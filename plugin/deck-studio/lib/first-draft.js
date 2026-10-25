/**
 * 首稿自动落版（F-173 / 智力升级 I-17）。
 *
 * 为什么单独一层：首稿是唯一「没有人工把关就进库」的动作，所以判定、元数据、回滚
 * 必须由程序保证，而不是靠 Agent 记得「这次是首稿」。三道硬约束：
 *
 * 1. 判定：`script/revisions/` 里没有任何 vNNN.md 才允许自动落版；有历史版本一律拒绝。
 * 2. 留痕：每条自动落版 revision 旁写 `<vNNN>.autoland.json`（自改轮次 / 依据的评审 / 摘要），
 *    并把落版前的稿子存成 `<vNNN>.before.md`——回滚要能精确还原到落版前，不是「重来一次」。
 * 3. 可回滚：只有「最新 revision 且是自动落版」才允许回滚；回滚本身也追加新 revision，
 *    旧版本照常保留（copy-on-write 不放宽）。
 *
 * 本模块无 IO 之外的依赖，工具 / 路由 / 文档读取共用同一套判定，避免三处各写一遍。
 *
 * @module dsh-plugin-deck-studio/first-draft
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const AUTOLAND_SUFFIX = ".autoland.json";
export const BEFORE_SUFFIX = ".before.md";

/** script revision 目录。 */
export function revisionsDir(workspace, deckId) {
  return join(workspace.deckDir(deckId), "script", "revisions");
}

/** 已落版 revision 数（vNNN.md；note/sidecar 不算）。 */
export function revisionCount(workspace, deckId) {
  const dir = revisionsDir(workspace, deckId);
  if (!existsSync(dir)) return 0;
  return workspace.listScriptRevisions(deckId).length;
}

/** 首稿判定：一份稿子都还没落过。 */
export function isFirstDraft(workspace, deckId) {
  return revisionCount(workspace, deckId) === 0;
}

/** 读某条 revision 的自动落版记录；没有返回 null。 */
export function autolandOf(workspace, deckId, revision) {
  const file = join(revisionsDir(workspace, deckId), `${revision}${AUTOLAND_SUFFIX}`);
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

/**
 * 最新一条 revision 的自动落版记录（用于「能不能回滚」判定）。
 * @returns {{revision:string, record:object}|null}
 */
export function latestAutoland(workspace, deckId) {
  const revisions = workspace.listScriptRevisions(deckId); // 新的在前
  if (!revisions.length) return null;
  const revision = revisions[0].revision;
  const record = autolandOf(workspace, deckId, revision);
  if (!record || record.rolledBack) return null;
  return { revision, record };
}

/** 写自动落版记录 + 落版前稿子（回滚用）。 */
export function writeAutoland(workspace, deckId, { revision, proposal, selfReview, draftRound, beforeText }) {
  const dir = revisionsDir(workspace, deckId);
  const beforeFile = `${revision}${BEFORE_SUFFIX}`;
  writeFileSync(join(dir, beforeFile), String(beforeText ?? ""), "utf8");
  const record = {
    autoland: true,
    at: new Date().toISOString(),
    deckId,
    revision,
    proposalId: proposal?.proposalId ?? null,
    draftRound: Number.isFinite(Number(draftRound)) ? Number(draftRound) : 1,
    selfReview: {
      rounds: Number.isFinite(Number(selfReview?.rounds)) ? Number(selfReview.rounds) : 0,
      reviewId: String(selfReview?.reviewId ?? ""),
      summary: String(selfReview?.summary ?? ""),
    },
    before: { revision: null, file: beforeFile, chars: String(beforeText ?? "").length },
    rolledBack: null,
  };
  writeFileSync(join(dir, `${revision}${AUTOLAND_SUFFIX}`), `${JSON.stringify(record, null, 2)}\n`, "utf8");
  return record;
}

/**
 * 回滚首稿：把 `<vNNN>.before.md` 的内容作为**新 revision** 写回，并标记原记录已回滚。
 * 只在「最新 revision 是自动落版且未回滚」时可用。
 * @returns {{ok:true, revision:string, restoredFrom:string, beforeRevision:string}}
 */
export function rollbackFirstDraft({ workspace, deckId, note = "" }) {
  const latest = latestAutoland(workspace, deckId);
  if (!latest) {
    throw new Error("没有可回滚的首稿：只支持回滚「最新一条 revision 是自动落版」的情况；正式修订请用提案流程。");
  }
  const dir = revisionsDir(workspace, deckId);
  const beforeFile = join(dir, latest.record.before?.file ?? `${latest.revision}${BEFORE_SUFFIX}`);
  if (!existsSync(beforeFile)) throw new Error(`首稿回滚缺少落版前快照：${beforeFile}`);
  const text = readFileSync(beforeFile, "utf8");
  const saved = workspace.saveScriptRevision(
    deckId,
    text,
    `rollback autoland ${latest.revision} → 落版前内容（${note || "用户要求回滚首稿"}）`,
  );
  latest.record.rolledBack = { at: new Date().toISOString(), revision: saved.revision, note: String(note ?? "") };
  writeFileSync(join(dir, `${latest.revision}${AUTOLAND_SUFFIX}`), `${JSON.stringify(latest.record, null, 2)}\n`, "utf8");
  return { ok: true, revision: saved.revision, restoredFrom: latest.record.before?.file ?? beforeFile, beforeRevision: latest.revision };
}

/** 给 workbench / 修改日志用的一句话徽标文案。 */
export function autolandBadge(record) {
  if (!record || !record.autoland) return "";
  if (record.rolledBack) return "首稿已回滚";
  const rounds = Number(record.selfReview?.rounds ?? 0);
  return `首稿（自动落版${rounds > 0 ? `，自改 ${rounds} 轮` : ""}，未经确认）`;
}
