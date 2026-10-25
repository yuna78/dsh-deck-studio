/**
 * dsh-plugin-deck-studio —— 宿主半。
 *
 * 两个挂载点（ADR-0006 D2）：
 * - profile 根：观测路由 `/api/deck-studio.*`（Connection 鉴权之下）+ 客户端面板数据；
 * - preset 子树（config.tools = true）：注册 deck 工具到该 preset 的会话。
 *
 * 只用 node: 内置模块；工具面在 lib/tools.js，trace 落盘在 lib/store.js。
 * @module dsh-plugin-deck-studio
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { PLUGIN_DIR, mergeConfig, repoRootFrom } from "./lib/config.js";
import { createRuntimeStore } from "./lib/store.js";
import { createDeckWorkspace, scriptSectionRange } from "./lib/deck-workspace.js";
import { createLocalSourceAdapter } from "./lib/source-adapter.js";
import { DOC_FILE_EXTS, readDeckDoc, resolveDeckDocs, resolveDocFile, scaffoldDeckDocs } from "./lib/deck-docs.js";
import { buildIntentMarkdown, buildMaterialsMarkdown, buildStyleReferenceMarkdown } from "./lib/deck-templates.js";
import { exportDeck, toJpeg, zip } from "./lib/exporter.js";
import { commitFiles, findRepo, unstageRemovedPath } from "./lib/git-commit.js";
import { pageEditView, savePageEdit } from "./lib/script-writer.js";
import { buildDeckRules, readDeckRules } from "./lib/deck-rules.js";
import { contentDensityOptions, densitySpec, normalizeContentDensity } from "./lib/content-density.js";
import { defineDeckTools } from "./lib/tools.js";
import { faqIndex, searchFaq } from "./lib/faq.js";
import { createScriptToSourceSync, decideProposal } from "./lib/proposal-decision.js";
import { createDesignRegistry, normalizeAbbr } from "./lib/designs.js";
import { readSampleRecords, readStyleDefinition, writeStyleDefinition } from "./lib/design-style.js";
import { resolveMediaFile, scanDesignStyles, scanResources } from "./lib/home-catalog.js";
import { defaultSelection, renderModelPayload, resolveSelection } from "./lib/render-nodes.js";
import { applyRenderSettings, readRenderSettings, renderSettingsPayload, saveRenderSettings } from "./lib/render-settings.js";
import { editEndpointFor, selectRenderer } from "./lib/render.js";

/** 稳定 Cordis 插件名。 */
export const name = "deck-studio";

/** connection：浏览器信任栅栏 + fetch 路由。tools 按需惰性取（见 apply）。 */
export const inject = ["connection"];

export const ROUTES = {
  status: "/api/deck-studio.status",
  state: "/api/deck-studio.state",
  workbench: "/api/deck-studio.workbench",
  app: "/api/deck-studio.app",
  asset: "/api/deck-studio.asset",
  doc: "/api/deck-studio.doc",
  docfile: "/api/deck-studio.docfile",
  export: "/api/deck-studio.export",
  pageEdit: "/api/deck-studio.page-edit",
  pageSave: "/api/deck-studio.page-save",
  media: "/api/deck-studio.media",
  renderModel: "/api/deck-studio.render-model",
  deckCreate: "/api/deck-studio.deck-create",
  deckDensity: "/api/deck-studio.deck-density",
  renderSettings: "/api/deck-studio.render-settings",
  userSettings: "/api/deck-studio.user-settings",
  deckDelete: "/api/deck-studio.deck-delete",
  deckDesign: "/api/deck-studio.deck-design",
  designCreate: "/api/deck-studio.design-create",
  designDelete: "/api/deck-studio.design-delete",
  designSample: "/api/deck-studio.design-sample",
  stylesSeed: "/api/deck-studio.styles-seed",
  sessionBind: "/api/deck-studio.session-bind",
  // F-108：工作台「确认落版 / 驳回」按钮——与 Agent 的 deck_revision_confirm 共用落版逻辑。
  proposalDecide: "/api/deck-studio.proposal-decide",
  sessionBindings: "/api/deck-studio.session-bindings",
  handoff: "/api/deck-studio.handoff",
  sourcefile: "/api/deck-studio.sourcefile",
  // F-140：内置 FAQ（工作台「？帮助」面板与 deck_help 工具同源）
  faq: "/api/deck-studio.faq",
  // F-141：首页「使用手册」——仓库里的 docs/manual.md + 截图，直接在工作台里读
  manual: "/api/deck-studio.manual",
  manualDoc: "/api/deck-studio.manual-doc",
  docsAsset: "/api/deck-studio.docs-asset",
};

/** 出图资产 MIME（image deck 只有图片；svg 仅 fake 测试用）。 */
const ASSET_MIME = { ".png": "image/png", ".webp": "image/webp", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".svg": "image/svg+xml" };
const ASSET_EXTS = [".png", ".webp", ".jpg", ".jpeg", ".svg"];

/** 仓库根（资料白名单工具同源：README / docs / samples / plugin 代码都在这下面）。 */
const REPO_ROOT = repoRootFrom(PLUGIN_DIR);

/** 参考资料自由文本解析（F-78）：一行一条，也兼容「路径 —— 说明」与缩进续行。 */
function parseReferenceEntries(raw) {
  const lines = String(raw ?? "").split(/\r?\n/);
  const entries = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    const indent = line.length - line.trimStart().length;
    const body = line.trim().replace(/^(?:[-*+]|\d+[.)、])\s*/, "");
    if (!body) continue;
    const withoutGroup = body.replace(/^【[^】]*】\s*/, "").trim();
    if (/^【[^】]*】$/.test(body) || !withoutGroup) continue;
    const split = withoutGroup.match(/^(.+?)\s*(?:——|–|—|\s\|\s)\s*(.+)$/);
    entries.push({ ref: (split ? split[1] : withoutGroup).trim(), note: split ? split[2].trim() : "", indent });
  }
  return entries.slice(0, 80);
}

/** 这行看起来像「引用」（路径 / 文件名 / 目录 / 链接），还是说明续行。 */
function looksLikeReference(ref) {
  return /^https?:\/\//i.test(ref)
    || /^[A-Za-z0-9_.\/\-]+\.(md|txt|pdf|docx?|xlsx?|csv|json|ya?ml|jpg|jpeg|png|webp|svg)$/i.test(ref)
    || /^(docs|samples|assets|plugin|scripts|src|tests|appendix|fixtures)\//i.test(ref)
    || /^(README|CHANGELOG|LICENSE)(\.md)?$/i.test(ref)
    || /\/$/.test(ref);
}

/** 参考资料条目 → 支撑材料清单行（文件 / 目录存在性 / 大小 / 标题）；不做内容分析。 */
export function describeReferences(raw, sourceRoot = "") {
  const rows = [];
  for (const { ref, note: rawNote, indent } of parseReferenceEntries(raw)) {
    // 缩进续行（例如路径下面的「定位 / 用户问题 / …」）并到上一条的「已知信息」里。
    if (indent >= 2 && rows.length && !looksLikeReference(ref)) {
      const prev = rows[rows.length - 1];
      prev.note = `${prev.note}${prev.note ? "；" : ""}${rawNote || ref}`.slice(0, 180);
      continue;
    }
    if (/^https?:\/\//i.test(ref)) {
      rows.push({ ref, type: "链接", status: "未抓取", note: rawNote || "创建时登记的链接；需要时由 Agent 读取 / 用户确认" });
      continue;
    }
    const urlHit = ref.match(/https?:\/\/\S+/);
    if (urlHit) {
      rows.push({ ref: urlHit[0], type: "链接", status: "未抓取", note: rawNote || ref.replace(urlHit[0], "").trim() || "创建时登记的链接" });
      continue;
    }
    const candidates = isAbsolute(ref) ? [ref] : [join(sourceRoot, ref), join(REPO_ROOT, ref)];
    const file = candidates.find((candidate) => candidate && existsSync(candidate) && statSync(candidate).isFile());
    const dir = candidates.find((candidate) => candidate && existsSync(candidate) && statSync(candidate).isDirectory());
    if (file) {
      const sizeKb = Math.max(1, Math.round(statSync(file).size / 1024));
      rows.push({ ref, type: "文件", status: "已找到", note: `${sizeKb} KB${rawNote ? ` · ${rawNote}` : ""}` });
    } else if (dir) {
      const count = readdirSync(dir).length;
      rows.push({ ref, type: "目录", status: "已找到", note: `${count} 项${rawNote ? ` · ${rawNote}` : ""}` });
    } else if (looksLikeReference(ref) || /[\\/]|\.(md|txt|pdf|docx?|xlsx?|csv|json|jpg|png)$/i.test(ref)) {
      rows.push({ ref, type: "文件", status: "未找到", note: rawNote || "路径没找到：确认相对仓库根还是 deck 源目录，或改发绝对路径" });
    } else {
      rows.push({ ref, type: "说明", status: "已记录", note: rawNote || (ref.length > 80 ? `${ref.slice(0, 80)}…` : ref) });
    }
  }
  return rows;
}

/** 工作台前端：同一套设计稿页面，由插件在同源伺服（cookie 鉴权之下）。 */
const UI_DIR = join(PLUGIN_DIR, "ui");
function workbenchPage() {
  const html = readFileSync(join(UI_DIR, "workbench.html"), "utf8");
  const css = readFileSync(join(UI_DIR, "workbench.css"), "utf8");
  return html.replace("/*__CSS__*/", () => css);
}

/** UI 指纹：HTML+CSS 内容变了前端自动 reload，避免旧页面混用新旧布局。 */
function uiVersion() {
  const html = readFileSync(join(UI_DIR, "workbench.html"), "utf8");
  const css = readFileSync(join(UI_DIR, "workbench.css"), "utf8");
  return createHash("sha1").update(html).update("\n").update(css).digest("hex").slice(0, 12);
}

/** 受控源目录里已知的工作文件（只读引用，不复制内容）。 */
function sourceFiles(sourceRoot) {
  if (!sourceRoot) return [];
  // F-136：这 6 项只是「源目录里的文件清单」，不是都必须有。
  // 以前统一标「缺失」，新 deck 一眼 4 个红字，看起来像坏了。
  const known = [
    ["script.md", "逐页故事线源（只读）", { required: true, hint: "出图与脚本页的唯一事实源，必须有" }],
    ["prompts", "每页 image prompt（visualBrief 来源）", { required: false, hint: "没有也不影响出图：visualBrief 写在工作区 manifest 里" }],
    ["build/deck.yaml", "构建清单（页数对账）", { required: false, hint: "只用来源里登记自定义页序 / 页数对账；本地新建 deck 用 manifest 即可" }],
    ["outputs/full/final", "源里已出好的整页图（Deck baseline）", { required: false, hint: "客户端源常带旧版整页图当 baseline；新 deck 还没出图，所以没有" }],
    ["CURRENT.md", "负责人当前状态", { required: false, hint: "交接 / 治理用；新建 deck 不会自动写，需要时让 Agent 起草" }],
    ["feedback.md", "负责人反馈", { required: false, hint: "有真实用户反馈才写；没有就是空，不算缺" }],
  ];
  return known.map(([name, role, meta]) => ({
    name,
    role,
    required: meta.required,
    hint: meta.hint,
    exists: existsSync(join(sourceRoot, name)),
  }));
}

let versionCache = null;
function pluginVersion() {
  if (versionCache) return versionCache;
  try {
    versionCache = JSON.parse(readFileSync(join(PLUGIN_DIR, "package.json"), "utf8")).version ?? "0.0.0";
  } catch {
    versionCache = "0.0.0";
  }
  return versionCache;
}

function json(payload, status = 200) {
  return Response.json(payload, { status, headers: { "cache-control": "no-store" } });
}

/**
 * 构建运行时服务（路由与工具共用；冒烟测试直接调用本函数喂假 ctx）。
 * @param {object} config - mergeConfig 产物。
 */
export function createService(config, logger, env = process.env) {
  // F-126：设置页保存的生图配置（$dataRoot/render-settings.json）覆盖 profile 默认值，
  // 不用改 patch、不用重启。没有这个文件时保持原配置。
  applyRenderSettings(config, readRenderSettings(config.dataRoot));
  // F-158：本机用户名（首次启动登记，之后问候语 / 新 deck owner 默认用它）。
  const userNameFile = join(config.dataRoot, "user.json");
  function readStoredUserName() {
    try {
      const raw = JSON.parse(readFileSync(userNameFile, "utf8"));
      return typeof raw?.name === "string" ? raw.name.trim().slice(0, 40) : "";
    } catch {
      return "";
    }
  }
  function saveUserName(name) {
    const clean = String(name ?? "").trim().slice(0, 40);
    if (!clean) throw new Error("名字不能为空");
    mkdirSync(config.dataRoot, { recursive: true });
    writeFileSync(userNameFile, `${JSON.stringify({ name: clean }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    config.userName = clean;
    return clean;
  }
  if (!config.userName) {
    const stored = readStoredUserName();
    if (stored) config.userName = stored;
  }
  const store = createRuntimeStore(config.dataRoot);
  const workspace = createDeckWorkspace(config);
  // 本地新建的 deck 注册表（.deck/decks-registry.json，不进 git）：重启后仍然存在。
  const decksRegistryFile = join(config.dataRoot, "decks-registry.json");
  /** design（风格）注册表 + session ↔ deck|design 绑定表（F-43）。 */
  const designRegistry = createDesignRegistry({ dataRoot: config.dataRoot });
  const readLocalDeckEntries = () => {
    try {
      const raw = JSON.parse(readFileSync(decksRegistryFile, "utf8"));
      return Array.isArray(raw?.decks) ? raw.decks : [];
    } catch {
      return [];
    }
  };
  for (const entry of readLocalDeckEntries()) {
    if (!entry?.id || !entry?.sourceRoot) continue;
    if (config.decks.some((deck) => deck.id === entry.id)) continue;
    // F-71：标出「来自注册表」——preset 工具实例靠它区分静态源，运行时删除的 deck 才能被移除。
    config.decks.push({ id: entry.id, label: entry.label || entry.id, sourceRoot: entry.sourceRoot, kind: entry.kind ?? "deck", designId: entry.designId ?? null, fromRegistry: true });
  }
  // F-157 首次启动自举：新装 profile 打开 bootstrap 时，自动登记示例 deck / 拷资源库 / 导入预设风格，
  // 避免「装完四个页面全是空的」。可用 profile patch 里 bootstrap: false 关掉。
  // 示例 deck 必须在 adapters 之前登记；资源和 fashioned 风格放后面（依赖 adapters/workspace）。
  if (config.bootstrap === true) bootstrapSampleDeck();
  const adapters = config.decks.map((deck) => createLocalSourceAdapter(deck));

  /** deckId → adapter（workbench / 资产路由共用）。 */
  const adapterOf = (deckId) => adapters.find((adapter) => adapter.id === deckId) ?? null;

  // ── 出图节点 / 模型选择（ADR-0010）────────────────────────────────────────
  /** 当前 deck 的节点选择文件（工作副本；不进 git）。 */
  function renderSelectionFile(deckId) {
    try {
      return join(workspace.deckDir(deckId), "render-selection.json");
    } catch {
      return "";
    }
  }

  /** 当前生效选择：工作副本里的选择优先，否则用配置 default。 */
  function currentRenderSelection(deckId) {
    const file = renderSelectionFile(deckId);
    if (file && existsSync(file)) {
      try {
        const saved = JSON.parse(readFileSync(file, "utf8"));
        const resolved = resolveSelection(config.render, saved);
        if (resolved) return { nodeId: resolved.nodeId, model: resolved.model };
      } catch {
        /* 坏文件回退配置默认 */
      }
    }
    return defaultSelection(config.render);
  }

  /** 工作台/设置面板用的节点 payload（只有 keyConfigured，没有 key 值）。 */
  function renderState(deckId) {
    return renderModelPayload(config.render, { env, selection: currentRenderSelection(deckId) });
  }

  /** 切换当前 deck 的生效模型（校验节点/模型存在；事件留痕）。 */
  function setRenderSelection(deckId, patch) {
    if (!adapterOf(deckId) && !existsSync(workspace.deckDir(deckId))) throw new Error(`未知 deck：${deckId}`);
    const resolved = resolveSelection(config.render, patch);
    if (!resolved) {
      throw new Error(`节点/模型不存在：${patch?.nodeId ?? "?"} / ${patch?.model ?? "?"}（检查 profile 的 render.nodes）`);
    }
    const file = renderSelectionFile(deckId);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify({ nodeId: resolved.nodeId, model: resolved.model, updatedAt: new Date().toISOString() }, null, 2)}\n`, "utf8");
    store.recordEvent({
      type: "deck.render.model.select",
      deckId,
      actor: "user",
      status: "succeeded",
      payload: { nodeId: resolved.nodeId, nodeName: resolved.nodeName, model: resolved.model, label: resolved.label },
    });
    return renderState(deckId);
  }

  /** 新建 deck 的源目录骨架：默认 6 页占位（标题等对话里补）。 */
  const DEFAULT_NEW_DECK_PAGES = 6;
  const MAX_NEW_DECK_PAGES = 40;
  const NEW_DECK_PAGE_TITLES = [
    "开场：为什么讲这件事",
    "背景：听众现在的工作方式",
    "问题：哪里卡住了",
    "案例：一段真实工作现场",
    "方法：AI 应该进入哪一步",
    "收口：可复用的工作方式",
  ];

  /**
   * 新建 deck 的页标题（F-99）：优先用调用方给的 pageTitles；否则按页数从默认骨架取，
   * 超出 6 页的部分生成占位标题。页数创建时可选、创建后还能在对话里用
   * deck_script_add_page 追加（只追加，不重排）。
   */
  function newDeckPageTitles(payload, blank) {
    if (blank) return [];
    const explicit = Array.isArray(payload.pageTitles)
      ? payload.pageTitles.map((item) => String(item ?? "").trim()).filter(Boolean).slice(0, MAX_NEW_DECK_PAGES)
      : [];
    if (explicit.length) return explicit;
    const requested = Number.parseInt(payload.pages, 10);
    const count = Number.isInteger(requested) && requested > 0
      ? Math.min(requested, MAX_NEW_DECK_PAGES)
      : DEFAULT_NEW_DECK_PAGES;
    const titles = [...NEW_DECK_PAGE_TITLES];
    while (titles.length < count) titles.push(`待补章节 ${titles.length + 1}`);
    return titles.slice(0, count);
  }

  /** 新建 deck 的目录名（英文 kebab）：只允许 [a-z0-9-]，空则回退 deckId。 */
  function normalizeDeckSlug(value) {
    const slug = String(value ?? "").trim().toLowerCase();
    if (!slug) return "";
    if (!/^[a-z0-9][a-z0-9-]{1,60}$/.test(slug)) {
      throw new Error("项目目录名只能用小写字母/数字/中划线（例：talk-ai-6-stages）");
    }
    return slug;
  }

  /**
   * 新建 deck 项目（负责人 2026-10-21 反馈）：意图 + 风格 → 源目录 + script 骨架 + 9 份文档骨架，
   * 然后回到对话里补资料/改 script，直到可以出图。不直接出图。
   */
  function createDeck(payload = {}) {
    const title = String(payload.title ?? "").trim();
    const occasion = String(payload.occasion ?? "").trim();
    const success = String(payload.success ?? "").trim();
    const scopeOut = String(payload.scopeOut ?? "").trim();
    if (!title) throw new Error("deck 标题不能为空");
    // 空白画布（design 会话用）：0 页，等 Agent 把风格样张沉淀到 designs/<ABBR>/。
    const blank = Boolean(payload.blank);
    const pageTitles = newDeckPageTitles(payload, blank);
    const pad = (n) => String(n).padStart(2, "0");
    const now = new Date();
    const id = `deck-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}-${Math.random().toString(36).slice(2, 6)}`;
    // 新建 deck 的去处（负责人 2026-10-21）：配置了 projectsRoot 就落在共享根
    // （`00_company/sharing/<目录名>/`，和已有 deck 源结构一致）；不配则沿用旧的
    // 内部 `.deck/projects/<id>/source`。design 空白画布始终走内部数据目录。
    const projectsRoot = blank ? "" : String(config.projectsRoot ?? "").trim();
    const slug = blank ? "" : normalizeDeckSlug(payload.dirName);
    let sourceRoot;
    if (projectsRoot) {
      sourceRoot = join(projectsRoot, slug || id);
      if (existsSync(sourceRoot) && readdirSync(sourceRoot).length > 0) {
        throw new Error(`项目目录已存在且非空：${sourceRoot}（换一个目录名）`);
      }
    } else {
      sourceRoot = join(config.dataRoot, "projects", id, "source");
    }
    mkdirSync(join(sourceRoot, "prompts"), { recursive: true });
    mkdirSync(join(sourceRoot, "build"), { recursive: true });
    mkdirSync(join(sourceRoot, "pages"), { recursive: true });
    mkdirSync(join(sourceRoot, "outputs", "full", "final"), { recursive: true });

    const pageBlocks = pageTitles.map((pageTitle, index) => {
      const heading = `P${pad(index + 1)} · ${pageTitle}`;
      return `### ${heading}\n**标题**：待定\n**副标题**：这一页回答什么\n**主张**：（待补：这页要证明的判断，一句话）\n**正文**：（待补：3–5 句正文，支撑上面的主张）\n**提示词**：（待补：visualBrief，说明画面要看到什么）\n`;
    }).join("\n");
    const script = [
      "---",
      `title: ${title}`,
      `owner: ${config.userName || ""}`,
      `created: ${now.toISOString()}`,
      "confidential: client",
      "render: image",
      "deck-type: talk",
      `pages: ${pageTitles.length}`,
      "status: draft",
      "---",
      "",
      `# ${title}`,
      "",
      "> 由「新建 Deck」创建：先补意图与资料，再改 script；未确认前不出图。",
      "",
      "## 故事线",
      "",
      blank ? "（空白画布：这个 deck 只作 design 的样张画布，不承载正式 deck 内容。）" : "（待补：分几段、每段回答什么、为什么这个顺序。）",
      "",
      pageBlocks,
    ].join("\n");
    writeFileSync(join(sourceRoot, "script.md"), script, "utf8");

    // F-123：项目规则随 deck 一起落地（受众 / 禁忌 / 视觉 / 事实来源直接取自创建表单），
    // 治理页不再显示「未配置」再去复制模板；之后用户改 deck.rules.md 即生效。
    if (!blank) {
      writeFileSync(
        join(sourceRoot, "deck.rules.md"),
        buildDeckRules({ audience: payload.audience, scopeOut, style: payload.style, references: payload.references, topic: payload.topic }),
        "utf8",
      );
    }

    // F-73：按 `**字段**：值` 写结构化字段（治理/「意图」标签页按这个解析），
    // 不再只写自由正文——否则弹窗里填了，打开仍显示「待补 / 缺字段」。
    writeFileSync(
      join(sourceRoot, "intent.md"),
      buildIntentMarkdown({
        title,
        audience: payload.audience,
        topic: payload.topic,
        intent: payload.intent,
        references: payload.references,
        occasion,
        success,
        scopeOut,
        created: now.toISOString(),
        owner: config.userName,
      }),
      "utf8",
    );

    const styleDescription = String(payload.style?.description ?? "").trim();
    const styleAbbr = String(payload.style?.abbr ?? "").trim();
    // 预设风格（seeds/styles/<ABBR>.json）自带画面语言 / 不要什么 / 参考；
    // 新建时选了 preset 就把这些真实约束落进 Design 文档，治理不当「画面约束不足」。
    let presetStyle = null;
    if (styleAbbr) {
      try {
        presetStyle = JSON.parse(readFileSync(join(SEED_STYLES_DIR, `${styleAbbr.toUpperCase()}.json`), "utf8"));
      } catch {
        presetStyle = null;
      }
    }
    writeFileSync(
      join(sourceRoot, "style-reference.md"),
      buildStyleReferenceMarkdown({ title, styleAbbr, styleDescription, preset: presetStyle, created: now.toISOString() }),
      "utf8",
    );

    const label = title;
    const deckConfig = { id, label, sourceRoot, kind: payload.kind ?? "deck", designId: payload.designId ?? null };
    config.decks.push(deckConfig);
    const adapter = createLocalSourceAdapter(deckConfig);
    adapters.push(adapter);
    try {
      workspace.ensureDeck(adapter, { styleBrief: config.styleBrief });
      // F-124：内容密度（一页写多少字 / 画面要求多细）随 deck 落 manifest，Agent 写 script 前会读到。
      const createdManifest = workspace.manifest(id);
      if (createdManifest) {
        createdManifest.contentDensity = normalizeContentDensity(payload.contentDensity);
        workspace.saveManifest(createdManifest);
      }
    } catch (error) {
      logger?.warn?.(`deck-studio: 新 deck ${id} ensureDeck 失败：${error?.message ?? error}`);
    }
    try {
      deckDocsScaffold(id);
    } catch (error) {
      logger?.warn?.(`deck-studio: 新 deck ${id} 文档骨架失败：${error?.message ?? error}`);
    }

    // F-78：创建时填的参考资料直接解析进「支撑材料」工作副本，不再留 TODO；
    // Agent 之后读资料，用 deck_doc_update 补「可引用事实 / 支持哪条主张 / 缺口」。
    try {
      const referenceRows = describeReferences(payload.references, sourceRoot);
      const materialsDir = join(workspace.deckDir(id), "docs");
      mkdirSync(materialsDir, { recursive: true });
      writeFileSync(
        join(materialsDir, "materials.md"),
        buildMaterialsMarkdown({ title, raw: String(payload.references ?? "").trim(), rows: referenceRows }),
        "utf8",
      );
    } catch (error) {
      logger?.warn?.(`deck-studio: 新 deck ${id} 支撑材料初始化失败：${error?.message ?? error}`);
    }

    // 落注册表（重启后仍可用）
    mkdirSync(dirname(decksRegistryFile), { recursive: true });
    const entries = readLocalDeckEntries().filter((entry) => entry?.id !== id);
    entries.push({
      id,
      label,
      sourceRoot,
      dirName: slug || null,
      createdAt: now.toISOString(),
      audience: String(payload.audience ?? "").trim(),
      topic: String(payload.topic ?? "").trim(),
      intent: String(payload.intent ?? "").trim(),
      references: String(payload.references ?? "").trim(),
      occasion,
      success,
      scopeOut,
      style: { abbr: styleAbbr, description: styleDescription },
      kind: payload.kind ?? "deck",
      designId: payload.designId ?? null,
    });
    writeFileSync(decksRegistryFile, `${JSON.stringify({ decks: entries }, null, 2)}\n`, "utf8");

    // F-73：弹窗选了已登记的预设风格（如 FYI）→ 直接把 deck ↔ design 关联落表，
    // 「Design」标签页不再显示「未关联」，也不需要用户再手动关联一次。
    if (styleAbbr) {
      const matched = designRegistry.findDesignByAbbr(styleAbbr);
      if (matched) {
        try {
          designRegistry.setDeckDesign(id, matched.designId);
        } catch (error) {
          logger?.warn?.(`deck-studio: 新 deck ${id} 关联风格失败：${error?.message ?? error}`);
        }
      }
    }

    store.recordEvent({
      type: "deck.created",
      deckId: id,
      actor: "user",
      status: "succeeded",
      payload: {
        label,
        sourceRoot,
        kind: payload.kind ?? "deck",
        designId: payload.designId ?? null,
        style: { abbr: styleAbbr, description: styleDescription },
        pages: pageTitles.length,
        note: `初始化：script ${pageTitles.length} 页 + 意图 / 风格 / 参考资料清单 / 文档骨架`,
      },
    });
    return {
      deckId: id,
      label,
      sourceRoot,
      pages: pageTitles.length,
      kind: payload.kind ?? "deck",
      designId: payload.designId ?? null,
      contentDensity: normalizeContentDensity(payload.contentDensity),
    };
  }

  /**
   * F-124：设置 deck 的内容密度（auto / concise / medium / dense）。
   * 只改 manifest 设置，不改已有内容；Agent 下次读 script / 提案时按新目标字数写。
   */
  function setDeckDensity(deckId, density) {
    const id = String(deckId ?? "").trim();
    const adapter = adapterOf(id);
    if (!adapter) throw new Error(`deck 不可用：${id}`);
    const deck = workspace.ensureDeck(adapter, { styleBrief: config.styleBrief });
    if (!deck) throw new Error(`manifest 缺失：${id}`);
    const value = normalizeContentDensity(density);
    deck.contentDensity = value;
    workspace.saveManifest(deck);
    store.recordEvent({
      type: "deck.density.set",
      deckId: id,
      actor: "user",
      status: "succeeded",
      payload: { contentDensity: value, label: densitySpec(value).label },
    });
    return { deckId: id, contentDensity: value, label: densitySpec(value).label, spec: densitySpec(value) };
  }

  /** deck 配置里的 kind（design 画布等；没配就是普通 deck）。 */
  function deckKind(deckId) {
    const entry = config.decks.find((item) => item.id === deckId);
    return { kind: entry?.kind ?? "deck", designId: entry?.designId ?? null };
  }

  /** 本机「新建 Deck」注册的 deck id 集合（这些可删除；受控源 deck 不可删）。 */
  /** 预设风格包目录（随插件分发；F-56）。 */
  const SEED_STYLES_DIR = join(PLUGIN_DIR, "seeds", "styles");
  const SEED_SAMPLES_DIR = join(PLUGIN_DIR, "seeds", "samples");

  /** 上传/导入图片的 MIME → 扩展名（只允许图片）。 */
  const SAMPLE_MIME_EXT = { "image/png": "png", "image/jpeg": "jpg", "image/jpg": "jpg", "image/webp": "webp" };
  const SAMPLE_MAX_BYTES = 12 * 1024 * 1024;

  /** 某个 design 的画布风格目录：`<canvas sourceRoot>/designs/<ABBR>/`。 */
  function designStyleDir(design) {
    const adapter = adapterOf(design.canvasDeckId);
    if (!adapter) throw new Error(`风格画布不存在：${design.canvasDeckId}`);
    return join(adapter.sourceRoot, "designs", design.abbr);
  }

  /**
   * 某个 design 的风格定义文件（F-63）。
   * Design 工作区只保留「风格定义 + 样张」两样资料，不再读 deck 的 9 份文档。
   */
  function readDesignStyleFiles(design) {
    let dir = "";
    try {
      dir = designStyleDir(design);
    } catch {
      dir = "";
    }
    const read = (fileName) => {
      if (!dir) return "";
      try {
        const file = join(dir, fileName);
        return existsSync(file) ? readFileSync(file, "utf8") : "";
      } catch {
        return "";
      }
    };
    const markdown = read("style.md");
    let style = null;
    try {
      style = JSON.parse(read("style.json") || "null");
    } catch {
      style = null;
    }
    let files = [];
    if (dir && existsSync(dir)) {
      try {
        files = readdirSync(dir)
          .filter((fileName) => statSync(join(dir, fileName)).isFile())
          .map((fileName) => ({ name: fileName, sizeBytes: statSync(join(dir, fileName)).size }));
      } catch {
        files = [];
      }
    }
    return { dirLabel: `designs/${design.abbr}`, markdown, style, files };
  }

  /** 给一个 design 加样张（贴图/上传/预设样张共用，F-55/F-56）。 */
  function addDesignSamples(payload = {}) {
    const design = designRegistry.findDesign(String(payload.designId ?? ""));
    if (!design) throw new Error(`未知 design：${payload.designId ?? "?"}`);
    const list = Array.isArray(payload.files) ? payload.files : [];
    if (!list.length) throw new Error("没有收到图片");
    const dir = designStyleDir(design);
    mkdirSync(dir, { recursive: true });
    const added = [];
    for (const file of list) {
      const mime = String(file?.mime ?? "").toLowerCase();
      const ext = SAMPLE_MIME_EXT[mime];
      if (!ext) throw new Error(`只支持 png / jpg / webp 图片（收到 ${mime || "未知类型"}）`);
      const raw = String(file?.data ?? "");
      const b64 = raw.includes(",") ? raw.slice(raw.indexOf(",") + 1) : raw;
      const buffer = Buffer.from(b64, "base64");
      if (!buffer.length) throw new Error("图片内容为空");
      if (buffer.length > SAMPLE_MAX_BYTES) throw new Error(`单张图片不能超过 12MB（这张 ${(buffer.length / 1024 / 1024).toFixed(1)}MB）`);
      const base = String(file?.name ?? "sample")
        .replace(/\.[a-z0-9]+$/i, "")
        .replace(/[^\w\u4e00-\u9fa5-]+/g, "-")
        .slice(0, 32) || "sample";
      let fileName = `${base}.${ext}`;
      let n = 1;
      while (existsSync(join(dir, fileName))) fileName = `${base}-${++n}.${ext}`;
      writeFileSync(join(dir, fileName), buffer);
      added.push(fileName);
    }
    store.recordEvent({
      type: "design.sample.add",
      deckId: design.canvasDeckId,
      actor: "user",
      status: "succeeded",
      payload: { designId: design.designId, abbr: design.abbr, samples: added },
    });
    return { designId: design.designId, added, design: designProjectView(design) };
  }

  /** F-157：把仓库自带的示例 deck 登记成只读源（没有配置任何 decks 时）。 */
  function bootstrapSampleDeck() {
    if (config.decks.length > 0) return;
    const sampleRoot = join(REPO_ROOT, "samples", "deckline-intro");
    if (!existsSync(join(sampleRoot, "script.md"))) return;
    config.decks.push({ id: "sample-deckline-intro", label: "Deckline 示例手册", sourceRoot: sampleRoot, kind: "deck", designId: null, fromBootstrap: true });
  }

  /** F-157：资源库为空时，把插件自带的品牌素材拷进 `<dataRoot>/resources`。 */
  function bootstrapSharedResources() {
    const seedDir = join(PLUGIN_DIR, "seeds", "resources");
    if (!existsSync(seedDir)) return;
    const target = join(config.dataRoot, "resources");
    try {
      if (existsSync(target) && readdirSync(target).length > 0) return;
      mkdirSync(target, { recursive: true });
      const names = readdirSync(seedDir).filter((name) => name !== "index.json");
      for (const name of names) writeFileSync(join(target, name), readFileSync(join(seedDir, name)));
      if (existsSync(join(seedDir, "index.json"))) {
        writeFileSync(join(target, "index.json"), readFileSync(join(seedDir, "index.json")));
      } else {
        const items = names.filter((name) => /\.(png|jpe?g|webp|svg)$/i.test(name)).map((name) => ({ name, file: name, description: "Deckline 品牌素材（示例）" }));
        writeFileSync(join(target, "index.json"), JSON.stringify({ items }, null, 2));
      }
    } catch (error) {
      logger?.warn?.("deck-studio: 资源库自举失败", error);
    }
  }

  /** F-157：风格注册表为空时，自动导入插件自带的 8 个预设风格（含样张）。 */
  function bootstrapDesignStyles() {
    try {
      if (designRegistry.listDesigns().length > 0) return;
      seedStyleDesigns();
    } catch (error) {
      logger?.warn?.("deck-studio: 预设风格自举失败", error);
    }
  }

  /** 把插件自带的预设风格导入当前实例（已存在的 abbr 跳过，F-56）。 */
  function seedStyleDesigns() {
    if (!existsSync(SEED_STYLES_DIR)) throw new Error("插件里没有预设风格包（seeds/styles）");
    const files = readdirSync(SEED_STYLES_DIR).filter((name) => name.endsWith(".json")).sort();
    const seeded = [];
    const skipped = [];
    for (const file of files) {
      let seed;
      try {
        seed = JSON.parse(readFileSync(join(SEED_STYLES_DIR, file), "utf8"));
      } catch {
        continue;
      }
      const abbr = normalizeAbbr(seed?.abbr);
      const seedName = String(seed?.name ?? "").trim();
      const seedDesc = String(seed?.description ?? "").trim();
      if (!abbr || !seedName || !seedDesc) continue;
      if (designRegistry.findDesignByAbbr(abbr)) {
        skipped.push(abbr);
        continue;
      }
      const created = createDesign({
        name: seedName,
        abbr,
        description: seedDesc,
        constraints: String(seed.constraints ?? ""),
        reference: String(seed.reference ?? ""),
        styleBrief: String(seed.styleBrief ?? ""),
      });
      const samples = existsSync(SEED_SAMPLES_DIR)
        ? readdirSync(SEED_SAMPLES_DIR).filter((sample) => sample.toLowerCase().startsWith(`${abbr.toLowerCase()}-`) || sample.toLowerCase().startsWith(`${abbr.toLowerCase()}.`))
        : [];
      const filesPayload = samples.map((sample, index) => {
        const ext = extname(sample).slice(1).toLowerCase();
        const mime = ext === "png" ? "image/png" : ext === "webp" ? "image/webp" : "image/jpeg";
        return {
          name: `sample-${String(index + 1).padStart(2, "0")}`,
          mime,
          data: readFileSync(join(SEED_SAMPLES_DIR, sample)).toString("base64"),
        };
      });
      if (filesPayload.length) addDesignSamples({ designId: created.design.designId, files: filesPayload });
      store.recordEvent({
        type: "design.seeded",
        deckId: created.deckId,
        actor: "system",
        status: "succeeded",
        payload: { designId: created.design.designId, abbr, samples: samples.length, seed: file },
      });
      seeded.push({ designId: created.design.designId, abbr, name: seedName, canvasDeckId: created.deckId, samples: samples.length });
    }
    return { seeded, skipped, total: files.length };
  }

  /**
   * 生图配置状态（F-57）：只报「key 是否配置」与节点名，绝不返回 key。
   */
  /** F-126：当前生图设置（设置页读 / 写用；只回 keyConfigured，不回 key）。 */
  function renderSettings() {
    return renderSettingsPayload(config, { env, saved: readRenderSettings(config.dataRoot) });
  }

  /** 保存设置页填的 endpoint / 模型 / key 来源 / 尺寸 / 模式，立即生效（写本机数据文件）。 */
  function saveRenderConfig(payload = {}) {
    const saved = saveRenderSettings(config.dataRoot, payload);
    applyRenderSettings(config, { values: saved });
    store.recordEvent({
      type: "render.settings.saved",
      deckId: null,
      actor: "user",
      status: "succeeded",
      payload: { mode: saved.mode, endpoint: saved.endpoint, model: saved.model, apiKeyEnv: saved.apiKeyEnv, apiKeyFile: saved.apiKeyFile, size: saved.size, nodes: Array.isArray(saved.nodes) ? saved.nodes.map((node) => ({ id: node.id, name: node.name, endpoint: node.endpoint, models: node.models, keySaved: Boolean(node.apiKey), apiKeyEnv: node.apiKeyEnv, apiKeyFile: node.apiKeyFile })) : undefined },
    });
    return renderSettingsPayload(config, { env, saved: { found: true, values: saved, file: join(config.dataRoot, "render-settings.json") } });
  }

  function renderStatus() {
    const nodes = Array.isArray(config.render?.nodes) ? config.render.nodes : [];
    const fallback = {
      id: "default",
      name: "默认节点",
      // 旧单节点配置也要把 endpoint 报出来（否则永远显示「缺地址」，F-80 修复）
      endpoint: config.render?.endpoint ?? "",
      apiKeyEnv: config.render?.apiKeyEnv ?? "",
      apiKeyFile: config.render?.apiKeyFile ?? "",
      models: [config.render?.model ?? ""].filter(Boolean),
    };
    const list = (nodes.length ? nodes : [fallback]).map((node) => {
      const apiKeyEnv = String(node?.apiKeyEnv ?? "");
      const apiKeyFile = String(node?.apiKeyFile ?? "");
      let keyConfigured = Boolean(String(node?.apiKey ?? "").trim()) || Boolean(apiKeyEnv && env?.[apiKeyEnv]);
      if (!keyConfigured && apiKeyFile) {
        try {
          keyConfigured = readFileSync(apiKeyFile, "utf8").split("\n").some((line) => new RegExp(`^\\s*${apiKeyEnv}\\s*=`).test(line));
        } catch {
          keyConfigured = false;
        }
      }
      return {
        id: String(node?.id ?? ""),
        name: String(node?.name ?? node?.id ?? ""),
        endpoint: String(node?.endpoint ?? ""),
        models: Array.isArray(node?.models) ? node.models : [],
        keyConfigured,
        keySource: apiKeyEnv ? `env ${apiKeyEnv}` : apiKeyFile ? "apiKeyFile" : "未配置",
      };
    });
    const selection = defaultSelection(config.render);
    // real 模式要同时具备「节点地址 + key」才算就绪（默认不带节点地址，见 lib/config.js）。
    const addressMissing = list.length > 0 && list.every((node) => !node.endpoint);
    const keyMissing = !list.some((node) => node.keyConfigured);
    return {
      mode: config.render?.mode ?? "fake",
      size: config.render?.size ?? "",
      selection,
      nodes: list,
      ready: config.render?.mode === "real" && !addressMissing && !keyMissing,
      hint:
        config.render?.mode === "real"
          ? addressMissing
            ? "生图节点还没配地址：在 profile patch 的 render.nodes[].endpoint（或 env DSH_DECK_IMAGE_ENDPOINT）填 OpenAI 兼容的 /v1/images/generations 地址（见 docs/install.md）"
            : keyMissing
              ? "生图节点还没配 key：在 profile patch 的 render.nodes[].apiKeyEnv / apiKeyFile 配置环境变量或 key 文件（见 docs/install.md）"
              : ""
          : "当前是 fake 模式（占位图，不出真图）：把 render.mode 改成 real 并配置节点地址与 key",
    };
  }

  const localDeckIds = () => new Set(readLocalDeckEntries().map((entry) => entry?.id).filter(Boolean));

  /** 只删除数据目录 / projectsRoot 下的本机生成目录，绝不碰受控源 deck（F-51）。 */
  function removeLocalDir(dir) {
    const target = String(dir ?? "").trim();
    if (!target) return "";
    const roots = [join(config.dataRoot, "projects"), String(config.projectsRoot ?? "").trim()].filter(Boolean);
    const safe = roots.some((root) => target === root || target.startsWith(`${root}/`));
    if (!safe) return "";
    // F-104：先记下所属仓库（目录删了就找不到），删完把 index 里的暂存条目一起清掉，
    // 避免用户仓库里留下 AD（已 add + 已删）这种半删除状态。
    const repo = findRepo(target);
    rmSync(target, { recursive: true, force: true });
    if (repo) unstageRemovedPath(repo, target);
    return target;
  }

  /** 某正式 deck 关联的 design（简版，首页卡片 / Design 文档页用）。 */
  function deckDesignBrief(deckId) {
    const association = designRegistry.deckDesignFor(deckId);
    if (!association?.designId) return null;
    const design = designRegistry.findDesign(association.designId);
    if (!design) return null;
    return { designId: design.designId, abbr: design.abbr, name: design.name };
  }

  /** design 画布自己还没样张时，从受控源 deck 里找同 abbr / 同名称的风格目录借样张（只引用，不复制，F-49）。 */
  function findDeckStyleForDesign(design) {
    const abbrKey = String(design.abbr ?? "").toUpperCase();
    const nameKey = String(design.name ?? "").trim().toLowerCase();
    for (const adapter of adapters) {
      let deckDir = "";
      try {
        deckDir = workspace.deckDir(adapter.id);
      } catch {
        deckDir = "";
      }
      let styles = [];
      try {
        styles = scanDesignStyles({ deckId: adapter.id, sourceRoot: adapter.sourceRoot ?? "", deckDir });
      } catch {
        styles = [];
      }
      for (const style of styles) {
        if (abbrKey && String(style.abbr ?? "").toUpperCase() === abbrKey) return style;
        if (nameKey && String(style.name ?? "").trim().toLowerCase() === nameKey) return style;
      }
    }
    return null;
  }

  /** 某 design 对应的样张（从它的空白画布 deck 的 designs/<ABBR>/ 扫，不复制）。 */
  function designProjectView(design) {
    const adapter = adapterOf(design.canvasDeckId);
    let deckDir = "";
    try {
      deckDir = workspace.deckDir(design.canvasDeckId);
    } catch {
      deckDir = "";
    }
    let style = null;
    try {
      const styles = scanDesignStyles({ deckId: design.canvasDeckId, sourceRoot: adapter?.sourceRoot ?? "", deckDir });
      const key = String(design.abbr ?? "").toUpperCase();
      style = styles.find((item) => String(item.abbr).toUpperCase() === key) ?? styles[0] ?? null;
    } catch {
      style = null;
    }
    // 画布还没出样张时，借源 deck 里同风格的样张（F-49：Designs 页一张卡同时是会话入口 + 样张）
    let styleSamples = style?.samples ?? [];
    let styleDescription = style?.description ?? "";
    if (!styleSamples.length) {
      const fallback = findDeckStyleForDesign(design);
      if (fallback) {
        styleSamples = fallback.samples ?? [];
        styleDescription = styleDescription || fallback.description || "";
      }
    }
    const binding = designRegistry.bindingFor("design", design.designId);
    const deckEntry = config.decks.find((item) => item.id === design.canvasDeckId);
    // F-72：把 style.json 里的提示词本体带回前端（定义页展示 + 出图复用）。
    let definition = null;
    try {
      definition = readStyleDefinition(adapter?.sourceRoot ?? "", design.abbr, design);
    } catch {
      definition = null;
    }
    return {
      ...design,
      canvasTitle: deckEntry?.label ?? design.canvasDeckId,
      samples: styleSamples,
      description: design.description || styleDescription || "",
      styleBrief: definition?.styleBrief || design.styleBrief || "",
      styleDir: definition?.dir ?? "",
      boundSessionId: binding?.sessionId ?? null,
    };
  }

  /** Designs 页的风格项目列表（F-43）；带「哪些 deck 在用这个风格」（F-51）。 */
  function designProjects() {
    const associations = designRegistry.listDeckDesigns();
    return designRegistry.listDesigns().map((design) => ({
      ...designProjectView(design),
      decks: Object.entries(associations)
        .filter(([, value]) => value?.designId === design.designId)
        .map(([deckId]) => ({ deckId, label: config.decks.find((deck) => deck.id === deckId)?.label ?? deckId })),
    }));
  }

  /**
   * Designs 页「＋ 添加风格」：建 design 记录 + 0 页空白 deck 画布 + 风格目录骨架。
   * 会话由客户端建好后调 session-bind 绑定；这里只负责实体。
   */
  function createDesign(payload = {}) {
    const name = String(payload.name ?? "").trim();
    if (!name) throw new Error("风格名称不能为空");
    const description = String(payload.description ?? "").trim();
    if (!description) throw new Error("先描述画面（风格提示词不能为空）");
    const abbr = normalizeAbbr(payload.abbr);
    if (designRegistry.findDesignByAbbr(abbr)) throw new Error(`缩写 ${abbr} 已被其他风格占用`);
    const constraints = String(payload.constraints ?? "").trim();
    const reference = String(payload.reference ?? "").trim();
    const now = new Date();
    const pad = (n) => String(n).padStart(2, "0");
    const designId = `design-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}-${Math.random().toString(36).slice(2, 6)}`;

    // 空白画布：0 页 deck（不出现在「正式 deck」心智里，Decks 里标「风格画布」）。
    const canvas = createDeck({
      title: `${name} · 风格画布`,
      blank: true,
      intent: description,
      style: { abbr, description },
      kind: "design-canvas",
      designId,
    });

    const adapter = adapterOf(canvas.deckId);
    // F-72：styleBrief（精确画面提示词）之前被丢掉，导致出样张时无提示词可复用。
    // 用户没单独填时，弹窗里的画面描述本身就是提示词本体。
    const styleBrief = String(payload.styleBrief ?? "").trim() || description;
    const written = writeStyleDefinition(adapter?.sourceRoot ?? canvas.sourceRoot, {
      abbr, name, description, constraints, reference, styleBrief, designId,
    });

    const design = { designId, name, abbr, description, constraints, reference, styleBrief: written.definition.styleBrief, canvasDeckId: canvas.deckId, createdAt: now.toISOString() };
    designRegistry.upsertDesign(design);
    store.recordEvent({
      type: "design.created",
      deckId: canvas.deckId,
      actor: "user",
      status: "succeeded",
      payload: { designId, abbr, name, canvasDeckId: canvas.deckId },
    });
    return { design: designProjectView(design), deckId: canvas.deckId };
  }

  /** 预设风格包里某个缩写的 styleBrief（老 design 迁移用；没有就 null）。 */
  function readSeedStyleBrief(abbr) {
    const file = join(SEED_STYLES_DIR, `${String(abbr ?? "").toUpperCase()}.json`);
    if (!existsSync(file)) return "";
    try {
      const seed = JSON.parse(readFileSync(file, "utf8"));
      return String(seed?.styleBrief ?? "").trim();
    } catch {
      return "";
    }
  }

  /**
   * F-72：读一个 design 的完整风格定义 + 已有样张的 prompt 记录。
   * agent 在「再补两张样张」前先调它，避免重造风格提示词。
   */
  function designStyle(designId) {
    const key = String(designId ?? "").trim();
    const design = designRegistry.findDesign(key) ?? designRegistry.findDesignByAbbr(key);
    if (!design) throw new Error(`未知 design：${key || "（空）"}`);
    const adapter = adapterOf(design.canvasDeckId);
    const definition = readStyleDefinition(adapter?.sourceRoot ?? "", design.abbr, design);
    const samples = readSampleRecords(definition.dir).map((record) => ({
      revision: record.revision ?? "",
      brief: record.brief ?? "",
      prompt: record.prompt ?? "",
      model: record.model ?? "",
      size: record.size ?? "",
      imagePath: record.imagePath ?? "",
      createdAt: record.createdAt ?? "",
    }));
    return {
      designId: design.designId,
      canvasDeckId: design.canvasDeckId,
      abbr: definition.abbr || design.abbr,
      name: definition.name || design.name,
      description: definition.description || design.description || "",
      constraints: definition.constraints || design.constraints || "",
      reference: definition.reference || design.reference || "",
      styleBrief: definition.styleBrief || design.styleBrief || "",
      styleDir: definition.dir,
      styleJsonPath: definition.jsonPath,
      styleMdPath: definition.mdPath,
      samples,
    };
  }

  /**
   * F-72：更新风格定义（只写画布 deck 的 designs/<ABBR>/，不动客户源 deck）。
   * 样张出图会自动带上新的 styleBrief，不需要重新建 design。
   */
  function updateDesignStyle(payload = {}) {
    const key = String(payload.designId ?? "").trim();
    const design = designRegistry.findDesign(key) ?? designRegistry.findDesignByAbbr(key);
    if (!design) throw new Error(`未知 design：${key || "（空）"}`);
    const adapter = adapterOf(design.canvasDeckId);
    if (!adapter?.sourceRoot) throw new Error(`design ${design.abbr} 的画布 deck 不在源目录，无法写风格定义`);
    const pick = (value, fallback) => (typeof value === "string" ? value.trim() : fallback);
    const next = {
      abbr: design.abbr,
      name: pick(payload.name, design.name),
      description: pick(payload.description, design.description),
      constraints: pick(payload.constraints, design.constraints),
      reference: pick(payload.reference, design.reference),
      styleBrief: pick(payload.styleBrief, design.styleBrief),
      designId: design.designId,
    };
    const written = writeStyleDefinition(adapter.sourceRoot, next);
    designRegistry.upsertDesign({
      ...design,
      name: written.definition.name,
      description: written.definition.description,
      constraints: written.definition.constraints,
      reference: written.definition.reference,
      styleBrief: written.definition.styleBrief,
    });
    store.recordEvent({
      type: "design.style-updated",
      deckId: design.canvasDeckId,
      actor: "tool",
      status: "succeeded",
      payload: { designId: design.designId, abbr: design.abbr, fields: ["name", "description", "constraints", "reference", "styleBrief"].filter((field) => typeof payload[field] === "string") },
    });
    return { designId: design.designId, abbr: design.abbr, styleDir: written.dir, style: written.definition };
  }

  /**
   * F-72：老 design 迁移——style.json 里没有 styleBrief 时，从预设风格包补上。
   * 幂等：已有 styleBrief 的不覆盖（用户改过的保持）。
   */
  function backfillStyleBriefs() {
    const updated = [];
    for (const design of designRegistry.listDesigns()) {
      try {
        const adapter = adapterOf(design.canvasDeckId);
        if (!adapter?.sourceRoot) continue;
        const definition = readStyleDefinition(adapter.sourceRoot, design.abbr, design);
        if (definition.styleBrief) continue;
        const seedBrief = readSeedStyleBrief(design.abbr);
        if (!seedBrief) continue;
        const written = writeStyleDefinition(adapter.sourceRoot, {
          abbr: design.abbr,
          name: design.name,
          description: design.description,
          constraints: design.constraints,
          reference: design.reference,
          styleBrief: seedBrief,
          designId: design.designId,
        });
        designRegistry.upsertDesign({ ...design, styleBrief: written.definition.styleBrief });
        updated.push(design.abbr);
      } catch (error) {
        logger?.warn?.(`${name}: backfill styleBrief(${design.abbr}) 失败：${error?.message ?? error}`);
      }
    }
    return { updated };
  }

  /**
   * 删除一个 design（F-51）：登记表 + 0 页空白画布 + 画布数据目录 + 会话绑定 + deck 关联。
   * 源 deck 里的风格目录 / 样张不动（那些是源资产，只在画布里扫描引用）。
   */
  function deleteDesign(payload = {}) {
    const designId = String(payload.designId ?? "").trim();
    const design = designRegistry.findDesign(designId);
    if (!design) throw new Error(`未知 design：${designId}`);
    const canvasDeckId = design.canvasDeckId;
    // 1) 摘掉画布 deck 注册（只处理 design-canvas）
    const canvasEntry = config.decks.find((deck) => deck.id === canvasDeckId) ?? null;
    if (canvasEntry?.kind === "design-canvas") {
      config.decks = config.decks.filter((deck) => deck.id !== canvasDeckId);
      const index = adapters.findIndex((item) => item.id === canvasDeckId);
      if (index >= 0) adapters.splice(index, 1);
      const entries = readLocalDeckEntries().filter((entry) => entry?.id !== canvasDeckId);
      writeFileSync(decksRegistryFile, `${JSON.stringify({ decks: entries }, null, 2)}\n`, "utf8");
      // 2) 删画布数据目录（内部目录，只在数据目录下）
      try {
        const deckDir = workspace.deckDir(canvasDeckId);
        if (deckDir) rmSync(deckDir, { recursive: true, force: true });
      } catch (error) {
        logger?.warn?.(`${name}: 删画布目录失败 ${canvasDeckId}：${error?.message ?? error}`);
      }
      removeLocalDir(join(config.dataRoot, "projects", canvasDeckId));
    }
    // 3) 解绑这个 design 的会话；清掉 deck → design 关联
    const unboundSessions = designRegistry.removeBindingsFor("design", designId);
    for (const [deckId, value] of Object.entries(designRegistry.listDeckDesigns())) {
      if (value?.designId === designId) designRegistry.setDeckDesign(deckId, null);
    }
    // 4) 摘登记表
    designRegistry.removeDesign(designId);
    store.recordEvent({
      type: "design.deleted",
      deckId: null,
      actor: "user",
      status: "succeeded",
      payload: { designId, abbr: design.abbr, name: design.name, canvasDeckId, unboundSessions },
    });
    return { designId, canvasDeckId, unboundSessions };
  }

  /**
   * 登记「这个 deck 用哪个 design」（F-51）。designId 传空 = 解除关联。
   * 只写插件侧关联表，不动源 deck 的任何文件。
   */
  function setDeckDesign(payload = {}) {
    const deckId = String(payload.deckId ?? "").trim();
    if (!adapterOf(deckId)) throw new Error(`未知 deck：${deckId}`);
    const rawDesignId = payload.designId;
    const designId = rawDesignId === null || rawDesignId === undefined || rawDesignId === "" ? "" : String(rawDesignId).trim();
    const previous = designRegistry.deckDesignFor(deckId)?.designId ?? null;
    if (designId && !designRegistry.findDesign(designId)) throw new Error(`未知 design：${designId}`);
    designRegistry.setDeckDesign(deckId, designId || null);
    store.recordEvent({
      type: designId ? "deck.design.set" : "deck.design.clear",
      deckId,
      actor: "user",
      status: "succeeded",
      payload: { designId: designId || null, previous },
    });
    const design = designId ? designRegistry.findDesign(designId) : null;
    return { deckId, previous, design: design ? designProjectView(design) : null };
  }

  /**
   * 删除一个本机新建的 deck（F-51）：工作副本 + 本机源目录 + 注册表 + 会话绑定 + 风格关联。
   * 受控源 deck 只能从 profile 配置移除，这里明确拒绝。
   */
  function deleteDeck(payload = {}) {
    const deckId = String(payload.deckId ?? "").trim();
    const entry = readLocalDeckEntries().find((item) => item?.id === deckId) ?? null;
    if (!entry) throw new Error("只能删除本机新建的 deck；受控源 deck 请在 profile 的 decks 里移除");
    if ((entry.kind ?? "deck") === "design-canvas") throw new Error("风格画布请到 Designs 页删除对应风格");
    const adapter = adapterOf(deckId);
    const sourceRoot = String(adapter?.sourceRoot ?? entry.sourceRoot ?? "");
    const unboundSessions = designRegistry.removeBindingsFor("deck", deckId);
    designRegistry.setDeckDesign(deckId, null);
    try {
      const deckDir = workspace.deckDir(deckId);
      if (deckDir) rmSync(deckDir, { recursive: true, force: true });
    } catch (error) {
      logger?.warn?.(`${name}: 删 deck 工作副本失败 ${deckId}：${error?.message ?? error}`);
    }
    const removedSource = removeLocalDir(sourceRoot);
    config.decks = config.decks.filter((deck) => deck.id !== deckId);
    const index = adapters.findIndex((item) => item.id === deckId);
    if (index >= 0) adapters.splice(index, 1);
    const entries = readLocalDeckEntries().filter((item) => item?.id !== deckId);
    writeFileSync(decksRegistryFile, `${JSON.stringify({ decks: entries }, null, 2)}\n`, "utf8");
    store.recordEvent({
      type: "deck.deleted",
      deckId: null,
      actor: "user",
      status: "succeeded",
      payload: { deckId, label: entry.label ?? deckId, sourceRoot: removedSource || sourceRoot, unboundSessions },
    });
    return { deckId, removedSource, unboundSessions };
  }

  /** 会话 ↔ deck|design 绑定（F-43：每个会话必须有绑定）。 */
  function listBindings() {
    return designRegistry.listBindings();
  }

  function bindSession(payload = {}) {
    const sessionId = String(payload.sessionId ?? "").trim();
    if (!sessionId) throw new Error("sessionId 不能为空");
    const kind = payload.kind;
    const id = String(payload.id ?? "").trim();
    if (!id) throw new Error("绑定的 deck/design 不能为空");
    if (kind === "deck") {
      if (!adapterOf(id)) throw new Error(`未知 deck：${id}`);
    } else if (kind === "design") {
      if (!designRegistry.findDesign(id)) throw new Error(`未知 design：${id}`);
    } else {
      throw new Error("kind 只能是 deck / design");
    }
    const binding = designRegistry.upsertBinding({ sessionId, kind, id, title: payload.title });
    store.recordEvent({
      type: "session.bound",
      deckId: kind === "deck" ? id : null,
      actor: "user",
      status: "succeeded",
      payload: { sessionId, kind, id, title: binding.title },
    });
    return binding;
  }

  function unbindSession(sessionId) {
    return designRegistry.removeBinding(String(sessionId ?? ""));
  }

  /** 出图运行时：按当前选择解析节点 → renderer + key（key 只在内存里）。 */
  function renderRuntime(deckId) {
    // F-148：profile 根挂载（设置页）和 preset 子树（deck 工具）是两个 service 实例，
    // 在设置页保存节点只更新根实例；工具挂载这边每次出图前来读一次本机设置文件，
    // 否则「面板里换了节点，Agent 出图仍走旧节点」。
    const stored = readRenderSettings(config.dataRoot);
    if (stored.values) applyRenderSettings(config, stored);
    const resolved = resolveSelection(config.render, currentRenderSelection(deckId));
    if (!resolved) throw new Error("没有可用的出图节点/模型：检查 profile 的 render.nodes / render.default");
    const picked = selectRenderer({
      ...config.render,
      endpoint: resolved.endpoint,
      apiKeyEnv: resolved.apiKeyEnv,
      apiKeyFile: resolved.apiKeyFile,
    }, env);
    return {
      renderer: picked.renderer,
      // F-146：设置页里直接保存的 key 优先；没有才回退 env / key 文件
      apiKey: resolved.apiKey || picked.apiKey,
      model: resolved.model,
      endpoint: resolved.endpoint,
      editEndpoint: resolved.editEndpoint || editEndpointFor(resolved.endpoint),
      editTransport: resolved.editTransport || "multipart",
      nodeId: resolved.nodeId,
      nodeName: resolved.nodeName,
      label: resolved.label,
      mode: config.render.mode,
      timeoutMs: config.render.timeoutMs,
    };
  }

  /** 某 deck 最近事件（修改日志用：渲染/导出/交接/QA/说明）。 */
  function deckEvents(deckId, limit = 500) {
    // 事件日志只存 payloadRef；文档（尤其修改日志的「为什么」）要读回 payload。
    // F-78：以前只看最后 200 条事件，日志一长（评估/预设批量出图）就会把 deck.created
    // 挤出去，新 deck 的「修改日志」明明有初始化事件却显示为空。现在按 deck 过滤后取最近 N 条。
    return store
      .events(0)
      .filter((event) => event.deckId === deckId)
      .slice(-limit)
      .map((event) => ({ ...event, payload: store.eventPayload(event.eventId)?.payload ?? null }));
  }

  /** script revision 列表（修改日志用：revisions/vNNN.md + 同名 note）。 */
  function deckRevisions(deckId) {
    let dir;
    try {
      dir = join(workspace.deckDir(deckId), "script", "revisions");
    } catch {
      return [];
    }
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

  /** 9 份必备 deck 文档的治理状态（不含大段正文）。 */
  function deckDocs(deckId) {
    let deckDir;
    try {
      deckDir = workspace.deckDir(deckId);
    } catch {
      return { docs: [], governance: { deckId, score: 0, counts: {}, total: 0, missing: [], partial: [] } };
    }
    return resolveDeckDocs({ adapter: adapterOf(deckId), deckDir, render: config.render, revisions: deckRevisions(deckId), events: deckEvents(deckId) });
  }

  /** 单份文档（中间区标签用）：正文 + 结构化视图。 */
  function deckDoc(deckId, docId) {
    let deckDir;
    try {
      deckDir = workspace.deckDir(deckId);
    } catch {
      return null;
    }
    return readDeckDoc({ adapter: adapterOf(deckId), deckDir, docId, render: config.render, revisions: deckRevisions(deckId), events: deckEvents(deckId) });
  }

  /** 给缺失文档打骨架（只写 .deck 工作副本，不动源 deck）。 */
  function deckDocsScaffold(deckId, docIds) {
    const adapter = adapterOf(deckId);
    if (!adapter) throw new Error(`unknown deck: ${deckId}`);
    return scaffoldDeckDocs({ adapter, deckDir: workspace.deckDir(deckId), docIds });
  }

  /** 一页的可编辑视图（页面微调弹窗预填）。 */
  function pageForEdit(deckId, pageId) {
    const adapter = adapterOf(deckId);
    if (!adapter?.available()) return null;
    return pageEditView(adapter, pageId);
  }

  /**
   * 页面微调保存：写回源 script.md / prompts/Pnn.txt，重建 manifest，并自动 git 提交。
   * 这是唯一允许直接写源 deck 的动作（ADR-0006 的例外，见 ADR-0008）。
   */
  function savePage(deckId, pageId, patch) {
    const adapter = adapterOf(deckId);
    if (!adapter?.available()) throw new Error(`deck 不可用：${deckId}`);
    const page = Number(String(pageId).replace(/^p/i, ""));
    const result = savePageEdit({
      sourceRoot: adapter.sourceRoot,
      page,
      title: patch?.title ?? "",
      subtitle: patch?.subtitle ?? "",
      body: patch?.body ?? "",
      prompt: typeof patch?.prompt === "string" ? patch.prompt : undefined,
    });
    const deck = workspace.ensureDeck(adapter, { styleBrief: config.styleBrief, forceRebuild: true });
    const message = `deck(${deckId})：微调 P${String(page).padStart(2, "0")}${patch?.title ? `「${String(patch.title).slice(0, 30)}」` : ""}`;
    const git = commitFiles({ dir: adapter.sourceRoot, files: result.files, message });
    store.recordEvent({
      type: "deck.script.save",
      deckId,
      slideIds: [result.pageId],
      actor: "user",
      status: git.ok ? "succeeded" : "saved",
      payload: { page: result.page, files: result.files, commit: git.commit ?? null, gitError: git.error ?? null },
    });
    return {
      deckId,
      page: result.page,
      pageId: result.pageId,
      files: result.files.map((file) => file.replace(`${adapter.sourceRoot}/`, "")),
      commit: git.commit ?? null,
      gitOk: git.ok,
      gitError: git.error ?? null,
      deckTitle: deck?.title ?? null,
    };
  }

  /** 导出整份 deck：每页一张整页图 → PDF / PPTX。 */
  /** F-141：首页「使用手册」读取 docs/manual(.en).md（只读仓库公开文档）。 */
  function readManual(lang = "zh") {
    const file = join(REPO_ROOT, "docs", lang === "en" ? "manual.en.md" : "manual.md");
    const primary = existsSync(file) ? file : join(REPO_ROOT, "docs", "manual.md");
    if (!existsSync(primary)) throw new Error("本机没有找到使用手册（docs/manual.md）；公开包里带 docs/ 目录时才有。");
    return { markdown: readFileSync(primary, "utf8"), path: relative(REPO_ROOT, primary) };
  }

  /** F-150：手册里链到的公开文档（install / styles / sample-deck / compat / productization）也在应用内读。 */
  function readDoc(docPath = "manual.md") {
    const name = String(docPath ?? "").trim().replace(/^docs\//, "");
    if (!/^(manual|install|styles|sample-deck|compat|productization)(\.en)?\.md$/.test(name)) {
      throw new Error(`不支持的文档：${name || "(空)"}`);
    }
    const file = join(REPO_ROOT, "docs", name);
    if (!existsSync(file)) throw new Error(`本机没有找到文档：docs/${name}`);
    return { markdown: readFileSync(file, "utf8"), path: `docs/${name}` };
  }

  /**
   * F-141：手册里的截图（docs/assets/screenshots/**）。
   * 只允许 png/jpg/webp/svg，路径必须落在 screenshots 目录内——不给任意文件读取留口子。
   */
  function docsAsset(assetPath) {
    const raw = String(assetPath ?? "").replace(/^\/+/, "");
    if (!/^[A-Za-z0-9._/-]+\.(png|jpg|jpeg|webp|svg)$/i.test(raw)) return null;
    const base = join(REPO_ROOT, "docs", "assets", "screenshots");
    const full = resolve(base, raw);
    if (!full.startsWith(resolve(base) + sep)) return null;
    if (!existsSync(full) || !statSync(full).isFile()) return null;
    return { file: full, mime: ASSET_MIME[extname(full).toLowerCase()] ?? "application/octet-stream" };
  }

  function exportDeckFile(deckId, format) {
    const deck = workspace.ensureDeck(adapterOf(deckId) ?? { id: deckId, sourceRoot: "", readScriptRaw: () => null }, { styleBrief: config.styleBrief });
    const slides = (deck?.slides ?? [])
      .map((slide) => {
        const render = slideRenderInfo(deckId, slide.id);
        if (!render) return null;
        const file = assetFile(deckId, slide.id, render.revision);
        return file ? { pageId: slide.id, file } : null;
      })
      .filter(Boolean);
    const missing = (deck?.slides ?? []).filter((slide) => !slideRenderInfo(deckId, slide.id)).map((slide) => slide.id);
    // F-137：缺图不再整包拒绝——先导出已出图的页，缺页清单一起返回，用户可以先拿到能看的一版。
    if (!slides.length) throw new Error(`一页都还没有图（共 ${(deck?.slides ?? []).length} 页），先出图再导出`);
    const result = exportDeck({ format, slides });
    store.recordEvent({ type: "deck.export", deckId, actor: "user", status: "succeeded", payload: { format, pages: slides.length, total: (deck?.slides ?? []).length, missing, bytes: result.buffer.length } });
    const safeTitle = String(deck?.title ?? deckId).replace(/[\\/:*?"<>|]/g, "-").slice(0, 60);
    return { ...result, filename: `${safeTitle}.${result.ext}`, pages: slides.length, total: (deck?.slides ?? []).length, missing };
  }

  /**
   * 交接包（handoff）：把接手人需要的全部内容打成一个 zip。
   * 含 manifest、当前 script、9 份文档、每页 prompt/qa/最终图、出图选择、最近事件、README。
   * 只读工作副本，不改任何文件。
   */
  function exportHandoff(deckId) {
    const adapter = adapterOf(deckId);
    if (!adapter) throw new Error(`未知 deck：${deckId}`);
    const deck = workspace.ensureDeck(adapter, { styleBrief: config.styleBrief });
    let dir;
    try {
      dir = workspace.deckDir(deckId);
    } catch {
      throw new Error(`未知 deck：${deckId}`);
    }
    const entries = [];
    const seen = new Set();
    const push = (name, data, { store = false } = {}) => {
      if (seen.has(name)) return;
      seen.add(name);
      entries.push({ name, data, store });
    };
    const IMAGE_EXT = new Set([".png", ".jpg", ".jpeg", ".webp", ".svg"]);
    const walk = (base, prefix, depth = 0) => {
      if (!existsSync(base) || depth > 6) return;
      for (const entry of readdirSync(base, { withFileTypes: true })) {
        const full = join(base, entry.name);
        if (entry.isDirectory()) {
          walk(full, `${prefix}${entry.name}/`, depth + 1);
          continue;
        }
        if (!entry.isFile()) continue;
        const rel = `${prefix}${entry.name}`;
        const ext = extname(entry.name).toLowerCase();
        push(rel, readFileSync(full), { store: IMAGE_EXT.has(ext) });
      }
    };
    if (existsSync(join(dir, "deck.json"))) push("deck.json", readFileSync(join(dir, "deck.json")));
    walk(join(dir, "script"), "script/");
    walk(join(dir, "prompts"), "prompts/");
    walk(join(dir, "docs"), "docs/");
    walk(join(dir, "slides"), "slides/");
    // 每页最终图压成 JPEG 放进 images/（源出图的页也带，接手人不用回源目录找）
    const tmpDir = join(config.dataRoot, "tmp", `handoff-${deckId}`);
    mkdirSync(tmpDir, { recursive: true });
    let imageCount = 0;
    for (const slide of deck?.slides ?? []) {
      const pageId = slide.id;
      const render = slideRenderInfo(deckId, pageId);
      const localFile = render ? assetFile(deckId, pageId, render.revision) : null;
      const sourceFile = adapterOf(deckId)?.sourceImages?.()?.[pageId]?.path ?? null;
      const file = localFile ?? sourceFile;
      if (!file) continue;
      const ext = extname(file).toLowerCase();
      try {
        if (ext === ".png" || ext === ".jpg" || ext === ".jpeg") {
          push(`images/${pageId}.jpg`, toJpeg(file, tmpDir), { store: true });
          imageCount += 1;
        } else {
          push(`images/${pageId}${ext}`, readFileSync(file), { store: true });
          imageCount += 1;
        }
      } catch {
        // sips 不可用 / 图读不到：跳过这一页的图，其余内容照常导出
      }
    }
    if (existsSync(join(dir, "render-selection.json"))) push("render-selection.json", readFileSync(join(dir, "render-selection.json")));
    // 源里的风格规范 / 反馈 / 研究台账也带上（如果存在）
    const sourceRoot = adapter.sourceRoot ?? "";
    for (const name of ["style-reference.md", "feedback.md", "external-case-research.md", "CURRENT.md"]) {
      const file = join(sourceRoot, name);
      if (existsSync(file)) push(`source/${name}`, readFileSync(file));
    }
    const events = store.events(500).filter((event) => event.deckId === deckId).slice(-200);
    push("events.json", `${JSON.stringify({ deckId, exportedAt: new Date().toISOString(), events }, null, 2)}\n`);
    const pageCount = deck?.slides?.length ?? 0;
    push(
      "README.md",
      [
        `# 交接包：${deck?.title ?? deckId}`,
        "",
        `- deckId：${deckId}`,
        `- 导出时间：${new Date().toISOString()}`,
        `- 页数：${pageCount}；已出图：${imageCount}`,
        "",
        "## 目录",
        "",
        "- `deck.json`：页序与每页内容（标题/副标题/正文/提示词）manifest",
        "- `script/current.md`：当前脚本（唯一事实来源）",
        "- `docs/`：9 份治理文档（意图/脚本/设计/修改日志/反馈/调研/支撑材料/审稿/事实核对）",
        "- `prompts/Pnn.txt`：每页出图提示词",
        "- `images/Pnn.jpg`：每页最终图（JPEG，含源出图页，接手人可直接看）",
        "- `slides/<page>/versions/<rev>/`：工作副本里的图 + prompt + qa（如果有本地重出）",
        "- `render-selection.json`：导出时生效的出图节点/模型",
        "- `events.json`：该 deck 最近 200 条任务/事件轨迹",
        "- `source/`：源里的风格规范、反馈、研究台账（只读快照）",
        "",
        "## 接手怎么继续",
        "",
        "1. 读 `docs/intent.md` 确认目标与顺序（叙事主线写在 intent 里）；",
        "2. 改 `script/current.md`（不要只改图）；",
        "3. 出图用当前节点/模型（`render-selection.json`），单页重出、保留旧版本；",
        "4. 反馈先登记到 `docs/feedback.md` 再动手。",
        "",
      ].join("\n"),
    );
    const buffer = zip(entries);
    const safeTitle = String(deck?.title ?? deckId).replace(/[\\/:*?"<>|]/g, "-").slice(0, 60);
    const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, "");
    store.recordEvent({ type: "deck.handoff", deckId, actor: "user", status: "succeeded", payload: { files: entries.length, bytes: buffer.length, pages: pageCount } });
    return { buffer, mime: "application/zip", filename: `${safeTitle}-handoff-${stamp}.zip`, files: entries.length, pages: pageCount };
  }

  /** 首页目录：风格（designs/<ABBR>/）与资源库（resources/ + assets/）。 */
  function homeCatalog(deckId) {
    const adapter = adapterOf(deckId);
    let deckDir = "";
    try {
      deckDir = workspace.deckDir(deckId);
    } catch {
      deckDir = "";
    }
    const sourceRoot = adapter?.sourceRoot ?? "";
    return {
      deckId,
      designStyles: scanDesignStyles({ deckId, sourceRoot, deckDir }),
      // F-134：共享资源库放 <dataRoot>/resources，任何 deck 的「资源库」都能看到
      resources: scanResources({ deckId, sourceRoot, deckDir, sharedRoot: config.dataRoot }),
    };
  }

  /** media 路由解析：只放行白名单目录的图片。 */
  function mediaFile(deckId, scope, path) {
    const adapter = adapterOf(deckId);
    let deckDir = "";
    try {
      deckDir = workspace.deckDir(deckId);
    } catch {
      deckDir = "";
    }
    return resolveMediaFile({ deckId, scope, path, sourceRoot: adapter?.sourceRoot ?? "", deckDir, sharedRoot: config.dataRoot });
  }

  /** 设计样张：源里的风格样图（samples / probe / assets / styles）。 */
  function designSamples(deckId) {
    const adapter = adapterOf(deckId);
    if (!adapter) return [];
    const out = [];
    const dirs = ["samples", "probe", "assets", "styles", "style-samples"];
    for (const dir of dirs) {
      const full = join(adapter.sourceRoot, dir);
      if (!existsSync(full)) continue;
      for (const name of readdirSync(full)) {
        if (!/\.(png|jpg|jpeg|webp)$/i.test(name)) continue;
        const file = join(full, name);
        if (!statSync(file).isFile()) continue; // 同名目录（如 probe/cover-v4-*/）跳过
        out.push({
          name: `${dir}/${name}`,
          dir,
          sizeBytes: statSync(file).size,
          url: `${ROUTES.sourcefile}?deckId=${encodeURIComponent(deckId)}&name=${encodeURIComponent(`${dir}/${name}`)}`,
        });
      }
    }
    return out;
  }

  /** 源里的图片文件（设计样张预览用）：只允许 图片扩展名 + 白名单目录。 */
  function sourceFile(deckId, name) {
    const adapter = adapterOf(deckId);
    if (!adapter || !name || name.includes("..")) return null;
    const allowed = /^(samples|probe|assets|styles|style-samples)\/[\w.\-\u4e00-\u9fa5/]+$/;
    if (!allowed.test(name) || !/\.(png|jpg|jpeg|webp)$/i.test(name)) return null;
    const file = join(adapter.sourceRoot, name);
    return existsSync(file) && statSync(file).isFile() ? { file, name, sizeBytes: statSync(file).size } : null;
  }

  /** 工作副本里的文档文件（草案 / 调研原文），只允许 docs/ 与 research/files/。 */
  function deckDocFile(deckId, docId, name) {
    let deckDir;
    try {
      deckDir = workspace.deckDir(deckId);
    } catch {
      return null;
    }
    return resolveDocFile({ deckDir, docId, name });
  }

  /** status 载荷：面板横幅 + 健康检查。源缺失也 200（把“哪儿不对”说清楚）。 */
  async function status() {
    const decks = [];
    for (const adapter of adapters) {
      const manifest = workspace.manifest(adapter.id);
      const view = adapter.available() ? adapter.overview() : null;
      decks.push({
        deckId: adapter.id,
        label: adapter.label,
        sourceRoot: adapter.sourceRoot,
        sourceAvailable: Boolean(view),
        title: manifest?.title ?? view?.title ?? adapter.label,
        pageCount: manifest?.slides?.length ?? view?.pageCount ?? 0,
        status: manifest?.status ?? view?.status ?? "",
        warnings: [...(view?.warnings ?? []), ...(manifest?.buildWarnings ?? [])],
        ...deckKind(adapter.id),
      });
    }
    for (const deckId of workspace.listDeckIds()) {
      if (decks.some((deck) => deck.deckId === deckId)) continue;
      const manifest = workspace.manifest(deckId);
      decks.push({ deckId, label: manifest?.title ?? deckId, sourceRoot: manifest?.source?.root ?? "", sourceAvailable: Boolean(manifest?.source?.root), title: manifest?.title ?? deckId, pageCount: manifest?.slides?.length ?? 0, status: manifest?.status ?? "", warnings: [] });
    }
    const tasks = store.taskList(200);
    const counts = {};
    for (const task of tasks) counts[task.status] = (counts[task.status] ?? 0) + 1;
    const pending = adapters.length
      ? adapters.flatMap((adapter) => workspace.listProposals(adapter.id, "waiting-user"))
      : workspace.listDeckIds().flatMap((deckId) => workspace.listProposals(deckId, "waiting-user"));
    // F-108：标记「已过期」提案——工作副本里已经找不到它的 before 行（被后续 revision 改过）。
    // 以前要等用户点了确认才报「部分失败」；现在 UI 可以直接标出来、禁用确认、给清理入口。
    const scriptTextCache = new Map();
    const scriptTextOf = (deckId) => {
      if (!scriptTextCache.has(deckId)) {
        let text = "";
        try {
          text = String(workspace.scriptCurrent(deckId) ?? "");
        } catch {
          text = "";
        }
        scriptTextCache.set(deckId, text);
      }
      return scriptTextCache.get(deckId);
    };
    // 过期判断要按「这一页」找 before 行：新 deck 每页都有同样的
    // `**标题**：待定` 占位，用整份 script 判断会永远「不过期」。
    const pageTextOf = (deckId, page) => {
      const text = scriptTextOf(deckId);
      const pageNo = Number(page);
      if (!Number.isFinite(pageNo) || pageNo <= 0) return text;
      const lines = text.split("\n");
      const range = scriptSectionRange(text, pageNo);
      if (!range) return text; // 表格惯例没有 `### Pxx` 分节，退回整份文本
      return lines.slice(range.start, range.end).join("\n");
    };
    const isStaleProposal = (proposal) =>
      proposal.kind === "script"
      && typeof proposal.before === "string"
      && proposal.before.length > 0
      && !pageTextOf(proposal.deckId, proposal.page).includes(proposal.before);
    return {
      ok: true,
      plugin: name,
      version: pluginVersion(),
      uiVersion: uiVersion(),
      displayName: config.displayName,
      hideShellSidebar: config.hideShellSidebar === true,
      workspacePath: config.workspacePath,
      dataRoot: config.dataRoot,
      toolsMounted: config.tools,
      renderMode: config.render.mode,
      renderModel: config.render.model,
      decks,
      taskCounts: counts,
      pendingProposals: pending.map((proposal) => ({
        proposalId: proposal.proposalId,
        deckId: proposal.deckId,
        pageId: proposal.pageId,
        // F-108：脚本页要按页号把待确认提案挂到对应页卡片上。
        page: Number.isFinite(Number(proposal.page)) ? Number(proposal.page) : null,
        kind: proposal.kind ?? "",
        field: proposal.field,
        reason: proposal.reason,
        // F-90：带上提案正文（截断），供评估判定产物质量 + 前端预览；不是写入，只是展示。
        after: typeof proposal.after === "string" ? proposal.after.slice(0, 4000) : "",
        // F-108：Context 时间线要能直接看 diff，而不是只有「待确认」四个字。
        diff: typeof proposal.diff === "string" ? proposal.diff.slice(0, 4000) : "",
        // F-108 修订：脚本页要显示「当前值 → 建议值」，否则卡片上的标题/副标题和提案行
        // 看起来是「两套」内容，用户分不清哪个是现在的、哪个是待确认的。
        before: typeof proposal.before === "string" ? proposal.before.slice(0, 4000) : "",
        // 已过期：工作副本变了，这条提案的 before 行不存在，确认会「工作副本已漂移」。
        stale: isStaleProposal(proposal),
        createdAt: proposal.createdAt,
      })),
      generatedAt: new Date().toISOString(),
    };
  }

  /** state 载荷：面板全量（tasks + events + proposals）。 */
  async function state() {
    const base = await status();
    const events = store.events(60).slice().reverse();
    const eventDetails = events.map((event) => ({ ...event, payload: store.eventPayload(event.eventId)?.payload ?? null }));
    return { ...base, tasks: store.taskList(50), events: eventDetails };
  }

  /**
   * 某页最新已渲染图片（image deck 的 ppt 本体）。
   * 布局：`.deck/decks/<deckId>/slides/<pageId>/versions/vNNN/image.png`。
   * 只返回**已存在**的版本；未出图返回 null（前端显示占位 + 出图入口）。
   */
  function slideRenderInfo(deckId, pageId) {
    // 1) .deck 里已渲染的版本优先（vNNN）
    const versionsDir = join(workspace.slideDir(deckId, pageId), "versions");
    if (existsSync(versionsDir)) {
      const revisions = readdirSync(versionsDir).filter((name) => /^v\d+$/.test(name)).sort().reverse();
      for (const revision of revisions) {
        for (const ext of ASSET_EXTS) {
          const file = join(versionsDir, revision, `image${ext}`);
          if (!existsSync(file)) continue;
          return {
            revision,
            ext,
            url: `${ROUTES.asset}?deckId=${encodeURIComponent(deckId)}&pageId=${encodeURIComponent(pageId)}&rev=${revision}`,
            sizeBytes: statSync(file).size,
            renderedAt: statSync(file).mtime.toISOString(),
          };
        }
      }
    }
    // 2) 源里已出好的整页图作为 baseline（只读引用，不复制、不占双份空间）
    const source = adapterOf(deckId)?.sourceImages?.()[pageId];
    if (source) {
      return {
        revision: "source",
        ext: source.ext,
        url: `${ROUTES.asset}?deckId=${encodeURIComponent(deckId)}&pageId=${encodeURIComponent(pageId)}&rev=source`,
        sizeBytes: source.sizeBytes,
        renderedAt: statSync(source.path).mtime.toISOString(),
        fromSource: true,
      };
    }
    return null;
  }

  /**
   * deck 封面预览图（F-48）：源里第一页 baseline 优先，其次 .deck 里第一张已渲染版本；
   * 风格画布（design-canvas）退回该风格的样张。只返回 URL，不复制文件、不新增落盘。
   */
  function deckCoverUrl(deckId) {
    try {
      const adapter = adapterOf(deckId);
      const sourceImages = adapter?.sourceImages?.() ?? {};
      const pageIds = Object.keys(sourceImages).sort((a, b) => a.localeCompare(b));
      for (const pageId of pageIds) {
        const info = slideRenderInfo(deckId, pageId);
        if (info?.url) return info.url;
      }
      const manifest = workspace.manifest(deckId);
      for (const slide of manifest?.slides ?? []) {
        if (!slide?.id) continue;
        const info = slideRenderInfo(deckId, slide.id);
        if (info?.url) return info.url;
      }
      const { designId } = deckKind(deckId);
      if (designId) {
        const design = designRegistry.findDesign(designId);
        if (design) {
          const project = designProjectView(design);
          if (project.samples?.[0]?.url) return project.samples[0].url;
        }
      }
    } catch (error) {
      logger?.warn?.(`${name}: deckCoverUrl(${deckId}) 失败：${error?.message ?? error}`);
    }
    return null;
  }

  /** 资产读取：只允许 versions/vNNN/image.<ext> 或源 baseline（rev=source），防目录穿越。 */
  function assetFile(deckId, pageId, revision) {
    if (revision === "source") {
      const image = adapterOf(deckId)?.sourceImages?.()[pageId];
      return image && existsSync(image.path) ? image.path : null;
    }
    if (!/^v\d+$/.test(revision ?? "")) return null;
    let dir;
    try {
      dir = join(workspace.slideDir(deckId, pageId), "versions", revision);
    } catch {
      return null;
    }
    for (const ext of ASSET_EXTS) {
      const file = join(dir, `image${ext}`);
      if (existsSync(file)) return file;
    }
    return null;
  }

  /**
   * F-88：deck 项目级规则（deck.rules.md）的只读展示载荷。
   * 内容会随 workbench 载荷下发给工作台（≤8KB，仅用于展示）；不提供页面内写入，
   * 受控源保持只读，用户自己在 deck 项目根建文件。
   */
  function projectRulesPayload(sourceRoot) {
    const rules = readDeckRules(sourceRoot);
    return {
      found: rules.found,
      path: rules.path,
      bytes: rules.bytes,
      truncated: rules.truncated,
      flags: rules.flags ?? [],
      content: rules.found ? rules.content : "",
      ...(rules.warning ? { warning: rules.warning } : {}),
    };
  }

  /**
   * workbench 载荷：工作台前端（三栏 Observation）需要的真实数据。
   * active deck 的 manifest/script 在首次访问时幂等初始化（ensureDeck 不覆盖已有文件）。
   */
  async function workbench(requestedDeckId = null) {
    const base = await state();
    const localIds = localDeckIds();
    const decks = base.decks.map((deck) => ({
      ...deck,
      // F-51：首页只列正式 deck；风格画布仍在 Designs 页（deletable 只对本机新建 deck 为 true）
      local: localIds.has(deck.deckId),
      deletable: localIds.has(deck.deckId) && (deck.kind ?? "deck") !== "design-canvas",
      design: deckDesignBrief(deck.deckId),
      // F-52：每张 deck 卡都显示自己的 9 份文档状态（不再只有当前 active deck 有点点）
      ...(() => {
        if ((deck.kind ?? "deck") === "design-canvas") return { documents: [], missing: 0, score: null };
        try {
          const { docs, governance } = deckDocs(deck.deckId);
          return {
            documents: docs.map((doc) => ({ id: doc.id, label: doc.label, status: doc.status })),
            missing: docs.filter((doc) => doc.status === "missing").length,
            score: governance?.score ?? null,
          };
        } catch (error) {
          logger?.warn?.(`${name}: deckDocs(${deck.deckId}) 失败：${error?.message ?? error}`);
          return { documents: [], missing: 0, score: null };
        }
      })(),
      // F-88：首页 deck 卡显示「规则」标记
      rules: projectRulesPayload(adapterOf(deck.deckId)?.sourceRoot ?? "").found,
      cover: deckCoverUrl(deck.deckId),
      appendixCount: adapterOf(deck.deckId)?.available() ? adapterOf(deck.deckId).overview().appendixCount ?? 0 : workspace.manifest(deck.deckId)?.appendix?.count ?? 0,
      appendixRows: workspace.manifest(deck.deckId)?.appendix?.rows ?? [],
    }));
    const activeId = (requestedDeckId && decks.some((deck) => deck.deckId === requestedDeckId) ? requestedDeckId : null) ?? decks[0]?.deckId ?? workspace.listDeckIds()[0] ?? null;
    let active = null;
    if (activeId) {
      const adapter = adapterOf(activeId);
      let deck = workspace.manifest(activeId);
      if (adapter?.available()) {
        try {
          // ensureDeck 幂等：manifest 缺失时初始化；源变了且本地还没改过时按源刷新派生字段。
          deck = workspace.ensureDeck(adapter, { styleBrief: config.styleBrief });
        } catch (error) {
          logger?.warn?.(`${name}: ensureDeck(${activeId}) 失败：${error?.message ?? error}`);
          deck = workspace.manifest(activeId);
        }
      }
      const view = adapter?.available() ? adapter.overview() : null;
      const activeKind = deckKind(activeId).kind ?? "deck";
      const canvasDesign = activeKind === "design-canvas"
        ? designRegistry.listDesigns().find((item) => item.canvasDeckId === activeId) ?? null
        : null;
      // F-67：定义页要显示「这个风格被哪些 deck 用」+「有多少个会话」，decks 由 designProjects 视图补齐
      const canvasProject = canvasDesign
        ? designProjects().find((item) => item.designId === canvasDesign.designId) ?? null
        : null;
      active = {
        deckId: activeId,
        ...deckKind(activeId),
        title: deck?.title ?? view?.title ?? activeId,
        status: deck?.status ?? view?.status ?? "draft",
        sourceRoot: adapter?.sourceRoot ?? deck?.source?.root ?? "",
        slides: (deck?.slides ?? []).map((slide) => ({
          id: slide.id,
          order: slide.order,
          type: slide.type,
          title: slide.title,
          question: slide.question,
          claim: slide.claim,
          // F-109：正文是独立字段，工作台要能读到（确认 body 提案后立刻可见）。
          body: slide.body ?? "",
          source: slide.source,
          asset: slide.asset,
          visualBrief: slide.visualBrief ?? "",
          // F-114：这条画面要求写于哪个关联风格（换风格时 UI 标「旧风格 brief」）。
          visualBriefDesign: slide.visualBriefDesign ?? null,
          render: slideRenderInfo(activeId, slide.id),
        })),
        appendix: deck?.appendix ?? { count: view?.appendixCount ?? 0, rows: view?.appendixRows ?? [] },
        // 9 份必备文档的治理状态（正文按标签懒加载 /api/deck-studio.doc）
        // F-63：design 画布没有 deck 文档，直接给空 documents，避免误导成「缺 9 份文档」
        ...(canvasDesign
          ? { documents: [], governance: null }
          : (() => {
              const { docs, governance } = deckDocs(activeId);
              return { documents: docs, governance };
            })()),
        // F-63：design 工作区只保留风格定义 + 样张（Design 标签页 / 右栏 Design Library）
        designProject: canvasProject,
        designStyle: canvasDesign ? readDesignStyleFiles(canvasDesign) : null,
        sources: sourceFiles(adapter?.sourceRoot ?? deck?.source?.root ?? ""),
        script: workspace.scriptCurrent(activeId) ?? "",
        // 当前 deck 关联的登记风格（F-51：Design 文档页「关联风格」区）
        design: (() => {
          const association = designRegistry.deckDesignFor(activeId);
          const design = association?.designId ? designRegistry.findDesign(association.designId) : null;
          return design ? designProjectView(design) : null;
        })(),
        // F-124：内容密度（新建时选，之后可在工具栏改），决定 script 正文 / 画面要求的目标字数
        contentDensity: normalizeContentDensity(deck?.contentDensity),
        contentDensityOptions: contentDensityOptions(),
        // F-88：deck 项目级规则（可选 deck.rules.md），只读展示用
        projectRules: canvasDesign ? { found: false, path: "deck.rules.md", bytes: 0, truncated: false, flags: [], content: "" } : projectRulesPayload(adapter?.sourceRoot ?? deck?.source?.root ?? ""),
        // 当前 deck 生效的出图节点/模型（下拉可换）
        renderNodes: renderState(activeId),
        // 首页/标签用：deck 列表、风格（designs/<ABBR>/ 样张）、资源库
        decks: decks.map((item) => ({ deckId: item.deckId, label: item.label, pageCount: item.pageCount, status: item.status ?? "", sourceRoot: item.sourceRoot ?? "", kind: item.kind ?? "deck" })),
        designs: designSamples(activeId),
        ...homeCatalog(activeId),
        sourceRoot: adapter?.sourceRoot ?? deck?.source?.root ?? "",
      };
    }
    return {
      ...base,
      // F-164：会话默认落在哪个目录 / 工作区。npm 布局下 repoRootFrom 会退到插件包内的 seeds/，
      // 不能拿来当会话 cwd（会落到「未分组」）。优先显式配置的 workspacePath，否则用宿主启动目录。
      cwd: config.workspacePath || process.cwd(),
      workspacePath: config.workspacePath,
      config: {
        preset: "deck-studio",
        renderMode: config.render.mode,
        renderModel: config.render.model,
        renderEndpoint: config.render.endpoint,
        renderSize: config.render.size,
        dataRoot: config.dataRoot,
        displayName: config.displayName,
        hideShellSidebar: config.hideShellSidebar === true,
        defaultStyleAbbr: config.defaultStyleAbbr,
      },
      user: { name: config.userName },
      render: renderStatus(),
      renderSettings: renderSettings(),
      decks,
      active,
      designProjects: designProjects(),
      bindings: listBindings(),
      proposals: base.pendingProposals,
    };
  }

  // F-157：资源和预设风格自举放在所有内部常量初始化之后（否则会碰 TDZ）。
  if (config.bootstrap === true) {
    bootstrapSharedResources();
    bootstrapDesignStyles();
  }

  return { config, store, workspace, adapters, status, state, workbench, readManual, readUserName: () => config.userName, saveUserName, readDoc, docsAsset, setDeckDensity, renderSettings, saveRenderConfig, isLocalDeck: (deckId) => localDeckIds().has(String(deckId ?? "")), assetFile, slideRenderInfo, deckCoverUrl, deckRevisions, deckDocs, deckDoc, deckDocsScaffold, deckDocFile, pageForEdit, savePage, exportDeckFile, designSamples, sourceFile, homeCatalog, mediaFile, renderState, setRenderSelection, renderRuntime, createDeck, createDesign, designProjects, designStyle, updateDesignStyle, backfillStyleBriefs, listBindings, bindSession, unbindSession, deleteDesign, deleteDeck, setDeckDesign, addDesignSamples, seedStyleDesigns, renderStatus, exportHandoff }
}

/**
 * 注册路由与（可选）工具。标准 Cordis apply。
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {Record<string, unknown>} [rawConfig]
 */
export function apply(ctx, rawConfig) {
  const config = mergeConfig(rawConfig, { pluginDir: PLUGIN_DIR, env: process.env });
  const service = createService(config, ctx.logger);
  // F-72：老 design 的 style.json 没存 styleBrief（模板库提示词被丢），启动时幂等补齐。
  try {
    const backfilled = service.backfillStyleBriefs();
    if (backfilled.updated.length) ctx.logger?.info?.(`${name}: styleBrief 已补齐 ${backfilled.updated.join(", ")}`);
  } catch (error) {
    ctx.logger?.warn?.(`${name}: styleBrief 迁移失败：${error?.message ?? error}`);
  }

  /** @type {Array<() => unknown>} */
  const disposers = [];
  const registerRoute = (path, respond, methods = ["GET"]) => {
    if (!config.routes) return;
    disposers.push(
      ctx.connection.fetch.register({
        path,
        methods,
        requestBody: "buffered",
        fetch: async (request) => {
          try {
            return await respond(request);
          } catch (error) {
            ctx.logger?.warn?.(`${name}: ${path} failed: ${error?.message ?? error}`);
            return json({ error: { message: error instanceof Error ? error.message : String(error) } }, 500);
          }
        },
      }),
    );
  };
  const route = (path, handler) => registerRoute(path, async (request) => json(await handler(request)));

  route(ROUTES.status, () => service.status());
  route(ROUTES.state, () => service.state());
  route(ROUTES.workbench, (request) => service.workbench(new URL(request?.url ?? "/", "http://localhost").searchParams.get("deckId")));
  registerRoute(
    ROUTES.app,
    () => new Response(workbenchPage(), { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } }),
  );
  registerRoute(ROUTES.export, (request) => {
    const url = new URL(request?.url ?? "/", "http://localhost");
    const format = (url.searchParams.get("format") ?? "pptx").toLowerCase();
    const result = service.exportDeckFile(url.searchParams.get("deckId") ?? "", format);
    return new Response(result.buffer, {
      headers: {
        "content-type": result.mime,
        "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(result.filename)}`,
        "cache-control": "no-store",
        "x-deck-pages": String(result.pages),
        "x-deck-total": String(result.total ?? result.pages),
        "x-deck-missing": (result.missing ?? []).join(","),
      },
    });
  });

  registerRoute(ROUTES.pageEdit, (request) => {
    const url = new URL(request?.url ?? "/", "http://localhost");
    const view = service.pageForEdit(url.searchParams.get("deckId") ?? "", url.searchParams.get("pageId") ?? "");
    return view ? json({ ok: true, ...view }) : json({ ok: false, error: { message: "page not found" } }, 404);
  });

  registerRoute(ROUTES.pageSave, async (request) => {
    const body = await request.json().catch(() => ({}));
    const result = service.savePage(body.deckId ?? "", body.pageId ?? "", body.fields ?? body);
    return json({ ok: true, ...result });
  }, ["POST"]);

  registerRoute(ROUTES.handoff, (request) => {
    const url = new URL(request?.url ?? "/", "http://localhost");
    const result = service.exportHandoff(url.searchParams.get("deckId") ?? "");
    return new Response(result.buffer, {
      headers: {
        "content-type": result.mime,
        "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(result.filename)}`,
        "cache-control": "no-store",
        "x-deck-files": String(result.files),
      },
    });
  });

  registerRoute(ROUTES.deckCreate, async (request) => {
    if ((request?.method ?? "POST").toUpperCase() !== "POST") return json({ ok: false, error: { message: "POST only" } }, 405);
    const body = await request.json().catch(() => ({}));
    return json({ ok: true, deck: service.createDeck(body) });
  }, ["POST"]);

  // 生图设置（F-126）：body { mode, endpoint, model, apiKeyEnv, apiKeyFile, size }，存本机数据目录并即刻生效。
  registerRoute(ROUTES.renderSettings, async (request) => {
    if ((request?.method ?? "GET").toUpperCase() === "GET") return json({ ok: true, ...service.renderSettings() });
    if ((request?.method ?? "POST").toUpperCase() !== "POST") return json({ ok: false, error: { message: "GET / POST only" } }, 405);
    const body = await request.json().catch(() => ({}));
    return json({ ok: true, ...service.saveRenderConfig(body) });
  }, ["GET", "POST"]);

  // 本机用户名（F-158）：GET 读 / POST {name} 存；之后问候语与新 deck owner / 封面作者默认用它。
  registerRoute(ROUTES.userSettings, async (request) => {
    const method = (request?.method ?? "GET").toUpperCase();
    if (method === "GET") return json({ ok: true, user: { name: config.userName } });
    if (method !== "POST") return json({ ok: false, error: { message: "GET / POST only" } }, 405);
    const body = await request.json().catch(() => ({}));
    try {
      const name = service.saveUserName(body?.name);
      return json({ ok: true, user: { name } });
    } catch (error) {
      return json({ ok: false, error: { message: error.message } }, 400);
    }
  }, ["GET", "POST"]);

  // 内容密度（F-124）：body { deckId, density }。
  registerRoute(ROUTES.deckDensity, async (request) => {
    if ((request?.method ?? "POST").toUpperCase() !== "POST") return json({ ok: false, error: { message: "POST only" } }, 405);
    const body = await request.json().catch(() => ({}));
    return json({ ok: true, ...service.setDeckDensity(body.deckId ?? "", body.density ?? body.contentDensity ?? "") });
  }, ["POST"]);

  // Designs 页「＋ 添加风格」：建 design 实体 + 0 页空白 deck 画布（F-43）。
  registerRoute(ROUTES.designCreate, async (request) => {
    if ((request?.method ?? "POST").toUpperCase() !== "POST") return json({ ok: false, error: { message: "POST only" } }, 405);
    const body = await request.json().catch(() => ({}));
    return json({ ok: true, ...service.createDesign(body) });
  }, ["POST"]);

  // 给风格贴图/上传样张（F-55）：body { designId, files:[{name,mime,data(base64)}] }。
  registerRoute(ROUTES.designSample, async (request) => {
    if ((request?.method ?? "POST").toUpperCase() !== "POST") return json({ ok: false, error: { message: "POST only" } }, 405);
    const body = await request.json().catch(() => ({}));
    return json({ ok: true, ...service.addDesignSamples(body) });
  }, ["POST"]);

  // 导入插件自带的预设风格（F-56）。
  registerRoute(ROUTES.stylesSeed, async (request) => {
    if ((request?.method ?? "POST").toUpperCase() !== "POST") return json({ ok: false, error: { message: "POST only" } }, 405);
    return json({ ok: true, ...service.seedStyleDesigns() });
  }, ["POST"]);

  // 删除风格：design 登记 + 0 页画布 + 绑定关系（F-51）。
  registerRoute(ROUTES.designDelete, async (request) => {
    if ((request?.method ?? "POST").toUpperCase() !== "POST") return json({ ok: false, error: { message: "POST only" } }, 405);
    const body = await request.json().catch(() => ({}));
    return json({ ok: true, ...service.deleteDesign(body) });
  }, ["POST"]);

  // 删除本机新建的 deck（受控源 deck 不可删，后端也拒）。
  registerRoute(ROUTES.deckDelete, async (request) => {
    if ((request?.method ?? "POST").toUpperCase() !== "POST") return json({ ok: false, error: { message: "POST only" } }, 405);
    const body = await request.json().catch(() => ({}));
    return json({ ok: true, ...service.deleteDeck(body) });
  }, ["POST"]);

  // 登记 / 解除 deck → design 关联（F-51）。
  registerRoute(ROUTES.deckDesign, async (request) => {
    if ((request?.method ?? "POST").toUpperCase() !== "POST") return json({ ok: false, error: { message: "POST only" } }, 405);
    const body = await request.json().catch(() => ({}));
    return json({ ok: true, ...service.setDeckDesign(body) });
  }, ["POST"]);

  // 会话绑定：客户端建好会话后落表（DSH 会话没有绑定字段，绑定表在插件侧）。
  registerRoute(ROUTES.sessionBind, async (request) => {
    if ((request?.method ?? "POST").toUpperCase() !== "POST") return json({ ok: false, error: { message: "POST only" } }, 405);
    const body = await request.json().catch(() => ({}));
    if (body?.action === "unbind") return json({ ok: true, removed: service.unbindSession(body.sessionId) });
    return json({ ok: true, binding: service.bindSession(body) });
  }, ["POST"]);

  registerRoute(ROUTES.sessionBindings, () => json({ ok: true, bindings: service.listBindings() }));

  // F-108：提案裁决。用户在脚本页看到「待确认修改」，点确认就直接落 revision（不必再等 Agent 回合）。
  registerRoute(
    ROUTES.proposalDecide,
    async (request) => {
      if ((request?.method ?? "POST").toUpperCase() !== "POST") return json({ ok: false, error: { message: "POST only" } }, 405);
      const body = await request.json().catch(() => ({}));
      const ids = (Array.isArray(body?.proposalIds) ? body.proposalIds : [body?.proposalId])
        .map((id) => String(id ?? "").trim())
        .filter(Boolean);
      if (!ids.length) return json({ ok: false, error: { message: "缺少 proposalIds" } }, 400);
      const confirmed = body?.confirmed !== false;
      const quote = String(body?.quote ?? "").trim()
        || (confirmed ? "（工作台：用户点了「确认落版」）" : "（工作台：用户点了「驳回」）");
      const syncScriptToSource = createScriptToSourceSync({ adapters: service.adapters, isLocalDeck: (deckId) => service.isLocalDeck(deckId) });
      const results = [];
      for (const proposalId of ids) {
        const proposal = service.workspace.proposal(proposalId);
        if (!proposal) {
          results.push({ proposalId, ok: false, error: "提案不存在" });
          continue;
        }
        try {
          const decided = decideProposal({ store: service.store, workspace: service.workspace, proposal, confirmed, quote, sessionId: null, syncScriptToSource });
          results.push({ proposalId, ok: true, status: decided.status, revision: decided.revision ?? null, text: decided.text });
        } catch (error) {
          results.push({ proposalId, ok: false, error: String(error?.message ?? error) });
        }
      }
      return json({ ok: true, results, decided: results.filter((item) => item.ok).length });
    },
    ["POST"],
  );

  // 同一路径只能注册一次（connection 按 path 去重）：GET 读状态 / POST 切换选择。
  registerRoute(
    ROUTES.renderModel,
    async (request) => {
      const url = new URL(request?.url ?? "/", "http://localhost");
      if ((request?.method ?? "GET").toUpperCase() === "POST") {
        const body = await request.json().catch(() => ({}));
        return json({ ok: true, ...service.setRenderSelection(body.deckId ?? "", { nodeId: body.nodeId, model: body.model }) });
      }
      return json({ ok: true, ...service.renderState(url.searchParams.get("deckId") ?? "") });
    },
    ["GET", "POST"],
  );

  registerRoute(ROUTES.media, (request) => {
    const url = new URL(request?.url ?? "/", "http://localhost");
    const hit = service.mediaFile(url.searchParams.get("deckId") ?? "", url.searchParams.get("scope") ?? "source", url.searchParams.get("path") ?? "");
    if (!hit) return new Response("Not found", { status: 404 });
    const mime = ASSET_MIME[extname(hit.file).toLowerCase()] ?? "application/octet-stream";
    return new Response(readFileSync(hit.file), { headers: { "content-type": mime, "cache-control": "no-store" } });
  });

  registerRoute(ROUTES.manual, (request) => {
    const url = new URL(request?.url ?? "/", "http://localhost");
    try {
      return json({ ok: true, ...service.readManual(url.searchParams.get("lang") ?? "zh") });
    } catch (error) {
      return json({ ok: false, error: { message: error.message } }, 404);
    }
  });

  registerRoute(ROUTES.manualDoc, (request) => {
    const url = new URL(request?.url ?? "/", "http://localhost");
    try {
      return json({ ok: true, ...service.readDoc(url.searchParams.get("path") ?? "manual.md") });
    } catch (error) {
      return json({ ok: false, error: { message: error.message } }, 404);
    }
  });

  registerRoute(ROUTES.docsAsset, (request) => {
    const url = new URL(request?.url ?? "/", "http://localhost");
    const asset = service.docsAsset(url.searchParams.get("path") ?? "");
    if (!asset) return new Response("not found", { status: 404 });
    return new Response(readFileSync(asset.file), {
      headers: { "content-type": asset.mime, "cache-control": "public, max-age=300" },
    });
  });

  registerRoute(ROUTES.faq, (request) => {
    const url = new URL(request?.url ?? "/", "http://localhost");
    const query = String(url.searchParams.get("q") ?? "").trim();
    const hits = query ? searchFaq(query, 5) : [];
    return json({ ok: true, query, index: faqIndex(), results: hits.map((entry) => ({ id: entry.id, title: entry.title, answer: entry.answer })) });
  });

  registerRoute(ROUTES.sourcefile, (request) => {
    const url = new URL(request?.url ?? "/", "http://localhost");
    const hit = service.sourceFile(url.searchParams.get("deckId") ?? "", url.searchParams.get("name") ?? "");
    if (!hit) return new Response("Not found", { status: 404 });
    const mime = ASSET_MIME[extname(hit.file).toLowerCase()] ?? "application/octet-stream";
    return new Response(readFileSync(hit.file), { headers: { "content-type": mime, "cache-control": "no-store" } });
  });

  registerRoute(ROUTES.doc, (request) => {
    const url = new URL(request?.url ?? "/", "http://localhost");
    const deckId = url.searchParams.get("deckId") ?? "";
    const docId = url.searchParams.get("docId") ?? "";
    // F-163：读取失败要把真实原因吐给前端，不能 500 空手而归（前端以前会一直转圈）。
    try {
      const doc = service.deckDoc(deckId, docId);
      if (!doc) return json({ ok: false, error: { message: `unknown deck or doc：deckId=${deckId || "(空)"} docId=${docId || "(空)"}` } }, 404);
      return json({ ok: true, deckId, ...doc });
    } catch (error) {
      const message = String(error?.message ?? error);
      logger?.warn?.(`deck-studio.doc 读取失败 deckId=${deckId} docId=${docId}：${message}`);
      return json({ ok: false, error: { message } }, 500);
    }
  });

  registerRoute(ROUTES.docfile, (request) => {
    const url = new URL(request?.url ?? "/", "http://localhost");
    const hit = service.deckDocFile(url.searchParams.get("deckId") ?? "", url.searchParams.get("docId") ?? "", url.searchParams.get("name") ?? "");
    if (!hit) return new Response("Not found", { status: 404 });
    const ext = extname(hit.file).toLowerCase();
    return new Response(readFileSync(hit.file), {
      headers: {
        "content-type": DOC_FILE_EXTS[ext] ?? "application/octet-stream",
        "cache-control": "no-store",
        "content-disposition": `inline; filename*=UTF-8''${encodeURIComponent(hit.name)}`,
      },
    });
  });

  registerRoute(ROUTES.asset, (request) => {
    const url = new URL(request?.url ?? "/", "http://localhost");
    const file = service.assetFile(url.searchParams.get("deckId") ?? "", url.searchParams.get("pageId") ?? "", url.searchParams.get("rev") ?? "");
    if (!file) return new Response("Not found", { status: 404 });
    return new Response(readFileSync(file), {
      headers: { "content-type": ASSET_MIME[extname(file).toLowerCase()] ?? "application/octet-stream", "cache-control": "no-store" },
    });
  });

  ctx.effect(
    () => async () => {
      await Promise.allSettled(disposers.map((dispose) => dispose()));
    },
    `${name}: fetch routes`,
  );

  // preset 子树挂载（config.tools = true）才注册工具；"tools" 服务不存在时显式报错，
  // 不静默吞——「工具没挂上」必须可见。
  if (config.tools) {
    const toolRuntime = ctx.get("tools");
    if (!toolRuntime?.register) {
      ctx.logger?.warn?.(`${name}: config.tools=true 但 tools 服务不可用——deck 工具未注册`);
    } else {
      const tools = defineDeckTools({ store: service.store, workspace: service.workspace, adapters: service.adapters, config, env: process.env, repoRoot: repoRootFrom(PLUGIN_DIR), isLocalDeck: (deckId) => service.isLocalDeck(deckId), resolveRender: (deckId) => service.renderRuntime(deckId), subagents: () => ctx.get("subagents") ?? null, reviewPreset: config.review?.presetId });
      for (const tool of tools) {
        disposers.push(toolRuntime.register(tool));
      }
      ctx.logger?.info?.(`${name}: deck tools registered (${tools.map((tool) => tool.name).join(", ")})`);
    }
  }

  // 服务树里的 deckStudio 是单例：**只由根挂载（routes 开启）提供**。
  // preset 子树里的工具挂载不能再 provide——Cordis 同一 realm 内重复 provide 会抛
  // `service "deckStudio" has been registered at <deck-studio>`，进而使 preset 激活失败，
  // 新会话报 agent-preset/invalid（2026-10-20 真机踩到并复现）。
  if (config.routes) {
    try {
      ctx.provide("deckStudio", service);
    } catch (error) {
      ctx.logger?.debug?.(`${name}: deckStudio 已有提供方，跳过重复 provide（${error?.message ?? error}）`);
    }
  }
  ctx.logger?.info?.(`${name} ready (routes=${config.routes ? Object.values(ROUTES).join(", ") : "off"}, tools=${config.tools ? "on" : "off"}, decks=${service.adapters.length}, dataRoot=${config.dataRoot})`);
}

export { mergeConfig, createRuntimeStore, createDeckWorkspace, createLocalSourceAdapter, defineDeckTools };
