# Changelog

## [0.2.11] · 2026-10-29

### 功能

- **插件图标（F-192）**：包根 `package.json` 新增 `"icon": "assets/icon.svg"`，`files` 补 `assets/`。图标就是工作台左上角那枚 mark 的
  小尺寸版（去掉最淡的底层卡片、两道文字条加粗、星芒放大——原样缩到 36px 会糊成一块灰）。宿主读包内文件 → base64 数据 URI →
  36px 画在 48px 框里，DSH「插件」面板与组合包卡片不再显示默认插画。声明有硬约束（包内相对路径、`svg/png/jpeg/webp`、≤256KiB、
  必须在 `files` 里），错了宿主**静默**回退默认插画——所以 `verify/smoke.mjs` 加了图标契约（105 项）：路径 / 存在 / 体积 / 扩展名 /
  白名单覆盖 / 与顶栏同一套渐变。
- 上游配套：[awesome-dsh-plugin#10371](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/pull/10371)——市场索引透传条目 `icon`，
  让「发现」卡片也能显示插件自己的图；该 PR 合并前，市场里的插件仍统一显示默认插画。

### 修复与配置

- `smoke` 的 git 留痕用例显式设置 `core.hooksPath=.git/hooks`：本机全局 hooksPath（devline 的 `.githooks`）会让临时仓库里的
  `pre-commit` 失效，导致「hook 拒绝时 commit 必须失败」这条假失败。

## [0.2.10] · 2026-10-26

> 正式发布版。`0.2.9` 曾在 npm 上发过一次中间态快照（缺 F-190 反装饰纪律与 README 改版），
> 以本版为准；GitHub 的 `v0.2.8` 之后直接跳到本版。

### 功能

- **顶栏更新 / 反馈入口（F-188）**：工作台右上角常驻三个按钮——**⚙ 设置**（切到右栏设置页）、**↻ vX.Y.Z** 点一下查 npm 最新版
  （有新版弹「当前 vX → vY」确认，点「更新」直接跑 `dsh plugin add`，重启 DSH 生效；已是最新就报版本号；
  本机 `link:` / `file:` 开发安装只解释「更新走仓库」，**不会**把本地链接换成 registry 包），
  **GitHub** 直接打开仓库的「新建 issue」页。离线 / registry 连不上时明确提示超时，不卡界面。
- 新增 `GET /api/deck-studio.update-check`（查 registry latest，12s 超时）与 `POST /api/deck-studio.update`
  （在 profile 里 `pnpm add`，240s）；安装方式按插件真实路径反推 profile（npm 布局不依赖 env），
  版本比较自己实现 semver（`0.2.10 > 0.2.9`、预发版排序），不引第三方依赖。

### 功能（续）

- **图上文字清单（F-189）**：出图 prompt 先列「这一页必须在画面上印出的文字」——主标题 / 副标题 / 一句话主张 /
  3–4 条要点（从正文抽短句），再给版式与字号预算，并声明「画面要求与文字清单冲突时文字优先」。
  之前副标题只写成「这页回答：…」，模型当成语境不印；画面要求又写「只出现三栏标签」，
  于是成图只剩几个标签、信息全靠讲述——现在这三项必须出现在画面里。
  同步：`qaCheck` 新增 `on-image-text` 门禁（漏印直接拒出图，修图 / 样张不受影响）；
  脚本页每页可展开「出图时拼装的完整 prompt」（`GET /api/deck-studio.page-prompt`），当场看服务端到底发了什么。

### 修复与配置

- **反装饰纪律（F-190）**：出图 prompt 加「画面纪律」——只画图上文字与画面要求点名的元素，不新增图例 / 清单面板 /
  装饰性英文标签 / 示意数据，同一元素不既画又列，同一信息不写两遍（含「不要双括号」）。
  同时把 TEC 预设里「外加带边框的图例 / 清单面板」从**必带**改成**必要时才加、且只列本页出现过的元素**——
  之前那页右上角凭空出现的 ARCHITECTURE LEGEND（NODE / SERVER / CLOUD…）就是这条风格词喂出来的。
- **文档页 tab 排版**：一轮评审会有 6 个相关文件 chip（`review.readers.md` / `review.gap.md` / `review.experts.md` …），
  原来跟标题挤同一行、右对齐折成两截，草案说明还夹在 chip 中间；改成标题右上角放主文件路径 + 草案说明，
  chip 独立一行左对齐可换行。目录型「相关文件」（`prompts/` 等）与不存在的文件不再算可切换项——
  脚本页原来挂着的 `script.md` / `prompts/` 一排 chip 现在整行隐藏。
- **插件门面图文改版（F-191）**：`plugin/deck-studio/README.md` 从「一段说明 + 表格」改成有图的产品页——
  logo、工作台截图、四张实拍（工作台 / 播放 / 风格库 / 管理）、能力表、安装 / 手册 / 示例入口、常见问题；
  删掉过期的 0.2.4 段落与 critic 检查说明。npm 页面直接渲染这份 README，所以这次一并进来。
- 插件 `package.json` 补 `repository` / `homepage` / `bugs`：npm 页面能跳仓库，界面「GitHub」按钮也从这里取地址。
- 预设风格数在 `plugin/deck-studio/AGENTS.md` 文件地图里补齐 8 → 9（0.2.8 漏的更）。

### harness

- smoke **104/104**（F-188 版本比较 / registry / 安装方式 / profile / 仓库链接 / 路由；F-189 图上文字清单逐字进 prompt、
  QA 拦漏印；F-190 画面纪律 + TEC 预设不再强制图例）。
- e2e **18 步全通过**（新增「顶栏更新 / 仓库按钮」与「脚本页拼装 prompt 可见」两项）；
  `audit:ui` 174 有反应 / 0 死按钮 / 0 报错（更新与 GitHub 按钮按会打网络 / 开新标签跳过）。
- 手册新增「13. 更新插件与反馈」（中英），`manual-shots --check-only` 通过；README 安装命令与当前版本同步 0.2.10。

## [0.2.8] · 2026-10-25

### 功能

- **风格登记（F-186）**：普通 deck 会话里没先选风格、做完说「这个风格好看，帮我登记」时，Agent 用新工具
  `deck_style_create` 把视觉语言登记成 design（与界面「＋添加风格」同一实体）。缩写不传自动生成；
  样张从该 deck 已出图页面**复制成品图**（不重新出图、不花额度），默认挑 3 张（封面 / 信息页 / 数据对比页各一）。
  已有风格可传 `designId` + `pages` 补样张，不动名称与提示词。
- **新预设风格 DSA · 深海琥珀**（深青底 + 香槟金细线 + 衬线中文大标题 + 大面积留白），带 3 张 1280 宽基线样张；
  预设风格随插件分发数 8 → 9，`＋ 导入预设风格` 会一并导入（幂等）。
- **评审结果改人话（F-187）**：评审完自动生成两本确定性渲染的文档——`docs/review.readers.md`（听众视角：
  一句话总结 + 读完五问 + 逐页「读者读到 / 被说服了吗 / 建议改法」+ 先改三处）和 `docs/review.gap.md`
  （负责人视角：意图达成、差距一句话、先改哪几页、需要拍板 + 附内部口径）。听众本不出现 P0/P1 / 置信度等内部术语。

### 修复

- 风格登记复制样张时文件名出现双点（`sample-p01-v002..png`），原因 `slideRenderInfo().ext` 带前导点。

### harness

- persona 增两条：普通会话「风格登记」（不再回答「没有接口 / 只能去界面建」）与「评审结果先讲人话」。
- 文档补「方式 0：普通会话里直接说」（`docs/styles.md`）、架构补 F-186 / F-187 流程；README / install / styles 预设数同步 9。
- smoke 101/101（新增 F-186 纯函数与工具注册断言、F-187 听众文档断言；预设风格断言 8 → 9）。

## [0.2.7] · 2026-10-25

> 本版只发布了 GitHub（助手能力补齐），未发 npm；npm 上 0.2.6 之后直接是 0.2.8。

### 功能

- 补齐 Deckline 主助手的 Web 搜索/抓取、资料/图片读取与检索、限定辅助草稿写编辑、只读研究子 Agent、提问/待办/文件交付，以及时间/长上下文能力。
- 主助手不再把缺少联网工具解释为产品禁止联网；搜索凭证与聊天凭证分开说明。

### 修复与权限

- 通用写仅限工作区 `.deck-assistant-scratch`；正式产物继续走 deck 工具与用户确认，受控源不由通用文件工具写入。
- 通用读限工作区/精确授权资料路径，拒绝秘密文件与 symlink；宽泛目录检索保守拒绝不安全目录，需缩小到干净资料目录。
- 研究委派不提供任意 preset 或 deck 写工具；内部审稿继续零工具。未引入 Bash 或开发技能。

### 兼容与配置

- Preview：DSH `>=0.2.1-rc.2 <0.3.0`；Node `^22.19.0 || >=24.0.0`。默认 fake 渲染，真实出图节点/key 自配。
- 搜索沿用宿主后端；默认 DeepSeek 搜索需账户或 `DEEPSEEK_API_KEY`，第三方聊天 key 不能替代。缺凭证应明确失败。
- 自定义完整 preset 需合并新版基础能力条目；升级重启后用新会话验收。

## [0.2.6] · 2026-10-25

### 功能

- 听众审稿改为插件内置的一次性 Sub Agent，不再额外注册用户可选的「听众审稿」Mode；仍通过听众评审按钮或对话自动调用。
- 专用审稿配置不继承父 preset / 对话历史，不开放工具，抑制可选 runtime contexts；审稿只返回意见，改稿仍需提案与用户确认。

### 修复

- 校验评审 JSON、严重度与逐字原文证据；非正常完成、无效输出或清理失败明确报失败，不再误当作「没有问题」。
- 补齐启动 / 运行取消、超时与子 Agent 释放；取消后不写评审报告。
- 新项目保存位置展示真实配置根或默认数据根，不再假定本机目录；默认提示词和安装文档同步。

### harness

- Smoke 87/87，真实 DSH 服务 + 离线适配器集成19项；产品实例真实模型评审成功，临时测试稿已清理。
- README 补齐全屏播放、内置模板与风格管理说明和截图。

### 兼容性与迁移

- Preview：本版最低要求 DSH `0.2.1-rc.2`，支持范围 `>=0.2.1-rc.2 <0.3.0`；Node `^22.19.0 || >=24.0.0`。旧 DSH 请先升级，或保留插件0.2.5。
- 升级插件后重启 DSH；手写 profile 若仍声明 `preset-deck-critic`，请移除。旧 `review.presetId` 不再选择审稿配置。
- 任务和工具隔离并非独立 deployment：宿主 required operational contexts 与全局指令 hook 仍可生效。
- 默认 fake 渲染；真实出图在设置页配置节点/模型/API Key，或使用环境变量/本机 key 文件。
- 本次生产模型覆盖单审稿人；多听众并发及首次整稿自动触发未单独验收。

## [0.2.5] · 2026-10-25

### 功能

- Deck / Design 制作入口自动使用「Deckline · image deck」，不需要手动选择模式。

### 修复

- 自动创建会话时明确指定 Deckline 模式；创建失败显示原因，不再静默退回标准模式。
- 已绑定标准模式的旧会话保留历史，进入制作流程时另建并绑定 Deckline 会话；发送制作指令前同样核对模式。
- 自动新建会话优先绑定 DSH 启动目录对应的工作区；未登记时自动登记，不再优先落到无关默认目录或未分组。
- 文档读取失败显示错误与重试入口，不再一直停留在「读取中」。

### harness

- 新增直接执行会话桥函数的行为回归，覆盖模式、启动工作区、旧会话保留与失败不回退；接入 smoke / check。
- Smoke 87 项通过、UI E2E 16/16、按钮体检 164 个有反应 / 0 报错、文档起草真模型发送链路通过。

### 兼容性

- Preview：DSH `>=0.1.7-0 <0.3.0`，本轮运行验证基于 0.2.1；Node `^22.19.0 || >=24.0.0`。
- 默认使用 fake 占位渲染；真实出图请在设置页配置节点地址、模型和 API Key，或使用环境变量 / 本机 key 文件。

## [0.2.4] · 2026-10-25

### 变更

- 关键词与文案补 `PPT`：npm keywords（ppt / pptx / powerpoint / ai-ppt / 幻灯片 / 演示文稿）、包描述、
  README 首段、插件市场索引标题与描述——让搜「PPT」的人也能找到 Deckline。

## [0.2.3] · 2026-10-25

### 修复

- npm 安装后的首次体验（0.2.2 的问题）：包内没带 `docs/` 与 `samples/`，导致「使用手册」打不开、示例 deck 只有空占位。
  现在 `prepack` 把手册与示例 deck 收进包内 `seeds/`，`repoRootFrom()` 在 npm 布局下回退到 `seeds/`；源码布局行为不变。

## [0.2.2] · 2026-10-25（首个 npm 公开版本）

### 修复

- Deck 页页面卡片尺寸统一（F-160）：之前未出图的占位卡会按内容收缩，和已出图的页大小不一；现在所有页面卡同宽同高（16:9 画面 + 单行元信息）。
- 应用内读使用手册 / install.md 时，不再被 5 秒后台刷新弹回章节首页（F-160b）。

### 新增

- 听众评审（F-159）：`deck_script_review` 按 intent 的「听众」动态生成独立只读审稿人（子 agent），逐页给 P0/P1
  问题 + 原文证据 + 可落版的改法，写进 `docs/review.experts.md`；只评不改，改稿仍走提案 + 用户确认。
  首次整份 script 落版后跑一次，用户说「再审一次」/ 脚本页「听众评审」按钮可随时再跑；默认最多 3 个审稿人。

- 写作纪律（F-158）：persona / `deck.rules.md` 模板 / deck_script_read 统一带上「标题给判断、不写比喻对仗、不写 AI 黑话、按受众调术语密度」；
  提案结果返回 `styleHints`（文案提醒），命中就提示具体哪条要改。
- 受众与目的进入生成链路（F-158）：`deck_script_read` / `deck_source_overview` 读出 intent 的听众、带走、成功标准；
  出图 prompt 带受众 / 目的，不再只按标题拼图。
- 封面页特殊处理（F-158）：P01 的 prompt 只放主标题 / 副标题 / 作者 / 日期，明确禁止目录、要点清单、大段正文。
- 脚本页更新提醒（F-158）：脚本 tab 有待确认提案时打小圆点；每页脚本内容变过且未查看时在页头打小圆点，点开即清。
- 首次启动登记名字（F-158）：存 `<dataRoot>/user.json`，首页问候用「XX，欢迎你」，新 deck 的 owner 与封面作者默认用它。

### 新增

- 首次启动自举（F-157）：新装 profile 默认收起 DSH 外壳左栏、自动登记「Deckline 示例手册」、
  把品牌素材拷进资源库、导入 8 个预设风格；只在空的时候发生，可用 `bootstrap: false` 关闭。
- 资源库扫描按文件名去重（共享库优先），示例 deck 的 `assets/` 不再和共享库重复出条目。

## [0.2.1] · 2026-10-24

### 新增
- **设置页直接管理出图节点**：一个节点就是「名称 + 接口地址 + API Key + 模型名」四项，可新增、编辑、删除；
  key 存在本机 `.deck/render-settings.json`（0600，已 gitignore），界面只显示「已保存」，接口不回显明文。
  不存本机的可以继续用环境变量 / key 文件；节点列表优先于 profile。
- **修图工具 `deck_image_edit`**：以已有图为底图改局部（去水印 / 改标题 / 删元素 / 换背景），一次一张；
  页面图修成新版本（旧图不覆盖），素材图落 `.deck/edits/` 独立产物；端点默认由 generations 端点派生。

### 改进
- **设置页节点卡可直接切换线路**：点模型或「用这个节点」立即写当前 deck 的选择，下一次出图生效、不重启。
- **节点表单默认收起**：平时只显示节点列表，点「编辑 / ＋ 新增节点」才展开，保存或取消后收起。
- **去掉工具栏「？帮助」按钮**：常见问题继续在 Chat 里问 Agent（同一份 FAQ）。
- **手册里的文档链接改为应用内打开**：install / styles / sample-deck 等不再跳到空白页，可返回手册。
- 首页问候语默认不再写死作者名：配置留空时显示「欢迎你」。

### 修复
- **设置页保存的节点对 Agent 出图立即生效**：此前工作台与 deck 工具是两个插件实例，Agent 出图仍用启动时的旧节点，
  切了线路仍报旧节点的余额错误。
- **设置页输入不再被后台刷新覆盖**：正在填写的文字和焦点会保留。
- **保存节点后列表与当前线路立即刷新**：新增节点保存后自动切到此线路，不用再点「用这个节点」。
- **公开包构建**：不再夹带 `verify/` `fixtures/` `AGENTS.md`；公开文档死链清零，README 标明开发专用命令。

### harness
- 手册截图与编号自动校验；smoke 82 项；e2e 15 步；按钮体检 0 死控件；严格版指令链检查。

## [0.2.0] · 2026-10-23（开源准备版）

### 修复
- **Inspector 正文框显示的是整节 script（含主张 / 意图 / 提示词）**（F-133）：现在按字段取——script 里有
  `**正文**：` 就只显示正文；保存也只替换这一行，主张 / 画面说明 / 提示词原样保留（以前整节替换会连带丢字段）。
  没有 `正文` 字段的 deck（`页面内容` / 表格惯例）保持原来的整节编辑。

### 修复
- **换 deck 后右栏 Inspector 显示上一本 deck 的页面内容**（F-132）：`switchDeck` 现在清空 `STATE.selected`
  并清掉 Inspector 旧值；`fillInspectorBody` 的响应同时校验 deckId + pageId。以前两本 deck 都有 p01 时，
  新 deck 的 p01 被当成「已选中」跳过重选，Inspector 一直挂着上一本的标题/正文。
  e2e 增加「换 deck 后 Inspector 不串上一本的页」回归。

### 修复
- **进入 deck 默认会话选错（F-139）**：之前取绑定表第一条（最早绑的会话），不看最近活跃；现在按绑定会话的
  `updatedAt` 选最新，且首页点 deck 先等 deck 切完再切会话，避免 postMessage 抢跑落到旧会话。
- **主张/正文字段写反导致「审批完没变化」（F-138）**：Agent 把长正文写进 claim，卡片不显示主张 → 用户看不到改动。
  现在 claim 超 120 字提案直接拒并提示用 body；脚本卡片显示主张与字数、超长标红；`deck_script_read` 给存量数据警告；
  qjx8 deck p03–p10 已按提案路径修复（长内容回到正文，主张收成一句）。

### 新增
- **首页「使用手册」（F-141）**：左导航新增入口，在应用内直接读 `docs/manual.md`（13 章 + 7 张带编号截图），
  章节 chips 跳转；截图走 `/api/deck-studio.docs-asset`（只放行 docs/assets/screenshots/**，拒绝路径穿越/非图片）。
  手册截图重新生成并修正「？帮助」按钮引入的编号漂移。
- **内置 FAQ / 帮助（F-140）**：27 条常见操作问答（改稿、出图、导出、换风格、会话、排错…）。
  Chat 里问「怎么操作」时 Agent 先调 `deck_help` 查同源知识再答；工作台工具栏新增「？帮助」弹窗，
  支持关键字搜索，走 `/api/deck-studio.faq`。

### 改进
- **使用手册重排 + 图上说明（F-143）**：「跟 Agent 怎么说」提到 §2 并扩成 8 组约 30 条示范 case；
  手册截图在每个序号旁直接画说明框（带引线、自动避让控件），编号清单保留用于搜索与校验；中英两版同步。
- - **批量出图文案校正（F-142）**：工具仍一次一页，但用户点名多页 / 整份时 Agent 会连续出完——persona、FAQ、
  工作台 prompt、README / 手册 / 样例 deck / 产品化风险表 / AGENTS 边界统一成「按页出图，可点名批量连出」，
  不再出现「一次只出一页 / 不要批量」。smoke 增加文案回归。
- **全屏演示退出竞态（F-142b）**：Esc 退出时先 await 真正退出全屏再隐藏演示层，避免 `fullscreenElement`
  残留导致整页按钮点不动（e2e 暴露）。
- **harness 减负（F-137）**：persona 25 条压成三段（闭环 / 硬纪律 / 场景剧本），删表演性步骤播报与重复台账要求；
  空 visualBrief 可出「自动草稿」图（`briefSource=draft`），`deck_render_page` 支持内联 visualBrief；
  确认不再强制引用原话（缺原话标 `quoteMissing` 留痕）；导出缺图页跳过并返回缺页清单；
  治理评分改称「交接完备度」，明确不影响出图 / 导出。约束清单见 `docs/harness-constraints.md`。

### 改进
- **资料库清单不再一片「缺失」**（F-136）：Library 里每项标必需 / 可选 + 一句用途；`script.md` 是唯一必需，
  `build/deck.yaml` / `outputs` / `CURRENT.md` / `feedback.md` 缺失只是「还没用到」，不代表坏了。
  可选缺失用中性灰标，不再和真错误同色。

### 改进
- **共享资源库 `<dataRoot>/resources/`**（F-134）：任何 deck 的「资源库」都会带上这里的 logo / 头像 / 二维码；
  支持 `index.json` 登记显示名与描述，白色 logo 缩略图自动加深底；media 路由新增 `scope=shared` 白名单。
  本机已导入产品字标 / 公司字标 / 团队字标、Yuna 3D 头像、微信二维码、原创「Yuna 的修炼手册」logo；
  受控源里的无用海报已移出（备份在 `.deck/backups/`）。

### 改进
- **去掉无意义的 deck 状态**（F-129）：deck 头部的 `draft` 徽标和「项目规则」按钮删掉（没有 publish / final 状态区分；
  规则入口保留在治理页），首页卡片也不再显示状态字样。
- **工具栏更松快**（F-129）：内容密度下拉改成短文案（`自动 · 按页判断` / `简洁 · 50–100 字` …），
  出图下拉不再带「（key 未配置）」长括号（key 状态进 title / 设置页），「添加页面 / 全屏演示 / 导出」不再被挤。
- **设置页字号统一**（F-129）：`#settings` 之前用浏览器默认的 h2(24px) / span(16px) 字号，和输入框 12px
  混在一起；现在标题 16px、字段名 10px、控件 34px 高，与其它面板一致，key 变量名 / key 文件改为并排两列。
- 手册截图随界面重出（F-129）：删除两个头部控件、缩短密度文案、设置页重新排版后，`npm run manual:shots` 重拍
  并校验编号；deck 类截图裁掉左栏 Chat（避免把本机会话内容带进公开手册）。

### 新增
- **生图设置页**（F-126）：工作台右栏「设置」可直接填 endpoint / 模型 / key 环境变量名（或 key 文件）/ 尺寸，
  保存即生效、不用改 profile 也不用重启；写本机 `.deck/render-settings.json`（600，gitignore），只存变量名不存 key 值，
  启动时覆盖 profile 配置。
- **带编号的手册截图**（F-128）：`npm run manual:shots` 自动拉起 demo 实例、按视觉顺序把 1/2/3 编号画在控件上，
  生成 `docs/assets/screenshots/manual/`（另出一套无标注图给 README），并校验 `docs/manual.md` / `manual.en.md`
  的编号数量与控件名——UI 改版后编号对不上会直接失败。
- **英文手册**（F-128）：新增 [`docs/manual.en.md`](docs/manual.en.md)，与中文手册逐图对应。
- **logo 水印**（F-125）：`deck_watermark_assets` 列 `assets/` 分类素材，`deck_watermark_apply` 给每页已出图页面盖 logo
  （默认右上角，可换位置 / 透明度 / 大小 / 指定页 / dryRun），每页写新 revision、不覆盖原图；纯 Node 自解自编 PNG，零第三方依赖。
- **内容密度**（F-124）：创建 / 工具栏可选 auto / 简洁 / 适中 / 信息密集，Agent 写 script 按对应字数口径；
  auto = 由 Agent 按每页内容判断，不设固定字数。
- **deck 项目规则自动初始化**（F-123）：新建 deck 自动生成 `deck.rules.md` 模板（受众 / 禁忌 / 视觉 / 事实来源来自创建表单）。
- **全屏演示**（F-102）：一页一屏，↑↓←→ / 空格 / 滚轮 / 点画面翻页，Esc 退出；真全屏优先 + 页面内兜底。

### 文档与发布
- 新增 [`docs/manual.md`](docs/manual.md)：按界面区域逐个按钮说明（首页 / 工作台 / 各 tab / 弹窗 / 导出 / 设置 / 项目规则 / 数据目录），
  每个区域配带 1/2/3 编号圈的截图，编号清单与图上控件一一对应；另附英文版 `manual.en.md`。
- 手册截图可复现：`npm run manual:demo`（用内置示例 deck + 预设风格重建 `.deck/demo`）→ `npm run manual:shots`
  （截图 + 写 `legend.json` + 校验两份手册编号与控件名），`npm run manual:check` 只校验。
- README 加界面截图（`docs/assets/screenshots/`，全部来自内置示例 deck，无客户素材）与「界面里配生图」入口。
- 公开包白名单加入 `docs/manual.md` + `docs/assets/screenshots/**`；隐私扫描 0 命中。

### 验证
- 契约冒烟 72/72；e2e 12/12；UI 按钮体检 0 死按钮；harness 门禁通过；公开包构建通过。

## Unreleased（下个版本）

### Harness / AI 协作机制（F-80）

- **渐进披露指令链**：根 `AGENTS.md` 收成薄路由（4.6 KB），`docs/` / `plugin/deck-studio/` / `scripts/` /
  `samples/` 分层加载；本机节点 / key / profile 事实进 本机覆盖文件（不入库）。
- **出图节点地址去硬编码**：默认端点为空，节点地址与 key 只来自 profile / `DSH_DECK_IMAGE_*` env / 本机 key 文件；
  real 模式缺地址会明确报错并给配置提示。仓库不再携带真实 relay、key 或个人绝对路径。
- **确定性门禁**：新增 `scripts/harness-check.mjs`（指令链预算、相对链接、脱敏、默认端点、台账、运行数据边界、
  harness 设施共 8 类检查；`--strict` / `--staged` / `--self-test`）+ CI + 可选 pre-commit。
- 新增 AI 协作 harness 文档与两个项目 skill（分层验证 `deck-verify`、发布检查 `deck-release`）。
- `CURRENT.md` / `HANDOVER.md` 拆成「当前视图 + 历史归档」，降低每轮上下文成本。
- 修复 `.gitignore` 全局 `build/` 误伤测试 fixture（干净 clone 可跑 smoke）。

### 工作台：全屏演示（F-102）

- deck 工具栏「导出」旁新增「▶ 全屏演示」：一页一屏放映整页图，↑↓←→ / PageUp·PageDown / 空格 / 滚轮 / 点画面翻页，
  Esc 退出；真全屏优先，工作台 iframe 补 `allow="fullscreen"`，被拒时父窗口全屏 / 页面内全屏兜底；design 画布不显示入口。

### 验证

- 契约冒烟 54/54；harness 门禁 8/8；公开包构建隐私扫描 0 命中。
- deck 项目级规则 `deck.rules.md`：plugin 显式读取（不走 `AGENTS.md` 文件链），overview 返回并标注优先级；8KB 上限 + 越权 flag（ADR-0021）。
- 工作台展示项目级规则：deck head 入口 + 治理页只读卡片（已配置/未配置 + 模板）+ 首页规则 chip（F-88）。

## v0.1.0 — 2026-10-21

首次公开版本：DSH 上的 image deck 工作台插件。

### 功能

- **工作台**：左侧 DSH 原生 Chat + 中间 deck 工作区（整页图 / 逐页 prompt / 版本）+ 右侧资料库。
- **image deck 闭环**：intent → script 提案/确认 → 逐页出图 → 版本回退 → 导出/交接包；源 deck 只读，产物落本地 `.deck/`。
- **治理**：7 份必备文档、修改日志、治理评分、交接包。
- **风格（design）**：登记风格、贴图/上传/拖拽添加样张、0 页风格画布 + 样张墙预览；
  随插件分发 8 个预设风格（BIZ / FYI / JPN / EDT / TEC / SKT / SWS / GRD）+ 样张。
- **生图**：多节点/多模型选择，`apiKeyEnv` / `apiKeyFile` 配置，界面只显示 key 是否配置；无 key 可 fake 模式跑通。
- **安装**：`dsh plugin --profile deckline add dsh-plugin-deck-studio`（直发 npm 包，无 scope）。

### 随仓库内容

- `plugin/deck-studio/` 插件本体 + 预设风格 seeds；
- `docs/`：安装 / 风格 / 产品化 / 示例 deck 指引；
- `samples/deckline-intro/`：示例 deck《Deckline 产品说明手册》（intent / script / 画面说明）；
- `assets/logo/`：Deckline logo（svg + png）。

### 验证

- 冒烟测试 `plugin/deck-studio/verify/smoke.mjs`：34/34 通过（无需网络与 key）。
- 真机验证：安装 → 建 deck → 建风格（贴图）→ 出图 → 导出 → 重启后数据仍在。

### License

MIT © 2026 Yuna（Deckline）。
