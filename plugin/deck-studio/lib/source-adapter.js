/**
 * 本地受控源 adapter（DeckSourceAdapter 最小实现）。
 *
 * 只读：script.md（frontmatter + 逐页表格）、build/deck.yaml（页序 manifest）、
 * CURRENT.md（做到哪）、feedback.md（反馈行）。客户正文只进会话与 `.deck/`，
 * 永不回写源目录、永不复制进 Git。
 *
 * 表格解析按「第一列 = 页号，后接标题 / 回答 / 主张 / 来源」的既有 deck 惯例；
 * 缺单元格补空串，行结构不齐不炸——读不到就如实返回空 + 警告。
 * @module dsh-plugin-deck-studio/source-adapter
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/** 读文本文件；不存在返回 null。 */
function readText(file) {
  try {
    return existsSync(file) ? readFileSync(file, "utf8") : null;
  } catch {
    return null;
  }
}

/** 解析 frontmatter（`---` 围栏，顶层 `key: value`；嵌套结构忽略）。 */
export function parseFrontmatter(text) {
  if (typeof text !== "string" || !text.startsWith("---")) return {};
  const end = text.indexOf("\n---", 3);
  if (end < 0) return {};
  const meta = {};
  for (const line of text.slice(4, end).split("\n")) {
    const match = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line);
    if (match && !line.startsWith(" ") && !line.startsWith("-")) meta[match[1]] = match[2].trim();
  }
  return meta;
}

/** 把一行 markdown 表格行拆成单元格（去首尾 `|`、去分隔行）。 */
function splitRow(line) {
  return line.replace(/^\|/, "").replace(/\|\s*$/, "").split("|").map((cell) => cell.trim());
}

function isSeparator(line) {
  return /^\|[\s:|-]+\|?\s*$/.test(line);
}

/** 抓取所有包含指定表头关键词的 markdown 表：返回行数组的数组。 */
function findTables(text, headerKeywords) {
  if (!text) return [];
  const lines = text.split("\n");
  const tables = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line.startsWith("|") || isSeparator(line)) continue;
    const head = splitRow(line).join(" ");
    if (!headerKeywords.every((keyword) => head.includes(keyword))) continue;
    const rows = [];
    for (let j = i + 1; j < lines.length; j += 1) {
      const row = lines[j];
      if (!row.startsWith("|")) break;
      if (isSeparator(row)) continue;
      rows.push(splitRow(row));
    }
    tables.push(rows);
    i += 1 + rows.length; // 跳过已消费的表体（分隔行 + 行）
  }
  return tables;
}

/** 第一张匹配表的行（CURRENT / feedback 用）。 */
function findTable(text, headerKeywords) {
  return findTables(text, headerKeywords)[0] ?? [];
}

/**
 * 从 script.md 抽逐页行：`| N | 标题 | 这页回答… | 主张 | 来源 |`。
 * 正文与附录可能各有一张同构表——全部收集；页号跨表应唯一，重复时保序去重。
 */
export function parseStoryPages(scriptText) {
  const pages = [];
  const seen = new Set();
  for (const table of findTables(scriptText, ["页", "标题"])) {
    for (const cells of table) {
      const page = Number.parseInt(String(cells[0] ?? "").replace(/\D/g, ""), 10);
      if (!Number.isFinite(page) || page <= 0 || seen.has(page)) continue;
      seen.add(page);
      pages.push({
        page,
        title: cells[1] ?? "",
        question: cells[2] ?? "",
        claim: cells[3] ?? "",
        content: cells[2] ?? "",
        source: cells[4] ?? "",
      });
    }
  }
  return pages;
}

/**
 * 解析「按页分节」的 script（另一种既有 deck 惯例）：
 *
 *     ### P04 · 案例闪卡 01：商业运营 / 数据分析
 *     **标题**：从"拼报告"，到"可复用的洞察链路"
 *     **页面标签**：案例闪卡 01｜商业运营 / 数据分析团队
 *
 * 没有 `|页|标题|` 表格时用它。字段按 `**字段**：值` 收集；列表内容留在 body。
 * 页号来自 `### P<digits>`，标题缺字段时退回分节标题。
 */
export function parseSectionedPages(scriptText) {
  if (!scriptText) return [];
  const pageHead = /^#{2,3}\s*P(\d+)\s*[·.\-–—:]?\s*(.*)$/;
  const fieldLine = /^\*\*([^*]+)\*\*\s*[：:]\s*(.*)$/;
  const pages = [];
  let current = null;
  const flush = () => {
    if (!current) return;
    const fields = current.fields;
    // 没写「副标题 / 页面标签」的页（总纲、能力线等），拿正文第一段当「这页回答」，
    // 跳过 `**目标一｜…**` 这种小标题行和表格行，避免空字段直接漏到卡片上。
    const excerpt = current.body
      .map((line) => line.trim())
      .filter((line) => line && !/^\*\*[^*]+\*\*$/.test(line) && !line.startsWith("|") && !/^-{3,}$/.test(line))
      .map((line) => line.replace(/^[-*+]\s+/, "").replace(/^>\s?/, "").replace(/\*\*/g, "").trim())
      .find((line) => line.length >= 6) ?? "";
    pages.push({
      page: current.page,
      section: current.section,
      fields,
      title: fields["标题"] || current.section || "",
      question: fields["副标题"] || fields["页面标签"] || excerpt.slice(0, 110),
      claim: fields["主张"] || fields["为什么值得 AI 做"] || fields["为什么值得 Agent 做"] || fields["讲述意图"] || fields["画面说明"] || "",
      // 整页正文（标题行以下全部原文）：storyline / 脚本标签要能完整展示，不能只剩一句摘录。
      content: current.body.join("\n").replace(/\n{3,}/g, "\n\n").trim(),
      source: "script.md",
    });
    current = null;
  };
  for (const line of scriptText.split("\n")) {
    const head = pageHead.exec(line.trim());
    if (head) {
      flush();
      current = { page: Number(head[1]), section: head[2].trim(), fields: {}, body: [] };
      continue;
    }
    if (!current) continue;
    if (/^#{1,4}\s/.test(line)) {
      flush();
      continue;
    }
    const field = fieldLine.exec(line.trim());
    if (field) {
      current.fields[field[1].trim()] = field[2].trim();
      continue;
    }
    current.body.push(line);
  }
  flush();
  return pages.filter((page) => page.page > 0);
}

/**
 * 解析附录表（`| 页 | 内容 | 来源 |`，页列可能是 `A1` 或 `A3–A10` 区间）。
 * 区间按原样保留，不展开成单页——附录页在源里就是区间登记。
 */
export function parseAppendixRows(scriptText) {
  const rows = [];
  for (const table of findTables(scriptText, ["页", "内容"])) {
    for (const cells of table) {
      const id = String(cells[0] ?? "").trim();
      if (!id || /^[0-9]+$/.test(id)) continue; // 正文页号列走 parseStoryPages
      rows.push({ id, content: cells[1] ?? "", source: cells[2] ?? "" });
    }
  }
  return rows;
}

/** 展开附录 id（`A1` / `A3–A10`）为页数，用于与 deck.yaml 对账。 */
export function appendixRowCount(rows) {
  let count = 0;
  for (const row of rows) {
    const range = /^A(\d+)\s*[–-]\s*A(\d+)$/.exec(row.id);
    if (range) count += Math.abs(Number(range[2]) - Number(range[1])) + 1;
    else count += 1;
  }
  return count;
}

/** 解析 build/deck.yaml：顶层 title + `- custom: <path>` 页序。 */
export function parseDeckYaml(yamlText) {
  if (!yamlText) return { title: "", pages: [] };
  const titleMatch = /^title:\s*(.+)$/m.exec(yamlText);
  const pages = [];
  for (const match of yamlText.matchAll(/^\s*-\s*(?:custom|html|page)\s*:\s*(\S+)\s*$/gm)) {
    pages.push(match[1]);
  }
  return { title: titleMatch ? titleMatch[1].trim().replace(/^["']|["']$/g, "") : "", pages };
}

/**
 * 创建一个只读 deck 源 adapter。
 * @param {{id: string, label: string, sourceRoot: string}} deck - config.decks 的一项。
 */
export function createLocalSourceAdapter(deck) {
  const { id, label, sourceRoot } = deck;

  function scriptPath() {
    return join(sourceRoot, "script.md");
  }

  return {
    get id() {
      return id;
    },
    get label() {
      return label;
    },
    get sourceRoot() {
      return sourceRoot;
    },

    /** 源是否可读（script.md 存在）。 */
    available() {
      return existsSync(scriptPath());
    },

    /** 全量概览：不抛错，缺什么报什么。 */
    overview() {
      const script = readText(scriptPath());
      const meta = parseFrontmatter(script ?? "");
      const current = readText(join(sourceRoot, "CURRENT.md"));
      const feedback = readText(join(sourceRoot, "feedback.md"));
      const deckYaml = parseDeckYaml(readText(join(sourceRoot, "build", "deck.yaml")));
      const tablePages = parseStoryPages(script ?? "");
      const sectioned = tablePages.length ? [] : parseSectionedPages(script ?? "");
      const pages = tablePages.length ? tablePages : sectioned;
      const appendix = parseAppendixRows(script ?? "");
      const appendixCount = appendixRowCount(appendix);
      const expectedYaml = pages.length + appendixCount;
      return {
        id,
        label,
        sourceRoot,
        available: Boolean(script),
        meta,
        // deck 标题优先取 build manifest（deck.yaml），其次 script frontmatter，最后 label。
        title: deckYaml.title || meta.title || label,
        status: meta.status ?? "",
        updated: meta.updated ?? "",
        pageCount: pages.length,
        appendixCount,
        appendixRows: appendix,
        yamlPageCount: deckYaml.pages.length,
        currentTable: findTable(current ?? "", ["阶段", "状态"]).slice(0, 12),
        feedbackCount: findTable(feedback ?? "", ["日期", "原话"]).length,
        warnings: [
          ...(script && pages.length === 0 ? [`${id}: script.md 存在但没解析出逐页（表格或 P 分节均无）`] : []),
          ...(script && deckYaml.pages.length > 0 && deckYaml.pages.length !== expectedYaml
            ? [`${id}: deck.yaml 页数(${deckYaml.pages.length}) ≠ script 逐页(${pages.length}) + 附录(${appendixCount})`]
            : []),
        ],
      };
    },

    /** 逐页行（升序）：优先表格惯例，其次 `### Pxx` 分节惯例。 */
    storyPages() {
      const text = readText(scriptPath()) ?? "";
      const tableRows = parseStoryPages(text);
      const rows = tableRows.length ? tableRows : parseSectionedPages(text);
      return rows.sort((a, b) => a.page - b.page);
    },

    /** 每页 visualBrief（源侧已写好的 image prompt：`prompts/P01.txt`）。 */
    prompts() {
      const dir = join(sourceRoot, "prompts");
      const out = {};
      if (!existsSync(dir)) return out;
      for (const name of readdirSync(dir)) {
        const match = /^[Pp](\d+)\.(txt|md)$/.exec(name);
        if (!match) continue;
        out[`p${String(Number(match[1])).padStart(2, "0")}`] = readText(join(dir, name)) ?? "";
      }
      return out;
    },

    /** 源里已出好的整页图（image deck 的 ppt 本体）：`outputs/full/final/P01.png` 等。 */
    sourceImages() {
      const out = {};
      const dirs = ["outputs/full/final", "outputs/final", "pages", "images", "exports"];
      for (const dir of dirs) {
        const full = join(sourceRoot, dir);
        if (!existsSync(full)) continue;
        for (const name of readdirSync(full)) {
          const match = /^[Pp](\d+)\.(png|jpg|jpeg|webp)$/i.exec(name);
          if (!match) continue;
          const pageId = `p${String(Number(match[1])).padStart(2, "0")}`;
          if (out[pageId]) continue;
          const file = join(full, name);
          out[pageId] = { path: file, ext: `.${match[2].toLowerCase()}`, sizeBytes: statSync(file).size };
        }
      }
      return out;
    },

    /** 附录行（区间按源文件原样）。 */
    appendixRows() {
      return parseAppendixRows(readText(scriptPath()) ?? "");
    },

    /** deck.yaml 页序（与逐页行按下标对应）。 */
    yamlPages() {
      return parseDeckYaml(readText(join(sourceRoot, "build", "deck.yaml"))).pages;
    },

    /** 原始 script 文本（diff / 工作副本初始化用）。 */
    readScriptRaw() {
      return readText(scriptPath());
    },

    /** 反馈行。 */
    feedbackRows(limit = 20) {
      return findTable(readText(join(sourceRoot, "feedback.md")) ?? "", ["日期", "原话"])
        .slice(0, limit)
        .map((cells) => ({ date: cells[0] ?? "", target: cells[1] ?? "", quote: cells[2] ?? "", action: cells[3] ?? "", layer: cells[4] ?? "", tags: cells[5] ?? "" }));
    },
  };
}
