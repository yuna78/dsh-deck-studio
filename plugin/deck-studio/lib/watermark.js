/**
 * Logo 水印（F-125）：assets 分类 → 列举可选水印 → 给整份 deck 的页面盖 logo。
 *
 * 负责人口径（2026-10-23）：
 * - assets 里按分类放素材，至少有一类 `logo`，可以放多个；
 * - 用户跟 Agent 说「我要加水印」，能选哪个 logo；默认盖 **右上角**；
 * - 每个页面都盖；原图不覆盖——水印产物写新的 revision（vNNN），旧图保留。
 *
 * 实现：纯 node（zlib）自己解 / 编 PNG（见 lib/png.js），不引 sharp/canvas。
 * 页面图与 logo 都必须是 PNG；SVG logo 会明确提示先转 PNG，而不是静默跳过。
 *
 * @module dsh-plugin-deck-studio/watermark
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, extname, join, relative } from "node:path";
import { compositeLogo, decodePng, encodePng } from "./png.js";

/** 水印位置（默认右上角）。 */
export const WATERMARK_POSITIONS = ["top-right", "top-left", "bottom-right", "bottom-left", "center"];

export const WATERMARK_POSITION_LABELS = {
  "top-right": "右上角（默认）",
  "top-left": "左上角",
  "bottom-right": "右下角",
  "bottom-left": "左下角",
  center: "居中",
};

const IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".svg"]);

/** 资产分类根目录：仓库 `assets/`（按子目录分类，如 logo/）。 */
export function assetsRootOf(repoRoot) {
  return join(repoRoot, "assets");
}

/**
 * 扫描 assets/ 下的分类与素材。
 * @returns {{categories: Array<{category: string, items: Array<{id: string, name: string, category: string, format: string, bytes: number, path: string, watermarkable: boolean}>}>}}
 */
export function listAssets(repoRoot) {
  const root = assetsRootOf(repoRoot);
  if (!existsSync(root)) return { categories: [], root };
  const categories = [];
  for (const entry of readdirSync(root, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const dir = join(root, entry.name);
    const items = [];
    for (const file of readdirSync(dir).sort()) {
      const ext = extname(file).toLowerCase();
      if (!IMAGE_EXTS.has(ext) || file.startsWith(".")) continue;
      const path = join(dir, file);
      const stat = statSync(path);
      if (!stat.isFile()) continue;
      items.push({
        id: `${entry.name}/${file}`,
        name: file,
        category: entry.name,
        format: ext.replace(".", ""),
        bytes: stat.size,
        path,
        // 只有 PNG 能直接合成（zlib 自己解）；SVG/JPG 明确提示先转 PNG。
        watermarkable: ext === ".png",
      });
    }
    if (items.length) categories.push({ category: entry.name, items });
  }
  return { categories, root };
}

/** 支持做水印的素材（PNG），供 Agent 选择。 */
export function listWatermarkAssets(repoRoot) {
  const { categories, root } = listAssets(repoRoot);
  const items = categories.flatMap((category) => category.items).filter((item) => item.watermarkable);
  return { root, categories, items };
}

/**
 * 按 Agent 给的名字找素材：id（logo/x.png）/ 文件名（x.png）/ 基名（x）都可以；
 * 找不到或有歧义都返回候选，让 Agent 能自己纠正而不是瞎猜。
 */
export function findAsset(repoRoot, query) {
  // 找素材时把 SVG/JPG 也算进来：用户报了 SVG 名字时要能明确说「需要先转 PNG」，
  // 而不是回一句「没找到」。
  const { categories } = listAssets(repoRoot);
  const items = categories.flatMap((category) => category.items);
  const raw = String(query ?? "").trim();
  if (!raw) return { ok: false, reason: "empty", candidates: items };
  const needle = raw.toLowerCase().replace(/\\/g, "/");
  const qualified = needle.includes("/") ? needle : null;
  const matches = items.filter((item) => {
    const id = item.id.toLowerCase();
    const name = item.name.toLowerCase();
    const stem = name.replace(/\.[^.]+$/, "");
    if (qualified) return id === qualified || id.endsWith(`/${qualified}`);
    return name === needle || stem === needle || id === needle;
  });
  if (matches.length === 1) return { ok: true, asset: matches[0] };
  if (matches.length > 1) return { ok: false, reason: "ambiguous", candidates: matches };
  // 宽松兜底：唯一子串命中
  const loose = items.filter((item) => item.id.toLowerCase().includes(needle) || item.name.toLowerCase().includes(needle));
  if (loose.length === 1) return { ok: true, asset: loose[0] };
  if (loose.length > 1) return { ok: false, reason: "ambiguous", candidates: loose };
  return { ok: false, reason: "not-found", candidates: items };
}

/** 把一张页面 PNG + logo PNG 合成水印后的 PNG Buffer。 */
export function watermarkPng({ pageBuffer, logoBuffer, position = "top-right", opacity = 0.85, scale = 0.14, margin = 0.04 }) {
  const page = decodePng(pageBuffer);
  const logo = decodePng(logoBuffer);
  const { image, placement } = compositeLogo({ page, logo, position, opacity, scale, margin });
  return { buffer: encodePng(image), size: `${image.width}x${image.height}`, placement };
}

/** 给 Agent 看的一行位置说明。 */
export function positionLine() {
  return WATERMARK_POSITIONS.map((key) => `${key}（${WATERMARK_POSITION_LABELS[key]}）`).join(" / ");
}

/** 报告里用的相对路径（不把本机绝对路径泄给用户/Agent）。 */
export function displayPath(repoRoot, path) {
  try {
    const rel = relative(repoRoot, path);
    return rel.startsWith("..") ? basename(path) : rel;
  } catch {
    return basename(path);
  }
}

/** 读 PNG 文件（水印流程用，统一错误文案）。 */
export function readPngFile(path) {
  const buffer = readFileSync(path);
  if (!buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    throw new Error(`不是 PNG：${basename(path)}`);
  }
  return buffer;
}
