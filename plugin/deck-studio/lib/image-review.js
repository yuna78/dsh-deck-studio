/**
 * 图片评审（智力升级 C 层 / F-178）：图出来后到底对不对。
 *
 * 设计原则（docs/intelligence-upgrade.md §C）：
 * - 视觉模型只做**转写**（低自由度，逐字照抄，看到错字照抄错字），判定交给程序（字符串 diff）。
 * - 同一张图转写两次，按字段比对；不一致的字段标「不确定」送人工，不参与自动判定。
 * - 表意层先盲后对照：先只给图问「这图像在说什么」，再给本页主张判「一致 / 矛盾 / 多出」。
 * - 五维打分只记录（保真 / 完整 / 表意 / 贴合 / 承接），硬门禁只有「保真 = 5 且 表意 ≥ 4」。
 * - 不引入 OCR：直接用视觉输入（docs/vision-input.md 已实测边界）。
 *
 * 本模块只做纯逻辑 + 一次 HTTP 调用；落盘（qa.json / review.images.md）在 tools.js。
 */

import { readFileSync } from "node:fs";
import { extname } from "node:path";

/** 逐字转写 prompt：不让模型概括、纠错、美化。 */
export function transcribePrompt({ page }) {
  return `任务：把这张幻灯片图片里**所有可见文字逐字照抄**下来，用于和稿件做比对。

规则（很重要）：
1. 只照抄，不概括、不纠错、不补全、不美化。看到错字就抄错字，看到缺字就留缺。
2. 看不清的字写 "?"，不要猜。
3. 不要描述画面、颜色、构图——只要文字。
4. 按区块归类：标题 / 副标题 / 正文 / 数字（含单位）/ 标注（标签、角标、页脚、来源行）。

只输出 JSON（不要 markdown 代码块）：
{"title":"...","subtitle":"...","body":["段落 1","段落 2"],"numbers":["数字或含数字的短句"],"labels":["标签/角标/页脚"],"unreadable":["看不清的片段"]}

页码：${page || "（未指定）"}`;
}

/** 盲述 prompt：不给稿子、不给意图，只问看图感受（C2a）。 */
export function blindPrompt({ page }) {
  return `只看这一张幻灯片图片，不要参考任何稿件，回答三个问题：
1. 这图像在说什么？（一句话）
2. 它想让我做什么 / 记住什么？（一句话）
3. 你觉得它哪里最费解？（一句话；没有就写 "无"）

只输出 JSON（不要 markdown 代码块）：{"what":"...","ask":"...","confusing":"..."}

页码：${page || "（未指定）"}`;
}

/** 对照 prompt：给本页主张 + 受众 + 风格锚点，判一致 / 矛盾 / 多出，并打贴合与承接分。 */
export function contrastPrompt({ page, pageText, intent = "", styleAnchor = "", prevPage = "", visualBrief = "", cover = false }) {
  const coverRule = cover
    ? `\n封面页例外：作者署名 / 主讲人 / 场合 / 日期 / 品牌角标属于封面版式要求（「这页的画面要求」里通常已写明），不算超载。`
    : "";
  return `你是版面评审。先读「这页该讲什么」，再看图，判断三件事：

A. 图表达的意思和主张是否一致？
   - "一致"：图在支持这条主张
   - "矛盾"：图说了相反的 / 让人得出相反结论 → 这是扭曲（P0）
   - "多出"：图里出现稿件没要求的信息（自造数据、额外结论、无关装饰性文字）→ 超载（P1）${coverRule}
B. 贴合：颜色角色 / 画法 / 信息密度是否命中风格锚点？1–5 分（5=全部命中，3=一处漂移，1=换了风格）
C. 承接：和上一页的视觉语言是否连续（同一套卡片 / 线条 / 构图习惯）？1–5 分（没有上一页就给 4）

只输出 JSON（不要 markdown 代码块）：
{"verdict":"一致|矛盾|多出","contradiction":"矛盾在哪（没有就空）","extra":["多出来的信息"],"fit":1,"continuity":1,"notes":"≤60 字"}

页码：${page || "（未指定）"}
受众 / 意图：${intent || "（未提供）"}
风格锚点：${styleAnchor || "（未提供）"}
上一页：${prevPage || "（无）"}

这页该讲什么（稿件原文）：
"""
${pageText}
"""

这页的画面要求（visualBrief；图应照此呈现，不是稿件正文）：
"""
${visualBrief || "（未写）"}
"""`;
}

/** 封面版式允许出现的元信息：署名 / 场合 / 日期 / 品牌角标不算「多出」。 */
const COVER_META_RE = /(署名|作者|主讲|演讲|讲者|分享人|场合|会议|分享会|内部分享|日期|时间|地点|公司|团队|版|版权|©|logo|角标|20\d{2}\s*[-年./]\s*\d)/i;

/**
 * 按页角色校正对照结论（C2）：封面页里属于版式要求的元信息，不该被算成超载。
 *
 * 为什么要程序兜底：判超载的是视觉模型，它看不到版式约定，容易把「Yuna · 公司内部分享 · 2026-10」
 * 这种封面署名判成「多出来的信息」→ 表意 3 分、门禁不过、转人工。规则是确定性的，就不交给模型猜。
 * 只对封面生效；正文页多出信息仍然算超载（这条不能松）。
 */
export function normalizeContrastForPage(contrast = {}, { cover = false } = {}) {
  const extras = Array.isArray(contrast.extra) ? contrast.extra : [];
  if (!cover || extras.length === 0 || contrast.verdict === "矛盾") return { ...contrast, ignoredExtras: [] };
  const ignored = extras.filter((item) => COVER_META_RE.test(String(item ?? "")));
  const kept = extras.filter((item) => !COVER_META_RE.test(String(item ?? "")));
  if (ignored.length === 0) return { ...contrast, ignoredExtras: [] };
  return {
    ...contrast,
    verdict: kept.length ? "多出" : "一致",
    extra: kept,
    ignoredExtras: ignored,
  };
}

const FENCE = /^\s*```[a-z]*\s*/i;

/**
 * 挑出「整页出图」的 prompt（修图版本的 prompt.txt 只有编辑指令，没有页面标题，不能当基准）。
 * @param {string[]} prompts - 从新到旧排列的 prompt 文本
 */
export function pickRenderExpectations(prompts = []) {
  for (const prompt of prompts) {
    const expected = expectationsOfPrompt(prompt);
    if (expected.title || expected.question || expected.claim) return expected;
  }
  return null;
}

/** 从模型输出里取最外层 JSON 对象；取不到返回 null。 */
export function jsonOf(text) {
  const raw = String(text ?? "").replace(FENCE, "").replace(/\s*```\s*$/, "");
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(raw.slice(start, end + 1));
  } catch {
    return null;
  }
}

export function parseTranscription(text) {
  const parsed = jsonOf(text);
  if (!parsed) return { transcription: null, unparsed: true };
  const list = (value) => (Array.isArray(value) ? value.map((item) => String(item ?? "").trim()).filter(Boolean) : []);
  return {
    unparsed: false,
    transcription: {
      title: String(parsed.title ?? "").trim(),
      subtitle: String(parsed.subtitle ?? "").trim(),
      body: list(parsed.body),
      numbers: list(parsed.numbers),
      labels: list(parsed.labels),
      unreadable: list(parsed.unreadable),
    },
  };
}

export function parseBlind(text) {
  const parsed = jsonOf(text);
  if (!parsed) return { blind: null, unparsed: true };
  return {
    unparsed: false,
    blind: {
      what: String(parsed.what ?? "").trim(),
      ask: String(parsed.ask ?? "").trim(),
      confusing: String(parsed.confusing ?? "").trim(),
    },
  };
}

export function parseContrast(text) {
  const parsed = jsonOf(text);
  if (!parsed) return { contrast: null, unparsed: true };
  const verdict = ["一致", "矛盾", "多出"].includes(String(parsed.verdict ?? "").trim())
    ? String(parsed.verdict).trim()
    : "一致";
  const score = (value) => {
    const number = Number(value);
    if (!Number.isFinite(number)) return 4;
    return Math.min(5, Math.max(1, Math.round(number)));
  };
  return {
    unparsed: false,
    contrast: {
      verdict,
      contradiction: String(parsed.contradiction ?? "").trim(),
      extra: Array.isArray(parsed.extra) ? parsed.extra.map((item) => String(item ?? "").trim()).filter(Boolean).slice(0, 8) : [],
      fit: score(parsed.fit),
      continuity: score(parsed.continuity),
      notes: String(parsed.notes ?? "").trim().slice(0, 120),
    },
  };
}

/**
 * 出图 prompt → 图上**应该出现**的文字（C1 的对照基准）。
 *
 * 为什么不用当前 script 当基准：图可能是旧稿出的（script 后来改过），拿新稿比旧图会把
 * 「图是旧的」误判成「图写错了字」。基准取这张图自己的 prompt，再单独查「图是否基于旧稿」。
 */
export function expectationsOfPrompt(promptText = "") {
  const lines = String(promptText ?? "").split("\n");
  // 封面页的 prompt 用的是「主标题 / 副标题」，正文页是「页面标题 / 这页回答 / 主张」，两种都要认。
  const field = (...labels) => {
    for (const label of labels) {
      const line = lines.find((item) => item.trim().startsWith(`${label}：`) || item.trim().startsWith(`${label}:`));
      if (!line) continue;
      const cut = line.indexOf("：") >= 0 ? line.indexOf("：") + 1 : line.indexOf(":") + 1;
      const value = line.slice(cut).trim();
      if (value) return value;
    }
    return "";
  };
  const title = field("页面标题", "主标题", "标题");
  const question = field("这页回答", "副标题");
  const claim = field("主张");
  const quoted = [...String(promptText ?? "").matchAll(/[「“"]([^」”"]{2,60})[」”"]/g)].map((match) => match[1].trim()).filter(Boolean);
  return {
    title,
    question,
    claim,
    body: "",
    quoted,
    numbers: numbersIn([title, question, claim, ...quoted].join("\n")),
  };
}

/** 规范化：去空白 / 全角空格 / 常见引号，用于逐字比对。 */
export function squash(text) {
  return String(text ?? "").replace(/[\s\u3000]+/g, "").replace(/[“”"「」『』'’]/g, "").replace(/[，。、；：！？,.;:!?·—–\-]/g, "");
}

/** 从稿件里抽数字（含小数 / 百分号 / 单位），用于「数字必须逐字对」的硬判据。 */
export function numbersIn(text) {
  const found = String(text ?? "").match(/\d+(?:[.,]\d+)?%?/g) ?? [];
  return [...new Set(found)].slice(0, 20);
}

/** 最长公共子序列长度（字符级），用于正文相似度。 */
export function lcsLength(a, b) {
  const left = [...String(a ?? "")];
  const right = [...String(b ?? "")];
  if (!left.length || !right.length) return 0;
  let previous = new Array(right.length + 1).fill(0);
  for (let i = 1; i <= left.length; i += 1) {
    const current = new Array(right.length + 1).fill(0);
    for (let j = 1; j <= right.length; j += 1) {
      current[j] = left[i - 1] === right[j - 1] ? previous[j - 1] + 1 : Math.max(previous[j], current[j - 1]);
    }
    previous = current;
  }
  return previous[right.length];
}

/**
 * 转写 vs 稿件逐段 diff（C1 第 3 步）。
 * 判据：标题逐字相等；数字 / 术语逐字相等；正文允许 ≤2% 字符差异。
 */
export function diffTranscription({ expected = {}, transcription = {} }) {
  const diffs = [];
  const wantTitle = String(expected.title ?? "").trim();
  const gotTitle = String(transcription.title ?? "").trim();
  if (wantTitle) {
    if (!gotTitle) diffs.push({ type: "missing", field: "title", expected: wantTitle, actual: "" });
    else if (squash(wantTitle) !== squash(gotTitle)) {
      diffs.push({ type: "wrong", field: "title", expected: wantTitle, actual: gotTitle });
    }
  } else if (gotTitle) {
    diffs.push({ type: "extra", field: "title", expected: "", actual: gotTitle });
  }

  const gotAll = squash([transcription.title, transcription.subtitle, ...(transcription.body ?? []), ...(transcription.numbers ?? []), ...(transcription.labels ?? [])].join(""));
  // 这页回答 / 主张：图上通常印成副标题或首段，找不到就算软差异（不判硬失败，但说明「没印出来」）。
  // 但画面要求里引号内的文案是设计师写进画面的替代说法，命中它就不算缺失。
  const quotedHit = (expected.quoted ?? []).some((quote) => {
    const needle = squash(quote).slice(0, 8);
    return needle.length >= 4 && gotAll.includes(needle);
  });
  for (const [field, want] of [["subtitle", expected.question], ["claim", expected.claim]]) {
    const text = String(want ?? "").trim();
    if (text.length < 6) continue;
    const needle = squash(text).slice(0, 24);
    if (needle && !gotAll.includes(needle) && !quotedHit) diffs.push({ type: "missing", field, expected: text.slice(0, 80), actual: "" });
  }
  const wantNumbers = numbersIn([expected.title, expected.question, expected.claim, expected.body].filter(Boolean).join("\n"));
  const gotNumbers = new Set((transcription.numbers ?? []).flatMap((item) => numbersIn(item)));
  const bodySquashed = squash([...((transcription.body ?? []))].join(""));
  for (const number of wantNumbers) {
    if (!gotNumbers.has(number) && !bodySquashed.includes(squash(number)) && !gotAll.includes(squash(number))) {
      diffs.push({ type: "missing", field: "number", expected: number, actual: "" });
    }
  }

  const wantBody = String(expected.body ?? "").trim();
  const gotBody = (transcription.body ?? []).join("");
  if (wantBody) {
    const wanted = squash(wantBody);
    const got = squash(gotBody);
    const same = lcsLength(wanted, got);
    const ratio = wanted.length ? 1 - same / wanted.length : 0;
    if (!got) diffs.push({ type: "missing", field: "body", expected: wantBody.slice(0, 80), actual: "" });
    else if (ratio > 0.02) diffs.push({ type: "wrong", field: "body", expected: wantBody.slice(0, 80), actual: gotBody.slice(0, 80), ratio: Number(ratio.toFixed(3)) });
  }

  // 多出来的正文段落：稿件里查不到、且长度 ≥12 字（排除页码 / 角标这类版面元素）
  const expectedAll = squash([expected.title, expected.question, expected.claim, expected.body].filter(Boolean).join(""));
  for (const paragraph of transcription.body ?? []) {
    const text = String(paragraph ?? "").trim();
    if (text.length < 12) continue;
    if (!expectedAll.includes(squash(text).slice(0, 12))) {
      diffs.push({ type: "extra", field: "body", expected: "", actual: text.slice(0, 80) });
    }
  }
  return diffs;
}

/**
 * 双转写一致性（C1 第 2 步）：两次结果按字段比对。
 * 只对「两次都有内容」的字段判；任一为空也算不稳（模型没读全）。
 */
export function mergeDualTranscription(first = {}, second = {}) {
  const unstable = [];
  const fields = ["title", "subtitle"];
  for (const field of fields) {
    const a = squash(first[field]);
    const b = squash(second[field]);
    if (a !== b) unstable.push(field);
  }
  const bodyA = [...(first.body ?? [])].map(squash).join("|");
  const bodyB = [...(second.body ?? [])].map(squash).join("|");
  if (bodyA !== bodyB) unstable.push("body");
  const numbersA = [...(first.numbers ?? [])].map(squash).sort().join("|");
  const numbersB = [...(second.numbers ?? [])].map(squash).sort().join("|");
  if (numbersA !== numbersB) unstable.push("numbers");
  return { unstable, stable: unstable.length === 0 };
}

/**
 * 保真判定（C1 第 4 步）：标题逐字、数字逐字是硬失败；正文 >2% 差异算失败。
 * 双转写不一致的字段不算自动判定（送人工），但如果差异字段本身就是标题/数字，直接判「不确定」。
 */
export function judgeFidelity({ diffs = [], unstable = [] } = {}) {
  const hard = diffs.filter((diff) => diff.field === "title" || diff.field === "number");
  const soft = diffs.filter((diff) => diff.field === "body" || diff.field === "subtitle" || diff.field === "claim");
  const unreadable = diffs.filter((diff) => diff.field === "unreadable");
  // 双转写任何字段不一致都标「不确定」送人工（不参与自动判定）——C1 第 2 步的硬要求。
  if (unstable.length) {
    return { verdict: "不确定", score: 3, mustHuman: true, blockers: [...hard, ...soft], unstable };
  }
  if (hard.length) return { verdict: "失败", score: 1, mustHuman: false, blockers: hard, unstable };
  if (soft.length) return { verdict: "失败", score: 2, mustHuman: false, blockers: soft, unstable };
  if (unreadable.length) return { verdict: "不确定", score: 3, mustHuman: true, blockers: unreadable, unstable };
  return { verdict: "通过", score: 5, mustHuman: false, blockers: [], unstable };
}

/** 表意判定（C2b）：矛盾 = 扭曲（P0）；多出 = 超载（P1）。 */
export function judgeMeaning(contrast = {}) {
  if (contrast.verdict === "矛盾") return { verdict: "扭曲", severity: "P0", score: 1 };
  if (contrast.verdict === "多出") return { verdict: "超载", severity: "P1", score: 3 };
  return { verdict: "通过", severity: "", score: 5 };
}

/**
 * 五维打分（C4）：保真 / 完整 / 表意 / 贴合 / 承接。
 * 可交付门槛：保真 = 5 且 表意 ≥ 4，其余 ≥ 3；总分只记录不做门禁。
 */
export function composeReviewScore({ fidelity, meaning, complete = 5, fit = 4, continuity = 4 } = {}) {
  const scores = {
    保真: Number(fidelity?.score ?? 1),
    完整: Math.min(5, Math.max(1, Number(complete))),
    表意: Number(meaning?.score ?? 1),
    贴合: Math.min(5, Math.max(1, Number(fit))),
    承接: Math.min(5, Math.max(1, Number(continuity))),
  };
  const total = Object.values(scores).reduce((sum, value) => sum + value, 0);
  const blockers = [];
  if (scores.保真 !== 5) blockers.push(`保真 ${scores.保真}/5（错字 / 错数 / 缺字是硬失败）`);
  if (scores.表意 < 4) blockers.push(`表意 ${scores.表意}/5（没看懂 / 扭曲）`);
  for (const dim of ["完整", "贴合", "承接"]) {
    if (scores[dim] < 3) blockers.push(`${dim} ${scores[dim]}/5（低于 3）`);
  }
  return { scores, total, gate: blockers.length === 0, blockers, mustHuman: Boolean(fidelity?.mustHuman) };
}

/** C5：失败类型 → 先改什么 + 重出范围。 */
export function rebuildAdvice({ fidelity, meaning } = {}) {
  const rows = [];
  if (fidelity?.verdict === "失败") {
    const hasHard = (fidelity.blockers ?? []).some((diff) => diff.field === "title" || diff.field === "number");
    rows.push({
      failure: hasHard ? "保真失败（错字 / 错数）" : "保真失败（正文缺字 / 多字）",
      firstChange: "只改 prompt：强化逐字照排、禁止模型改字或加字",
      scope: "该页",
    });
  }
  if (fidelity?.verdict === "不确定") rows.push({ failure: "转写不确定（两张转写不一致）", firstChange: "人工看一眼原图，或再转写一次", scope: "该页（人工）" });
  if (meaning?.verdict === "扭曲") rows.push({ failure: "表意扭曲（说了别的 / 说反了）", firstChange: "先改 script 的主张或画面要求，再出图", scope: "该页" });
  if (meaning?.verdict === "超载") rows.push({ failure: "超载（图里多出信息）", firstChange: "删 script 里多余的要求", scope: "该页" });
  return rows;
}

/** 每页结果汇总成 review.images.md。 */
export function renderImageReviewMarkdown({ deckTitle = "", generatedAt = "", rows = [] } = {}) {
  const lines = [
    `# 图片评审 · ${deckTitle || "（未命名 deck）"}`,
    "",
    `生成时间：${generatedAt || "（未记录）"}；视觉模型只做转写，判定由程序做；不引入 OCR。`,
    "",
    "| 页 | 保真 | 完整 | 表意 | 贴合 | 承接 | 门禁 | 结论 |",
    "|---|---|---|---|---|---|---|---|",
  ];
  for (const row of rows) {
    const score = row.scores ?? {};
    const verdict = row.gate ? "可交付" : row.mustHuman ? "转人工" : (row.blockers ?? []).join("；") || "需重出";
    lines.push(
      `| ${row.page} | ${score.保真 ?? "-"} | ${score.完整 ?? "-"} | ${score.表意 ?? "-"} | ${score.贴合 ?? "-"} | ${score.承接 ?? "-"} | ${row.gate ? "过" : "不过"} | ${String(verdict).slice(0, 80)} |`,
    );
  }
  lines.push("");
  lines.push("门槛：保真 = 5 且 表意 ≥ 4，其余 ≥ 3；同一页 3 次不过转人工（C5）。");
  return `${lines.join("\n")}\n`;
}

/**
 * 完整一页评审（C1 + C2 + C3 + C4）：两次转写 → diff → 盲述 → 对照 → 五维打分。
 * 纯编排，不落盘（落盘在 tools.js）；verify 脚本与工具共用这一条路径。
 */
export async function runImageReview({
  imagePath,
  pageId,
  expected = {},
  pageText = "",
  intentText = "",
  styleAnchor = "",
  prevPageText = "",
  visualBrief = "",
  cover = false,
  settings = {},
  skipBlind = false,
  fetchImpl = fetch,
}) {
  const call = async (prompt, maxTokens) => {
    const result = await askVisionModel({
      imagePath,
      prompt,
      baseURL: settings.baseURL,
      apiKey: settings.apiKey,
      model: settings.model,
      maxTokens: maxTokens ?? settings.maxTokens,
      timeoutMs: settings.timeoutMs,
      fetchImpl,
    });
    return result.content;
  };
  const transcribeOnce = async () => {
    let parsed = parseTranscription(await call(transcribePrompt({ page: pageId }), settings.maxTokens));
    if (parsed.unparsed) parsed = parseTranscription(await call(transcribePrompt({ page: pageId }), Math.round((settings.maxTokens ?? 3000) * 1.5)));
    if (parsed.unparsed) throw new Error("转写两次都没返回约定 JSON，无法评审（不要猜；重试或换视觉模型）");
    return parsed.transcription;
  };
  // 双转写：同一张图、同一 prompt、两次独立调用（固定温度由服务端默认；不一致就标「不确定」）
  const [first, second] = await Promise.all([transcribeOnce(), transcribeOnce()]);
  const dual = mergeDualTranscription(first, second);
  const diffs = diffTranscription({ expected, transcription: first });
  const fidelity = judgeFidelity({ diffs, unstable: dual.unstable });

  let blind = null;
  let blindError = "";
  if (!skipBlind) {
    try {
      const parsed = parseBlind(await call(blindPrompt({ page: pageId }), Math.min(1200, settings.maxTokens ?? 3000)));
      if (parsed.unparsed) blindError = "盲述没有返回约定 JSON";
      else blind = parsed.blind;
    } catch (error) {
      blindError = String(error?.message ?? error);
    }
  }

  const contrastParsed = parseContrast(
    await call(
      contrastPrompt({ page: pageId, pageText, intent: intentText, styleAnchor, prevPage: prevPageText, visualBrief, cover }),
      Math.min(2000, settings.maxTokens ?? 3000),
    ),
  );
  if (contrastParsed.unparsed) throw new Error("对照评审没有返回约定 JSON（不要猜结论；重试）");
  const contrast = normalizeContrastForPage(contrastParsed.contrast, { cover });
  const meaning = judgeMeaning(contrast);
  const review = composeReviewScore({ fidelity, meaning, fit: contrast.fit, continuity: contrast.continuity });
  const advice = rebuildAdvice({ fidelity, meaning });
  return { transcription: first, second, dual, diffs, fidelity, blind, blindError, contrast, meaning, review, advice };
}

/** 最近一次评审记录（按页）→ 用于累计重出次数与 3 次阈值。 */
export function attemptsOf(qa = {}) {
  const attempts = Number(qa?.review?.attempts ?? qa?.review?.attempt ?? 0);
  return Number.isFinite(attempts) && attempts > 0 ? Math.floor(attempts) : 0;
}

/** 一次视觉调用（OpenAI 兼容 chat/completions，image_url 传 base64；不用 OCR）。 */
export async function askVisionModel({ imagePath, prompt, baseURL, apiKey, model, maxTokens = 3000, timeoutMs = 180_000, fetchImpl = fetch }) {
  if (!baseURL) throw new Error("视觉评审没有配置 baseURL：在 profile 的 deckStudio.imageReview 里设 baseURL，或设 env DSH_DECK_VISION_BASE_URL");
  if (!model) throw new Error("视觉评审没有配置 model：在 profile 的 deckStudio.imageReview 里设 model，或设 env DSH_DECK_VISION_MODEL");
  if (!apiKey) throw new Error("视觉评审没有 API key：设 imageReview.apiKeyEnv 指向的环境变量（默认 WOCHENG_API_KEY）");
  const bytes = readFileSync(imagePath);
  const ext = extname(imagePath).toLowerCase();
  const mediaType = ext === ".jpg" || ext === ".jpeg" ? "image/jpeg" : ext === ".webp" ? "image/webp" : "image/png";
  const body = {
    model,
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: prompt },
          { type: "image_url", image_url: { url: `data:${mediaType};base64,${bytes.toString("base64")}` } },
        ],
      },
    ],
    max_tokens: maxTokens,
  };
  const response = await fetchImpl(`${String(baseURL).replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`视觉调用失败 ${response.status}：${text.slice(0, 300)}`);
  const payload = JSON.parse(text);
  const content = payload.choices?.[0]?.message?.content;
  const finish = payload.choices?.[0]?.finish_reason ?? "?";
  if (typeof content !== "string" || !content.trim()) {
    throw new Error(`视觉调用返回没有正文（finish_reason=${finish}）——多半是思考 token 用光，调大 maxTokens 重试`);
  }
  return { content, finish, usage: payload.usage ?? null };
}
