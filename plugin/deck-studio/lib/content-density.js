/**
 * deck 内容密度（F-124）：一页写多少字、画面要求写多细。
 *
 * 背景：同一份 deck，有人要「一页 300 字、图里信息密集」的自阅稿，有人要「一页 80 字、
 * 一页一件事」的演讲稿。密度是 deck 级设置（manifest.contentDensity），落在：
 * - 新建 Deck 弹窗 / deck 工具栏「密度」下拉（用户改）；
 * - deck_source_overview、deck_script_read（Agent 每次写 script 前读到目标字数）；
 * - persona 第 23 条（按设置写，auto 时自己判断并说明理由）。
 *
 * 数字口径（负责人 2026-10-23 定）：
 * - 信息密集 dense：正文 200–500 字/页，画面要求 800–900 字
 * - 适中 medium：正文 100–200 字/页，画面要求 400–600 字
 * - 简洁 concise：正文 50–100 字/页，画面要求 200–300 字
 * - 自动 auto：**不设固定字数**——由 Agent 按这一页／这份 deck 的内容自己判断每一页该多长
 *   （该密则密、该简则简），但要说明判断理由；不是「套一个 100–200 的区间」
 *
 * 注意：正文长 ≠ 画面字多。画面里的字仍由风格与视觉规则约束（信息密集也不许堆小字）。
 */

export const CONTENT_DENSITY_KEYS = ["auto", "concise", "medium", "dense"];

export const CONTENT_DENSITIES = {
  auto: {
    key: "auto",
    label: "自动",
    hint: "不设固定字数：由 Agent 按每页内容自己判断该多长，并说明理由",
    bodyMin: null,
    bodyMax: null,
    briefMin: null,
    briefMax: null,
  },
  concise: {
    key: "concise",
    label: "简洁",
    hint: "一页一件事，标题即结论，正文只留支撑句",
    bodyMin: 50,
    bodyMax: 100,
    briefMin: 200,
    briefMax: 300,
  },
  medium: {
    key: "medium",
    label: "适中",
    hint: "结论 + 2–3 句支撑 + 一句收口",
    bodyMin: 100,
    bodyMax: 200,
    briefMin: 400,
    briefMax: 600,
  },
  dense: {
    key: "dense",
    label: "信息密集",
    hint: "自阅型：一页给足论据 / 数据 / 步骤，读者不用问讲者",
    bodyMin: 200,
    bodyMax: 500,
    briefMin: 800,
    briefMax: 900,
  },
};

/** 归一化：未知值一律当 auto（老 deck 没有这个字段）。 */
export function normalizeContentDensity(value) {
  const key = String(value ?? "").trim().toLowerCase();
  return CONTENT_DENSITY_KEYS.includes(key) ? key : "auto";
}

export function densitySpec(value) {
  return CONTENT_DENSITIES[normalizeContentDensity(value)];
}

/** UI 下拉用的选项（含目标字数，便于用户看懂差别；auto 不写死区间）。 */
export function contentDensityOptions() {
  return CONTENT_DENSITY_KEYS.map((key) => {
    const spec = CONTENT_DENSITIES[key];
    const fixed = spec.bodyMin != null;
    return {
      key,
      label: spec.label,
      body: fixed ? `${spec.bodyMin}–${spec.bodyMax} 字/页` : "每页由 Agent 判断（不固定）",
      brief: fixed ? `${spec.briefMin}–${spec.briefMax} 字` : "每页由 Agent 判断（不固定）",
      // 数值口径也带上：工作台要按它逐页标「字数是否达标」，不能只靠字符串解析
      bodyMin: spec.bodyMin,
      bodyMax: spec.bodyMax,
      briefMin: spec.briefMin,
      briefMax: spec.briefMax,
      hint: spec.hint,
    };
  });
}

/** 给 Agent 看的一行（工具结果 / 脚本页都用它，保证口径一致）。 */
export function densityLine(value) {
  const spec = densitySpec(value);
  if (spec.key === "auto") {
    return "内容密度：自动（不设固定字数——按这一页的内容自己判断该多长、画面要求该多细，该密则密、该简则简；判断完告诉用户理由，不要套固定区间）";
  }
  return `内容密度：${spec.label}（正文 ${spec.bodyMin}–${spec.bodyMax} 字/页、画面要求 ${spec.briefMin}–${spec.briefMax} 字；${spec.hint}）`;
}
