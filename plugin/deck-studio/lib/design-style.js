/**
 * design（风格）的提示词定义与样张记录（F-72）。
 *
 * 背景：预设风格包 `seeds/styles/*.json` 里本来带一段 `styleBrief`（精确的
 * 画面提示词），但建 design 时被丢掉了；`deck_design_sample` 又只拿
 * description + 新 brief 现拼 prompt，于是「重新生成样张」看起来像把风格提示词
 * 重造了一遍，也和已有样张不一致。
 *
 * 本模块把「风格定义文件」当成唯一事实来源：
 * - `designs/<ABBR>/style.json`：description / constraints / reference / styleBrief；
 * - `designs/<ABBR>/style.md`：人读版；
 * - `designs/<ABBR>/samples.jsonl`：每张样张实际用的 brief + prompt + 参数。
 *
 * 纯文件读写，无业务状态；供服务端（index.js）和工具（tools.js）共用。
 * @module dsh-plugin-deck-studio/design-style
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** `designs/<ABBR>/` 目录。 */
export function styleDirOf(sourceRoot, abbr) {
  return join(sourceRoot, "designs", String(abbr ?? "").trim().toUpperCase());
}

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

/**
 * 读风格定义：style.json 优先，style.md 兜底，registry 字段再兜底。
 * @param {string} sourceRoot - 画布 deck 的源目录。
 * @param {string} abbr - 风格缩写（目录名）。
 * @param {Record<string, unknown>} [fallback] - registry 里的 design 字段。
 */
export function readStyleDefinition(sourceRoot, abbr, fallback = {}) {
  const dir = styleDirOf(sourceRoot, abbr);
  const jsonPath = join(dir, "style.json");
  const mdPath = join(dir, "style.md");
  const json = readJson(jsonPath) ?? {};
  let styleMd = "";
  try {
    if (existsSync(mdPath)) styleMd = readFileSync(mdPath, "utf8");
  } catch {
    styleMd = "";
  }
  const text = (value) => String(value ?? "").trim();
  return {
    dir,
    jsonPath,
    mdPath,
    exists: existsSync(jsonPath) || Boolean(styleMd),
    abbr: text(json.abbr || fallback.abbr || abbr).toUpperCase(),
    name: text(json.name || fallback.name),
    description: text(json.description || fallback.description),
    constraints: text(json.constraints || fallback.constraints),
    reference: text(json.reference || fallback.reference),
    // 兼容手动写的风格文件：prompt / stylePrompt 都视作提示词本体。
    styleBrief: text(json.styleBrief || json.stylePrompt || json.prompt),
    styleMd,
  };
}

/** 风格定义 → style.md 文本。 */
export function styleMarkdown(definition = {}) {
  const name = String(definition.name ?? "").trim();
  const abbr = String(definition.abbr ?? "").trim().toUpperCase();
  const lines = [`# ${name}（${abbr}）`, "", String(definition.description ?? "").trim()];
  if (definition.styleBrief) lines.push("", "## 风格提示词（styleBrief）", "", String(definition.styleBrief).trim());
  if (definition.constraints) lines.push("", "## 不要什么", "", String(definition.constraints).trim());
  if (definition.reference) lines.push("", "## 参考", "", String(definition.reference).trim());
  return `${lines.join("\n")}\n`;
}

/** 风格定义 → style.json 对象（保留已有字段，patch 覆盖）。 */
export function styleJson(definition = {}, base = {}) {
  const pick = (value) => (typeof value === "string" ? value.trim() : "");
  return {
    ...base,
    abbr: pick(definition.abbr || base.abbr).toUpperCase(),
    name: pick(definition.name || base.name),
    description: pick(definition.description ?? base.description),
    constraints: pick(definition.constraints ?? base.constraints),
    reference: pick(definition.reference ?? base.reference),
    styleBrief: pick(definition.styleBrief ?? base.styleBrief),
    ...(base.designId ? { designId: base.designId } : {}),
    ...(base.createdAt ? { createdAt: base.createdAt } : {}),
    updatedAt: new Date().toISOString(),
  };
}

/**
 * 写回 style.json / style.md（幂等；用于创建、样式更新、老 design 迁移）。
 * @returns {{ dir: string, jsonPath: string, mdPath: string, definition: object }}
 */
export function writeStyleDefinition(sourceRoot, definition) {
  const dir = styleDirOf(sourceRoot, definition.abbr);
  mkdirSync(dir, { recursive: true });
  const jsonPath = join(dir, "style.json");
  const mdPath = join(dir, "style.md");
  const base = readJson(jsonPath) ?? {};
  const next = styleJson(definition, base);
  writeFileSync(jsonPath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  writeFileSync(mdPath, styleMarkdown(next), "utf8");
  return { dir, jsonPath, mdPath, definition: next };
}

/**
 * 组合样张 prompt：已有风格提示词在前，新 brief 只作为「这张要试的画面」。
 * 关键约束（F-72）：
 * - 新样张不重写风格提示词；没有 styleBrief 时才退回 description；
 * - `reference` 只给人看，不进出图 prompt（常含机构/客户品牌名，image adapter
 *   的内容过滤会把这类 prompt 挂到超时——2026-10-20 BIZ 会话实测 3 次 180s 超时）。
 */
export function composeSamplePrompt(definition, brief) {
  const styleLine = `# 风格：${definition.name || definition.abbr}（${definition.abbr}）`;
  const stylePrompt = definition.styleBrief || definition.description || "";
  const description = definition.description && definition.description !== stylePrompt
    ? `# 画面语言\n${definition.description}`
    : "";
  return [
    styleLine,
    stylePrompt,
    description,
    definition.constraints ? `# 不要\n${definition.constraints}` : "",
    `# 这张要试的画面（沿用上面的风格提示词，只补这一张的新内容）\n${String(brief ?? "").trim()}`,
  ].filter(Boolean).join("\n\n");
}

/** 读 samples.jsonl（坏行忽略）。 */
export function readSampleRecords(styleDir) {
  const file = join(styleDir, "samples.jsonl");
  if (!existsSync(file)) return [];
  const out = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const row = line.trim();
    if (!row) continue;
    try {
      out.push(JSON.parse(row));
    } catch {
      /* 坏行忽略 */
    }
  }
  return out;
}

/** 追加一张样张的 prompt 记录（不覆盖旧记录）。 */
export function appendSampleRecord(styleDir, record = {}) {
  mkdirSync(styleDir, { recursive: true });
  const row = { ...record, createdAt: record.createdAt || new Date().toISOString() };
  appendFileSync(join(styleDir, "samples.jsonl"), `${JSON.stringify(row)}\n`, "utf8");
  return row;
}
