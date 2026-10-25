/**
 * 新建 deck 的初始文档模板（F-73）。
 *
 * 背景：新建 Deck 弹窗里填的「听众 / 话题 / 意图 / 参考资料 / 风格」以前只被塞进
 * intent.md 的自由正文里，而治理与「意图」标签页按 `**字段**：值` 读取结构化字段，
 * 于是出现「弹窗明明填了，打开却显示待补 / 治理说缺字段」。
 *
 * 这里统一生成两类文档的初始内容：
 * - intent.md：结构化字段行（听众 / 主题 / 带走 / …）+ 参考资料 + 故事线占位；
 * - style-reference.md：`## 画面约束` 下 ≥3 条 bullet，让 Design 文档从第一天就可治理。
 *
 * 纯函数（无 IO），便于 smoke 直接断言；预设风格信息由调用方读 seeds 后传入。
 * @module dsh-plugin-deck-studio/deck-templates
 */

const pad = (value) => String(value ?? "").trim();
const orPlaceholder = (value, hint) => (pad(value) ? pad(value) : `（待补：${hint}）`);

/**
 * intent.md 初始内容。
 * @param {{title:string, audience?:string, topic?:string, intent?:string, references?:string, created?:string, owner?:string}} input
 */
export function buildIntentMarkdown({ title, audience = "", topic = "", intent = "", references = "", occasion = "", success = "", scopeOut = "", created = "", owner = "" } = {}) {
  const heading = pad(title) || "（deck 标题）";
  return [
    "---",
    `title: ${heading}`,
    `owner: ${owner}`,
    ...(created ? [`created: ${created}`] : []),
    "status: draft",
    "---",
    "",
    "# 意图",
    "",
    `- **听众**：${orPlaceholder(audience, "讲给谁：角色 / 部门 / 层级 / 对 AI 的熟悉度")}`,
    `- **主题**：${orPlaceholder(topic || heading, "一句话说清这场讲什么")}`,
    `- **带走**：${orPlaceholder(intent, "听完他们应该能带走什么（1–3 条，可验证）")}`,
    `- **场合 / 时长**：${orPlaceholder(occasion, "内部培训 / 客户评审 / 分享会；多少分钟")}`,
    `- **成功标准**：${orPlaceholder(success, "怎么判断这场讲成了")}`,
    `- **不讲的**：${orPlaceholder(scopeOut, "明确排除什么，避免范围膨胀")}`,
    "",
    "## 参考资料",
    "",
    orPlaceholder(references, "链接 / 文件路径 / 已有材料说明"),
    "",
    "## 故事线（叙事结构）",
    "",
    "（待补：分几段、每段回答什么、为什么这个顺序。脚本页顶部的叙事概览从 script 自动派生，不复制。）",
    "",
  ].join("\n");
}

/** 从预设风格定义里取「不要什么」等约束；没有就返回空串。 */
const presetConstraints = (preset) => pad(preset?.constraints);
const presetReference = (preset) => pad(preset?.reference);
const presetName = (preset) => pad(preset?.name);

/**
 * style-reference.md（Design 文档）初始内容：至少 3 条「## 画面约束」bullet。
 * 有预设风格：用预设的画面语言 / 不要什么 / 参考 / 历史风格；
 * 只有自定义描述：画面语言 + 参考 + 出图纪律（流程约束，不编视觉细节）。
 * @param {{title:string, styleAbbr?:string, styleDescription?:string, preset?:object|null, created?:string}} input
 */
export function buildStyleReferenceMarkdown({ title, styleAbbr = "", styleDescription = "", preset = null, created = "" } = {}) {
  const heading = pad(title) || "（deck 标题）";
  const description = pad(styleDescription) || pad(preset?.description);
  const rules = [];
  if (description) rules.push(`画面语言：${description}`);
  if (presetConstraints(preset)) rules.push(`不要什么：${presetConstraints(preset)}`);
  if (presetReference(preset)) rules.push(`参考：${presetReference(preset)}`);
  if (pad(styleAbbr)) rules.push(`历史风格：${pad(styleAbbr).toUpperCase()}${presetName(preset) ? `（${presetName(preset)}）` : ""}，出图沿用已登记样张的画面语言`);
  if (!rules.length) rules.push("画面语言：（待补：一句话说清这是什么风格的 deck）");
  if (rules.length < 3) {
    rules.push("出图纪律：按页出图 / 按页留版本；用户点名多页可连续出；visualBrief 先确认再出图（流程约束，不属于风格本身）");
    rules.push("参考：以用户提供的风格描述为准，不额外引入其他风格元素");
  }
  return [
    "---",
    `title: ${heading} · 视觉风格`,
    `style-abbr: ${pad(styleAbbr).toUpperCase() || "（未选）"}`,
    ...(created ? [`created: ${created}`] : []),
    "status: draft",
    "---",
    "",
    "# 画面规范",
    "",
    "## 视觉定位",
    "",
    description || "（待补：一句话说清这是什么风格的 deck。）",
    "",
    "## 画面约束",
    "",
    ...rules.map((rule) => `- ${rule}`),
    "",
    "## 模板 / 版式",
    "",
    "- 封面：（待补：封面怎么排）",
    "- 信息页：（待补：信息页怎么排）",
    "- 案例页：（待补：案例页怎么排）",
    "",
    "## 出图参数",
    "",
    "- 模型 / 节点 / 尺寸：与 profile 里的 render 配置一致（工作台右侧「出图」处可改）",
    "",
  ].join("\n");
}

/**
 * 新建 deck 的「支撑材料」初始内容（F-78）：把创建时填的参考资料解析成清单，
 * 不再只留一个 TODO。rows 由调用方探测（文件是否存在 / 大小 / 首行标题）；
 * Agent 之后用 deck_doc_update 补「可引用事实 / 支持哪条主张 / 缺口」。
 * @param {{title?:string, raw?:string, rows?:Array<{ref:string,type:string,status:string,note:string,fullPath?:string}>}} input
 */
export function buildMaterialsMarkdown({ title = "", raw = "", rows = [] } = {}) {
  const heading = pad(title) || "（deck 标题）";
  const list = Array.isArray(rows) ? rows : [];
  const lines = [
    "---",
    `title: ${heading} · 支撑材料`,
    "status: draft",
    "---",
    "",
    "# 支撑材料",
    "",
    "> 创建 deck 时填的参考资料先在这里登记；Agent 读完后补「可引用事实 / 支持哪条主张 / 缺口」。",
    "",
    "## 引用清单",
    "",
  ];
  if (list.length) {
    // 表头必须是「文件名 / 链接 / 总结」：deck-docs.js 的 materials 解析器按这三列识别，
    // 换表头会让「支撑材料」页把每条都渲染成「（未命名）目录」（F-78 实测踩过）。
    lines.push("| 文件名 | 链接 | 总结 |", "| --- | --- | --- |");
    for (const row of list) {
      const clean = (value) => String(value ?? "").replace(/\|/g, "／").replace(/\n/g, " ").replace(/`/g, "'");
      const ref = clean(row.ref);
      const summary = `${row.type || "文件"} · ${row.status || "待确认"}${row.note ? ` · ${clean(row.note)}` : ""}`;
      lines.push(`| ${ref} | ${ref} | ${summary} |`);
    }
    lines.push("");
  } else {
    lines.push("（创建时没有填参考资料；可以直接把文件路径 / 链接发我。）", "");
  }
  if (pad(raw)) {
    lines.push("## 原始说明", "", pad(raw), "");
  }
  lines.push("## Agent 分析", "", "（待补：每条资料里的可引用事实、能支撑哪条主张、还缺什么。）", "");
  return lines.join("\n");
}
