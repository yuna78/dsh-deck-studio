/**
 * 提案裁决（F-108）：把「用户确认/驳回提案」的逻辑从工具里抽出来，
 * 让 Agent 的 deck_revision_confirm 与工作台按钮（POST /api/deck-studio.proposal-decide）
 * 走同一条写入路径——不会出现「UI 确认了但 revision/源文件没写」的两套账。
 *
 * 写入纪律不变：只追加 revision（copy-on-write），本机 deck 回写源 script.md，
 * 受控客户源只读；每一步都留 `deck.edit` 事件与 task 状态。
 *
 * @module dsh-plugin-deck-studio/proposal-decision
 */

import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { SCRIPT_FIELD_CELL, proposalNow, scriptSectionRange } from "./deck-workspace.js";
import { commitFiles } from "./git-commit.js";

/**
 * 本机新建 deck：确认后的脚本内容回写源 script.md + git 留痕（F-100 / ADR-0022）。
 * 受控客户源（isLocalDeck=false）仍然只读：只写 .deck 工作副本，不回写源。
 */
export function createScriptToSourceSync({ adapters = [], isLocalDeck = null } = {}) {
  return function syncScriptToSource(deckId, scriptText, proposal = null) {
    if (typeof isLocalDeck !== "function" || !isLocalDeck(deckId)) return null;
    const adapter = adapters.find((candidate) => candidate.id === deckId) ?? null;
    const sourceRoot = String(adapter?.sourceRoot ?? "");
    if (!sourceRoot || !existsSync(sourceRoot)) return null;
    const file = join(sourceRoot, "script.md");
    writeFileSync(file, scriptText.endsWith("\n") ? scriptText : `${scriptText}\n`, "utf8");
    const label = proposal?.kind === "script-add-page" ? "追加页" : "改稿";
    const git = commitFiles({ dir: sourceRoot, files: [file], message: `deck(${deckId})：${label}回写 script` });
    return { path: file, ok: git?.ok === true, commit: git?.commit ?? null, error: git?.ok ? null : git?.error ?? "git 未提交" };
  };
}

/** 把一条 waiting-user 提案落成 revision（或记为用户驳回）。 */
export function decideProposal({ store, workspace, proposal, confirmed, quote = "", sessionId = null, syncScriptToSource = null }) {
  if (!proposal) throw new Error("提案不存在");
  if (proposal.status !== "waiting-user") throw new Error(`提案 ${proposal.proposalId} 状态为 ${proposal.status}，只有 waiting-user 可裁决`);

  const task = store.taskList(200).find((candidate) => candidate.kind === "edit" && (candidate.inputRefs ?? []).includes(`proposal:${proposal.proposalId}`));

  if (confirmed !== true) {
    workspace.updateProposal(proposal, { status: "rejected", decidedAt: proposalNow(), decidedBy: "user", note: String(quote ?? "") });
    if (task) store.taskUpdate(task.taskId, { status: "cancelled", actor: "user", error: "user-rejected" });
    store.recordEvent({
      type: "deck.edit",
      sessionId,
      taskId: task?.taskId ?? null,
      deckId: proposal.deckId,
      slideIds: [proposal.pageId],
      actor: "user",
      status: "failed",
      payload: { proposalId: proposal.proposalId, outcome: "rejected", note: String(quote ?? "") },
    });
    return { proposalId: proposal.proposalId, status: "rejected", deckId: proposal.deckId, text: `提案 ${proposal.proposalId} 已按用户意思驳回并留痕。` };
  }

  // F-137：确认不再强制「必须引用原话」。用户在 Chat 说「就这样 / 可以」、或在工作台点「确认落版」都算确认；
  // 拿不到原话时仍落版，但事件里记 quoteMissing=true 留痕（审计可查），并把警告回给 Agent。
  const confirmationQuote = String(quote ?? "").trim();
  const quoteMissing = !confirmationQuote;
  const affectedSlideIds = Array.isArray(proposal.pageIds) && proposal.pageIds.length ? [...proposal.pageIds] : [proposal.pageId];

  let revisionInfo = null;
  let appliedScriptText = null;
  if (proposal.kind === "script") {
    const current = workspace.scriptCurrent(proposal.deckId);
    if (current == null) throw new Error(`script 工作副本缺失：${proposal.deckId}`);
    // 用行级替换：before 行 → after 行（提案生成时已定稿，避免重算）。
    const lines = current.split("\n");
    // before 行必须落在「这一页」的分节里；否则同页对面（或别的页）的相同占位行会被误改。
    const range = scriptSectionRange(current, proposal.page);
    const start = range ? range.start + 1 : 0;
    const end = range ? range.end : lines.length;
    let index = -1;
    for (let i = start; i < end; i += 1) {
      if (lines[i] === proposal.before) {
        index = i;
        break;
      }
    }
    if (index < 0) throw new Error(`提案已过期：工作副本里找不到提案 ${proposal.proposalId} 的 before 行（已被其他 revision 改动）。请驳回这条提案，让 Agent 基于当前脚本重新提案。`);
    lines[index] = proposal.after;
    // F-120：改标题时把分节标题行 `### PNN · 旧标题` 一起改掉。历史 bug：只改 `**标题**` 行，
    // 标题行一直留着旧标题，错位后没人看得出来，工作副本与 manifest 越走越远。
    if (proposal.field === "title") {
      const newTitle = String(proposal.value ?? proposal.after ?? "").replace(/^\s*\*\*[^*]+\*\*\s*[：:]\s*/, "").trim();
      if (newTitle && range) {
        for (let i = range.start; i < Math.min(range.start + 3, lines.length); i += 1) {
          if (/^#{2,3}\s*P0*\d+\s*[·.\-–—:]/.test(lines[i].trim())) {
            lines[i] = lines[i].replace(/(^#{2,3}\s*P0*\d+\s*[·.\-–—:]\s*).*$/, `$1${newTitle}`);
            break;
          }
        }
      }
    }
    appliedScriptText = lines.join("\n");
    revisionInfo = workspace.saveScriptRevision(proposal.deckId, appliedScriptText, `apply ${proposal.proposalId} (${proposal.pageId}.${proposal.field}) by user confirmation`);
    // 同步 manifest 的对应字段，保持 deck.json 与 script 一致。
    const deck = workspace.manifest(proposal.deckId);
    const slide = deck?.slides?.find((candidate) => candidate.id === proposal.pageId);
    if (deck && slide) {
      if (String(proposal.after ?? "").startsWith("|") && SCRIPT_FIELD_CELL[proposal.field] != null) {
        // 表格惯例：after 是完整表格行，第 0 个 split 段是行首空串。
        const cell = proposal.after.split("|")[SCRIPT_FIELD_CELL[proposal.field] + 1];
        if (typeof cell === "string" && cell.trim()) slide[proposal.field] = cell.trim();
        workspace.saveManifest(deck);
      } else if (proposal.field === "title" || proposal.field === "question" || proposal.field === "claim" || proposal.field === "body") {
        // 分节惯例（F-75 / F-109）：直接取提案里的纯值；老提案没有 value 就从 `**字段**：值` 里剥。
        const value = proposal.value != null ? String(proposal.value).trim() : String(proposal.after ?? "").replace(/^\s*\*\*[^*]+\*\*\s*[：:]\s*/, "").trim();
        if (value) slide[proposal.field] = value;
        workspace.saveManifest(deck);
      }
    }
  } else if (proposal.kind === "script-add-page") {
    // F-99：追加页的写回分支。不复用上面的行级替换（before="" 会命中第一处空行），
    // 而是基于**当前**工作副本重算追加结果，避免提案后又被别的 revision 改过而覆盖。
    const current = workspace.scriptCurrent(proposal.deckId);
    if (current == null) throw new Error(`script 工作副本缺失：${proposal.deckId}`);
    const applied = workspace.appendScriptPages(current, proposal.pages ?? []);
    if (!applied.pages.length) throw new Error(`提案 ${proposal.proposalId} 没有可追加的页`);
    revisionInfo = workspace.saveScriptRevision(
      proposal.deckId,
      applied.text,
      `append ${applied.pages.length} page(s) ${applied.pages.map((spec) => `P${String(spec.page).padStart(2, "0")}`).join(" ")} by user confirmation (${proposal.proposalId})`,
    );
    const deck = workspace.manifest(proposal.deckId);
    if (!deck) throw new Error(`manifest 缺失：${proposal.deckId}`);
    deck.slides = Array.isArray(deck.slides) ? deck.slides : [];
    const existingIds = new Set(deck.slides.map((slide) => slide.id));
    for (const spec of applied.pages) {
      const pageId = `p${String(spec.page).padStart(2, "0")}`;
      if (existingIds.has(pageId)) {
        throw new Error(`manifest 已有 ${pageId}，拒绝重复追加（可能已确认过；请重新提案）`);
      }
      deck.slides.push({
        id: pageId,
        order: spec.page,
        type: "story",
        title: spec.title,
        question: spec.question,
        claim: spec.claim,
        source: "script.md",
        asset: null,
        // 追加页默认没有画面要求；出图前先走 deck_script_propose_edit 补 visualBrief。
        visualBrief: spec.visualBrief,
      });
    }
    deck.slides.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    workspace.saveManifest(deck);
    proposal.pageCountAfter = applied.pageCount;
    appliedScriptText = applied.text;
  } else {
    const deck = workspace.manifest(proposal.deckId);
    const slide = deck?.slides?.find((candidate) => candidate.id === proposal.pageId);
    if (!deck || !slide) throw new Error(`manifest 页不存在：${proposal.pageId}`);
    slide.visualBrief = String(proposal.after ?? "").trim();
    // F-114：记录这页画面要求是在哪个关联风格下写的（换风格时据此判断要不要刷新）。
    slide.visualBriefDesign = proposal.writtenUnderDesign ?? null;
    workspace.saveManifest(deck);
  }

  // F-100 / ADR-0022：本机新建 deck 的脚本改动回写源 script.md；受控客户源保持只读。
  const sourceSync = appliedScriptText != null && typeof syncScriptToSource === "function"
    ? syncScriptToSource(proposal.deckId, appliedScriptText, proposal)
    : null;

  if (quoteMissing) {
    store.recordEvent({ type: "deck.edit", sessionId, taskId: task?.taskId ?? null, deckId: proposal.deckId, slideIds: affectedSlideIds, actor: "system", status: "succeeded", payload: { proposalId: proposal.proposalId, outcome: "applied", quoteMissing: true } });
  }
  workspace.updateProposal(proposal, { status: "applied", decidedAt: proposalNow(), decidedBy: "user", confirmationQuote, quoteMissing, revision: revisionInfo?.revision ?? null });
  if (task) {
    store.taskUpdate(task.taskId, {
      status: "succeeded",
      actor: "user",
      outputRefs: [...(revisionInfo ? [`revision:${proposal.deckId}/script/${revisionInfo.revision}`] : []), `proposal:${proposal.proposalId}`],
    });
  }
  store.recordEvent({
    type: "deck.edit",
    sessionId,
    taskId: task?.taskId ?? null,
    deckId: proposal.deckId,
    slideIds: affectedSlideIds,
    actor: "user",
    status: "succeeded",
    payload: { proposalId: proposal.proposalId, outcome: "applied", confirmationQuote, quoteMissing, revision: revisionInfo?.revision ?? null, revisionPath: revisionInfo?.path ?? null, ...(sourceSync ? { sourceSync } : {}), ...(proposal.kind === "script-add-page" ? { field: "add-page", pages: proposal.pageIds, pageCountAfter: proposal.pageCountAfter ?? null } : {}) },
  });

  return {
    proposalId: proposal.proposalId,
    status: "applied",
    revision: revisionInfo?.revision ?? null,
    revisionPath: revisionInfo?.path ?? null,
    deckId: proposal.deckId,
    ...(sourceSync ? { sourceSync } : {}),
    ...(quoteMissing ? { quoteMissing: true } : {}),
    text:
      `提案 ${proposal.proposalId} 已应用${revisionInfo ? `，script revision ${revisionInfo.revision} 已写入（旧版保留）` : ""}` +
      `。${sourceSync ? (sourceSync.ok ? `源 script.md 已回写并提交（${sourceSync.commit}）。` : `源 script.md 已回写，git 未提交：${sourceSync.error}。`) : ""}` +
      `${quoteMissing ? "\n（这次没带用户原话，已按确认动作落版并标 quoteMissing 留痕；下次能引用原话更好。）" : ""}`,
  };
}
