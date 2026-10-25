/**
 * 读 deck 的「写作上下文」：script.md 头部（title / owner / created）+ intent.md 的结构化字段
 * （听众 / 带走 / 成功标准 / 不讲的）。给两处用（F-158）：
 * - deck_script_read / 提案结果：让 Agent 写正文前看到「讲给谁、为什么讲」；
 * - buildPrompt：出图 prompt 带上受众与目的，封面页带作者 / 日期。
 *
 * 只读源文件，纯解析；找不到文件时返回空字段，不抛错。
 * @module dsh-plugin-deck-studio/deck-brief
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

// 占位文本可能带嵌套括号（「（待补：…（只写角色，不写标题））」），所以整行匹配而不是遇到第一个右括号就停。
const clean = (value) => String(value ?? "").replace(/^（待补[\s\S]*）$/, "").trim();

/** 读 `---` front matter（只取顶层 `key: value`）。 */
export function readFrontMatter(text) {
  const out = {};
  const lines = String(text ?? "").split("\n");
  if (lines[0]?.trim() !== "---") return out;
  for (let index = 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.trim() === "---") break;
    const match = line.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
    if (match) out[match[1]] = match[2].trim().replace(/^["']|["']$/g, "");
  }
  return out;
}

/** 从 intent.md 的 `- **字段**：值` 行取值。 */
export function readIntentFields(text) {
  const out = {};
  for (const line of String(text ?? "").split("\n")) {
    const match = line.match(/^\s*[-*]\s*\*\*([^*]+)\*\*\s*[：:]\s*(.*)$/);
    if (match) out[match[1].trim()] = clean(match[2]);
  }
  return out;
}

/**
 * @param {string} sourceRoot deck 源根
 * @returns {{title:string, owner:string, created:string, audience:string, topic:string, takeaway:string, success:string, scopeOut:string, rules:string}}
 */
export function readDeckBrief(sourceRoot) {
  const empty = { title: "", owner: "", created: "", audience: "", topic: "", takeaway: "", success: "", scopeOut: "", rules: "" };
  const root = String(sourceRoot ?? "").trim();
  if (!root) return empty;
  let scriptHead = {};
  try {
    if (existsSync(join(root, "script.md"))) scriptHead = readFrontMatter(readFileSync(join(root, "script.md"), "utf8"));
  } catch {
    scriptHead = {};
  }
  let intent = {};
  try {
    if (existsSync(join(root, "intent.md"))) intent = readIntentFields(readFileSync(join(root, "intent.md"), "utf8"));
  } catch {
    intent = {};
  }
  const skeleton = {
    argument: clean(intent["核心论证"]),
    type: clean(intent["骨架类型"]),
    order: clean(intent["页序角色"]),
    keepThree: clean(intent["只留 3 页留哪 3 页"]),
  };
  return {
    title: clean(scriptHead.title || intent["主题"]),
    owner: clean(scriptHead.owner),
    created: clean(scriptHead.created),
    audience: clean(intent["听众"]),
    topic: clean(intent["主题"]),
    takeaway: clean(intent["带走"]),
    success: clean(intent["成功标准"]),
    scopeOut: clean(intent["不讲的"]),
    skeleton,
    rules: "",
  };
}

/** A0 骨架类型（plan §A0）：写页之前先选一个，或自由写一句。 */
export const SKELETON_TYPES = ["结论先行", "故事线", "教学分解", "视觉主导", "中性简报"];

/**
 * 论证骨架体检（A0 的判据）：
 * - 核心论证 / 骨架类型 / 页序角色 三行必填；
 * - 「只留 3 页留哪 3 页」答不出来 → 说明论证还没想清（warn，不阻断）；
 * - 骨架类型不在预设里也行（自由写一句），但要在文本里能看出来。
 * @returns {{ok:boolean, missing:string[], keepThree:boolean, typeKnown:boolean, hint:string}}
 */
export function validateSkeleton(brief = {}) {
  const skeleton = brief.skeleton ?? {};
  const missing = [];
  if (!skeleton.argument) missing.push("核心论证");
  if (!skeleton.type) missing.push("骨架类型");
  if (!skeleton.order) missing.push("页序角色");
  const keepThree = Boolean(skeleton.keepThree);
  const typeKnown = !skeleton.type || SKELETON_TYPES.some((type) => String(skeleton.type).includes(type));
  const hint = missing.length
    ? `论证骨架还没写全（缺：${missing.join(" / ")}）。写页之前先在 intent.md 的「论证骨架」段写三行：核心论证（因为 X，所以 Y；听众要做的是 Z）/ 骨架类型（${SKELETON_TYPES.join(" / ")}，或自由写一句）/ 页序角色（只写角色，不写标题）。连贯不是句子的产物，是骨架的产物。`
    : !keepThree
      ? "论证骨架有了，但「只留 3 页留哪 3 页」没答——答不出来说明论证还没想清，先想清楚再往下写。"
      : "";
  return { ok: missing.length === 0, missing, keepThree, typeKnown, hint };
}

/** 出图 prompt 用的上下文行：受众 / 目的（一句话）。没有就返回空数组。 */
export function briefPromptLines(brief = {}) {
  const lines = [];
  if (brief.audience) lines.push(`受众：${brief.audience}（术语密度、例子、取舍按这个受众来）`);
  if (brief.takeaway || brief.success) lines.push(`这页服务的目的：${brief.takeaway || brief.success}`);
  return lines;
}

/** 封面页用的作者 / 日期行。日期只取 YYYY-MM-DD。 */
export function coverPromptLines(brief = {}) {
  const lines = [];
  if (brief.owner) lines.push(`作者：${brief.owner}`);
  const date = String(brief.created ?? "").match(/^\d{4}-\d{2}-\d{2}/)?.[0];
  if (date) lines.push(`日期：${date}`);
  return lines;
}
