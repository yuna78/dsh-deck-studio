#!/usr/bin/env node
/**
 * npm 打包前把「使用手册 + 示例 deck」收进包内 seeds/。
 *
 * 源码树里它们在 <repo>/docs 与 <repo>/samples；npm 安装后插件上两级是 node_modules，
 * 拿不到仓库资产。lib/config.js 的 repoRootFrom() 在检测不到仓库布局时回退到 seeds/，
 * 所以这里生成 seeds/docs 与 seeds/sample-deckline-intro，保证 npm 安装后的首启体验完整。
 *
 * 这些目录是构建产物（gitignore），每次 pack/publish 自动重建。
 */
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE_DIR = dirname(HERE);
const REPO_ROOT = dirname(dirname(PACKAGE_DIR));
const SEEDS = join(PACKAGE_DIR, "seeds");

const DOC_FILES = [
  "manual.md", "manual.en.md",
  "install.md", "install.en.md",
  "styles.md", "styles.en.md",
  "sample-deck.md", "sample-deck.en.md",
  "compat.md",
];

function copyDocs() {
  const src = join(REPO_ROOT, "docs");
  if (!existsSync(join(src, "manual.md"))) {
    console.warn("[prepack] 找不到 docs/manual.md，跳过分发文档（可能不是从仓库根打包）");
    return;
  }
  const dest = join(SEEDS, "docs");
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(join(dest, "assets", "screenshots"), { recursive: true });
  for (const name of DOC_FILES) {
    if (existsSync(join(src, name))) cpSync(join(src, name), join(dest, name));
  }
  const shots = join(src, "assets", "screenshots");
  if (existsSync(shots)) cpSync(shots, join(dest, "assets", "screenshots"), { recursive: true });
  console.log(`[prepack] docs → seeds/docs（${DOC_FILES.filter((n) => existsSync(join(src, n))).length} 份）`);
}

function copySampleDeck() {
  const src = join(REPO_ROOT, "samples", "deckline-intro");
  if (!existsSync(join(src, "script.md"))) {
    console.warn("[prepack] 找不到 samples/deckline-intro/script.md，跳过示例 deck");
    return;
  }
  const dest = join(SEEDS, "samples", "deckline-intro");
  rmSync(dest, { recursive: true, force: true });
  cpSync(src, dest, { recursive: true });
  console.log("[prepack] samples/deckline-intro → seeds/samples/deckline-intro");
}

copyDocs();
copySampleDeck();
