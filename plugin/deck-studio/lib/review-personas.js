/**
 * F-159：按 intent 的「听众」动态生成审稿人（不是写死几个固定 role）。
 *
 * 评审的立场来自用户填的听众，而不是产品预先规定的「技术 / 业务 / 编辑」三件套：
 * - 听众是一个群体（`技术负责人、后端工程师`）→ 每个群体一个「本人」评审；
 * - 只有一个听众 → 加一个「这堆人里最挑剔的那位」；
 * - 听众没填 → 不猜，直接让主笔先补 intent。
 *
 * 审稿人输出严格 JSON（见 `REVIEW_OUTPUT_CONTRACT`），由工具聚合；本模块无 IO，smoke 直接测。
 * @module dsh-plugin-deck-studio/review-personas
 */

/** 审稿人最多几个（每个 = 一次子 agent 调用；default 3，配置可调）。 */
export const DEFAULT_MAX_REVIEWERS = 3;
export const HARD_MAX_REVIEWERS = 5;

/** 给子 agent 的输出契约；解析器与 persona 都引用同一份措辞。 */
export const REVIEW_OUTPUT_CONTRACT = `只输出一个 JSON 对象，不要 markdown 代码块之外的解释：
{
  "reviewer": "你的身份（一句话）",
  "verdict": "看完这份 script 的一句话总评",
  "issues": [
    {
      "page": "P01",
      "severity": "P0 | P1 | P2",
      "problem": "一句话问题（站在你的身份上）",
      "evidence": "script 原文片段（必须逐字引用）",
      "suggestion": "具体怎么改（给可直接落版的句子，不是「优化一下」）"
    }
  ]
}
规则：
- 只从「${"${audience}"}」这个身份判断，不写通用写作建议；
- 最多 8 条，按严重度排序；没有真问题就输出空数组，不要凑数；
- 每条必须有 script 原文证据；没有证据的意见不要写；
- 不改稿、不调用任何工具、不提提案；你只输出这份 JSON。`;

/**
 * 逗号 / 顿号 / 分号 / 斜杠 / 换行 分隔的听众列表。
 *
 * 真实 intent 里「听众」常带解释：`第一次接触 Deckline 的人：会用 DSH、被改稿折磨过…`。
 * 冒号后是补充说明，不是第二个听众——先按第一个冒号切开，只用前半段做身份，
 * 后半段留给 prompt 里的完整 audience 文本（reviewerPrompt 直接用 brief.audience）。
 */
export function splitAudience(audience) {
  const raw = String(audience ?? "").trim();
  if (!raw) return [];
  const colon = raw.search(/[：:]/);
  const head = colon >= 0 ? raw.slice(0, colon).trim() : raw;
  return head
    .split(/[、，,；;\/|\n]+/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    // 「技术负责人和技术团队」这种句子里再拆一层
    .flatMap((part) => part.split(/\s*(?:以及|还有|和|与|及)\s*/))
    .map((part) => part.replace(/^[·\-*\s]+|[。；;，,.\s]+$/g, "").trim())
    .filter((part) => part.length > 0 && part.length <= 40);
}

/** 同一个听众去重（大小写 / 空格不敏感）。 */
function uniqueBy(list, keyOf) {
  const seen = new Set();
  const out = [];
  for (const item of list) {
    const key = keyOf(item);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

/**
 * 按 intent 的听众生成审稿人。
 * @param {{audience?:string, takeaway?:string, success?:string, topic?:string}} brief
 * @param {{max?:number}} [options]
 * @returns {{reviewers: Array<{id:string,label:string,audience:string,stance:string,focus:string}>, reason:string}}
 */
export function deriveReviewers(brief, options = {}) {
  const max = Math.min(
    HARD_MAX_REVIEWERS,
    Math.max(1, Number.isFinite(Number(options.max)) ? Number(options.max) : DEFAULT_MAX_REVIEWERS),
  );
  const audience = String(brief?.audience ?? "").trim();
  const segments = uniqueBy(splitAudience(audience), (segment) => segment.toLowerCase());
  if (!segments.length) {
    return { reviewers: [], reason: "intent.md 没写「听众」，评审没有立场可站；先补听众再跑评审。" };
  }
  const reviewers = [];
  for (const [index, segment] of segments.entries()) {
    reviewers.push({
      id: `audience-${index + 1}`,
      label: `${segment}（本人）`,
      audience: segment,
      stance: "本人",
      focus: `你就是「${segment}」，坐在这场 deck 的听众席里。只从你的处境和关注点判断：哪里听不懂、哪里不信、哪里觉得和我无关、听完哪页还是不知道要我做什么。`,
    });
    if (reviewers.length >= max) break;
  }
  // 听众只有一个 / 还留有名额时，补一个「同一群听众里最挑剔的那位」：不引入外部角色，仍是听众视角。
  if (reviewers.length < max && segments.length === 1) {
    reviewers.push({
      id: "audience-skeptic",
      label: `${segments[0]}（挑刺的那位）`,
      audience: segments[0],
      stance: "挑剔者",
      focus: `你也是「${segments[0]}」，但是现场最不客气的那位：专找站不住的数据、被跳过的前提、过度承诺、经不起追问的结论；你会当场举手问「凭什么」「所以呢」「这跟我有什么关系」。`,
    });
  }
  return {
    reviewers,
    reason: reviewers.length
      ? `按 intent 听众生成 ${reviewers.length} 位审稿人：${reviewers.map((reviewer) => reviewer.label).join(" / ")}`
      : "没有可用听众",
  };
}

/** 审稿 prompt：身份 + 这份 deck 的意图 + script + 输出契约。 */
export function reviewerPrompt({ reviewer, brief, deckTitle, script, rulesText = "", maxScriptChars = 60_000 }) {
  const scriptText = String(script ?? "");
  const clipped = scriptText.length > maxScriptChars
    ? `${scriptText.slice(0, maxScriptChars)}\n\n（script 过长，以上为前 ${maxScriptChars} 字符；按已给部分评审，超出部分在 verdict 里注明未覆盖）`
    : scriptText;
  const intentLines = [
    brief?.topic ? `主题：${brief.topic}` : "",
    brief?.audience ? `听众：${brief.audience}` : "",
    brief?.takeaway ? `听完要带走：${brief.takeaway}` : "",
    brief?.success ? `怎么算讲成功：${brief.success}` : "",
    brief?.scopeOut ? `不讲的：${brief.scopeOut}` : "",
  ].filter(Boolean);
  return [
    `你是这份 deck 的独立审稿人：${reviewer.label}`,
    reviewer.focus,
    "",
    "## 这份 deck 的意图（用户写的）",
    intentLines.join("\n") || "（intent 未提供）",
    "",
    deckTitle ? `## deck 标题\n${deckTitle}` : "",
    rulesText ? `## 这份 deck 的创作规则\n${rulesText}` : "",
    "## 待审 script（原文，含每页标题 / 这页回答 / 主张 / 正文 / 提示词）",
    clipped,
    "",
    "## 你的任务",
    "以你的身份从头读一遍：哪些页让你信、哪些页让你走神、哪些页听完仍然不知道要做什么。",
    "只提你能用原文证据支撑的问题；每条给出可以直接落版的改法（具体到句子 / 数字 / 结构）。",
    "",
    "## 输出契约",
    REVIEW_OUTPUT_CONTRACT.replace("${audience}", reviewer.audience),
  ]
    .filter((line) => line !== "")
    .join("\n");
}

/** 从子 agent 的最终文本里取 JSON（容忍 ```json 围栏 / 前后废话）。 */
export function parseReviewerOutput(text) {
  const raw = String(text ?? "").trim();
  if (!raw) return { reviewer: "", verdict: "", issues: [], raw: "" };
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidates = [fenced?.[1], raw].filter(Boolean);
  for (const candidate of candidates) {
    const start = candidate.indexOf("{");
    const end = candidate.lastIndexOf("}");
    if (start < 0 || end <= start) continue;
    try {
      const parsed = JSON.parse(candidate.slice(start, end + 1));
      const issues = Array.isArray(parsed.issues)
        ? parsed.issues
            .map((issue) => ({
              page: String(issue?.page ?? "").trim(),
              severity: ["P0", "P1", "P2"].includes(String(issue?.severity ?? "").toUpperCase())
                ? String(issue.severity).toUpperCase()
                : "P2",
              problem: String(issue?.problem ?? "").trim(),
              evidence: String(issue?.evidence ?? "").trim(),
              suggestion: String(issue?.suggestion ?? "").trim(),
            }))
            .filter((issue) => issue.problem || issue.suggestion)
        : [];
      return {
        reviewer: String(parsed.reviewer ?? "").trim(),
        verdict: String(parsed.verdict ?? "").trim(),
        issues,
        raw,
      };
    } catch {
      /* 试下一个候选 */
    }
  }
  // 模型没按 JSON 输出：保留原文，至少让主笔能看到意见，不要静默丢。
  return { reviewer: "", verdict: "", issues: [], raw, unparsed: true };
}

/** 多审稿人结果合并：带来源、去重、按严重度排序。 */
export function mergeIssues(results = []) {
  const issues = [];
  for (const result of results) {
    for (const issue of result?.issues ?? []) {
      issues.push({
        ...issue,
        reviewer: result.reviewer || result.label || "",
        from: result.label || result.reviewer || "",
      });
    }
  }
  const seen = new Set();
  const merged = [];
  for (const issue of issues) {
    const key = `${issue.page}|${issue.severity}|${issue.problem.replace(/\s+/g, "").slice(0, 40)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(issue);
  }
  const rank = { P0: 0, P1: 1, P2: 2 };
  return merged.sort((a, b) => (rank[a.severity] ?? 9) - (rank[b.severity] ?? 9));
}

/** 写进 docs/review.experts.md 的 markdown。 */
export function renderReviewMarkdown({ deckTitle, brief, reviewers, issues, generatedAt, failed = [] }) {
  const bySeverity = { P0: 0, P1: 0, P2: 0 };
  for (const issue of issues) bySeverity[issue.severity] = (bySeverity[issue.severity] ?? 0) + 1;
  const cell = (value) => String(value ?? "").replace(/\|/g, "\\|").replace(/\n+/g, " ").slice(0, 300);
  const table = issues.length
    ? [
        "| 严重度 | 页 | 问题 | 证据 | 改法 | 来自 |",
        "|---|---|---|---|---|---|",
        ...issues.map(
          (issue) =>
            `| ${issue.severity} | ${cell(issue.page || "—")} | ${cell(issue.problem)} | ${cell(issue.evidence)} | ${cell(issue.suggestion)} | ${cell(issue.reviewer)} |`,
        ),
      ].join("\n")
    : "| — | — | 未发现问题 | — | — | — |";
  return [
    "---",
    `title: ${deckTitle ?? ""} · 听众评审`,
    "status: draft",
    "---",
    "",
    "# 听众评审（动态 persona）",
    "",
    `> 生成时间：${generatedAt} · 只审不改：评审结果不直接改 script，改稿仍走提案 + 用户确认。`,
    "",
    "## 评审人（按 intent 听众生成）",
    reviewers.length
      ? reviewers.map((reviewer) => `- ${reviewer.label}：${reviewer.focus}`).join("\n")
      : "- （无）",
    ...(failed.length ? ["", `失效评审：${failed.map((item) => item.label).join(" / ")}`] : []),
    "",
    "## 结论",
    "",
    `P0 × ${bySeverity.P0} · P1 × ${bySeverity.P1} · P2 × ${bySeverity.P2}（共 ${issues.length} 条）`,
    "",
    "## 问题清单",
    "",
    table,
    "",
    ...(issues.length ? [] : ["（没有可操作的问题；主笔可以按原稿交付，仍建议用户复核事实与口径。）", ""]),
  ].join("\n");
}
