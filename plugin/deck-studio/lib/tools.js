/**
 * Deck Agent 工具面（ADR-0006 D3）。裸工具定义 + `ctx.tools.register`，零第三方依赖。
 *
 * 每个工具调用都通过 withToolEvent 留 `agent.tool` 事件；edit / render 另起 task 记录
 * 生命周期（queued → running → waiting-user → succeeded/failed/cancelled）。
 *
 * @module dsh-plugin-deck-studio/tools
 */

import { dirname, extname, join, relative, resolve, sep } from "node:path";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { buildPrompt, qaCheck, nextRevision, selectRenderer, editEndpointFor, imageMime, readKeyFromFile, createFakeEditRenderer, createRealEditRenderer } from "./render.js";
import { applyScriptFieldEdit, scriptDiff, newProposalId, proposalNow, SCRIPT_FIELD_CELL, scriptSectionRange } from "./deck-workspace.js";
import { appendChangelogNote, readDeckDoc, resolveDeckDocs, scaffoldDeckDocs } from "./deck-docs.js";
import { createDesignRegistry } from "./designs.js";
import { appendSampleRecord, composeSamplePrompt, readSampleRecords, readStyleDefinition, writeStyleDefinition } from "./design-style.js";
import { createLocalSourceAdapter, parseSectionedPages } from "./source-adapter.js";
import { readDeckRules, renderDeckRules } from "./deck-rules.js";
import { readDeckBrief, validateSkeleton } from "./deck-brief.js";
import { scriptStyleHints } from "./script-style.js";
import { DEFAULT_MAX_REVIEWERS, HARD_MAX_REVIEWERS, deriveReviewers, mergeIssues } from "./review-personas.js";
import {
  BLIND_FREEZE_FILE,
  REVIEW_REPORT_FILE,
  blindReviewerPrompt,
  buildFindings,
  contrastReviewerPrompt,
  gapsToIssues,
  makeFreezeRecord,
  mergeBlind,
  pageIdsFromScript,
  parseBlindOutput,
  parseContrastOutput,
  renderProtocolMarkdown,
  scriptContainsEvidence,
  scriptSnapshotHash,
  verifyFreeze,
} from "./review-protocol.js";
import { REVIEW_AGENT_PROVIDER } from "./review-agent.js";
import { plainReviewSummary, renderGapReviewMarkdown, renderReaderReviewMarkdown } from "./review-readers.js";
import { applyCitationChecks, citationCheckPrompt, parseCitationCheck } from "./citation-check.js";
import { attemptsOf, pickRenderExpectations, renderImageReviewMarkdown, runImageReview } from "./image-review.js";
import { analyzeTitleChain, renderTitleChain } from "./title-chain.js";
import { CONTRACT_FIELD_KEYS, contractTag, readPageContract, summarizeContracts, validatePageContract } from "./page-contract.js";
import { compareScores, mergeScoreRecords, parseScoreOutput, renderScoreHistoryMarkdown, renderScoreSummary, scoreHistoryEntry, scoreReviewerPrompt } from "./review-score.js";
import { analyzeFactLabels, factSummaryLine } from "./fact-labels.js";
import { densityLine } from "./content-density.js";
import { faqIndex, searchFaq } from "./faq.js";
import { WATERMARK_POSITIONS, WATERMARK_POSITION_LABELS, findAsset, listAssets, positionLine, readPngFile, watermarkPng } from "./watermark.js";
import { PLUGIN_DIR, repoRootFrom } from "./config.js";
import { buildIntentMarkdown } from "./deck-templates.js";
import { applyFirstDraftBatch, createScriptToSourceSync, decideProposal } from "./proposal-decision.js";
import { isFirstDraft, latestAutoland, rollbackFirstDraft } from "./first-draft.js";

/** 本次调用的 sessionId（非 agent 环境——冒烟测试——为 null）。 */
function sessionIdOf(exec) {
  return exec?.agent?.id ?? null;
}

/**
 * Agent 可读的参考资料白名单（F-71）。
 *
 * 背景：Agent 只有 deck_* 工具，没有通用文件工具——弹窗「参考资料」里给的
 * README / docs / materials 路径它根本读不到，于是只能按聊天里的几句话编内容。
 * 这里提供一个**只读、白名单**的文件读取工具：只允许本仓库里对外可见的
 * 资料（README / 对外 4 篇 docs / samples / logo / 插件代码），
 * 不碰客户 deck 源、.deck 运行数据、内部台账和密钥文件。
 */
const REPO_ROOT = repoRootFrom(PLUGIN_DIR);
const READABLE_FILES = new Set([
  "README.md",
  "CHANGELOG.md",
  "LICENSE",
  "docs/productization.md",
  "docs/install.md",
  "docs/styles.md",
  "docs/sample-deck.md",
]);
const READABLE_DIRS = ["samples/", "assets/logo/", "plugin/deck-studio/"];
const READABLE_EXTS = new Set([".md", ".txt", ".json", ".yml", ".yaml", ".js", ".mjs", ".css", ".html", ".svg", ".csv"]);

function resolveReadablePath(rawPath) {
  const raw = String(rawPath ?? "").trim().replace(/\\/g, "/");
  if (!raw) throw new Error("path 不能为空");
  if (raw.startsWith("/") || raw.startsWith("~") || raw.split("/").includes("..")) {
    throw new Error(`不允许的路径：${raw}（只接受本仓库相对路径，不能跳出仓库）`);
  }
  const rel = relative(REPO_ROOT, resolve(REPO_ROOT, raw)).replace(/\\/g, "/");
  if (!rel || rel.startsWith("..")) throw new Error(`不允许的路径：${raw}（只接受本仓库相对路径）`);
  const allowed = READABLE_FILES.has(rel) || READABLE_DIRS.some((dir) => rel.startsWith(dir));
  if (!allowed) {
    throw new Error(
      `path 不在只读白名单：${rel}；可读：README.md / CHANGELOG.md / docs 的 productization·install·styles·sample-deck / samples/ / assets/logo/ / plugin/deck-studio/`,
    );
  }
  const file = join(REPO_ROOT, rel);
  if (!existsSync(file) || !statSync(file).isFile()) throw new Error(`文件不存在：${rel}`);
  const ext = extname(file).toLowerCase();
  if (!READABLE_EXTS.has(ext)) throw new Error(`不支持的文件类型：${ext || "（无扩展名）"}；本工具只读文本 / 代码 / 配置（png/jpg 图片不能读内容）`);
  const bytes = statSync(file).size;
  if (bytes > 200_000) throw new Error(`文件过大：${bytes} 字节（上限 200KB），请换更小的材料`);
  return { file, rel, bytes };
}

/**
 * 工具包装：记录 agent.tool started / succeeded / failed 事件。
 * @param {ReturnType<import('./store.js').createRuntimeStore>} store
 */
function withToolEvent(store, toolName, run) {
  return async (args, exec) => {
    const sessionId = sessionIdOf(exec);
    const envelope = store.recordEvent({
      type: "agent.tool",
      sessionId,
      actor: "agent",
      status: "started",
      payload: { tool: toolName, args: summarizeArgs(args) },
    });
    const started = Date.now();
    try {
      const value = await run(args, exec);
      store.recordEvent({
        type: "agent.tool",
        sessionId,
        taskId: value?.taskId ?? null,
        deckId: value?.deckId ?? args?.deckId ?? null,
        slideIds: value?.slideIds ?? [],
        actor: "agent",
        status: "succeeded",
        payload: { tool: toolName, eventId: envelope.eventId, durationMs: Date.now() - started },
      });
      return value;
    } catch (error) {
      store.recordEvent({
        type: "agent.tool",
        sessionId,
        actor: "agent",
        status: "failed",
        payload: { tool: toolName, eventId: envelope.eventId, durationMs: Date.now() - started, error: String(error?.message ?? error) },
      });
      throw error;
    }
  };
}

/** 事件里的参数摘要：截断长文本，绝不落 API key。 */
function summarizeArgs(args) {
  const out = {};
  for (const [key, value] of Object.entries(args ?? {})) {
    const text = typeof value === "string" ? value : JSON.stringify(value);
    out[key] = typeof text === "string" && text.length > 160 ? `${text.slice(0, 160)}…(${text.length})` : value;
  }
  return out;
}

const strEnum = (values) => ({ type: "string", enum: values });

/**
 * 构建全部工具定义。
 * @param {object} services
 * @param {import('./store.js').createRuntimeStore} services.store
 * @param {import('./deck-workspace.js').createDeckWorkspace} services.workspace
 * @param {Array<ReturnType<import('./source-adapter.js').createLocalSourceAdapter>>} services.adapters
 * @param {import('./config.js').mergeConfig} services.config
 * @param {NodeJS.ProcessEnv} [services.env]
 */
/**
 * 评审意见 → 提案的元数据（F-176 / 智力升级 I-18）。
 * A/B 类可以进提案；C 类（原文找不到证据）一律拒绝——宁可少一条意见，也不让编造的证据进改动。
 */
function reviewMetaOf(args = {}) {
  const meta = {};
  const reviewRef = String(args.reviewRef ?? "").trim();
  if (reviewRef) meta.reviewRef = reviewRef.slice(0, 40);
  const severity = String(args.severity ?? "").trim().toUpperCase();
  if (severity) {
    if (!["P0", "P1", "P2"].includes(severity)) throw new Error(`severity 只能是 P0 / P1 / P2（收到 ${severity}）`);
    meta.severity = severity;
  }
  const confidence = String(args.confidence ?? "").trim().toUpperCase();
  if (confidence) {
    if (!["A", "B", "C", "D"].includes(confidence)) throw new Error(`confidence 只能是 A / B / C / D（收到 ${confidence}）`);
    if (confidence === "C") {
      throw new Error("C 类意见（稿件里找不到原文证据）不许进提案：先在评审里确认证据，或把它当「无法核实」告诉用户，不要照着改。");
    }
    meta.confidence = confidence;
  }
  const evidence = String(args.evidence ?? "").trim();
  if (evidence) meta.evidence = evidence.slice(0, 300);
  return meta;
}

export function defineDeckTools({ store, workspace, adapters, config, env = process.env, resolveRender = null, isLocalDeck = null, repoRoot = null, subagents = null, visionFetch = null, createStyle = null }) {
  const resolveSubagents = () => (typeof subagents === "function" ? subagents() : subagents);
  const designs = createDesignRegistry({ dataRoot: config.dataRoot });
  const decksRegistryFile = join(config.dataRoot, "decks-registry.json");

  /**
   * F-111：deck 关联的 design（「这个 deck 用哪个登记风格」）。
   * 出图 prompt 必须带它的 styleBrief——否则 Design 页显示的「已关联 SKT」只是装饰，
   * 出图仍用全局 styleBrief，用户看到的就是「我定的风格没生效」。
   */
  const linkedDesignStyle = (deckId) => {
    const association = designs.deckDesignFor(deckId);
    if (!association?.designId) return null;
    const design = designs.findDesign(association.designId);
    if (!design) return null;
    let definition = null;
    const canvas = adapters.find((item) => item.id === design.canvasDeckId) ?? null;
    if (canvas?.sourceRoot) {
      try {
        definition = readStyleDefinition(canvas.sourceRoot, design.abbr ?? "", design);
      } catch {
        definition = null;
      }
    }
    const brief = String(design.styleBrief || definition?.styleBrief || definition?.description || design.description || "").trim();
    if (!brief) return null;
    return {
      designId: design.designId,
      abbr: design.abbr ?? "",
      name: design.name ?? "",
      brief,
      constraints: String(design.constraints || definition?.constraints || "").trim(),
    };
  };
  // 启动时从注册表补进来的 deck 不算静态源；之后再被删掉就应从工具实例里移除。
  const staticDeckIds = new Set((config.decks ?? []).filter((deck) => deck?.id && !deck.fromRegistry).map((deck) => deck.id));

  /**
   * F-71：root 挂载（routes: true）和 preset 挂载（tools: true）是**两个 service 实例**，
   * 各自在启动时按注册表建了 adapters。「新建 Deck / 新建风格」只更新 root 实例的
   * adapters + 落注册表，preset 工具实例的 adapters 会停在启动那一刻——于是 Agent 报
   * 「未知 deck：deck-xxx」，用户看到的就是「新建完对话里全是错误」。
   *
   * 修法：每次工具调用前按 `decks-registry.json` 对齐 adapters——
   * 注册表里有、adapters 里没有的补上；既不在静态配置、也不在注册表里的移除。
   * 一次小文件读，代价可忽略；换来的是新建 deck 立刻可被 Agent 看见。
   */
  function readRegistryDecks() {
    try {
      const raw = JSON.parse(readFileSync(decksRegistryFile, "utf8"));
      const entries = Array.isArray(raw?.decks) ? raw.decks : [];
      return new Map(entries.filter((entry) => entry?.id && entry?.sourceRoot).map((entry) => [entry.id, entry]));
    } catch {
      return new Map();
    }
  }

  function refreshAdapters() {
    const registered = readRegistryDecks();
    for (const [id, entry] of registered) {
      if (adapters.some((candidate) => candidate.id === id)) continue;
      adapters.push(
        createLocalSourceAdapter({ id, label: entry.label || id, sourceRoot: entry.sourceRoot, kind: entry.kind ?? "deck", designId: entry.designId ?? null }),
      );
    }
    for (let index = adapters.length - 1; index >= 0; index -= 1) {
      const id = adapters[index].id;
      if (staticDeckIds.has(id) || registered.has(id)) continue;
      adapters.splice(index, 1);
    }
  }

  function adapterFor(deckId) {
    const adapter = adapters.find((candidate) => candidate.id === deckId);
    if (!adapter) {
      throw new Error(`未知 deck：${deckId}（可用：${adapters.map((candidate) => candidate.id).join(", ") || "无——检查 preset 配置里的 decks"}）`);
    }
    if (!adapter.available()) throw new Error(`源不可读：${deckId} → ${adapter.sourceRoot}`);
    return adapter;
  }

  /**
   * 本机新建 deck：把确认后的脚本内容回写源 script.md + git 留痕（F-100 / ADR-0022）。
   *
   * 受控客户源（isLocalDeck=false）仍然只读：只写 .deck 工作副本，不回写源。
   * git 不可用 / 源不在仓库里只返回错误，不影响已经写好的文件（与 ADR-0008 一致）。
   */
  const syncScriptToSource = createScriptToSourceSync({ adapters, isLocalDeck });

  function manifestFor(deckId) {
    const deck = workspace.manifest(deckId);
    if (!deck) throw new Error(`deck 未初始化：${deckId}（先调 deck_script_read 触发初始化）`);
    return deck;
  }

  function slideFor(deckId, page) {
    const deck = manifestFor(deckId);
    const pageId = `p${String(Number(page)).padStart(2, "0")}`;
    const slide = deck.slides.find((candidate) => candidate.id === pageId);
    if (!slide) throw new Error(`页不存在：${pageId}（${deckId} 共 ${deck.slides.length} 页）`);
    return { deck, slide, pageId };
  }

  /**
   * deck_design_sample 的 design 解析（F-61）。
   *
   * 模型偶尔会把 design id 截断（`…-u14f` → `…-u14`），直接按完整 id 查会误报
   * 「先用 design/create 建风格」——design 其实存在。这里按可信度依次尝试：
   * 1. 完整 designId；2. 缩写（大小写不敏感）；3. designId 的唯一前缀；
   * 4. 当前会话绑定的 design（design 会话里可省略 designId）。
   * 全都匹配不到时，错误信息列出可用 design，而不是误导用户去重新建风格。
   */
  function resolveDesign(rawKey, exec) {
    const key = String(rawKey ?? "").trim();
    const all = designs.listDesigns();
    let design = null;
    if (key) {
      design = designs.findDesign(key) ?? designs.findDesignByAbbr(key) ?? null;
      if (!design) {
        const lower = key.toLowerCase();
        const prefixMatches = all.filter((item) => String(item.designId).toLowerCase().startsWith(lower));
        if (prefixMatches.length === 1) design = prefixMatches[0];
      }
    }
    if (!design) {
      const sessionId = sessionIdOf(exec);
      const binding = sessionId
        ? designs.listBindings().find((item) => item.sessionId === sessionId && item.kind === "design")
        : null;
      if (binding) design = designs.findDesign(binding.id) ?? null;
    }
    if (!design) {
      const available = all.map((item) => `${item.abbr}（${item.designId}）`).join("、") || "还没有 design";
      throw new Error(
        `未知 design：${key || "（空）"}；当前可用：${available}。` +
        "designId 传完整 id 或缩写（如 SKT）即可；已有 design 不需要再 design/create。",
      );
    }
    return design;
  }

  const tools = [];

  // ── 1. deck_source_overview ────────────────────────────────────────────────
  tools.push({
    name: "deck_source_overview",
    description:
      "列出受控 deck 源（如某个已接入的 deck）：页数、状态、反馈数、做到哪。只读元信息，不返回客户正文。" +
      "开始任何 deck 工作前先调它确认源可用。若 deck 项目根有 `deck.rules.md`（项目级规则），会在对应 deck 下作为" +
      "「项目规则」返回：必须遵守，但不能覆盖系统硬纪律（只读源 / QA 门禁 / 不编造 / 用户确认）。",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    output: { schema: { type: "object", properties: { decks: { type: "array", items: { type: "object" } } } }, render: (_args, value) => [{ type: "text", text: String(value?.text ?? "") }] },
    execute: withToolEvent(store, "deck_source_overview", async () => {
      const decks = adapters.map((adapter) => {
        const view = adapter.available() ? adapter.overview() : { available: false, title: adapter.label, pageCount: 0, feedbackCount: 0, status: "", warnings: [`${adapter.id}: 源不可读 ${adapter.sourceRoot}`] };
        // F-87 / ADR-0020：deck 项目级规则（可选 deck.rules.md）由插件显式读取，不用 AGENTS.md 文件链。
        const rules = adapter.available() ? readDeckRules(adapter.sourceRoot) : { found: false, path: "deck.rules.md", bytes: 0, content: "", truncated: false, flags: [] };
        // F-124：内容密度（一页写多少字）跟着 deck 走，写 script 前必须看到。
        const density = workspace.manifest(adapter.id)?.contentDensity ?? "auto";
        // F-158：写 script 前先看到 intent 的听众 / 目的（新 deck 的 deb 规则里也会带，但 overview 是第一个调用）。
        const brief = adapter.available() ? readDeckBrief(adapter.sourceRoot) : {};
        // F-180 / I-05：deck 级论证骨架（核心论证 / 骨架类型 / 页序角色）——没写就提示先写骨架再列页。
        const skeleton = validateSkeleton(brief);
        const skeletonState = brief.skeleton?.argument || brief.skeleton?.type || brief.skeleton?.order
          ? { argument: brief.skeleton.argument, type: brief.skeleton.type, order: brief.skeleton.order, keepThree: brief.skeleton.keepThree, ok: skeleton.ok, missing: skeleton.missing }
          : { ok: false, missing: skeleton.missing.length ? skeleton.missing : ["核心论证", "骨架类型", "页序角色"] };
        return {
          deckId: adapter.id,
          label: adapter.label,
          available: view.available,
          title: view.title,
          status: view.status ?? "",
          pageCount: view.pageCount ?? 0,
          feedbackCount: view.feedbackCount ?? 0,
          phases: (view.currentTable ?? []).map((cells) => ({ phase: cells[0], state: cells[1] })),
          warnings: view.warnings ?? [],
          sourceRoot: adapter.sourceRoot,
          contentDensity: density,
          projectRules: {
            found: rules.found,
            path: rules.path,
            bytes: rules.bytes,
            truncated: rules.truncated,
            flags: rules.flags ?? [],
            ...(rules.warning ? { warning: rules.warning } : {}),
          },
          _rulesText: renderDeckRules(rules),
          _briefText: [
            brief.audience || brief.takeaway || brief.success
              ? `受众 / 目的：${[brief.audience, brief.takeaway || brief.success].filter(Boolean).join(" · ")}`
              : "",
            skeleton.hint,
          ].filter(Boolean).join("\n"),
          _skeletonText: skeletonState,
        };
      });
      return {
        decks: decks.map(({ _rulesText, _briefText, _skeletonText, ...deck }) => deck),
        deckId: null,
        text: decks
          .map((deck) =>
            [
              `• ${deck.deckId}（${deck.label}）${deck.available ? "" : "【源不可读】"}`,
              `  标题：${deck.title} · 状态：${deck.status || "—"} · 页数：${deck.pageCount} · 反馈：${deck.feedbackCount} 条`,
              ...(deck.phases.length ? [`  做到哪：${deck.phases.map((phase) => `${phase.phase}=${phase.state}`).join("；")}`] : []),
              `  ${densityLine(deck.contentDensity)}`,
              ...(deck.warnings.length ? [`  警告：${deck.warnings.join("；")}`] : []),
              ...(deck._briefText ? [`  ${deck._briefText}`] : []),
              ...(deck._rulesText ? [deck._rulesText] : []),
            ].join("\n"),
          )
          .join("\n"),
      };
    }),
  });

  // ── 1.5 deck_file_read ─────────────────────────────────────────────────────
  // F-71：资料白名单只读。用于读「新建 Deck」弹窗参考资料 / materials.md 里列的
  // README、docs、samples 材料、logo 与插件代码；不读客户源 / .deck / 内部台账 / 密钥。
  tools.push({
    name: "deck_file_read",
    description:
      "只读读取本仓库里的参考资料（弹窗「参考资料」里列的路径，或 samples/deckline-intro/materials.md 的清单）：" +
      "README.md / CHANGELOG.md / docs 的 productization·install·styles·sample-deck / samples/ / assets/logo/ / plugin/deck-studio/。" +
      "不读客户 deck 源、.deck 运行数据、内部台账、密钥。路径是仓库相对路径；最多返回 400 行（maxLines 可到 800）。",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "仓库相对路径，如 samples/deckline-intro/materials/project-summary.md" },
        maxLines: { type: "number", description: "最多返回行数（默认 400，上限 800）" },
      },
      required: ["path"],
      additionalProperties: false,
    },
    output: { schema: { type: "object", properties: { path: { type: "string" }, lines: { type: "number" }, truncated: { type: "boolean" } } }, render: (_args, value) => [{ type: "text", text: String(value?.text ?? "") }] },
    execute: withToolEvent(store, "deck_file_read", async (args) => {
      const { file, rel, bytes } = resolveReadablePath(args.path);
      const all = readFileSync(file, "utf8").split("\n");
      const limit = Math.min(Math.max(20, Number(args.maxLines) || 400), 800);
      const shown = all.slice(0, limit);
      const truncated = all.length > limit;
      return {
        path: rel,
        lines: all.length,
        truncated,
        text: `文件 ${rel}（${all.length} 行 · ${bytes} 字节${truncated ? `，只显示前 ${limit} 行` : ""}）\n\n${shown.join("\n")}${truncated ? "\n…（已截断；需要更多内容请传更大的 maxLines，或读更具体的文件）" : ""}`,
      };
    }),
  });

  // ── 1.5 deck_doc_read（F-76：Agent 读得到 deck 文档正文） ──────────────────
  tools.push({
    name: "deck_doc_read",
    description:
      "读当前 deck 的治理文档正文（intent 意图 / design 画面规范 / changelog 修改日志 / feedback 反馈 / research 调研 / materials 支撑材料 / review 审稿 / fact-check 事实核对）。" +
      "补意图、提 script 提案前先读 intent 与 design，别靠猜；资料里没有的事实要问用户，不要编。",
    parameters: {
      type: "object",
      properties: {
        deckId: { type: "string" },
        docId: { type: "string", enum: ["intent", "design", "changelog", "feedback", "research", "materials", "review", "factcheck"], description: "文档 id" },
        maxLines: { type: "number", description: "最多返回多少行（默认 400，上限 800）" },
      },
      required: ["deckId", "docId"],
      additionalProperties: false,
    },
    output: {
      schema: { type: "object", properties: { docId: { type: "string" }, status: { type: "string" }, text: { type: "string" } } },
      render: (_args, value) => [{ type: "text", text: String(value?.text ?? "") }],
    },
    execute: withToolEvent(store, "deck_doc_read", async (args) => {
      const adapter = adapterFor(args.deckId);
      const deck = workspace.ensureDeck(adapter, { styleBrief: config.styleBrief });
      const docId = String(args.docId ?? "");
      const limit = Math.min(Math.max(Number(args.maxLines) || 400, 20), 800);
      const doc = readDeckDoc({
        adapter,
        deckDir: workspace.deckDir(deck.id),
        docId,
        render: config.render,
        revisions: workspace.manifest(deck.id)?.revisions ?? [],
        events: store.events(200).filter((event) => event.deckId === deck.id),
      });
      if (!doc) throw new Error(`未知文档：${docId}（可选 intent / design / changelog / feedback / research / materials / review / factcheck）`);
      const lines = String(doc.content ?? "").split("\n");
      const truncated = lines.length > limit;
      const body = lines.slice(0, limit).join("\n");
      const head = doc.status === "missing"
        ? `文档 ${docId}（${doc.label ?? docId}）还没有内容${doc.issues?.length ? `：${doc.issues.join("；")}` : ""}。`
        : `文档 ${docId}（${doc.label ?? docId}）· 状态 ${doc.status}${doc.primary ? ` · ${doc.primary}` : ""}${truncated ? ` · 只显示前 ${limit} 行（共 ${lines.length} 行）` : ""}`;
      return {
        deckId: deck.id,
        docId,
        status: doc.status,
        issues: doc.issues ?? [],
        text: `${head}\n\n${body || "（空）"}`,
      };
    }),
  });

  // ── 1.6 deck_doc_update（F-78：Agent 把分析结果写进文档） ──────────────────
  const INTENT_FIELD_ALIASES = {
    "听众": "听众", audience: "听众", "受众": "听众", "对象": "听众",
    "主题": "主题", topic: "主题", "话题": "主题",
    "带走": "带走", takeaway: "带走", "希望带走": "带走", "收获": "带走",
    "场合/时长": "场合 / 时长", "场合 / 时长": "场合 / 时长", occasion: "场合 / 时长",
    "场合": "场合 / 时长", "时长": "场合 / 时长", "时间": "场合 / 时长", "场景": "场合 / 时长",
    duration: "场合 / 时长", time: "场合 / 时长", venue: "场合 / 时长",
    "成功标准": "成功标准", success: "成功标准", "成功": "成功标准", "目的": "成功标准",
    "目标": "成功标准", goal: "成功标准", objective: "成功标准",
    "不讲的": "不讲的", "不讲": "不讲的", scopeOut: "不讲的", scope: "不讲的",
    "边界": "不讲的", "排除": "不讲的", "不包括": "不讲的", "nonGoals": "不讲的",
    // F-180（I-05）：论证骨架四行也是 intent 的结构化字段，能通过 deck_doc_update 写。
    "核心论证": "核心论证", argument: "核心论证", "论点": "核心论证",
    "骨架类型": "骨架类型", skeletonType: "骨架类型", "叙事结构类型": "骨架类型",
    "页序角色": "页序角色", pageOrder: "页序角色", "页序": "页序角色",
    "只留 3 页留哪 3 页": "只留 3 页留哪 3 页", "只留3页": "只留 3 页留哪 3 页", keepThree: "只留 3 页留哪 3 页",
  };
  const DOC_DRAFT_PATH = (dir, docId) => (docId === "research" ? join(dir, "docs", "research", "index.md") : join(dir, "docs", `${docId}.md`));
  const DOC_TITLES = { materials: "支撑材料", research: "调研", feedback: "反馈" };

  tools.push({
    name: "deck_doc_update",
    description:
      "把分析结果写进当前 deck 的文档。intent：补结构化字段（听众 / 主题 / 带走 / 场合·时长 / 成功标准 / 不讲的），" +
      "本机新建 deck 写回源 intent.md；materials / research / feedback：写 .deck 工作副本（确认后回写源）。" +
      "补之前先用 deck_doc_read / deck_file_read 读依据；没有依据的字段不要编，缺什么问用户。",
    parameters: {
      type: "object",
      properties: {
        deckId: { type: "string" },
        docId: { type: "string", enum: ["intent", "materials", "research", "feedback"] },
        fields: { type: "object", description: "仅 intent：字段名 → 值（支持中文名或 audience/topic/takeaway/occasion/success/scopeOut）" },
        content: { type: "string", description: "仅 materials / research / feedback：要写入的 Markdown" },
        mode: { type: "string", enum: ["append", "replace"], description: "写入方式（默认 append）" },
        reason: { type: "string", description: "为什么补（写进修改日志）" },
      },
      required: ["deckId", "docId"],
      additionalProperties: false,
    },
    output: { schema: { type: "object", properties: { docId: { type: "string" }, status: { type: "string" }, text: { type: "string" } } }, render: (_args, value) => [{ type: "text", text: String(value?.text ?? "") }] },
    execute: withToolEvent(store, "deck_doc_update", async (args, exec) => {
      const adapter = adapterFor(args.deckId);
      const deck = workspace.ensureDeck(adapter, { styleBrief: config.styleBrief });
      const deckDir = workspace.deckDir(deck.id);
      const docId = String(args.docId ?? "");
      const reason = String(args.reason ?? "").trim();
      const localDeck = typeof isLocalDeck === "function" && isLocalDeck(deck.id);
      const sessionId = sessionIdOf(exec);
      let target = "";
      let text = "";

      const record = (note) => store.recordEvent({
        type: "deck.doc.update",
        deckId: deck.id,
        sessionId,
        actor: "agent",
        status: "succeeded",
        payload: { docId, note: String(note ?? reason).slice(0, 300) || `更新 ${docId}` },
      });

      if (docId === "intent") {
        const sourceIntent = join(adapter.sourceRoot ?? "", "intent.md");
        const draftIntent = join(deckDir, "docs", "intent.md");
        const canWriteSource = localDeck && Boolean(adapter.sourceRoot) && existsSync(dirname(sourceIntent));
        const currentFile = canWriteSource ? sourceIntent : draftIntent;
        const current = existsSync(currentFile) ? readFileSync(currentFile, "utf8") : buildIntentMarkdown({ title: deck.label ?? deck.id });
        const fields = args.fields && typeof args.fields === "object" ? args.fields : {};
        // F-100：故事线是整段正文（模板里的 `## 故事线（叙事结构）`），不是单行字段。
        const STORYLINE_KEYS = new Set(["故事线", "叙事", "叙事结构", "故事线（叙事结构）", "storyline", "narrative", "story"]);
        const merged = [];
        let storyline = "";
        for (const [rawKey, rawValue] of Object.entries(fields)) {
          if (STORYLINE_KEYS.has(String(rawKey).trim())) {
            storyline = String(rawValue ?? "").trim();
            continue;
          }
          const fieldName = INTENT_FIELD_ALIASES[String(rawKey).trim()] ?? null;
          if (!fieldName) continue;
          // 字段是 `- **字段**：值` 单行结构：多行值折成一行，避免把后续行写成裸正文 / 重复插入。
          const value = String(rawValue ?? "").replace(/\r?\n+/g, "；").replace(/\s+/g, " ").trim();
          if (!value) continue;
          merged.push([fieldName, value]);
        }
        if (!merged.length && !storyline) throw new Error("intent 至少要给一个字段（听众 / 主题 / 带走 / 场合·时长 / 成功标准 / 不讲的 / 核心论证 / 骨架类型 / 页序角色 / 只留 3 页）或故事线正文");
        const lines = current.split("\n");
        const lineRe = /^(\s*-\s*\*\*)([^*]+)(\*\*\s*[：:]\s*)(.*)$/;
        let lastFieldIndex = -1;
        const matchedNames = new Set();
        for (let i = 0; i < lines.length; i += 1) {
          const match = lineRe.exec(lines[i]);
          if (!match) continue;
          lastFieldIndex = i;
          const existing = INTENT_FIELD_ALIASES[match[2].trim()] ?? match[2].trim();
          const hit = merged.find(([name]) => name === existing && !matchedNames.has(name));
          if (hit) {
            lines[i] = `${match[1]}${match[2]}${match[3]}${hit[1]}`;
            matchedNames.add(hit[0]);
          }
        }
        const missingRows = merged.filter(([name]) => !matchedNames.has(name));
        if (missingRows.length) {
          const insertAt = lastFieldIndex >= 0 ? lastFieldIndex + 1 : lines.findIndex((line) => line.startsWith("## 参考资料"));
          const rows = missingRows.map(([name, value]) => `- **${name}**：${value}`);
          lines.splice(insertAt >= 0 ? insertAt : lines.length, 0, ...rows);
        }
        // F-78：Agent 判断「没依据」时也不能把模板的「（待补：…）」原样留给用户
        // （评估 S08 抓到过：字段没编是对的，但占位还在）。改成明确的待确认口径。
        for (let i = 0; i < lines.length; i += 1) {
          const match = lineRe.exec(lines[i]);
          if (!match) continue;
          if ((match[4] ?? "").includes("（待补")) {
            lines[i] = `${match[1]}${match[2]}${match[3]}（待确认：缺依据，已列问题问我）`;
          }
        }
        if (storyline) {
          // 写入或替换 `## 故事线（叙事结构）` 整段：多行不折叠，重复写是替换而不是追加。
          const bodyLines = storyline.split("\n").map((line) => line.replace(/\s+$/, ""));
          while (bodyLines.length && !bodyLines[bodyLines.length - 1].trim()) bodyLines.pop();
          const start = lines.findIndex((line) => /^##\s*故事线/.test(line));
          if (start >= 0) {
            let end = lines.length;
            for (let i = start + 1; i < lines.length; i += 1) {
              if (/^##\s/.test(lines[i])) { end = i; break; }
            }
            lines.splice(start + 1, Math.max(0, end - start - 1), "", ...bodyLines, "");
          } else {
            // 老 intent 没有这段：插在「## 参考资料」之后，保持模板顺序。
            const refAt = lines.findIndex((line) => /^##\s*参考资料/.test(line));
            const insertAt = refAt >= 0 ? lines.length : lines.length;
            lines.splice(insertAt, 0, "", "## 故事线（叙事结构）", "", ...bodyLines, "");
          }
        }
        mkdirSync(dirname(currentFile), { recursive: true });
        text = lines.join("\n").replace(/\n{3,}/g, "\n\n");
        writeFileSync(currentFile, text.endsWith("\n") ? text : `${text}\n`, "utf8");
        target = currentFile;
        record(`补意图字段：${merged.map(([name]) => name).join(" / ")}`);
      } else if (docId === "materials" || docId === "research" || docId === "feedback") {
        const file = DOC_DRAFT_PATH(deckDir, docId);
        const content = String(args.content ?? "").trim();
        if (!content) throw new Error(`${docId} 需要 content`);
        const mode = args.mode === "replace" ? "replace" : "append";
        const heading = DOC_TITLES[docId];
        const body = content.startsWith("---") ? content : `---\ntitle: ${deck.label ?? deck.id} · ${heading}\nstatus: draft\n---\n\n# ${heading}\n\n${content}`;
        // F-78：模板里的「（待补：…）」是给 Agent 看的占位；只要 Agent 写了正文，
        // 就把占位行清掉，否则用户看到的支撑材料仍像没做（评估 S08 抓到过）。
        const cleanPlaceholders = (text) =>
          text
            .replace(/^[>\s]*（待补：每条资料里的可引用事实[^\n]*\n?/gm, "")
            .replace(/\n{3,}/g, "\n\n");
        mkdirSync(dirname(file), { recursive: true });
        if (mode === "replace" || !existsSync(file)) {
          const next = cleanPlaceholders(body);
          writeFileSync(file, next.endsWith("\n") ? next : `${next}\n`, "utf8");
          text = `${heading} 已${mode === "replace" ? "重写" : "写入"}（工作副本）：${file}`;
        } else {
          const existing = readFileSync(file, "utf8");
          const next = `${existing.replace(/\s+$/, "")}\n\n${body.replace(/^---[\s\S]*?---\n\n/, "")}\n`;
          writeFileSync(file, cleanPlaceholders(next), "utf8");
          text = `${heading} 已追加（工作副本）：${file}`;
        }
        target = file;
        record(reason || `补${heading}`);
      } else {
        throw new Error(`不支持的 docId：${docId}（可选 intent / materials / research / feedback）`);
      }

      return {
        deckId: deck.id,
        docId,
        status: "ok",
        target,
        text: `${text}\n目标：${target}${localDeck ? "（本机 deck：intent 直接写源，其余文档写 .deck 工作副本）" : "（受控源 deck：只写 .deck 工作副本）"}`,
      };
    }),
  });

  // ── 2. deck_script_read ────────────────────────────────────────────────────
  tools.push({
    name: "deck_script_read",
    description:
      "只读读取 deck 源 script 的逐页行（页号 / 标题 / 这页回答 / 主张 / 来源），可指定页段。" +
      "首次调用会初始化该 deck 的 .deck 工作区（manifest + script 工作副本），不修改源。",
    parameters: {
      type: "object",
      properties: {
        deckId: { type: "string", description: "deck id，见 deck_source_overview" },
        from: { type: "number", description: "起始页号（含），缺省 = 1" },
        to: { type: "number", description: "结束页号（含），缺省 = 末页" },
      },
      required: ["deckId"],
      additionalProperties: false,
    },
    output: { schema: { type: "object", properties: { deckId: { type: "string" }, count: { type: "number" } } }, render: (_args, value) => [{ type: "text", text: String(value?.text ?? "") }] },
    execute: withToolEvent(store, "deck_script_read", async (args, exec) => {
      const adapter = adapterFor(args.deckId);
      const deck = workspace.ensureDeck(adapter, { styleBrief: config.styleBrief });
      const from = Number.isFinite(args.from) ? Math.max(1, Number(args.from)) : 1;
      const to = Number.isFinite(args.to) ? Number(args.to) : Number.MAX_SAFE_INTEGER;
      const slides = deck.slides.filter((slide) => slide.order >= from && slide.order <= to);
      // F-110：把「能不能出图」所依赖的 visualBrief 一并读出来，并附上当前待确认提案清单。
      // 否则 Agent 会凭上文里旧的提案状态作答（真机：整 deck 已全部落版，Agent 仍说「visualBrief 是空的、
      // 有一条 11:50 的提案还在 waiting-user」，让我去确认一条早就不存在的提案）。
      const currentScript = workspace.scriptCurrent(deck.id) ?? "";
      const pending = workspace.listProposals(deck.id, "waiting-user");
      const staleOf = (proposal) => {
        const range = scriptSectionRange(currentScript, proposal.page);
        const text = range ? currentScript.split("\n").slice(range.start, range.end).join("\n") : currentScript;
        return Boolean(proposal.before) && !text.includes(proposal.before);
      };
      const briefOf = (slide) => String(slide.visualBrief ?? "").trim();
      // F-181：逐页契约（角色 / 受众变化 / 关系 / 主张 / 证据）在 script 的 `**字段**：值` 行里；
      // 老 deck 没有 → 只显示「未填」，不报错、不阻断出图。
      const parsedForContract = parseSectionedPages(currentScript);
      const fieldsOfPage = new Map(parsedForContract.map((page) => [page.page, page.fields ?? {}]));
      const contractOfSlide = (slide) => validatePageContract(fieldsOfPage.get(slide.order) ?? {});
      const lines = slides.map((slide) => {
        const brief = briefOf(slide);
        const briefStyle = slide.visualBriefDesign ? `（写于 ${slide.visualBriefDesign} 风格）` : "（未记录写作风格）";
        const briefText = brief ? `${briefStyle}${brief.slice(0, 120)}${brief.length > 120 ? "…" : ""}` : "（空 · 这一页还不能出图）";
        const contract = contractOfSlide(slide);
        return `P${String(slide.order).padStart(2, "0")} [${slide.id}] ${slide.title}\n    回答：${slide.question || "—"}\n    主张：${slide.claim || "—"}\n    契约：${contractTag(contract)}\n    画面要求：${briefText}\n    来源：${slide.source || "—"}`;
      });
      // F-181：整本契约汇总（一页都没填时只提示一句，不刷屏）。
      const contractSummary = summarizeContracts(parsedForContract);
      const missingContractPages = contractSummary.perPage.filter((item) => !item.ok);
      const contractLine = contractSummary.untouched
        ? "逐页契约：这本 deck 还没填（老 deck 正常）——新写页时建议每页补 角色 / 受众变化 / 关系 / 证据。"
        : contractSummary.complete === contractSummary.pages
          ? ""
          : `逐页契约：${contractSummary.pages} 页里 ${contractSummary.complete} 页齐；缺的页：${missingContractPages.slice(0, 5).map((item) => `P${String(item.page).padStart(2, "0")}（${item.missing.join("、") || "有弱项"}）`).join("；")}${missingContractPages.length > 5 ? ` …等 ${missingContractPages.length} 页` : ""}`;
      // F-182（I-07）：正文里的数字要么挂事实 ID、要么标「示意数据」；没标注只提示，不阻断。
      const factAnalysis = analyzeFactLabels(
        parsedForContract.map((page) => ({
          page: page.page,
          // 正文取 script 现场内容（manifest 的 body 只在提案落版时同步，读稿要按 script 判事实）。
          body: page.fields?.["正文"] || page.content || "",
          claim: page.fields?.["主张"] || page.claim || "",
          evidence: readPageContract(page.fields ?? {}).证据,
        })),
      );
      const factLine = factSummaryLine(factAnalysis);
      const linked = linkedDesignStyle(deck.id);
      const styleLine = linked
        ? `\n关联风格：${linked.abbr} ${linked.name}（出图时自动带上它的 styleBrief；visualBrief 只写这页具体画面，不要另起一套视觉语言）\n  styleBrief：${linked.brief.slice(0, 200)}${linked.brief.length > 200 ? "…" : ""}${linked.constraints ? `\n  不要什么：${linked.constraints}` : ""}`
        : "\n关联风格：未关联 design（出图只带全局风格）";
      // F-124：写 / 改 script 前先看到目标字数（用户可改，auto 时自己判断）。
      const densityLineText = densityLine(deck.contentDensity);
      // F-158：写 script 前把 intent 的听众 / 目的和文案纪律一起读给 Agent，不然它会按「通用文案」写。
      const brief = readDeckBrief(adapter.sourceRoot);
      const skeleton = validateSkeleton(brief);
      const skeletonLine = brief.skeleton?.argument || brief.skeleton?.type || brief.skeleton?.order
        ? `论证骨架：${[brief.skeleton.argument, brief.skeleton.type, brief.skeleton.order].filter(Boolean).join(" ｜ ")}${brief.skeleton.keepThree ? `\n只留 3 页：${brief.skeleton.keepThree}` : ""}${skeleton.hint ? `\n⚠ ${skeleton.hint}` : ""}`
        : `⚠ ${skeleton.hint || "论证骨架还没写"}`;
      const briefLine = [
        brief.audience ? `听众：${brief.audience}（术语密度 / 例子 / 取舍按这个来）` : "听众：intent 里没写——先问用户，或按最小假设写明再写正文",
        brief.takeaway || brief.success ? `目的 / 成功标准：${brief.takeaway || brief.success}` : "",
        "文案纪律：标题≤16 字给判断（比喻 / 对仗 / 问句 / 「不是…而是…」都不要）；副标题一句话说这页回答什么；正文先结论后证据，按听众调术语密度；不写 AI 黑话（赋能 / 闭环 / 抓手 / 生态位 / 底层逻辑 / 范式）。",
        skeletonLine,
      ].filter(Boolean).join("\n");
      const pendingText = pending.length
        ? pending.map((proposal) => `  ${proposal.proposalId} · ${proposal.pageId} · ${proposal.field}${staleOf(proposal) ? " · 已过期（工作副本已变，需重新提案）" : ""}`).join("\n")
        : "  0 条（当前没有待确认提案；可以直接继续提案或出图，不要让用户去确认不存在的提案）";
      // F-120：工作副本与 manifest 错位时（历史镜像 bug），提案会落到错的页；读脚本时先体检并提示修复。
      const parsedWorking = parseSectionedPages(currentScript);
      const titleOfWorking = new Map(parsedWorking.map((page) => [page.page, String(page.title ?? "").trim()]));
      const outOfSync = deck.slides.filter((slide, index) => {
        const working = titleOfWorking.get(index + 1);
        return working != null && working !== String(slide.title ?? "").trim();
      });
      const syncLine = outOfSync.length
        ? `\n⚠ 工作副本与 manifest 有 ${outOfSync.length} 页错位（${outOfSync.map((slide, index) => `P${String(slide.order).padStart(2, "0")}`).join("、")}）——此时逐页提案会落到错页；先调用 deck_script_repair 修复。`
        : "";
      // F-138：主张超长 = 多半把正文写进了 claim（工作台卡片不显示主张，用户看不到改动）。
      const longClaimSlides = deck.slides.filter((slide) => [...String(slide.claim ?? "").trim()].length > 120);
      const longClaimLine = longClaimSlides.length
        ? `\n⚠ ${longClaimSlides.length} 页主张过长（${longClaimSlides.map((slide) => slide.id).join("、")}）：claim 是一句话判断，长内容应在正文 body。若确认写反了，用 deck_script_propose_edit 把长内容提到 body、claim 收成一句。`
        : "";
      const appendix = Array.isArray(deck.appendix?.rows) ? deck.appendix.rows : [];
      const appendixText = appendix.length
        ? `\n附录（${deck.appendix.count} 页，区间登记）：\n${appendix.map((row) => `  ${row.id}：${row.content}`).join("\n")}`
        : "";
      return {
        deckId: deck.id,
        count: slides.length,
        slideIds: slides.map((slide) => slide.id),
        pendingProposals: pending.map((proposal) => ({ proposalId: proposal.proposalId, pageId: proposal.pageId, field: proposal.field, stale: staleOf(proposal) })),
        text: `deck ${deck.id}（${deck.title}）· 正文 ${slides.length} 页${styleLine}\n${densityLineText}\n${briefLine}${contractLine ? `\n${contractLine}` : ""}${factLine ? `\n${factLine}` : ""}${syncLine}${longClaimLine}\n${lines.join("\n")}${appendixText}\n待确认提案（${pending.length}）：\n${pendingText}\n（源：${adapter.sourceRoot} · 只读）`,
        outOfSyncPages: outOfSync.map((slide) => slide.id),
      };
    }),
  });

  // ── 3. deck_script_propose_edit ────────────────────────────────────────────
  tools.push({
    name: "deck_script_propose_edit",
    description:
      "提出一页的修改提案：生成 unified diff 并进入 waiting-user，等用户在 Chat 里确认（或在工作台点确认）。" +
      "可改字段：title（标题）/ question（这页回答）/ body（正文，整页 3-5 句）/ claim（一句话判断，老 deck 兼容）/ visualBrief（画面要求，仅 manifest）；逐页契约另可用 角色 / 受众变化 / 关系 / 证据 四个字段（script 里的 `**角色**：…` 行，缺行时自动插在标题后）。" +
      "写整页内容时 title+question+body 一起提；多页 / 整本重写用 deck_script_propose_edits 一次提交；" +
      "严禁在用户确认前调用 deck_revision_confirm。",
    parameters: {
      type: "object",
      properties: {
        deckId: { type: "string" },
        page: { type: "number", description: "页号（script 里的 N）" },
        field: strEnum([...Object.keys(SCRIPT_FIELD_CELL), ...CONTRACT_FIELD_KEYS, "body", "visualBrief"]),
        newValue: { type: "string", description: "新值全文（不是增量）" },
        reason: { type: "string", description: "为什么改（写进 trace）" },
        reviewRef: { type: "string", description: "这条改动对应评审清单里的哪一条（如 R03；修订确认用）" },
        severity: { type: "string", description: "评审严重度 P0 / P1 / P2" },
        confidence: { type: "string", description: "证据置信度 A / B / C / D；C（原文找不到）不许提" },
        evidence: { type: "string", description: "评审给的原文证据（逐字，≥8 字）" },
      },
      required: ["deckId", "page", "field", "newValue"],
      additionalProperties: false,
    },
    output: { schema: { type: "object", properties: { proposalId: { type: "string" }, status: { type: "string" } } }, render: (_args, value) => [{ type: "text", text: String(value?.text ?? "") }] },
    execute: withToolEvent(store, "deck_script_propose_edit", async (args, exec) => {
      const adapter = adapterFor(args.deckId);
      const deck = workspace.ensureDeck(adapter, { styleBrief: config.styleBrief });
      const pageId = `p${String(Number(args.page)).padStart(2, "0")}`;
      const slide = deck.slides.find((candidate) => candidate.id === pageId);
      if (!slide) throw new Error(`页不存在：${pageId}（${deck.id} 共 ${deck.slides.length} 页）`);

      // F-138：主张（claim）只放一句话结论。把整段正文写进 claim 会让工作台看不到改动（卡片不显示主张），
      // 页面上也只剩旧正文——用户会以为「审批完还是不对」。这类字段写反必须在提案时就挡住。
      if (args.field === "claim") {
        const claimText = String(args.newValue ?? "").trim();
        const claimChars = [...claimText].length;
        if (claimChars > 120) {
          throw new Error(`claim（主张）只放一句话判断（建议 ≤ 60 字），这版 ${claimChars} 字，看起来是把正文写进了主张。长内容请用 field="body" 写「正文」；claim 留一句结论即可（工作台卡片会显示正文，主张不显示）。`);
        }
      }

      let before = "";
      let after = "";
      let kind = "";
      let diff = "";
      let taskInputRefs = [];

      if (args.field === "visualBrief") {
        kind = "manifest";
        before = slide.visualBrief ?? "";
        after = String(args.newValue ?? "").trim();
        if (!after) throw new Error("visualBrief 不能为空");
        diff = scriptDiff(`visualBrief: ${before}`, `visualBrief: ${after}`);
        taskInputRefs = [`deck:${deck.id}#${pageId}.visualBrief`];
      } else {
        kind = "script";
        const current = workspace.scriptCurrent(deck.id);
        if (current == null) throw new Error(`script 工作副本缺失：${deck.id}`);
        const applied = applyScriptFieldEdit(current, args.page, args.field, args.newValue);
        if (!applied) throw new Error(`script 里找不到页 ${args.page}（表格行 / 分节字段都没有匹配项）`);
        before = applied.oldRow;
        after = applied.newRow;
        diff = scriptDiff(current, applied.text);
        taskInputRefs = [`script:${deck.id}#P${String(args.page).padStart(2, "0")}#${args.field}`];
      }

      const proposal = {
        proposalId: newProposalId(),
        deckId: deck.id,
        pageId,
        page: Number(args.page),
        kind,
        field: args.field,
        before,
        after,
        // F-74：分节惯例的 after 是整行 `**标题**：值`，manifest 同步需要纯值。
        value: String(args.newValue ?? "").trim(),
        diff,
        reason: String(args.reason ?? ""),
        ...reviewMetaOf(args),
        status: "waiting-user",
        createdAt: proposalNow(),
        sessionId: sessionIdOf(exec),
        // F-114：记下这条 visualBrief 是在哪个关联风格下写的，换风格时才能确定哪些页需要刷新。
        ...(args.field === "visualBrief" ? { writtenUnderDesign: linkedDesignStyle(deck.id)?.abbr ?? null } : {}),
      };
      // F-108 修订：同一页同一字段被重复提案时，旧提案作废（superseded）。
      // 否则脚本页会出现「两套标题」——两轮提案都挂在同一页上，用户分不清哪个算数。
      const superseded = workspace
        .listProposals(deck.id, "waiting-user")
        .filter((item) => item.pageId === pageId && item.field === args.field && item.proposalId !== proposal.proposalId);
      for (const stale of superseded) {
        workspace.saveProposal({ ...stale, status: "superseded", supersededBy: proposal.proposalId, decidedAt: proposal.createdAt, decidedBy: "agent" });
      }
      workspace.saveProposal(proposal);

      const task = store.taskCreate({
        kind: "edit",
        deckId: deck.id,
        slideIds: [pageId],
        actor: "agent",
        sessionId: proposal.sessionId,
        inputRefs: taskInputRefs,
      });
      store.taskUpdate(task.taskId, { status: "running", actor: "agent" });
      store.taskUpdate(task.taskId, {
        status: "waiting-user",
        actor: "agent",
        inputRefs: [...taskInputRefs, `proposal:${proposal.proposalId}`],
      });
      store.recordEvent({
        type: "deck.edit",
        sessionId: proposal.sessionId,
        taskId: task.taskId,
        deckId: deck.id,
        slideIds: [pageId],
        actor: "agent",
        status: "waiting-user",
        payload: { proposalId: proposal.proposalId, field: args.field, reason: proposal.reason, diff },
      });

      const styleHints = scriptStyleHints({
        field: args.field,
        value: String(args.newValue ?? ""),
        title: slide.title,
        question: slide.question,
        body: slide.body,
      });
      const pendingNow = workspace.listProposals(deck.id, "waiting-user");
      const pendingForPage = pendingNow.filter((item) => item.pageId === pageId).length;
      const queueNote = `队列：本页 ${pendingForPage} 条 · 整个 deck ${pendingNow.length} 条待确认（同一页同一字段只认最新一条）。`;
      const supersededNote = superseded.length ? `旧的 ${superseded.length} 条同字段提案已自动作废。` : "";
      return {
        proposalId: proposal.proposalId,
        taskId: task.taskId,
        deckId: deck.id,
        slideIds: [pageId],
        status: "waiting-user",
        pendingCount: pendingNow.length,
        diff,
        styleHints,
        text: `提案 ${proposal.proposalId}（${pageId} · ${args.field}）已进入 waiting-user：\n\n${diff || "(无文本差异)"}\n${queueNote}${supersededNote ? ` ${supersededNote}` : ""}${styleHints.length ? `\n文案提醒（不阻断提案，建议先改）：\n${styleHints.map((hint) => `- ${hint}`).join("\n")}` : ""}\n请在 Chat 里确认（我会引用提案号）；确认后才写入 revision。`,
      };
    }),
  });

  // ── 3.5 deck_script_add_page ───────────────────────────────────────────────
  tools.push({
    name: "deck_script_add_page",
    description:
      "给 deck 追加页（F-99：页数可以在对话里改）。只追加到最后一页之后，不重排既有页；" +
      "生成 `### Pxx · 标题` 分节 + diff 并进入 waiting-user，等用户在 Chat 里确认后再用 " +
      "deck_revision_confirm 落 revision。一次可以加多页（pages 数组，或 count + titles）。" +
      "不支持在中间插入 / 删除 / 换位——那会让 slides/<pageId> 版本目录与 asset 错配。",
    parameters: {
      type: "object",
      properties: {
        deckId: { type: "string" },
        count: { type: "number", description: "追加页数（默认 1；给了 pages 时忽略）" },
        titles: { type: "array", items: { type: "string" }, description: "新页标题（按顺序；缺的补占位）" },
        pages: {
          type: "array",
          description: "逐页内容（title / question / claim / body / visualBrief），优先于 count + titles",
          items: {
            type: "object",
            properties: {
              title: { type: "string" },
              question: { type: "string" },
              claim: { type: "string" },
              body: { type: "string" },
              visualBrief: { type: "string" },
            },
            additionalProperties: false,
          },
        },
        reason: { type: "string", description: "为什么加页（写进 trace）" },
      },
      required: ["deckId"],
      additionalProperties: false,
    },
    output: { schema: { type: "object", properties: { proposalId: { type: "string" }, status: { type: "string" }, pageCount: { type: "number" } } }, render: (_args, value) => [{ type: "text", text: String(value?.text ?? "") }] },
    execute: withToolEvent(store, "deck_script_add_page", async (args, exec) => {
      const adapter = adapterFor(args.deckId);
      const deck = workspace.ensureDeck(adapter, { styleBrief: config.styleBrief });
      const current = workspace.scriptCurrent(deck.id);
      if (current == null) throw new Error(`script 工作副本缺失：${deck.id}`);
      const explicit = Array.isArray(args.pages) ? args.pages.filter(Boolean) : [];
      const requested = explicit.length
        ? explicit
        : Array.from({ length: Math.max(1, Math.min(Number(args.count) || 1, 20)) }, (_, offset) => ({
            title: Array.isArray(args.titles) ? String(args.titles[offset] ?? "") : "",
          }));
      if (requested.length > 20) throw new Error("一次最多追加 20 页（更多请拆成两次提案）");
      const existing = workspace.scriptPageNumbers(current);
      const startPage = (existing.length ? Math.max(...existing) : deck.slides.length) + 1;
      const specs = requested.map((page, offset) => {
        const pageNo = startPage + offset;
        return {
          page: pageNo,
          title: String(page?.title ?? "").trim() || `待补章节 ${pageNo}`,
          question: String(page?.question ?? "").trim(),
          claim: String(page?.claim ?? "").trim(),
          body: String(page?.body ?? "").trim(),
          visualBrief: String(page?.visualBrief ?? "").trim(),
        };
      });
      const preview = workspace.appendScriptPages(current, specs);
      const pageIds = specs.map((spec) => `p${String(spec.page).padStart(2, "0")}`);
      const diff = scriptDiff(current, preview.text);
      const proposal = {
        proposalId: newProposalId(),
        deckId: deck.id,
        pageId: pageIds[0],
        page: specs[0].page,
        pageIds,
        kind: "script-add-page",
        field: "add-page",
        before: "",
        after: preview.text,
        // F-74 的 value 语义是「单字段纯值」，追加页没有单值，留空。
        value: "",
        pages: specs,
        pageCountBefore: deck.slides.length,
        pageCountAfter: preview.pageCount,
        diff,
        reason: String(args.reason ?? ""),
        status: "waiting-user",
        createdAt: proposalNow(),
        sessionId: sessionIdOf(exec),
      };
      workspace.saveProposal(proposal);

      const task = store.taskCreate({
        kind: "edit",
        deckId: deck.id,
        slideIds: pageIds,
        actor: "agent",
        sessionId: proposal.sessionId,
        inputRefs: [`script:${deck.id}#append-page`],
      });
      store.taskUpdate(task.taskId, { status: "running", actor: "agent" });
      store.taskUpdate(task.taskId, {
        status: "waiting-user",
        actor: "agent",
        inputRefs: [`script:${deck.id}#append-page`, `proposal:${proposal.proposalId}`],
      });
      store.recordEvent({
        type: "deck.edit",
        sessionId: proposal.sessionId,
        taskId: task.taskId,
        deckId: deck.id,
        slideIds: pageIds,
        actor: "agent",
        status: "waiting-user",
        payload: { proposalId: proposal.proposalId, field: "add-page", reason: proposal.reason, diff, pages: specs.map((spec) => spec.page) },
      });

      return {
        proposalId: proposal.proposalId,
        taskId: task.taskId,
        deckId: deck.id,
        slideIds: pageIds,
        status: "waiting-user",
        pageCount: preview.pageCount,
        diff,
        text:
          `追加页提案 ${proposal.proposalId} 已进入 waiting-user：${deck.slides.length} 页 → ${preview.pageCount} 页` +
          `（新增 ${pageIds.join(" / ")}，只追加到末尾，既有页不动）。\n\n${diff || "(无文本差异)"}\n` +
          `请在 Chat 里确认；确认后才写 script revision + manifest。`,
      };
    }),
  });

  // ── 4. deck_revision_confirm ───────────────────────────────────────────────
  tools.push({
    name: "deck_revision_confirm",
    description:
      "对 waiting-user 的提案执行用户裁决。confirmed=true 表示用户已确认（Chat 明确同意或工作台点了确认）；" +
      "confirmationQuote 引用用户原话最好，没带也能落版（会标 quoteMissing 留痕）——不要为了凑原话反复问用户；" +
      "写入 script revision（copy-on-write，不覆盖旧版）并同步 manifest。" +
      "确认支持脚本字段（含 body 正文）与 visualBrief / 追加页；confirmed=false 记为用户驳回。",
    parameters: {
      type: "object",
      properties: {
        proposalId: { type: "string" },
        confirmed: { type: "boolean" },
        confirmationQuote: { type: "string", description: "确认时用户的原话（可选；缺省也能落版，会标 quoteMissing 留痕）" },
      },
      required: ["proposalId", "confirmed"],
      additionalProperties: false,
    },
    output: { schema: { type: "object", properties: { proposalId: { type: "string" }, status: { type: "string" } } }, render: (_args, value) => [{ type: "text", text: String(value?.text ?? "") }] },
    execute: withToolEvent(store, "deck_revision_confirm", async (args, exec) => {
      const proposal = workspace.proposal(String(args.proposalId ?? ""));
      if (!proposal) throw new Error(`提案不存在：${args.proposalId}`);
      // F-108：落版逻辑抽到 lib/proposal-decision.js，工作台「确认落版」按钮与工具共用。
      return decideProposal({
        store,
        workspace,
        proposal,
        confirmed: args.confirmed === true,
        quote: String(args.confirmationQuote ?? ""),
        sessionId: sessionIdOf(exec),
        syncScriptToSource,
      });
    }),
  });


  // ── 4.5 deck_draft_rollback（F-173 首稿自动落版的安全阀）──────────────────
  tools.push({
    name: "deck_draft_rollback",
    description:
      "回滚首稿：把稿子恢复到「首稿自动落版之前」的内容（追加一条新 revision，旧版全部保留）。" +
      "只在这份 deck 的最新 revision 是自动落版时可用；正式修订（用户确认过的版本）不适用，走提案流程。" +
      "用户说「这首稿不要了 / 回到之前 / 重新起草」时用它，然后报告回到了哪一版。",
    parameters: {
      type: "object",
      properties: {
        deckId: { type: "string" },
        note: { type: "string", description: "回滚原因（记进 revision 说明与事件，可选）" },
      },
      required: ["deckId"],
      additionalProperties: false,
    },
    output: { schema: { type: "object", properties: { deckId: { type: "string" }, revision: { type: "string" } } }, render: (_args, value) => [{ type: "text", text: String(value?.text ?? "") }] },
    execute: withToolEvent(store, "deck_draft_rollback", async (args, exec) => {
      const deckId = String(args.deckId ?? "").trim();
      if (!deckId) throw new Error("缺少 deckId");
      const deck = workspace.manifest(deckId);
      if (!deck) throw new Error(`未知 deck：${deckId}`);
      const latest = latestAutoland(workspace, deckId);
      if (!latest) throw new Error(`没有可回滚的首稿：${deckId} 最新 revision 不是自动落版（或已经回滚过）。正式修订请走提案流程。`);
      const result = rollbackFirstDraft({ workspace, deckId, note: String(args.note ?? "") });
      const current = workspace.scriptCurrent(deckId) ?? "";
      const sourceSync = typeof syncScriptToSource === "function" ? syncScriptToSource(deckId, current, null) : null;
      store.recordEvent({
        type: "deck.edit",
        sessionId: sessionIdOf(exec),
        taskId: null,
        deckId,
        slideIds: [],
        actor: "user",
        status: "succeeded",
        payload: { outcome: "autoland-rollback", fromRevision: result.beforeRevision, revision: result.revision, note: String(args.note ?? "") },
      });
      return {
        deckId,
        revision: result.revision,
        beforeRevision: result.beforeRevision,
        ...(sourceSync ? { sourceSync } : {}),
        text:
          `首稿已回滚：${result.beforeRevision} 的自动落版作废，稿子恢复到落版前内容，新 revision ${result.revision}（旧版都保留，可再回看）。` +
          `${sourceSync ? (sourceSync.ok ? "源 script.md 已回写并提交。" : `源 script.md 已回写，git 未提交：${sourceSync.error}。`) : ""}` +
          `\n接下来按用户要的方向重新起草；重新落版时仍走首稿自动落版（此时又回到「没有已落版稿子」的状态）。`,
      };
    }),
  });

  // ── 5. deck_render_page ────────────────────────────────────────────────────
  tools.push({
    name: "deck_render_page",
    description:
      "对一页出图：slide 内容 → prompt（含全局视觉 preset）→ QA 门禁 → image adapter。" +
      "一次调用只出一页；用户点名多页 / 整套时按页序连续调用即可——批量是正常用法，不用每页停下来等确认。" +
      "版本 copy-on-write（image.svg/png + prompt.txt + qa.json），失败不覆盖旧版本。" +
      "visualBrief 为空也可以直接出：系统用标题 / 回答 / 正文拼「自动草稿」prompt 并在 qa.json 标 briefSource=draft。" +
      "想一次到位就带上 visualBrief 参数（只写这一页的画面要求，随出图一起落 manifest，不占提案队列）。",
    parameters: {
      type: "object",
      properties: {
        deckId: { type: "string" },
        page: { type: "number" },
        size: { type: "string", description: "覆盖默认尺寸（如 2560x1440）" },
      },
      required: ["deckId", "page"],
      additionalProperties: false,
    },
    output: { schema: { type: "object", properties: { revision: { type: "string" }, imagePath: { type: "string" } } }, render: (_args, value) => [{ type: "text", text: String(value?.text ?? "") }] },
    execute: withToolEvent(store, "deck_render_page", async (args, exec) => {
      // F-137：出图不再要求「先调 deck_script_read」——直接 ensureDeck，删掉无意义的调用顺序。
      const renderAdapter = adapterFor(args.deckId);
      const deck = workspace.ensureDeck(renderAdapter, { styleBrief: config.styleBrief });
      const pageId = `p${String(Number(args.page)).padStart(2, "0")}`;
      const slide = deck.slides.find((candidate) => candidate.id === pageId);
      if (!slide) throw new Error(`页不存在：${pageId}（${deck.id} 共 ${deck.slides.length} 页）`);
      const sessionId = sessionIdOf(exec);
      const signal = exec?.signal;
      const task = store.taskCreate({
        kind: "render",
        deckId: deck.id,
        slideIds: [pageId],
        actor: "agent",
        sessionId,
        inputRefs: [`deck:${deck.id}#${pageId}`],
      });
      store.taskUpdate(task.taskId, { status: "running", actor: "agent" });

      const tryFinish = async (result) => {
        store.taskUpdate(task.taskId, { status: result.status, actor: "agent", error: result.error ?? null, outputRefs: result.outputRefs ?? [] });
        return result.value;
      };

      try {
        // F-137：内联 visualBrief（只写 manifest，不占提案队列）——一次调用补 brief + 出图。
        const inlineBrief = String(args.visualBrief ?? "").trim();
        let briefSource = "existing";
        if (inlineBrief) {
          slide.visualBrief = inlineBrief;
          slide.visualBriefDesign = linkedDesignStyle(deck.id)?.abbr ?? null;
          workspace.saveManifest(deck);
          briefSource = "inline";
          store.recordEvent({ type: "deck.brief", sessionId, taskId: task.taskId, deckId: deck.id, slideIds: [pageId], actor: "agent", status: "succeeded", payload: { source: "inline", chars: inlineBrief.length } });
        }
        const size = String(args.size ?? config.render.size);
        const linked = linkedDesignStyle(deck.id);
        // F-137：没有 visualBrief 不再硬拒——用标题 / 回答 / 正文拼「自动草稿」，旧版本不覆盖，重出成本可控。
        if (!String(slide.visualBrief ?? "").trim()) {
          briefSource = "draft";
          const draft = [`第 ${slide.order ?? args.page} 页：${slide.title ?? ""}`, String(slide.question ?? "").trim(), String(slide.body ?? "").trim().slice(0, 160)]
            .filter(Boolean).join("\n");
          slide.visualBrief = draft || "整页信息图，按标题与正文排版";
          store.recordEvent({ type: "deck.brief", sessionId, taskId: task.taskId, deckId: deck.id, slideIds: [pageId], actor: "system", status: "succeeded", payload: { source: "draft" } });
        }
        // 风格 = deck 关联 design 的 styleBrief（+ 它的「不要什么」）；没关联才退回全局配置。
        const styleBrief = linked
          ? [linked.brief, linked.constraints ? `不要什么：${linked.constraints}` : ""].filter(Boolean).join("\n")
          : config.styleBrief;
        const prompt = buildPrompt(slide, styleBrief, { brief: readDeckBrief(renderAdapter.sourceRoot) });
        const qa = qaCheck(prompt, size);
        if (!qa.ok) {
          store.recordEvent({ type: "deck.qa", sessionId, taskId: task.taskId, deckId: deck.id, slideIds: [pageId], actor: "system", status: "failed", payload: { gate: "qa", qa } });
          return tryFinish({ status: "failed", error: "qa-gate", value: { taskId: task.taskId, deckId: deck.id, slideIds: [pageId], qa, text: `QA 门禁未通过：${qa.checks.filter((check) => !check.ok).map((check) => `${check.name}(${check.detail})`).join("；")}` } });
        }

        const outDir = join(workspace.slideDir(deck.id, pageId), "versions", nextRevision(workspace.slideDir(deck.id, pageId)));
        mkdirSync(outDir, { recursive: true });
        writeFileSync(join(outDir, "prompt.txt"), prompt, "utf8");
        writeFileSync(join(outDir, "content.json"), `${JSON.stringify(slide, null, 2)}\n`, "utf8");

        // 出图节点/模型按当前 deck 的生效选择解析（ADR-0010）；没有 resolveRender 的老调用退回 config.render。
        const runtime = typeof resolveRender === "function"
          ? resolveRender(deck.id)
          : { renderer: null, apiKey: "", model: config.render.model, endpoint: config.render.endpoint, nodeName: "", label: config.render.model, mode: config.render.mode, timeoutMs: config.render.timeoutMs };
        if (!runtime.renderer) {
          const { selectRenderer } = await import("./render.js");
          const picked = selectRenderer(config.render, env);
          runtime.renderer = picked.renderer;
          runtime.apiKey = picked.apiKey;
        }
        const briefStale = Boolean(slide.visualBriefDesign && linked && slide.visualBriefDesign !== linked.abbr);
        const renderResult = await runtime.renderer.render({
          prompt,
          slideId: pageId,
          revision: outDir.split("/").pop(),
          model: runtime.model,
          endpoint: runtime.endpoint,
          size,
          outDir,
          apiKey: runtime.apiKey,
          timeoutMs: runtime.timeoutMs,
          signal,
        });
        writeFileSync(join(outDir, "qa.json"), `${JSON.stringify({ ok: true, checks: qa.checks, briefSource, provenance: { model: renderResult.model, endpoint: renderResult.endpoint, size: renderResult.size, provider: renderResult.provider, durationMs: renderResult.durationMs, node: runtime.nodeName || null }, renderedAt: new Date().toISOString() }, null, 2)}\n`, "utf8");
        store.recordEvent({
          type: "deck.render",
          sessionId,
          taskId: task.taskId,
          deckId: deck.id,
          slideIds: [pageId],
          actor: "tool",
          status: "succeeded",
          payload: { revision: outDir.split("/").pop(), imagePath: renderResult.imagePath, provider: renderResult.provider, model: renderResult.model, endpoint: renderResult.endpoint, node: runtime.nodeName || null, size: renderResult.size, durationMs: renderResult.durationMs, designAbbr: linked?.abbr ?? null, briefDesign: slide.visualBriefDesign ?? null },
        });
        store.recordEvent({ type: "deck.qa", sessionId, taskId: task.taskId, deckId: deck.id, slideIds: [pageId], actor: "system", status: "succeeded", payload: { qa } });
        const revision = outDir.split("/").pop();
        return tryFinish({
          status: "succeeded",
          outputRefs: [`revision:${deck.id}/${pageId}/${revision}`, `asset:${renderResult.imagePath}`],
          value: {
            taskId: task.taskId,
            deckId: deck.id,
            slideIds: [pageId],
            revision,
            imagePath: renderResult.imagePath,
            provider: renderResult.provider,
            node: runtime.nodeName || null,
            model: renderResult.model,
            durationMs: renderResult.durationMs,
            designAbbr: linked?.abbr ?? null,
            briefStale,
            text: `${pageId} ${revision} 出图完成（${renderResult.provider} · ${runtime.nodeName ? `${runtime.nodeName} / ` : ""}${renderResult.model} · ${renderResult.size} · ${renderResult.durationMs}ms）\n风格：${linked ? `${linked.abbr} ${linked.name}（来自 deck 关联的 design）` : "未关联 design，用全局风格"}${briefSource === "draft" ? "\n⚠ 这页原来没有 visualBrief，这次用的是「标题 + 正文」自动草稿 prompt；想更贴风格，可以再补一条 visualBrief 重出（旧图不覆盖）。" : ""}${briefStale ? `\n⚠ 这页画面要求写于 ${slide.visualBriefDesign} 风格下（当前 ${linked?.abbr}），可能风格混搭；想要更好效果可先让 Agent 按新风格重写画面要求。` : ""}\n图片：${renderResult.imagePath}`,
          },
        });
      } catch (error) {
        const message = String(error?.message ?? error);
        const hint = /超时|timeout|aborted/i.test(message)
          ? `\n这次是节点响应慢（超时 ${Math.round((config.render.timeoutMs ?? 420_000) / 1000)}s），不是内容问题：旧版本未被覆盖，等 1-2 分钟重试这一页即可。`
          : "";
        store.recordEvent({ type: "deck.render", sessionId, taskId: task.taskId, deckId: deck.id, slideIds: [pageId], actor: "tool", status: "failed", payload: { error: message } });
        return tryFinish({ status: "failed", error: message, value: { taskId: task.taskId, deckId: deck.id, slideIds: [pageId], text: `出图失败（旧版本未受影响）：${message}${hint}` } });
      }
    }),
  });

  // ── 5b. deck_image_edit（修图：以图生图改局部，F-144） ─────────────────────
  const IMAGE_SOURCE_RE = /\.(png|jpe?g|webp|svg)$/i;

  function resolvePageNumber(value) {
    const match = /^(?:p)?0*(\d+)$/i.exec(String(value ?? "").trim());
    if (!match) throw new Error(`page 只接受页号（如 3 或 "P03"），收到：${value}`);
    return Number(match[1]);
  }

  /** 这页最新版本的图（vNNN/image.png|jpg|webp|svg）。 */
  function latestRevisionImage(slideDir) {
    const versionsDir = join(slideDir, "versions");
    if (!existsSync(versionsDir)) return null;
    const revisions = readdirSync(versionsDir).filter((name) => /^v\d+$/.test(name)).sort().reverse();
    for (const revision of revisions) {
      const dir = join(versionsDir, revision);
      for (const name of readdirSync(dir)) {
        if (/^image\.(png|jpe?g|webp|svg)$/i.test(name)) return { revision, filePath: join(dir, name) };
      }
    }
    return null;
  }

  /** deck 源目录内的底图路径：只收图片后缀，禁止绝对路径 / 目录穿越。 */
  function resolveSourceImage(sourceRoot, sourceImage) {
    const rel = String(sourceImage ?? "").trim().replace(/^\.\//, "");
    if (!rel) throw new Error("sourceImage 为空");
    if (!IMAGE_SOURCE_RE.test(rel)) throw new Error(`sourceImage 只支持 png / jpg / jpeg / webp / svg：${rel}`);
    if (rel.startsWith("/") || rel.split("/").includes("..")) throw new Error(`sourceImage 必须是 deck 源目录内的相对路径，不能穿越：${rel}`);
    const root = resolve(sourceRoot);
    const target = resolve(root, rel);
    if (target !== root && !target.startsWith(root + sep)) throw new Error(`sourceImage 越出 deck 源目录：${rel}`);
    if (!existsSync(target)) throw new Error(`sourceImage 不存在：${rel}（相对 deck 源目录：${sourceRoot}）`);
    return target;
  }

  tools.push({
    name: "deck_image_edit",
    description:
      "修图专用（以图生图）：拿一张已有图片当底图，只改你点名的地方——去水印 / 改标题 / 删掉某个元素 / 换背景 / 补细节，" +
      "输出新版本，旧图不覆盖。一次调用修一张（多张就按页调多次）。" +
      "底图二选一：page（页号，取这页最新版本的图）或 sourceImage（deck 源目录里的图片路径，如 assets/logo.png）。" +
      "只改画面、不改 script / 正文（要改文案先用提案）；整页重新出图用 deck_render_page，不要拿这个工具重跑整页。",
    parameters: {
      type: "object",
      properties: {
        deckId: { type: "string" },
        page: { type: "string", description: "页号（如 3 或 \"P03\"），用这页最新版本的图当底图" },
        sourceImage: { type: "string", description: "deck 源目录内的图片相对路径（png/jpg/jpeg/webp/svg），如 assets/logo.png" },
        instruction: { type: "string", description: "要改什么，写局部、写具体（如：把标题改大两号，去掉右下角水印）" },
        size: { type: "string", description: "输出尺寸，默认沿用出图设置" },
      },
      required: ["deckId", "instruction"],
      additionalProperties: false,
    },
    output: { schema: { type: "object", properties: { revision: { type: "string" }, imagePath: { type: "string" } } }, render: (_args, value) => [{ type: "text", text: String(value?.text ?? "") }] },
    execute: withToolEvent(store, "deck_image_edit", async (args, exec) => {
      const instruction = String(args.instruction ?? "").trim();
      if (instruction.length < 4) throw new Error("instruction 太短：写清楚改哪里、改成什么（例：把标题改大两号，去掉右下角水印）");
      const hasPage = args.page !== undefined && args.page !== null && String(args.page).trim() !== "";
      const hasSource = String(args.sourceImage ?? "").trim() !== "";
      if (!hasPage && !hasSource) throw new Error("要给 page（页号）或 sourceImage（底图路径），二选一");
      if (hasPage && hasSource) throw new Error("page 与 sourceImage 只能二选一：修页面图传 page，修素材图传 sourceImage");
      const adapter = adapterFor(args.deckId);
      const deck = workspace.ensureDeck(adapter, { styleBrief: config.styleBrief });
      const sessionId = sessionIdOf(exec);
      const signal = exec?.signal;
      const size = String(args.size ?? config.render.size);
      const pageNo = hasPage ? resolvePageNumber(args.page) : null;
      const pageId = pageNo === null ? null : `p${String(pageNo).padStart(2, "0")}`;
      const slide = pageId ? deck.slides.find((candidate) => candidate.id === pageId) : null;
      if (pageId && !slide) throw new Error(`页不存在：${pageId}（${deck.id} 共 ${deck.slides.length} 页）`);
      // 底图先解析：参数/路径错了要直接抛给 Agent（不是包成一次「修图失败」的 task）。
      let source;
      if (pageId) {
        const latest = latestRevisionImage(workspace.slideDir(deck.id, pageId));
        if (!latest) throw new Error(`${pageId} 还没有可修的图：先 deck_render_page 出图（或用 sourceImage 指定底图）`);
        source = latest;
      } else {
        source = { revision: null, filePath: resolveSourceImage(adapter.sourceRoot, args.sourceImage) };
      }
      const sourceRel = relative(adapter.sourceRoot, source.filePath) || source.filePath;
      const task = store.taskCreate({ kind: "edit", deckId: deck.id, slideIds: pageId ? [pageId] : [], actor: "agent", sessionId, inputRefs: [pageId ? `deck:${deck.id}#${pageId}` : `asset:${sourceRel}`] });
      store.taskUpdate(task.taskId, { status: "running", actor: "agent" });
      const finish = (result) => {
        store.taskUpdate(task.taskId, { status: result.status, actor: "agent", error: result.error ?? null, outputRefs: result.outputRefs ?? [] });
        return result.value;
      };
      try {
        const prompt = `# 修图（局部修改，其余保持不变）\n${instruction}\n\n要求：只改点名的地方；不换整页构图；图里的文字保持可读，不要新增没提到的文字或 logo。`;
        const qa = qaCheck(prompt, size);
        if (!qa.ok) {
          store.recordEvent({ type: "deck.qa", sessionId, taskId: task.taskId, deckId: deck.id, slideIds: pageId ? [pageId] : [], actor: "system", status: "failed", payload: { gate: "qa", qa } });
          return finish({ status: "failed", error: "qa-gate", value: { taskId: task.taskId, qa, text: `修图前 QA 门禁未通过：${qa.checks.filter((check) => !check.ok).map((check) => `${check.name}(${check.detail})`).join("；")}` } });
        }
        // 输出位置：页面修图 → 新版本目录（copy-on-write）；素材修图 → .deck/edits/ 独立产物。
        let outDir;
        let revision = "";
        if (pageId) {
          revision = nextRevision(workspace.slideDir(deck.id, pageId));
          outDir = join(workspace.slideDir(deck.id, pageId), "versions", revision);
        } else {
          const stamp = new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14);
          outDir = join(workspace.deckDir(deck.id), "edits", `${stamp}-${Math.random().toString(36).slice(2, 6)}`);
        }
        mkdirSync(outDir, { recursive: true });
        writeFileSync(join(outDir, "prompt.txt"), prompt, "utf8");
        if (pageId) writeFileSync(join(outDir, "content.json"), `${JSON.stringify(slide, null, 2)}\n`, "utf8");
        const runtime = typeof resolveRender === "function"
          ? resolveRender(deck.id)
          : { renderer: null, apiKey: "", model: config.render.model, endpoint: config.render.endpoint, editEndpoint: editEndpointFor(config.render.endpoint), editTransport: "multipart", nodeName: "", timeoutMs: config.render.timeoutMs, mode: config.render.mode };
        const fake = runtime.mode !== "real" || runtime.renderer?.provider === "fake";
        const info = imageMime(extname(source.filePath));
        if (!fake && !info) throw new Error(`修图底图需要 png / jpg / jpeg / webp（当前：${extname(source.filePath) || "未知"}）`);
        const renderer = fake ? createFakeEditRenderer() : createRealEditRenderer();
        const editResult = await renderer.edit({
          filePath: source.filePath,
          ext: extname(source.filePath),
          outDir,
          prompt,
          model: runtime.model,
          endpoint: runtime.editEndpoint || editEndpointFor(runtime.endpoint),
          size,
          apiKey: runtime.apiKey,
          timeoutMs: runtime.timeoutMs,
          signal,
          transport: runtime.editTransport || "multipart",
        });
        writeFileSync(join(outDir, "qa.json"), `${JSON.stringify({
          ok: true,
          checks: qa.checks,
          kind: "edit",
          edit: { instruction, sourceRevision: source.revision, sourceImage: sourceRel },
          provenance: { model: runtime.model, endpoint: editResult.endpoint || null, size: editResult.size || size, provider: editResult.provider, durationMs: editResult.durationMs, node: runtime.nodeName || null, transport: editResult.transport || "n/a" },
          editedAt: new Date().toISOString(),
        }, null, 2)}\n`, "utf8");
        store.recordEvent({
          type: "deck.render",
          sessionId,
          taskId: task.taskId,
          deckId: deck.id,
          slideIds: pageId ? [pageId] : [],
          actor: "tool",
          status: "succeeded",
          payload: { edit: true, revision: revision || null, imagePath: editResult.imagePath, instruction, sourceRevision: source.revision, sourceImage: sourceRel, provider: editResult.provider, model: runtime.model, node: runtime.nodeName || null, size: editResult.size || size, durationMs: editResult.durationMs },
        });
        store.recordEvent({ type: "deck.qa", sessionId, taskId: task.taskId, deckId: deck.id, slideIds: pageId ? [pageId] : [], actor: "system", status: "succeeded", payload: { qa } });
        const where = pageId ? `${pageId} → ${revision}` : "独立产物（不挂页面）";
        return finish({
          status: "succeeded",
          outputRefs: pageId ? [`revision:${deck.id}/${pageId}/${revision}`, `asset:${editResult.imagePath}`] : [`asset:${editResult.imagePath}`],
          value: {
            taskId: task.taskId,
            deckId: deck.id,
            slideIds: pageId ? [pageId] : [],
            revision: revision || null,
            imagePath: editResult.imagePath,
            provider: editResult.provider,
            model: runtime.model,
            durationMs: editResult.durationMs,
            sourceRevision: source.revision,
            text: `修图完成：${where}（${editResult.provider} · ${runtime.nodeName ? `${runtime.nodeName} / ` : ""}${runtime.model} · ${size}）\n改了什么：${instruction}\n底图：${sourceRel}${source.revision ? `（${source.revision}）` : ""}\n图片：${editResult.imagePath}\n旧版本保留，没有覆盖。${pageId ? "" : "\n注意：这是独立产物，不会自动变成某一页的图；要挂到页面上得重新出一版整页图，或把这张图当参考再出。"}`,
          },
        });
      } catch (error) {
        const message = String(error?.message ?? error);
        store.recordEvent({ type: "deck.render", sessionId, taskId: task.taskId, deckId: deck.id, slideIds: pageId ? [pageId] : [], actor: "tool", status: "failed", payload: { edit: true, error: message, instruction } });
        return finish({ status: "failed", error: message, value: { taskId: task.taskId, deckId: deck.id, slideIds: pageId ? [pageId] : [], text: `修图失败（旧版本未受影响）：${message}` } });
      }
    }),
  });

  // ── 6. deck_docs_check / deck_docs_scaffold ────────────────────────────────
  const deckRevisions = (deckId) => {
    const dir = join(workspace.deckDir(deckId), "script", "revisions");
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter((name) => /^v\d+\.md$/.test(name))
      .sort()
      .reverse()
      .map((name) => {
        const revision = name.replace(/\.md$/, "");
        const noteFile = join(dir, `${revision}.note.txt`);
        return { revision, savedAt: statSync(join(dir, name)).mtime.toISOString(), note: existsSync(noteFile) ? readFileSync(noteFile, "utf8").trim() : "" };
      });
  };

  const deckDocsOf = (deckId) => {
    const adapter = adapters.find((item) => item.id === deckId) ?? null;
    if (!adapter) throw new Error(`unknown deck: ${deckId}`);
    return resolveDeckDocs({ adapter, deckDir: workspace.deckDir(deckId), render: config.render, revisions: deckRevisions(deckId), events: store.events(200).filter((event) => event.deckId === deckId) });
  };

  // ── F-140：内置 FAQ（产品操作问答） ─────────────────────────────────────
  tools.push({
    name: "deck_help",
    description:
      "查工作台内置 FAQ：怎么改稿 / 出图 / 导出 / 换风格 / 加页 / 看会话 / 失败排查 / 安装 key。" +
      "用户问「怎么操作 / 在哪点 / 为什么不行」时先查它，按返回步骤回答（按当前界面口径，不要凭记忆编 UI）；" +
      "查不到就直说没覆盖到，并指路 README / docs/manual.md。",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "关键字或整句问题，如「怎么导出 PPTX」「换风格」；省略则返回目录" },
      },
      additionalProperties: false,
    },
    output: { schema: { type: "object", properties: {} }, render: (_args, value) => [{ type: "text", text: String(value?.text ?? "") }] },
    execute: withToolEvent(store, "deck_help", async (args) => {
      const query = String(args?.query ?? "").trim();
      if (!query) {
        const index = faqIndex();
        return {
          query,
          hits: [],
          text: `工作台 FAQ（${index.length} 条）：\n${index.map((entry) => `· ${entry.title}（${entry.id}）`).join("\n")}\n\n用 deck_help 带关键字查具体步骤（如 query="导出"）。`,
        };
      }
      const hits = searchFaq(query, 3);
      if (!hits.length) {
        return {
          query,
          hits: [],
          text: `FAQ 里没有匹配「${query}」的条目。不要凭记忆编操作步骤：直接说这块没覆盖到，建议看 README / docs/manual.md，或让用户描述具体界面位置。`,
        };
      }
      return {
        query,
        hits: hits.map((entry) => entry.id),
        text: `${hits.map((entry) => `【${entry.title}】\n${entry.answer}`).join("\n\n")}\n\n（把步骤讲清楚即可，不要把整段原文念给用户；界面细节以这份答案为准。）`,
      };
    }),
  });

  tools.push({
    name: "deck_docs_check",
    description: "检查这份 deck 的 9 份文档（意图 / 脚本 / Design / 修改日志 / 反馈 / 调研 / 支撑材料 / 审稿 / 事实核对）齐不齐、字段缺什么。这是「交接完备度」，出图不需要文档齐全；交接 / 导出前再跑。",
    parameters: {
      type: "object",
      properties: { deckId: { type: "string", description: "deck id；省略则取第一个" } },
      additionalProperties: false,
    },
    output: {
      schema: { type: "object", properties: { governance: { type: "object" } } },
      render: (_args, value) => [{ type: "text", text: String(value?.text ?? "") }],
    },
    execute: withToolEvent(store, "deck_docs_check", async (args) => {
      const deckId = args?.deckId ?? adapters[0]?.id;
      const { docs, governance } = deckDocsOf(deckId);
      const icon = { ok: "✓", derived: "≈", draft: "✎", partial: "!", missing: "✗" };
      const lines = [
        `交接完备度 ${governance.score}/100（${Object.entries(governance.counts).map(([key, count]) => `${key} ${count}`).join(" · ")}）——不影响出图 / 改稿 / 导出。`,
        "",
        ...docs.map((doc) => `${icon[doc.status] ?? "?"} ${doc.label}（${doc.status}）${doc.primary ? ` · ${doc.primary}` : ""}${doc.issues.length ? `\n    ${doc.issues.join("\n    ")}` : ""}`),
        "",
        governance.score === 100 ? "9 份文档齐全，交接包可以直接用。" : `交接可选缺项：${docs.filter((doc) => doc.status !== "ok").map((doc) => doc.label).join(" / ")}（用到再补，不用为了分数停下出图）`,
      ];
      return { deckId, governance, docs, text: lines.join("\n") };
    }),
  });

  tools.push({
    name: "deck_docs_scaffold",
    description: "给缺失的 deck 文档打骨架（写 .deck 工作副本 docs/，不动客户源目录），再由 Agent 按模板补内容。",
    parameters: {
      type: "object",
      properties: {
        deckId: { type: "string", description: "deck id；省略则取第一个" },
        docIds: { type: "array", items: { type: "string" }, description: "只补指定文档 id（intent / script / design / changelog / feedback / research / materials）" },
      },
      additionalProperties: false,
    },
    output: {
      schema: { type: "object", properties: { created: { type: "array", items: { type: "string" } } } },
      render: (_args, value) => [{ type: "text", text: String(value?.text ?? "") }],
    },
    execute: withToolEvent(store, "deck_docs_scaffold", async (args) => {
      const deckId = args?.deckId ?? adapters[0]?.id;
      const adapter = adapters.find((item) => item.id === deckId);
      if (!adapter) throw new Error(`unknown deck: ${deckId}`);
      const result = scaffoldDeckDocs({ adapter, deckDir: workspace.deckDir(deckId), docIds: args?.docIds });
      return {
        deckId,
        ...result,
        text: result.created.length
          ? `已在工作副本创建：${result.created.join("、")}${result.skipped.length ? `（已存在跳过：${result.skipped.join("、")}）` : ""}
下一步：按模板补内容，确认后再回写源 deck。`
          : `没有创建新文件${result.skipped.length ? `（已存在：${result.skipped.join("、")}）` : ""}。`,
      };
    }),
  });

  // ── 7. deck_trace ──────────────────────────────────────────────────────────
  tools.push({
    name: "deck_trace",
    description: "读取 deck 工作的 task 与 event 流水（chat / edit / render / qa）。排障与交接时用。",
    parameters: {
      type: "object",
      properties: { limit: { type: "number", description: "各取最近 N 条，默认 20" } },
      additionalProperties: false,
    },
    output: { schema: { type: "object", properties: { tasks: { type: "array", items: { type: "object" } } } }, render: (_args, value) => [{ type: "text", text: String(value?.text ?? "") }] },
    execute: withToolEvent(store, "deck_trace", async (args) => {
      const limit = Number.isFinite(args?.limit) && args.limit > 0 ? Math.min(100, Math.floor(args.limit)) : 20;
      const tasks = store.taskList(limit);
      const events = store.events(limit).slice().reverse();
      const formatTask = (task) => `${task.taskId} [${task.kind}] ${task.status}${task.error ? ` · ${task.error}` : ""} · ${task.deckId ?? "—"} ${(task.slideIds ?? []).join(",")} · ${task.createdAt}`;
      const formatEvent = (event) => `${event.timestamp} ${event.type} ${event.status} · ${event.deckId ?? "—"} ${(event.slideIds ?? []).join(",")} · ${event.actor}`;
      return {
        tasks,
        events,
        text: [`最近任务（${tasks.length}）：`, ...tasks.map(formatTask), "", `最近事件（${events.length}）：`, ...events.map(formatEvent)].join("\n"),
      };
    }),
  });

  // ── N. deck_note_change ────────────────────────────────────────────────────
  tools.push({
    name: "deck_note_change",
    description:
      "给修改日志补一条「为什么」：系统已经从 revision/事件自动生成变更时间线，你只需在每次改完 deck 后补一句人话（改了什么、为什么、影响哪些页）。会追加到 docs/changelog.md 并记事件。",
    parameters: {
      type: "object",
      properties: {
        deckId: { type: "string", description: "deck id；省略则取第一个" },
        note: { type: "string", description: "一句话说明：为什么改 / 影响了什么" },
        pageId: { type: "string", description: "相关页 id（可选，如 p03）" },
      },
      required: ["note"],
      additionalProperties: false,
    },
    output: {
      schema: { type: "object", properties: { ok: { type: "boolean" }, line: { type: "string" } } },
      render: (_args, value) => [{ type: "text", text: String(value?.text ?? "") }],
    },
    execute: withToolEvent(store, "deck_note_change", async (args) => {
      const deckId = args?.deckId ?? adapters[0]?.id;
      const adapter = adapters.find((item) => item.id === deckId);
      if (!adapter) throw new Error(`unknown deck: ${deckId}`);
      const pageId = typeof args?.pageId === "string" ? args.pageId : "";
      const { line } = appendChangelogNote({ deckDir: workspace.deckDir(deckId), note: args?.note, pageId, actor: "agent" });
      store.recordEvent({
        type: "deck.changelog.note",
        deckId,
        slideIds: pageId ? [pageId] : [],
        actor: "agent",
        status: "succeeded",
        payload: { note: String(args.note).slice(0, 300) },
      });
      return { ok: true, line, text: `已记入修改日志：${line}` };
    }),
  });

  // ── N+0. deck_style_read / deck_style_update（F-72：复用已有风格提示词）──────
  tools.push({
    name: "deck_style_read",
    description:
      "读一个 design（风格）的定义：style.json / style.md 里的风格提示词（styleBrief）、画面语言、不要什么、参考，" +
      "以及已有样张的 brief + 实际 prompt 记录。补样张前先读它：新样张要沿用已有风格提示词，只补「这张要试的画面」，不要重造提示词。",
    parameters: {
      type: "object",
      properties: {
        designId: { type: "string", description: "design id 或缩写（如 SKT）；省略则用当前会话绑定的 design" },
      },
      additionalProperties: false,
    },
    output: { schema: { type: "object", properties: { abbr: { type: "string" }, text: { type: "string" } } }, render: (_args, value) => [{ type: "text", text: String(value?.text ?? "") }] },
    execute: withToolEvent(store, "deck_style_read", async (args, exec) => {
      const design = resolveDesign(args.designId, exec);
      const adapter = adapterFor(design.canvasDeckId);
      const definition = readStyleDefinition(adapter.sourceRoot, design.abbr, design);
      const samples = readSampleRecords(definition.dir);
      const text = [
        `# design ${definition.abbr || design.abbr} · ${definition.name || design.name}`,
        `designId: ${design.designId}（画布 deck ${design.canvasDeckId}）`,
        `style.json: ${definition.jsonPath}`,
        "",
        "## 风格提示词（styleBrief，出样张时自动带上）",
        definition.styleBrief || "（还没有 styleBrief；只有画面描述，会用 description 兜底）",
        definition.description ? `\n## 画面语言\n${definition.description}` : "",
        definition.constraints ? `\n## 不要什么\n${definition.constraints}` : "",
        definition.reference ? `\n## 参考\n${definition.reference}` : "",
        "",
        `## 已有样张 prompt（${samples.length} 条记录）`,
        ...(samples.length
          ? samples.map((row) => `- ${row.revision || "?"}｜brief：${row.brief || "（未记录）"}｜prompt ${String(row.prompt ?? "").length} 字｜${row.createdAt || ""}`)
          : ["（还没有 prompt 记录；老样张是本次改动之前出的，无法回溯当时的 prompt）"]),
        "",
        "补新样张时：沿用上面的 styleBrief，只把「这张要试什么画面」写进 brief。",
      ].filter((line) => line !== undefined).join("\n");
      return { designId: design.designId, abbr: definition.abbr || design.abbr, styleBrief: definition.styleBrief, samples: samples.length, text };
    }),
  });

  tools.push({
    name: "deck_style_update",
    description:
      "更新 design（风格）的定义：只写画布 deck 的 designs/<ABBR>/style.json + style.md，不动客户源 deck。" +
      "只在用户明确要改风格（改提示词 / 约束 / 参考）并确认草案后调用；改完后出样张会自动带上新 styleBrief。" +
      "不要用它改 deck 页面内容。",
    parameters: {
      type: "object",
      properties: {
        designId: { type: "string", description: "design id 或缩写；省略则用当前会话绑定的 design" },
        styleBrief: { type: "string", description: "新的风格提示词本体（精确画面语言；出样张自动带上）" },
        description: { type: "string", description: "给人看的画面语言描述（可选）" },
        constraints: { type: "string", description: "不要什么（可选）" },
        reference: { type: "string", description: "参考（可选）" },
      },
      additionalProperties: false,
    },
    output: { schema: { type: "object", properties: { styleBrief: { type: "string" } } }, render: (_args, value) => [{ type: "text", text: String(value?.text ?? "") }] },
    execute: withToolEvent(store, "deck_style_update", async (args, exec) => {
      const design = resolveDesign(args.designId, exec);
      const adapter = adapterFor(design.canvasDeckId);
      const patch = {};
      for (const field of ["styleBrief", "description", "constraints", "reference"]) {
        if (typeof args[field] === "string" && args[field].trim()) patch[field] = args[field].trim();
      }
      if (!Object.keys(patch).length) throw new Error("没有要更新的字段：至少给 styleBrief / description / constraints / reference 之一");
      const written = writeStyleDefinition(adapter.sourceRoot, {
        abbr: design.abbr,
        name: design.name,
        description: design.description,
        constraints: design.constraints,
        reference: design.reference,
        styleBrief: design.styleBrief,
        designId: design.designId,
        ...patch,
      });
      designs.upsertDesign({
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
        payload: { designId: design.designId, abbr: design.abbr, fields: Object.keys(patch) },
      });
      return {
        designId: design.designId,
        abbr: design.abbr,
        styleBrief: written.definition.styleBrief,
        text: `design ${design.abbr} 风格定义已更新（${Object.keys(patch).join(" / ")}）\nstyle.json：${written.jsonPath}\n后面的样张会自动沿用新的 styleBrief。`,
      };
    }),
  });

  /**
   * F-186：普通 deck 会话里的「风格登记」——没先选风格，deck 做完后把这套视觉语言沉淀成 design。
   * 与 Designs 页「＋添加风格」同一个创建路径（同一份样式卡 / 画布 / 注册表），
   * 区别：缩写可省略（自动生成），并可直接把当前 deck 已出图的页面复制成样张（不重新出图、不花额度）。
   */
  tools.push({
    name: "deck_style_create",
    description:
      "把一套视觉语言登记成风格（design）：给名称 + 风格提示词（画面语言），并传当前 deck 的已出图页面当样张（直接复制成品图，不重新出图）。" +
      "默认挑 3 张（有封面 / 信息页 / 数据对比页最好，三张才能说明风格在各类版面上都成立）；" +
      "用在普通 deck 会话里：用户没先选风格、或做完后说「这个风格好看 / 帮我登记 / 以后想复用」时调它；" +
      "不要回答「没有接口 / 只能去界面建」。登记后用户可在新建 deck 时选这个风格，也可以用 deck_design_bind 把它关联到当前 deck。" +
      "给已有风格补样张：传 designId（或缩写）+ deckId + pages，不传 name/styleBrief。" +
      "不需要用户先想缩写（不传 abbr 会自动生成）；不要用它改风格提示词（改已有风格用 deck_style_update）。",
    parameters: {
      type: "object",
      properties: {
        designId: { type: "string", description: "已有风格 id 或缩写（只在「补样张」时传；传了就不新建，也不改名称/提示词）" },
        name: { type: "string", description: "风格名称（给人看的，如「深海琥珀」；新建时必填）" },
        styleBrief: { type: "string", description: "风格提示词本体：颜色 / 材质 / 字体 / 版式等精确画面语言（新建时必填；出图时用它）" },
        abbr: { type: "string", description: "风格缩写（2–6 位字母/数字，可省略，自动生成）" },
        description: { type: "string", description: "给人看的画面描述（可选，默认同 styleBrief）" },
        constraints: { type: "string", description: "不要什么（可选）" },
        reference: { type: "string", description: "参考（可选；只给人看，不进出图 prompt）" },
        deckId: { type: "string", description: "从哪个 deck 取样张（省略=当前会话绑定的 deck）" },
        pages: { type: "array", items: { type: "string" }, description: '用哪几页的成品图当样张（如 ["p01","p02","p03"]；省略=该 deck 前 3 页有图的页）' },
      },
      required: [],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: "object",
        properties: {
          designId: { type: "string" },
          abbr: { type: "string" },
          samples: { type: "array", items: { type: "object" } },
        },
      },
      render: (_args, value) => [{ type: "text", text: String(value?.text ?? "") }],
    },
    execute: withToolEvent(store, "deck_style_create", async (args, exec) => {
      if (typeof createStyle !== "function") throw new Error("当前挂载不支持创建风格（只在启用工具的 preset 会话里可用）");
      const designKey = String(args?.designId ?? "").trim();
      const name = String(args?.name ?? "").trim();
      const styleBrief = String(args?.styleBrief ?? "").trim();
      if (!designKey) {
        if (!name) throw new Error("缺少 name：先给风格起个名字（给已有风格补样张请传 designId）");
        if (!styleBrief) throw new Error("缺少 styleBrief：先写清这套风格的画面语言（颜色 / 材质 / 字体 / 版式）");
      }
      const sessionId = sessionIdOf(exec);
      const binding = sessionId ? designs.listBindings().find((item) => item.sessionId === sessionId) : null;
      const deckId = String(args?.deckId ?? "").trim()
        || (binding?.kind === "deck" ? String(binding.id) : "");
      const pages = Array.isArray(args?.pages) ? args.pages.map((page) => String(page)) : [];
      const created = createStyle({
        designId: designKey,
        name,
        abbr: String(args?.abbr ?? "").trim(),
        styleBrief,
        description: String(args?.description ?? "").trim(),
        constraints: String(args?.constraints ?? "").trim(),
        reference: String(args?.reference ?? "").trim(),
        deckId,
        pages,
      });
      const sampleLines = created.samples?.length
        ? created.samples.map((item) => `- ${item.pageId} ${item.revision} → designs/${created.abbr}/${item.file}（${(item.sizeBytes / 1024 / 1024).toFixed(1)} MB，复制成品图，未重新出图）`)
        : ["（这次没带样张；可以之后用 deck_design_sample 出，或在界面样张图片区补）"];
      const headline = created.appended
        ? `已给风格 ${created.abbr} · ${created.name} 补样张（designId: ${created.designId}）`
        : `已登记风格：${created.abbr} · ${created.name}（designId: ${created.designId}）`;
      const text = [
        headline,
        created.appended ? `现有样张合计 ${created.totalSamples ?? created.samples?.length ?? 0} 张` : `风格提示词：${styleBrief.slice(0, 120)}${styleBrief.length > 120 ? "…" : ""}`,
        "",
        `本次样张（${created.samples?.length ?? 0} 张）：`,
        ...sampleLines,
        "",
        "以后新建 deck 时可以在「添加风格 / 新建 Deck」里选它；也可以把当前 deck 关联到它（deck_design_bind），之后出图会带这套 styleBrief。",
        "想验证这套风格换个版面是否稳定，用 deck_design_sample 出 1–2 张不同版面的样张再给用户看。",
      ].join("\n");
      return {
        designId: created.designId,
        abbr: created.abbr,
        samples: created.samples ?? [],
        text,
      };
    }),
  });

  // ── N+1. deck_design_sample ────────────────────────────────────────────────
  tools.push({
    name: "deck_design_sample",
    description:
      "给绑定的 design（风格）出一张样张：风格描述 + 这张要试的画面 → QA → 图片模型，" +
      "保存到画布 deck 的 designs/<ABBR>/sample-vNNN.png（不覆盖旧样张）。" +
      "design 会话里用它试风格；不要用它改 deck 页面。" +
      "designId 可传完整 id 或缩写（如 SKT）；design 会话里可省略（自动用会话绑定的 design）。" +
      "若报「未知 design」，说明 id 写错/被截断，改用缩写重试，不要建议用户重新创建风格。",
    parameters: {
      type: "object",
      properties: {
        designId: { type: "string", description: "design id 或缩写（如 SKT）；省略则用当前会话绑定的 design" },
        brief: { type: "string", description: "这张样张要试的画面/版面说明" },
        size: { type: "string", description: "覆盖默认尺寸（如 2560x1440）" },
      },
      required: ["brief"],
      additionalProperties: false,
    },
    output: { schema: { type: "object", properties: { revision: { type: "string" }, imagePath: { type: "string" } } }, render: (_args, value) => [{ type: "text", text: String(value?.text ?? "") }] },
    execute: withToolEvent(store, "deck_design_sample", async (args, exec) => {
      const design = resolveDesign(args.designId, exec);
      const brief = String(args.brief ?? "").trim();
      if (!brief) throw new Error("brief 不能为空：说明这张样张要试什么画面");
      const adapter = adapterFor(design.canvasDeckId);
      const sessionId = sessionIdOf(exec);
      const size = String(args.size ?? config.render.size);
      // F-72：沿用 style.json 里已有的风格提示词（styleBrief），新 brief 只补「这张要试的画面」，
      // 不再用 description 现拼一套新提示词。
      const definition = readStyleDefinition(adapter.sourceRoot, design.abbr, design);
      const prompt = composeSamplePrompt(definition, brief);
      const qa = qaCheck(prompt, size);
      if (!qa.ok) throw new Error(`QA 门禁未通过：${qa.checks.filter((check) => !check.ok).map((check) => `${check.name}(${check.detail})`).join("；")}`);

      const runtime = typeof resolveRender === "function"
        ? resolveRender(design.canvasDeckId)
        : (() => {
            const picked = selectRenderer(config.render, env);
            return { renderer: picked.renderer, apiKey: picked.apiKey, model: config.render.model, endpoint: config.render.endpoint, nodeName: "", label: config.render.model, mode: config.render.mode, timeoutMs: config.render.timeoutMs };
          })();
      const styleDir = join(adapter.sourceRoot, "designs", design.abbr);
      mkdirSync(styleDir, { recursive: true });
      const used = readdirSync(styleDir).filter((name) => /^sample-v\d+\.(png|jpe?g|webp|svg)$/i.test(name)).length;
      const revision = `v${String(used + 1).padStart(3, "0")}`;
      const renderResult = await runtime.renderer.render({
        prompt,
        slideId: `design-${design.abbr}`,
        revision,
        model: runtime.model,
        endpoint: runtime.endpoint,
        size,
        outDir: styleDir,
        apiKey: runtime.apiKey,
        timeoutMs: runtime.timeoutMs,
        signal: exec?.signal,
      });
      const produced = renderResult.imagePath;
      const target = join(styleDir, `sample-${revision}${extname(produced) || ".png"}`);
      if (produced !== target) renameSync(produced, target);
      // F-72：把这张样张实际用的 brief + prompt 落盘，后续「再加两张」可以接着用。
      const record = appendSampleRecord(styleDir, {
        designId: design.designId,
        abbr: design.abbr,
        revision,
        brief,
        prompt,
        model: renderResult.model,
        size: renderResult.size,
        imagePath: target,
        durationMs: renderResult.durationMs,
        sessionId,
      });
      store.recordEvent({
        type: "design.sample",
        sessionId,
        deckId: design.canvasDeckId,
        actor: "tool",
        status: "succeeded",
        payload: { designId: design.designId, abbr: design.abbr, revision, imagePath: target, model: renderResult.model, size: renderResult.size, durationMs: renderResult.durationMs, promptChars: prompt.length, brief, recordAt: record.createdAt },
      });
      return {
        designId: design.designId,
        revision,
        imagePath: target,
        text: `design ${design.abbr} 样张 ${revision} 完成（${renderResult.provider} · ${renderResult.model} · ${renderResult.size} · ${renderResult.durationMs}ms）\n图片：${target}`,
      };
    }),
  });

  // ── N+1.4 deck_design_bind（F-113：deck ↔ design 换绑） ────────────────────
  tools.push({
    name: "deck_design_bind",
    description:
      "把 deck 关联到某个登记风格（design），或传空设计解除关联。用户明确要求「换风格 / 换 design / 关联到 X」时用；" +
      "不要自己替用户换风格。换绑只改「出图用哪个 styleBrief」，不改已有页面内容；换完提醒用户旧 visualBrief 可能还是旧风格的画面语言。",
    parameters: {
      type: "object",
      properties: {
        deckId: { type: "string", description: "deck id；省略取第一个" },
        designId: { type: "string", description: "design id 或缩写（如 GRD）；传空字符串 = 解除关联" },
      },
      additionalProperties: false,
    },
    output: { schema: { type: "object", properties: { deckId: { type: "string" }, designId: { type: "string" } } }, render: (_args, value) => [{ type: "text", text: String(value?.text ?? "") }] },
    execute: withToolEvent(store, "deck_design_bind", async (args) => {
      const deckId = String(args?.deckId ?? adapters[0]?.id ?? "");
      const adapter = adapterFor(deckId);
      const raw = String(args?.designId ?? "").trim();
      const previous = designs.deckDesignFor(deckId)?.designId ?? null;
      const deck = workspace.ensureDeck(adapter, { styleBrief: config.styleBrief });
      const briefPages = () => deck.slides
        .filter((slide) => String(slide.visualBrief ?? "").trim())
        .map((slide) => ({ pageId: slide.id, page: slide.order, designAbbr: slide.visualBriefDesign ?? null }));
      if (!raw) {
        designs.setDeckDesign(deckId, null);
        store.recordEvent({ type: "deck.design.bind", deckId, actor: "agent", status: "succeeded", payload: { designId: null, previous } });
        return { deckId, designId: "", text: `deck ${deckId}（${adapter.label}）已解除风格关联；之后出图只带全局 styleBrief。` };
      }
      const design = resolveDesign(raw, null);
      designs.setDeckDesign(deckId, design.designId);
      store.recordEvent({ type: "deck.design.bind", deckId, actor: "agent", status: "succeeded", payload: { designId: design.designId, abbr: design.abbr, previous } });
      // F-114：换风格后，哪些页的 visualBrief 不是在新风格下写的 → 这些页的 brief 需要用户决定是否刷新。
      const staleBriefs = briefPages().filter((item) => item.designAbbr !== design.abbr);
      store.recordEvent({ type: "deck.design.briefs-check", deckId, actor: "tool", status: "succeeded", payload: { designAbbr: design.abbr, stale: staleBriefs.map((item) => item.pageId) } });
      const staleText = staleBriefs.length
        ? `\n有 ${staleBriefs.length} 页的画面要求不是 ${design.abbr} 风格下写的：${staleBriefs.map((item) => `${item.pageId}${item.designAbbr ? `（写于 ${item.designAbbr}）` : "（未记录）"}`).join("、")}。\n`
          + `问用户选哪种（必须问，不要自己决定）：① 只换风格、保留现有画面要求（下次出图 = 现有 brief + 新风格，可能出现风格混搭）；`
          + `② 按新风格重写这些页的 visualBrief（逐页提案，确认后再出图，效果更好）。`
        : `\n所有页的画面要求都与新风格一致，不需要刷新。`;
      return {
        deckId,
        designId: design.designId,
        designAbbr: design.abbr,
        staleBriefs,
        text: `deck ${deckId}（${adapter.label}）的出图风格已换成 ${design.abbr} ${design.name}。\n`
          + `之后 deck_render_page 的 prompt 会带它的 styleBrief（${String(design.styleBrief || design.description || "").slice(0, 80)}…）。${staleText}`,
      };
    }),
  });

  // ── N+1.5 deck_research_plan（F-96 P2 分批调研） ───────────────────────────
  tools.push({
    name: "deck_research_plan",
    description:
      "把 deck 的参考资料拆成「调研批次」：先规划（不传 batchIndex）→ 再逐批读（batchIndex=1,2,…）。" +
      "每批返回该批文件的前若干行摘要（有字数预算），避免一次读完 10+ 份资料把上下文占满。" +
      "读完一批就把可引用事实 + 出处写进调研台账（deck_doc_update，docId=research），再读下一批。" +
      "不要跳过规划、也不要一次把全部资料读完。",
    parameters: {
      type: "object",
      properties: {
        deckId: { type: "string", description: "deck id，见 deck_source_overview" },
        batchIndex: { type: "number", description: "要读的批次号（从 1 开始）；不传 = 只生成计划" },
        batchSize: { type: "number", description: "每批几份资料（默认 3，上限 6）" },
        charBudget: { type: "number", description: "该批摘要总字数预算（默认 4000，范围 800–12000）" },
        write: { type: "boolean", description: "是否把批次计划写进调研台账（默认 true）" },
      },
      required: ["deckId"],
      additionalProperties: false,
    },
    output: {
      schema: { type: "object", properties: { deckId: { type: "string" }, totalBatches: { type: "number" }, batchIndex: { type: "number" } } },
      render: (_args, value) => [{ type: "text", text: String(value?.text ?? "") }],
    },
    execute: withToolEvent(store, "deck_research_plan", async (args, exec) => {
      const adapter = adapterFor(args.deckId);
      const deck = workspace.ensureDeck(adapter, { styleBrief: config.styleBrief });
      const deckDir = workspace.deckDir(deck.id);
      const { docs } = resolveDeckDocs({
        adapter,
        deckDir,
        render: config.render,
        revisions: workspace.manifest(deck.id)?.revisions ?? [],
        events: store.events(200).filter((event) => event.deckId === deck.id),
      });
      const materials = docs.find((doc) => doc.id === "materials");
      const refs = [];
      const seen = new Set();
      for (const row of materials?.facts?.items ?? []) {
        const ref = String(row.name || row.link || "").trim();
        if (!ref || seen.has(ref)) continue;
        seen.add(ref);
        refs.push(ref);
      }
      const sources = refs.map((ref) => {
        if (/^https?:\/\//i.test(ref)) return { ref, readable: false, reason: "链接（需联网 / 由用户提供原文）" };
        try {
          const { rel, bytes } = resolveReadablePath(ref);
          return { ref: rel, readable: true, bytes };
        } catch (error) {
          return { ref, readable: false, reason: String(error?.message ?? error) };
        }
      });
      const readable = sources.filter((item) => item.readable);
      // 批次大小要跨调用一致：读第 N 批时如果没传 batchSize，沿用计划里写下的大小（默认 3）。
      const researchPath = join(deckDir, "docs", "research", "index.md");
      const researchText = existsSync(researchPath) ? readFileSync(researchPath, "utf8") : "";
      const plannedSize = Number((researchText.match(/批次大小：(\d+)/) ?? [])[1]) || 0;
      const batchSize = Math.min(Math.max(Number(args.batchSize) || plannedSize || 3, 1), 6);
      const batches = [];
      for (let i = 0; i < readable.length; i += batchSize) batches.push(readable.slice(i, i + batchSize));
      const totalBatches = batches.length;
      if (!readable.length) {
        return {
          deckId: deck.id,
          totalBatches: 0,
          text: `deck ${deck.id} 没有可读的本地参考资料（${sources.length} 条登记里有 ${sources.filter((item) => !item.readable).length} 条是链接 / 未登记文件）。先把资料路径登记进「支撑材料」，或让用户提供可读文件。`,
        };
      }

      // 计划写进调研台账：只写「## 调研批次计划」这一节，幂等替换。
      let planWritten = false;
      if (args.write !== false) {
        const target = join(deckDir, "docs", "research", "index.md");
        mkdirSync(dirname(target), { recursive: true });
        const existing = existsSync(target) ? readFileSync(target, "utf8") : "---\ntitle: 调研台账\nstatus: draft\n---\n\n# 调研台账\n";
        const planLines = [
          "## 调研批次计划",
          "",
          `> 分批读，避免一次把上下文占满；批次大小：${batchSize}（共 ${totalBatches} 批）。读完一批把事实写进下面的台账。`,
          "",
          "| 批次 | 文件 | 状态 |",
          "|---|---|---|",
          ...batches.map((batch, index) => `| ${index + 1} | ${batch.map((item) => item.ref).join(" · ")} | 待读 |`),
          "",
        ].join("\n");
        const stripped = existing.replace(/## 调研批次计划[\s\S]*?(?=\n## |$)/, "").replace(/\s+$/, "");
        writeFileSync(target, `${stripped}\n\n${planLines}`, "utf8");
        planWritten = true;
      }

      const planText = [
        `deck ${deck.id} 参考资料 ${sources.length} 条（可读 ${readable.length} · 链接/不可读 ${sources.length - readable.length}）`,
        `分 ${totalBatches} 批（每批 ≤${batchSize} 份）：`,
        ...batches.map((batch, index) => `  批次 ${index + 1}：${batch.map((item) => `${item.ref}（${Math.round(item.bytes / 1024)}KB）`).join(" · ")}`),
        ...(sources.filter((item) => !item.readable).length ? [`不可读 / 需另找：${sources.filter((item) => !item.readable).map((item) => item.ref).join(" · ")}`] : []),
        "",
        `下一步：逐批调用 deck_research_plan({deckId, batchIndex: 1..${totalBatches}}) 读该批摘要；每批读完把可引用事实 + 出处写进调研台账（deck_doc_update，docId=research）。`,
        planWritten ? "批次计划已写入调研台账。" : "（未写文件）",
      ].join("\n");

      const logPlan = (payload) => store.recordEvent({
        type: "deck.research.plan",
        deckId: deck.id,
        sessionId: sessionIdOf(exec),
        actor: "agent",
        status: "succeeded",
        payload: { totalBatches, batchSize, sources: sources.length, readable: readable.length, ...payload },
      });

      if (!Number.isFinite(Number(args.batchIndex))) {
        logPlan({ mode: "plan", written: planWritten });
        return { deckId: deck.id, totalBatches, sources, text: planText };
      }
      const index = Math.floor(Number(args.batchIndex));
      const batch = batches[index - 1];
      if (!batch) throw new Error(`batchIndex 越界：${index}（共 ${totalBatches} 批）`);
      const budget = Math.min(Math.max(Number(args.charBudget) || 4000, 800), 12000);
      const perFile = Math.max(400, Math.floor(budget / batch.length) - 200);
      const digests = batch.map((item) => {
        const { file } = resolveReadablePath(item.ref);
        const text = readFileSync(file, "utf8");
        const lines = text.split("\n");
        const shownLines = lines.slice(0, 120).join("\n");
        const digest = shownLines.length > perFile ? `${shownLines.slice(0, perFile)}\n…（本批预算内截断，需要更多细节单独再读这份文件）` : shownLines;
        return `### ${item.ref}（${lines.length} 行 · ${Math.round(item.bytes / 1024)}KB，显示前 ${Math.min(lines.length, 120)} 行）\n${digest}`;
      });
      logPlan({ mode: "batch", batchIndex: index, files: batch.map((item) => item.ref) });
      return {
        deckId: deck.id,
        totalBatches,
        batchIndex: index,
        files: batch.map((item) => item.ref),
        text: [
          `批次 ${index}/${totalBatches}（${batch.length} 份，摘要预算 ${budget} 字）`,
          "",
          ...digests,
          "",
          `读完这批后：把「可引用事实 / 出处（文件 + 位置）/ 能支撑哪条主张 / 缺口」写进调研台账（deck_doc_update，docId=research），再读下一批。`,
        ].join("\n"),
      };
    }),
  });

  // ── N+2. deck_review（F-95 P1 审稿人 / 红队） ─────────────────────────────
  tools.push({
    name: "deck_review",
    description:
      "审稿（红队）：读 intent / design / script / materials / research / changelog，找出交付前必修的问题" +
      "（缺内容、空 visualBrief、无来源支撑、前后不一致），按严重度排序写进 review.md。" +
      "只审不改、不出图。每条必须带：严重度 P0/P1/P2、位置（文档名或页号 P0x）、证据原文、修复建议；" +
      "没有真问题时要写明「无问题 + 依据」，不要为了凑数编问题。交付前必须审一次。",
    parameters: {
      type: "object",
      properties: {
        deckId: { type: "string", description: "deck id，见 deck_source_overview" },
        write: { type: "boolean", description: "是否把意见写进 review.md（默认 true；dry run 传 false）" },
      },
      required: ["deckId"],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: "object",
        properties: { deckId: { type: "string" }, verdict: { type: "string" }, issues: { type: "array" } },
      },
      render: (_args, value) => [{ type: "text", text: String(value?.text ?? "") }],
    },
    execute: withToolEvent(store, "deck_review", async (args, exec) => {
      const adapter = adapterFor(args.deckId);
      const deck = workspace.ensureDeck(adapter, { styleBrief: config.styleBrief });
      const deckDir = workspace.deckDir(deck.id);
      const sessionId = sessionIdOf(exec);
      const { docs, governance } = resolveDeckDocs({
        adapter,
        deckDir,
        render: config.render,
        revisions: workspace.manifest(deck.id)?.revisions ?? [],
        events: store.events(200).filter((event) => event.deckId === deck.id),
      });
      const pages = adapter.storyPages?.() ?? [];
      const prompts = adapter.prompts?.() ?? {};
      const docOf = (id) => docs.find((item) => item.id === id);
      const isPlaceholder = (value) => !String(value ?? "").trim() || /TODO|todo|待补|待填|待确认/.test(String(value));
      const cell = (value) => String(value ?? "").replace(/\|/g, "\\|").replace(/\n+/g, " ").slice(0, 240);
      const issues = [];
      const add = (severity, category, where, evidence, fix) => issues.push({ severity, category, where, evidence, fix });

      // 1) 结构：页数 / 每页主张 / visualBrief / 内容
      if (!pages.length) add("P0", "结构", "script.md", "读不到任何正文页", "先补 script 页骨架（P01–P06）");
      else if (pages.length < 3) add("P0", "结构", "script.md", `正文只有 ${pages.length} 页`, "补齐页数，或明确说明这是只讲一页的短 deck");
      for (const page of pages) {
        const display = `P${String(page.page).padStart(2, "0")}`;
        const key = `p${String(page.page).padStart(2, "0")}`;
        const brief = String(prompts[key] ?? "").trim();
        if (isPlaceholder(page.claim)) add("P1", "主张", display, `claim=${JSON.stringify(page.claim ?? "")}`, "给这一页一句可被资料支撑的结论（不是栏目名）");
        if (!brief) add("P1", "画面要求", display, "visualBrief 为空", "按 design 风格补这一页画面要求，参考已有页的句式");
        else if (isPlaceholder(brief)) add("P1", "画面要求", display, `visualBrief 仍是占位：${cell(brief)}`, "把占位换成具体画面要求");
        if (isPlaceholder(page.content ?? "")) add("P2", "内容", display, "页面内容还是占位", "补 2–4 条支撑主张的要点");
      }

      // 2) 意图 / 设计 / 支撑材料 / 调研 / 修改日志
      const intent = docOf("intent");
      if (!intent || intent.status === "missing") add("P0", "意图", "intent.md", "文档缺失", "补 听众 / 主题 / 带走 等字段");
      else for (const issue of intent.issues ?? []) add(intent.status === "partial" ? "P0" : "P1", "意图", "intent.md", issue, "补齐字段后再交付；没依据的写成待确认问题问用户");
      const design = docOf("design");
      if (!design || design.status === "missing") add("P0", "风格", "design.md", "文档缺失", "补画面约束 / 模板 / 出图参数");
      else for (const issue of design.issues ?? []) add(design.status === "partial" ? "P1" : "P2", "风格", "design.md", issue, "补齐后才能保证各页风格一致");
      const materials = docOf("materials");
      if (!materials || materials.status === "missing") add("P1", "支撑材料", "materials.md", "文档缺失", "登记每条资料的 文件名 / 链接 / 总结");
      else if (/TODO|待补/.test(materials.primary ? String(readFileSync(join(deckDir, "docs", "materials.md"), "utf8")) : "")) add("P2", "支撑材料", "materials.md", "还有占位 / 未登记", "把资料逐条登记成可引用事实");
      const research = docOf("research");
      if (!research || research.status === "missing") add("P2", "调研", "research/index.md", "没有调研台账", "登记来源；没找到的要标「需要外部检索」");
      else {
        const entries = research.facts?.entries ?? [];
        const noSource = entries.filter((entry) => !String(entry.source ?? "").trim());
        if (noSource.length) add("P2", "调研", "research/index.md", `${noSource.length} 条缺出处`, "补出处，或标「未提供」");
      }
      const changelog = docOf("changelog");
      const entries = changelog?.facts?.entries ?? [];
      if (!entries.length) add("P2", "修改日志", "changelog.md", "还没有改动记录", "至少留一条「新建 / 为什么」记录，方便交接");

      const bySeverity = { P0: 0, P1: 0, P2: 0 };
      for (const issue of issues) bySeverity[issue.severity] = (bySeverity[issue.severity] ?? 0) + 1;
      const verdict = bySeverity.P0 ? "不可交付：先修 P0" : bySeverity.P1 ? "需修改后才能交付" : bySeverity.P2 ? "可交付（有优化建议）" : "可交付";
      const scope = `intent / design / script（${pages.length} 页）/ materials / research / changelog`;
      const now = new Date().toISOString();
      const table = issues.length
        ? ["| 严重度 | 类别 | 位置 | 证据 | 修复建议 |", "|---|---|---|---|---|", ...issues.map((issue) => `| ${issue.severity} | ${issue.category} | ${issue.where} | ${cell(issue.evidence)} | ${cell(issue.fix)} |`)].join("\n")
        : "| 严重度 | 类别 | 位置 | 证据 | 修复建议 |\n|---|---|---|---|---|\n| — | — | — | 未发现问题 | — |";
      const evidence = `治理评分 ${governance.score}/100 · 文档 ${docs.filter((doc) => doc.status !== "missing").length}/${docs.length} 有内容 · 正文 ${pages.length} 页`;
      const body = [
        "---",
        `title: ${deck.label ?? deck.id} · 审稿意见`,
        "status: draft",
        "---",
        "",
        "# 审稿意见",
        "",
        `> 生成时间：${now} · 审核范围：${scope} · 只审不改、不出图。`,
        "",
        "## 结论",
        "",
        `**${verdict}**（P0 × ${bySeverity.P0} · P1 × ${bySeverity.P1} · P2 × ${bySeverity.P2}）`,
        "",
        `依据：${evidence}`,
        "",
        "## 问题清单",
        "",
        table,
        "",
      ];
      if (!issues.length) body.push("## 无问题时的依据", "", `- 已逐页检查 claim / visualBrief / 内容：${pages.length} 页`, `- 已检查 7 类治理文档与治理评分（${governance.score}/100）`, "- 结论：当前没有发现必修问题；交付前仍建议用户复核客户口径。", "");
      const content = body.join("\n");
      const target = join(deckDir, "docs", "review.md");
      let written = false;
      if (args.write !== false) {
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, content.endsWith("\n") ? content : `${content}\n`, "utf8");
        written = true;
        appendChangelogNote({ deckDir, note: `审稿：${verdict}（P0 ${bySeverity.P0} / P1 ${bySeverity.P1} / P2 ${bySeverity.P2}）`, actor: "agent" });
      }
      store.recordEvent({
        type: "deck.review",
        deckId: deck.id,
        sessionId,
        actor: "agent",
        status: "succeeded",
        payload: { verdict, total: issues.length, bySeverity, written, scope },
      });
      const lines = issues.length
        ? issues.map((issue) => `${issue.severity} · ${issue.category} · ${issue.where}：${issue.evidence} → ${issue.fix}`)
        : ["未发现问题（依据见 review.md / 治理检查）"];
      return {
        deckId: deck.id,
        docId: "review",
        verdict,
        issues,
        bySeverity,
        written,
        text: `审稿结论：${verdict}（P0 ${bySeverity.P0} / P1 ${bySeverity.P1} / P2 ${bySeverity.P2}）\n${lines.join("\n")}${written ? `\n已写入：${target}` : "\n（dry run，未写文件）"}`,
      };
    }),
  });

  // ── 4.5 deck_script_review（F-159 听众评审；F-172 两段式盲审 → 冻结 → 对照）──
  tools.push({
    name: "deck_script_review",
    description:
      "听众评审（两段式）：按 intent 的「听众」生成独立审稿人。第一段盲审——只给听众身份和稿件，不给意图，" +
      "逐页四问（复述 / 承接 / 追问 / 下一步动作）后把结论冻结到 docs/review.blind.json；" +
      "第二段对照——把冻结结论和 intent 一起给出，逐页判「是 / 部分 / 否」并做读者读出 X / 稿件 S / 意图 Y 的差异。" +
      "phase=full（默认）跑完整两段；blind 只冻结；contrast 复用冻结记录（稿件改过会拒绝，需重跑盲审）。" +
      "写 docs/review.experts.md（覆盖矩阵 + 差异表）+ docs/review.findings.json（可采纳清单）。只审不改：不改 script；" +
      "改稿走 deck_script_propose_edits 并给每条 edit 带 reviewRef/severity/confidence/evidence，C 类（原文找不到证据）不许进提案。",
    parameters: {
      type: "object",
      properties: {
        deckId: { type: "string", description: "deck id，见 deck_source_overview" },
        phase: {
          type: "string",
          enum: ["full", "blind", "contrast"],
          description: "full（默认）= 盲审 + 冻结 + 对照；blind = 只跑盲审并冻结；contrast = 用已有冻结记录跑对照",
        },
        maxReviewers: { type: "number", description: `最多几个审稿人（1–${HARD_MAX_REVIEWERS}，默认按 profile 配置，通常 2–3）` },
        write: { type: "boolean", description: "是否写 docs/review.experts.md 与 docs/review.blind.json（默认 true；dry run 传 false）" },
        scores: { type: "boolean", description: "是否顺手打四维分（表意清晰 / 证据充分 / 结构连贯 / 意图达成，默认 true；false 时只出意见不打分）" },
      },
      required: ["deckId"],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: "object",
        properties: { deckId: { type: "string" }, reviewers: { type: "array" }, issues: { type: "array" } },
      },
      render: (_args, value) => [{ type: "text", text: String(value?.text ?? "") }],
    },
    execute: withToolEvent(store, "deck_script_review", async (args, exec) => {
      const adapter = adapterFor(args.deckId);
      const deck = workspace.ensureDeck(adapter, { styleBrief: config.styleBrief });
      const deckDir = workspace.deckDir(deck.id);
      const sessionId = sessionIdOf(exec);
      const brief = readDeckBrief(adapter.sourceRoot);
      const script = workspace.scriptCurrent(deck.id) ?? "";
      const pages = pageIdsFromScript(script);
      const scriptHash = scriptSnapshotHash(script);
      const phase = ["full", "blind", "contrast"].includes(String(args.phase ?? "")) ? String(args.phase) : "full";
      const freezePath = join(deckDir, "docs", BLIND_FREEZE_FILE);
      const runtime = resolveSubagents();
      const maxReviewers = Math.min(
        HARD_MAX_REVIEWERS,
        Math.max(1, Number.isFinite(Number(args.maxReviewers)) ? Number(args.maxReviewers) : Number(config.review?.maxReviewers ?? DEFAULT_MAX_REVIEWERS)),
      );
      const derived = deriveReviewers(brief, { max: maxReviewers });

      const textOnly = (value) => [
        `deck ${deck.id}（${deck.title}）· 听众评审`,
        value,
      ].join("\n");

      if (!String(brief.audience ?? "").trim()) {
        return {
          deckId: deck.id,
          reviewers: [],
          issues: [],
          text: textOnly("先补 intent.md 的「听众」再评审：没有听众，审稿人就没有立场，写出来的只会是通用写作建议。"),
        };
      }
      if (!script.trim()) {
        return {
          deckId: deck.id,
          reviewers: derived.reviewers,
          issues: [],
          text: textOnly("script 工作副本还是空的：先写初稿（提案 → 确认落版）再来评审。"),
        };
      }
      if (!runtime?.startActivation) {
        return {
          deckId: deck.id,
          reviewers: derived.reviewers,
          issues: [],
          text: textOnly(
            "当前 profile 没有挂 subagent 服务（@deepseek-ai/dsh-subagent），无法启动插件内置审稿人。\n" +
              "请启用 DSH 子 Agent 服务后重试，不需要选择或安装审稿模式。",
          ),
        };
      }
      if (!exec?.agent) {
        return { deckId: deck.id, reviewers: derived.reviewers, issues: [], text: textOnly("评审需要在一个 Agent 会话里调用（找不到调用方 agent）。") };
      }

      const timeoutMs = 300_000;
      const activationResultText = (result) => {
        const blocks = Array.isArray(result?.output) ? result.output : [];
        return blocks
          .filter((block) => block?.type === "text" && String(block.text ?? "").trim())
          .map((block) => block.text)
          .join("\n")
          .trim();
      };
      const runOne = async (reviewer, promptText, parseFn, validate, maxTokens) => {
        const controller = new AbortController();
        const onAbort = () => controller.abort();
        if (exec.signal?.aborted) controller.abort();
        else exec.signal?.addEventListener?.("abort", onAbort, { once: true });
        let timer;
        let activation;
        const outcome = { reviewer, label: reviewer.label };
        const timeout = new Promise((_resolve, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            reject(new Error(`评审超时（${Math.round(timeoutMs / 1000)}s）`));
          }, timeoutMs);
        });
        try {
          activation = await runtime.startActivation({
            provider: REVIEW_AGENT_PROVIDER,
            label: `deck-review:${deck.id}:${reviewer.id}`,
            request: {
              prompt: [
                {
                  type: "text",
                  text: promptText,
                },
              ],
              ...(Number.isSafeInteger(maxTokens) && maxTokens > 0 ? { agentOptions: { maxTokens } } : {}),
              parent: exec.agent,
            },
            signal: controller.signal,
            delivery: "caller",
          });
          const result = await Promise.race([activation.result, timeout]);
          if (controller.signal.aborted) throw new Error("听众评审已取消或超时");
          if (result?.stopReason !== "completed") throw new Error(`审稿人未正常完成（${result?.stopReason ?? "unknown"}）`);
          const text = activationResultText(result);
          const parsed = parseFn(text);
          if (parsed.unparsed) throw new Error("审稿人未返回符合契约的 JSON");
          if (validate) validate(parsed);
          Object.assign(outcome, { parsed, text, stopReason: result.stopReason });
        } catch (error) {
          outcome.error = error instanceof Error ? error.message : String(error);
        } finally {
          clearTimeout(timer);
          exec.signal?.removeEventListener?.("abort", onAbort);
          try {
            await activation?.dispose?.();
          } catch {
            outcome.error = "审稿执行清理失败，请检查 DSH 子任务状态";
          }
        }
        return outcome;
      };

      // ── 第一段：盲审（只给身份与稿件，不给意图）→ 冻结 ──────────────────
      const runBlindPhase = async () => {
        const outcomes = await Promise.all(
          derived.reviewers.map((reviewer) =>
            runOne(
              reviewer,
              blindReviewerPrompt({ reviewer, brief, deckTitle: deck.title, script }),
              parseBlindOutput,
              undefined,
              Math.min(32_000, 8192 + pages.length * 1200),
            ),
          ),
        );
        const ok = outcomes.filter((outcome) => !outcome.error);
        const failed = outcomes.filter((outcome) => outcome.error).map((outcome) => ({ label: outcome.label, error: outcome.error }));
        const reviewers = ok.map((outcome) => ({
          label: outcome.reviewer.label,
          reviewer: outcome.parsed.blind.reviewer,
          whole: outcome.parsed.blind.whole,
          per_page: outcome.parsed.blind.per_page,
        }));
        const answered = new Set(reviewers.flatMap((item) => item.per_page.map((row) => row.page)));
        const missing = pages.filter((page) => !answered.has(page));
        const partial = pages.filter((page) => {
          const hits = reviewers.filter((item) => item.per_page.some((row) => row.page === page)).length;
          return hits > 0 && hits < reviewers.length;
        });
        const coverage = { expected: pages.length, answered: answered.size, missing, partial, complete: missing.length === 0 };
        return { outcomes, failed, reviewers, coverage };
      };

      // ── 第二段：对照（冻结结论 + 意图，做 X / S / Y 三方差分）────────────
      const runContrastPhase = async (frozenRecord) => {
        const byLabel = new Map((frozenRecord?.reviewers ?? []).map((item) => [item.label, item]));
        const outcomes = await Promise.all(
          derived.reviewers.map((reviewer) => {
            const prev = byLabel.get(reviewer.label) ?? frozenRecord?.reviewers?.[0];
            if (!prev) {
              return Promise.resolve({ reviewer, label: reviewer.label, error: "冻结记录里没有这位审稿人的盲审结论" });
            }
            return runOne(
              reviewer,
              contrastReviewerPrompt({
                reviewer,
                blind: { reviewer: prev.reviewer ?? prev.label, whole: prev.whole, per_page: prev.per_page },
                brief,
                deckTitle: deck.title,
                script,
              }),
              parseContrastOutput,
              (parsed) => {
                const bad = parsed.contrast.gaps.find((gap) => gap.evidence && !scriptContainsEvidence(script, gap.evidence));
                if (bad) throw new Error(`对照意见的证据不是稿件原文（${bad.page}），已拒绝采纳`);
              },
              Math.min(24_000, 6000 + pages.length * 900),
            );
          }),
        );
        const ok = outcomes.filter((outcome) => !outcome.error);
        const failed = outcomes.filter((outcome) => outcome.error).map((outcome) => ({ label: outcome.label, error: outcome.error }));
        // 每页一条差距：多位审稿人对同一页的判定合并（悲观取值 否 > 部分 > 是），
        // 读者读出 / 改法取第一条非空，来源记全部审稿人——报告里一页一行，不按审稿人刷屏。
        const rank = { 是: 0, 部分: 1, 否: 2 };
        const byPage = new Map();
        for (const outcome of ok) {
          for (const gap of outcome.parsed.contrast.gaps) {
            const label = outcome.reviewer.label;
            const prev = byPage.get(gap.page);
            if (!prev) {
              byPage.set(gap.page, { ...gap, reviewer: label, from: [label] });
              continue;
            }
            if ((rank[gap.verdict] ?? -1) > (rank[prev.verdict] ?? -1)) {
              byPage.set(gap.page, { ...gap, reviewer: label, from: [...prev.from, label] });
              continue;
            }
            prev.from.push(label);
            prev.x = prev.x || gap.x;
            prev.y = prev.y || gap.y;
            prev.fix = prev.fix || gap.fix;
            prev.evidence = prev.evidence || gap.evidence;
          }
        }
        const gaps = [...byPage.values()]
          .map((gap) => ({ ...gap, reviewer: gap.from.join(" / ") }))
          .sort((a, b) => a.page.localeCompare(b.page));
        const deckGap = ok.map((outcome) => outcome.parsed.contrast.deck_gap).filter(Boolean).join(" / ");
        const deleteCandidates = [...new Set(ok.flatMap((outcome) => outcome.parsed.contrast.delete_candidates))];
        return { outcomes, failed, gaps, deckGap, deleteCandidates };
      };

      const generatedAt = new Date().toISOString();
      const target = join(deckDir, "docs", REVIEW_REPORT_FILE);
      const writeFiles = args.write !== false && !exec.signal?.aborted;
      const labels = derived.reviewers.map((reviewer) => reviewer.label).join(" / ");
      let written = false;
      let frozen = null;

      // 只跑对照：必须用当轮稿件哈希匹配的冻结记录，稿子变了就拒绝（防止拿旧结论评新稿）。
      if (phase === "contrast") {
        if (!existsSync(freezePath)) {
          return {
            deckId: deck.id,
            phase,
            reviewers: [],
            issues: [],
            text: `还没有盲审冻结记录（docs/${BLIND_FREEZE_FILE}）：先跑 phase=blind（或 full）再对照。`,
          };
        }
        try {
          frozen = JSON.parse(readFileSync(freezePath, "utf8"));
        } catch {
          frozen = null;
        }
        const check = verifyFreeze(frozen, scriptHash);
        if (!check.ok) {
          return {
            deckId: deck.id,
            phase,
            scriptHash,
            reviewers: [],
            issues: [],
            text: `${check.reason}（冻结 ${frozen?.scriptHash ?? "无"} / 当前 ${scriptHash}）`,
          };
        }
      }

      // 盲审（full 也走这里）：先冻结再对照，顺序不能反。
      let blind = null;
      if (phase === "full" || phase === "blind") {
        blind = await runBlindPhase();
        if (writeFiles && blind.reviewers.length) {
          mkdirSync(join(deckDir, "docs"), { recursive: true });
          frozen = makeFreezeRecord({ deckId: deck.id, scriptHash, pages, reviewers: blind.reviewers, generatedAt });
          writeFileSync(freezePath, `${JSON.stringify(frozen, null, 2)}\n`, "utf8");
        }
        const coverLine = `覆盖 ${blind.coverage.answered}/${blind.coverage.expected} 页${blind.coverage.missing.length ? `（缺答 ${blind.coverage.missing.join("、")}）` : ""}`;
        const failLine = blind.failed.length
          ? `\n${blind.failed.length} 位审稿人失败：${blind.failed.map((item) => `${item.label}（${item.error}）`).join(" / ")}`
          : "";
        if (phase === "blind") {
          return {
            deckId: deck.id,
            phase,
            scriptHash,
            reviewers: derived.reviewers.map((reviewer) => ({ id: reviewer.id, label: reviewer.label })),
            coverage: blind.coverage,
            issues: [],
            failed: blind.failed,
            written: Boolean(frozen),
            text: `盲审${frozen ? "已冻结" : "完成（dry run 未冻结）"}：${coverLine}${failLine}\n下一步跑 phase=contrast 才知道读者读出和意图差在哪。`,
          };
        }
        if (!blind.reviewers.length) {
          return {
            deckId: deck.id,
            phase,
            scriptHash,
            reviewers: derived.reviewers.map((reviewer) => ({ id: reviewer.id, label: reviewer.label })),
            coverage: blind.coverage,
            issues: [],
            failed: blind.failed,
            written: false,
            text: `盲审没有有效结果，不能进入对照（也不据此判断稿件没有问题）：${coverLine}${failLine}`,
          };
        }
        frozen = frozen ?? makeFreezeRecord({ deckId: deck.id, scriptHash, pages, reviewers: blind.reviewers, generatedAt });
      }

      if (!blind) {
        // 只跑对照：从冻结记录里重建盲审视图（冻结记录就是第一段的事实来源）。
        const frozenReviewers = (frozen?.reviewers ?? []).map((item) => ({
          label: item.label,
          reviewer: item.reviewer,
          whole: item.whole,
          per_page: item.per_page ?? [],
        }));
        const answered = new Set(frozenReviewers.flatMap((item) => item.per_page.map((row) => row.page)));
        blind = {
          outcomes: [],
          failed: [],
          reviewers: frozenReviewers,
          coverage: {
            expected: (frozen?.pages ?? pages).length,
            answered: answered.size,
            missing: (frozen?.pages ?? pages).filter((page) => !answered.has(page)),
            partial: [],
            complete: true,
          },
        };
      }

      const contrast = await runContrastPhase(frozen);
      // F-176：可采纳清单 + G1 逐字匹配（B6 四道闸的第一道，程序判、不花模型）。
      const built = buildFindings(script, contrast.gaps);
      // F-177 / B6 G4：同一页被 ≥2 位独立审稿人命中 → 交叉确认，置信度不再只是单人口径。
      let findings = built.findings.map((finding) => ({
        ...finding,
        reviewers: [...new Set(contrast.gaps.filter((gap) => gap.page === finding.page).flatMap((gap) => gap.from ?? []))],
      }));
      findings = findings.map((finding) => ({ ...finding, crossReviewed: finding.reviewers.length >= 2, reviewers: finding.reviewers.length }));
      let dropped = built.dropped;
      let citation = { checked: 0, citationChecked: false, failed: "" };
      // F-177 / B6 G3：引用核查——一次独立小调用，校对员角色（不是评审员）；
      // 只核对 A 类条目，把 paraphrase 降到 B、unsupported 降到 D（D 仍列出但只作参考）。
      if (findings.length && args.citationCheck !== false && exec?.agent) {
        try {
          const promptText = citationCheckPrompt({
            items: findings.map((finding) => ({ id: finding.id, page: finding.page, evidence: finding.evidence, problem: finding.fix })),
            script,
            deckTitle: deck.title,
          });
          const verifier = { id: "citation", label: "引用核查" };
          // runOne 是评审员的通用入口（解析 + 校验 + 超时）；这里复用同一套隔离与预算。
          const outcome = await runOne(
            verifier,
            promptText,
            (text) => parseCitationCheck(text),
            null,
            Math.min(8000, 1200 + findings.length * 120),
          );
          if (outcome.error) throw new Error(outcome.error);
          const applied = applyCitationChecks(findings, outcome.parsed.checks);
          findings = applied.findings;
          citation = { checked: applied.checked, citationChecked: applied.citationChecked, failed: "" };
        } catch (error) {
          citation = { checked: 0, citationChecked: false, failed: String(error?.message ?? error) };
        }
      }
      // F-183（I-08）：四维评分——对照之后只打分、不出新意见；默认开，args.scores === false 可跳过。
      // 分数带 scriptHash / revision 落盘，两次评审可对照（「改完是不是更好了」不用凭感觉）。
      let scoreMean = null;
      let scoreCompare = null;
      let scoreEntry = null;
      const scoreFailed = [];
      if (phase === "full" && args.scores !== false && exec?.agent && derived.reviewers.length) {
        const records = [];
        for (const reviewer of derived.reviewers) {
          try {
            const outcome = await runOne(
              reviewer,
              scoreReviewerPrompt({ reviewer, brief, deckTitle: deck.title, script }),
              (text) => parseScoreOutput(text),
              null,
              2000,
            );
            if (outcome.error) throw new Error(outcome.error);
            if (!outcome.parsed?.record) throw new Error("打分输出缺维度或分数越界");
            records.push(outcome.parsed.record);
          } catch (error) {
            scoreFailed.push(`${reviewer.label}（${error?.message ?? error}）`);
          }
        }
        if (records.length) {
          scoreMean = mergeScoreRecords(records);
          const scoresFile = join(deckDir, "docs", "review.scores.json");
          const history = existsSync(scoresFile) ? JSON.parse(readFileSync(scoresFile, "utf8")) : [];
          const historyList = Array.isArray(history) ? history : [];
          const previous = historyList[historyList.length - 1] ?? null;
          scoreCompare = compareScores(previous ? { dimensions: previous.scores, average: previous.average } : null, scoreMean);
          const latestRevision = workspace.listScriptRevisions(deck.id)[0]?.revision ?? "";
          scoreEntry = scoreHistoryEntry({ at: generatedAt, scriptHash, revision: latestRevision, mean: scoreMean, compare: scoreCompare });
          if (writeFiles) {
            historyList.push(scoreEntry);
            const kept = historyList.slice(-50);
            writeFileSync(scoresFile, `${JSON.stringify(kept, null, 2)}\n`, "utf8");
            writeFileSync(join(deckDir, "docs", "review.scores.md"), renderScoreHistoryMarkdown(kept, { deckTitle: deck.title }), "utf8");
          }
        }
      }
      const issues = mergeIssues([{ label: "", issues: gapsToIssues(contrast.gaps) }]);
      const bySeverity = { P0: 0, P1: 0, P2: 0 };
      for (const issue of issues) bySeverity[issue.severity] = (bySeverity[issue.severity] ?? 0) + 1;
      const mergedBlind = mergeBlind(blind.reviewers.map((item) => ({ label: item.label, blind: item })));
      const failed = [...blind.failed, ...contrast.failed];
      const counts = { 是: 0, 部分: 0, 否: 0 };
      for (const gap of contrast.gaps) counts[gap.verdict] = (counts[gap.verdict] ?? 0) + 1;

      if (writeFiles) {
        mkdirSync(dirname(target), { recursive: true });
        const body = renderProtocolMarkdown({
          deckTitle: deck.title,
          generatedAt,
          scriptHash,
          reviewers: derived.reviewers,
          mergedBlind,
          coverage: blind.coverage,
          gaps: contrast.gaps,
          deckGap: contrast.deckGap,
          deleteCandidates: contrast.deleteCandidates,
          failed,
        });
        writeFileSync(target, body.endsWith("\n") ? body : `${body}\n`, "utf8");
        // 工作台「评审意见清单」直接读这份清单（不依赖 Agent 再复述一遍），C 类留在 dropped 里可审计。
        writeFileSync(
          join(deckDir, "docs", "review.findings.json"),
          `${JSON.stringify({ deckId: deck.id, generatedAt, scriptHash, findings, dropped }, null, 2)}\n`,
          "utf8",
        );
        written = true;
        // F-186：人话版两本——听众视角的读后感 + 负责人视角的意图差距。
        // 数据全部来自上面的盲审 / 对照 / 清单，不额外调模型；改法建议按页取「最重的一条」。
        const fixSuggestions = [...contrast.gaps]
          .filter((gap) => gap.verdict !== "是" && gap.fix)
          .sort((a, b) => (a.verdict === "否" ? -1 : 0) - (b.verdict === "否" ? -1 : 0));
        const readersPath = "docs/review.readers.md";
        const gapPath = "docs/review.gap.md";
        let titleChain = null;
        try {
          const pageItems = pageIdsFromScript(script).map((page, index) => ({
            page,
            title: script.split(/\n(?=##\s|P\d+\s)/)[index]?.split("\n")[0]?.replace(/^#+\s*/, "").trim() ?? "",
            claim: "",
          }));
          titleChain = analyzeTitleChain(pageItems);
        } catch {
          titleChain = null;
        }
        const titleChainLine = titleChain ? `${titleChain.verdict}${titleChain.stats ? `（${Object.entries(titleChain.stats).map(([key, value]) => `${key} ${value}`).join(" · ")}）` : ""}` : null;
        // 页标题给听众文档用（盲审结果里没有标题，只有页号）
        const pageTitles = Object.fromEntries([...script.matchAll(/^###\s+(P\d+)\s*·\s*(.+)$/gm)].map((match) => [match[1], match[2].trim()]));
        const readersBody = renderReaderReviewMarkdown({
          deckTitle: deck.title,
          generatedAt,
          audience: brief.audience ?? "",
          gaps: contrast.gaps,
          mergedBlind,
          deckGap: contrast.deckGap,
          fixSuggestions,
          pageTitles,
        });
        const gapBody = renderGapReviewMarkdown({
          deckTitle: deck.title,
          generatedAt,
          scriptHash,
          audience: brief.audience ?? "",
          intentText: [brief.audience, brief.takeaway].filter(Boolean).join(" · "),
          gaps: contrast.gaps,
          mergedBlind,
          deckGap: contrast.deckGap,
          findings,
          dropped,
          scores: scoreMean ? { average: scoreMean.average, dimensions: scoreMean.dimensions, compare: scoreCompare } : null,
          titleChain: titleChainLine ? { verdict: titleChainLine } : null,
          fixSuggestions,
        });
        writeFileSync(join(deckDir, "docs", "review.readers.md"), readersBody, "utf8");
        writeFileSync(join(deckDir, "docs", "review.gap.md"), gapBody, "utf8");
        appendChangelogNote({
          deckDir,
          note: `听众评审（两段式：盲审 ${blind.coverage.answered}/${blind.coverage.expected} 页 → 对照 是${counts.是}/部分${counts.部分}/否${counts.否}）`,
          actor: "agent",
        });
      }
      store.recordEvent({
        type: "deck.review.experts",
        deckId: deck.id,
        sessionId,
        actor: "agent",
        status: contrast.failed.length && contrast.outcomes.length === contrast.failed.length ? "failed" : "succeeded",
        payload: {
          phase,
          scriptHash,
          reviewers: derived.reviewers.map((reviewer) => reviewer.id),
          audience: brief.audience ?? "",
          coverage: { expected: blind.coverage.expected, answered: blind.coverage.answered, missing: blind.coverage.missing },
          verdicts: counts,
          total: issues.length,
          bySeverity,
          failed: failed.map((item) => item.label),
          written,
        },
      });
      const failureLine = failed.length
        ? `\n${failed.length} 位审稿人失败：${failed.map((item) => `${item.label}（${item.error}）`).join(" / ")}`
        : "";
      return {
        deckId: deck.id,
        phase,
        scriptHash,
        reviewers: derived.reviewers.map((reviewer) => ({ id: reviewer.id, label: reviewer.label, audience: reviewer.audience })),
        coverage: blind.coverage,
        blind: mergedBlind,
        gaps: contrast.gaps,
        deckGap: contrast.deckGap,
        deleteCandidates: contrast.deleteCandidates,
        issues,
        findings,
        dropped,
        citation,
        bySeverity,
        failed,
        written,
        text:
          // F-186：先讲人话（听众读到了什么 / 卡在哪 / 先改哪几页），内部口径压到括号里一行。
          plainReviewSummary({
            deckTitle: deck.title,
            gaps: contrast.gaps,
            mergedBlind,
            deckGap: contrast.deckGap,
            readersDoc: written ? "docs/review.readers.md" : "",
            gapDoc: written ? "docs/review.gap.md" : "",
            missing: failed.map((item) => item.label),
          }) +
          `\n\n（内部口径：审稿人 ${labels}；盲审覆盖 ${blind.coverage.answered}/${blind.coverage.expected} 页；对照 是 ${counts.是} / 部分 ${counts.部分} / 否 ${counts.否}${scoreMean ? `；四维均分 ${scoreMean.average}` : ""}${failureLine.replace(/\n/g, " ")}）` +
          `${written ? `\n已写入：${target} · docs/review.readers.md · docs/review.gap.md（冻结：docs/${BLIND_FREEZE_FILE}）` : "\n（dry run，未写文件）"}` +
          `\n给谁念：先按上面人话讲给用户听（不要念 P0/P1/置信度），再问要不要按「先改哪几页」逐条提案。\n` +
          `可采纳清单（证据在稿件里逐字命中，A 可定位 / B 转述或支撑偏弱 / D 参考）：${findings.length ? findings.map((item) => `${item.id} · ${item.page} · ${item.severity} · ${item.confidence}${item.crossReviewed ? " · 交叉确认" : ""}`).join(" / ") : "无"}` +
          `${citation.citationChecked ? `\n引用核查：${citation.checked} 条已由独立校对核对（G3）` : citation.failed ? `\n引用核查未完成：${citation.failed}（A 类按 G1 结果保留，回复里要说明没做 G3）` : ""}` +
          `${dropped.length ? `\n无法核实（C 类，禁止据此改稿，只告诉用户）：${dropped.map((item) => `${item.id} · ${item.page}`).join(" / ")}` : ""}` +
          "\n改稿时按清单逐条提案：deck_script_propose_edits 的每条 edit 带上 reviewRef（如 R01）+ severity + confidence + evidence；C 类一条都不要提。\n" +
          "第二轮用的是第一段冻结的盲审结论，不是重新评审；工作台脚本页会把这批意见列成清单，用户勾选后点「接受并更新」合成一条 revision。" +
          (scoreMean ? `\n${renderScoreSummary({ mean: scoreMean, compare: scoreCompare })}` : "") +
          (scoreFailed.length ? `\n评分未完成：${scoreFailed.join(" / ")}` : ""),
        scores: scoreMean,
        scoreCompare,
        scoreFailed,
      };
    }),
  });

  // F-120：脚本工作副本错位修复。历史上「提案落错页」把 P01–P06 的内容写反（标题行没跟着改），
  // 之后每次 propose_edit 的 before/after 都对不上、改到的也不是用户看到的页。manifest 是出图/UI
  // 的事实来源，这里按 manifest 顺序重建工作副本（正文按标题回收，避免丢内容）。
  tools.push({
    name: "deck_script_repair",
    description:
      "体检并修复脚本工作副本：如果 script/current.md 的页内容与 manifest（工作台/出图看到的标题）错位，" +
      "按 manifest 顺序重建 script/current.md，正文按标题回收不丢内容，保存为新 revision。" +
      "dryRun=true 时只体检不写。用户遇到「提案落错页 / 镜像」时先用它。",
    parameters: {
      type: "object",
      properties: {
        deckId: { type: "string" },
        dryRun: { type: "boolean", description: "只体检，不写文件（默认 false）" },
      },
      required: ["deckId"],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: "object",
        properties: {
          deckId: { type: "string" },
          mismatched: { type: "number" },
          repaired: { type: "boolean" },
          revision: { type: "string" },
        },
      },
      render: (_args, value) => [{ type: "text", text: String(value?.text ?? "") }],
    },
    execute: withToolEvent(store, "deck_script_repair", async (args) => {
      const adapter = adapterFor(args.deckId);
      const deck = workspace.ensureDeck(adapter, { styleBrief: config.styleBrief });
      const current = workspace.scriptCurrent(deck.id);
      if (current == null) throw new Error(`script 工作副本缺失：${deck.id}`);
      const parsed = parseSectionedPages(current);
      // 只拿「唯一标题」做标题匹配：新建 deck 的占位稿 6 页标题可能全是「待定」，
      // 用标题建 Map 会互相覆盖，把对得上的页全报成错位（S22 真机暴露的假阳性）。
      const titleCounts = new Map();
      for (const page of parsed) {
        const title = String(page.title ?? "").trim();
        titleCounts.set(title, (titleCounts.get(title) ?? 0) + 1);
      }
      const byTitle = new Map(
        parsed
          .filter((page) => titleCounts.get(String(page.title ?? "").trim()) === 1)
          .map((page) => [String(page.title ?? "").trim(), page]),
      );
      const problems = [];
      const blocks = [];
      deck.slides.forEach((slide, index) => {
        const pageNo = index + 1;
        const pageId = `p${String(pageNo).padStart(2, "0")}`;
        const matched = byTitle.get(String(slide.title ?? "").trim()) || parsed.find((page) => page.page === pageNo) || null;
        if (!matched || matched.page !== pageNo) {
          problems.push(`${pageId} 位置错位（manifest「${slide.title}」/ 副本第 ${matched?.page ?? "?"} 页是它）`);
        }
        const body = String(matched?.fields?.["正文"] ?? matched?.content ?? "").trim();
        const lines = [
          `### P${String(pageNo).padStart(2, "0")} · ${slide.title}`,
          `**标题**：${slide.title}`,
          `**副标题**：${slide.question ?? ""}`,
          `**主张**：${slide.claim ?? ""}`,
          `**正文**：${body || "（待补：3–5 句正文）"}`,
          `**提示词**：${slide.visualBrief ?? "（待补：visualBrief，说明画面要看到什么）"}`,
        ];
        blocks.push(lines.join("\n"));
      });
      const headMatch = /^([\s\S]*?)(?=^### P\d+)/m.exec(current);
      const preamble = (headMatch ? headMatch[1] : "").replace(/\n+$/, "");
      const nextText = `${preamble ? `${preamble}\n\n` : ""}${blocks.join("\n\n")}\n`;
      const mismatched = problems.length;
      if (!mismatched) {
        return { deckId: deck.id, mismatched: 0, repaired: false, revision: "", text: `工作副本 ${deck.slides.length} 页与 manifest 一致，不需要修复。` };
      }
      if (args?.dryRun) {
        return { deckId: deck.id, mismatched, repaired: false, revision: "", text: `发现 ${mismatched} 页错位：\n${problems.join("\n")}\n（dryRun：未写文件；去掉 dryRun 即按 manifest 顺序重建）` };
      }
      const saved = workspace.saveScriptRevision(deck.id, nextText, `repair: rebuild ${mismatched} page(s) from manifest (F-120)`);
      store.recordEvent({
        type: "deck.script.repair",
        deckId: deck.id,
        actor: "agent",
        status: "succeeded",
        payload: { mismatched, revision: saved.revision, problems },
      });
      return {
        deckId: deck.id,
        mismatched,
        repaired: true,
        revision: saved.revision,
        text: `已修复 ${mismatched} 页错位，工作副本重建为 ${saved.revision}（按 manifest 顺序；正文按标题回收）。\n${problems.join("\n")}\n现在可以正常逐页提案了。`,
      };
    }),
  });

  // F-119：批量提案——整本 / 多页重写时一次调用提交。没有这个工具时，Agent 会图省事把
  // 「可直接粘贴的 markdown」甩给用户，让用户自己覆盖 script 文件（工作台看不到、也没法确认）。
  const toolMap = new Map(tools.map((tool) => [tool.name, tool]));
  tools.push({
    name: "deck_script_propose_edits",
    description:
      "批量提案：一次提交同一 deck 多条字段修改（例如整本重写 10 页的 title/question/body/visualBrief）。" +
      "每条 edit 都会生成一条 waiting-user 提案并返回 proposalId；用户仍需确认后才落 revision。" +
      "多页改动优先用这个工具，不要逐条重复调用 deck_script_propose_edit，更不要把内容输出成" +
      "「可直接粘贴」的 markdown 让用户手工覆盖文件。",
    parameters: {
      type: "object",
      properties: {
        deckId: { type: "string" },
        autoland: {
          type: "boolean",
          description:
            "首稿自动落版：仅当这份 deck 一次都没落过 revision（首稿）时可用——提交的这批修改立即落成 revision，不再逐条等用户确认。" +
            "有历史版本的 deck 会被工具拒绝（走普通提案 + 用户确认）。自改轮次 / 摘要请一起传，落版会记进 autoland 元数据。",
        },
        selfReviewRounds: { type: "number", description: "首稿自改跑了几轮（0–3；自动落版记录用）" },
        selfReviewSummary: { type: "string", description: "自改摘要：主要改了哪几类（≤80 字，落版后要原样告诉用户）" },
        reviewId: { type: "string", description: "这次自改依据的评审记录 id / 路径（可选）" },
        edits: {
          type: "array",
          minItems: 1,
          maxItems: 60,
          items: {
            type: "object",
            properties: {
              page: { type: "number", description: "页号（script 里的 N）" },
              field: strEnum([...Object.keys(SCRIPT_FIELD_CELL), ...CONTRACT_FIELD_KEYS, "body", "visualBrief"]),
              newValue: { type: "string", description: "新值全文（不是增量）" },
              reason: { type: "string" },
              reviewRef: { type: "string", description: "评审清单条目号（如 R03）" },
              severity: { type: "string", description: "P0 / P1 / P2" },
              confidence: { type: "string", description: "A / B / C / D；C 不许提" },
              evidence: { type: "string", description: "评审原文证据（逐字）" },
            },
            required: ["page", "field", "newValue"],
            additionalProperties: false,
          },
        },
      },
      required: ["deckId", "edits"],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: "object",
        properties: {
          deckId: { type: "string" },
          pendingCount: { type: "number" },
          proposals: {
            type: "array",
            items: {
              type: "object",
              properties: { pageId: { type: "string" }, field: { type: "string" }, proposalId: { type: "string" } },
            },
          },
        },
      },
      render: (_args, value) => [{ type: "text", text: String(value?.text ?? "") }],
    },
    execute: withToolEvent(store, "deck_script_propose_edits", async (args, exec) => {
      const edits = Array.isArray(args?.edits) ? args.edits : [];
      if (!edits.length) throw new Error("edits 不能为空");
      if (edits.length > 60) throw new Error(`一次最多 60 条（收到 ${edits.length}）`);
      const single = toolMap.get("deck_script_propose_edit");
      if (!single) throw new Error("内部错误：找不到 deck_script_propose_edit");
      const created = [];
      const styleHints = [];
      // F-183 附带：一条坏 edit 不许拖垮整批（60 条里 1 条定位不到，另外 59 条应该照常提案）。
      // 但首稿自动落版例外——半份稿自动落库比报错更糟，所以 autoland 时任何失败都直接抛出，不落版。
      const failures = [];
      for (const edit of edits) {
        let value;
        try {
          value = await single.execute(
            {
              deckId: args.deckId,
              page: edit?.page,
              field: edit?.field,
              newValue: edit?.newValue,
              reason: edit?.reason ?? "",
              reviewRef: edit?.reviewRef,
              severity: edit?.severity,
              confidence: edit?.confidence,
              evidence: edit?.evidence,
            },
            exec,
          );
        } catch (error) {
          failures.push({ page: edit?.page, field: String(edit?.field ?? ""), error: String(error?.message ?? error) });
          if (args.autoland === true) {
            throw new Error(
              `首稿自动落版中止：${failures.length} 条修改没能应用（${failures.map((item) => `${item.page}·${item.field}：${item.error}`).join(" / ")}）。` +
                "没有落版，改完这几条后整批重提；不要分两批落首稿。",
            );
          }
          continue;
        }
        if (Array.isArray(value?.styleHints)) styleHints.push(...(value?.styleHints ?? []));
        created.push({
          pageId: value?.slideIds?.[0] ?? `p${String(edit?.page).padStart(2, "0")}`,
          field: String(edit?.field ?? ""),
          proposalId: String(value?.proposalId ?? ""),
        });
      }
      // F-173：首稿自动落版——这批修改合成一条 revision 直接落库，不再逐条等确认。
      if (args.autoland === true) {
        const proposals = created.map((item) => workspace.proposal(item.proposalId)).filter(Boolean);
        const landed = applyFirstDraftBatch({
          store,
          workspace,
          proposals,
          autoland: {
            draftRound: 1,
            selfReview: {
              rounds: Number(args.selfReviewRounds ?? 0),
              summary: String(args.selfReviewSummary ?? ""),
              reviewId: String(args.reviewId ?? ""),
            },
          },
          sessionId: sessionIdOf(exec),
          syncScriptToSource,
        });
        const pending = workspace.listProposals(args.deckId, "waiting-user");
        const record = landed.autoland ?? {};
        return {
          deckId: args.deckId,
          proposals: created,
          autoland: { revision: landed.revision, rolledInto: created.length, selfReview: record.selfReview ?? {} },
          pendingCount: pending.length,
          styleHints,
          text:
            `首稿自动落版：${created.length} 条修改已合成 revision ${landed.revision}（旧版保留，可回滚）。\n` +
            `自改 ${record.selfReview?.rounds ?? 0} 轮${record.selfReview?.summary ? `，主要改了「${record.selfReview.summary}」` : ""}。\n` +
            `这是首稿、未经用户逐条确认；落版后要主动告诉用户「自改摘要 + 可回滚」，回滚用 deck_draft_rollback。` +
            `${landed.sourceSync ? (landed.sourceSync.ok ? "源 script.md 已回写并提交。" : `源 script.md 已回写，git 未提交：${landed.sourceSync.error}。`) : ""}` +
            `${styleHints.length ? `\n文案提醒（不阻断，建议下轮改）：\n${styleHints.map((hint) => `- ${hint}`).join("\n")}` : ""}`,
        };
      }
      if (!created.length) {
        throw new Error(`${failures.length} 条修改都没能应用：${failures.map((item) => `${item.page}·${item.field}：${item.error}`).join(" / ")}`);
      }
      const pendingNow = workspace.listProposals(args.deckId, "waiting-user");
      const lines = created.map((item) => `${item.pageId} · ${item.field} → ${item.proposalId}`);
      const failedLine = failures.length
        ? `\n${failures.length} 条没能应用（其余已提案，这几条要重新定位后补提）：${failures.map((item) => `${item.page}·${item.field}：${item.error}`).join(" / ")}`
        : "";
      return {
        deckId: args.deckId,
        proposals: created,
        failures,
        pendingCount: pendingNow.length,
        styleHints,
        text: `已提交 ${created.length} 条提案（waiting-user）：\n${lines.join("\n")}${failedLine}\n队列：整个 deck ${pendingNow.length} 条待确认。可以逐条确认，或在工作台点「全部确认落版」；确认前不要渲染。${styleHints.length ? `\n文案提醒（不阻断提案，建议先改）：\n${styleHints.map((hint) => `- ${hint}`).join("\n")}` : ""}`,
      };
    }),
  });

  // F-71：所有工具执行前先对齐 adapters（新建 / 删除的 deck 立刻可见）。
  for (const tool of tools) {
    const execute = tool.execute;
    tool.execute = async (args, exec) => {
      refreshAdapters();
      return execute(args, exec);
    };
  }

  // ── 4.6 deck_image_review（F-178 图片评审：保真转写×2 → 表意盲述 + 对照 → 五维打分）──
  tools.push({
    name: "deck_image_review",
    description:
      "审已出图的页：图有没有如实呈现这页（保真）、有没有扭曲或超载意思（表意）、贴合与承接如何（五维打分）。" +
      "做法是视觉模型只做逐字转写（两次），判定全由程序做 diff；不引入 OCR。" +
      "出图后自动/按需调用；保真不过＝错字错数，必须重出该页；同一页 3 次不过转人工。" +
      "结果写进该版本 qa.json 的 review 字段 + docs/review.images.md。",
    parameters: {
      type: "object",
      properties: {
        deckId: { type: "string", description: "deck id" },
        page: { type: "string", description: "页码，p01 或 1 都行" },
        image: { type: "string", description: "指定图片路径（可选；缺省用该页最新版本的图）" },
        intent: { type: "string", description: "本页在整份 deck 里的意图（可选；缺省用 intent 文档的听众 / 目的）" },
        skipBlind: { type: "boolean", description: "跳过盲述（省一次调用，但表意只能靠对照；一般不跳过）" },
      },
      required: ["deckId", "page"],
      additionalProperties: false,
    },
    output: { schema: { type: "object", properties: { deckId: { type: "string" }, pageId: { type: "string" }, gate: { type: "boolean" } } }, render: (_args, value) => [{ type: "text", text: String(value?.text ?? "") }] },
    execute: withToolEvent(store, "deck_image_review", async (args) => {
      const adapter = adapterFor(args.deckId);
      const deck = workspace.ensureDeck(adapter, { styleBrief: config.styleBrief });
      const rawPage = String(args.page ?? "").trim();
      const pageId = /^p\d+$/i.test(rawPage) ? rawPage.toLowerCase() : `p${String(Number(rawPage) || 0).padStart(2, "0")}`;
      const slide = deck.slides.find((candidate) => candidate.id === pageId);
      if (!slide) throw new Error(`${deck.id} 没有 ${pageId}（现有页：${deck.slides.map((item) => item.id).join(" / ")}）`);

      const deckDir = workspace.deckDir(deck.id);
      const resolveImage = () => {
        if (args.image) {
          const candidate = resolve(String(args.image));
          if (!existsSync(candidate)) throw new Error(`指定的图不存在：${candidate}`);
          return candidate;
        }
        const versionsDir = join(deckDir, "slides", pageId, "versions");
        if (!existsSync(versionsDir)) throw new Error(`${pageId} 还没出过图（没有 versions/），先出图再评审`);
        const versions = readdirSync(versionsDir).filter((name) => /^v\d+$/.test(name)).sort();
        for (let index = versions.length - 1; index >= 0; index -= 1) {
          for (const name of ["image.png", "image.jpg", "image.jpeg", "image.webp"]) {
            const candidate = join(versionsDir, versions[index], name);
            if (existsSync(candidate)) return candidate;
          }
        }
        throw new Error(`${pageId} 的最新版本里没有图片文件，先出图再评审`);
      };
      const imagePath = resolveImage();

      // C1 的对照基准 = 出这张图时用的 prompt（不是当前 script：图可能是旧稿出的）。
      const versionDirs = readdirSync(join(deckDir, "slides", pageId, "versions")).filter((name) => /^v\d+$/.test(name)).sort();
      const versionDir = join(deckDir, "slides", pageId, "versions", versionDirs[versionDirs.length - 1]);
      const prompts = [...versionDirs].reverse()
        .map((name) => join(deckDir, "slides", pageId, "versions", name, "prompt.txt"))
        .filter((file) => existsSync(file))
        .map((file) => readFileSync(file, "utf8"));
      const expected = pickRenderExpectations(prompts) ?? { title: slide.title, question: slide.question, claim: slide.claim, body: "", quoted: [], numbers: [] };
      const renderPrompt = prompts.find((prompt) => (pickRenderExpectations([prompt])?.title || "") !== "") ?? "";
      // 图是不是旧稿出的：prompt 里的标题 vs 当前 script 标题（不同就提示重出，而不是当「错字」）。
      const script = workspace.scriptCurrent(deck.id) ?? "";
      const pageNo = Number(pageId.replace(/^p/, ""));
      const pageData = parseSectionedPages(script).find((page) => page.page === pageNo);
      const scriptTitle = pageData?.title || slide.title;
      const drift = Boolean(expected.title && scriptTitle && expected.title !== scriptTitle)
        ? `图是按旧稿出的：图上标题「${expected.title}」，当前稿件标题「${scriptTitle}」——先确认是不是要重出这页`
        : "";
      const pageText = pageData
        ? [`标题：${pageData.title}`, `副标题：${pageData.question}`, `主张：${pageData.claim}`, pageData.content].filter(Boolean).join("\n")
        : `标题：${slide.title}\n副标题：${slide.question}\n主张：${slide.claim}`;
      const brief = readDeckBrief(adapter.sourceRoot);
      const intentText = args.intent || [brief.audience ? `听众：${brief.audience}` : "", brief.topic ? `主题：${brief.topic}` : "", brief.intent ? `目的：${brief.intent}` : ""].filter(Boolean).join("；");
      const linked = linkedDesignStyle(deck.id);
      const prevSlide = deck.slides.find((item) => item.order === slide.order - 1);

      const settings = config.imageReview ?? {};
      const apiKey = env[settings.apiKeyEnv] || (settings.apiKeyFile ? readKeyFromFile(settings.apiKeyFile, settings.apiKeyEnv) : "");
      // C1 + C2 + C3 + C4：编排在 lib/image-review.js（verify 脚本共用同一条路径）。
      // 封面页：署名 / 场合 / 日期是版式要求，判「超载」时要放过（C2 校正，见 normalizeContrastForPage）。
      const isCover = slide.order === 1 || /封面/.test(String(slide.fields?.["角色"] ?? ""));
      const outcome = await runImageReview({
        imagePath,
        pageId,
        expected,
        pageText,
        intentText,
        styleAnchor: linked ? `${linked.abbr} ${linked.name}：${linked.brief}` : config.styleBrief,
        prevPageText: prevSlide ? `${prevSlide.id} ${prevSlide.title}：${prevSlide.claim || prevSlide.question || ""}` : "",
        visualBrief: String(slide.visualBrief ?? "").trim(),
        cover: isCover,
        settings: { ...settings, apiKey },
        skipBlind: args.skipBlind === true,
        fetchImpl: visionFetch ?? fetch,
      });
      let { fidelity, dual, meaning, contrast, review, advice, blind } = outcome;
      const { transcription, blindError } = outcome;
      // 图是按旧稿出的：差异来自「稿件改了、图没重出」，不是图写错字 / 说反话。
      // 单独标「旧稿」，不把版本差异判成扭曲（否则用户会去改 prompt，其实该做的是确认要不要重出）。
      if (drift) {
        meaning = { verdict: "旧稿", severity: "", score: 3 };
        review = { ...review, gate: false, blockers: ["图基于旧稿（与当前稿件不一致）：先确认是否重出这页", ...review.blockers.filter((line) => !/表意/.test(line))] };
      }

      // 落盘：qa.json 的 review 字段（保留历史 attempts，3 次阈值靠它累计）。
      const qaFile = join(versionDir, "qa.json");
      const previousQa = existsSync(qaFile) ? JSON.parse(readFileSync(qaFile, "utf8")) : {};
      const attempts = attemptsOf(previousQa) + 1;
      const mustHuman = review.mustHuman || (!review.gate && attempts >= 3);
      const record = {
        page: pageId,
        revision: versionDirs[versionDirs.length - 1],
        image: relative(deckDir, imagePath),
        verdict: mustHuman && !review.gate ? "转人工" : meaning.verdict === "通过" && fidelity.verdict === "通过" ? "通过" : "需重出",
        gate: review.gate,
        scores: review.scores,
        total: review.total,
        blockers: review.blockers,
        attempts,
        mustHuman,
        fidelity: { verdict: fidelity.verdict, unstable: fidelity.unstable, diffs: fidelity.blockers },
        meaning,
        contrast,
        blind,
        transcription,
        dual,
        advice,
        model: settings.model || "",
        drift,
        checkedAt: new Date().toISOString(),
      };
      const nextQa = { ...previousQa, review: record };
      writeFileSync(qaFile, `${JSON.stringify(nextQa, null, 2)}\n`, "utf8");

      // 整本汇总：把每页最新版本的 review 拍平成 review.images.md。
      const rows = [];
      for (const item of deck.slides) {
        const dir = join(deckDir, "slides", item.id, "versions");
        if (!existsSync(dir)) continue;
        const stamps = readdirSync(dir).filter((name) => /^v\d+$/.test(name)).sort();
        for (let index = stamps.length - 1; index >= 0; index -= 1) {
          const file = join(dir, stamps[index], "qa.json");
          if (!existsSync(file)) continue;
          try {
            const qa = JSON.parse(readFileSync(file, "utf8"));
            if (qa?.review?.scores) rows.push({ ...qa.review, page: item.id });
          } catch { /* 坏 qa 不影响汇总 */ }
          break;
        }
      }
      const docsDir = join(deckDir, "docs");
      mkdirSync(docsDir, { recursive: true });
      writeFileSync(join(docsDir, "review.images.md"), renderImageReviewMarkdown({ deckTitle: deck.title, generatedAt: new Date().toISOString(), rows }), "utf8");

      const scoreLine = Object.entries(review.scores).map(([key, value]) => `${key} ${value}`).join(" · ");
      const diffLines = (fidelity.blockers ?? []).slice(0, 6).map((diff) => {
        if (diff.type === "missing") return `✗ 缺 ${diff.field}：应出现「${String(diff.expected).slice(0, 40)}」`;
        if (diff.type === "extra") return `✗ 多出 ${diff.field}：「${String(diff.actual).slice(0, 40)}」`;
        return `✗ 错 ${diff.field}：应为「${String(diff.expected).slice(0, 40)}」，图上「${String(diff.actual).slice(0, 40)}」${diff.ratio != null ? `（差异 ${(diff.ratio * 100).toFixed(1)}%）` : ""}`;
      });
      const text = [
        `${pageId}（${versionDirs[versionDirs.length - 1]}）图片评审：${record.verdict} · 门禁${record.gate ? "过" : "不过"}`,
        `五维：${scoreLine}（总分 ${review.total}/25）`,
        "",
        `保真（转写两次${dual.stable ? "一致" : `不一致：${dual.unstable.join(" / ")}`}）：${fidelity.verdict}`,
        ...(diffLines.length ? diffLines : ["✓ 标题 / 数字 / 正文逐段对得上"]),
        "",
        `表意：${meaning.verdict}${meaning.severity ? `（${meaning.severity}）` : ""}`,
        blind ? `盲述：${blind.what}｜想让我：${blind.ask}${blind.confusing && blind.confusing !== "无" ? `｜费解：${blind.confusing}` : ""}` : "盲述：已跳过（只做了对照）",
        contrast.contradiction ? `矛盾：${contrast.contradiction}` : contrast.extra.length ? `多出：${contrast.extra.join("；")}` : "对照：与主张一致，无多出信息",
        "",
        ...(advice.length ? ["怎么改（按 C5 顺序）：", ...advice.map((item) => `· ${item.failure} → 先${item.firstChange}；重出范围：${item.scope}`)] : ["可交付：保真与表意都过（其余维度只记录，不做门禁）。"]),
        ...(drift ? [`⚠ ${drift}`] : []),
        ...(record.blockers.length ? [`门禁未过：${record.blockers.join("；")}`] : []),
        mustHuman ? `⚠ 同一页第 ${attempts} 次不过 → 转人工（记录在 qa.json 的 review.attempts；不要无限重试）。` : "",
        `已写入：${relative(deckDir, qaFile)}（review 字段）· docs/review.images.md`,
      ].filter(Boolean).join("\n");

      return { deckId: deck.id, pageId, revision: versionDirs[versionDirs.length - 1], gate: review.gate, mustHuman, attempts, scores: review.scores, drift, text };
    }),
  });

  // ── 4.7 deck_title_chain（F-179 标题串读：只看标题能不能推出故事线）──────────
  tools.push({
    name: "deck_title_chain",
    description:
      "标题串读测试：把稿件的页标题按顺序串起来，判断「只看标题能不能推出故事线」。" +
      "只查机器能查的：占位标题 / 重复标题 / 相邻标题断链 / 有没有收束页。确定性、不花模型。" +
      "写或大改 script 前、用户问「故事线通不通」时先跑它；推不出就先修标题链再往下写。",
    parameters: {
      type: "object",
      properties: { deckId: { type: "string", description: "deck id" } },
      required: ["deckId"],
      additionalProperties: false,
    },
    output: { schema: { type: "object", properties: { deckId: { type: "string" }, verdict: { type: "string" } } }, render: (_args, value) => [{ type: "text", text: String(value?.text ?? "") }] },
    execute: withToolEvent(store, "deck_title_chain", async (args) => {
      const adapter = adapterFor(args.deckId);
      const deck = workspace.ensureDeck(adapter, { styleBrief: config.styleBrief });
      const script = workspace.scriptCurrent(deck.id) ?? "";
      const pages = parseSectionedPages(script);
      if (!pages.length) {
        return { deckId: deck.id, verdict: "推不出", text: "稿件里还没有可读的页标题（script 工作副本为空）。先写 P01 起的分节标题，再跑标题串读。" };
      }
      const analysis = analyzeTitleChain(pages.map((page) => ({ page: page.page, title: page.title, claim: page.claim })));
      return {
        deckId: deck.id,
        verdict: analysis.verdict,
        stats: analysis.stats,
        text: `${renderTitleChain({ deckTitle: deck.title, analysis })}\n（这份报告是确定性判断：只查占位 / 重复 / 断链 / 收束，不评价标题文采。）`,
      };
    }),
  });

  // ── F-125：logo 水印 ──────────────────────────────────────────────────────
  tools.push({
    name: "deck_watermark_assets",
    description:
      "列出 assets/ 里可用的水印素材（按分类，如 logo）。用户说「加水印」「盖个 logo」「用某某水印」时先调它，" +
      "把可选的 id 报给用户确认用哪个（只有一个时可以直接用并说明）。只列 PNG 可水印素材；SVG 会标出来但需要先转 PNG。",
    parameters: { type: "object", properties: { category: { type: "string", description: "只看某一分类，如 logo（可选）" } }, additionalProperties: false },
    output: { schema: { type: "object", properties: {} }, render: (_args, value) => [{ type: "text", text: String(value?.text ?? "") }] },
    execute: withToolEvent(store, "deck_watermark_assets", async (args) => {
      const { categories, root } = listAssets(REPO_ROOT);
      const filtered = args?.category ? categories.filter((category) => category.category === String(args.category).toLowerCase()) : categories;
      const lines = [];
      for (const category of filtered) {
        lines.push(`分类「${category.category}」：`);
        for (const item of category.items) {
          const size = `${Math.max(1, Math.round(item.bytes / 1024))}KB`;
          lines.push(item.watermarkable ? `  • ${item.id}（${size}，PNG，可直接水印）` : `  • ${item.id}（${size}，${item.format.toUpperCase()}，需先转 PNG 才能水印）`);
        }
      }
      if (!lines.length) lines.push("assets/ 下还没有可用的水印素材（把 logo PNG 放到 assets/logo/ 即可）。");
      lines.push(`默认位置：右上角；可改 ${positionLine()}。`);
      return { root, categories: filtered, deckId: null, text: lines.join("\n") };
    }),
  });

  tools.push({
    name: "deck_watermark_apply",
    description:
      "给 deck 的页面盖 logo 水印（每个页面一张，默认右上角）。用户说「加水印 / 每个页面打个 logo」时用；" +
      "先用 deck_watermark_assets 选素材。原图不覆盖：每次盖出一版新 revision（vNNN），旧图保留、可回看。" +
      "只处理已出图的 PNG 页面；没出图的页会列在跳过里。",
    parameters: {
      type: "object",
      properties: {
        deckId: { type: "string", description: "deck id" },
        asset: { type: "string", description: "水印素材 id / 文件名，如 logo/deckline-logo.png" },
        position: strEnum(WATERMARK_POSITIONS),
        opacity: { type: "number", description: "不透明度 0.1–1，默认 0.85" },
        scale: { type: "number", description: "logo 宽度占页宽比例 0.03–0.5，默认 0.14" },
        pages: { type: "array", items: { type: "string" }, description: "只盖这些页（如 [\"p01\",\"p02\"]）；不传=全部" },
        dryRun: { type: "boolean", description: "只体检不落盘" },
      },
      required: ["deckId", "asset"],
      additionalProperties: false,
    },
    output: { schema: { type: "object", properties: {} }, render: (_args, value) => [{ type: "text", text: String(value?.text ?? "") }] },
    execute: withToolEvent(store, "deck_watermark_apply", async (args) => {
      const deckId = String(args?.deckId ?? "").trim();
      const adapter = adapters.find((item) => item.id === deckId);
      if (!adapter) throw new Error(`未知 deck：${deckId}（可用：${adapters.map((item) => item.id).join("、") || "无"}）`);
      const deck = workspace.ensureDeck(adapter, { styleBrief: config.styleBrief });
      if (!deck) throw new Error(`manifest 缺失：${deckId}`);

      const position = String(args?.position ?? "top-right");
      if (!WATERMARK_POSITIONS.includes(position)) throw new Error(`position 只能是 ${WATERMARK_POSITIONS.join(" / ")}`);
      const opacity = Math.min(Math.max(Number(args?.opacity ?? 0.85) || 0.85, 0.1), 1);
      const scale = Math.min(Math.max(Number(args?.scale ?? 0.14) || 0.14, 0.03), 0.5);
      const dryRun = args?.dryRun === true;

      const found = findAsset(REPO_ROOT, args?.asset);
      if (!found.ok) {
        const candidates = (found.candidates ?? []).map((item) => item.id);
        const reason = found.reason === "ambiguous" ? "有多个素材匹配" : found.reason === "empty" ? "没给素材名" : "没找到这个素材";
        throw new Error(`${reason}：「${args?.asset ?? ""}」。可选：${candidates.join("、") || "（assets/logo/ 里没有 PNG）"}。需要先转成 PNG 才能合成水印。`);
      }
      const asset = found.asset;
      if (!asset.watermarkable) throw new Error(`${asset.id} 不是 PNG（${asset.format}），水印合成只支持 PNG；请先导出 PNG 再放到 assets/${asset.category}/。`);
      const logoBuffer = readPngFile(asset.path);

      const wanted = Array.isArray(args?.pages) ? new Set(args.pages.map((page) => String(page))) : null;
      const applied = [];
      const skipped = [];
      for (const slide of deck.slides ?? []) {
        const label = slide.id;
        if (wanted && !wanted.has(slide.id)) continue;
        const slideDir = workspace.slideDir(deckId, slide.id);
        const versionsDir = join(slideDir, "versions");
        let sourceFile = null;
        let sourceRevision = null;
        if (existsSync(versionsDir)) {
          const revisions = readdirSync(versionsDir).filter((name) => /^v\d+$/.test(name)).sort().reverse();
          for (const revision of revisions) {
            const candidate = join(versionsDir, revision, "image.png");
            if (existsSync(candidate)) {
              sourceFile = candidate;
              sourceRevision = revision;
              break;
            }
          }
        }
        if (!sourceFile) {
          const baseline = adapter.sourceImages?.()[slide.id];
          if (baseline?.ext === ".png") {
            sourceFile = baseline.path;
            sourceRevision = "source";
          }
        }
        if (!sourceFile) {
          skipped.push(`${label}：还没有出图（没有 PNG 版本可盖）`);
          continue;
        }
        let pageBuffer;
        try {
          pageBuffer = readPngFile(sourceFile);
        } catch (error) {
          skipped.push(`${label}：${error.message}`);
          continue;
        }
        let output;
        try {
          output = watermarkPng({ pageBuffer, logoBuffer, position, opacity, scale, margin: 0.04 });
        } catch (error) {
          skipped.push(`${label}：合成失败（${error.message}）`);
          continue;
        }
        if (dryRun) {
          applied.push({ pageId: slide.id, revision: "(dryRun)", size: output.size, placement: output.placement });
          continue;
        }
        const revision = nextRevision(slideDir);
        const outDir = join(slideDir, "versions", revision);
        mkdirSync(outDir, { recursive: true });
        writeFileSync(join(outDir, "image.png"), output.buffer);
        // 同一页的 prompt / content / QA 跟着复制：水印只是新一版，不是另一页
        if (sourceRevision && sourceRevision !== "source") {
          const sourceDir = join(versionsDir, sourceRevision);
          for (const name of ["prompt.txt", "content.json"]) {
            const from = join(sourceDir, name);
            if (existsSync(from)) copyFileSync(from, join(outDir, name));
          }
          const qaFile = join(sourceDir, "qa.json");
          if (existsSync(qaFile)) {
            try {
              const qa = JSON.parse(readFileSync(qaFile, "utf8"));
              qa.checks = [...(qa.checks ?? []), { name: "watermark", ok: true, detail: `${asset.id} · ${WATERMARK_POSITION_LABELS[position]}` }];
              qa.watermark = { asset: asset.id, position, opacity, scale, appliedAt: new Date().toISOString(), sourceRevision };
              writeFileSync(join(outDir, "qa.json"), `${JSON.stringify(qa, null, 2)}\n`, "utf8");
            } catch {
              writeFileSync(join(outDir, "watermark.json"), `${JSON.stringify({ asset: asset.id, position, opacity, scale, sourceRevision, appliedAt: new Date().toISOString() }, null, 2)}\n`, "utf8");
            }
          } else {
            writeFileSync(join(outDir, "watermark.json"), `${JSON.stringify({ asset: asset.id, position, opacity, scale, sourceRevision, appliedAt: new Date().toISOString() }, null, 2)}\n`, "utf8");
          }
        } else {
          writeFileSync(join(outDir, "watermark.json"), `${JSON.stringify({ asset: asset.id, position, opacity, scale, sourceRevision: "source", appliedAt: new Date().toISOString() }, null, 2)}\n`, "utf8");
        }
        store.recordEvent({
          type: "deck.watermark.applied",
          deckId,
          slideIds: [slide.id],
          actor: "agent",
          status: "succeeded",
          payload: { asset: asset.id, position, opacity, scale, revision, sourceRevision, size: output.size },
        });
        applied.push({ pageId: slide.id, revision, size: output.size, placement: output.placement });
      }

      const lines = [
        dryRun
          ? `体检：${applied.length} 页可以盖「${asset.id}」（${WATERMARK_POSITION_LABELS[position]} · 透明度 ${opacity} · 宽 ${Math.round(scale * 100)}%）`
          : `已给 ${applied.length} 页盖水印：${asset.id}（${WATERMARK_POSITION_LABELS[position]} · 透明度 ${opacity} · 宽 ${Math.round(scale * 100)}%）`,
        ...applied.map((item) => `  • ${item.pageId} → ${item.revision}（${item.size}）`),
        ...(skipped.length ? [`跳过 ${skipped.length} 页：`, ...skipped.map((line) => `  • ${line}`)] : []),
        dryRun ? "确认后去掉 dryRun 再调一次就会落盘。" : "原图保留：每页多出一版 revision，可在工作台翻看；要换位置 / 换 logo 再调一次即可（会再生成一版，不覆盖）。",
      ];
      return {
        deckId,
        asset: { id: asset.id, path: asset.path, bytes: asset.bytes },
        position,
        opacity,
        scale,
        applied,
        skipped,
        slideIds: applied.map((item) => item.pageId),
        text: lines.join("\n"),
      };
    }),
  });

  return tools;
}
