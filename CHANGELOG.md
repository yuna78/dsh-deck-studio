# Changelog

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
