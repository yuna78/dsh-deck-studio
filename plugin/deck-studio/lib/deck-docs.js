/**
 * Deck 文档治理（每份 deck 都必须有的 9 份文档 + 治理检查）。
 *
 * 这份模块是「一个 deck 应该长什么样」的唯一事实来源（docs/deck-documents.md 是给
 * 人看的契约，这里是可执行的实现）：
 *
 *   0. 意图 intent.md        —— 听众 / 主题 / 希望带走什么（缺了它，后面全是猜）
 *   （故事线已并入脚本派生概览 + intent.md 的叙事小节，不再单独成文，见 ADR-0016）
 *   2. 脚本 script.md        —— 每页 正标题 / 副标题 / 内容 / 提示词
 *   3. Design design.md      —— 画面约束、模板、色板、出图参数
 *   4. 修改日志 changelog.md —— 谁在什么时候改了什么、为什么
 *   5. 反馈 feedback.md      —— 用户原话 / 处理 / 分层 / 标签
 *   6. 调研 research/        —— 每条有出处、发表时间、原文链接、本地存档、总结
 *   7. 支撑材料 materials.md —— 内部项目记录：文件名 / 链接 / 总结
 *
 * 两级位置：
 *   - **源 deck（客户目录，只读）**：现实里已有的文档，我们只读、只检查；
 *   - **工作副本 `.deck/decks/<deckId>/`**：缺的文档由 Agent 起草到这里（draft），
 *     调研原文下载到 `research/files/`，人确认后再回写源（不在本模块做）。
 *
 * 状态：ok / partial（有文件但字段不齐）/ derived（从 script 自动派生）/ draft（仅工作副本）/
 *       missing（完全没有）。缺文档不阻塞读，但进治理清单。
 * @module dsh-plugin-deck-studio/deck-docs
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { parseFrontmatter } from "./source-adapter.js";

/* ------------------------------------------------------------------ *
 * 文档规格
 * ------------------------------------------------------------------ */

/**
 * @typedef {object} DocSpec
 * @property {string} id
 * @property {string} label
 * @property {string} purpose
 * @property {string[]} candidates 源 deck 里的候选文件名（按优先级）
 * @property {string[]} aliases    相关但不算主文件的（retro / case-cards / research-status）
 * @property {boolean} [derivable] 没有专门文件时能否从 script 派生
 * @property {string} [template]   scaffold 用的模板 key
 */

/** @type {DocSpec[]} */
export const DOC_SPECS = [
  {
    id: "intent",
    label: "意图",
    purpose: "讲给谁、讲什么、希望大家带走什么",
    candidates: ["intent.md"],
    template: "intent",
  },
  {
    id: "script",
    label: "脚本",
    purpose: "逐页 正标题 / 副标题 / 内容 / 提示词",
    candidates: ["script.md"],
    aliases: ["prompts"],
    template: "script",
  },
  {
    id: "design",
    label: "Design",
    purpose: "画面约束、模板、色板、出图参数",
    candidates: ["design.md", "style-reference.md"],
    template: "design",
  },
  {
    id: "changelog",
    label: "修改日志",
    purpose: "谁在什么时候改了什么、为什么、谁确认",
    candidates: ["changelog.md", "CURRENT.md"],
    template: "changelog",
  },
  {
    id: "feedback",
    label: "反馈",
    purpose: "用户原话 / 处理 / 分层 / 标签，改稿前先落档",
    candidates: ["feedback.md"],
    aliases: ["retro.md"],
    template: "feedback",
  },
  {
    id: "research",
    label: "调研",
    purpose: "每条：出处 / 发表时间 / 原文链接 / 本地存档 / 总结",
    candidates: ["research/index.md", "external-case-research.md"],
    aliases: ["research-status.md", "case-cards.md"],
    template: "research",
  },
  {
    id: "materials",
    label: "支撑材料",
    purpose: "内部项目记录与素材：文件名 / 链接 / 总结",
    candidates: ["materials.md"],
    template: "materials",
  },
  {
    id: "review",
    label: "审稿",
    // F-187：评审产出按「读者 → 负责人 → 工程」排序，听众读后感放第一个（原来只有工程口径的 review.md）。
    purpose: "听众读后感（人话）· 意图与听众差距 · 工程口径的问题清单 / 证据 / 修复建议",
    candidates: ["review.readers.md", "review.gap.md", "review.md", "review.experts.md", "review.images.md", "review.scores.md"],
    aliases: ["review.readers.md", "review.gap.md", "review.experts.md", "review.images.md", "review.scores.md"],
    template: "review",
  },
  {
    id: "factcheck",
    label: "事实核对",
    purpose: "核对表：断言 → 来源 → 一致 / 冲突 / 无依据",
    candidates: ["fact-check.md", "factcheck.md"],
    template: "factcheck",
  },
];

/** 必需字段（用于 partial 判定）。 */
const REQUIRED_FIELDS = {
  intent: ["听众", "主题", "带走"],
  design: ["画面约束", "模板"],
};

/* ------------------------------------------------------------------ *
 * 解析
 * ------------------------------------------------------------------ */

/** 模板占位符（TODO / 待填 / 待确认）不算已填。 */
const isPlaceholder = (value) => !value || /TODO|todo|待填|待确认|（待/.test(String(value));

const readText = (file) => {
  try {
    return existsSync(file) ? readFileSync(file, "utf8") : null;
  } catch {
    return null;
  }
};

const sizeOf = (file) => {
  try {
    return statSync(file).size;
  } catch {
    return 0;
  }
};

/** `**字段**：值` 与 `- **字段**：值` 两种写法都收。 */
export function parseFieldLines(text) {
  const fields = {};
  if (!text) return fields;
  for (const line of text.split("\n")) {
    const match = /^\s*(?:[-*]\s*)?\*\*([^*]+)\*\*\s*[：:]\s*(.*)$/.exec(line);
    if (!match) continue;
    const key = match[1].trim();
    if (fields[key] == null) fields[key] = match[2].trim();
  }
  return fields;
}

/** 某个 `## 标题` 下的正文（到下一个同级/更高级标题为止）。 */
export function sectionBody(text, keyword) {
  if (!text) return "";
  const lines = text.split("\n");
  const start = lines.findIndex((line) => /^#{2,3}\s/.test(line) && line.includes(keyword));
  if (start < 0) return "";
  const level = (lines[start].match(/^#+/) ?? ["##"])[0].length;
  const body = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    const heading = /^(#{1,6})\s/.exec(lines[i]);
    if (heading && heading[1].length <= level) break;
    body.push(lines[i]);
  }
  return body.join("\n").trim();
}

/** 解析第一个 markdown 表（返回 {head, rows}，rows 为对象数组）。 */
export function parseTable(text) {
  return parseTables(text)[0] ?? { head: [], rows: [] };
}

/** 解析文本里**所有**表格块（F-96：分批调研每批追加一张表，只取第一张会漏掉后续批次）。 */
export function parseTables(text) {
  if (!text) return [];
  const lines = text.split("\n");
  const tables = [];
  for (let i = 0; i < lines.length - 1; i += 1) {
    if (!lines[i].trim().startsWith("|")) continue;
    const head = lines[i].trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((cell) => cell.trim());
    if (!/^[\s:|-]+$/.test(lines[i + 1].trim())) continue;
    const rows = [];
    let j = i + 2;
    for (; j < lines.length; j += 1) {
      if (!lines[j].trim().startsWith("|")) break;
      const cells = lines[j].trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((cell) => cell.trim());
      rows.push(Object.fromEntries(head.map((key, index) => [key, cells[index] ?? ""])));
    }
    tables.push({ head, rows });
    i = j;
  }
  return tables;
}

/** 设计约束：`## 视觉规则` 下的 bullet 列表。 */
export function parseDesignRules(text) {
  // 兼容三种既有写法：`## 视觉规则` / `## 画面约束` / 风格规范里的 `## 三条铁律`。
  // 条目既可能是 bullet，也可能是编号列表（1. …），统一归一。
  const body =
    sectionBody(text, "视觉规则") ||
    sectionBody(text, "画面约束") ||
    sectionBody(text, "规则") ||
    sectionBody(text, "铁律");
  return body
    .split("\n")
    .filter((line) => /^\s*(?:[-*]|\d+[.、])\s+/.test(line))
    .map((line) => line.replace(/^\s*(?:[-*]|\d+[.、])\s+/, "").trim())
    .filter(Boolean);
}

/**
 * 调研台账条目：
 *
 * A. 标准表格：`| 出处 | 标题 | 发表时间 | 原文链接 | 本地文件 | 总结 |`
 * B. 现有源里的编号列表：`1. Axtria — xxx` + 下一行 URL
 *
 * 返回 [{source,title,date,url,localFile,summary}]
 */
export function parseResearchEntries(text) {
  if (!text) return [];
  const entries = [];
  const tables = parseTables(text);
  const urlHead = (table) => table.head.some((key) => /原文链接|链接|url/i.test(key));
  if (tables.some(urlHead)) {
    for (const table of tables.filter(urlHead)) {
      for (const row of table.rows) {
        const url = row["原文链接"] ?? row["链接"] ?? row["URL"] ?? "";
        if (!/^https?:\/\//.test(url) && !row["标题"]) continue;
        // 模板占位行（TODO / YYYY-MM-DD / https://）不算调研条目。
        if (/TODO|待补|待填|YYYY-MM-DD/.test(`${url} ${row["标题"]} ${row["总结"] ?? ""} ${row["出处"] ?? ""}`)) continue;
        entries.push({
          source: row["出处"] ?? row["来源"] ?? "",
          title: row["标题"] ?? "",
          date: row["发表时间"] ?? row["时间"] ?? "",
          url: /^https?:\/\//.test(url) ? url : "",
          localFile: row["本地文件"] ?? row["本地存档"] ?? "",
          summary: row["总结"] ?? "",
        });
      }
    }
    if (entries.length) return entries;
  }
  // 内部台账模式（F-96）：没有 URL 但写了「事实 → 出处」的表（分批调研每批落一张表）。
  for (const table of tables) {
    const sourceKey = table.head.find((key) => /出处|来源|文件|位置/.test(key));
    const summaryKey = table.head.find((key) => /总结|事实|摘要|说明/.test(key));
    if (!sourceKey || !summaryKey) continue;
    for (const row of table.rows) {
      const source = String(row[sourceKey] ?? "").trim();
      const summary = String(row[summaryKey] ?? "").trim();
      if (!source && !summary) continue;
      if (/TODO|待补|待填|YYYY-MM-DD/.test(`${source} ${summary}`)) continue;
      entries.push({
        source,
        title: row["标题"] ?? row["断言"] ?? "",
        date: row["发表时间"] ?? row["时间"] ?? "",
        url: (summary.match(/https?:\/\/[^\s)）|]+/) ?? source.match(/https?:\/\/[^\s)）|]+/) ?? [])[0] ?? "",
        localFile: row["本地文件"] ?? row["本地存档"] ?? "",
        summary,
      });
    }
  }
  if (entries.length) return entries;
  // 条目清单模式（F-96）：- **可引用事实**：… 出处：README.md 开头段；也认「F1｜事实 + 下一行 出处：」。
  const bulletLines = String(text).split("\n");
  for (let i = 0; i < bulletLines.length; i += 1) {
    const bullet = /^\s*[-*+]\s+(.+)$/.exec(bulletLines[i]);
    if (!bullet) continue;
    const body = bullet[1].trim();
    const inline = /出处\s*[：:]\s*(.+)$/.exec(body);
    let source = inline ? inline[1] : "";
    if (!source) {
      // 出处写在缩进续行（最多向下看 2 行，遇到下一个 bullet 就停）。
      for (let j = i + 1; j <= i + 2 && j < bulletLines.length; j += 1) {
        if (/^\s*[-*+]\s+/.test(bulletLines[j])) break;
        const cont = /出处\s*[：:]\s*(.+)$/.exec(bulletLines[j]);
        if (cont) {
          source = cont[1];
          break;
        }
      }
    }
    if (!source) continue;
    let summary = inline ? body.replace(/出处\s*[：:].*$/, "") : body;
    summary = summary
      .replace(/^\**\s*(?:可引用事实|事实|要点|总结)\s*\**\s*[：:＋+\s]*/, "")
      .replace(/^[FＦ]\d+\s*[｜|]\s*/, "")
      .replace(/\*\*/g, "")
      .trim();
    source = source.replace(/[）)]\s*[。.]?\s*$/, "").replace(/`/g, "").trim();
    if (!summary && !source) continue;
    if (/TODO|待补|待填|YYYY-MM-DD/.test(`${source} ${summary}`)) continue;
    entries.push({ source, title: "", date: "", url: "", localFile: "", summary: summary.slice(0, 300) });
  }
  if (entries.length) return entries;
  if (entries.length) return entries;
  // 编号列表模式：优先只看「外部来源索引 / 来源索引」段落（避免把正文编号误当调研条目），
  // 且必须有原文链接才算一条调研。
  const scoped = sectionBody(text, "外部来源") || sectionBody(text, "来源索引") || text;
  const lines = scoped.split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    const match = /^\s*(\d+)[.、]\s+(.+)$/.exec(lines[i]);
    if (!match) continue;
    let label = match[2].trim();
    let url = "";
    let localFile = "";
    for (let j = i + 1; j < Math.min(i + 4, lines.length); j += 1) {
      const line = lines[j].trim();
      const link = /^<?(https?:\/\/[^\s>]+)>?$/.exec(line);
      if (link && !url) {
        url = link[1];
        continue;
      }
      const local = /^本地[：:]\s*(.+)$/.exec(line);
      if (local) localFile = local[1].trim();
    }
    if (!url) continue;
    const date = /[（(](\d{4}-\d{2}-\d{2})[）)]/.exec(label)?.[1] ?? "";
    label = label.replace(/[（(]\d{4}-\d{2}-\d{2}[）)]\s*$/, "").trim();
    const dash = label.split(/\s+—\s+|\s+-\s+/);
    entries.push({
      source: dash.length > 1 ? dash[0].trim() : "",
      title: dash.length > 1 ? dash.slice(1).join(" — ").trim() : label,
      date,
      url,
      localFile,
      summary: "",
    });
  }
  return entries;
}

/** 反馈表 → 行对象。 */
export function parseFeedbackRows(text) {
  const { head, rows } = parseTable(text);
  if (!head.some((key) => key.includes("日期"))) return [];
  return rows.map((row) => ({
    date: row["日期"] ?? "",
    target: row["对象"] ?? "",
    quote: row["原话"] ?? "",
    action: row["处理"] ?? "",
    layer: row["层"] ?? "",
    tags: row["标签"] ?? "",
  }));
}

/** 故事结构表 → 段落。 */
export function parseStorySegments(text) {
  const { head, rows } = parseTable(text);
  if (!head.some((key) => key.includes("段落"))) return [];
  return rows.map((row) => ({ segment: row["段落"] ?? "", pages: row["页码"] ?? "", task: row["任务"] ?? "" }));
}

/** 修改日志：`- YYYY-MM-DD · 版本 · 说明` 或表格。 */
export function parseChangelogEntries(text) {
  if (!text) return [];
  const { head, rows } = parseTable(text);
  if (head.some((key) => /日期|时间/.test(key)) && head.some((key) => /改动|内容|说明/.test(key))) {
    return rows.map((row) => ({
      date: row["日期"] ?? row["时间"] ?? "",
      revision: row["版本"] ?? "",
      note: row["改动"] ?? row["内容"] ?? row["说明"] ?? "",
      who: row["确认"] ?? row["人"] ?? "",
    }));
  }
  return text
    .split("\n")
    .map((line) => /^\s*[-*]\s+(\d{4}-\d{2}-\d{2})\s*[·:：-]?\s*(.*)$/.exec(line))
    .filter(Boolean)
    .map((match) => ({ date: match[1], revision: "", note: match[2].trim(), who: "" }));
}

/* ------------------------------------------------------------------ *
 * 修改日志：系统自动生成变更流 + agent 补充说明
 * ------------------------------------------------------------------ */

/** 关键事件 → 修改日志里的动作名。 */
const CHANGE_KIND_LABEL = {
  // F-73：新建本身就是第一条修改痕迹；不加它，新 deck 的「修改日志」会显示"缺失"。
  "deck.created": "新建",
  "deck.deleted": "删除",
  "deck.render": "重出图",
  "deck.export": "导出",
  "deck.handoff": "交接包",
  "deck.qa": "QA",
  "deck.changelog.note": "说明",
  // F-78：Agent 补 intent / 支撑材料 / 调研，也要进修改日志（否则「为什么」丢了）。
  "deck.doc.update": "补文档",
};

/**
 * 把「手写条目 + script 版本 + 关键事件」合成一份变更流（新的在前）。
 * 这是修改日志的唯一来源：系统负责"发生了什么"，人/agent 只补"为什么"。
 */
export function buildChangeFeed({ entries = [], revisions = [], events = [] }) {
  const rows = [];
  for (const entry of entries) {
    rows.push({
      date: entry.date || "",
      kind: "手写",
      page: "",
      note: entry.note || "",
      actor: entry.who || "",
      revision: entry.revision || "",
    });
  }
  for (const revision of revisions) {
    const pageIds = revision.pageIds ?? revision.slideIds ?? (revision.page ? [revision.page] : []);
    // F-173：首稿自动落版的 revision 要有醒目标记（徽标 + 自改摘要），否则用户看不出「这版没经过确认」。
    const badge = String(revision.autolandBadge ?? "");
    const autoland = revision.autoland && typeof revision.autoland === "object" ? revision.autoland : null;
    rows.push({
      date: revision.savedAt || "",
      kind: badge || "改脚本",
      page: pageIds.join(","),
      note: revision.note || (autoland?.selfReview?.summary ? `自改摘要：${autoland.selfReview.summary}` : "script 编辑"),
      actor: autoland ? "agent（自动落版）" : revision.actor || "",
      revision: revision.revision || "",
      ...(autoland ? { autoland: { ...autoland, badge: badge || "首稿（自动落版，未经确认）" } } : {}),
    });
  }
  for (const event of events) {
    if (!CHANGE_KIND_LABEL[event.type]) continue;
    // deck.script.save 已经由 revision 行表达，避免重复。
    rows.push({
      date: event.timestamp || "",
      kind: CHANGE_KIND_LABEL[event.type],
      page: (event.slideIds ?? []).join(","),
      note: event.payload?.note || "",
      actor: event.actor || "",
      revision: "",
    });
  }
  return rows.sort((a, b) => String(b.date).localeCompare(String(a.date)));
}

/**
 * agent 补一条变更说明：追加到工作副本 docs/changelog.md（交付物里可读），
 * 同时由调用方记 event（deck.changelog.note）。
 */
export function appendChangelogNote({ deckDir, note, pageId = "", actor = "agent" }) {
  if (!note || !String(note).trim()) throw new Error("note 不能为空");
  const file = draftPath(deckDir, "changelog");
  mkdirSync(join(file, ".."), { recursive: true });
  const date = new Date().toISOString().slice(0, 10);
  const scope = pageId ? ` ${pageId}` : "";
  const line = `- ${date} · ${scope}${String(note).trim()} · ${actor}\n`;
  if (!existsSync(file)) {
    writeFileSync(file, `---\ntitle: 修改日志\nstatus: active\n---\n\n# 修改日志\n\n> 系统自动记录变更；这里只补"为什么"。\n\n${line}`, "utf8");
  } else {
    appendFileSync(file, line, "utf8");
  }
  return { file, line: line.trim() };
}

/* ------------------------------------------------------------------ *
 * 解析后的文档视图
 * ------------------------------------------------------------------ */

function draftPath(deckDir, docId) {
  if (docId === "research") return join(deckDir, "docs", "research", "index.md");
  if (docId === "factcheck") return join(deckDir, "docs", "fact-check.md");
  return join(deckDir, "docs", `${docId}.md`);
}

function listResearchArchive(deckDir) {
  const dir = join(deckDir, "research", "files");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => !name.startsWith("."))
    .map((name) => {
      const file = join(dir, name);
      return { name, sizeBytes: sizeOf(file), path: file };
    });
}

/** 读工作副本 manifest（deck.json）；读不到就返回 null（治理解析不因坏文件崩）。 */
function readManifestJson(deckDir) {
  try {
    const file = join(deckDir, "deck.json");
    return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : null;
  } catch {
    return null;
  }
}

function slugOf(value) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

/**
 * 治理解析：返回 docs（不含大段 content）+ governance 汇总。
 * @param {object} input
 * @param {ReturnType<import('./source-adapter.js').createLocalSourceAdapter>|null} input.adapter
 * @param {string} input.deckDir
 * @param {object} [input.render] 渲染配置（design 文档要展示模型/尺寸）
 * @param {Array} [input.revisions] script revision 列表
 */
export function resolveDeckDocs({ adapter, deckDir, render = {}, revisions = [], events = [] }) {
  const sourceRoot = adapter?.sourceRoot ?? "";
  const script = adapter?.readScriptRaw?.() ?? readText(join(sourceRoot, "script.md")) ?? "";
  const meta = parseFrontmatter(script);
  const pages = adapter?.storyPages?.() ?? [];
  const prompts = adapter?.prompts?.() ?? {};
  const researchFiles = listResearchArchive(deckDir);

  const findSource = (names) => {
    for (const name of names) {
      const file = join(sourceRoot, name);
      if (existsSync(file)) return { name, file };
    }
    return null;
  };

  const docs = DOC_SPECS.map((spec) => {
    const sourceHit = findSource(spec.candidates);
    const draftFile = draftPath(deckDir, spec.id);
    const draftName = spec.id === "research" ? "research/index.md" : spec.id === "factcheck" ? "fact-check.md" : `${spec.id}.md`;
    const draft = existsSync(draftFile) ? { name: `docs/${draftName}`, file: draftFile } : null;
    const primary = sourceHit ?? draft;
    const kind = sourceHit ? "source" : draft ? "draft" : "none";
    const content = primary ? readText(primary.file) ?? "" : "";
    const doc = {
      id: spec.id,
      label: spec.label,
      purpose: spec.purpose,
      status: "missing",
      kind,
      primary: primary ? primary.name : null,
      // F-81：文档内容版本（mtime + size）——工作台轮询拿它判断「文件被外部改过」，
      // 没有它时状态/路径不变就永远不会刷新文档缓存（用户会一直看到旧正文）。
      version: primary ? `${primary.name}:${statSync(primary.file).mtimeMs}:${statSync(primary.file).size}` : "none",
      files: [],
      issues: [],
      facts: {},
    };

    // 相关文件（存在即列）
    for (const alias of spec.aliases ?? []) {
      const dir = /\.md$|\.yaml$/.test(alias) ? join(sourceRoot, alias) : join(sourceRoot, alias);
      if (existsSync(dir) && statSync(dir).isFile()) doc.files.push({ name: alias, exists: true, role: "相关", sizeBytes: sizeOf(dir) });
      else if (existsSync(dir)) doc.files.push({ name: `${alias}/`, exists: true, role: "相关目录", sizeBytes: 0 });
    }
    if (primary) doc.files.unshift({ name: primary.name, exists: true, role: sourceHit ? "源文档" : "工作副本草案", sizeBytes: sizeOf(primary.file) });

    // 各文档的字段/结构检查
    if (spec.id === "intent") {
      const fields = parseFieldLines(content);
      const pick = (...values) => values.map((value) => (isPlaceholder(value) ? "" : value)).find(Boolean) ?? "";
      const legacy = {
        听众: pick(fields["听众"], fields["Audience"]),
        主题: pick(fields["主题"], fields["Topic"], meta.title),
        带走: pick(fields["带走"], fields["希望带走"], fields["Takeaway"]),
      };
      // F-78：除了治理必需的三个字段，也要把「场合 / 时长」「成功标准」「不讲的」等
      // 结构化字段交给「意图」标签页的卡片（之前只传 legacy 三项，卡片永远显示 —）。
      const allFields = Object.fromEntries(
        Object.entries(fields).map(([key, value]) => [key, isPlaceholder(value) ? "" : value]),
      );
      doc.facts = { fields: { ...allFields, ...legacy }, derived: { 主题: meta.title ?? "", 类型: meta["deck-type"] ?? "", 目的: meta.purpose ?? "" } };
      const missing = REQUIRED_FIELDS.intent.filter((key) => !legacy[key]);
      if (!primary) {
        doc.status = "missing";
        doc.issues.push("缺 intent.md：听众 / 主题 / 带走 还没有被明确写下来（主题可从 script frontmatter 派生，其余需人补）");
      } else if (missing.length) {
        doc.status = "partial";
        doc.issues.push(`缺字段：${missing.join(" / ")}`);
      } else {
        doc.status = "ok";
      }
    } else if (spec.id === "script") {
      const promptIds = Object.keys(prompts);
      // F-110：画面要求（visualBrief）住在工作副本 manifest 里，不是源 prompts/Pxx.txt。
      // 以前只数 prompts/ 文件，新建 deck 永远显示「提示词覆盖 0/10」，把 Agent 和人都误导成「不能出图」。
      const manifest = readManifestJson(deckDir);
      const briefOf = (page) => {
        const pageId = `p${String(page.page).padStart(2, "0")}`;
        const slide = (manifest?.slides ?? []).find((item) => item.id === pageId);
        return String(slide?.visualBrief ?? "").trim();
      };
      const covered = pages.filter((page) => {
        const pageId = `p${String(page.page).padStart(2, "0")}`;
        const brief = briefOf(page);
        const fieldPrompt = String(page.fields?.["提示词"] ?? "").trim();
        return (brief && !isPlaceholder(brief)) || promptIds.includes(pageId) || (fieldPrompt && !isPlaceholder(fieldPrompt));
      });
      doc.facts = {
        pageCount: pages.length,
        promptCount: promptIds.length,
        promptCoverage: covered.length,
        // 故事线概览并入脚本页：分段表从 script 的 `## 段落 / 页码 / 任务` 解析，零副本。
        segments: parseStorySegments(script),
      };
      const derived = !primary && pages.length;
      if (derived) {
        doc.status = "derived";
        doc.files.unshift({ name: "script.md", exists: false, role: "缺失", sizeBytes: 0 });
      } else if (!primary) {
        doc.status = "missing";
        doc.issues.push("缺 script.md：没有逐页脚本");
      } else {
        doc.status = pages.length ? "ok" : "partial";
        if (!pages.length) doc.issues.push("script.md 里没解析出逐页（表格或 P 分节都算）");
      }
      if (pages.length && covered.length < pages.length) {
        doc.status = doc.status === "ok" ? "partial" : doc.status;
        doc.issues.push(`画面要求（visualBrief）覆盖 ${covered.length}/${pages.length} 页（缺 ${pages.length - covered.length} 页）`);
      }
    } else if (spec.id === "design") {
      const rules = (parseDesignRules(content) || (parseFieldLines(content)["画面约束"]?.split(/[；;]/) ?? [])).filter((rule) => !isPlaceholder(rule));
      doc.facts = {
        rules,
        render: { model: render.model ?? "", size: render.size ?? "", mode: render.mode ?? "", endpoint: render.endpoint ?? "" },
      };
      if (!primary) {
        doc.status = "missing";
        doc.issues.push("缺 design.md：画面约束 / 模板 / 色板 / 出图参数没有落档");
      } else if (rules.length < 3) {
        doc.status = "partial";
        doc.issues.push("画面约束不足 3 条（建议在「## 视觉规则」下列成 bullet）");
      } else {
        doc.status = "ok";
      }
    } else if (spec.id === "changelog") {
      // 修改日志 = 手写条目 + 版本记录 + 关键事件（系统自动生成），见 ADR-0016。
      const entries = parseChangelogEntries(content);
      // 变更流 = 手写条目 + script 版本 + 渲染/导出/交接/QA/说明事件（系统自动生成）。
      const feed = buildChangeFeed({ entries, revisions, events });
      doc.facts = { entries, feed, revisionCount: revisions.length, eventCount: events.length };
      if (!feed.length) {
        doc.status = "missing";
        doc.issues.push("还没有任何修改痕迹：改一次 script / 出一次图，系统会自动记录；agent 再补一句为什么即可");
      } else if (!entries.length) {
        // 有自动记录、但没有手写说明：能追溯"发生了什么"，还缺"为什么"。
        doc.status = "derived";
        doc.issues.push("没有手写说明：变更已由系统自动记录；建议 Agent 每次改完 deck 用 deck_note_change 补一句「为什么」");
      } else {
        doc.status = "ok";
      }
    } else if (spec.id === "feedback") {
      const rows = parseFeedbackRows(content);
      doc.facts = { rows };
      const retro = findSource(["retro.md"]);
      if (retro) doc.files.push({ name: "retro.md", exists: true, role: "回归台账", sizeBytes: sizeOf(retro.file) });
      if (!primary) {
        doc.status = "missing";
        doc.issues.push("缺 feedback.md：用户反馈没有留档，改稿依据不可追溯");
      } else if (!rows.length) {
        doc.status = "partial";
        doc.issues.push("没有解析出反馈行（表头需含 日期 / 对象 / 原话 / 处理）");
      } else {
        doc.status = "ok";
      }
    } else if (spec.id === "research") {
      const entries = parseResearchEntries(content);
      const archiveNames = new Set(researchFiles.map((file) => file.name));
      const merged = entries.map((entry) => {
        const localName = entry.localFile ? entry.localFile.replace(/^research\/files\//, "") : "";
        const local = [localName, ...archiveNames].find((name) => name && archiveNames.has(name)) ?? "";
        return { ...entry, localFile: local ? `files/${local}` : "", localUrl: local ? `research/files/${local}` : "" };
      });
      doc.facts = { entries: merged, archiveCount: researchFiles.length };
      if (!primary) {
        doc.status = "missing";
        doc.issues.push("缺调研台账（research/index.md 或 external-case-research.md）");
      } else if (!merged.length) {
        doc.status = "partial";
        doc.issues.push("没有解析出调研条目（支持表格 出处/标题/发表时间/原文链接/本地文件/总结，或编号列表 + URL）");
      } else {
        const noLocal = merged.filter((entry) => !entry.localFile).length;
        if (!noLocal) doc.status = "ok";
        else {
          doc.status = "partial";
          doc.issues.push(`${merged.length} 条调研中 ${noLocal} 条缺本地原文存档（research/files/）`);
        }
        const noDate = merged.filter((entry) => !entry.date).length;
        if (noDate) doc.issues.push(`${noDate} 条缺发表时间`);
      }
    } else if (spec.id === "materials") {
      // F-122：原来无脑取「第一张表」，表头不是材料清单时每列都取空 → 工作台渲染成
      // 一排「（未命名）目录 / 未登记总结」的空卡片（真机：materials.md 里放的是引用清单）。
      // 现在按表头挑真正像材料清单的那张表；找不到就老实报「表头不对」，不造假条目。
      const NAME_KEYS = ["文件名", "名称", "材料", "素材", "文件"];
      const LINK_KEYS = ["链接", "路径", "出处", "文件路径", "URL", "url"];
      const SUMMARY_KEYS = ["总结", "说明", "摘要", "用途", "备注"];
      const headMatches = (head, keys) => head.some((cell) => keys.some((key) => String(cell).includes(key)));
      const firstValue = (row, keys) => {
        for (const head of Object.keys(row)) {
          if (!keys.some((key) => head.includes(key))) continue;
          const value = row[head];
          if (value != null && String(value).trim()) return String(value).trim();
        }
        return "";
      };
      const tables = parseTables(content);
      // 表头越像材料清单（名称 + 链接/总结）越优先；一张都不像就不选，避免把引用清单当材料。
      const picked = tables
        .map((table) => {
          const score = (headMatches(table.head, NAME_KEYS) ? 2 : 0)
            + (headMatches(table.head, LINK_KEYS) ? 1 : 0)
            + (headMatches(table.head, SUMMARY_KEYS) ? 1 : 0);
          return { table, score };
        })
        .filter((item) => item.score >= 3)
        .sort((a, b) => b.score - a.score)[0] ?? null;
      const items = picked
        ? picked.table.rows
            .map((row) => ({
              name: firstValue(row, NAME_KEYS) || firstValue(row, LINK_KEYS),
              link: firstValue(row, LINK_KEYS),
              summary: firstValue(row, SUMMARY_KEYS),
            }))
            .filter((item) => item.name || item.link)
        : [];
      const hasAnyTable = tables.length > 0;
      doc.facts = { items };
      if (!primary) {
        // 兜底：把源目录里没被其它文档消费的文件列成「未登记素材」
        const inventory = [];
        if (existsSync(sourceRoot)) {
          const countFiles = (dir, depth = 0) => {
            if (depth > 3) return 0;
            let total = 0;
            for (const entry of readdirSync(dir)) {
              if (entry.startsWith(".")) continue;
              const full = join(dir, entry);
              total += statSync(full).isDirectory() ? countFiles(full, depth + 1) : 1;
            }
            return total;
          };
          for (const name of readdirSync(sourceRoot)) {
            if (name.startsWith(".")) continue;
            const file = join(sourceRoot, name);
            if (statSync(file).isDirectory()) {
              const count = countFiles(file);
              if (count) inventory.push({ name: `${name}/`, link: `${name}/`, summary: `目录 · ${count} 个文件` });
              continue;
            }
            if (/^(script|intent|storyline|design|changelog|feedback|materials|CURRENT|retro|case-cards|research-status|external-case-research|style-reference|implementation-principles)\.md$/.test(name)) continue;
            inventory.push({ name, link: name, summary: "" });
          }
        }
        doc.facts = { items: inventory };
        doc.status = inventory.length || pages.length ? "partial" : "missing";
        doc.issues.push("缺 materials.md：支撑材料只有文件清单，没有登记「来源 / 链接 / 总结」");
      } else if (!items.length) {
        doc.status = "partial";
        doc.issues.push(
          hasAnyTable
            ? "materials.md 里有表格，但没有一张是材料清单（表头需含 文件名 / 名称 + 链接 / 路径 + 总结），所以这里不显示条目；请让 Agent 用 deck_doc_update 补一张清单"
            : "materials.md 里还没有材料清单表（建议表头：文件名 / 链接 / 总结）",
        );
      } else {
        doc.status = "ok";
      }
    } else if (spec.id === "review" || spec.id === "factcheck") {
      const { rows } = parseTable(content);
      doc.facts = { rows };
      if (!primary) {
        doc.status = "missing";
        doc.issues.push(spec.id === "review" ? "缺审稿意见（review.md）：交付时建议跑一次 deck_review（不挡出图）" : "缺事实核对表（fact-check.md）");
      } else if (!rows.length) {
        doc.status = "partial";
        doc.issues.push("没有解析出条目（建议表格 + 表头；审稿用 严重度/类别/位置/证据/修复建议）");
      } else if (/TODO|待填|待确认/.test(content)) {
        doc.status = "partial";
        doc.issues.push("还有占位 / 待确认内容");
      } else {
        doc.status = "ok";
      }
    }
    // 只在工作副本里的草案：字段即使写全也还没进源 deck，治理上按 draft 计。
    if (kind === "draft" && doc.status === "ok") {
      doc.status = "draft";
      doc.issues.push("内容在工作副本 docs/，确认后回写源 deck");
    }
    return doc;
  });

  const counts = docs.reduce((acc, doc) => {
    acc[doc.status] = (acc[doc.status] ?? 0) + 1;
    return acc;
  }, {});
  const weight = { ok: 1, derived: 0.85, draft: 0.5, partial: 0.5, missing: 0 };
  const score = Math.round((docs.reduce((sum, doc) => sum + (weight[doc.status] ?? 0), 0) / docs.length) * 100);
  return {
    docs,
    governance: {
      deckId: adapter?.id ?? null,
      score,
      counts,
      total: docs.length,
      missing: docs.filter((doc) => doc.status === "missing").map((doc) => doc.id),
      partial: docs.filter((doc) => doc.status === "partial" || doc.status === "draft").map((doc) => doc.id),
    },
  };
}

/* ------------------------------------------------------------------ *
 * 单文档（含正文）
 * ------------------------------------------------------------------ */

/**
 * 读取单份文档：正文 + 结构化视图，供中间区对应标签渲染。
 * @param {object} input
 */
export function readDeckDoc({ adapter, deckDir, docId, file = "", render = {}, revisions = [], events = [] }) {
  const spec = DOC_SPECS.find((item) => item.id === docId);
  if (!spec) return null;
  const { docs } = resolveDeckDocs({ adapter, deckDir, render, revisions, events });
  const doc = docs.find((item) => item.id === docId);
  const sourceRoot = adapter?.sourceRoot ?? "";
  const draftFile = draftPath(deckDir, docId);
  const sourceFile = spec.candidates.map((name) => join(sourceRoot, name)).find((file) => existsSync(file));
  let primaryFile = sourceFile ?? (existsSync(draftFile) ? draftFile : null);
  // F-187：评审产物写在 deck 工作副本的 docs/ 下（review.readers.md / review.gap.md 等），
  // 不是源 deck 的候选文件；这里按「读者 → 负责人 → 工程」顺序找第一个存在的当作正文。
  if (docId === "review") {
    const preferred = spec.candidates.map((name) => join(deckDir, "docs", name)).find((file) => existsSync(file));
    if (preferred) {
      primaryFile = preferred;
      doc.primary = `docs/${preferred.split(/[\\/]/).pop()}`;
      // 人话版是散文体（没有「严重度」表格），不该被表格解析判成 partial。
      const human = /review\.(readers|gap)\.md$/.test(preferred);
      if (human || doc.status === "missing") {
        doc.status = human ? "ok" : "draft";
        doc.issues = [];
      }
      // 指定了相关文件（工作台点 chip）就读它；只允许本 deck docs/ 下的 review.* 文件。
      const wanted = String(file ?? "").trim();
      if (wanted && /^docs\/review\.[a-z]+\.(md|json)$/.test(wanted)) {
        const target = join(deckDir, wanted);
        if (existsSync(target) && statSync(target).isFile()) {
          primaryFile = target;
          doc.primary = wanted;
          doc.status = "ok";
          doc.issues = [];
        }
      }
      // 「相关文件」按顺序列出存在的几本，工作台文档页可以逐个打开。
      for (const name of spec.aliases ?? []) {
        const file = join(deckDir, "docs", name);
        if (!existsSync(file) || !statSync(file).isFile()) continue;
        doc.files.push({ name: `docs/${name}`, exists: true, role: "相关", sizeBytes: statSync(file).size });
      }
    }
  }
  const content = primaryFile ? readText(primaryFile) ?? "" : "";
  const script = adapter?.readScriptRaw?.() ?? readText(join(sourceRoot, "script.md")) ?? "";
  const pages = adapter?.storyPages?.() ?? [];
  const prompts = adapter?.prompts?.() ?? {};

  const parsed = {};
  if (docId === "intent") {
    parsed.fields = doc.facts.fields;
    parsed.derived = doc.facts.derived;
  } else if (docId === "script") {
    parsed.pages = pages.map((page) => {
      const pageId = `p${String(page.page).padStart(2, "0")}`;
      return {
        id: pageId,
        page: page.page,
        title: page.title,
        subtitle: page.question,
        claim: page.claim,
        // F-108：正文既可能是 **正文** 字段行，也可能是标题行以下的散段；两处都取，
        // 否则脚本页永远显示「（这页没有正文）」，用户在 UI 里看不到 Agent 写的内容。
        content: [page.fields?.["正文"], page.content]
          .map((part) => String(part ?? "").trim())
          .filter(Boolean)
          .join("\n\n"),
        prompt: prompts[pageId] || page.fields?.["提示词"] || "",
        source: page.source,
      };
    });
    parsed.segments = doc.facts.segments ?? [];
  } else if (docId === "design") {
    parsed.rules = doc.facts.rules;
    parsed.render = doc.facts.render;
  } else if (docId === "changelog") {
    parsed.entries = doc.facts.entries;
    parsed.feed = doc.facts.feed ?? [];
  } else if (docId === "feedback") {
    parsed.rows = doc.facts.rows;
  } else if (docId === "research") {
    parsed.entries = doc.facts.entries;
    parsed.archiveCount = doc.facts.archiveCount;
    parsed.archive = (() => {
      const dir = join(deckDir, "research", "files");
      if (!existsSync(dir)) return [];
      return readdirSync(dir).map((name) => ({ name, sizeBytes: sizeOf(join(dir, name)), path: `research/files/${name}` }));
    })();
  } else if (docId === "materials") {
    parsed.items = doc.facts.items;
  }

  return { ...doc, content, parsed };
}

/* ------------------------------------------------------------------ *
 * 模板与脚手架（只写工作副本，不动源 deck）
 * ------------------------------------------------------------------ */

export const DOC_TEMPLATES = {
  intent: `---
title: （deck 标题）
owner: （负责人）
updated: （YYYY-MM-DD）
status: draft
---

# 意图

- **听众**：TODO 讲给谁（角色 / 部门 / 层级 / 对 AI 的熟悉度）
- **主题**：TODO 一句话说清这场讲什么
- **带走**：TODO 听完他们应该能带走什么（1–3 条，可验证）
- **场合 / 时长**：TODO（内部培训 / 客户评审 / 分享会；多少分钟）
- **成功标准**：TODO 怎么判断这场讲成了
- **不讲的**：TODO 明确排除什么（避免范围膨胀）

## 故事线（叙事结构）

> 这里写"为什么这个顺序"，脚本页的叙事概览是从 script 自动派生的，不复制。

- **一句话主线**：TODO
- **分段**：
  - 进入现场（01–03）：TODO 这一段的任务
  - 主体（04–08）：TODO
  - 收束（19–21）：TODO
`,
  script: `---
title: （deck 标题）· 逐页脚本
render: image
status: draft
---

# 逐页脚本

### P01 · 封面

**标题**：TODO
**副标题**：TODO
**页面内容**：

- TODO

**讲述意图**：TODO
**画面说明**：

- TODO
`,
  design: `---
title: （deck 标题）· 画面规范
status: draft
---

# 画面规范

## 视觉定位

TODO 一句话说清这是什么风格的 deck。

## 画面约束

- 背景：TODO
- 线条 / 材质：TODO
- 主色：TODO
- 人物：TODO
- 构图：TODO
- 禁止：TODO

## 模板 / 版式

- 封面：TODO
- 信息页：TODO
- 案例页：TODO

## 出图参数

- 模型 / 节点 / 尺寸：TODO（与 profile 里的 render 配置一致）
`,
  changelog: `---
title: （deck 标题）· 修改日志
status: active
---

# 修改日志

> 每次改动先写这里，再改文件。改动要能追溯到人 / 反馈 / 版本。

- YYYY-MM-DD · 初稿 · TODO · 确认人：TODO
`,
  feedback: `---
title: （deck 标题）· 反馈
status: active
---

# 反馈

| 日期 | 对象 | 原话 | 处理 | 层 | 标签 |
|---|---|---|---|---|---|
| YYYY-MM-DD | TODO | TODO | TODO | A/B/C | TODO |
`,
  research: `---
title: （deck 标题）· 调研台账
status: draft
---

# 调研台账

> 一条调研一行：出处 / 发表时间 / 原文链接 / 本地存档 / 总结。
> 原文下载到 \`research/files/\`，本地文件列填相对路径（如 \`research/files/anthropic-context-engineering.md\`）。

| 出处 | 标题 | 发表时间 | 原文链接 | 本地文件 | 总结 |
|---|---|---|---|---|---|
| TODO | TODO | YYYY-MM-DD | https:// | research/files/ | TODO |
`,
  materials: `---
title: （deck 标题）· 支撑材料
status: draft
---

# 支撑材料

> 内部项目记录与素材：文件名 / 链接 / 总结。

| 文件名 | 链接 | 总结 |
|---|---|---|
| TODO | TODO | TODO |
`,
  review: `---
title: （deck 标题）· 审稿意见
status: draft
---

# 审稿意见

> 由 \`deck_review\` 生成：每条问题带严重度 / 位置 / 证据 / 修复建议；只审不改、不直接出图。

## 问题清单

| 严重度 | 类别 | 位置 | 证据 | 修复建议 |
|---|---|---|---|---|
| TODO | TODO | TODO | TODO | TODO |

## 结论

- TODO：可交付 / 需修改 / 不可交付 + 依据（审了哪些文档、哪些页）。
`,
  factcheck: `---
title: （deck 标题）· 事实核对
status: draft
---

# 事实核对

> 每条断言一行：这句话是谁说/哪份材料说的，核对结论是否一致。

| 断言 | 来源 | 结论 | 说明 |
|---|---|---|---|
| TODO | TODO | 一致 / 冲突 / 无依据 | TODO |
`,
};

/**
 * 给缺失的文档打骨架（写到 `.deck/decks/<deckId>/docs/`，不碰源 deck）。
 * @returns {{created: string[], skipped: string[]}}
 */
export function scaffoldDeckDocs({ adapter, deckDir, docIds }) {
  const wanted = docIds?.length ? docIds : DOC_SPECS.map((spec) => spec.id);
  const created = [];
  const skipped = [];
  for (const id of wanted) {
    const spec = DOC_SPECS.find((item) => item.id === id);
    if (!spec) continue;
    const sourceExists = spec.candidates.some((name) => existsSync(join(adapter?.sourceRoot ?? "", name)));
    const target = draftPath(deckDir, id);
    if (sourceExists || existsSync(target)) {
      skipped.push(id);
      continue;
    }
    mkdirSync(join(target, ".."), { recursive: true });
    writeFileSync(target, DOC_TEMPLATES[id] ?? `# ${spec.label}\n`, "utf8");
    const fileName = id === "research" ? "research/index.md" : id === "factcheck" ? "fact-check.md" : `${id}.md`;
    created.push(`docs/${fileName}`);
  }
  return { created, skipped };
}

/* ------------------------------------------------------------------ *
 * 文档文件访问（工作副本里的草案 / 调研原文）
 * ------------------------------------------------------------------ */

const SAFE_REL = /^[A-Za-z0-9._\-\u4e00-\u9fa5/]+$/;

/**
 * 解析工作副本内的文档文件路径（只允许 docs/ 与 research/files/）。
 * 越界 / `..` / 绝对路径一律 null（路由层返回 404）。
 */
export function resolveDocFile({ deckDir, docId, name }) {
  if (!name || typeof name !== "string" || !SAFE_REL.test(name) || name.includes("..")) return null;
  const base = docId === "research" ? join(deckDir, "research") : join(deckDir, "docs");
  const file = join(base, name.replace(/^\//, ""));
  if (!file.startsWith(base)) return null;
  if (!existsSync(file) || !statSync(file).isFile()) return null;
  return { file, name, sizeBytes: sizeOf(file) };
}

export const DOC_FILE_EXTS = {
  ".md": "text/markdown; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".pdf": "application/pdf",
};

export { slugOf };
