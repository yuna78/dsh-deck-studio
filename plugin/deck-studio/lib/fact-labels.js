/**
 * 事实标注（智力升级 A2 / F-182）：正文里的数字，要么挂「事实 ID」（调研台账里的条目），
 * 要么显式标「示意数据」——不能既没出处、又没说「这是我编的数」。
 *
 * 判据是确定性的（不花模型、不阻断出图）：
 * 1. 从这页的 body + claim 里抽数字（排除年份、页号这类不承载事实的编号）；
 * 2. 看这页的「证据」字段（I-06 契约里的第 5 项）写了什么：
 *    - 事实 ID（`F-01` / `#3` / 「调研台账 C02」/「访谈 12 人」…）→ 有来源；
 *    - 「示意数据 / 示意」→ 明确标了是示意；
 *    - 「无需」或空 → 有数字却没来源 → 提示（不阻断）。
 * 3. 提示只指出「哪页哪个数没来源」，不替用户改稿。
 */

// 数字 + 可选单位：42 / 3–5 分钟 / 30% / 1.5 倍 / 1200 万。
const NUMBER_RE = /(\d+(?:\.\d+)?(?:\s*[–\-~—至]\s*\d+(?:\.\d+)?)?)\s*(%|％|万|亿|倍|分钟|小时|天|个月|月|年|人|页|个|条|次|元|块|秒)?/g;
// 不承载事实的编号：年份、日期、页号、版本号、编号 ID 里的数字由字段自己管。
const IGNORE_IF_YEAR = /^(19|20)\d{2}$/;
const CITATION_RE = /(事实|台账|调研|访谈|问卷|报告|数据|统计|来源|出处|F-?\d+|#\s?\d+|C\d{2}|P\d{2})/i;
const SCHEMATIC_RE = /示意/;

/** 抽正文里的数字（去重、保序），返回 [{raw, unit, context}]。 */
export function extractFacts(text = "") {
  const source = String(text ?? "");
  const found = [];
  const seen = new Set();
  for (const match of source.matchAll(NUMBER_RE)) {
    const raw = match[1].replace(/\s+/g, "");
    const unit = match[2] ?? "";
    if (IGNORE_IF_YEAR.test(raw)) continue;
    // 编号不是事实：v001 / F-03 / C02 / P05 / 2026-10-25 里的数字不算「正文数字」。
    const before = source.slice(Math.max(0, (match.index ?? 0) - 1), match.index ?? 0);
    if (/[A-Za-z0-9_#\-.]/.test(before)) continue;
    const key = `${raw}${unit}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const index = match.index ?? 0;
    found.push({ raw, unit, context: source.slice(Math.max(0, index - 12), index + raw.length + unit.length + 12).replace(/\s+/g, " ").trim() });
  }
  return found;
}

/**
 * 单页事实标注体检。
 * @param {{page:number, body?:string, claim?:string, evidence?:string}} input
 * @returns {{page:number, numbers:string[], status:"no-numbers"|"cited"|"schematic"|"unannotated", hint:string}}
 */
export function checkFactLabels({ page = 0, body = "", claim = "", evidence = "" } = {}) {
  const facts = extractFacts([claim, body].filter(Boolean).join("\n"));
  const numbers = facts.map((fact) => `${fact.raw}${fact.unit}`);
  if (!numbers.length) return { page, numbers, status: "no-numbers", hint: "" };
  const evidenceText = String(evidence ?? "").trim();
  if (SCHEMATIC_RE.test(evidenceText)) return { page, numbers, status: "schematic", hint: "" };
  if (evidenceText && CITATION_RE.test(evidenceText)) return { page, numbers, status: "cited", hint: "" };
  const shown = numbers.slice(0, 4).join(" / ") + (numbers.length > 4 ? " …" : "");
  const hint = evidenceText
    ? `P${String(page).padStart(2, "0")} 正文有数字（${shown}），但「证据」写的是「${evidenceText.slice(0, 20)}」——数字要么挂事实 ID（调研台账里的条目），要么写「示意数据」。`
    : `P${String(page).padStart(2, "0")} 正文有数字（${shown}）却没写来源——在「证据」字段写事实 ID（调研台账里的条目），或写「示意数据」标明这是示意。`;
  return { page, numbers, status: "unannotated", hint };
}

/**
 * 整本事实标注汇总。
 * @param {{page:number, body?:string, claim?:string, evidence?:string}[]} pages
 */
export function analyzeFactLabels(pages = []) {
  const perPage = (Array.isArray(pages) ? pages : []).map((page) => checkFactLabels(page)).sort((left, right) => left.page - right.page);
  const unannotated = perPage.filter((item) => item.status === "unannotated");
  return {
    perPage,
    unannotated,
    withNumbers: perPage.filter((item) => item.numbers.length > 0).length,
  };
}

/** 一行摘要（没有问题时返回空串）。 */
export function factSummaryLine(analysis) {
  if (!analysis?.unannotated?.length) return "";
  const pages = analysis.unannotated.slice(0, 5).map((item) => `P${String(item.page).padStart(2, "0")}（${item.numbers.slice(0, 2).join(" / ")}）`).join("；");
  const more = analysis.unannotated.length > 5 ? ` …等 ${analysis.unannotated.length} 页` : "";
  return `事实标注：${analysis.unannotated.length} 页正文有数字但没挂来源：${pages}${more}——在「证据」字段写事实 ID（见调研台账）或「示意数据」；不阻断出图，但别让用户以为数字有出处。`;
}
