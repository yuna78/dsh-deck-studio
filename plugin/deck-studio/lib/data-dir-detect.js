/**
 * 数据目录不匹配检测（P0）：当前 dataRoot 里到底有没有这本 deck 的正文。
 *
 * 判定口径（规格 §2 + lead 认的例外）：
 * - `ok`：`decks/<id>/script/current.md` 在；
 * - `partial`：有出图（slides 里有 image.*）但 script 没了 → revision 丢失，文案与 mismatch 区分；
 * - `mismatch`：`decks/<id>/` 在（有 deck.json 等残留）但正文没了，或别处真的有这本 deck 的 script；
 * - `absent`：当前 dataRoot 里完全没有痕迹。**分两种口径**：
 *     - 本机新建 deck（源在 projectsRoot 下）：静默，不记事件、不出黄条（首次打开本来就该初始化）；
 *     - 注册的外部受控源 deck：给 info 级弱提示（不拦渲染）——
 *       「这本 deck 是外部源，当前数据目录还没有它的工作副本，首次打开会初始化」。
 *
 * 扫盘只在「疑似不对」时做（正常用户每次进 deck 只付两次 stat）。
 * @module dsh-plugin-deck-studio/data-dir-detect
 */

import { existsSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { defaultDataRoot } from "./config.js";
import { DECK_DATA_STATUS_LABELS, normalizeDirPath } from "./data-dir.js";

/** 只允许这个形状的 id 参与拼路径（与 deck-workspace 同一条纪律）。 */
const SAFE_ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/;
/** 出图文件名：slides/<pageId>/versions/vNNN/image.<ext>。 */
const IMAGE_FILE = /^image\.(png|webp|jpe?g|svg)$/i;
/** 外部源 absent 的弱提示（info 级，不拦渲染）。 */
export const EXTERNAL_ABSENT_NOTICE = "这本 deck 是外部源，当前数据目录还没有它的工作副本，首次打开会初始化。";

function safeReaddir(path) {
  try {
    return readdirSync(path, { withFileTypes: true });
  } catch {
    return [];
  }
}

function isDirectory(path) {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * 数一本 deck 已出图的张数（`slides/<pageId>/versions/vNNN/image.<ext>`）。
 * 只在需要时调（检测、自检面板），不做全量预热。
 * @param {string} deckDir - `<dataRoot>/decks/<deckId>`
 */
export function countDeckImages(deckDir, { cap = 2000 } = {}) {
  const slidesDir = join(deckDir, "slides");
  if (!existsSync(slidesDir)) return 0;
  let count = 0;
  for (const pageEntry of safeReaddir(slidesDir)) {
    if (!pageEntry.isDirectory()) continue;
    const versionsDir = join(slidesDir, pageEntry.name, "versions");
    if (!existsSync(versionsDir)) continue;
    for (const versionEntry of safeReaddir(versionsDir)) {
      if (!versionEntry.isDirectory() || !/^v\d+$/.test(versionEntry.name)) continue;
      for (const fileEntry of safeReaddir(join(versionsDir, versionEntry.name))) {
        if (!fileEntry.isFile() || !IMAGE_FILE.test(fileEntry.name)) continue;
        count += 1;
        if (count >= cap) return count;
      }
    }
  }
  return count;
}

/**
 * 一本 deck 在当前 dataRoot 里的数据状态。
 * @param {string} dataRoot
 * @param {string} deckId
 * @param {{countImages?: boolean}} [options] - 自检面板要「已出图页数」时传 true（健康 deck 也数）。
 */
export function deckDataHealth(dataRoot, deckId, { countImages = false } = {}) {
  const id = String(deckId ?? "").trim();
  const safe = SAFE_ID.test(id);
  const deckDir = safe ? join(dataRoot, "decks", id) : "";
  const result = {
    deckId: id,
    dataRoot,
    deckDir,
    deckDirExists: false,
    hasManifest: false,
    hasScript: false,
    imageCount: 0,
    scriptFile: safe ? join(deckDir, "script", "current.md") : "",
    status: "absent",
  };
  if (!safe || !existsSync(deckDir) || !isDirectory(deckDir)) return result;
  const hasManifest = existsSync(join(deckDir, "deck.json"));
  const hasScript = existsSync(join(deckDir, "script", "current.md"));
  // 没 script 时必须数图：有图 = partial（revision 丢了），没图 = mismatch（只剩残留）。
  const imageCount = countImages || !hasScript ? countDeckImages(deckDir) : 0;
  const status = hasScript ? "ok" : imageCount > 0 ? "partial" : "mismatch";
  return { ...result, deckDirExists: true, hasManifest, hasScript, imageCount, status };
}

/**
 * 一个候选数据目录里跟某本 deck 有关的事实（黄条「已发现：…（N 本 deck · M 张图）」）。
 */
export function scanDataDirCandidate(dataRoot, deckId) {
  const root = normalizeDirPath(dataRoot);
  const id = String(deckId ?? "").trim();
  const result = { dataRoot: root, deckFound: false, scriptFound: false, deckCount: 0, imageCount: 0, readable: false, score: 0 };
  if (!root || !SAFE_ID.test(id) || !existsSync(root) || !isDirectory(root)) return result;
  result.readable = true;
  const decksDir = join(root, "decks");
  for (const entry of safeReaddir(decksDir)) {
    if (!entry.isDirectory() || !SAFE_ID.test(entry.name)) continue;
    const deckDir = join(decksDir, entry.name);
    const hasScript = existsSync(join(deckDir, "script", "current.md"));
    if (!hasScript && !existsSync(join(deckDir, "deck.json"))) continue;
    result.deckCount += 1;
    result.imageCount += countDeckImages(deckDir);
    if (entry.name === id) {
      result.deckFound = true;
      result.scriptFound = hasScript;
    }
  }
  result.score = result.deckCount + result.imageCount;
  return result;
}

/** 磁盘上有内容的 deck id（有 deck.json 或 script/current.md），升序。 */
export function listDataRootDeckIds(dataRoot) {
  const decksDir = join(dataRoot, "decks");
  const ids = [];
  for (const entry of safeReaddir(decksDir)) {
    if (!entry.isDirectory() || !SAFE_ID.test(entry.name)) continue;
    const deckDir = join(decksDir, entry.name);
    if (existsSync(join(deckDir, "deck.json")) || existsSync(join(deckDir, "script", "current.md"))) ids.push(entry.name);
  }
  return ids.sort();
}

/**
 * 可用候选目录（内部口径，candidateDataRoots 与 scanDataDirCandidates 共用，别再各写一遍）。
 * 规格 §2「对每个候选检查 <candidate>/decks/<deckId>/script/current.md 是否存在，命中才记为可用候选」：
 * 目录必须真的存在；给了 deckId 时还必须有这本 deck 的正文。当前 dataRoot 自己不算候选。
 */
function usableCandidateRoots({ env, cwd, profileDataRoots, currentDataRoot, deckId }) {
  const current = normalizeDirPath(currentDataRoot, env);
  const raw = [
    cwd ? join(cwd, ".deck") : "",
    defaultDataRoot(env),
    env.DSH_DECK_DATA_ROOT ?? "",
    ...(Array.isArray(profileDataRoots) ? profileDataRoots : [profileDataRoots]),
  ];
  const seen = new Set();
  const out = [];
  for (const value of raw) {
    const path = normalizeDirPath(value, env);
    if (!path || path[0] !== "/") continue;
    const key = resolve(path);
    if (seen.has(key) || (current && key === resolve(current))) continue;
    // 不存在 / 没有这本 deck 正文的目录不是「可用候选」（列出来只会让人点一个空目录）。
    if (!existsSync(path)) continue;
    if (deckId && !existsSync(join(path, "decks", deckId, "script", "current.md"))) continue;
    seen.add(key);
    out.push(path);
  }
  return out;
}

/**
 * 候选数据目录（规格顺序）：`<cwd>/.deck` → `$DSH_HOME/deckline` → `$DSH_DECK_DATA_ROOT` → profile 里出现过的 dataRoot。
 * 去重、排除当前 dataRoot（它自己不算「候选」），并只留**可用**的（见 usableCandidateRoots）。
 * 不传 deckId 时按「目录存在」筛（诊断 / 列表用）。
 */
export function candidateDataRoots({ env = process.env, cwd = process.cwd(), profileDataRoots = [], currentDataRoot = "", deckId = "" } = {}) {
  return usableCandidateRoots({ env, cwd, profileDataRoots, currentDataRoot, deckId });
}

/**
 * 扫候选目录，只返回**真的存着这本 deck 的 script** 的目录（规格：「命中就记为可用候选」）。
 * 排序：deck 数多的优先，其次图多的；最多 `limit` 个（界面只列前 3）。
 */
export function scanDataDirCandidates({ deckId, env = process.env, cwd = process.cwd(), profileDataRoots = [], currentDataRoot = "", limit = 3 } = {}) {
  const roots = candidateDataRoots({ env, cwd, profileDataRoots, currentDataRoot, deckId });
  const hits = roots
    .map((root, order) => ({ ...scanDataDirCandidate(root, deckId), order }))
    .filter((entry) => entry.scriptFound);
  hits.sort((a, b) => (b.deckCount - a.deckCount) || (b.imageCount - a.imageCount) || (a.order - b.order));
  return hits.slice(0, Math.max(1, limit)).map(({ order, ...entry }) => entry);
}

/**
 * 整体体检：注册的 deck 在当前 dataRoot 里是不是都有正文；没有的扫候选目录找证据。
 */
export function assessDataDir({
  dataRoot,
  decks = [],
  env = process.env,
  cwd = process.cwd(),
  profileDataRoots = [],
  withCandidates = true,
  candidateLimit = 3,
  countImages = false,
} = {}) {
  const root = normalizeDirPath(dataRoot);
  const entries = (Array.isArray(decks) ? decks : [])
    .map((deck) => (typeof deck === "string" ? { id: deck } : deck))
    .filter((deck) => deck && SAFE_ID.test(String(deck.id ?? "")));
  const assessed = [];
  for (const deck of entries) {
    const health = deckDataHealth(root, deck.id, { countImages });
    let status = health.status;
    let candidates = [];
    if (status !== "ok" && withCandidates) {
      candidates = scanDataDirCandidates({
        deckId: deck.id,
        env,
        cwd,
        profileDataRoots,
        currentDataRoot: root,
        limit: candidateLimit,
      });
      // absent → mismatch 只在**别处真有这本 deck 的 script** 时升级（否则新 deck 首次打开就误报）。
      if (status === "absent" && candidates.length) status = "mismatch";
    }
    const sourceRoot = typeof deck.sourceRoot === "string" ? deck.sourceRoot : "";
    const sourceAvailable = typeof deck.sourceAvailable === "boolean" ? deck.sourceAvailable : null;
    const local = typeof deck.local === "boolean" ? deck.local : false;
    assessed.push({
      deckId: String(deck.id),
      label: typeof deck.label === "string" && deck.label ? deck.label : String(deck.id),
      title: typeof deck.title === "string" && deck.title ? deck.title : "",
      pageCount: Number.isFinite(Number(deck.pageCount)) ? Number(deck.pageCount) : 0,
      renderedPages: countImages ? health.imageCount : null,
      sourceRoot,
      sourceAvailable,
      registrationValid: sourceAvailable === true || Boolean(sourceRoot && existsSync(sourceRoot)),
      ...health,
      status,
      statusLabel: DECK_DATA_STATUS_LABELS[status] ?? status,
      origin: local ? "local" : "external",
      // 弱提示：只有「外部源 + 完全没痕迹」才给，info 级、不拦渲染、不记事件。
      notice: status === "absent" && !local ? { level: "info", message: EXTERNAL_ABSENT_NOTICE } : null,
      candidates,
      // 黄条口径（规格 §2 收口，lead 定的）：注册 deck 在当前 root 没有正文 → **一定**出黄条，
      // status 是 mismatch（别处找到 script）还是 absent（别处也没找到）只是文案变体。
      // 唯一静默：本机新建 deck（local）且当前 root 完全没痕迹 —— 首次打开本来就是正常初始化。
      needsBanner: status === "mismatch" || status === "partial" || (status === "absent" && !local),
    });
  }
  const broken = assessed.filter((deck) => deck.status === "mismatch" || deck.status === "partial");
  // 黄条范围比「数据坏」宽：外部源 absent 也要出条，所以收候选按 needsBanner 收。
  const bannerDecks = assessed.filter((deck) => deck.needsBanner);
  const merged = new Map();
  for (const deck of bannerDecks) {
    for (const candidate of deck.candidates) {
      const key = resolve(candidate.dataRoot);
      if (!merged.has(key)) merged.set(key, { ...candidate });
    }
  }
  const candidates = [...merged.values()]
    .sort((a, b) => (b.deckCount - a.deckCount) || (b.imageCount - a.imageCount))
    .slice(0, Math.max(1, candidateLimit));
  return {
    dataRoot: root,
    checkedAt: new Date().toISOString(),
    decks: assessed,
    mismatchDeckIds: broken.map((deck) => deck.deckId),
    bannerDeckIds: bannerDecks.map((deck) => deck.deckId),
    candidates,
    healthy: broken.length === 0,
  };
}

/**
 * 黄条 / 诊断要的事实（文案由前端按 UI 口径渲染，这里只给事实）。
 */
export function dataDirBannerFacts({ report, deckId = null, envOverride = false, dataRoot = "" } = {}) {
  const decks = report?.decks ?? [];
  // 黄条口径（规格 §2）：注册 deck 在当前 root 没有正文 → 出黄条；absent 只是文案变体，零候选时仍出黄条
  // （带手填输入框），只有本机新建 deck 的首次打开静默。判据统一用 needsBanner，别在这里再写一遍状态机。
  const bannerDecks = decks.filter((deck) => deck.needsBanner);
  const active = deckId ? decks.find((deck) => deck.deckId === deckId) ?? null : null;
  const activeNeedsBanner = Boolean(active && active.needsBanner);
  if (!activeNeedsBanner && !bannerDecks.length) {
    return { show: false, kind: "", deckId: null, deckLabel: "", scope: "deck", candidates: [], affectedDecks: 0, imageCount: 0, manualInput: false, envOverride: Boolean(envOverride), dataRoot };
  }
  const subject = activeNeedsBanner ? active : bannerDecks[0];
  const candidates = (activeNeedsBanner ? subject.candidates : report?.candidates) ?? [];
  return {
    show: true,
    kind: subject.status,
    deckId: subject.deckId,
    deckLabel: subject.label,
    scope: activeNeedsBanner ? "deck" : "home",
    candidates,
    // 零候选 = 连「切到这个目录」都没得点：前端要出手填绝对路径输入框（+ 目录选择器）。
    manualInput: candidates.length === 0,
    affectedDecks: bannerDecks.length,
    imageCount: activeNeedsBanner ? subject.imageCount : bannerDecks.reduce((sum, deck) => sum + (deck.imageCount ?? 0), 0),
    envOverride: Boolean(envOverride),
    dataRoot: dataRoot || report?.dataRoot || "",
  };
}

/**
 * 自检面板整表（一处拼装，前端不重算口径）。
 */
export function buildSelfCheckPayload({ resolved = {}, workspacePath = null, report = null, diskDeckIds = [], render = {}, versions = {} } = {}) {
  const decks = report?.decks ?? [];
  const registeredIds = decks.map((deck) => deck.deckId);
  const onDisk = (Array.isArray(diskDeckIds) ? diskDeckIds : []).filter((id) => SAFE_ID.test(String(id ?? "")));
  const payload = {
    checkedAt: new Date().toISOString(),
    processCwd: resolved.processCwd ?? process.cwd(),
    dataRoot: resolved.dataRoot ?? null,
    projectsRoot: resolved.projectsRoot ?? null,
    workspacePath: workspacePath ?? null,
    dshHome: resolved.dshHome ?? null,
    pointerFile: resolved.pointerFile ?? { path: "", exists: false, error: null },
    envOverride: resolved.envOverride ?? { active: false, name: "DSH_DECK_DATA_ROOT" },
    firstRun: resolved.firstRun === true,
    versions: {
      plugin: versions.plugin ?? "",
      dsh: versions.dsh ?? "",
      node: versions.node ?? process.version,
    },
    render: { mode: render.mode ?? "", nodeName: render.nodeName ?? "", model: render.model ?? "" },
    decks: {
      registeredCount: registeredIds.length,
      onDiskCount: onDisk.length,
      onlyRegistered: registeredIds.filter((id) => !onDisk.includes(id)),
      onlyOnDisk: onDisk.filter((id) => !registeredIds.includes(id)),
      items: decks.map((deck) => ({
        deckId: deck.deckId,
        label: deck.label,
        title: deck.title || deck.label,
        pageCount: deck.pageCount ?? 0,
        renderedPages: deck.renderedPages ?? (deck.hasScript ? 0 : deck.imageCount),
        hasScript: deck.hasScript === true,
        status: deck.status,
        statusLabel: deck.statusLabel ?? DECK_DATA_STATUS_LABELS[deck.status] ?? deck.status,
        origin: deck.origin ?? "external",
        notice: deck.notice ?? null,
        sourceRoot: deck.sourceRoot ?? "",
        sourceAvailable: deck.sourceAvailable ?? null,
        candidates: deck.candidates ?? [],
      })),
    },
  };
  return { ...payload, diagnosticsText: diagnosticsTextOf(payload) };
}

/**
 * 脱敏、可粘贴的诊断文本（「复制诊断信息」只复制这一段，避免前后端两套脱敏口径）。
 * 只含路径 / 版本 / 计数，不含 key、token。
 */
export function diagnosticsTextOf(payload = {}) {
  const fact = (root) => (root ? `${root.value || "(空)"}〔来源：${root.source}${root.envOverridden ? " · 环境变量覆盖（只读）" : ""}〕` : "(未知)");
  const lines = [];
  lines.push(`Deckline 自检 · ${payload.checkedAt ?? new Date().toISOString()}`);
  lines.push(`进程 cwd：${payload.processCwd ?? process.cwd()}`);
  lines.push(`数据目录 dataRoot：${fact(payload.dataRoot)}`);
  lines.push(`新建 deck 源根 projectsRoot：${fact(payload.projectsRoot)}`);
  lines.push(`会话工作区 workspacePath：${fact(payload.workspacePath)}`);
  lines.push(`DSH_HOME：${fact(payload.dshHome)}`);
  const pointer = payload.pointerFile ?? {};
  lines.push(`指针文件：${pointer.path || "(未知)"}（${pointer.exists ? "存在" : "不存在"}${pointer.error ? ` · ${pointer.error}` : ""}）`);
  lines.push(`环境变量覆盖：${payload.envOverride?.active ? `${payload.envOverride.name}（只读）` : "无"}`);
  const render = payload.render ?? {};
  lines.push(`出图：${render.mode || "—"} · ${render.nodeName || "默认节点"} · ${render.model || "—"}`);
  const versions = payload.versions ?? {};
  lines.push(`版本：插件 ${versions.plugin || "—"} · DSH ${versions.dsh || "—"} · Node ${versions.node || process.version}`);
  const decks = payload.decks ?? {};
  lines.push(`注册 deck ${decks.registeredCount ?? 0} 本 / 磁盘 ${decks.onDiskCount ?? 0} 本；仅注册：${(decks.onlyRegistered ?? []).join(", ") || "无"}；仅磁盘：${(decks.onlyOnDisk ?? []).join(", ") || "无"}`);
  for (const deck of decks.items ?? []) {
    const parts = [`[${deck.status}]`, deck.deckId, `${deck.pageCount ?? 0} 页`, `已出图 ${deck.renderedPages ?? 0} 页`, deck.hasScript ? "script 在" : "script 缺失"];
    if ((deck.candidates ?? []).length) {
      parts.push(`候选：${deck.candidates.map((candidate) => `${candidate.dataRoot}（${candidate.deckCount} 本 deck · ${candidate.imageCount} 张图）`).join(" / ")}`);
    }
    lines.push(`- ${parts.join(" · ")}`);
  }
  return lines.join("\n");
}
