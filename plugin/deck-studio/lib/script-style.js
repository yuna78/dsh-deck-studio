/**
 * 文案风格体检（F-158）：把「AI 腔 / 散文腔」变成可执行的提醒，而不是只靠 persona 自觉。
 *
 * 只返回提示，不阻断提案——文案是创作判断，最终由用户确认；但提案结果里必须出现具体哪一条、
 * 改成什么方向，Agent 才能在下一轮改掉。
 * @module dsh-plugin-deck-studio/script-style
 */

/** 空泛 / AI 黑话（命中就建议换成具体名词或数字）。 */
const BUZZWORDS = ["赋能", "闭环", "抓手", "生态位", "底层逻辑", "范式", "全链路", "组合拳", "护城河", "飞轮", "降维打击"];

/** 散文 / 修辞腔（标题和副标题里出现就提醒）。 */
const PROSE_PATTERNS = [
  { pattern: /不是[^。！？\n]{1,24}[，,]\s*(?:而是|是)/, hint: "「不是…而是…」是对仗句式" },
  { pattern: /(?:真正|所谓)的/, hint: "「真正的 / 所谓的」是空泛强调" },
  { pattern: /^(?:一场|一段|一次)[^。]{2,}/, hint: "「一场 / 一段 / 一次…」像散文开头" },
  { pattern: /[，,][^。！？\n]{2,6}[，,][^。！？\n]{2,6}[，,][^。！？\n]{2,6}/, hint: "连续短句排比，像文案而不像结论" },
  { pattern: /[！!]/, hint: "标题里的感叹号" },
  { pattern: /[？?]$/, hint: "标题以问句结尾（问句放副标题，标题给判断）" },
  { pattern: /(?:答案|密码|魔法|旅程|心跳|温度|边界|底色)$/, hint: "抽象名词收尾，读者得不到信息" },
];

const charCount = (value) => [...String(value ?? "").trim()].length;

/**
 * @param {{field?:string, value?:string, title?:string, question?:string, body?:string}} input
 * @returns {string[]} 人话提醒；空数组 = 没看出明显问题
 */
export function scriptStyleHints({ field = "", value = "", title = "", question = "", body = "" } = {}) {
  const hints = [];
  const targetTitle = field === "title" ? value : title;
  const targetQuestion = field === "question" ? value : question;
  const targetBody = field === "body" ? value : body;

  if (targetTitle) {
    const n = charCount(targetTitle);
    if (n > 20) hints.push(`标题 ${n} 字偏长：标题给判断（≤ 16 字），解释放副标题 / 正文`);
    for (const { pattern, hint } of PROSE_PATTERNS) {
      if (pattern.test(targetTitle)) {
        hints.push(`标题有「${hint}」：改成「名词 + 判断 / 动作」，例如「三个页面状态都要能回退」`);
        break;
      }
    }
    const hit = BUZZWORDS.find((word) => targetTitle.includes(word));
    if (hit) hints.push(`标题里有「${hit}」：换成具体名词或数字，读者才知道你说什么`);
  }
  if (targetQuestion && charCount(targetQuestion) > 40) hints.push("副标题超过 40 字：副标题只说「这页回答什么」，一句话");
  if (targetBody) {
    const n = charCount(targetBody);
    if (n > 0 && n < 20) hints.push(`正文只有 ${n} 字：正文要么删掉让标题承担，要么补事实/例子`);
    const hit = BUZZWORDS.find((word) => targetBody.includes(word));
    if (hit) hints.push(`正文里有「${hit}」：换成机制、数字或具体做法`);
  }
  return hints;
}
