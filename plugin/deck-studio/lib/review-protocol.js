/**
 * F-172 · 审稿协议：盲审 → 冻结 → 对照（两段式），以「先盲后对照」替代「一上来就给意图」。
 *
 * 为什么两段：审稿人一旦知道作者想表达什么，就会自动补全读者没接住的部分——
 * 它评的是「你想说的」，不是「你写出来的」。所以第一段只给身份 + 稿件，四问逐页作答，
 * 结论落盘冻结；第二段才揭示意图，做 X/S/Y 三方差分。
 *
 * 本模块无 IO（不读不写文件）：prompt 与解析纯函数，snapshot 哈希可测。
 * 冻结文件与报告落盘由 tools.js 负责。
 * @module dsh-plugin-deck-studio/review-protocol
 */

import { createHash } from "node:crypto";

/** 每页必答的四问（覆盖矩阵的列）。 */
export const BLIND_QUESTIONS = [
  { id: "restate", label: "复述", ask: "只读这一页，用一句话说出它想让我记住什么。" },
  { id: "relation", label: "承接", ask: "这一页和上一页是什么关系？（并列 / 递进 / 因果 / 转折 / 无关系 / 首次立题）" },
  { id: "doubt", label: "追问", ask: "哪一句你信不过、想追问，或者觉得是空话？（原文引用；没有就写「无」）" },
  { id: "next_action", label: "动作", ask: "读完这一页，你知道下一步该做什么吗？（知道就写出来；不知道写「不知道」）" },
];

/** 冻结文件名（deck docs 下）；报告沿用 F-159 的 review.experts.md，工作台不用改。 */
export const BLIND_FREEZE_FILE = "review.blind.json";
export const REVIEW_REPORT_FILE = "review.experts.md";

/** 盲审阶段允许发给审稿人的信息（这里显式列出来，方便测试与审计）。 */
export const BLIND_ALLOWED_FIELDS = ["audience", "deckTitle", "pages"];
/** 盲审阶段禁止出现的内容（意图/规则/骨架这些会替作者圆场）。 */
export const BLIND_FORBIDDEN_FIELDS = ["takeaway", "success", "scopeOut", "topic", "rulesText", "skeleton"];

const RELATIONS = new Set(["并列", "递进", "因果", "转折", "无关系", "首次立题"]);
const VERDICTS = new Set(["是", "部分", "否"]);

/** 从 script 里取页号（`### P01 · 标题`），去重保序。 */
export function pageIdsFromScript(script) {
  const ids = [];
  const seen = new Set();
  for (const match of String(script ?? "").matchAll(/^###\s+(P\d+)\b/gm)) {
    if (seen.has(match[1])) continue;
    seen.add(match[1]);
    ids.push(match[1]);
  }
  return ids;
}

/**
 * 稿子快照哈希：空白归一后取 sha256。
 * 冻结只对当轮快照有效——稿子变了，旧盲审结论自动失效（防止「拿旧结论评新稿」）。
 */
export function scriptSnapshotHash(script) {
  const normalized = String(script ?? "").replace(/\r\n/g, "\n").replace(/[ \t]+$/gm, "").replace(/\n{3,}/g, "\n\n").trim();
  return createHash("sha256").update(normalized, "utf8").digest("hex").slice(0, 32);
}

function clip(text, maxChars) {
  const value = String(text ?? "");
  return value.length > maxChars ? `${value.slice(0, maxChars)}\n\n（过长，以上为前 ${maxChars} 字符）` : value;
}

/** 盲审 prompt：只给身份与稿件，四问逐页作答。故意不含意图四件套。 */
export function blindReviewerPrompt({ reviewer, brief, deckTitle, script, maxScriptChars = 60_000 }) {
  const questions = BLIND_QUESTIONS.map((item, index) => `${index + 1}. ${item.label}：${item.ask}`).join("\n");
  return [
    `你是这份分享的听众：${reviewer.label}`,
    reviewer.focus,
    "",
    deckTitle ? `## 分享标题\n${deckTitle}` : "",
    "## 你手上的材料",
    "只有下面这份页面内容（页号 / 标题 / 这页回答什么 / 主张 / 正文）。",
    "你不会看到作者的意图、成功标准、规则或任何解释——就像你只是坐进了听众席。",
    "",
    "## 页面内容",
    clip(script, maxScriptChars),
    "",
    "## 你的任务（每一页都要答，一页都不能跳）",
    questions,
    "",
    "整本再答一问：读完全部，你以为作者想让你做什么？用一句话说，不要参考标题。",
    "",
    "## 输出契约",
    "只输出一个 JSON 对象，不要围栏外的解释：",
    "{",
    '  "reviewer": "你的身份（一句话）",',
    '  "per_page": [',
    '    {"page": "P01", "restate": "一句话", "relation": "首次立题", "doubt": "原文引用或「无」", "next_action": "知道：… / 不知道"}',
    "  ],",
    '  "whole": "你以为作者想让你做什么"',
    "}",
    "规则：",
    `- per_page 必须覆盖上面出现的每一页（共 ${pageIdsFromScript(script).length} 页），顺序与稿件一致；`,
    "- 每个字段都只写一句话：restate ≤40 字、doubt ≤40 字、next_action ≤20 字、whole ≤40 字；不要写在 JSON 之外的解释；",
    "- 只写你作为听众的真实反应；不确定就写「不确定」，不要替作者补全；",
    "- 不给建议、不打分、不写通用写作建议；不提任何工具或文件。",
  ]
    .filter((line) => line !== "")
    .join("\n");
}

/** 对照 prompt：冻结的盲审结论 + 稿件原文 + 作者意图，做三方差分（X 读者读出 / S 稿子写的 / Y 意图要的）。
 * 必须带稿件原文：证据要逐字引用，只给盲审结论会让模型拿自己的复述当证据，被校验拒绝。 */
export function contrastReviewerPrompt({ reviewer, blind, brief, deckTitle, script = "", maxScriptChars = 60_000 }) {
  const intentLines = [
    brief?.topic ? `主题：${brief.topic}` : "",
    brief?.audience ? `听众：${brief.audience}` : "",
    brief?.takeaway ? `听完要带走：${brief.takeaway}` : "",
    brief?.success ? `怎么算讲成功：${brief.success}` : "",
    brief?.scopeOut ? `不讲的：${brief.scopeOut}` : "",
  ].filter(Boolean);
  return [
    `你是这份分享的听众：${reviewer.label}（同一个身份，第二轮）`,
    "",
    "## 你上一轮看完之后的真实反应（已冻结，不许改）",
    "这是你在不知道作者意图的情况下写下的结论：",
    "```json",
    JSON.stringify(blind, null, 2).slice(0, 40_000),
    "```",
    "",
    "## 现在可以看的：作者写的意图",
    intentLines.join("\n") || "（intent 未提供）",
    "",
    "## 稿件原文（引用证据只能从这里逐字摘）",
    clip(script, maxScriptChars),
    "",
    deckTitle ? `## 分享标题\n${deckTitle}` : "",
    "",
    "## 你的任务",
    "拿你上一轮的读出，跟作者意图逐页对照，标出差异属于哪一类：",
    "- X ≠ S：你读出的（X）和稿子上写的（S）不一样——表达没到位；",
    "- S ≠ Y：稿子写的（S）和作者意图（Y）不一样——内容偏了；",
    "- X = Y ≠ S：你读出了意图，但稿子绕了——该删减；",
    "- X = S = Y：达标。",
    "另外两问：整本上你读出的和意图差在哪；哪几页可以删或合并。",
    "",
    "## 输出契约",
    "只输出一个 JSON 对象：",
    "{",
    '  "reviewer": "你的身份（一句话）",',
    '  "gaps": [',
    '    {"page": "P01", "x": "你读出的", "y": "意图要的", "verdict": "是 | 部分 | 否", "evidence": "稿件原文片段", "fix": "具体怎么改（可直接落版的句子）"}',
    "  ],",
    '  "deck_gap": "整本读出的和意图差在哪（一句话）",',
    '  "delete_candidates": ["P0X（为什么可删）"]',
    "}",
    "规则：",
    "- 每页一条 gap；没有差异就写 verdict=是，x 与 y 写同一句；",
    "- 每个字段只写一句话：x / y ≤40 字、evidence ≤60 字（逐字摘）、fix ≤60 字；不要写在 JSON 之外的解释；",
    "- evidence 必须从上面「稿件原文」里逐字摘一句，不要用自己的复述、不要编；没找到可引的句子就不写 evidence；",
    "- 不改稿、不调用工具；只输出这份 JSON。",
  ]
    .filter((line) => line !== "")
    .join("\n");
}

function jsonCandidate(text) {
  const raw = String(text ?? "").trim();
  if (!raw) return null;
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  for (const candidate of [fenced?.[1], raw].filter(Boolean)) {
    const start = candidate.indexOf("{");
    const end = candidate.lastIndexOf("}");
    if (start < 0 || end <= start) continue;
    try {
      const parsed = JSON.parse(candidate.slice(start, end + 1));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
    } catch {
      /* 试下一个候选 */
    }
  }
  return null;
}

/** 解析盲审输出；形状不合契约就标 unparsed（不静默丢，交给上层如实报告）。 */
export function parseBlindOutput(text) {
  const parsed = jsonCandidate(text);
  if (!parsed) return { blind: null, unparsed: true, raw: String(text ?? "") };
  const reviewer = String(parsed.reviewer ?? "").trim();
  const whole = String(parsed.whole ?? "").trim();
  const rows = Array.isArray(parsed.per_page) ? parsed.per_page : null;
  if (!reviewer || !whole || !rows || rows.length > 200) {
    return { blind: null, unparsed: true, raw: String(text ?? "") };
  }
  const perPage = [];
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const page = String(row.page ?? "").trim();
    if (!/^P\d+$/.test(page)) continue;
    perPage.push({
      page,
      restate: String(row.restate ?? "").trim(),
      relation: RELATIONS.has(String(row.relation ?? "").trim()) ? String(row.relation).trim() : "其他",
      doubt: String(row.doubt ?? "").trim() || "无",
      next_action: String(row.next_action ?? "").trim() || "不知道",
    });
  }
  if (!perPage.length) return { blind: null, unparsed: true, raw: String(text ?? "") };
  return {
    blind: { reviewer, whole, per_page: perPage },
    unparsed: false,
    raw: String(text ?? ""),
  };
}

/** 覆盖矩阵：expected 是稿件页号，answered 是审稿人真答了的页。 */
export function checkCoverage(perPage, expectedPages) {
  const answered = new Set((perPage ?? []).map((row) => row.page));
  const expected = expectedPages ?? [];
  const missing = expected.filter((page) => !answered.has(page));
  const extra = [...answered].filter((page) => !expected.includes(page));
  return { expected: expected.length, answered: answered.size, missing, extra, complete: missing.length === 0 && extra.length === 0 };
}

/** 解析对照输出。 */
export function parseContrastOutput(text) {
  const parsed = jsonCandidate(text);
  if (!parsed) return { contrast: null, unparsed: true, raw: String(text ?? "") };
  const reviewer = String(parsed.reviewer ?? "").trim();
  const rows = Array.isArray(parsed.gaps) ? parsed.gaps : null;
  if (!reviewer || !rows) return { contrast: null, unparsed: true, raw: String(text ?? "") };
  const gaps = [];
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const page = String(row.page ?? "").trim();
    if (!/^P\d+$/.test(page)) continue;
    const verdictRaw = String(row.verdict ?? "").trim();
    gaps.push({
      page,
      x: String(row.x ?? "").trim(),
      y: String(row.y ?? "").trim(),
      verdict: VERDICTS.has(verdictRaw) ? verdictRaw : "部分",
      evidence: String(row.evidence ?? "").trim(),
      fix: String(row.fix ?? "").trim(),
    });
  }
  if (!gaps.length) return { contrast: null, unparsed: true, raw: String(text ?? "") };
  const deleteCandidates = Array.isArray(parsed.delete_candidates)
    ? parsed.delete_candidates.map((item) => String(item ?? "").trim()).filter(Boolean).slice(0, 10)
    : [];
  return {
    contrast: {
      reviewer,
      gaps,
      deck_gap: String(parsed.deck_gap ?? "").trim(),
      delete_candidates: deleteCandidates,
    },
    unparsed: false,
    raw: String(text ?? ""),
  };
}

/** 多审稿人盲审合并：同页多条复述并列保留（不同听众读出不同意思本身就是信号）。 */
export function mergeBlind(blinds = []) {
  const byPage = new Map();
  for (const item of blinds) {
    const from = item.label || item.blind?.reviewer || "";
    for (const row of item.blind?.per_page ?? []) {
      if (!byPage.has(row.page)) byPage.set(row.page, { page: row.page, answers: [] });
      byPage.get(row.page).answers.push({ from, ...row });
    }
  }
  return [...byPage.values()].sort((a, b) => a.page.localeCompare(b.page));
}

/**
 * 证据是否真的来自稿件：先抹掉空白与引号差异再比。
 * 模型常把跨行/全角空格/引号换成自己习惯的写法，直接 includes 会把真证据判成编的。
 */
export function scriptContainsEvidence(script, evidence) {
  const squash = (text) => String(text ?? "").replace(/[\s\u3000]+/g, "").replace(/[“”"「」『』']/g, "");
  const needle = squash(evidence);
  if (!needle) return false;
  return squash(script).includes(needle);
}

/**
 * 评审意见 → 可采纳清单（F-176 / 智力升级 I-18，同时是 B6 假证据治理的 G1）。
 *
 * 每条意见给一个稳定编号（R01…），并当场做 G1「逐字匹配」：
 * 证据在稿件里找得到（规范化空白 / 引号后仍是子串）→ A 类可进提案；找不到 → C 类，
 * 只进 dropped[]（界面显示「无法核实」），绝不允许照着它改稿。B / D 类要等 G3 引用核查的模型判定，这里先不产生。
 */
export function buildFindings(script, gaps = []) {
  const findings = [];
  const dropped = [];
  const seen = new Set();
  for (const gap of gaps) {
    if (gap.verdict === "是") continue;
    const page = String(gap.page ?? "").trim();
    if (!page) continue;
    const evidence = String(gap.evidence ?? "").trim();
    const key = `${page}::${evidence.replace(/\s+/g, "")}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const verbatim = evidence.length >= 8 && scriptContainsEvidence(script, evidence);
    const finding = {
      id: `R${String(findings.length + dropped.length + 1).padStart(2, "0")}`,
      page,
      verdict: gap.verdict,
      severity: gap.verdict === "否" ? "P0" : "P1",
      // 三方差分里 X≠S 是表达问题、S≠Y 是内容问题、X=Y≠S 是删减——一次只改一类。
      category: gap.x && gap.y ? (gap.x === gap.y ? "表达" : "内容") : gap.y ? "内容" : "表达",
      evidence,
      fix: String(gap.fix ?? "").trim(),
      reviewer: String(gap.reviewer ?? ""),
      confidence: verbatim ? "A" : "C",
      verbatim,
    };
    if (verbatim) findings.push(finding);
    else dropped.push(finding);
  }
  return { findings, dropped };
}

/** 对照意见 → 统一 issues（沿用 F-159 的严重度口径，工作台不需要改）。 */
export function gapsToIssues(gaps = []) {
  const issues = [];
  for (const gap of gaps) {
    if (gap.verdict === "是") continue;
    issues.push({
      page: gap.page,
      severity: gap.verdict === "否" ? "P0" : "P1",
      problem: `读者读出「${gap.x || "（空）"}」，意图要「${gap.y || "（空）"}」`,
      evidence: gap.evidence,
      suggestion: gap.fix,
      reviewer: gap.reviewer ?? "",
      from: gap.from ?? gap.reviewer ?? "",
    });
  }
  return issues;
}

/** 冻结记录：哈希 + 页 + 审稿人 + 覆盖情况 + 四问定义，一次写死。 */
export function makeFreezeRecord({ deckId, scriptHash, pages, reviewers, generatedAt }) {
  return {
    schemaVersion: 1,
    deckId,
    scriptHash,
    generatedAt,
    questions: BLIND_QUESTIONS.map((item) => item.id),
    pages,
    reviewers,
  };
}

/** 冻结校验：稿子哈希必须与冻结时一致，否则旧盲审结论不能用于新稿。 */
export function verifyFreeze(freeze, currentHash) {
  if (!freeze || typeof freeze !== "object") return { ok: false, reason: "没有可用的盲审冻结记录" };
  if (!freeze.scriptHash) return { ok: false, reason: "盲审冻结记录缺少稿子哈希" };
  if (freeze.scriptHash !== currentHash) {
    return { ok: false, reason: "稿件在盲审之后被改过，旧盲审结论已失效——请重跑盲审再对照" };
  }
  return { ok: true, reason: "" };
}

const cell = (value, max = 220) => String(value ?? "").replace(/\|/g, "\\|").replace(/\n+/g, " ").slice(0, max);

/** 写进 review.experts.md 的报告：冻结的盲审 → 覆盖矩阵 → 三方差分 → 结论。 */
export function renderProtocolMarkdown({ deckTitle, generatedAt, scriptHash, reviewers, mergedBlind, coverage, gaps, deckGap, deleteCandidates, failed = [] }) {
  const byVerdict = { 是: 0, 部分: 0, 否: 0 };
  for (const gap of gaps) byVerdict[gap.verdict] = (byVerdict[gap.verdict] ?? 0) + 1;
  const blindRows = mergedBlind.length
    ? mergedBlind
        .map((row) => {
          const first = row.answers[0] ?? {};
          return `| ${row.page} | ${cell(first.restate)} | ${cell(first.relation, 20)} | ${cell(first.doubt, 160)} | ${cell(first.next_action, 80)} |`;
        })
        .join("\n")
    : "| — | — | — | — | — |";
  const gapRows = gaps.length
    ? gaps
        .map(
          (gap) =>
            `| ${gap.verdict} | ${gap.page} | ${cell(gap.x, 140)} | ${cell(gap.y, 140)} | ${cell(gap.evidence, 120)} | ${cell(gap.fix, 200)} |`,
        )
        .join("\n")
    : "| — | — | — | — | — | — |";
  return [
    "---",
    `title: ${deckTitle ?? ""} · 听众评审`,
    "status: draft",
    "---",
    "",
    "# 听众评审（盲审 → 对照）",
    "",
    `> 生成时间：${generatedAt} · 稿件哈希：\`${scriptHash}\``,
    "> 只审不改：评审不直接改 script；改稿仍走提案 + 用户确认。",
    "",
    "## 评审人（按 intent 听众生成）",
    reviewers.length ? reviewers.map((reviewer) => `- ${reviewer.label}`).join("\n") : "- （无）",
    ...(failed.length ? ["", `失效评审：${failed.map((item) => item.label).join(" / ")}`] : []),
    "",
    "## 第一轮：盲审（不知道意图）",
    "",
    `覆盖：${coverage.answered}/${coverage.expected} 页${(coverage.missing ?? []).length ? `；**缺答：${coverage.missing.join("、")}**` : ""}${(coverage.extra ?? []).length ? `；多答：${coverage.extra.join("、")}` : ""}`,
    "",
    "| 页 | 复述（这页想让人记住什么） | 承接 | 追问 | 下一步动作 |",
    "|---|---|---|---|---|",
    blindRows,
    "",
    "## 第二轮：对照（揭示意图后的差异）",
    "",
    `是 ${byVerdict.是} · 部分 ${byVerdict.部分} · 否 ${byVerdict.否}`,
    ...(deckGap ? ["", `整本差异：${deckGap}`] : []),
    "",
    "| 判定 | 页 | 读者读出 X | 意图要的 Y | 原文证据 | 改法 |",
    "|---|---|---|---|---|---|",
    gapRows,
    "",
    ...(deleteCandidates?.length ? ["## 可删 / 可合并", "", ...deleteCandidates.map((item) => `- ${item}`), ""] : []),
  ].join("\n");
}
