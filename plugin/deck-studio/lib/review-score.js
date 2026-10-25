/**
 * 审稿四维评分 + 版本记录（智力升级 B3 / F-183）。
 *
 * 为什么要打分：审稿意见是「这页哪里不行」，分数是「这本 deck 整体在什么水平」。
 * 只有分数落盘并带上 scriptHash / revision，两轮评审才能对照——否则「改完是不是更好了」
 * 只能靠感觉，这正是审稿机制最容易空转的地方。
 *
 * 四个维度各 1–5 分（打分发生在**对照阶段之后**，评审已看过意图；盲审阶段仍然不打分，保持听众视角的干净）：
 * - 表意清晰：读者能否一句话复述这页想让他记住什么；
 * - 证据充分：主张有没有支撑（含「示意数据」是否讲明）；
 * - 结构连贯：页与页的关系是否成立（承接 / 递进 / 转折）；
 * - 意图达成：整本有没有做到 intent 的「带走」。
 *
 * 本模块是纯函数（prompt / 解析 / 合并 / 对照）；落盘走 `lib/review-score-store.js` 的薄封装。
 */

export const SCORE_DIMENSIONS = ["表意清晰", "证据充分", "结构连贯", "意图达成"];

/** 打分 prompt：一次只出四维分 + 每维一句理由，不做新审稿（意见已由盲审 / 对照产出）。 */
export function scoreReviewerPrompt({ reviewer, brief = {}, deckTitle = "", script = "", maxScriptChars = 60_000 }) {
  const dimensions = SCORE_DIMENSIONS.map((dimension, index) => `${index + 1}. ${dimension}：1–5 分（5=最好）`).join("\n");
  const intentLines = [
    brief.audience ? `听众：${brief.audience}` : "",
    brief.takeaway ? `要带走：${brief.takeaway}` : "",
    brief.success ? `成功标准：${brief.success}` : "",
  ].filter(Boolean);
  const scriptText = String(script ?? "");
  const clipped = scriptText.length > maxScriptChars ? `${scriptText.slice(0, maxScriptChars)}\n…（后略）` : scriptText;
  return [
    `你是这份分享的听众评审：${reviewer.label}`,
    reviewer.focus,
    "",
    deckTitle ? `## 分享标题\n${deckTitle}` : "",
    intentLines.length ? `## 作者意图\n${intentLines.join("\n")}` : "",
    "",
    "## 稿件（打分用）",
    clipped,
    "",
    "## 你的任务：只打分，不写新意见",
    "刚才你已经审过这份稿子。现在只做一件事：给这本 deck 的四维度打分。",
    dimensions,
    "",
    "打分口径：",
    "- 3 分 = 及格：能读下去，但有一两处要读者自己补；",
    "- 5 分 = 好：不需要作者解释，听众当场能复述 / 能被说服；",
    "- 1 分 = 明显不合格：读完不知道在说什么，或证据站不住。",
    "- 每维必须给一句理由（≤30 字），理由要指向具体页或具体句子，不要写「整体不错」。",
    "",
    "## 输出契约",
    "只输出一个 JSON 对象，不要围栏外的解释：",
    "{",
    '  "reviewer": "你的身份（一句话）",',
    '  "scores": {"表意清晰": 4, "证据充分": 3, "结构连贯": 4, "意图达成": 4},',
    '  "notes": {"表意清晰": "P05 一句话能复述", "证据充分": "P03 的 30% 没来源"}',
    "}",
    "规则：分数只能是 1–5 的整数；不确定就给 3 分并在理由里写「不确定」。",
  ]
    .filter((line) => line !== "")
    .join("\n");
}

function jsonCandidate(text) {
  const raw = String(text ?? "").trim();
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fenced ? fenced[1] : raw;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(body.slice(start, end + 1));
  } catch {
    return null;
  }
}

/**
 * 解析打分输出；坏输出不炸（返回 unparsed + 缺的维度）。
 * @returns {{record:{reviewer:string,scores:Record<string,number>,notes:Record<string,string>}|null, unparsed:boolean, missing:string[]}}
 */
export function parseScoreOutput(text) {
  const parsed = jsonCandidate(text);
  if (!parsed || typeof parsed !== "object") return { record: null, unparsed: true, missing: [...SCORE_DIMENSIONS] };
  const reviewer = String(parsed.reviewer ?? "").trim();
  const scores = {};
  const notes = {};
  const missing = [];
  for (const dimension of SCORE_DIMENSIONS) {
    const value = Number(parsed.scores?.[dimension]);
    if (!Number.isFinite(value) || value < 1 || value > 5) {
      missing.push(dimension);
      continue;
    }
    scores[dimension] = Math.round(value);
    const note = String(parsed.notes?.[dimension] ?? "").trim();
    if (note) notes[dimension] = note.slice(0, 60);
  }
  if (missing.length) return { record: null, unparsed: false, missing, reviewer };
  return { record: { reviewer: reviewer || "听众", scores, notes }, unparsed: false, missing: [] };
}

/**
 * 合并多个评审的打分：每维取均值（保留一位小数），并记下人数 / 最低最高 / 理由。
 * @param {{reviewer:string,scores:Record<string,number>,notes?:Record<string,string>}[]} records
 */
export function mergeScoreRecords(records = []) {
  const list = (Array.isArray(records) ? records : []).filter((record) => record && record.scores);
  const dimensions = {};
  for (const dimension of SCORE_DIMENSIONS) {
    const values = list.map((record) => Number(record.scores[dimension])).filter((value) => Number.isFinite(value));
    dimensions[dimension] = values.length
      ? {
          mean: Number((values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(1)),
          min: Math.min(...values),
          max: Math.max(...values),
          count: values.length,
        }
      : { mean: null, min: null, max: null, count: 0 };
  }
  const means = SCORE_DIMENSIONS.map((dimension) => dimensions[dimension].mean).filter((value) => value != null);
  return {
    dimensions,
    average: means.length ? Number((means.reduce((sum, value) => sum + value, 0) / means.length).toFixed(2)) : null,
    reviewers: list.map((record) => ({ reviewer: record.reviewer, scores: record.scores, notes: record.notes ?? {} })),
  };
}

/**
 * 与上一次评审对照：返回每维 delta（无上次则全 null）。
 * @param {object|null} previous mergeScoreRecords 产物
 * @param {object} current
 */
export function compareScores(previous, current) {
  const deltas = {};
  for (const dimension of SCORE_DIMENSIONS) {
    const before = previous?.dimensions?.[dimension]?.mean;
    const after = current?.dimensions?.[dimension]?.mean;
    deltas[dimension] = before != null && after != null ? Number((after - before).toFixed(1)) : null;
  }
  const changed = SCORE_DIMENSIONS.filter((dimension) => deltas[dimension] != null && deltas[dimension] !== 0);
  return {
    available: Boolean(previous),
    deltas,
    changed,
    // 一句话结论：先说变好还是变差，再点名变化最大的维度。
    line: !previous
      ? ""
      : changed.length === 0
        ? "与上次评审相比：四维分数没有变化。"
        : (() => {
            const biggest = [...changed].sort((left, right) => Math.abs(deltas[right]) - Math.abs(deltas[left]))[0];
            const direction = deltas[biggest] > 0 ? "升" : "降";
            const improved = changed.filter((dimension) => deltas[dimension] > 0).length;
            const worsened = changed.filter((dimension) => deltas[dimension] < 0).length;
            return `与上次评审相比：${improved} 维升、${worsened} 维降；变化最大的是「${biggest}」${direction} ${Math.abs(deltas[biggest]).toFixed(1)} 分。`;
          })(),
  };
}

/** 历史记录里的一条（写入 JSON 的形状）。 */
export function scoreHistoryEntry({ at, scriptHash, revision, mean, compare }) {
  return {
    at,
    scriptHash: scriptHash ?? "",
    revision: revision ?? "",
    scores: mean.dimensions,
    average: mean.average,
    reviewers: mean.reviewers,
    compare: compare?.available ? { deltas: compare.deltas, line: compare.line } : null,
  };
}

/** 历史记录 → markdown 表（`docs/review.scores.md`，方便前后对照与交接）。 */
export function renderScoreHistoryMarkdown(entries = [], { deckTitle = "" } = {}) {
  const list = Array.isArray(entries) ? entries : [];
  const header = `| 时间 | revision | ${SCORE_DIMENSIONS.join(" | ")} | 均分 |`;
  const divider = `|---|---|${SCORE_DIMENSIONS.map(() => "---").join("|")}|---|`;
  const rows = list.map((entry) => {
    const cells = SCORE_DIMENSIONS.map((dimension) => entry.scores?.[dimension]?.mean ?? "—");
    const at = String(entry.at ?? "").replace("T", " ").slice(0, 16);
    return `| ${at} | ${entry.revision || "—"} | ${cells.join(" | ")} | ${entry.average ?? "—"} |`;
  });
  const lines = [`# 审稿评分记录 · ${deckTitle || "（未命名 deck）"}`, "", header, divider, ...rows, ""];
  const last = list[list.length - 1];
  if (last?.compare?.line) lines.push(last.compare.line, "");
  lines.push("打分口径：1–5；3 = 及格，5 = 听众不需要作者解释就能复述 / 被说服。分数由每轮评审的听众独立打，取均值。", "");
  return lines.join("\n");
}

/** 给人看的一段摘要（工具输出 / review 文档都能用）。 */
export function renderScoreSummary({ mean, compare }) {
  const parts = SCORE_DIMENSIONS.map((dimension) => {
    const item = mean?.dimensions?.[dimension];
    return item?.mean == null ? `${dimension} —` : `${dimension} ${item.mean}`;
  });
  const lines = [`四维评分：${parts.join(" · ")}${mean?.average != null ? `（均分 ${mean.average}）` : ""}`];
  if (compare?.line) lines.push(compare.line);
  return lines.join("\n");
}
