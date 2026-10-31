/**
 * 数据目录（dataRoot / projectsRoot）解析与指针文件（P0）。
 *
 * 口径（规格 `.deck-assistant-scratch/deckline-data-dir-spec.md` §1 / §4）：
 * - 解析优先级：env `DSH_DECK_DATA_ROOT` > 指针文件 `$DSH_HOME/deckline/location.json`
 *   > profile patch `deck-studio.config.dataRoot` > 默认 `$DSH_HOME/deckline`；
 * - 每次解析都把**命中来源**（env / pointer / profile / default）带出去，设置页与黄条直接显示；
 * - 指针文件位置固定，不随 dataRoot 配置移动（否则自指）；写入 0600、不含任何 key；
 * - env 覆盖时指针只读：写了也不生效，界面必须说明「由环境变量 … 指定（只读）」。
 *
 * 本模块只做「解析 + 读写指针」，不碰 deck 内容；不匹配检测在 lib/data-dir-detect.js。
 * @module dsh-plugin-deck-studio/data-dir
 */

import { accessSync, chmodSync, constants, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { defaultDataRoot, expandHome } from "./config.js";

/** 覆盖 dataRoot 的环境变量名（优先级最高）。 */
export const DATA_DIR_ENV = "DSH_DECK_DATA_ROOT";
/** 覆盖 projectsRoot 的环境变量名。 */
export const PROJECTS_ROOT_ENV = "DSH_DECK_PROJECTS_ROOT";
/** 指针文件名（固定住在 `$DSH_HOME/deckline/`，不随 dataRoot 移动）。 */
export const LOCATION_FILE_NAME = "location.json";
/** 指针文件格式版本。 */
export const LOCATION_VERSION = 1;

/** 解析命中来源（顺序 = 优先级）。 */
export const DATA_DIR_SOURCES = ["env", "pointer", "profile", "default"];

/** 命中来源的人话标签（设置页第一行 / 诊断信息共用）。 */
export const DATA_DIR_SOURCE_LABELS = {
  env: `环境变量 ${DATA_DIR_ENV}`,
  pointer: "指针文件 location.json",
  profile: "profile patch（deck-studio.config.dataRoot）",
  default: "默认 $DSH_HOME/deckline",
};

/** 每本 deck 的数据状态标签（检测模块与 UI 共用一张词表）。 */
export const DECK_DATA_STATUS_LABELS = {
  ok: "正常",
  mismatch: "不在这",
  partial: "正文丢失",
  absent: "尚未初始化",
};

/**
 * 规范化用户输入的目录：展开 `~`、去首尾空白与尾部斜杠。
 * **不**把相对路径悄悄 resolve 成绝对路径——写指针时要求绝对路径，相对路径直接报错。
 * @param {unknown} value
 * @param {NodeJS.ProcessEnv} [env]
 */
export function normalizeDirPath(value, env = process.env) {
  const expanded = expandHome(String(value ?? "").trim(), env).trim();
  if (!expanded) return "";
  return expanded.length > 1 ? expanded.replace(/[/\\]+$/, "") : expanded;
}

/** `$DSH_HOME`（未配置时 `~/.dsh`）。 */
export function dshHomeOf(env = process.env) {
  return normalizeDirPath(env.DSH_HOME || "~/.dsh", env);
}

function isDirectory(path) {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * 目录可写？目录还不存在时看最近的已存在祖先（不替你建目录）。
 * @param {string} path
 */
export function dirWritable(path) {
  const target = String(path ?? "").trim();
  if (!target) return false;
  let dir = target;
  while (!existsSync(dir)) {
    const parent = dirname(dir);
    if (parent === dir) return false;
    dir = parent;
  }
  try {
    accessSync(dir, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * 一个目录的三个事实（自检面板 / 首次引导校验共用）。
 * @param {unknown} path
 * @param {NodeJS.ProcessEnv} [env]
 */
export function dirFacts(path, env = process.env) {
  const value = normalizeDirPath(path, env);
  return { value, exists: value ? isDirectory(value) : false, writable: dirWritable(value) };
}

/** 指针文件的固定位置：`<DSH_HOME>/deckline/location.json`。 */
export function locationFileOf(env = process.env) {
  return join(defaultDataRoot(env), LOCATION_FILE_NAME);
}

/**
 * 读指针文件。坏文件不抛：返回 `found:true, error:…`，让界面能说清「文件坏了」而不是「没有」。
 * @param {NodeJS.ProcessEnv} [env]
 */
export function readLocationPointer(env = process.env) {
  const path = locationFileOf(env);
  const base = { found: false, path, version: null, dataRoot: "", projectsRoot: "", setBy: "", updatedAt: "", error: null };
  if (!existsSync(path)) return base;
  try {
    const raw = JSON.parse(readFileSync(path, "utf8"));
    return {
      found: true,
      path,
      version: Number.isFinite(Number(raw?.version)) ? Number(raw.version) : null,
      dataRoot: normalizeDirPath(raw?.dataRoot ?? "", env),
      projectsRoot: normalizeDirPath(raw?.projectsRoot ?? "", env),
      setBy: typeof raw?.setBy === "string" ? raw.setBy.trim() : "",
      updatedAt: typeof raw?.updatedAt === "string" ? raw.updatedAt.trim() : "",
      error: null,
    };
  } catch (error) {
    return { ...base, found: true, error: `location.json 解析失败：${error?.message ?? error}` };
  }
}

/**
 * 指针文件所在目录能不能写（首次引导 / 设置页在写之前先问，避免「点了才发现不行」）。
 * @param {NodeJS.ProcessEnv} [env]
 */
export function pointerWritable(env = process.env) {
  const file = locationFileOf(env);
  let dir = dirname(file);
  const missing = [];
  while (!existsSync(dir)) {
    const parent = dirname(dir);
    if (parent === dir) break;
    missing.unshift(dir);
    dir = parent;
  }
  const writable = dirWritable(dir);
  return {
    path: file,
    dir,
    dirExists: existsSync(dirname(file)),
    writable,
    missing,
    error: writable ? null : `目录不可写：${dir}`,
  };
}

/**
 * 写指针文件（0600、不含任何 key）。
 *
 * 只改指针、不改 profile patch：这条路径不需要重启 DSH 就生效。
 * env 覆盖时**不允许**写（写了也不生效，只会让人困惑）；调用方先看 `resolveDataDir().envOverride.active`。
 *
 * @param {{dataRoot: unknown, projectsRoot?: unknown, setBy?: string}} input
 * @param {NodeJS.ProcessEnv} [env]
 * @param {Date} [now]
 */
export function writeLocationPointer(input = {}, env = process.env, now = new Date()) {
  const dataRoot = normalizeDirPath(input.dataRoot, env);
  if (!dataRoot) throw new Error("dataRoot 不能为空");
  if (!isAbsolute(dataRoot)) throw new Error(`数据目录必须是绝对路径：${dataRoot}`);
  const projectsRoot = normalizeDirPath(input.projectsRoot, env);
  if (projectsRoot && !isAbsolute(projectsRoot)) throw new Error(`projectsRoot 必须是绝对路径：${projectsRoot}`);
  const setBy = String(input.setBy ?? "settings").trim() || "settings";
  const pointer = { version: LOCATION_VERSION, dataRoot, projectsRoot, setBy, updatedAt: now.toISOString() };
  const path = locationFileOf(env);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(pointer, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  // mode 只对新建文件生效；已存在的文件显式收紧一次（失败不静默放宽，也不因此让写入失败）。
  try {
    chmodSync(path, 0o600);
  } catch {
    /* Windows / 特殊文件系统不支持 chmod */
  }
  return { path, pointer };
}

/** 删掉指针文件（切换回滚用；文件不存在不报错）。 */
export function deleteLocationPointer(env = process.env) {
  const path = locationFileOf(env);
  try {
    rmSync(path, { force: true });
  } catch {
    /* 权限不足等：把结果交给上层提示，不在这里编造「已删除」 */
  }
  return { path, removed: !existsSync(path) };
}

/**
 * 把指针文件回滚成 `snapshot`（= `readLocationPointer(env)` 的原样快照）。
 * 切换失败时不能让指针停在新目录上，否则重启后直接进错目录。
 */
export function restoreLocationPointer(snapshot, env = process.env) {
  if (snapshot?.found) {
    return writeLocationPointer({ dataRoot: snapshot.dataRoot, projectsRoot: snapshot.projectsRoot ?? "", setBy: snapshot.setBy ?? "rollback" }, env);
  }
  return deleteLocationPointer(env);
}

/** 统一的「根对象」形状：`{value, source, envOverridden, writable, exists}`。 */
function rootFact(value, source, env) {
  const facts = dirFacts(value, env);
  return { value: facts.value, source, envOverridden: source === "env", writable: facts.writable, exists: facts.exists };
}

/** `<dataRoot>/decks` 是否为空（不存在也算空）。 */
function decksDirEmpty(dataRoot) {
  const dir = join(dataRoot, "decks");
  if (!existsSync(dir)) return true;
  try {
    return readdirSync(dir).length === 0;
  } catch {
    return true;
  }
}

/**
 * 解析 dataRoot / projectsRoot 与命中来源（唯一入口，纯读取）。
 *
 * @param {{env?: NodeJS.ProcessEnv, profileDataRoot?: string, profileProjectsRoot?: string, logger?: {warn?: Function}}} [input]
 */
/** 冲突 warn 只打一次：5s 轮询与多次重建服务都不重复刷屏。 */
let warnedDataRootConflict = false;
let warnedProjectsRootConflict = false;

export function resolveDataDir({ env = process.env, profileDataRoot = "", profileProjectsRoot = "", logger = null } = {}) {
  const envDataRoot = normalizeDirPath(env[DATA_DIR_ENV] ?? "", env);
  const envProjectsRoot = normalizeDirPath(env[PROJECTS_ROOT_ENV] ?? "", env);
  const profileRoot = normalizeDirPath(profileDataRoot, env);
  const profileProjects = normalizeDirPath(profileProjectsRoot, env);
  const warn = typeof logger?.warn === "function" ? logger.warn.bind(logger) : null;
  // env 赢 profile 是规格要求，但会让「两处都配过」的老用户静默换目录：留一条 warn 痕迹，只打一次。
  if (warn && envDataRoot && profileRoot && envDataRoot !== profileRoot && !warnedDataRootConflict) {
    warnedDataRootConflict = true;
    warn(`dataRoot 同时由环境变量与 profile 配置指定，已按 env 生效（env=${envDataRoot}，profile=${profileRoot}）`);
  }
  if (warn && envProjectsRoot && profileProjects && envProjectsRoot !== profileProjects && !warnedProjectsRootConflict) {
    warnedProjectsRootConflict = true;
    warn(`projectsRoot 同时由环境变量与 profile 配置指定，已按 env 生效（env=${envProjectsRoot}，profile=${profileProjects}）`);
  }
  const pointer = readLocationPointer(env);
  // 坏指针 / 指向相对路径的指针不当依据：否则数据根会被悄悄换成空值。
  const pointerDataRoot = pointer.error || !isAbsolute(pointer.dataRoot) ? "" : pointer.dataRoot;
  const pointerProjectsRoot = pointer.error || !isAbsolute(pointer.projectsRoot) ? "" : pointer.projectsRoot;

  const dataRoot = envDataRoot || pointerDataRoot || profileRoot || normalizeDirPath(defaultDataRoot(env), env);
  const source = envDataRoot ? "env" : pointerDataRoot ? "pointer" : profileRoot ? "profile" : "default";
  const projectsSource = envProjectsRoot ? "env" : pointerProjectsRoot ? "pointer" : profileProjects ? "profile" : "default";
  const projectsRootValue = envProjectsRoot || pointerProjectsRoot || profileProjects;

  const dataRootFact = rootFact(dataRoot, source, env);
  const projectsRootFact = projectsRootValue
    ? rootFact(projectsRootValue, projectsSource, env)
    // 空串 = 沿用旧口径 `<dataRoot>/projects/<deckId>/source`：可写性跟 dataRoot 走，不伪造一个不存在的目录。
    : { value: "", source: "default", envOverridden: false, writable: dataRootFact.writable, exists: dataRootFact.exists };

  return {
    dataRoot: dataRootFact,
    projectsRoot: { ...projectsRootFact, effective: projectsRootValue || join(dataRootFact.value, "projects") },
    dshHome: rootFact(dshHomeOf(env), env.DSH_HOME ? "env" : "default", env),
    pointerFile: {
      path: pointer.path,
      exists: pointer.found,
      error: pointer.error,
      setBy: pointer.setBy,
      updatedAt: pointer.updatedAt,
      version: pointer.version,
    },
    envOverride: { active: source === "env", name: DATA_DIR_ENV },
    // 真·首次：这个数据目录里还没有任何 deck、没存过出图设置、也没有指针文件（规格 §3 触发条件）。
    firstRun: decksDirEmpty(dataRootFact.value) && !existsSync(join(dataRootFact.value, "render-settings.json")) && !pointer.found,
    processCwd: process.cwd(),
    sourceLabel: DATA_DIR_SOURCE_LABELS[source] ?? source,
    profileDataRoot: profileRoot,
    profileProjectsRoot: profileProjects,
    defaults: { dataRoot: normalizeDirPath(defaultDataRoot(env), env) },
  };
}
