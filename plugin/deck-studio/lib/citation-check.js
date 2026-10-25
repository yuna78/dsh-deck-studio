/**
 * G3 引用核查（智力升级 B6 / F-177）：一次独立小调用，角色是**校对员不是评审员**。
 *
 * 评审给的意见带 evidence，评审员可能「引对文、推错论」（F4）或「改写当引用」（F2）。
 * G1（程序逐字匹配，见 buildFindings）只能杀 F1/F3；这里是第二道：
 * 让另一个没有上下文的小模型只回答两件事——这段是否逐字存在？它是否支撑这条意见？
 *
 * 本模块无 IO：只拼 prompt、解析结果。调用方在 tools.js 里用 review agent 跑一次。
 */

export const CITATION_VERDICTS = new Set(["verbatim", "paraphrase", "unsupported"]);

/** 引用核查的 prompt：只做校对，不给意图、不让它评稿。 */
export function citationCheckPrompt({ items = [], script = "", deckTitle = "" }) {
  const list = items
    .map((item) => `- ${item.id}｜${item.page}｜证据：${JSON.stringify(item.evidence)}｜意见：${item.problem || item.fix || "（未写）"}`)
    .join("\n");
  return `你是校对员，不是评审员。任务是核对下面的「意见」引用的稿件原文是否真实、是否支撑这条意见。

规则：
1. 只看给你的稿件原文和意见，不要评价稿件好坏，不要提新意见，不要改写。
2. 每条意见给两个判断：
   - quote：证据是否逐字存在于稿件原文（忽略空白 / 标点差异）→ "verbatim" | "paraphrase" | "unsupported"
     · verbatim：稿件里有这段原文
     · paraphrase：原文在，但这条是改写/概括，不是逐字引用
     · unsupported：稿件里找不到这段，也找不到对应原句
   - supports：这条证据是否足以支撑这条意见的结论 → true | false
3. 原文里没有的东西一律判 unsupported，不要凭常识补。

只输出 JSON（不要 markdown 代码块）：
{"checks":[{"id":"R01","quote":"verbatim|paraphrase|unsupported","supports":true|false,"note":"≤40 字"}]}

deck：${deckTitle || "（未命名）"}
稿 件 原 文：
"""
${script}
"""

待核对意见：
${list}`;
}

/** 解析引用核查输出；坏行丢掉，不抛。 */
export function parseCitationCheck(text) {
  const raw = String(text ?? "");
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) return { checks: [], unparsed: true };
  let parsed;
  try {
    parsed = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return { checks: [], unparsed: true };
  }
  const rows = Array.isArray(parsed.checks) ? parsed.checks : [];
  const checks = [];
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const id = String(row.id ?? "").trim();
    if (!/^R\d+$/.test(id)) continue;
    const quote = String(row.quote ?? "").trim();
    checks.push({
      id,
      quote: CITATION_VERDICTS.has(quote) ? quote : "unsupported",
      supports: row.supports === true,
      note: String(row.note ?? "").trim().slice(0, 80),
    });
  }
  return { checks, unparsed: checks.length === 0 };
}

/**
 * 把 G3 结论并回可采纳清单（B6 置信度 A–D 的完整口径）：
 * - verbatim + supports → A（可勾选，证据可定位）
 * - paraphrase 或 supports=false（但原文在）→ B（可勾选，标「转述 / 支撑偏弱」）
 * - unsupported → D（原文在但推不出结论 / 支撑不足：仍列出，只作参考，默认不勾）
 * 没拿到结论的条目保持原置信度（G1 已过的仍是 A），不因核查失败降级——但要在返回里标 `citationChecked:false`。
 */
export function applyCitationChecks(findings = [], checks = []) {
  const byId = new Map(checks.map((check) => [check.id, check]));
  let checked = 0;
  const next = findings.map((finding) => {
    const check = byId.get(finding.id);
    if (!check) return { ...finding };
    checked += 1;
    if (check.quote === "unsupported" || check.supports === false) {
      return { ...finding, confidence: check.quote === "unsupported" ? "D" : "B", citation: check };
    }
    if (check.quote === "paraphrase") return { ...finding, confidence: "B", citation: check };
    return { ...finding, confidence: "A", citation: check };
  });
  return { findings: next, checked, citationChecked: checked > 0 };
}
