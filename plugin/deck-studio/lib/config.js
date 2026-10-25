/**
 * 插件配置解析与路径解析。纯函数、无 IO——冒烟测试可直接喂假 env。
 *
 * 两个挂载点共用本文件（ADR-0006 D2）：
 * - profile 根挂载：`tools: false`，只开观测路由 + 客户端面板；
 * - preset 子树挂载：`tools: true` + `decks[]`（受控源路径等）。
 *
 * 源路径纪律（ADR-0006 D5）：客户源目录只从 config / env 来，绝不写死在工具逻辑里。
 * @module dsh-plugin-deck-studio/config
 */

import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { DEFAULT_MAX_REVIEWERS, HARD_MAX_REVIEWERS } from "./review-personas.js";
import { fileURLToPath } from "node:url";

/** 插件包根目录（lib/ 的上一级——本文件住在 lib/ 里）。 */
export const PLUGIN_DIR = dirname(dirname(fileURLToPath(import.meta.url)));

/**
 * 资产根：源码树根 `<repo>/plugin/deck-studio/` 的上一级。
 *
 * npm 安装时插件在 `<profile>/node_modules/dsh-plugin-deck-studio`，上两级是 node_modules，
 * 那里没有 samples / docs；公开包把手册与示例 deck 一起打进包内 `seeds/`（prepack 生成），
 * 这种情况回退到 `seeds/`，否则「使用手册」和首次启动的示例 deck 在 npm 安装下是空的。
 */
export function repoRootFrom(pluginDir = PLUGIN_DIR) {
  const repo = resolve(pluginDir, "..", "..");
  const looksLikeRepo = existsSync(join(repo, "samples", "deckline-intro", "script.md")) || existsSync(join(repo, "docs", "manual.md"));
  if (looksLikeRepo) return repo;
  const bundled = join(pluginDir, "seeds");
  if (existsSync(join(bundled, "docs", "manual.md"))) return bundled;
  return repo;
}

/**
 * 默认渲染配置。
 * 出图节点地址**不设默认值**：provider 中立，节点只来自 profile patch / env / 本机 key 文件，
 * 仓库里不携带任何厂商或个人中转地址（real 模式缺 endpoint 时 `lib/render.js` 会明确报错）。
 * API key 永不出现在配置或仓库里，只从 env / key 文件读。
 */
export const DEFAULT_RENDER = {
  mode: "fake",
  model: "gpt-image-2.5-sunburst",
  endpoint: "",
  size: "2560x1440",
  apiKeyEnv: "DSH_DECK_IMAGE_API_KEY",
  apiKeyFile: "",
  // F-110：2560x1440 的整页图在慢网络下会超过 3 分钟（真机 p01 出图在 180s 被 abort）。
  // 2560x1440 实测 219s 成功、慢的时候 300s 还没回来；给到 7 分钟，超时文案会提示重试。
  timeoutMs: 420_000,
  /** 多节点配置（ADR-0010）：nodes 存在时优先；没有时回退到上面的单节点字段。 */
  nodes: [],
  /** 缺省选择：nodeId/modelId；留空用 nodes[0].models[0]。 */
  default: "",
};

/** 默认视觉 preset（写进每页 prompt 头部；可在 profile 里用 styleBrief 覆盖）。 */
export const DEFAULT_STYLE_BRIEF =
  "品牌信息图风格：深青 #06363B 主色、米白纸张底、暖金点缀，纸张纹理背景；" +
  "信息密度高、克制、知识型；版式干净、层级清楚；不要卡通、不要 3D 渲染、不要照片素材。";

/** 展示名（status / 面板横幅用）。 */
export const DEFAULT_DISPLAY_NAME = "Deckline";

/**
 * 展开一个 deck 源条目：config 里的 path 支持 `~`；缺 id 拒绝。
 * @param {unknown} raw - config.decks[] 的一项。
 * @param {NodeJS.ProcessEnv} env - 展开 `~` 与 env 覆盖用。
 */
function normalizeDeck(raw, env) {
  if (!raw || typeof raw !== "object") return null;
  const sourceRoot = typeof raw.sourceRoot === "string" ? expandHome(raw.sourceRoot, env) : "";
  if (!sourceRoot) return null;
  const id = typeof raw.id === "string" && raw.id.trim() ? raw.id.trim() : "";
  if (!id || !/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(id)) return null;
  return {
    id,
    label: typeof raw.label === "string" && raw.label.trim() ? raw.label.trim() : id,
    sourceRoot,
  };
}

/** 展开 `~/` 前缀；其余原样。 */
/** 默认数据根：安装用户的可写位置（不落进插件包 / node_modules）。源码调试时可在 profile 里显式配 dataRoot。 */
export function defaultDataRoot(env = process.env) {
  return join(expandHome(env.DSH_HOME || "~/.dsh", env), "deckline");
}

export function expandHome(value, env = process.env) {
  if (typeof value !== "string") return "";
  if (value === "~") return env.HOME ?? value;
  if (value.startsWith("~/")) return join(env.HOME ?? "", value.slice(2));
  return value;
}

/**
 * 合并 loader config ← 默认值 ← env 覆盖。
 * @param {Record<string, unknown>|undefined} raw - apply(ctx, config) 的 config。
 * @param {{pluginDir?: string, env?: NodeJS.ProcessEnv}} [options]
 */
export function mergeConfig(raw, options = {}) {
  const env = options.env ?? process.env;
  const pluginDir = options.pluginDir ?? PLUGIN_DIR;
  const input = raw && typeof raw === "object" ? raw : {};
  const positive = (value, fallback) =>
    Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : fallback;

  const renderInput = input.render && typeof input.render === "object" ? input.render : {};
  const mode = renderInput.mode === "real" || env.DSH_DECK_RENDER_MODE === "real" ? "real" : "fake";
  const render = {
    ...DEFAULT_RENDER,
    ...renderInput,
    mode,
    // 配置优先；env 别名与 docs/install.md 一致（DSH_DECK_IMAGE_*），保留 GPT_IMAGE_* 兼容旧用法。
    model:
      renderInput.model || env.DSH_DECK_IMAGE_MODEL || env.GPT_IMAGE_MODEL || DEFAULT_RENDER.model,
    size: renderInput.size || env.DSH_DECK_IMAGE_SIZE || env.GPT_IMAGE_SIZE || DEFAULT_RENDER.size,
    endpoint: renderInput.endpoint || env.DSH_DECK_IMAGE_ENDPOINT || DEFAULT_RENDER.endpoint,
    apiKeyFile: expandHome(
      renderInput.apiKeyFile || env.DSH_DECK_IMAGE_API_KEY_FILE || DEFAULT_RENDER.apiKeyFile,
      env,
    ),
    timeoutMs: positive(renderInput.timeoutMs, DEFAULT_RENDER.timeoutMs),
  };

  const decksRaw = Array.isArray(input.decks) ? input.decks : [];
  const decks = decksRaw.map((deck) => normalizeDeck(deck, env)).filter(Boolean);

  const singleSource = expandHome(
    typeof input.sourceRoot === "string" ? input.sourceRoot : (env.DSH_DECK_SOURCE_ROOT ?? ""),
    env,
  );
  if (singleSource && !decks.some((deck) => deck.sourceRoot === singleSource)) {
    decks.unshift({
      id: typeof input.sourceDeckId === "string" && input.sourceDeckId.trim() ? input.sourceDeckId.trim() : "sample-deck",
      label: typeof input.sourceDeckLabel === "string" && input.sourceDeckLabel.trim() ? input.sourceDeckLabel.trim() : "示例受控源",
      sourceRoot: singleSource,
    });
  }

  return {
    /** 只在 preset 子树挂载点为 true；根挂载只开路由与面板。 */
    tools: input.tools === true,
    /** preset 子树挂载点设 false（根挂载已注册同路径路由，避免双重注册）。 */
    routes: input.routes !== false,
    dataRoot:
      expandHome(
        typeof input.dataRoot === "string" && input.dataRoot
          ? input.dataRoot
          : (env.DSH_DECK_DATA_ROOT ?? ""),
        env,
      ) || defaultDataRoot(env),
    /**
     * 新建 deck 项目的落盘根（2026-10-21 负责人：以后写的 deck 都放
     * `00_company/sharing/`）。留空 = 旧的内部 `.deck/projects/<id>/source`。
     * 配置了这个根时，新项目直接建在 `<projectsRoot>/<目录名>/`
     * （script.md / intent.md / style-reference.md / prompts/ 同层，和已有 deck 源结构一致）。
     */
    projectsRoot: expandHome(
      typeof input.projectsRoot === "string" && input.projectsRoot.trim()
        ? input.projectsRoot.trim()
        : (env.DSH_DECK_PROJECTS_ROOT ?? ""),
      env,
    ),
    decks,
    render,
    styleBrief:
      typeof input.styleBrief === "string" && input.styleBrief.trim()
        ? input.styleBrief.trim()
        : DEFAULT_STYLE_BRIEF,
    displayName:
      typeof input.displayName === "string" && input.displayName.trim()
        ? input.displayName.trim()
        : DEFAULT_DISPLAY_NAME,
    /**
     * 是否把 DSH 外壳左侧栏默认收起隐藏（F-69）。
     * 默认 false：只有专门的产品 profile（如 deck-studio）显式打开才生效，
     * 开发/其他 profile 的 DSH 界面不受影响。
     */
    hideShellSidebar: input.hideShellSidebar === true,
    /**
     * 新建 Deck 弹窗默认预选的登记风格（F-112）：填 design 缩写（如 GRD）。
     * 留空 = 不预选。只在 UI 预选，不改变任何已有 deck 的关联风格。
     */
    defaultStyleAbbr:
      typeof input.defaultStyleAbbr === "string" && input.defaultStyleAbbr.trim()
        ? input.defaultStyleAbbr.trim().toUpperCase()
        : "",
    /**
     * 首次启动自举（F-157）：新装 profile 自动登记示例 deck、拷一份资源库、导入预设风格。
     * 默认 false（通用插件不强加内容）；产品 bundle patch 里打开，关掉填 false。
     */
    bootstrap: input.bootstrap === true,
    /**
     * 听众评审（F-159）：审稿人由 intent 的「听众」动态生成，不是写死的固定 role。
     * presetId 指向只读评审 preset（cordis.patch.yml 的 preset-deck-critic）；
     * maxReviewers 是成本上限（每个审稿人 = 一次子 agent 调用），默认 3。
     */
    review: {
      presetId:
        typeof input.review?.presetId === "string" && input.review.presetId.trim()
          ? input.review.presetId.trim()
          : "deck-critic",
      maxReviewers: Math.min(
        HARD_MAX_REVIEWERS,
        positive(input.review?.maxReviewers, DEFAULT_MAX_REVIEWERS),
      ),
    },
    /** 首页问候语里的用户名（默认空 = 只显示「欢迎你」；可在 profile 配置里改）。 */
    userName:
      typeof input.userName === "string" && input.userName.trim()
        ? input.userName.trim()
        : "",
  };
}
