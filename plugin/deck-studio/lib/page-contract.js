/**
 * 逐页契约（智力升级 A1 / F-181）：每页写之前先填 5 项，缺一项不进入写作。
 *
 * 为什么是 5 项：一页 slide 讲不清，多半不是句子问题，而是「这页在论证里干什么」没定。
 * - 角色：承上 / 结论 / 证据 / 对比 / 机制 / 风险 / 请求 —— 决定位置；
 * - 受众变化：从 A 状态 → B 状态（可观察）；「让听众理解」不算变化，没法判定；
 * - 关系：与上一页 递进 / 并列 / 因果 / 转折 —— 答不出就是断链；
 * - 主张：一句话，≤ 60 字，可判真假；
 * - 证据：事实 ID / 示意数据 / 无需 —— 决定可信度（事实标注见 I-07）。
 *
 * 这里是纯函数：解析出来的字段 → 缺什么 / 哪项不合规 / 给 Agent 的下一步提示。
 * 老 deck 没有这些字段 → 只提示、不报错、不阻断出图。
 */

export const CONTRACT_ROLES = ["承上", "结论", "证据", "对比", "机制", "风险", "请求"];
export const CONTRACT_RELATIONS = ["递进", "并列", "因果", "转折", "开场", "收束"];

/** 5 项契约：key 是给人看的字段名，aliases 是 script 里可能出现的写法。 */
export const CONTRACT_FIELDS = [
  { key: "角色", aliases: ["角色"], hint: `承上 / 结论 / 证据 / 对比 / 机制 / 风险 / 请求 之一` },
  { key: "受众变化", aliases: ["受众变化", "听众变化"], hint: `写成「从 X → Y」的可观察变化；「让听众理解」不算` },
  { key: "关系", aliases: ["关系"], hint: `与上一页：${CONTRACT_RELATIONS.join(" / ")}` },
  { key: "主张", aliases: ["主张"], hint: "一句话，≤ 60 字，可判真假" },
  { key: "证据", aliases: ["证据"], hint: "事实 ID / 示意数据 / 无需" },
];

/** propose_edit 可写的契约字段名（工具 enum 用）。 */
export const CONTRACT_FIELD_KEYS = CONTRACT_FIELDS.map((field) => field.key);

const pick = (fields = {}, aliases = []) => {
  for (const alias of aliases) {
    const value = fields[alias];
    if (value != null && String(value).trim()) return String(value).trim();
  }
  return "";
};

/**
 * 从 script 字段表里读 5 项契约。
 * @param {Record<string,string>} fields - parseSectionedPages 产出的 fields
 */
export function readPageContract(fields = {}) {
  return {
    角色: pick(fields, ["角色"]),
    受众变化: pick(fields, ["受众变化", "听众变化"]),
    关系: pick(fields, ["关系"]),
    主张: pick(fields, ["主张"]),
    证据: pick(fields, ["证据"]),
  };
}

/**
 * 契约体检：缺项 + 弱项（写了但不可判定）+ 下一步提示。
 * @param {Record<string,string>} fields
 */
export function validatePageContract(fields = {}) {
  const contract = readPageContract(fields);
  const missing = CONTRACT_FIELDS.filter((field) => !contract[field.key]).map((field) => field.key);
  const weak = [];
  if (contract.角色 && !CONTRACT_ROLES.some((role) => contract.角色.includes(role))) {
    weak.push(`角色「${contract.角色}」不在 ${CONTRACT_ROLES.join(" / ")} 里——它在论证里处在什么位置？`);
  }
  if (contract.关系 && !CONTRACT_RELATIONS.some((relation) => contract.关系.includes(relation))) {
    weak.push(`关系「${contract.关系}」不在 ${CONTRACT_RELATIONS.join(" / ")} 里——和上一页是递进、并列、因果还是转折？`);
  }
  if (contract.受众变化 && /^(让|使|帮助)?(听众|用户|大家|观众)?(理解|了解|知道|明白|感受|意识到|认识)/.test(contract.受众变化)) {
    weak.push(`受众变化「${contract.受众变化}」不可观察——写成「从 A → B」（听完能说出 / 能判断 / 能做出什么）`);
  }
  if (contract.主张 && [...contract.主张].length > 60) {
    weak.push(`主张 ${[...contract.主张].length} 字，超过 60 字——一页一主张，长的部分挪进正文`);
  }
  const ok = missing.length === 0 && weak.length === 0;
  const hint = missing.length
    ? `这页还缺契约：${missing.join(" / ")}。写正文之前先补齐（提案时 field 用这些字段名）；老 deck 不强制，但缺了就别怪「这页讲不清」。`
    : weak.length
      ? `契约有弱项：${weak.join("；")}`
      : "";
  return { ok, contract, missing, weak, hint };
}

/**
 * 整本契约汇总：哪几页齐、哪几页缺哪项。
 * @param {{page:number, fields?:Record<string,string>}[]} pages - parseSectionedPages 产出
 */
export function summarizeContracts(pages = []) {
  const perPage = (Array.isArray(pages) ? pages : [])
    .map((page) => {
      const result = validatePageContract(page?.fields ?? {});
      return { page: Number(page?.page ?? 0), ok: result.ok, missing: result.missing, weak: result.weak };
    })
    .sort((left, right) => left.page - right.page);
  const complete = perPage.filter((item) => item.ok).length;
  return {
    pages: perPage.length,
    complete,
    // 一页都没填（老 deck）→ 不刷屏，只给一句话提示。
    untouched: perPage.length > 0 && complete === 0 && perPage.every((item) => item.missing.length === CONTRACT_FIELDS.length),
    perPage,
  };
}

/** 脚本页面上的一行状态，如「契约 4/5（缺 证据）」。 */
export function contractTag(result) {
  const total = CONTRACT_FIELDS.length;
  const done = total - result.missing.length;
  if (result.ok) return "契约 5/5";
  if (done === 0) return "契约 0/5（未填）";
  const parts = [];
  if (result.missing.length) parts.push(`缺 ${result.missing.join("、")}`);
  if (result.weak.length) parts.push("有弱项");
  return `契约 ${done}/${total}（${parts.join("；")}）`;
}
