/**
 * 标题串读测试（智力升级 A3 / F-179）：只看一串页标题，能不能推出这份 deck 的故事线。
 *
 * 为什么是确定性脚本：这是「结构问题」，不该花模型调用、也不该由模型嘴上说「故事线清晰」。
 * 判据只查机器能查的东西：
 * - 有没有占位标题（待定 / 待补 / 暂无 / TBD）——占位意味着这一页还没有观点；
 * - 有没有重复标题——重复意味着两页在讲同一件事，或者一页是凑数；
 * - 相邻标题有没有共同词（2 字词）——全断链说明每页各说各的，读者串不起来；
 * - 有没有收束页（结论 / 小结 / 下一步 / 记住 / 带走 / 回扣）——没有收束，标题串读不出「然后呢」。
 * 「标题好不好」不在这里判（那是审稿人和人的事）；这里只判「能不能串起来」。
 */

const PLACEHOLDER = /待定|待补|暂无|待填|TBD|TBA|XXX|xxx/;
const CLOSE_MARKERS = /小结|总结|结论|收束|下一步|记住|带走|回扣|最后|所以|落地|行动|开始|三件事|清单/;
const STOP_BIGRAMS = new Set(["怎么", "什么", "为什么", "如何", "我们", "他们", "一个", "这个", "那个", "可以", "不是", "就是"]);

/** 标题的 2 字词集合（去掉常见虚词组合）。中文没有分词器，2-gram 足够做「有没有共同词」的判断。 */
export function bigramsOf(title = "") {
  const text = String(title ?? "").replace(/[\s\u3000]+/g, "").replace(/[，。、；：！？,.!?：:·—–\-（）()「」『』“”"']/g, "");
  const grams = new Set();
  for (let index = 0; index + 1 < text.length; index += 1) {
    const gram = text.slice(index, index + 2);
    if (!STOP_BIGRAMS.has(gram) && !/^\d+$/.test(gram)) grams.add(gram);
  }
  return grams;
}

function sharesBigram(left, right) {
  for (const gram of left) if (right.has(gram)) return true;
  return false;
}

/**
 * 读一遍标题串，输出逐页标记 + 能不能推出来的结论。
 * @param {{page:number,title:string,claim?:string}[]} pages
 */
export function analyzeTitleChain(pages = []) {
  const rows = (Array.isArray(pages) ? pages : [])
    .map((item, index) => ({
      page: Number(item?.page ?? index + 1),
      title: String(item?.title ?? "").trim(),
      claim: String(item?.claim ?? "").trim(),
    }))
    .filter((item) => item.title || item.claim)
    .sort((left, right) => left.page - right.page);

  const seen = new Map();
  const chain = rows.map((row, index) => {
    const flags = [];
    if (!row.title) flags.push("无标题");
    else if (PLACEHOLDER.test(row.title)) flags.push("占位标题");
    const key = row.title.replace(/\s+/g, "");
    if (key && seen.has(key)) flags.push(`与 P${String(seen.get(key)).padStart(2, "0")} 重复`);
    else if (key) seen.set(key, row.page);
    const grams = bigramsOf(row.title);
    const prev = index > 0 ? bigramsOf(rows[index - 1].title) : null;
    const next = index + 1 < rows.length ? bigramsOf(rows[index + 1].title) : null;
    const linkedPrev = !prev || sharesBigram(grams, prev);
    const linkedNext = !next || sharesBigram(grams, next);
    if (index > 0 && !linkedPrev) flags.push("与上一页无共同词");
    // 单看相邻两页会误杀正常转折（「故事线怎么定」→「逐页脚本怎么改」）。真正判「串不起来」看
    // 整体连通性：这一页和前后任意一页有共同词，就算它挂在链上。
    const attached = linkedPrev || linkedNext;
    return {
      ...row,
      flags,
      role: index === 0 ? "开场" : CLOSE_MARKERS.test(row.title) ? "收束" : "推进",
      linked: attached,
    };
  });

  const placeholderCount = chain.filter((row) => row.flags.includes("占位标题") || row.flags.includes("无标题")).length;
  const duplicateCount = chain.filter((row) => row.flags.some((flag) => flag.includes("重复"))).length;
  const brokenLinks = chain.filter((row) => row.flags.includes("与上一页无共同词")).length;
  const linkRate = chain.length > 1 ? Number((1 - brokenLinks / (chain.length - 1)).toFixed(2)) : 1;
  // 连通性：至少挂在一个邻居上的页比例（比「每一对相邻页都要同词」宽，能容忍一次正常转折）。
  const detached = chain.filter((row) => !row.linked).length;
  const connectivity = chain.length ? Number((1 - detached / chain.length).toFixed(2)) : 1;
  const hasClose = chain.length > 1 && (chain[chain.length - 1].role === "收束" || chain.some((row) => CLOSE_MARKERS.test(row.title)));

  const reasons = [];
  if (!chain.length) reasons.push("没有可读的页标题");
  if (placeholderCount) reasons.push(`${placeholderCount} 页还是占位标题（待定 / 待补）——这些页没有观点，标题串读不出内容`);
  if (duplicateCount) reasons.push(`${duplicateCount} 页标题与别的页重复——读者会以为是同一件事讲两遍`);
  if (connectivity < 0.7) reasons.push(`有 ${detached} 页和前后页都没有共同词——标题串中间断了，读者接不上`);
  if (chain.length > 3 && !hasClose) reasons.push("没有收束页（结论 / 小结 / 下一步）——读完标题不知道「所以呢」");
  if (chain.length > 0 && chain.length < 4) reasons.push(`只有 ${chain.length} 页，标题串太短，推不出完整论证`);

  const verdict = reasons.length ? "推不出" : "推得出";
  return {
    chain,
    stats: { pages: chain.length, placeholderCount, duplicateCount, brokenLinks, linkRate, connectivity, hasClose },
    verdict,
    reasons,
    // 给 Agent 的下一步：按最靠前的硬问题先修，不要一次全改。
    next: placeholderCount
      ? "先把占位页的标题写成「这页的主张」（不是栏目名），再回头看链"
      : duplicateCount
        ? "把重复的那页并掉，或改成它真正多出来的那一层"
        : connectivity < 0.7
          ? "让相邻标题共享一个关键词，或加一句承接（「上一页说了 X，这页说 Y」）"
          : !hasClose
            ? "补一页收束：结论 / 下一步 / 要记住的一句话"
            : "",
  };
}

/** 渲染成给人看的标题链报告。 */
export function renderTitleChain({ deckTitle = "", analysis }) {
  const lines = [`# 标题串读 · ${deckTitle || "（未命名 deck）"}`, ""];
  lines.push(`结论：**${analysis.verdict}**（${analysis.stats.pages} 页 · 占位 ${analysis.stats.placeholderCount} · 重复 ${analysis.stats.duplicateCount} · 断点 ${analysis.stats.brokenLinks} · 连通 ${Math.round((analysis.stats.connectivity ?? 1) * 100)}%）`);
  if (analysis.reasons.length) {
    lines.push("", "为什么：");
    for (const reason of analysis.reasons) lines.push(`- ${reason}`);
  }
  lines.push("", "| 页 | 标题 | 角色 | 标记 |", "|---|---|---|---|");
  for (const row of analysis.chain) {
    lines.push(`| P${String(row.page).padStart(2, "0")} | ${row.title || "（空）"} | ${row.role} | ${row.flags.join("；") || "—"} |`);
  }
  if (analysis.next) lines.push("", `下一步：${analysis.next}`);
  return `${lines.join("\n")}\n`;
}
