/**
 * deck 工作区：`.deck/decks/<deckId>/` 的 manifest、script 工作副本、提案与 revision。
 *
 * 纪律（ADR-0006 D4/D5）：
 * - manifest / 工作副本第一次使用时从受控源初始化，之后只改 `.deck/`，不回写源；
 * - script revision 是 copy-on-write 全文快照（revisions/vNNN.md），current.md 始终等于最新；
 * - 提案（proposals/*.json）是 waiting-user 的事实载体，确认 / 驳回都留痕。
 * @module dsh-plugin-deck-studio/deck-workspace
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { createLocalSourceAdapter } from "./source-adapter.js";
import { nowIso, makeId } from "./store.js";
import { lineDiff } from "./diff.js";
import { stripVisualBriefScaffolding } from "./render.js";

/** script 表格行里可编辑字段 → 单元格下标。 */
export const SCRIPT_FIELD_CELL = { title: 1, question: 2, claim: 3 };

/** `p07` → 7；非法返回 null。 */
export function pageNumberFromId(pageId) {
  const page = Number(String(pageId ?? "").replace(/^p/i, ""));
  return Number.isFinite(page) && page > 0 ? page : null;
}

/** 页号 → `p07`。 */
export function pageIdFromNumber(page) {
  return `p${String(Number(page)).padStart(2, "0")}`;
}

/**
 * slide 对应的**原始源页号**（F-208 插页后 manifest 会记 `sourcePage`）。
 * 源 baseline 图（`outputs/full/final/P0N.png`）按原始源页映射：插页改了页号，
 * 但这页的源图还是原来那张，不能跟着改号。
 * - 老 manifest 没有该字段 → 按 order（插页前的行为和现在一致）。
 * - 显式 `sourcePage: null` → 这页是插页新增的，源里没有 baseline 图。
 */
export function slideSourcePage(slide) {
  if (!slide || typeof slide !== "object") return null;
  if (Object.prototype.hasOwnProperty.call(slide, "sourcePage")) {
    const raw = slide.sourcePage;
    // 显式 null / undefined 都表示「源里没有这页」（插页新增）；不能走 Number(null)=0。
    if (raw == null || raw === "") return null;
    const page = Number(raw);
    return Number.isFinite(page) && page > 0 ? page : null;
  }
  const order = Number(slide.order);
  return Number.isFinite(order) && order > 0 ? order : null;
}

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
  // F-181（I-06）：逐页契约 5 项里的可写字段；缺字段时插在标题行之后，老 deck 不受影响。
  // 键名用中文字段名（工具 enum 直接暴露给人看），英文别名保留给内部调用。
  角色: ["角色"],
  受众变化: ["受众变化", "听众变化"],
  关系: ["关系"],
  证据: ["证据"],
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
    // F-209：多实例共享同一个 .deck 时，半截 deck.json 会被 manifest() 当成「没有 manifest」，
    // ensureDeck 于是按源静默重建、把插页/追加的本地页丢掉。写入走 tmp + rename（同目录原子替换）。
    const file = join(dir, "deck.json");
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(deck, null, 2)}\n`, "utf8");
    renameSync(tmp, file);
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
        // F-209：源 prompt 是完整独立 prompt，含 `### P02 · 标题` 这类分页标题；原样拼进出图 prompt
        // 会被模型当图上文字印出来（实测页顶出现「##P2」），导入时先做最小清洗。
        visualBrief: stripVisualBriefScaffolding(prompts[pageId] ?? ""),
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

  /** 一页的分节 script 文本块（追加 / 插页共用）。 */
  function scriptPageBlock(spec) {
    const pageNo = spec.page;
    const title = spec.title || `待补章节 ${pageNo}`;
    return [
      `### P${String(pageNo).padStart(2, "0")} · ${title}`,
      `**标题**：${title}`,
      `**副标题**：${spec.question || "这一页回答什么（待补）"}`,
      `**主张**：${spec.claim || "（待补：这页要证明的判断）"}`,
      `**正文**：${spec.body || "（待补：3–5 句正文）"}`,
      `**提示词**：${spec.visualBrief || "（待补：visualBrief）"}`,
    ].join("\n");
  }

  /**
   * 规格化新页（追加 / 插页共用）。页号**永远按当前位置重算**，不信调用方存的旧页号：
   * 提案存放期间如果又落了别的 revision（比如先插页、再确认之前提的追加页），旧页号会和现页撞车。
   */
  function normalizeNewPageSpecs(pages, startPage) {
    return (Array.isArray(pages) ? pages : []).map((page, offset) => ({
      page: startPage + offset,
      title: String(page?.title ?? "").trim(),
      question: String(page?.question ?? "").trim(),
      claim: String(page?.claim ?? "").trim(),
      body: String(page?.body ?? "").trim(),
      visualBrief: String(page?.visualBrief ?? "").trim(),
    }));
  }

  /** 在 `insertAt` 行之前塞入新页块，并修掉前后多余空行（追加 / 插页共用）。 */
  function splicePageBlocks(lines, insertAt, specs) {
    const head = lines.slice(0, insertAt);
    while (head.length && head[head.length - 1].trim() === "") head.pop();
    const tail = lines.slice(insertAt);
    while (tail.length && tail[0].trim() === "") tail.shift();
    const nextLines = [...head];
    for (const spec of specs) {
      if (nextLines.length) nextLines.push("");
      nextLines.push(scriptPageBlock(spec));
    }
    if (tail.length) {
      nextLines.push("");
      nextLines.push(...tail);
    }
    let next = nextLines.join("\n");
    const pageCount = scriptPageNumbers(next).length;
    next = next.replace(/^pages:\s*\d+\s*$/m, `pages: ${pageCount}`);
    return { text: next, pageCount };
  }

  /** 追加位置：最后一个正文页之后（`## 附录` 之类的一级/二级小节之前）。 */
  function appendInsertLine(lines) {
    let lastPageLine = -1;
    lines.forEach((line, index) => {
      if (SCRIPT_PAGE_HEAD.test(line)) lastPageLine = index;
    });
    let insertAt = lines.length;
    if (lastPageLine >= 0) {
      for (let index = lastPageLine + 1; index < lines.length; index += 1) {
        if (/^#{1,2}\s/.test(lines[index])) {
          insertAt = index;
          break;
        }
      }
    }
    return insertAt;
  }

  /**
   * 追加页到 script 工作副本（F-99）。只追加到最后一个正文页之后（附录前），不重排既有页。
   * 同时把 frontmatter 的 `pages:` 计数改成新页数，保证元数据与正文一致。
   */
  function appendScriptPages(scriptText, pages) {
    const text = String(scriptText ?? "");
    const lines = text.split("\n");
    const existing = scriptPageNumbers(text);
    const startPage = (existing.length ? Math.max(...existing) : 0) + 1;
    const specs = normalizeNewPageSpecs(pages, startPage);
    if (!specs.length) throw new Error("appendScriptPages：没有要追加的页");
    const spliced = splicePageBlocks(lines, appendInsertLine(lines), specs);
    return { ...spliced, startPage, pages: specs };
  }

  /**
   * 插页到 script 工作副本（F-208）。`at` = 插到第 N 页之前（1-based；at = 最大页号+1 等价追加）。
   *
   * 与追加的差别：插页会让 >= at 的页号整体后移 `pages.length` 页——脚本标题行、manifest 的
   * slide id/order、以及 `.deck/.../slides/<pageId>/versions` 目录都必须一起迁（见
   * `shiftSlideDirs` 与 proposal-decision 的 `syncInsertPageManifest`）。**已出的图跟着内容走**，
   * 不需要重出整份（ADR-0028）。
   *
   * 纯函数：只算新文本，不写盘；调用方负责 revision / manifest / 目录迁移。
   */
  function insertScriptPages(scriptText, { at, pages } = {}) {
    const text = String(scriptText ?? "");
    if (!text.trim()) throw new Error("插页失败：script 工作副本为空");
    const lines = text.split("\n");
    const existing = scriptPageNumbers(text);
    if (!existing.length) {
      throw new Error("插页只支持分节惯例的 script（`### Pxx · 标题`）；这份 deck 是表格惯例，暂不支持在中间插页——可以用 deck_script_add_page 追加，或先确认是否要改成分节惯例。");
    }
    const maxPage = Math.max(...existing);
    const atPage = Number(at);
    if (!Number.isInteger(atPage) || atPage < 1) {
      throw new Error(`插页位置无效：at=${at}（要插到第 N 页之前，N 从 1 开始）`);
    }
    if (atPage > maxPage + 1) {
      throw new Error(`插页位置超界：当前 ${maxPage} 页，at 最大是 ${maxPage + 1}（= 追加到末尾，也可以直接用 deck_script_add_page）`);
    }
    const specs = normalizeNewPageSpecs(pages, atPage);
    if (!specs.length) throw new Error("insertScriptPages：没有要插入的页");
    const shift = specs.length;

    // 插入行 = 第一个页号 >= at 的标题行；at = max+1 时退回「末尾 / 附录前」的锚点。
    let insertAt = -1;
    for (let index = 0; index < lines.length; index += 1) {
      const match = lines[index].match(SCRIPT_PAGE_HEAD);
      if (match && Number(match[1]) >= atPage) {
        insertAt = index;
        break;
      }
    }
    if (insertAt < 0) insertAt = appendInsertLine(lines);

    // 后移：插入点之后、页号 >= at 的标题行 +shift（保留 `###` 层级与标题，只改页号）。
    const renumbered = lines.map((line, index) => {
      if (index < insertAt) return line;
      const match = line.match(SCRIPT_PAGE_HEAD);
      if (!match) return line;
      const page = Number(match[1]);
      if (!(page >= atPage)) return line;
      return line.replace(/^(#{2,3}\s*P)0*(\d+)/, (match, prefix) => `${prefix}${String(page + shift).padStart(2, "0")}`);
    });

    const spliced = splicePageBlocks(renumbered, insertAt, specs);
    return {
      ...spliced,
      at: atPage,
      shift,
      pages: specs,
      // 被后移的旧页：旧页号 → 新页号（manifest / 目录 / 提案按这个映射迁）
      renumberedPages: existing.filter((page) => page >= atPage).map((page) => ({ from: page, to: page + shift })),
    };
  }

  /**
   * 插页时把 `slides/<pageId>/versions` 目录整体后移（F-208）。
   * 从大到小 rename，避免目标目录已存在互相覆盖；中途失败回滚已迁的目录，保持工作区干净。
   * 返回 [{ fromId, toId }]。
   */
  function shiftSlideDirs(deckId, { fromPage, shift } = {}) {
    const from = Number(fromPage);
    const step = Number(shift);
    if (!Number.isInteger(from) || from < 1) throw new Error(`shiftSlideDirs：fromPage 无效（${fromPage}）`);
    if (!Number.isInteger(step) || step < 1) throw new Error(`shiftSlideDirs：shift 无效（${shift}）`);
    const slidesDir = join(deckDir(deckId), "slides");
    if (!existsSync(slidesDir)) return [];
    const entries = readdirSync(slidesDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && /^p\d+$/.test(entry.name))
      .map((entry) => ({ id: entry.name, page: Number(entry.name.slice(1)) }))
      .filter((entry) => entry.page >= from)
      .sort((left, right) => right.page - left.page);
    const moved = [];
    try {
      for (const entry of entries) {
        const toId = `p${String(entry.page + step).padStart(2, "0")}`;
        const target = join(slidesDir, toId);
        if (existsSync(target)) {
          throw new Error(`插页迁移冲突：${target} 已存在（目录与 manifest 不一致；先核对 slides/ 与 deck.json，或跑 deck_script_repair 体检）`);
        }
        renameSync(join(slidesDir, entry.id), target);
        moved.push({ fromId: entry.id, toId });
      }
    } catch (error) {
      for (const item of [...moved].reverse()) {
        try {
          renameSync(join(slidesDir, item.toId), join(slidesDir, item.fromId));
        } catch {
          /* 回滚尽力而为；原始错误更重要 */
        }
      }
      throw error;
    }
    return moved;
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
    const manifestFile = join(deckDir(adapter.id), "deck.json");
    // F-209：deck.json 存在但 JSON 坏了 ≠ 新 deck。以前会当 null → 按源重建 manifest，
    // 插页/追加的本地页静默消失（script 还是 25 页）。宁可报错让人先备份/修复。
    if (!deck && existsSync(manifestFile)) {
      throw new Error(`manifest 损坏，拒绝按源重建（会丢插页/追加页）：${manifestFile}；先备份并修复 deck.json（或从 script/revisions 重建），再打开这本 deck。`);
    }
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
        // F-208：插过页之后 manifest 的 id/order 已经重编号，和源页号不再一一对应。
        // 对齐键取决于源是不是本地脚本的镜像：
        // - 本机 deck 确认后会把 script 回写源（ADR-0022），源的「第 N 页」= 本地第 N 页（含插页）
        //   → 按 id 对齐；用 sourcePage 反而会把插入页当成「源里没有的页」重复插一遍。
        // - 受控客户源永远停在原始页序 → 按 slide.sourcePage（原始源页）对齐，避免 Inspector 保存
        //   （forceRebuild）把后移过的页弄丢或重复。
        // 判据是「源的页号语义 == 本地页号语义」，不是「文本一模一样」：
        // Inspector 保存（savePage）只写源 script.md、不写本地 current.md（有 revision 时源不覆盖本地），
        // 两份文本会立刻不相等——但页号集合仍一致，仍该按 id 对齐。受控源插页后源仍是原始页数，集合不同，
        // 才按 slide.sourcePage 对齐。所以只比页号序列。
        const localScriptText = readFileSafe(scriptFile);
        const sourceScriptText = typeof adapter.readScriptRaw === "function" ? adapter.readScriptRaw() : null;
        const pageNumbersOfText = (text) => [...String(text ?? "").matchAll(/^#{2,3}\s*P(\d+)/gm)].map((match) => Number(match[1]));
        const localPageNumbers = pageNumbersOfText(localScriptText);
        const sourcePageNumbers = pageNumbersOfText(sourceScriptText);
        const sourceMirrorsLocal = localPageNumbers.length > 0
          && localPageNumbers.length === sourcePageNumbers.length
          && localPageNumbers.every((page, index) => page === sourcePageNumbers[index]);
        const alignPageOf = (slide) => (sourceMirrorsLocal ? pageNumberFromId(slide.id) : slideSourcePage(slide));
        const byAlignedPage = new Map();
        for (const slide of previous) {
          const sourcePage = alignPageOf(slide);
          if (sourcePage != null && !byAlignedPage.has(sourcePage)) byAlignedPage.set(sourcePage, slide);
        }
        // 源里有的页：字段以源为准，但保留本地 id/order、原始源页标记与 local-only 的 visualBrief。
        const merged = rebuilt.map((row) => {
          const local = byAlignedPage.get(row.order);
          if (!local) return row;
          // F-121：重建 manifest 时 visualBrief 是「本地才有的字段」，必须连写作风格一起保住；
          // 只留 visualBrief 会把 provenance 冲掉，脚本页就全变成「brief 风格未记录」。
          const next = { ...row, id: local.id, order: local.order };
          if (Object.prototype.hasOwnProperty.call(local, "sourcePage")) next.sourcePage = local.sourcePage;
          if (String(local.visualBrief ?? "").trim()) {
            next.visualBrief = local.visualBrief;
            if (local.visualBriefDesign) next.visualBriefDesign = local.visualBriefDesign;
          }
          return next;
        });
        // 源里没有的页 = 本地追加 / 插入页（F-99 / F-208）。重建 manifest 时不能丢，
        // 否则 Inspector 一保存（forceRebuild）就把 6→10 页打回 6 页。
        const extras = previous.filter((slide) => {
          const sourcePage = alignPageOf(slide);
          return sourcePage == null || !rebuilt.some((row) => row.order === sourcePage);
        });
        // 兜底：源与本地都改过时可能撞出重复 id，宁可保守去重（保留先出现的那条），也不能一本 deck 两份 p07。
        const seenIds = new Set();
        const slides = [...merged, ...extras]
          .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
          .filter((slide) => {
            if (!slide?.id || seenIds.has(slide.id)) return false;
            seenIds.add(slide.id);
            return true;
          });
        deck = {
          ...deck,
          title: view.title,
          status: view.status || deck.status,
          sourceSignature: signature,
          buildWarnings: view.warnings,
          slides,
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
        const sourcePage = slideSourcePage(slide);
        const row = rows.find((item) => item.page === sourcePage);
        const body = String(row?.fields?.["正文"] ?? "").trim();
        if (body) {
          slide.body = body;
          changed = true;
        }
      }
      // F-209：已落盘的旧 manifest 里 visualBrief 可能还是「源 prompt 原样」（含 `### P02` 分页标题）。
      // 只删结构标题行、别的一字不动；改一次就够（下次比较不再变化）。
      for (const slide of current.slides) {
        const cleaned = stripVisualBriefScaffolding(slide.visualBrief);
        if (cleaned !== String(slide.visualBrief ?? "")) {
          slide.visualBrief = cleaned;
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

  /** 已落版 script revision 列表（新的在前）；首稿判定与回滚共用。 */
  function listScriptRevisions(deckId) {
    const dir = join(deckDir(deckId), "script", "revisions");
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter((name) => /^v\d+\.md$/.test(name))
      .sort()
      .reverse()
      .map((name) => {
        const revision = name.replace(/\.md$/, "");
        const noteFile = join(dir, `${revision}.note.txt`);
        return {
          revision,
          savedAt: statSync(join(dir, name)).mtime.toISOString(),
          note: existsSync(noteFile) ? readFileSync(noteFile, "utf8").trim() : "",
        };
      });
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
    insertScriptPages,
    shiftSlideDirs,
    scriptPageNumbers,
    /** 某页对应的原始源页号（源 baseline 图映射；页不存在返回 null）（F-208）。 */
    sourcePageOf(deckId, pageId) {
      const deck = manifest(deckId);
      const slide = deck?.slides?.find((candidate) => candidate.id === pageId);
      return slide ? slideSourcePage(slide) : null;
    },
    /**
     * 源 baseline 图的 key（`p03`）：按 slide 的原始源页取，插页重编号不会挂错图。
     * 页不在 manifest 时按传入 id 原样返回（导航/预览会直接拿源页号查）；
     * 返回 null = 这页是插页新增的，源里没有 baseline 图。
     */
    sourcePageKey(deckId, pageId) {
      const deck = manifest(deckId);
      const slide = deck?.slides?.find((candidate) => candidate.id === pageId);
      if (!slide) return pageId;
      const page = slideSourcePage(slide);
      return page == null ? null : pageIdFromNumber(page);
    },
    saveScriptRevision,
    listScriptRevisions,
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
