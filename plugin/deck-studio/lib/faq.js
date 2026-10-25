/**
 * 工作台内置 FAQ（F-140）。
 *
 * 只回答「怎么操作 / 在哪点 / 为什么不行」这类产品使用问题——它是产品知识的唯一来源，
 * Chat 里的 Agent 用 deck_help 工具查，工作台的「？帮助」面板走同一个 API。
 * 不写死具体 deck、客户名、节点地址；答案尽量给可点击的路径与工具名。
 *
 * 维护约定：改 UI 文案 / 流程时同步改这里（smoke 会检查条目数与必填字段）。
 */
export const FAQ_ENTRIES = [
  {
    id: "new-deck",
    title: "怎么新建一份 deck",
    keywords: ["新建", "创建", "新deck", "new", "开一个deck"],
    answer:
      "首页 → 右上「＋ 新建 Deck」：填标题、听众、场合、时长、要讲什么、参考资料（可拖文件 / 粘贴路径），选内容密度，点「创建」。\n" +
      "创建后会生成源目录（script.md / intent.md / 素材），左侧自动开一个绑定这份 deck 的会话。",
  },
  {
    id: "how-to-edit",
    title: "怎么改某一页的内容（提案 → 确认）",
    keywords: ["改内容", "修改", "改稿", "提案", "确认", "正文", "标题", "副标题"],
    answer:
      "在 Chat 里说要改第几页、改成什么。Agent 会提「提案」（diff 预览，此时文件不动）；你在 Chat 说「可以」或点提案卡片上的「确认」，才落版成新 revision。\n" +
      "自己的工作台里也可以点每页右上「微调」直接改标题 / 副标题 / 正文（写回 script.md）。\n" +
      "字段口径：标题 / 副标题（这页回答）/ 正文（具体内容，①②③ 写这里）/ 提示词（画面要求，只写画面）。",
  },
  {
    id: "fields-wrong",
    title: "为什么改了内容，脚本页看不到",
    keywords: ["看不到", "没变化", "不生效", "主张", "字段", "写反"],
    answer:
      "先看是不是把长内容写进了「主张」：卡片的正文区只显示正文（body），主张是一句话结论。\n" +
      "脚本卡片现在会显示主张和字数，超过 120 字会标红「主张过长 · 长内容应写正文」。\n" +
      "让 Agent 把长内容提到正文：deck_script_propose_edit 用 field=body 提一条，确认后正文才更新。",
  },
  {
    id: "image-edit",
    title: "能把已经出好的图修一下吗（修图 / 去水印）",
    keywords: ["修图", "改图", "去水印", "以图生图", "编辑图片", "局部修改", "retouch", "修一下"],
    answer:
      "可以，用修图工具 deck_image_edit：说「P03 的图修一下：去掉右下角水印，标题再大一点」「把 P05 那张图里的人换成剪影」\n" +
      "——Agent 会拿这页最新版本的图当底图，只改你点名的地方，产出新版本（旧图不覆盖）。\n" +
      "一次修一张；多张就按页说「P03–P05 都修掉水印」。它只改画面，不改 script / 正文：要改文字内容还是走提案。\n" +
      "想拿 deck 里的素材图（assets/ 下的 png / jpg / webp）修，也可以直接说「用 assets/xxx.png 修一下，背景换米白」，\n" +
      "结果会落成独立产物，不会自动变成某一页的图。整页重画用「P03 重出」，不要用修图去重跑整页。",
  },
  {
    id: "render-one",
    title: "怎么出图 / 重出（一页或多页）",
    keywords: ["出图", "生成图片", "渲染", "重出", "重新生成", "来一张"],
    answer:
      "说「出第 N 页」即可（Agent 调 deck_render_page，一次一页）。想一次出好几页见「能一次出多页吗」那条。\n" +
      "每页右下「重新出图」也行。\n" +
      "每次出新版本（v001 → v002），旧图保留、不覆盖；不满意继续重出即可。",
  },
  {
    id: "render-batch",
    title: "能一次出多页 / 整套吗",
    keywords: ["批量", "整套", "全部出图", "一起出", "多页"],
    answer:
      "可以，而且批量是正常用法：说「出 P04–P06」「把这 10 页都出一下」「整份出图」就行——用户点名 = 已确认，\n" +
      "Agent 按页序连续出完，不用每页停下来等确认。工具层仍是一次一页调用：每页各自留 prompt / 图 / QA / 版本，\n" +
      "失败只重出那一页，成本和质量都可控。不会自行扩到没点名的页。",
  },
  {
    id: "brief-empty",
    title: "页面还没有画面要求，能出图吗",
    keywords: ["visualbrief", "画面要求", "提示词为空", "没写提示词", "空"],
    answer:
      "能。没有画面要求时，系统用标题 + 正文拼「自动草稿」prompt 直接出图（qa.json 标 briefSource=draft），出完再补 brief 重出即可。\n" +
      "想一次到位：让 Agent 出图时带上 visualBrief 参数，系统会随手把这条画面要求存进这一页。",
  },
  {
    id: "export",
    title: "怎么导出 PDF / PPTX",
    keywords: ["导出", "pdf", "pptx", "ppt", "下载"],
    answer:
      "右上「导出 ▾」→ PDF / PPTX / 交接包。每页导出一张整页图。\n" +
      "还有页没出图也能导：缺的页会跳过，状态栏提示「6/10 页 · 缺 P04…」；只有一页都没出图才会拒绝。",
  },
  {
    id: "export-handoff",
    title: "交接包（zip）里有什么",
    keywords: ["交接", "交接包", "handoff", "打包", "给别人"],
    answer:
      "zip 里有：script.md、每页 prompt、每页整页图、9 份文档、事件记录。\n" +
      "交接前建议先跑一次治理页看缺什么（缺文档不影响出图，只是交接完备度）。",
  },
  {
    id: "change-style",
    title: "怎么换风格 / 关联 design",
    keywords: ["风格", "style", "design", "换风格", "样式", "关联"],
    answer:
      "Design 标签 →「这个 deck 用哪个登记风格」→ 选一个风格「关联到本 deck」，之后出图自动带这个风格提示词。\n" +
      "换风格只改画面语言，不改页面内容、不覆盖旧图；已写好的旧画面要求可以保留，也可以让 Agent 按新风格重写（逐页提案确认）。\n" +
      "想要新风格：首页 Designs →「＋ 添加风格」（描述 + 样张），或从风格画布会话里用 deck_design_sample 生子样张。",
  },
  {
    id: "style-canvas",
    title: "风格画布 / 样张怎么用",
    keywords: ["样张", "风格画布", "design canvas", "试风格"],
    answer:
      "Designs 页点一个风格进入它的空白画布会话：产物是「风格定义 + 样张」，不是 deck 页面。\n" +
      "让 Agent 先给 2–3 个版面 brief，你选一个再逐张出样张；样张会存进 designs/<缩写>/ 并出现在 Designs 页。",
  },
  {
    id: "density",
    title: "内容密度是什么，在哪改",
    keywords: ["密度", "字数", "正文多长", "多少字", "简洁", "密集"],
    answer:
      "密度决定一页写多少字：简洁（正文 50–100）/ 适中（100–200）/ 密集（200–500）。\n" +
      "deck 工具栏「密度」下拉可随时改；也可以让 Agent「按当前密度检查并重写」不达标的页。\n" +
      "注意：正文长 ≠ 画面字多——正文是讲稿，画面里的字要少。",
  },
  {
    id: "watermark",
    title: "怎么加 logo 水印",
    keywords: ["水印", "logo", "角标", "水印素材"],
    answer:
      "跟 Agent 说「盖水印 / 用 XX logo」：它会先列可选素材（deck_watermark_assets），确认后整份盖上（默认右上角，可指定位置 / 透明度 / 大小 / 指定页）。\n" +
      "每次出新版本、不覆盖原图；没出图的页会跳过并告知哪几页没盖上。",
  },
  {
    id: "resources",
    title: "资源库 / 怎么用自己的 logo 和头像",
    keywords: ["资源库", "素材", "logo", "头像", "二维码", "导入图片"],
    answer:
      "Library 面板的「资源库」列出共享素材（<数据目录>/resources）。放图进这个目录（配 index.json 写显示名）后，所有 deck 都能看到。\n" +
      "在 Chat 里可以直接说「用资源库里的 XX logo」，Agent 会用 deck_media / 水印工具取素材。",
  },
  {
    id: "inspector",
    title: "Inspector 逐页编辑保存的是什么",
    keywords: ["inspector", "微调", "保存", "编辑页", "右侧栏"],
    answer:
      "右栏 Inspector 改的是标题 / 副标题 / 正文 / 提示词，「保存」会写回源 script.md（本机新建 deck）并留 git 提交，然后可以「重新出图」。\n" +
      "受控客户源 deck 的源目录只读，保存只写工作副本；要回写源请走提案 + 确认。",
  },
  {
    id: "script-card",
    title: "脚本页卡片上的数字是什么意思",
    keywords: ["卡片", "字数", "达标", "目标", "脚本标签"],
    answer:
      "每页卡片：副标题、主张（一句话结论）、正文、提示词。\n" +
      "灰底小标签是当前密度下的字数：「正文 163 字 · 达标」= 在目标区间内；橙色「· 目标 100–200」= 不达标，可以让 Agent 重写。",
  },
  {
    id: "versions",
    title: "怎么回退到上一版",
    keywords: ["回退", "历史", "版本", "撤销", "恢复到上一版"],
    answer:
      "Context 面板 / 版本列表里能看到每次 revision（v001、v002…），选旧版本「回退」即可；旧版永远保留，不覆盖。\n" +
      "图片同理：每页每次出图各成一个版本，切回旧版就行。",
  },
  {
    id: "governance",
    title: "治理评分不到 100 能出图 / 导出吗",
    keywords: ["治理", "评分", "100分", "文档缺失", "齐备"],
    answer:
      "能。治理页是「交接完备度」，不是门槛：3 份与生成相关（意图 / 脚本 / Design），另外 6 份交接可选。\n" +
      "缺文档不影响出图 / 改稿 / 导出；要交接别人时再补齐，或先跑 deck_docs_check 看缺什么。",
  },
  {
    id: "review",
    title: "审稿 review 是必须的吗",
    keywords: ["审稿", "review", "检查", "校对"],
    answer:
      "不是必须。要交付前建议让 Agent 审一次（deck_review），它会读文档、写 review.md，按 P0/P1 列问题；只审不改、不出图。\n" +
      "P0 优先修，P1 看时间；审稿结论不阻塞任何工具。",
  },
  {
    id: "research",
    title: "调研 / 参考资料怎么进台账",
    keywords: ["调研", "资料", "参考", "research", "来源"],
    answer:
      "新建 deck 时填的参考资料会进支撑材料；Agent 用 deck_research_plan 分批读，可引用的事实写进调研台账（链接 + 存档 + 摘要）。\n" +
      "资料 ≥5 份或很长时建议让 Agent 分批读，避免一次塞满上下文。",
  },
  {
    id: "sessions",
    title: "左侧会话怎么切换 / 为什么默认是这个",
    keywords: ["会话", "对话", "切换", "绑定", "默认会话", "新会话"],
    answer:
      "左侧顶部标题旁边的数字是这份 deck 的会话数，点开可切换；「＋」新建一个并自动绑定本 deck。\n" +
      "进入 deck 默认打开的是「绑定会话里最近活跃的那个」；如果当前会话没绑在这份 deck 上，工作台会自动切回绑定会话。",
  },
  {
    id: "add-page",
    title: "页数不够怎么加页",
    keywords: ["加页", "增加页面", "页数", "扩页", "多一页"],
    answer:
      "工具栏「＋ 添加页面」或让 Agent 加页（deck_script_add_page，可一次多页，只追加到末尾，产出提案，确认后落版）。\n" +
      "新页没有画面要求也能先出草稿图，再决定要不要补写。",
  },
  {
    id: "delete-deck",
    title: "怎么删除 deck",
    keywords: ["删除", "删掉", "移除deck", "清理"],
    answer:
      "首页 deck 卡片上的「…」→ 删除。会删工作副本（.deck 下产物）；源目录是否一起删按弹窗提示确认。\n" +
      "受控客户源 deck 建议只删工作副本，不要动源目录。",
  },
  {
    id: "render-fail",
    title: "出图失败怎么排查",
    keywords: ["失败", "报错", "超时", "error", "出不来图", "qa"],
    answer:
      "看 Agent 回复的错误类型：\n" +
      "· QA 门禁：prompt 太短 / 尺寸不合法 / 含疑似密钥——改提示词重试；\n" +
      "· 节点或 key：设置页看出图节点与 key 状态（只显示配没配）；\n" +
      "· 超时 / 网络：插件会重试 5 次，仍失败可换节点或稍等；\n" +
      "· 「页不存在」：先确认页号与 deck 是否切对。",
  },
  {
    id: "switch-node",
    title: "怎么换出图节点 / 模型（线路切不过去）",
    keywords: ["换节点", "切节点", "换线路", "换模型", "出图节点", "线路", "模型下拉", "节点不换"],
    answer:
      "两个地方都能换：① 工作台顶部「出图」下拉，选节点 / 模型；② 右栏「设置 → 出图节点」，点某个模型或「用这个节点」。\n" +
      "切换只对当前这本 deck 生效，写进它的 render-selection.json，下一次出图就用新线路，不用重启。\n" +
      "要加线路：设置页「＋ 新增节点」，填 名称 / 接口地址（一般以 /v1 结尾）/ API Key（直接粘贴，存本机不进 git）/ 模型名，\n" +
      "保存后会自动切到新节点（不用再点「用这个节点」）；节点卡上还能「编辑 / 删除」（至少留一个）。\n" +
      "节点显示「key 未配置」时切过去也出不了图，先把 key 填好。",
  },
  {
    id: "install",
    title: "安装 / 配置出图 key",
    keywords: ["安装", "配置", "key", "api", "启动", "profile"],
    answer:
      "README / docs/install.md 有完整步骤：建 profile → 装插件 → 配置出图节点（endpoint / 模型 / key 走环境变量或本机 key 文件）→ 启动打开工作台。\n" +
      "没有 key 也能用 fake 模式跑通整条流程（不产生真实图片）。",
  },
  {
    id: "fullscreen",
    title: "怎么全屏演示",
    keywords: ["全屏", "演示", "present", "翻页", "放映"],
    answer:
      "工具栏「▶ 全屏演示」：↑ ↓ ← → 都能翻页（笔记本方向键即可），空格下一页，Esc 退出。\n" +
      "用的是已出图的整页图，不重新出图、不额外花钱。",
  },
  {
    id: "deck-rules",
    title: "deck.rules.md 是什么",
    keywords: ["规则", "rules", "项目规则", "约束"],
    answer:
      "deck 项目根目录下的 deck.rules.md 是这份 deck 的创作约束（语气、禁用词、版式习惯），必须遵守，但不能覆盖硬纪律（客户源只读 / QA 门禁 / 不编造 / 需用户确认）。\n" +
      "在治理页能看到它是否生效。",
  },
  {
    id: "why-no-batch-button",
    title: "为什么没有「一键出整套」按钮（Chat 里可以批量）",
    keywords: ["一键", "批量按钮", "整批", "一次出完", "批量出图", "全部出图"],
    answer:
      "界面上没放一键按钮，是为了避免误触把整份重出、成本失控；但没有限制你批量——\n" +
      "在 Chat 里点名「整份都出」「出 P04–P10」，Agent 会按页序连续出完，不用每页等确认。\n" +
      "逐页调用的好处是每页独立版本 / QA，哪页不满意只重出哪页，不会一锅端。",
  },
];

/** 查询归一化：去空白、小写，保留中文。 */
function normalize(text) {
  return String(text ?? "").toLowerCase().replace(/\s+/g, "");
}

/** 检索：关键词包含 / 标题字重叠，返回命中的条目（最多 limit 条）。 */
export function searchFaq(query, limit = 3) {
  const q = normalize(query);
  if (!q) return [];
  const scored = [];
  for (const entry of FAQ_ENTRIES) {
    let score = 0;
    const title = normalize(entry.title);
    for (const keyword of entry.keywords ?? []) {
      const key = normalize(keyword);
      if (!key) continue;
      if (q.includes(key)) score += 5;
      else if (key.includes(q)) score += 3;
    }
    // 中文没有空格：用二元组补召回（单个字符太容易误命中，会把无关问题也排上来）。
    const keywordText = (entry.keywords ?? []).map(normalize).join("|");
    for (let index = 0; index < q.length - 1; index += 1) {
      const pair = q.slice(index, index + 2);
      if (/^[\u4e00-\u9fa5]{2}$/.test(pair)) {
        if (title.includes(pair)) score += 1.2;
        if (keywordText.includes(pair)) score += 1.5;
      }
    }
    if (score >= 2.4) scored.push({ entry, score });
  }
  return scored
    .sort((a, b) => b.score - a.score || a.entry.id.localeCompare(b.entry.id))
    .slice(0, Math.max(1, Math.min(10, Number(limit) || 3)))
    .map((item) => item.entry);
}

/** 目录：只给标题 + 关键词，避免把整份 FAQ 塞进上下文。 */
export function faqIndex() {
  return FAQ_ENTRIES.map((entry) => ({ id: entry.id, title: entry.title, keywords: (entry.keywords ?? []).slice(0, 5) }));
}
