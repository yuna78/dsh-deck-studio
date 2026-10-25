/**
 * 逐页 script 微调写回（页面内编辑 → 源 script.md + prompts/Pxx.txt）。
 *
 * 只允许两件事：
 *   1. 改某一页的 **标题** / **副标题（或页面标签）** 字段值；
 *   2. 改这一页标题行以下的**正文**（其它字段、bullet 原样交回）；
 *   3. 改这一页的 image prompt（prompts/Pnn.txt）。
 *
 * 不新增页、不删页、不动其它页。写回后由调用方 git 提交。
 * 表格惯例（`| 页 | 标题 | … |`）的 deck 不支持正文级编辑（源头是表格，逐页正文没有单独段落）。
 * @module dsh-plugin-deck-studio/script-writer
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { parseSectionedPages } from "./source-adapter.js";

const readText = (file) => (existsSync(file) ? readFileSync(file, "utf8") : null);

/** `### P04 · 案例闪卡 01：商业运营 / 数据分析` */
const pageHeadRe = (page) => new RegExp(`^#{2,3}\\s*P0*${page}\\s*[·.\\-–—:]?`);
const anyHeading = /^#{1,4}\s/;

/** 页号 → 该页 heading 在行数组里的范围。 */
function sectionRange(lines, page) {
  const headRe = pageHeadRe(page);
  const start = lines.findIndex((line) => headRe.test(line.trim()));
  if (start < 0) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (anyHeading.test(lines[i])) {
      end = i;
      break;
    }
  }
  return { start, end };
}

/** 读取一页的可编辑视图（编辑器预填）。 */
export function pageEditView(adapter, pageId) {
  const page = Number(String(pageId).replace(/^p/i, ""));
  if (!Number.isFinite(page) || page <= 0) return null;
  const script = adapter?.readScriptRaw?.() ?? readText(join(adapter?.sourceRoot ?? "", "script.md"));
  if (!script) return null;
  const pages = parseSectionedPages(script);
  const hit = pages.find((item) => item.page === page);
  if (!hit) {
    return { page, unsupported: true, reason: "该 deck 的 script 不是「### Pxx + **字段**：值」分节惯例，暂不支持逐页正文编辑" };
  }
  const lines = script.split("\n");
  const range = sectionRange(lines, page);
  if (!range) return null;
  const heading = lines[range.start];
  // 标题 / 副标题 / 页面标签 三个字段单独编辑，其余原文进 body。
  const titleKey = "标题" in hit.fields ? "标题" : null;
  const subtitleKey = "副标题" in hit.fields ? "副标题" : "页面标签" in hit.fields ? "页面标签" : null;
  const bodyLines = lines
    .slice(range.start + 1, range.end)
    .filter((line) => {
      if (titleKey && new RegExp(`^\\s*\\*\\*${titleKey}\\*\\*\\s*[：:]`).test(line)) return false;
      if (subtitleKey && new RegExp(`^\\s*\\*\\*${subtitleKey}\\*\\*\\s*[：:]`).test(line)) return false;
      return true;
    });
  const pageIdNormalized = `p${String(page).padStart(2, "0")}`;
  // F-133：分节里显式写了「正文」字段时，Inspector 的正文框只显示正文本身；
  // 以前把整节（主张 / 正文 / 提示词 / 画面说明）都塞进来，用户看到的其实是意图和提示词。
  const hasBodyField = "正文" in hit.fields;
  return {
    page,
    pageId: pageIdNormalized,
    heading,
    titleKey: titleKey ?? "标题",
    subtitleKey: subtitleKey ?? "副标题",
    bodyKey: hasBodyField ? "正文" : null,
    title: titleKey ? hit.fields[titleKey] ?? "" : hit.section ?? "",
    subtitle: subtitleKey ? hit.fields[subtitleKey] ?? "" : "",
    body: hasBodyField
      ? hit.fields["正文"] ?? ""
      : bodyLines.join("\n").replace(/^\n+/, "").replace(/\n+$/, ""),
    prompt: adapter?.prompts?.()[pageIdNormalized] ?? "",
  };
}

/**
 * 写回一页。
 * @param {object} input
 * @param {string} input.sourceRoot
 * @param {number} input.page
 * @param {string} input.title
 * @param {string} input.subtitle
 * @param {string} input.body
 * @param {string|null} [input.prompt]  null / undefined = 不改 prompt
 * @returns {{files: string[], changed: string[]}}
 */
export function savePageEdit({ sourceRoot, page, title, subtitle, body, prompt }) {
  const scriptPath = join(sourceRoot, "script.md");
  const script = readText(scriptPath);
  if (!script) throw new Error("源 deck 没有 script.md");
  const lines = script.split("\n");
  const range = sectionRange(lines, page);
  if (!range) throw new Error(`script.md 里找不到 P${page} 分节（当前 deck 可能不是分节惯例）`);

  const current = parseSectionedPages(script).find((item) => item.page === page);
  const titleKey = current && "标题" in current.fields ? "标题" : "标题";
  const subtitleKey = current && "副标题" in current.fields ? "副标题" : current && "页面标签" in current.fields ? "页面标签" : null;

  const bodyKey = current && "正文" in current.fields ? "正文" : null;
  const bodyText = String(body ?? "").replace(/^\n+/, "").replace(/\n+$/, "");
  const escapeRe = (text) => String(text).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // 字段级替换：`**字段**：值` 这一行换成新值；字段不存在就插到这一节开头。
  const setFieldLine = (sectionLines, key, value) => {
    const pattern = new RegExp(`^\\s*\\*\\*${escapeRe(key)}\\*\\*\\s*[：:]`);
    const index = sectionLines.findIndex((line) => pattern.test(line));
    const next = String(value ?? "").trim();
    if (index >= 0) {
      if (next) sectionLines[index] = `**${key}**：${next}`;
      else sectionLines.splice(index, 1);
      return;
    }
    if (next) sectionLines.unshift(`**${key}**：${next}`);
  };

  let replacement;
  if (bodyKey) {
    // F-133：只改 标题 / 副标题 / 正文 三个字段，主张、画面说明、提示词等原样保留。
    const sectionLines = lines.slice(range.start + 1, range.end);
    while (sectionLines.length && !sectionLines[0].trim()) sectionLines.shift();
    while (sectionLines.length && !sectionLines[sectionLines.length - 1].trim()) sectionLines.pop();
    setFieldLine(sectionLines, titleKey, title);
    if (subtitleKey) setFieldLine(sectionLines, subtitleKey, subtitle);
    // 正文按单行字段写：换行折叠成空格，避免续行滑出字段、落回整节正文。
    setFieldLine(sectionLines, bodyKey, bodyText.replace(/\s*\n+\s*/g, " "));
    replacement = ["", ...sectionLines, ""];
  } else {
    const paragraphs = [];
    if (String(title ?? "").trim()) paragraphs.push(`**${titleKey}**：${String(title).trim()}`);
    if (subtitleKey && String(subtitle ?? "").trim()) paragraphs.push(`**${subtitleKey}**：${String(subtitle).trim()}`);
    if (bodyText) paragraphs.push(bodyText);
    replacement = ["", ...paragraphs.join("\n\n").split("\n"), ""];
  }
  const nextLines = [...lines.slice(0, range.start + 1), ...replacement, ...lines.slice(range.end)];
  let nextScript = nextLines.join("\n");
  nextScript = nextScript.replace(/\n{3,}/g, "\n\n");
  if (!nextScript.endsWith("\n")) nextScript += "\n";

  const changed = [];
  if (nextScript !== script) {
    writeFileSync(scriptPath, nextScript, "utf8");
    changed.push(scriptPath);
  }

  const pageId = `p${String(page).padStart(2, "0")}`;
  if (typeof prompt === "string") {
    const dir = join(sourceRoot, "prompts");
    mkdirSync(dir, { recursive: true });
    const promptPath = join(dir, `P${String(page).padStart(2, "0")}.txt`);
    const existing = readText(promptPath);
    if (existing !== prompt) {
      writeFileSync(promptPath, prompt.endsWith("\n") ? prompt : `${prompt}\n`, "utf8");
      changed.push(promptPath);
    }
  }
  return { files: changed, changed, page, pageId };
}
