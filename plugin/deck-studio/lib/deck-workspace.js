/**
 * deck 工作区：`.deck/decks/<deckId>/` 的 manifest、script 工作副本、提案与 revision。
 *
 * 纪律（ADR-0006 D4/D5）：
 * - manifest / 工作副本第一次使用时从受控源初始化，之后只改 `.deck/`，不回写源；
 * - script revision 是 copy-on-write 全文快照（revisions/vNNN.md），current.md 始终等于最新；
 * - 提案（proposals/*.json）是 waiting-user 的事实载体，确认 / 驳回都留痕。
 * @module dsh-plugin-deck-studio/deck-workspace
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { createLocalSourceAdapter } from "./source-adapter.js";
import { nowIso, makeId } from "./store.js";
import { lineDiff } from "./diff.js";

/** script 表格行里可编辑字段 → 单元格下标。 */
export const SCRIPT_FIELD_CELL = { title: 1, question: 2, claim: 3 };

/** 新值里的竖线与换行会破坏表格结构，替换为全角安全字符。 */
export function sanitizeCell(value) {
  return String(value ?? "").replace(/\|/g, "／").replace(/\r?\n/g, " ").trim();
}

/**
 * 在 script 文本中找到页号对应的表格行；返回 {line, index} 或 null。
 * 页号跨表唯一（正文 1..36，附录 37..55）；重复取第一条并让调用方警告。
 */
export function findScriptRow(scriptText, page) {
  const lines = scriptText.split("\n");
  const pattern = new RegExp(`^\\|\\s*${page}\\s*\\|`);
  for (let i = 0; i < lines.length; i += 1) {
    if (pattern.test(lines[i])) return { line: lines[i], index: i };
  }
  return null;
}

/** 替换一行的指定单元格；cells 数量不足时补空串。 */
export function replaceCell(rowLine, cellIndex, newValue) {
  const cells = rowLine.replace(/^\|/, "").replace(/\|\s*$/, "").split("|").map((cell) => cell.trim());
  while (cells.length <= cellIndex) cells.push("");
  cells[cellIndex] = sanitizeCell(newValue);
  return `| ${cells.join(" | ")} |`;
}

/**
 * 分节惯例（`### P04 · 标题` + `**字段**：值`）里，字段 → 源文件里的字段名（按优先级）。
 * 表格惯例走 SCRIPT_FIELD_CELL；分节惯例走这张表（F-75 评估发现：新建 deck 是分节惯例，
 * 之前 propose_edit 只认表格行 → 对新建 deck 直接报「找不到页的表格行」）。
 */
export const SECTION_FIELD_KEYS = {
  title: ["标题"],
  question: ["副标题", "页面标签"],
  claim: ["主张", "为什么值得 AI 做", "为什么值得 Agent 做", "讲述意图"],
  // F-109：正文独立成字段。以前 claim 把「正文」当别名，提案会整段覆盖正文，
  // 现在 body 走自己的字段，claim 不再误伤正文。
  body: ["正文"],
};

/** 标题行（`### P04 · …`）与该页结束行（下一个 heading 之前）。 */
function sectionRange(lines, page) {
  const headRe = new RegExp(`^#{2,3}\\s*P0*${page}\\s*[·.\\-–—:]?`);
  const start = lines.findIndex((line) => headRe.test(line.trim()));
  if (start < 0) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^#{1,4}\s/.test(lines[i])) {
      end = i;
      break;
    }
  }
  return { start, end };
}

/**
 * 找到某页在 script 里的行区间（`### Pxx` 分节惯例）；表格惯例没有分节时返回 null。
 * F-108：提案的 before 行必须在「这一页」里找——新 deck 每页都有同样的占位行，
 * 全篇 indexOf 会把 P01 的标题改到 P02 上。
 */
export function scriptSectionRange(scriptText, page) {
  const pageNo = Number(page);
  if (!Number.isFinite(pageNo) || pageNo <= 0) return null;
  return sectionRange(String(scriptText ?? "").split("\n"), pageNo);
}

/** 分节惯例：替换 / 插入某页的字段行。 */
function applySectionFieldEdit(scriptText, page, field, newValue) {
  const keys = SECTION_FIELD_KEYS[field];
  if (!keys) return null;
  const lines = scriptText.split("\n");
  const range = sectionRange(lines, page);
  if (!range) return null;
  const value = sanitizeCell(newValue);
  const pattern = new RegExp(`^(\\s*)\\*\\*(${keys.map((key) => key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})\\*\\*\\s*[：:]\\s*(.*)$`);
  for (let i = range.start + 1; i < range.end; i += 1) {
    const match = pattern.exec(lines[i]);
    if (!match) continue;
    const oldRow = lines[i];
    lines[i] = `${match[1]}**${match[2]}**：${value}`;
    return { text: lines.join("\n"), oldRow, newRow: lines[i] };
  }
  // 这页还没有该字段（老 deck 没有 `**主张**`）→ 插在标题行之后，保持其它字段原样。
  const newRow = `**${keys[0]}**：${value}`;
  lines.splice(range.start + 1, 0, newRow);
  return { text: lines.join("\n"), oldRow: "", newRow };
}

/** 对 script 文本应用一个字段修改；返回 {text, oldRow, newRow} 或 null（找不到页）。 */
export function applyScriptFieldEdit(scriptText, page, field, newValue) {
  const cellIndex = SCRIPT_FIELD_CELL[field];
  if (Number.isFinite(cellIndex)) {
    const row = findScriptRow(scriptText, page);
    if (!row) return applySectionFieldEdit(scriptText, page, field, newValue);
    const newRow = replaceCell(row.line, cellIndex, newValue);
    const lines = scriptText.split("\n");
    const oldRow = lines[row.index];
    lines[row.index] = newRow;
    return { text: lines.join("\n"), oldRow, newRow };
  }
  return applySectionFieldEdit(scriptText, page, field, newValue);
}

/**
 * @param {{dataRoot: string}} config - mergeConfig 的产物（用到 dataRoot）。
 */
export function createDeckWorkspace(config) {
  const decksDir = join(config.dataRoot, "decks");

  function deckDir(deckId) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(deckId)) throw new Error(`unsafe deckId: ${deckId}`);
    return join(decksDir, deckId);
  }

  function slideDir(deckId, pageId) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(pageId)) throw new Error(`unsafe pageId: ${pageId}`);
    return join(deckDir(deckId), "slides", pageId);
  }

  function readFileSafe(file) {
    try {
      return existsSync(file) ? readFileSync(file, "utf8") : null;
    } catch {
      return null;
    }
  }

  /** manifest（无则 null）。 */
  function manifest(deckId) {
    const raw = readFileSafe(join(deckDir(deckId), "deck.json"));
    if (!raw) return null;
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  function saveManifest(deck) {
    const dir = deckDir(deck.id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "deck.json"), `${JSON.stringify(deck, null, 2)}\n`, "utf8");
  }

  /** 从源初始化 manifest + script 工作副本（幂等：已存在不覆盖）。 */
  /** 从受控源构建 slides（唯一入口：初始化和「源变了」重建都走这里）。 */
  function slidesFromSource(adapter) {
    const yamlPages = adapter.yamlPages();
    const prompts = typeof adapter.prompts === "function" ? adapter.prompts() : {};
    return adapter.storyPages().map((row) => {
      const pageId = `p${String(row.page).padStart(2, "0")}`;
      return {
        id: pageId,
        order: row.page,
        type: row.page === 1 ? "cover" : "story",
        title: row.title,
        question: row.question,
        claim: row.claim,
        source: row.source,
        // F-130：正文也进 manifest（以前的 manifest 只有 title/question/claim，脚本页只能从源文档拿
        // 正文，密度检查 / 工作台看到的「已落版正文」和源快照会打架）。
        body: String(row.fields?.["正文"] ?? "").trim(),
        asset: yamlPages[row.page - 1] ?? null,
        // 源里已写好的 image prompt（prompts/P01.txt）直接作为 visualBrief 起点。
        visualBrief: prompts[pageId] ?? "",
      };
    });
  }

  /** 分节惯例的页头：`### P07 · 标题`（表格惯例另由 SCRIPT_FIELD_CELL 处理）。 */
  const SCRIPT_PAGE_HEAD = /^#{2,3}\s*P(\d+)\s*(?:[·.‐-―:：-]\s*)?(.*)$/;

  /** script 文本里的页号（按出现顺序去重）。 */
  function scriptPageNumbers(scriptText) {
    const pages = [];
    for (const line of String(scriptText ?? "").split("\n")) {
      const match = line.match(SCRIPT_PAGE_HEAD);
      if (!match) continue;
      const page = Number(match[1]);
      if (Number.isInteger(page) && page > 0 && !pages.includes(page)) pages.push(page);
    }
    return pages;
  }

  /**
   * 追加页到 script 工作副本（F-99）。只追加到最后一个正文页之后（附录前）：
   * 页号 = 当前最大页号 + 1..N，不重排既有页——重排会让 slides/<pageId>/versions、
   * asset URL、proposal.pageId 跟着错配（那需要迁目录，另有 ADR 再谈）。
   * 同时把 frontmatter 的 `pages:` 计数改成新页数，保证元数据与正文一致。
   */
  function appendScriptPages(scriptText, pages) {
    const text = String(scriptText ?? "");
    const lines = text.split("\n");
    const existing = scriptPageNumbers(text);
    const startPage = (existing.length ? Math.max(...existing) : 0) + 1;
    const specs = (Array.isArray(pages) ? pages : []).map((page, offset) => ({
      page: Number(page?.page) > 0 ? Number(page.page) : startPage + offset,
      title: String(page?.title ?? "").trim(),
      question: String(page?.question ?? "").trim(),
      claim: String(page?.claim ?? "").trim(),
      body: String(page?.body ?? "").trim(),
      visualBrief: String(page?.visualBrief ?? "").trim(),
    }));
    if (!specs.length) throw new Error("appendScriptPages：没有要追加的页");
    let lastPageLine = -1;
    lines.forEach((line, index) => {
      if (SCRIPT_PAGE_HEAD.test(line)) lastPageLine = index;
    });
    // 最后一个正文页之后若出现一级/二级小节（如 `## 附录`），插到它前面。
    let insertAt = lines.length;
    if (lastPageLine >= 0) {
      for (let index = lastPageLine + 1; index < lines.length; index += 1) {
        if (/^#{1,2}\s/.test(lines[index])) {
          insertAt = index;
          break;
        }
      }
    }
    const head = lines.slice(0, insertAt);
    while (head.length && head[head.length - 1].trim() === "") head.pop();
    const tail = lines.slice(insertAt);
    while (tail.length && tail[0].trim() === "") tail.shift();
    const nextLines = [...head];
    for (const spec of specs) {
      const pageNo = spec.page;
      const title = spec.title || `待补章节 ${pageNo}`;
      const block = [
        `### P${String(pageNo).padStart(2, "0")} · ${title}`,
        `**标题**：${title}`,
        `**副标题**：${spec.question || "这一页回答什么（待补）"}`,
        `**主张**：${spec.claim || "（待补：这页要证明的判断）"}`,
        `**正文**：${spec.body || "（待补：3–5 句正文）"}`,
        `**提示词**：${spec.visualBrief || "（待补：visualBrief）"}`,
      ].join("\n");
      if (nextLines.length) nextLines.push("");
      nextLines.push(block);
    }
    if (tail.length) {
      nextLines.push("");
      nextLines.push(...tail);
    }
    let next = nextLines.join("\n");
    const pageCount = scriptPageNumbers(next).length;
    next = next.replace(/^pages:\s*\d+\s*$/m, `pages: ${pageCount}`);
    return { text: next, pageCount, startPage, pages: specs };
  }

  /**
   * 源内容指纹：脚本正文 + 解析结果 + 源 prompt 数量。
   * 用于判断「源更新了，但本地还没开始改（无 script revision）」时自动重建 manifest，
   * 避免 adapter 解析规则升级后旧 deck.json 里的空字段一直残留。
   */
  function sourceSignature(adapter) {
    const view = adapter.overview();
    const rows = adapter.storyPages();
    const prompts = typeof adapter.prompts === "function" ? adapter.prompts() : {};
    const payload = JSON.stringify({
      title: view.title,
      status: view.status,
      warnings: view.warnings,
      pages: rows.map((row) => [row.page, row.title, row.question, row.claim, row.source]),
      prompts: Object.keys(prompts).length,
    });
    return createHash("sha1").update(payload).digest("hex").slice(0, 16);
  }

  /** 本地是否已有 script revision（有 = 人已经改过，源刷新不得覆盖）。 */
  function hasLocalScriptEdits(deckId) {
    const dir = join(deckDir(deckId), "script", "revisions");
    return existsSync(dir) && readdirSync(dir).some((name) => /^v\d+\.md$/.test(name));
  }

  function ensureDeck(adapter, { styleBrief, forceRebuild = false } = {}) {
    let deck = manifest(adapter.id);
    const scriptFile = join(deckDir(adapter.id), "script", "current.md");
    if (!deck) {
      const view = adapter.overview();
      deck = {
        schemaVersion: 1,
        id: adapter.id,
        title: view.title,
        status: view.status || "draft",
        renderer: "image",
        styleId: "deckline-teal-paper-v1",
        source: { root: adapter.sourceRoot, readonly: true, kind: "local-client-deck" },
        sourceSignature: sourceSignature(adapter),
        buildWarnings: view.warnings,
        slides: slidesFromSource(adapter),
        // 附录在源里是区间登记（如 A3–A10），不是逐页——摘要进 manifest，不造假逐页。
        appendix: { count: view.appendixCount ?? 0, rows: view.appendixRows ?? [] },
      };
      saveManifest(deck);
    } else if (forceRebuild || !hasLocalScriptEdits(adapter.id)) {
      const signature = sourceSignature(adapter);
      if (deck.sourceSignature !== signature) {
        const view = adapter.overview();
        const rebuilt = slidesFromSource(adapter);
        const previous = Array.isArray(deck.slides) ? deck.slides : [];
        const byId = new Map(previous.map((slide) => [slide.id, slide]));
        // 源里有的页：字段以源为准，但保留本地已填的 visualBrief（manifest-only，源里没有）。
        const merged = rebuilt.map((slide) => {
          const local = byId.get(slide.id);
          if (!local || !String(local.visualBrief ?? "").trim()) return slide;
          // F-121：重建 manifest 时 visualBrief 是「本地才有的字段」，必须连写作风格一起保住；
          // 只留 visualBrief 会把 provenance 冲掉，脚本页就全变成「brief 风格未记录」。
          return {
            ...slide,
            visualBrief: local.visualBrief,
            ...(local.visualBriefDesign ? { visualBriefDesign: local.visualBriefDesign } : {}),
          };
        });
        // 源里没有的页 = 本地追加页（F-99 deck_script_add_page）。重建 manifest 时不能丢，
        // 否则 Inspector 一保存（forceRebuild）就把 6→10 页打回 6 页。
        const extras = previous.filter((slide) => !rebuilt.some((candidate) => candidate.id === slide.id));
        deck = {
          ...deck,
          title: view.title,
          status: view.status || deck.status,
          sourceSignature: signature,
          buildWarnings: view.warnings,
          slides: [...merged, ...extras].sort((a, b) => (a.order ?? 0) - (b.order ?? 0)),
          appendix: { count: view.appendixCount ?? 0, rows: view.appendixRows ?? [] },
        };
        saveManifest(deck);
        // 有本地 revision 时 current.md 是事实源，不能被源覆盖（否则追加页会丢）。
        const raw = hasLocalScriptEdits(adapter.id) ? null : adapter.readScriptRaw();
        if (raw != null) writeFileSync(scriptFile, raw, "utf8");
      }
    }
    if (!existsSync(scriptFile)) {
      const raw = adapter.readScriptRaw();
      if (raw != null) {
        mkdirSync(join(deckDir(adapter.id), "script"), { recursive: true });
        writeFileSync(scriptFile, raw, "utf8");
      }
    }
    // F-130：老 manifest 里没有 body 字段（正文只存在源 script 里），补一次；
    // 否则脚本页的密度达标标记和「按当前密度检查」都会把正文当 0 字。
    const current = manifest(adapter.id);
    if (current && Array.isArray(current.slides)) {
      let changed = false;
      const rows = adapter.storyPages();
      for (const slide of current.slides) {
        if (String(slide.body ?? "").trim()) continue;
        const row = rows.find((item) => `p${String(item.page).padStart(2, "0")}` === slide.id);
        const body = String(row?.fields?.["正文"] ?? "").trim();
        if (body) {
          slide.body = body;
          changed = true;
        }
      }
      if (changed) saveManifest(current);
    }
    return manifest(adapter.id);
  }

  /** script 工作副本（未初始化返回 null）。 */
  function scriptCurrent(deckId) {
    return readFileSafe(join(deckDir(deckId), "script", "current.md"));
  }

  /** 全文 revision（copy-on-write）：写 revisions/vNNN.md 并把 current.md 推进到它。 */
  function saveScriptRevision(deckId, text, note) {
    const dir = deckDir(deckId);
    const versionsDir = join(dir, "script", "revisions");
    mkdirSync(versionsDir, { recursive: true });
    const count = readdirSync(versionsDir).filter((name) => /^v\d+\.md$/.test(name)).length;
    const revision = `v${String(count + 1).padStart(3, "0")}`;
    const file = join(versionsDir, `${revision}.md`);
    writeFileSync(file, text, "utf8");
    writeFileSync(join(dir, "script", "current.md"), text, "utf8");
    if (note) writeFileSync(join(versionsDir, `${revision}.note.txt`), `${note}\n`, "utf8");
    return { revision, path: file };
  }

  /** 提案。 */
  function saveProposal(proposal) {
    const dir = join(deckDir(proposal.deckId), "proposals");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${proposal.proposalId}.json`), `${JSON.stringify(proposal, null, 2)}\n`, "utf8");
  }

  function proposal(proposalId) {
    if (!/^prop_[a-zA-Z0-9]+$/.test(proposalId)) throw new Error(`unsafe proposalId: ${proposalId}`);
    for (const deckId of listDeckIds()) {
      const raw = readFileSafe(join(deckDir(deckId), "proposals", `${proposalId}.json`));
      if (raw) {
        try {
          return JSON.parse(raw);
        } catch {
          return null;
        }
      }
    }
    return null;
  }

  /** 更新并回写提案（状态迁移由调用方负责）。 */
  function updateProposal(proposal, patch) {
    const next = { ...proposal, ...patch, proposalId: proposal.proposalId };
    saveProposal(next);
    return next;
  }

  function listProposals(deckId, status = null) {
    const dir = join(deckDir(deckId), "proposals");
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter((name) => name.endsWith(".json"))
      .map((name) => {
        try {
          return JSON.parse(readFileSync(join(dir, name), "utf8"));
        } catch {
          return null;
        }
      })
      .filter(Boolean)
      .filter((item) => !status || item.status === status)
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  }

  function listDeckIds() {
    if (!existsSync(decksDir)) return [];
    return readdirSync(decksDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && existsSync(join(decksDir, entry.name, "deck.json")))
      .map((entry) => entry.name)
      .sort();
  }

  return {
    get dataRoot() {
      return config.dataRoot;
    },
    deckDir,
    slideDir,
    manifest,
    saveManifest,
    ensureDeck,
    scriptCurrent,
    appendScriptPages,
    scriptPageNumbers,
    saveScriptRevision,
    saveProposal,
    proposal,
    updateProposal,
    listProposals,
    listDeckIds,
  };
}

/** 新提案 id。 */
export function newProposalId() {
  return makeId("prop");
}

/** 提案时间戳。 */
export const proposalNow = nowIso;

/** 便捷：生成 script 行级 diff。 */
export const scriptDiff = (oldText, newText) => lineDiff(oldText, newText);
