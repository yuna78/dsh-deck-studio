/**
 * image render：prompt 构建、QA 门禁、fake / gpt-image adapter、版本落盘；
 * 另含「修图」adapter（以已有图为底图 → edits/多图输入），供 deck_image_edit 工具使用。
 *
 * 门禁（AGENTS.md「出图 prompt 不得包含客户敏感信息」的可执行部分）：
 * prompt 非空、不含凭证样式串、尺寸合法。失败不写任何版本文件。
 * @module dsh-plugin-deck-studio/render
 */

import { mkdirSync, writeFileSync, existsSync, readdirSync, readFileSync } from "node:fs";
import { extname, join } from "node:path";
import { briefPromptLines, coverPromptLines } from "./deck-brief.js";

/** 凭证样式串（命中即拒绝出图）。 */
const SECRET_PATTERNS = [
  [/sk-[A-Za-z0-9]{8,}/, "OpenAI 样式密钥 (sk-…)"],
  [/api[_-]?key\s*[=:]/i, "api_key 赋值"],
  [/bearer\s+[A-Za-z0-9._-]{16,}/i, "Bearer token"],
  [/password\s*[=:：]\s*\S+/i, "password 赋值"],
];

/**
 * 从正文里抽「要点」短句（F-189）：图上只放短句，不排长段。
 * 切块优先级：空行分段 → ①②③ 编号 → 句号；每块取冒号前的标签 + 后半句短描述，压到 ~28 字。
 * @param {string} body
 * @param {number} [limit]
 * @returns {string[]}
 */
/** 把一句压到 limit 字内：优先在标点处断（不出现省略号——画面上的省略号会被当成内容印出来）。 */
function shortenClause(text, limit = 28) {
  const value = String(text ?? "").trim();
  if (value.length <= limit) return value;
  const cut = value.slice(0, limit);
  let best = -1;
  for (const punct of ["，", "、", "；", "：", "。"]) {
    best = Math.max(best, cut.lastIndexOf(punct));
  }
  const base = best >= 10 ? cut.slice(0, best) : cut;
  return base.replace(/[，、；：。]$/u, "").trim();
}

export function bodyKeyPoints(body, limit = 4) {
  const text = String(body ?? "").trim();
  if (!text) return [];
  const blocks = text
    .split(/\n{2,}|[①②③④⑤⑥⑦⑧⑨⑩]/u)
    .map((block) => block.trim())
    .filter(Boolean);
  const points = [];
  for (const block of blocks) {
    const first = block.split(/(?<=[。！？])/u)[0].trim().replace(/[。！？]$/u, "");
    if (!first) continue;
    // 「标签（补充）：说明」→ 保留标签 + 说明的首个短句，图上才读得完
    const match = first.match(/^([^：]{1,14}：)\s*(.+)$/u);
    const point = match ? `${match[1]}${shortenClause(match[2], 20)}` : shortenClause(first);
    if (point) points.push(point);
    if (points.length >= limit) break;
  }
  return points;
}

/**
 * 「这一页必须在画面上印出的文字」清单（F-189）。
 * 出图模型只认「要印什么」，把字段名换成口语会漏印——所以这里给出逐字清单，供 prompt 与 QA 共用。
 * @param {object} slide
 * @returns {{title:string, subtitle:string, claim:string, bullets:string[]}}
 */
export function onImageText(slide) {
  const text = (value) => String(value ?? "").trim();
  const title = text(slide?.title);
  const subtitle = text(slide?.question);
  const claim = text(slide?.claim);
  return {
    title,
    subtitle,
    // 主张超过 40 字就别整句塞画面（读不完），让副标题 + 要点承担信息。
    claim: claim.length > 40 ? `${claim.slice(0, 39)}…` : claim,
    bullets: bodyKeyPoints(slide?.body),
  };
}

const ON_IMAGE_HEAD = "【这一页必须在画面上印出的文字：逐字照排，不要改写、翻译、缩写或省略】";
/** 反装饰：图例 / 清单面板 / 英文角标这类「看起来专业但跟本页无关」的元素，模型最容易凭空造。 */
const CANVAS_DISCIPLINE =
  "画面纪律：只画上面【图上文字】与「画面要求」点名的元素；不要新增图例 / 清单面板 / 装饰性英文标签 / 示意数据 / 与内容无关的图标；同一元素不要既画出来又列进清单（重复两遍）；同一信息只写一次，不要用双层括号，也不要既加括注又写注释行。";

/** 把清单渲染成 prompt 行（QA 只检查 head 存在与关键行逐字命中）。 */
function onImageLines(list) {
  const lines = [ON_IMAGE_HEAD];
  if (list.title) lines.push(`主标题：${list.title}`);
  if (list.subtitle) lines.push(`副标题（标题下方一行，字号小于主标题）：${list.subtitle}`);
  if (list.claim) lines.push(`一句话主张：${list.claim}`);
  if (list.bullets.length) {
    lines.push("要点（原句只作理解；画面上每条压成 ≤12 字短语贴到对应模块）：");
    list.bullets.forEach((point, index) => lines.push(`${index + 1}. ${point}`));
  }
  lines.push("版式与字号预算：主标题最大；副标题紧接其下、约标题的 45% 字号；一句话主张做成通栏一行（字号小于副标题、大于要点）——这三项都必须完整印出，不得省略或用别的话替代。");
  return lines;
}

/**
 * 由 slide 字段 + 全局风格 preset 组 prompt。
 * F-158：封面页单列一套版式纪律（只放标题/副标题/作者/日期，不堆正文）；
 * 普通页带上 intent 的受众 / 目的，避免「图很漂亮但讲错人」。
 * F-189：文字不再是「语境」，而是显式「图上文字清单」——副标题 / 主张 / 要点逐字列出，
 * 并声明与 visualBrief 的排他指令冲突时文字优先（否则「画面上只出现 XX 标签」会把副标题吞掉）。
 * @param {object} slide manifest slide
 * @param {string} styleBrief
 * @param {{brief?: object}} [context] readDeckBrief() 的结果
 */
export function buildPrompt(slide, styleBrief, context = {}) {
  const brief = context.brief ?? {};
  const list = onImageText(slide);
  const isCover = slide?.type === "cover" || Number(slide?.order) === 1;
  if (isCover) {
    const parts = [styleBrief, "封面页（16:9）：只放标题信息", ...onImageLines({ ...list, bullets: [] })];
    parts.push(...coverPromptLines(brief));
    parts.push("版式纪律：只放主标题 / 副标题 / 作者 / 日期；正文不超过一行；不要目录、要点清单、数据图表、大段文字；留白为主。");
    if (slide?.visualBrief) parts.push(`画面要求：${slide.visualBrief}`);
    parts.push(CANVAS_DISCIPLINE);
    parts.push("文字优先：上面【图上文字】的每一行都必须出现在画面里；画面要求与它冲突时，以上面为准。");
    return parts.filter(Boolean).join("\n");
  }
  const parts = [styleBrief, ...onImageLines(list)];
  const body = String(slide?.body ?? "").trim();
  if (body) parts.push(`讲述用正文（不要整段排进画面，只提炼成上面的要点；用来把握语气与例子）：${body.slice(0, 300)}`);
  if (slide?.visualBrief) parts.push(`画面要求：${slide.visualBrief}`);
  parts.push(CANVAS_DISCIPLINE);
  parts.push("文字优先：上面【图上文字】的主标题 / 副标题 / 主张必须完整印出（可换行、可分层，但不得省略、不得改写成别的说法）；画面要求若写「只出现 XX」，XX 之外仍要保留这三项与要点短语。");
  parts.push(...briefPromptLines(brief));
  return parts.filter(Boolean).join("\n");
}

/**
 * QA 门禁。返回 {ok, checks:[{name, ok, detail}]}。
 * @param {string} prompt 最终 prompt
 * @param {string} size 尺寸
 * @param {object} [slide] 传了就额外检查「图上文字」是否都在 prompt 里（F-189）
 */
export function qaCheck(prompt, size, slide) {
  const checks = [];
  const promptOk = typeof prompt === "string" && prompt.trim().length >= 8;
  checks.push({ name: "prompt-exists", ok: promptOk, detail: promptOk ? `${prompt.trim().length} chars` : "prompt 为空或过短" });
  const sizeOk = /^\d{3,4}x\d{3,4}$/.test(String(size ?? ""));
  checks.push({ name: "size-valid", ok: sizeOk, detail: String(size ?? "") });
  const secretHit = SECRET_PATTERNS.find(([pattern]) => pattern.test(prompt ?? ""));
  checks.push({ name: "no-secrets", ok: !secretHit, detail: secretHit ? `疑似敏感串：${secretHit[1]}` : "clean" });
  if (slide) {
    const list = onImageText(slide);
    const missing = [];
    if (!String(prompt ?? "").includes(ON_IMAGE_HEAD)) missing.push("图上文字清单");
    if (list.title && !String(prompt ?? "").includes(list.title)) missing.push("主标题");
    if (list.subtitle && !String(prompt ?? "").includes(list.subtitle)) missing.push("副标题");
    if (list.claim && !String(prompt ?? "").includes(list.claim)) missing.push("主张");
    checks.push({ name: "on-image-text", ok: missing.length === 0, detail: missing.length ? `prompt 缺：${missing.join(" / ")}` : `${list.title ? "标题" : ""}${list.subtitle ? "+副标题" : ""}${list.claim ? "+主张" : ""}${list.bullets.length ? `+${list.bullets.length} 要点` : ""}` || "clean" });
  }
  return { ok: checks.every((check) => check.ok), checks };
}

/** 下一个版本号 v001…（按 versions/ 目录现有条目数）。 */
export function nextRevision(slideDir) {
  const versionsDir = join(slideDir, "versions");
  if (!existsSync(versionsDir)) return "v001";
  const count = readdirSync(versionsDir).filter((name) => /^v\d+$/.test(name)).length;
  return `v${String(count + 1).padStart(3, "0")}`;
}

/** fake renderer：确定性 SVG 占位，不访问网络。 */
export function createFakeRenderer() {
  return {
    provider: "fake",
    async render({ prompt, slideId, revision, model, endpoint, size, outDir, signal }) {
      const started = Date.now();
      signal?.throwIfAborted();
      const [w, h] = String(size).split("x").map((n) => Number.parseInt(n, 10) || 1536);
      const escape = (text) => String(text).replace(/[<&>]/g, (char) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[char] ?? char));
      const excerpt = escape(prompt.replace(/\n/g, " / ").slice(0, 220));
      const svg =
        `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">` +
        `<rect width="100%" height="100%" fill="#f6f0e5"/>` +
        `<rect x="0" y="${h - 88}" width="100%" height="88" fill="#06363B"/>` +
        `<text x="72" y="140" font-family="sans-serif" font-size="${Math.round(w / 38)}" fill="#06363B">${escape(slideId)} · ${escape(revision)}</text>` +
        `<text x="72" y="220" font-family="sans-serif" font-size="${Math.round(w / 64)}" fill="#1496a8">FAKE RENDER · ${escape(model)} · ${escape(size)}</text>` +
        `<text x="72" y="${h - 120}" font-family="sans-serif" font-size="${Math.round(w / 72)}" fill="#5C6464">${excerpt}</text>` +
        `</svg>`;
      const imagePath = join(outDir, "image.svg");
      writeFileSync(imagePath, svg, "utf8");
      return { imagePath, imageExt: "svg", model, endpoint, size, durationMs: Date.now() - started, provider: "fake" };
    },
  };
}

/** gpt-image adapter：POST {model, prompt, size} → data[0].b64_json → image.png。 */
/** 下载图片 URL：CDN 抖动时重试（最多 5 次，指数退避）；已取消的请求不再重试。 */
async function downloadImage(fetchImpl, url, signal, attempts = 5) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (signal?.aborted) throw signal.reason ?? new Error("render 已取消");
    try {
      const response = await fetchImpl(url, { signal });
      if (response.ok) return response;
      lastError = new Error(`image url 下载失败 HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    if (attempt + 1 < attempts) await new Promise((resolve) => setTimeout(resolve, Math.min(2000, 500 * 2 ** attempt)));
  }
  throw lastError ?? new Error("image url 下载失败");
}

export function createRealRenderer({ fetchImpl = fetch } = {}) {
  return {
    provider: "gpt-image",
    async render({ prompt, model, endpoint, size, outDir, apiKey, timeoutMs, signal }) {
      if (!apiKey) throw new Error(`real render 需要 API key：设置 env ${"DSH_DECK_IMAGE_API_KEY"}（或 config.render.apiKeyEnv 指向的变量）`);
      if (!endpoint) throw new Error("real render 缺 endpoint 配置");
      const started = Date.now();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(new Error(`render 超时（${timeoutMs}ms）`)), timeoutMs ?? 420_000);
      const onAbort = () => controller.abort(signal?.reason);
      signal?.addEventListener("abort", onAbort, { once: true });
      try {
        const response = await fetchImpl(endpoint, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
          body: JSON.stringify({ model, prompt, size, n: 1 }),
          signal: controller.signal,
        });
        if (!response.ok) {
          const text = await response.text().catch(() => "");
          throw new Error(`image API ${response.status}: ${text.slice(0, 300)}`);
        }
        const body = await response.json();
        const item = body?.data?.[0] ?? {};
        const imagePath = join(outDir, "image.png");
        if (item.b64_json) {
          writeFileSync(imagePath, Buffer.from(item.b64_json, "base64"));
        } else if (item.url) {
          // 中转可能返回 OSS 托管 URL（签名地址，不带凭证），GET 落地。
          // 签名 URL 走 CDN，跨网抖动时会瞬时超时；重试 1 次（不重试已取消的请求）。
          const fileResponse = await downloadImage(fetchImpl, item.url, controller.signal);
          writeFileSync(imagePath, Buffer.from(await fileResponse.arrayBuffer()));
        } else {
          throw new Error("image API 返回缺少 data[0].b64_json / url");
        }
        return { imagePath, imageExt: "png", model, endpoint, size, durationMs: Date.now() - started, provider: "gpt-image" };
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
      }
    },
  };
}

/** 从 KEY=VALUE 样式的 env 文件读一个变量（不抛错；绝不打日志）。 */
export function readKeyFromFile(file, name) {
  if (!file || !name) return "";
  try {
    for (const line of readFileSync(file, "utf8").split("\n")) {
      const match = new RegExp(`^\\s*${name}\\s*=\\s*(.*?)\\s*$`).exec(line);
      if (match) return match[1].replace(/^["']|["']$/g, "").trim();
    }
  } catch {
    // 文件不存在 / 不可读：返回空，由调用方报“缺 key”
  }
  return "";
}

/**
 * 从出图 endpoint 派生修图 endpoint：`/v1/images/generations` → `/v1/images/edits`。
 * 节点可以显式配 `editEndpoint` 覆盖；派生不出来就返回空串（调用方报错，不猜地址）。
 */
export function editEndpointFor(endpoint) {
  const text = String(endpoint ?? "").trim().replace(/\/+$/, "");
  if (!text) return "";
  if (/\/images\/edits$/.test(text)) return text;
  if (/\/images\/generations$/.test(text)) return text.replace(/\/images\/generations$/, "/images/edits");
  if (/\/v1$/.test(text)) return `${text}/images/edits`;
  return "";
}

const MIME_BY_EXT = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp" };

/** 图片文件 → {mime, ext}；不支持的格式返回 null。 */
export function imageMime(ext) {
  const key = String(ext ?? "").toLowerCase();
  const mime = MIME_BY_EXT[key.startsWith(".") ? key : `.${key}`];
  return mime ? { mime, ext: key.startsWith(".") ? key : `.${key}` } : null;
}

/** 修图响应解析：b64_json 直接落盘，url 走下载（和出图共用重试）。 */
async function writeEditImage(fetchImpl, item, outDir, signal) {
  const imagePath = join(outDir, "image.png");
  if (item?.b64_json) {
    writeFileSync(imagePath, Buffer.from(item.b64_json, "base64"));
    return imagePath;
  }
  if (item?.url) {
    const fileResponse = await downloadImage(fetchImpl, item.url, signal);
    writeFileSync(imagePath, Buffer.from(await fileResponse.arrayBuffer()));
    return imagePath;
  }
  throw new Error("修图 API 返回缺少 data[0].b64_json / url");
}

/**
 * 修图（image edit）adapter：multipart 传 image + prompt + model + size 到 edits 端点。
 * transport=json 时改用 JSON body（image 传 data URL），给只吃 JSON 的中转兜底。
 */
export function createRealEditRenderer({ fetchImpl = fetch } = {}) {
  return {
    provider: "gpt-image-edit",
    async edit({ filePath, prompt, model, endpoint, size, outDir, apiKey, timeoutMs, signal, transport = "multipart" }) {
      if (!apiKey) throw new Error("修图需要 API key：设置 env DSH_DECK_IMAGE_API_KEY（或 config.render.apiKeyEnv 指向的变量）");
      if (!endpoint) throw new Error("修图缺 endpoint：在节点配 editEndpoint，或让出图 endpoint 以 /v1/images/generations 结尾自动派生");
      const started = Date.now();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(new Error(`修图超时（${timeoutMs}ms）`)), timeoutMs ?? 420_000);
      const onAbort = () => controller.abort(signal?.reason);
      signal?.addEventListener("abort", onAbort, { once: true });
      try {
        let response;
        if (transport === "json") {
          const mime = imageMime(extname(filePath))?.mime ?? "image/png";
          const dataUrl = `data:${mime};base64,${readFileSync(filePath).toString("base64")}`;
          response = await fetchImpl(endpoint, {
            method: "POST",
            headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
            body: JSON.stringify({ model, prompt, size, n: 1, image: dataUrl }),
            signal: controller.signal,
          });
        } else {
          const info = imageMime(extname(filePath)) ?? { mime: "image/png", ext: ".png" };
          const form = new FormData();
          form.append("model", model);
          form.append("prompt", prompt);
          form.append("size", size);
          form.append("n", "1");
          form.append("image", new Blob([readFileSync(filePath)], { type: info.mime }), `source${info.ext}`);
          response = await fetchImpl(endpoint, {
            method: "POST",
            headers: { authorization: `Bearer ${apiKey}` },
            body: form,
            signal: controller.signal,
          });
        }
        if (!response.ok) {
          const text = await response.text().catch(() => "");
          throw new Error(`修图 API ${response.status}: ${text.slice(0, 300)}`);
        }
        const body = await response.json();
        const imagePath = await writeEditImage(fetchImpl, body?.data?.[0] ?? {}, outDir, controller.signal);
        return { imagePath, imageExt: "png", model, endpoint, size, durationMs: Date.now() - started, provider: "gpt-image-edit", transport };
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
      }
    },
  };
}

/** fake 修图：把底图复制成新版本（确定性、不联网），用于 smoke / 无 key 演示。 */
export function createFakeEditRenderer() {
  return {
    provider: "fake-edit",
    async edit({ filePath, outDir, ext = ".png", signal }) {
      signal?.throwIfAborted();
      const started = Date.now();
      const info = imageMime(ext) ?? { ext: ".png" };
      const imagePath = join(outDir, `image${info.ext}`);
      writeFileSync(imagePath, readFileSync(filePath));
      return { imagePath, imageExt: info.ext, provider: "fake-edit", size: null, durationMs: Date.now() - started };
    },
  };
}

/** 按配置选 renderer；real 模式缺 key 直接抛（不悄悄退回 fake）。 */
export function selectRenderer(renderConfig, env = process.env) {
  if (renderConfig.mode === "real") {
    const apiKey = env[renderConfig.apiKeyEnv] || readKeyFromFile(renderConfig.apiKeyFile, renderConfig.apiKeyEnv);
    return { renderer: createRealRenderer(), apiKey };
  }
  return { renderer: createFakeRenderer(), apiKey: "" };
}
