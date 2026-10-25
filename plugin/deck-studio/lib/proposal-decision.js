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
import { isFirstDraft, writeAutoland } from "./first-draft.js";

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

/**
 * 单条 script 提案 → 新文本（纯函数：不写盘、不碰 manifest）。
 * 行级替换 + 改标题时同步分节标题行（F-120）。批量首稿落版与单条落版共用，避免两套替换规则。
 */
export function applyScriptProposalToText(current, proposal) {
  const lines = String(current ?? "").split("\n");
  const range = scriptSectionRange(String(current ?? ""), proposal.page);
  const start = range ? range.start + 1 : 0;
  const end = range ? range.end : lines.length;
  // F-181/F-182：契约 / 证据这类「这页原本没有的字段」提案，before 为空串；
  // 以前靠「找一行空行」插入，页面里没有空行就会误判为已过期（真机 500）。
  // 现在直接插在页标题行之后，语义就是「新增字段」。
  if (!String(proposal.before ?? "").length && range) {
    lines.splice(start, 0, String(proposal.after ?? ""));
    return lines.join("\n");
  }
  let index = -1;
  for (let i = start; i < end; i += 1) {
    if (lines[i] === proposal.before) {
      index = i;
      break;
    }
  }
  if (index < 0) {
    throw new Error(`提案已过期：工作副本里找不到提案 ${proposal.proposalId} 的 before 行（已被其他 revision 改动）。请驳回这条提案，让 Agent 基于当前脚本重新提案。`);
  }
  lines[index] = proposal.after;
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
  return lines.join("\n");
}

/** 把 script 提案的结果同步进 manifest，保持 deck.json 与 script 一致。 */
export function syncScriptManifest(workspace, proposal) {
  const deck = workspace.manifest(proposal.deckId);
  const slide = deck?.slides?.find((candidate) => candidate.id === proposal.pageId);
  if (!deck || !slide) return;
  if (String(proposal.after ?? "").startsWith("|") && SCRIPT_FIELD_CELL[proposal.field] != null) {
    const cell = proposal.after.split("|")[SCRIPT_FIELD_CELL[proposal.field] + 1];
    if (typeof cell === "string" && cell.trim()) slide[proposal.field] = cell.trim();
    workspace.saveManifest(deck);
    return;
  }
  if (proposal.field === "title" || proposal.field === "question" || proposal.field === "claim" || proposal.field === "body") {
    const value = proposal.value != null ? String(proposal.value).trim() : String(proposal.after ?? "").replace(/^\s*\*\*[^*]+\*\*\s*[：:]\s*/, "").trim();
    if (value) slide[proposal.field] = value;
    workspace.saveManifest(deck);
  }
}

/** 追加页提案 → 新文本；页同步进 manifest（已存在同页号时抛错）。 */
export function syncAddPageManifest(workspace, proposal, appliedPages) {
  const deck = workspace.manifest(proposal.deckId);
  if (!deck) throw new Error(`manifest 缺失：${proposal.deckId}`);
  deck.slides = Array.isArray(deck.slides) ? deck.slides : [];
  const existingIds = new Set(deck.slides.map((slide) => slide.id));
  for (const spec of appliedPages) {
    const pageId = `p${String(spec.page).padStart(2, "0")}`;
    if (existingIds.has(pageId)) throw new Error(`manifest 已有 ${pageId}，拒绝重复追加（可能已确认过；请重新提案）`);
    deck.slides.push({
      id: pageId,
      order: spec.page,
      type: "story",
      title: spec.title,
      question: spec.question,
      claim: spec.claim,
      source: "script.md",
      asset: null,
      visualBrief: spec.visualBrief,
    });
  }
  deck.slides.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  workspace.saveManifest(deck);
}

/**
 * 批量落版（F-176 / 智力升级 I-18）：把一批 script 提案合成**一条** revision。
 * 首稿自动落版（F-173）与用户「接受并更新」勾选批次共用这一段，保证两条路径的写入语义一致。
 */
function landProposalBatch({ store, workspace, proposals, decidedBy, quote = "", outcome, sessionId = null, syncScriptToSource = null, revisionNote }) {
  const list = Array.isArray(proposals) ? proposals.filter(Boolean) : [];
  if (!list.length) throw new Error("批量落版没有可应用的提案");
  const deckId = list[0].deckId;
  for (const proposal of list) {
    if (proposal.deckId !== deckId) throw new Error("批量落版只处理同一个 deck 的提案");
    if (proposal.status !== "waiting-user") throw new Error(`提案 ${proposal.proposalId} 状态为 ${proposal.status}，只有 waiting-user 可落版`);
    if (proposal.kind !== "script" && proposal.kind !== "script-add-page" && proposal.kind !== "manifest") {
      throw new Error(`批量落版不支持 ${proposal.kind} 类提案（只支持 script 正文 / 追加页 / visualBrief）`);
    }
  }
  const current = workspace.scriptCurrent(deckId);
  if (current == null) throw new Error(`script 工作副本缺失：${deckId}`);
  let text = current;
  let manifestTouched = false;
  for (const proposal of list) {
    if (proposal.kind === "manifest") {
      // visualBrief 只动 manifest，不产生 script 文本变化；和 script 提案合成同一条 revision，
      // 否则首稿「正文 + 画面要求」一起写会被拆成两条，用户勾选一次却落两次版。
      const deck = workspace.manifest(deckId);
      const slide = deck?.slides?.find((candidate) => candidate.id === proposal.pageId);
      if (!deck || !slide) throw new Error(`manifest 里没有 ${proposal.pageId}`);
      slide.visualBrief = String(proposal.value ?? proposal.after ?? "").trim();
      slide.visualBriefDesign = proposal.writtenUnderDesign ?? null;
      workspace.saveManifest(deck);
      manifestTouched = true;
      continue;
    }
    if (proposal.kind === "script-add-page") {
      const applied = workspace.appendScriptPages(text, proposal.pages ?? []);
      if (!applied.pages.length) throw new Error(`提案 ${proposal.proposalId} 没有可追加的页`);
      text = applied.text;
      syncAddPageManifest(workspace, proposal, applied.pages);
      proposal.pageCountAfter = applied.pageCount;
    } else {
      text = applyScriptProposalToText(text, proposal);
      syncScriptManifest(workspace, proposal);
    }
  }
  const saved = workspace.saveScriptRevision(deckId, text, revisionNote);
  for (const proposal of list) {
    workspace.updateProposal(proposal, {
      status: "applied",
      decidedAt: proposalNow(),
      decidedBy,
      confirmationQuote: String(quote ?? ""),
      quoteMissing: decidedBy === "agent" ? false : !String(quote ?? "").trim(),
      revision: saved.revision,
      ...(outcome === "autoland" ? { autoland: true } : {}),
    });
  }
  const sourceSync = typeof syncScriptToSource === "function" ? syncScriptToSource(deckId, text, list[0]) : null;
  const reviewRefs = [...new Set(list.map((proposal) => proposal.reviewRef).filter(Boolean))];
  store.recordEvent({
    type: "deck.edit",
    sessionId,
    taskId: null,
    deckId,
    slideIds: [...new Set(list.map((proposal) => proposal.pageId))],
    actor: decidedBy === "user" ? "user" : "agent",
    status: "succeeded",
    payload: {
      proposalIds: list.map((proposal) => proposal.proposalId),
      outcome,
      revision: saved.revision,
      ...(manifestTouched ? { manifestTouched: true } : {}),
      ...(reviewRefs.length ? { reviewRefs } : {}),
      ...(sourceSync ? { sourceSync } : {}),
    },
  });
  return { deckId, revision: saved.revision, proposalIds: list.map((proposal) => proposal.proposalId), sourceSync, reviewRefs, beforeText: current };
}

/**
 * 首稿批量落版（F-173）：把一批 script 提案合成**一条** revision 直接落库，不逐条等确认。
 * 只在「一次都没落过版」时可用；判定与元数据写盘都在这里，Agent 说错话也落不了有历史版本的稿子。
 */
export function applyFirstDraftBatch({ store, workspace, proposals, autoland = null, sessionId = null, syncScriptToSource = null }) {
  const list = Array.isArray(proposals) ? proposals.filter(Boolean) : [];
  if (!list.length) throw new Error("首稿自动落版没有可应用的提案");
  const deckId = list[0].deckId;
  if (!isFirstDraft(workspace, deckId)) {
    throw new Error(`首稿自动落版被拒：${deckId} 已有已落版 revision。自动落版只用于第一次落库，这次请等用户确认后再落。`);
  }
  const landed = landProposalBatch({
    store,
    workspace,
    proposals: list,
    decidedBy: "agent",
    outcome: "autoland",
    sessionId,
    syncScriptToSource,
    revisionNote: `first draft autoland: ${list.length} edit(s) ${list.map((proposal) => proposal.proposalId).join(" ")}`,
  });
  const record = writeAutoland(workspace, deckId, {
    revision: landed.revision,
    proposal: list[0],
    selfReview: autoland?.selfReview ?? {},
    draftRound: autoland?.draftRound ?? 1,
    beforeText: landed.beforeText ?? "",
  });
  return { deckId, revision: landed.revision, proposalIds: landed.proposalIds, autoland: record, ...(landed.sourceSync ? { sourceSync: landed.sourceSync } : {}) };
}

/**
 * 用户「接受并更新」：把勾选的一批评审修改合成一条 revision（F-176 / I-18）。
 * 与首稿自动落版的区别只在「谁决定」——判定、写入、元数据、回滚语义全部共用一套。
 */
export function applyConfirmedBatch({ store, workspace, proposals, quote = "", sessionId = null, syncScriptToSource = null }) {
  const list = Array.isArray(proposals) ? proposals.filter(Boolean) : [];
  if (!list.length) throw new Error("接受并更新：没有勾选任何修改");
  const landed = landProposalBatch({
    store,
    workspace,
    proposals: list,
    decidedBy: "user",
    quote,
    outcome: "accepted-batch",
    sessionId,
    syncScriptToSource,
    revisionNote: `accept review batch: ${list.length} edit(s) ${list.map((proposal) => proposal.reviewRef || proposal.proposalId).join(" ")}`,
  });
  return { deckId: landed.deckId, revision: landed.revision, proposalIds: landed.proposalIds, reviewRefs: landed.reviewRefs, ...(landed.sourceSync ? { sourceSync: landed.sourceSync } : {}) };
}

/** 把一条 waiting-user 提案落成 revision（或记为用户驳回）。 */
export function decideProposal({ store, workspace, proposal, confirmed, quote = "", sessionId = null, syncScriptToSource = null, autoland = null }) {
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

  // F-173 首稿自动落版：只有「一次都没落过 revision」的稿子允许零确认落版。
  // 判定放在这里（而不是 Agent 侧）：Agent 说错话也落不了有历史版本的稿子。
  const wantAutoland = autoland != null;
  if (wantAutoland) {
    if (proposal.kind !== "script" && proposal.kind !== "script-add-page") {
      throw new Error("自动落版只用于 script 内容（正文 / 追加页）；visualBrief 这类仍走提案确认。");
    }
    if (!isFirstDraft(workspace, proposal.deckId)) {
      throw new Error(`首稿自动落版被拒：${proposal.deckId} 已有已落版 revision。自动落版只用于第一次落库，这次请等用户确认后再落。`);
    }
  }
  const beforeText = wantAutoland ? workspace.scriptCurrent(proposal.deckId) ?? "" : null;

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
    appliedScriptText = applyScriptProposalToText(current, proposal);
    revisionInfo = workspace.saveScriptRevision(proposal.deckId, appliedScriptText, `apply ${proposal.proposalId} (${proposal.pageId}.${proposal.field}) by user confirmation`);
    syncScriptManifest(workspace, proposal);
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
    syncAddPageManifest(workspace, proposal, applied.pages);
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

  // F-173：自动落版留痕（自改摘要 + 落版前快照），回滚要用。
  const autolandRecord = wantAutoland && revisionInfo
    ? writeAutoland(workspace, proposal.deckId, {
        revision: revisionInfo.revision,
        proposal,
        selfReview: autoland?.selfReview ?? {},
        draftRound: autoland?.draftRound ?? 1,
        beforeText,
      })
    : null;

  // F-100 / ADR-0022：本机新建 deck 的脚本改动回写源 script.md；受控客户源保持只读。
  const sourceSync = appliedScriptText != null && typeof syncScriptToSource === "function"
    ? syncScriptToSource(proposal.deckId, appliedScriptText, proposal)
    : null;

  if (quoteMissing) {
    store.recordEvent({ type: "deck.edit", sessionId, taskId: task?.taskId ?? null, deckId: proposal.deckId, slideIds: affectedSlideIds, actor: "system", status: "succeeded", payload: { proposalId: proposal.proposalId, outcome: "applied", quoteMissing: true } });
  }
  workspace.updateProposal(proposal, { status: "applied", decidedAt: proposalNow(), decidedBy: autolandRecord ? "agent" : "user", confirmationQuote, quoteMissing, revision: revisionInfo?.revision ?? null, ...(autolandRecord ? { autoland: true } : {}) });
  if (task) {
    store.taskUpdate(task.taskId, {
      status: "succeeded",
      actor: autolandRecord ? "agent" : "user",
      outputRefs: [...(revisionInfo ? [`revision:${proposal.deckId}/script/${revisionInfo.revision}`] : []), `proposal:${proposal.proposalId}`],
    });
  }
  store.recordEvent({
    type: "deck.edit",
    sessionId,
    taskId: task?.taskId ?? null,
    deckId: proposal.deckId,
    slideIds: affectedSlideIds,
    actor: autolandRecord ? "agent" : "user",
    status: "succeeded",
    payload: { proposalId: proposal.proposalId, outcome: "applied", confirmationQuote, quoteMissing, revision: revisionInfo?.revision ?? null, revisionPath: revisionInfo?.path ?? null, ...(autolandRecord ? { autoland: true, selfReview: autolandRecord.selfReview, draftRound: autolandRecord.draftRound } : {}), ...(sourceSync ? { sourceSync } : {}), ...(proposal.kind === "script-add-page" ? { field: "add-page", pages: proposal.pageIds, pageCountAfter: proposal.pageCountAfter ?? null } : {}) },
  });

  return {
    proposalId: proposal.proposalId,
    status: "applied",
    revision: revisionInfo?.revision ?? null,
    revisionPath: revisionInfo?.path ?? null,
    deckId: proposal.deckId,
    ...(sourceSync ? { sourceSync } : {}),
    ...(quoteMissing ? { quoteMissing: true } : {}),
    ...(autolandRecord ? { autoland: autolandRecord } : {}),
    text:
      `提案 ${proposal.proposalId} 已应用${revisionInfo ? `，script revision ${revisionInfo.revision} 已写入（旧版保留）` : ""}` +
      `。${sourceSync ? (sourceSync.ok ? `源 script.md 已回写并提交（${sourceSync.commit}）。` : `源 script.md 已回写，git 未提交：${sourceSync.error}。`) : ""}` +
      `${autolandRecord ? `\n这是首稿（未经确认的自动落版）：自改 ${autolandRecord.selfReview.rounds} 轮${autolandRecord.selfReview.summary ? `，主要改了「${autolandRecord.selfReview.summary}」` : ""}。不满意可以调 deck_draft_rollback 一键回到落版前。` : ""}` +
      `${quoteMissing && !autolandRecord ? "\n（这次没带用户原话，已按确认动作落版并标 quoteMissing 留痕；下次能引用原话更好。）" : ""}`,
  };
}
