/**
 * 插件自更新：版本比较 + 安装方式判断 + 更新命令（F-188）。
 *
 * 背景：插件装好之后没有「检查更新 / 一键更新」入口，用户只能自己去终端 `dsh plugin add`。
 * 工作台顶栏给一个刷新按钮（有新版时带小圆点），点了能看版本差异并直接更新；旁边是仓库入口（提 issue）。
 *
 * 纪律：
 * - **只在 npm 安装模式下执行更新**；本机 `link:` / `file:` 开发安装一律拒绝执行，只解释原因
 *   （开发树里跑 pnpm add 会把本地 link 换成 registry 版本，把人正在改的代码顶掉）。
 * - 更新只改 profile 里的依赖，**不改运行中的进程**：跑完提示重启 DSH 才生效。
 * - 版本比较按 semver 的「主.次.补 + 预发」做，不引第三方依赖。
 *
 * @module dsh-plugin-deck-studio/update-check
 */


const clamp = (value) => String(value ?? "").trim();

/** 解析 "1.2.3-rc.4" → { main:[1,2,3], pre:["rc","4"] }；非法返回 null。 */
export function parseVersion(raw) {
  const text = clamp(raw).replace(/^v/i, "");
  const match = text.match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/);
  if (!match) return null;
  return {
    main: [Number(match[1]), Number(match[2]), Number(match[3])],
    pre: match[4] ? match[4].split(".") : [],
  };
}

/** semver 优先级比较：a>b 返回 1，a<b 返回 -1，相等 0（含预发版规则）。非法版本抛错。 */
export function compareVersions(a, b) {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (!left) throw new Error(`版本号不合法：${a}`);
  if (!right) throw new Error(`版本号不合法：${b}`);
  for (let i = 0; i < 3; i += 1) {
    if (left.main[i] !== right.main[i]) return left.main[i] > right.main[i] ? 1 : -1;
  }
  // 有预发标记的版本低于同号正式版（0.3.0-rc.1 < 0.3.0）
  if (!left.pre.length && !right.pre.length) return 0;
  if (!left.pre.length) return 1;
  if (!right.pre.length) return -1;
  const size = Math.max(left.pre.length, right.pre.length);
  for (let i = 0; i < size; i += 1) {
    const x = left.pre[i];
    const y = right.pre[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (x === y) continue;
    const xn = /^\d+$/.test(x);
    const yn = /^\d+$/.test(y);
    if (xn && yn) return Number(x) > Number(y) ? 1 : -1;
    if (xn) return -1; // 数字标识符优先级低于字母
    if (yn) return 1;
    return x > y ? 1 : -1;
  }
  return 0;
}

/** latest 比 current 新才返回 true；任一版本号非法时返回 false（宁可不动）。 */
export function isNewer(latest, current) {
  try {
    return compareVersions(latest, current) > 0;
  } catch {
    return false;
  }
}

/** 从 registry 的 packument / version 文档里取 latest 版本（兼容 dist-tags 与单版本文档）。 */
export function latestFromRegistry(payload) {
  if (!payload || typeof payload !== "object") return "";
  const tagged = clamp(payload["dist-tags"]?.latest);
  if (tagged && parseVersion(tagged)) return tagged; // 坏 tag（"abc"）不许当版本
  const single = clamp(payload.version);
  return parseVersion(single) ? single : "";
}

/**
 * 判断插件是怎么装进 profile 的：
 * - `linked`：`link:` / `file:` / `portal:` 等本地路径 —— 开发模式，更新走 git，不执行 pnpm
 * - `npm`：semver 版本（或 `^` / `~` / `latest` 等 tag）—— 可以 `pnpm add <pkg>@latest`
 * - `unknown`：找不到 profile 或依赖缺失
 */
export function installModeOf({ profileDir = "", packageName = "" } = {}) {
  if (!profileDir || !packageName) return { mode: "unknown", spec: "", reason: "拿不到 profile 目录或包名" };
  let pkg;
  try {
    pkg = JSON.parse(readFileSync(join(profileDir, "package.json"), "utf8"));
  } catch {
    return { mode: "unknown", spec: "", reason: `读不到 ${join(profileDir, "package.json")}` };
  }
  const spec = clamp(pkg?.dependencies?.[packageName]);
  if (!spec) return { mode: "unknown", spec: "", reason: `profile 的 dependencies 里没有 ${packageName}` };
  if (/^(link|file|portal|workspace):/i.test(spec) || spec.startsWith(".") || spec.startsWith("/")) {
    return { mode: "linked", spec, reason: "本机是开发链接安装（link:/file:），更新走仓库，不在界面里执行" };
  }
  return { mode: "npm", spec, reason: "" };
}

/**
 * 找出插件所在的 profile 目录（更新命令要在那里跑 pnpm）：
 * 1. 从插件真实路径往上走，哪一级 package.json 的 dependencies 声明了这个包，哪一级就是 profile
 *    —— npm 布局下插件在 `<profile>/node_modules/<pkg>`，这一条就够，不依赖 env；
 * 2. 退而用 env.DSH_PROFILE_DIR（DSH 启动时注入），要求它确实声明了这个依赖；
 * 3. 都没有返回 ""（界面只解释、不执行）。
 */
export function detectProfileDir({ pluginDir = "", packageName = "", env = {} } = {}) {
  if (!pluginDir || !packageName) return "";
  const declares = (dir) => {
    try {
      const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
      return Boolean(pkg?.dependencies?.[packageName]);
    } catch {
      return false;
    }
  };
  let dir = "";
  try {
    dir = realpathSync(pluginDir);
  } catch {
    dir = pluginDir;
  }
  // 逐级向上（最多 6 层，避免走到磁盘根）
  for (let depth = 0; depth < 6; depth += 1) {
    const parent = dirname(dir);
    if (parent === dir) break;
    if (declares(parent)) return parent;
    dir = parent;
  }
  const hinted = clamp(env?.DSH_PROFILE_DIR);
  if (hinted && declares(hinted)) return hinted;
  // 开发链接安装：插件不在 profile 里，扫 DSH_HOME/profiles/*，挑一个确实声明了依赖的
  const root = clamp(env?.DSH_HOME) ? join(clamp(env?.DSH_HOME), "profiles") : "";
  if (root) {
    try {
      const candidates = readdirSync(root)
        .map((entry) => join(root, entry))
        .filter((dir) => declares(dir));
      if (candidates.length) {
        const named = env?.DSH_PROFILE ? candidates.find((dir) => dir.endsWith(`/${env.DSH_PROFILE}`)) : null;
        return named ?? candidates[0];
      }
    } catch {
      /* profiles 目录不存在就算了 */
    }
  }
  return "";
}

/** 插件包里仓库相关链接（用于顶栏「GitHub」按钮）；没有就留空。 */
export function repoLinksOf(packageJson = {}) {
  const repo = packageJson.repository;
  const raw = typeof repo === "string" ? repo : clamp(repo?.url);
  const url = raw
    .replace(/^git\+/, "")
    .replace(/^git@github\.com:/, "https://github.com/")
    .replace(/\.git$/, "");
  const homepage = clamp(packageJson.homepage) || url;
  const bugs = typeof packageJson.bugs === "string" ? packageJson.bugs : clamp(packageJson.bugs?.url);
  const issues = bugs ? bugs.replace(/\/+$/, "") : url ? `${url}/issues` : "";
  const suggest = issues.endsWith("/issues") ? `${issues}/new/choose` : url ? `${url}/issues/new/choose` : "";
  return { repo: url, homepage, issues, suggest };
}

import { readFileSync, readdirSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
