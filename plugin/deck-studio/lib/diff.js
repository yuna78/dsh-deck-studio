/**
 * 行级 unified diff（LCS）。只服务 script.md / deck.json 的提案展示，不追求 GNU diff 逐字节一致。
 * @module dsh-plugin-deck-studio/diff
 */

/** LCS-backtrack 行差异：返回 [{type:"same"|"del"|"add", line}]。 */
function rowDiff(oldLines, newLines) {
  const n = oldLines.length;
  const m = newLines.length;
  // 防御超长输入：脚本文件 ~200 行，deck.json ~60 行，直接 DP 足够。
  const dp = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      dp[i][j] = oldLines[i] === newLines[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const rows = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (oldLines[i] === newLines[j]) {
      rows.push({ type: "same", line: oldLines[i] });
      i += 1;
      j += 1;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      rows.push({ type: "del", line: oldLines[i] });
      i += 1;
    } else {
      rows.push({ type: "add", line: newLines[j] });
      j += 1;
    }
  }
  while (i < n) {
    rows.push({ type: "del", line: oldLines[i] });
    i += 1;
  }
  while (j < m) {
    rows.push({ type: "add", line: newLines[j] });
    j += 1;
  }
  return rows;
}

/**
 * unified diff 文本（带 `@@` 块头与上下文行）。
 * @param {string} oldText
 * @param {string} newText
 * @param {{context?: number, from?: string, to?: string}} [options]
 * @returns {string} 无差异时返回空串。
 */
export function lineDiff(oldText, newText, options = {}) {
  const context = Number.isFinite(options.context) && options.context >= 0 ? Math.floor(options.context) : 2;
  const from = options.from ?? "a/script.md";
  const to = options.to ?? "b/script.md";
  const rows = rowDiff(oldText.split("\n"), newText.split("\n"));
  if (!rows.some((row) => row.type !== "same")) return "";

  // 聚成 hunk：相邻变更 + context 行。
  const hunks = [];
  let current = null;
  rows.forEach((row, index) => {
    const interesting = row.type !== "same";
    if (interesting) {
      if (!current) current = { start: Math.max(0, index - context), rows: [] };
      current.rows.push(row);
      current.end = index;
    } else if (current && index - current.end > context) {
      hunks.push(current);
      current = null;
    } else if (current) {
      current.rows.push(row);
    }
  });
  if (current) hunks.push(current);

  const lines = [`--- ${from}`, `+++ ${to}`];
  for (const hunk of hunks) {
    const oldCount = hunk.rows.filter((row) => row.type !== "add").length;
    const newCount = hunk.rows.filter((row) => row.type !== "del").length;
    const oldStart = rows.slice(0, hunk.start).filter((row) => row.type !== "add").length + 1;
    const newStart = rows.slice(0, hunk.start).filter((row) => row.type !== "del").length + 1;
    lines.push(`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`);
    for (const row of hunk.rows) {
      lines.push(`${row.type === "same" ? " " : row.type === "del" ? "-" : "+"}${row.line}`);
    }
  }
  return `${lines.join("\n")}\n`;
}
