/**
 * 听众评审的「人话版」报告（F-186）。
 *
 * 背景：`review.experts.md` 是工程口径（覆盖矩阵 / 判定表 / 证据 / P0-P1），负责人和听众都读不进去。
 * 这里**不产生新判断**，只把已有的盲审 + 对照结果翻译成两本人能读的文档：
 *
 * - `docs/review.readers.md`：听众视角——读完记住什么、连贯吗、结构清楚吗、哪里不信、还想知道什么；
 * - `docs/review.gap.md`：负责人视角——意图要什么 vs 听众读到什么、差距、先改哪三页、哪几件要拍板。
 *
 * 纪律：读者文档里不出现 P0/P1、置信度 A/B/C、交叉确认这类内部词——这些留在 gap 文档的「附：内部口径」。
 * 所有句子都由输入模板拼出来（不调模型），所以同一份评审结果每次渲染一致、可复算。
 *
 * @module dsh-plugin-deck-studio/review-readers
 */

const s = (value) => String(value ?? "").trim();
/** 引号内再套句号会变成「…。」。」，渲染前先削掉末尾标点。 */
const trimTail = (value) => s(value).replace(/[。；;，,、\s]+$/u, "");
const firstSentence = (text, limit = 40) => {
  const clean = s(text).replace(/\s+/g, " ");
  if (!clean) return "";
  const cut = clean.match(/^.*?[。！？!?;；]/);
  const body = cut ? cut[0] : clean;
  return body.length > limit ? `${body.slice(0, limit)}…` : body;
};

const severityRank = { 否: 0, 部分: 1, 是: 2 };

/** 分数可能是 number 或 {mean, n}（合并后的四维分）——渲染时统一取均值。 */
const meanOf = (value) => {
  if (typeof value === "number") return Number.isInteger(value) ? value : Number(value.toFixed(2));
  if (value && typeof value === "object" && typeof value.mean === "number") {
    return Number.isInteger(value.mean) ? value.mean : Number(value.mean.toFixed(2));
  }
  return "—";
};

/** 两位听众常问同一件事：按前 20 字归一化后去重，避免「还想知道」念两遍。 */
const dedupeBySimilarity = (items = [], limit = 3) => {
  const seen = [];
  const out = [];
  for (const raw of items) {
    const text = s(raw);
    if (!text) continue;
    const key = text.replace(/[\s\u3000「」『』“”"'，。；！？、—…]/g, "").slice(0, 20);
    if (seen.some((item) => item === key || item.startsWith(key) || key.startsWith(item))) continue;
    seen.push(key);
    out.push(text);
    if (out.length >= limit) break;
  }
  return out;
};

/** 整本一句话：听众记住了什么（用第一页的复述 + 全本读者自述）。 */
export function readerHeadline({ gaps = [], mergedBlind = [], deckGap = "" } = {}) {
  const pages = new Map(mergedBlind.map((row) => [row.page, row.answers?.[0] ?? {}]));
  const firstPage = [...pages.keys()].sort((a, b) => a.localeCompare(b))[0];
  const remembered = firstSentence(pages.get(firstPage)?.restate ?? "", 60);
  const failed = gaps.filter((gap) => gap.verdict !== "是");
  const halfPages = failed.filter((gap) => gap.verdict === "部分").length;
  const missed = failed.filter((gap) => gap.verdict === "否").length;
  const worst = [...failed].sort((a, b) => (severityRank[a.verdict] ?? 3) - (severityRank[b.verdict] ?? 3))[0];
  const whole = firstSentence(deckGap, 80);
  const parts = [];
  if (remembered) parts.push(`听众读完记住的是「${trimTail(remembered)}」`);
  if (failed.length) {
    const detail = [halfPages ? `${halfPages} 页只接住一半` : "", missed ? `${missed} 页没接住` : ""].filter(Boolean).join("、");
    parts.push(`${gaps.length} 页里，${detail}${worst ? `，最要紧的是第 ${worst.page.replace(/^P0*/, "")} 页` : ""}`);
  } else if (gaps.length) {
    parts.push("每页都被接住了");
  }
  if (whole) parts.push(`听众自己的总结是：「${whole}」`);
  return `${parts.join("；")}。`;
}

/** 听众读后感的五问五答（全部来自盲审 + 对照，不新增判断）。 */
export function readerImpression({ gaps = [], mergedBlind = [], deckGap = "" } = {}) {
  const answers = mergedBlind.flatMap((row) => (row.answers ?? []).map((answer) => ({ ...answer, from: answer.from ?? "" })));
  const pages = mergedBlind.map((row) => row.page);
  const relations = new Map();
  for (const row of mergedBlind) {
    for (const answer of row.answers ?? []) {
      if (!relations.has(row.page)) relations.set(row.page, answer.relation);
    }
  }
  const relationChain = pages.map((page) => relations.get(page)).filter(Boolean);
  const broken = [...relations.entries()].filter(([, relation]) => /无|没有|说不清|不知道|断/.test(s(relation))).map(([page]) => page);
  const doubts = [...new Set(answers.map((answer) => firstSentence(answer.doubt, 60)).filter(Boolean))].slice(0, 3);
  const knownPages = mergedBlind.filter((row) => (row.answers ?? []).some((answer) => /知道|清楚/.test(s(answer.next_action)))).length;
  const conflicts = gaps.filter((gap) => gap.verdict === "否");
  const halfPages = gaps.filter((gap) => gap.verdict === "部分");

  const learned = firstSentence([...new Set(answers.map((answer) => firstSentence(answer.restate, 50)).filter(Boolean))].join("；"), 120)
    || "（听众没有留下复述，可能这页太抽象或太密）";
  const coherence = broken.length
    ? `第 ${broken.join(" / ").replace(/P0*/g, "")} 页和上一页的接不上：听众说不出这页和前面是什么关系。`
    : relationChain.length
      ? `页与页之间接得上（承接：${relationChain.slice(0, 6).join(" → ")}）${relationChain.length > 6 ? " …" : ""}。`
      : "没有拿到承接信息。";
  const structure = gaps.length
    ? `整本 ${gaps.length} 页，${gaps.filter((gap) => gap.verdict === "是").length} 页完全接住、${halfPages.length} 页只接住一半、${conflicts.length} 页没接住；${knownPages ? `${knownPages} 页听众知道下一步做什么` : "多数页听众不知道下一步做什么"}。`
    : "没有对照结果，无法判断结构。";
  const contradiction = conflicts.length
    ? `有 ${conflicts.length} 页听众没接住——读出来的重点和讲的人要的不一样（${conflicts.map((gap) => `第 ${gap.page.replace(/^P0*/, "")} 页`).join("、")}）。这不是前后矛盾，是这几页没把话说到听众能接住。`
    : "没有发现听众读出与意图对不上的地方。";
  const promises = dedupeBySimilarity(doubts);
  const wishes = promises.length ? promises.map((doubt) => `「${doubt}」`).join("；") : "听众没有留下明确的追问。";
  return { learned, coherence, structure, contradiction, wishes };
}

/** 听众视角 markdown。 */
export function renderReaderReviewMarkdown({
  deckTitle = "",
  generatedAt = "",
  audience = "",
  gaps = [],
  mergedBlind = [],
  deckGap = "",
  fixSuggestions = [],
  pageTitles = {},
} = {}) {
  const headline = readerHeadline({ gaps, mergedBlind, deckGap });
  const impression = readerImpression({ gaps, mergedBlind, deckGap });
  const gapByPage = new Map();
  for (const gap of gaps) {
    if (!gapByPage.has(gap.page) || (severityRank[gap.verdict] ?? 3) < (severityRank[gapByPage.get(gap.page).verdict] ?? 3)) gapByPage.set(gap.page, gap);
  }
  const pageBlocks = mergedBlind.map((row) => {
    const answers = row.answers ?? [];
    const primary = answers[0] ?? {};
    const others = answers.slice(1);
    const gap = gapByPage.get(row.page);
    const verdictLine = gap
      ? gap.verdict === "是"
        ? "被说服了：是"
        : `被说服了一半：听众读出「${firstSentence(gap.x, 70)}」，你想让他们带走的是「${firstSentence(gap.y, 70)}」。`
      : "这一页没有对照结论。";
    const title = pageTitles[row.page] || "";
    return [
      `## 第 ${row.page.replace(/^P0*/, "")} 页${title ? ` · ${title}` : ""}`,
      "",
      `- 读者读到：${firstSentence(primary.restate, 120) || "（没有复述）"}`,
      `- 和上一页的关系：${firstSentence(primary.relation, 30) || "（没答）"}`,
      `- 读者想问：${firstSentence(primary.doubt, 120) || "（没有追问）"}`,
      `- 下一步动作：${s(primary.next_action) || "（没答）"}`,
      `- ${verdictLine}`,
      gap?.fix ? `- 建议改法：${gap.fix}` : "",
      others.length ? `- 另一位听众：${firstSentence(others[0].doubt || others[0].restate, 100)}` : "",
      "",
    ].filter((line) => line !== "" || true).join("\n");
  });
  const fixes = fixSuggestions.slice(0, 3);
  return [
    "---",
    `title: ${deckTitle || "deck"} · 听众读后感`,
    "status: draft",
    "---",
    "",
    `# 听众读后感 · ${deckTitle || "（未命名 deck）"}`,
    "",
    `> 生成时间：${generatedAt || "（未记录）"}${audience ? ` · 听众：${audience}` : ""}`,
    "> 这份文档只记录「听众读到了什么」，不改稿；改法建议在每页末尾，需要你确认后才落版。",
    "",
    "## 一句话",
    "",
    headline,
    "",
    "## 读完的感觉",
    "",
    `- **学到了什么**：${impression.learned}`,
    `- **连贯吗**：${impression.coherence}`,
    `- **结构清楚吗**：${impression.structure}`,
    `- **有没有互相矛盾的地方**：${impression.contradiction}`,
    `- **还想知道什么**：${impression.wishes}`,
    "",
    "## 逐页：听众读到了什么",
    "",
    ...pageBlocks.map((block) => block.replace(/\n{3,}/g, "\n\n")),
    "## 听众建议先改的三处",
    "",
    ...(fixes.length
      ? fixes.map((item, index) => `${index + 1}. 第 ${String(item.page ?? "").replace(/^P0*/, "")} 页：${item.fix || item.problem || "（改法未给）"}`)
      : ["（本次没有需要改的地方）"]),
    "",
    "---",
    "",
    "> 内部口径（严重度、交叉确认、四维分）在 [review.gap.md](review.gap.md) 的「附：内部口径」，不用给听众看。",
    "",
  ].join("\n");
}

/** 负责人视角 markdown：意图 vs 听众的差距 + 需要拍板的事。 */
export function renderGapReviewMarkdown({
  deckTitle = "",
  generatedAt = "",
  scriptHash = "",
  audience = "",
  intentText = "",
  gaps = [],
  mergedBlind = [],
  deckGap = "",
  findings = [],
  dropped = [],
  scores = null,
  titleChain = null,
  fixSuggestions = [],
} = {}) {
  const counts = { 是: 0, 部分: 0, 否: 0 };
  for (const gap of gaps) counts[gap.verdict] = (counts[gap.verdict] ?? 0) + 1;
  const headline = readerHeadline({ gaps, mergedBlind, deckGap });
  const impression = readerImpression({ gaps, mergedBlind, deckGap });
  const gapByPage = new Map();
  for (const gap of gaps) {
    if (!gapByPage.has(gap.page) || (severityRank[gap.verdict] ?? 3) < (severityRank[gapByPage.get(gap.page).verdict] ?? 3)) gapByPage.set(gap.page, gap);
  }
  const rows = mergedBlind.map((row) => {
    const gap = gapByPage.get(row.page);
    const read = gap?.x || row.answers?.[0]?.restate || "";
    const wanted = gap?.y || "";
    const missing = gap ? (gap.verdict === "是" ? "—" : gap.verdict === "否" ? "听众读出的和意图相反或对不上" : "只讲到一半，缺「为什么/怎么做/凭什么」中的一块") : "无对照";
    return `| ${row.page} | ${firstSentence(wanted, 60) || "（对照组没给）"} | ${firstSentence(read, 60) || "（没有复述）"} | ${missing} | ${firstSentence(gap?.fix, 60) || "—"} | ${gap ? (gap.verdict === "否" ? "P0" : gap.verdict === "部分" ? "P1" : "—") : "—"} |`;
  });
  const top = [...gapByPage.values()]
    .filter((gap) => gap.verdict !== "是")
    .sort((a, b) => (severityRank[a.verdict] ?? 3) - (severityRank[b.verdict] ?? 3))
    .slice(0, 3);
  const decisions = dedupeBySimilarity(
    mergedBlind.flatMap((row) => (row.answers ?? []).map((answer) => firstSentence(answer.doubt, 70))),
    3,
  );
  const scoreLine = scores?.average
    ? `四维均分 ${meanOf(scores.average)}（表意清晰 ${meanOf(scores.dimensions?.["表意清晰"])} / 证据充分 ${meanOf(scores.dimensions?.["证据充分"])} / 结构连贯 ${meanOf(scores.dimensions?.["结构连贯"])} / 意图达成 ${meanOf(scores.dimensions?.["意图达成"])}）`
    : "（本轮没有评分）";
  return [
    "---",
    `title: ${deckTitle || "deck"} · 意图与听众差距`,
    "status: draft",
    "---",
    "",
    `# 意图 vs 听众 · 差距报告 · ${deckTitle || "（未命名 deck）"}`,
    "",
    `> 生成时间：${generatedAt || "（未记录）"}${scriptHash ? ` · 稿件哈希：\`${scriptHash}\`` : ""}${audience ? ` · 目标听众：${audience}` : ""}`,
    "> 给负责人看的一页纸：你要他们带走什么、他们实际带走了什么、差在哪、先改哪几页。",
    "",
    "## 一、一页总结",
    "",
    `- **意图达成**：是 ${counts.是} 页 / 部分 ${counts.部分} 页 / 否 ${counts.否} 页。`,
    `- **听众读后感到的差距**：${headline}`,
    impression.wishes ? `- **还想知道什么**：${impression.wishes}` : "",
    `- **先改哪几页**：${top.length ? top.map((gap) => `第 ${gap.page.replace(/^P0*/, "")} 页（${gap.verdict === "否" ? "听众没接住" : "只接住一半"}）`).join("、") : "本轮没有需要先改的页"}`,
    intentText ? `- **你的意图**：${firstSentence(intentText, 100)}` : "",
    "",
    "## 二、逐页差距（意图要的 vs 听众读到的）",
    "",
    "| 页 | 意图要的 | 听众读到的 | 差距 | 建议改法 | 内部级别 |",
    "|---|---|---|---|---|---|",
    ...(rows.length ? rows : ["| — | （没有对照结果） | — | — | — | — |"]),
    "",
    "## 三、需要你拍板",
    "",
    ...(decisions.length ? decisions.map((item, index) => `${index + 1}. ${item}`) : ["（本轮听众没有提出需要业务决定的问题）"]),
    "",
    "## 四、附：内部口径（工程/下一轮看，不用给听众）",
    "",
    `- ${scoreLine}${scores?.compare?.line ? `；${scores.compare.line}` : ""}`,
    `- 可采纳建议 ${findings.length} 条${findings.length ? `：${findings.map((item) => `${item.id}（${item.page}，${item.severity}，置信度 ${item.confidence}${item.crossReviewed ? "，交叉确认" : ""}）`).join("、")}` : ""}`,
    dropped.length ? `- 无法核实 ${dropped.length} 条（C 类，禁止据此改稿）：${dropped.map((item) => `${item.id}（${item.page}）`).join("、")}` : "- 无法核实（C 类）：0 条",
    titleChain ? `- 标题串读：${titleChain.verdict ?? "—"}${titleChain.reasons?.length ? `（${titleChain.reasons.slice(0, 2).join("；")}）` : ""}` : "",
    fixSuggestions.length ? `- 建议清单（按页）：${fixSuggestions.slice(0, 6).map((item) => `${item.page}：${firstSentence(item.fix, 40)}`).join("；")}` : "",
    "",
  ]
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/\n*$/, "\n");
}

/** 工具正文用的人话摘要（3 行以内，先讲人话，再给路径）。 */
export function plainReviewSummary({ deckTitle = "", gaps = [], mergedBlind = [], deckGap = "", readersDoc = "", gapDoc = "", missing = [] } = {}) {
  const headline = readerHeadline({ gaps, mergedBlind, deckGap });
  const gapByPage = new Map();
  for (const gap of gaps) {
    if (!gapByPage.has(gap.page) || (severityRank[gap.verdict] ?? 3) < (severityRank[gapByPage.get(gap.page).verdict] ?? 3)) gapByPage.set(gap.page, gap);
  }
  const top = [...gapByPage.values()]
    .filter((gap) => gap.verdict !== "是")
    .sort((a, b) => (severityRank[a.verdict] ?? 3) - (severityRank[b.verdict] ?? 3))
    .slice(0, 3);
  const lines = [`一句话：${headline}`];
  if (!gaps.length) lines.push("没有有效的对照结果（审稿人全失败或没跑），不能据此判断稿件没有问题。");
  if (top.length) {
    lines.push(
      `听众卡在哪（先改这几页）：${top
        .map((gap) => `第 ${gap.page.replace(/^P0*/, "")} 页——听众读出「${firstSentence(gap.x, 26) || "（空）"}」，你要的是「${firstSentence(gap.y, 26) || "（空）"}」`)
        .join("；")}`,
    );
  }
  if (readersDoc) lines.push(`完整记录：听众人话版 ${readersDoc}；意图差距 + 拍板项 ${gapDoc}（内部口径在后者末尾）。`);
  if (missing.length) lines.push(`没跑完的审稿人：${missing.join(" / ")}（结论不完整，要说明）`);
  return lines.join("\n");
}
