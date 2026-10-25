/**
 * 首页目录：Designs（风格 + 样张）与 Resources（资源库）。
 *
 * 约定（docs/deck-documents.md「design / 资源」）：
 * - 一个风格 = 一个目录：`designs/<ABBR>/`（ABBR 是风格缩写，目录名即缩写，如 `PC`）；
 * - 风格元信息：目录下 `style.json`（{abbr,name,description}）或 `style.md`
 *   （可选 frontmatter: abbr/name，正文即风格提示词/描述）；
 * - 样张：风格目录下的图片文件，全部属于该风格，首页点 block 弹层预览多张；
 * - 资源库：`resources/index.json`（{items:[{name,description,file}]}）描述文件；
 *   没有 index 时自动登记目录里的图片（logo 等素材）。
 *
 * 只做扫描与描述，不复制文件、不写盘；文件由 media 路由按白名单伺服。
 * @module dsh-plugin-deck-studio/home-catalog
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join } from "node:path";

const IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".webp", ".svg"]);
const MEDIA_DIRS_SOURCE = new Set(["designs", "resources", "assets", "samples", "probe", "styles", "style-samples"]);
const MEDIA_DIRS_WORK = new Set(["designs", "resources"]);
// 共享资源库（F-134）：<dataRoot>/resources，跨 deck 共用 logo / 头像 / 二维码等。
const MEDIA_DIRS_SHARED = new Set(["resources"]);

const isImage = (name) => IMAGE_EXTS.has(extname(name).toLowerCase());
const byName = (a, b) => a.localeCompare(b, "zh-Hans-CN");

/** 解析极简 frontmatter（只认 `---` 之间的 `key: value`；不引第三方依赖）。 */
export function parseFrontmatter(text) {
  const source = String(text ?? "").replace(/\r\n/g, "\n");
  if (!source.startsWith("---\n")) return { fields: {}, body: source };
  const end = source.indexOf("\n---", 4);
  if (end < 0) return { fields: {}, body: source };
  const fields = {};
  for (const line of source.slice(4, end).split("\n")) {
    const match = line.match(/^([A-Za-z][\w-]*)\s*[：:]\s*(.*)$/);
    if (match) fields[match[1].toLowerCase()] = match[2].trim();
  }
  return { fields, body: source.slice(end + 4).replace(/^\n+/, "") };
}

/** 读风格元信息：style.json > style.md > 目录名兜底。 */
function readStyleMeta(dir, dirName) {
  const jsonFile = join(dir, "style.json");
  if (existsSync(jsonFile)) {
    try {
      const raw = JSON.parse(readFileSync(jsonFile, "utf8"));
      return {
        abbr: String(raw.abbr || dirName).trim(),
        name: String(raw.name || raw.abbr || dirName).trim(),
        description: String(raw.description || raw.prompt || "").trim(),
      };
    } catch {
      /* 坏 json 退回 style.md */
    }
  }
  const mdFile = join(dir, "style.md");
  let description = "";
  let name = dirName;
  let abbr = dirName;
  if (existsSync(mdFile)) {
    const { fields, body } = parseFrontmatter(readFileSync(mdFile, "utf8"));
    if (fields.abbr) abbr = fields.abbr;
    if (fields.name) name = fields.name;
    description = body.trim();
    if (!description) {
      const heading = body.match(/^#+\s*(.*)$/m);
      if (heading) name = heading[1].trim() || name;
    }
  }
  return { abbr: abbr.trim() || dirName, name: name.trim() || dirName, description };
}

/** 目录里的图片样张（只直接子文件，避免把子目录结构带进来）。 */
function listImages(dir) {
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir)
      .filter((name) => !name.startsWith("."))
      .filter((name) => isImage(name))
      .map((name) => ({ name, file: join(dir, name) }))
      .filter((item) => {
        try {
          return statSync(item.file).isFile();
        } catch {
          return false;
        }
      })
      .sort((a, b) => byName(a.name, b.name));
  } catch {
    return [];
  }
}

/**
 * 扫描风格：一个子目录 = 一个风格（source 优先，其次工作副本；同缩写去重）。
 * @param {{deckId: string, sourceRoot?: string, deckDir?: string}} input
 */
export function scanDesignStyles({ deckId, sourceRoot = "", deckDir = "" } = {}) {
  const roots = [];
  if (sourceRoot && existsSync(join(sourceRoot, "designs"))) roots.push({ scope: "source", dir: join(sourceRoot, "designs") });
  if (deckDir && existsSync(join(deckDir, "designs"))) roots.push({ scope: "work", dir: join(deckDir, "designs") });

  const styles = [];
  const seen = new Set();
  for (const root of roots) {
    let entries = [];
    try {
      entries = readdirSync(root.dir).filter((name) => !name.startsWith(".")).sort(byName);
    } catch {
      continue;
    }
    for (const dirName of entries) {
      const styleDir = join(root.dir, dirName);
      let stat;
      try {
        stat = statSync(styleDir);
      } catch {
        continue;
      }
      if (!stat.isDirectory()) continue;
      const meta = readStyleMeta(styleDir, dirName);
      const key = meta.abbr.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      const samples = listImages(styleDir).map((item) => ({
        name: item.name,
        sizeBytes: (() => {
          try {
            return statSync(item.file).size;
          } catch {
            return 0;
          }
        })(),
        url: mediaUrl({ deckId, scope: root.scope, path: `designs/${dirName}/${item.name}` }),
      }));
      styles.push({
        abbr: meta.abbr,
        name: meta.name,
        description: meta.description,
        dir: dirName,
        scope: root.scope,
        samples,
      });
    }
  }
  return styles;
}

/**
 * 扫描资源库：`resources/index.json` 描述优先，其次自动登记 resources/ 与 assets/ 里的图片。
 */
export function scanResources({ deckId, sourceRoot = "", deckDir = "", sharedRoot = "" } = {}) {
  const roots = [];
  // 共享库放最前：同一张图在 deck 内也有时，优先展示共享条目的名称/描述。
  if (sharedRoot) roots.push({ scope: "shared", dir: join(sharedRoot, "resources") });
  if (deckDir) roots.push({ scope: "work", dir: join(deckDir, "resources") });
  if (sourceRoot) {
    roots.push({ scope: "source", dir: join(sourceRoot, "resources") });
    roots.push({ scope: "source", dir: join(sourceRoot, "assets") });
  }

  const resources = [];
  const seen = new Set();
  const seenNames = new Set();
  const push = (item, fileName = "") => {
    const urlKey = item.url;
    const nameKey = String(fileName || item.name || "").toLowerCase();
    if (seen.has(urlKey) || (nameKey && seenNames.has(nameKey))) return;
    seen.add(urlKey);
    if (nameKey) seenNames.add(nameKey);
    resources.push(item);
  };

  for (const root of roots) {
    if (!existsSync(root.dir)) continue;
    const dirName = root.dir.split("/").pop();
    const indexFile = join(root.dir, "index.json");
    if (existsSync(indexFile)) {
      let items = [];
      try {
        const raw = JSON.parse(readFileSync(indexFile, "utf8"));
        items = Array.isArray(raw) ? raw : (raw.items ?? []);
      } catch {
        items = [];
      }
      for (const entry of items) {
        const file = String(entry?.file ?? "").trim();
        if (!file || file.includes("..") || file.includes("/")) continue;
        const full = join(root.dir, file);
        if (!existsSync(full) || !isImage(file)) continue;
        push({
          name: String(entry.name || file).trim(),
          description: String(entry.description || "").trim(),
          kind: extname(file).slice(1).toUpperCase(),
          scope: root.scope,
          sizeBytes: statSync(full).size,
          url: mediaUrl({ deckId, scope: root.scope, path: `${dirName}/${file}` }),
        }, file);
      }
    }
    // 没有 index.json 或 index 里没登记的图片：自动登记（按文件名当描述）
    for (const item of listImages(root.dir)) {
      if (item.name.toLowerCase() === "index.json") continue;
      const already = resources.some((resource) => resource.url.endsWith(`/${encodeURIComponent(item.name)}`) || resource.url.endsWith(`/${item.name}`));
      if (already) continue;
      try {
        push({
          name: item.name.replace(/\.[a-z0-9]+$/i, ""),
          description: `源素材 · ${dirName}/`,
          kind: extname(item.name).slice(1).toUpperCase(),
          scope: root.scope,
          sizeBytes: statSync(item.file).size,
          url: mediaUrl({ deckId, scope: root.scope, path: `${dirName}/${item.name}` }),
        }, item.name);
      } catch {
        /* 单文件读不到就跳过 */
      }
    }
  }
  return resources;
}

/** media 路由 URL（所有目录/文件都在 URL 里编码，前端直接用）。 */
export function mediaUrl({ deckId, scope, path }) {
  return `/api/deck-studio.media?` + new URLSearchParams({ deckId, scope, path });
}

/**
 * media 路由解析：只允许白名单目录 + 图片扩展名 + 不允许 `..`/绝对路径。
 * @returns {{file: string}|null}
 */
export function resolveMediaFile({ deckId, scope, path, sourceRoot = "", deckDir = "", sharedRoot = "" }) {
  const base = scope === "shared" ? sharedRoot : scope === "work" ? deckDir : sourceRoot;
  if (scope === "shared" && !sharedRoot) return null;
  if (!base || !path || typeof path !== "string") return null;
  if (path.includes("..") || path.startsWith("/") || path.includes("\\")) return null;
  const first = path.split("/")[0];
  const allowed = scope === "shared" ? MEDIA_DIRS_SHARED : scope === "work" ? MEDIA_DIRS_WORK : MEDIA_DIRS_SOURCE;
  if (!allowed.has(first)) return null;
  if (!isImage(path)) return null;
  const file = join(base, path);
  if (!existsSync(file)) return null;
  try {
    return statSync(file).isFile() ? { file } : null;
  } catch {
    return null;
  }
}
