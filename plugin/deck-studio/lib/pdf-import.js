/**
 * PDF 导入（需求 req_28a1eec6eab8，2026-11-06）：把目录里的一份 PDF 变成 Deckline 的
 * 「每页一张整页图」deck，顺带抽取同目录里的 md。
 *
 * 设计边界（先看清再改）：
 * - **不做 OCR、不做视觉推理**：意图字段只从 md 里「已经写好的」字段抽；抽不到就留占位，
 *   并在 intent.md 末尾写「导入说明（推断 · 待确认）」。看图推意图是下一阶段的事。
 * - **导入的整页图是参考 baseline**，不是最终交付图：PDF 渲染出来的字/版式与源 pptx 不一致时
 *   不能当过审的稿子用（真正的原因见 docs/architecture.md「导入」一节）。
 * - 纯函数（分类 / 抽字段 / 标题启发 / 说明生成）都不碰磁盘，smoke 直接测；
 *   IO 只有两处：`listImportDir()` 与 `rasterizePdfToPng()`。
 * - `rasterizePdfToPng()` 依赖 poppler 的 `pdftoppm`（本机 brew install poppler）。
 *   插件本身不引入 npm 依赖，缺二进制时**明确报错**，不静默降级成空 deck。
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, renameSync, statSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { parseSectionedPages, parseStoryPages } from "./source-adapter.js";

export const PDF_IMPORT_DEFAULT_DPI = 120;
export const PDF_IMPORT_MIN_DPI = 72;
export const PDF_IMPORT_MAX_DPI = 300;
/** 一次导入的页数上限：够覆盖常见分享会 deck，又不至于让一次请求跑十几分钟。 */
export const PDF_IMPORT_MAX_PAGES = 40;

/** dpi 规范化：非数字回默认，超范围夹到边界（越界不报错，导入不该因为参数小错失败）。 */
export function normalizeDpi(value) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return PDF_IMPORT_DEFAULT_DPI;
  return Math.min(PDF_IMPORT_MAX_DPI, Math.max(PDF_IMPORT_MIN_DPI, parsed));
}

/** 目录里哪些文件是导入源：只要 PDF 与 md（其它文件不猜、不读）。 */
export function classifyImportNames(names = []) {
  const pdfs = [];
  const markdown = [];
  for (const raw of Array.isArray(names) ? names : []) {
    const name = String(raw ?? "").trim();
    if (!name || name.startsWith(".")) continue;
    if (/\.pdf$/i.test(name)) pdfs.push(name);
    else if (/\.md$/i.test(name)) markdown.push(name);
  }
  return { pdfs: pdfs.sort(), markdown: markdown.sort() };
}

/** 从 PDF 文件名推 deck 标题（末级兜底，用户填了就用用户的）。 */
export function titleFromPdfName(fileName = "") {
  const base = basename(String(fileName ?? ""), extname(String(fileName ?? "")));
  return base.replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim() || "导入的 deck";
}

/** 意图六字段的别名表（中文 / 英文都认，大小写不敏感）。 */
const INTENT_FIELDS = [
  { key: "audience", labels: ["听众", "受众", "用户", "audience"] },
  { key: "topic", labels: ["主题", "话题", "topic"] },
  { key: "intent", labels: ["意图", "带走", "intent"] },
  { key: "occasion", labels: ["场合", "时长", "occasion"] },
  { key: "success", labels: ["成功标准", "success"] },
  { key: "scopeOut", labels: ["不讲的", "不讲", "边界", "scopeout", "scope-out"] },
];

/** 占位值不算抽取成功（「（待补：…）」正是模板里的空位）。 */
function isEmptyPlaceholder(value) {
  const text = String(value ?? "").trim();
  if (!text) return true;
  return /^[（(]\s*待补/.test(text) || /^[（(]\s*未填/.test(text);
}

/**
 * frontmatter 的键值对。这里**不复用** source-adapter 的 `parseFrontmatter`：
 * 它只认 ASCII 键名（`^[A-Za-z0-9_-]+`），
 * 而导入目录里的 md 常写 `听众:` / `主题:` 这种中文键——那些正是我们要抽的字段。
 */
function readFrontmatterPairs(text = "") {
  const body = String(text ?? "");
  if (!body.startsWith("---")) return [];
  const end = body.indexOf("\n---", 3);
  if (end < 0) return [];
  const pairs = [];
  for (const line of body.slice(4, end).split("\n")) {
    if (!line.trim() || /^\s*[-#]/.test(line)) continue;
    const match = /^\s*([^:\s][^:]{0,31}?)\s*[：:]\s*(.*)$/.exec(line);
    if (!match) continue;
    pairs.push([match[1].trim(), match[2].trim()]);
  }
  return pairs;
}

function cleanFieldValue(value) {
  return String(value ?? "").replace(/\s+/g, " ").replace(/\*\*/g, "").trim();
}

/**
 * 从一段 md 里抽意图字段：
 * 1. frontmatter（`audience:` / `听众:` 等）；
 * 2. `**听众**：…` 这种结构化字段行（Deckline 自己的 intent.md 就是这个写法）。
 * 只抽「已经写好的」，不推断；返回 `sources` 方便在说明里交代每个字段从哪来。
 */
export function extractIntentFields(text = "") {
  const fields = {};
  const sources = {};
  const body = String(text ?? "");
  if (!body.trim()) return { fields, sources };

  const metaEntries = readFrontmatterPairs(body);
  for (const { key, labels } of INTENT_FIELDS) {
    for (const label of labels) {
      const hit = metaEntries.find(([name]) => String(name).trim().toLowerCase() === label.toLowerCase());
      if (!hit) continue;
      const value = cleanFieldValue(hit[1]);
      if (isEmptyPlaceholder(value)) continue;
      fields[key] = value;
      sources[key] = `frontmatter · ${hit[0]}`;
      break;
    }
  }

  for (const line of body.split("\n")) {
    const match = /^\s*[-*]?\s*\*\*([^*]{1,16})\*\*\s*[：:]\s*(.+)$/.exec(line);
    if (!match) continue;
    const label = match[1].trim();
    const value = cleanFieldValue(match[2]);
    if (isEmptyPlaceholder(value)) continue;
    for (const { key, labels } of INTENT_FIELDS) {
      if (fields[key]) continue;
      if (labels.some((item) => label.toLowerCase() === item.toLowerCase())) {
        fields[key] = value;
        sources[key] = `「${label}」字段`;
      }
    }
  }
  return { fields, sources };
}

/**
 * 标题启发：md 里 `#` / `##` 标题的条数**正好等于页数**（或多一条文档大标题）时，
 * 才把它们当逐页标题——数量对不上就宁可不用，也不硬塞。
 */
export function headingsAsTitles(text = "", pageCount = 0) {
  const count = Number(pageCount) || 0;
  if (!count) return [];
  const heads = String(text ?? "")
    .split("\n")
    .map((line) => /^(#{1,2})\s+(.+?)\s*$/.exec(line.trim()))
    .filter(Boolean)
    .map((match) => match[2].replace(/\*\*/g, "").replace(/^\d+[.、)]\s*/, "").trim())
    .filter(Boolean);
  if (heads.length === count) return heads;
  if (heads.length === count + 1) return heads.slice(1);
  return [];
}

/** 一份 md 能不能当这台 deck 的 script：逐页解析出来的页数必须和 PDF 页数一致。 */
export function scriptPagesFromMarkdown(text = "") {
  const body = String(text ?? "");
  if (!body.trim()) return [];
  const table = parseStoryPages(body);
  const rows = table.length ? table : parseSectionedPages(body);
  return rows.filter((row) => row && Number(row.page) > 0);
}

/**
 * 把 `createDeck()` 写出来的占位 `**标题**：待定` 换成导入时推出来的页标题。
 * 不改分节头（`### P01 · …` 在建档时已经是目标标题），只补「标题」字段——
 * 否则 deck 列表 / 工作台每一页都显示「待定」，等于没导入。
 */
export function applyImportedTitles(scriptText = "", titles = []) {
  let index = 0;
  return String(scriptText ?? "").replace(/^\*\*标题\*\*\s*[：:].*$/gm, (line) => {
    const title = String(titles[index] ?? "").trim();
    index += 1;
    return title ? `**标题**：${title}` : line;
  });
}

/**
 * 导入说明（写在 intent.md 末尾）：把「哪些是抽到的、哪些是占位、哪些没做」一次交代清楚，
 * 避免用户或 Agent 把导入的占位当成已确认的意图。
 */
export function buildImportNote({
  pdfName = "",
  pageCount = 0,
  dpi = PDF_IMPORT_DEFAULT_DPI,
  mdFiles = [],
  fieldSources = {},
  warnings = [],
} = {}) {
  const lines = [
    "## 导入说明（推断 · 待确认）",
    "",
    `- 来源：\`${pdfName || "（未知 PDF）"}\` —— ${Number(pageCount) || 0} 页 · ${Number(dpi) || PDF_IMPORT_DEFAULT_DPI} dpi，每页已落成整页图 \`pages/p01.png…\`。`,
    `- 抽到的 md：${mdFiles.length ? mdFiles.map((name) => `\`${name}\``).join("、") : "（目录里没有 md）"}。`,
  ];
  const sourced = Object.entries(fieldSources ?? {}).filter(([, from]) => from);
  lines.push(
    `- 上面字段的来源：${sourced.length ? sourced.map(([key, from]) => `${key} ← ${from}`).join("；") : "没有抽到现成字段，全部是占位"}。`,
  );
  lines.push("- 没做的：**逐页看图推断意图**（本轮不做视觉推理）。需要时让 Agent 读整页图后补这里。");
  lines.push("- 提醒：导入的整页图是**参考 baseline**（`rev=source`），不是最终交付图；要重出图请走正常出图流程。");
  for (const warning of Array.isArray(warnings) ? warnings : []) lines.push(`- ⚠️ ${warning}`);
  lines.push("");
  return lines.join("\n");
}

/** 列导入目录（只读一层，不递归）：返回 PDF / md 的文件对象。 */
export function listImportDir(dir) {
  const names = readdirSync(dir).filter((name) => !name.startsWith("."));
  const { pdfs, markdown } = classifyImportNames(names);
  const stat = (name) => {
    const path = join(dir, name);
    const info = statSync(path);
    return { name, path, sizeBytes: info.size };
  };
  return {
    dir,
    pdfs: pdfs.map(stat),
    markdown: markdown.map(stat),
  };
}

/** poppler 的 pdftoppm 在不在（只用于提前给人话提示）。 */
export function hasPdftoppm() {
  try {
    execFileSync("pdftoppm", ["-v"], { stdio: "ignore", timeout: 10_000 });
    return true;
  } catch (error) {
    return error?.code !== "ENOENT";
  }
}

/**
 * PDF → 每页 PNG。
 * 输出名统一成 `p01.png … pNN.png`（两位补零，超过 99 页按实际位数），
 * 与 `source-adapter.sourceImages()` 认的 `P01.png` 约定一致（大小写都认）。
 */
export function rasterizePdfToPng({ pdfPath, outDir, dpi = PDF_IMPORT_DEFAULT_DPI } = {}) {
  if (!pdfPath || !existsSync(pdfPath)) throw new Error(`PDF 不存在：${pdfPath ?? "（空）"}`);
  const value = normalizeDpi(dpi);
  mkdirSync(outDir, { recursive: true });
  const rawPrefix = join(outDir, "raw");
  try {
    execFileSync("pdftoppm", ["-png", "-r", String(value), pdfPath, rawPrefix], {
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 20 * 60 * 1000,
    });
  } catch (error) {
    if (error?.code === "ENOENT") {
      const missing = new Error("PDF 导入需要 poppler 的 `pdftoppm`：macOS `brew install poppler`，Debian/Ubuntu `apt install poppler-utils`");
      missing.code = "pdftoppm-missing";
      throw missing;
    }
    const stderr = String(error?.stderr ?? "").trim();
    throw new Error(`PDF 转图片失败：${stderr || error?.message || "pdftoppm 退出异常"}`);
  }

  const produced = readdirSync(outDir)
    .filter((name) => /^raw-\d+\.png$/i.test(name))
    .map((name) => ({ name, page: Number(/^raw-(\d+)\.png$/i.exec(name)[1]) }))
    .sort((a, b) => a.page - b.page);
  if (!produced.length) throw new Error("pdftoppm 没有产出任何页图（PDF 可能损坏、加密或没有页面）");

  const files = produced.map((item, index) => {
    const pageId = `p${String(index + 1).padStart(2, "0")}`;
    const file = join(outDir, `${pageId}.png`);
    renameSync(join(outDir, item.name), file);
    return { pageId, file, bytes: statSync(file).size };
  });
  return { files, pageCount: files.length, dpi: value };
}
