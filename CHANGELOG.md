# Changelog

## [0.2.26] · 2026-11-06

> 导入 PDF 成功之后，工作台进入的是**列表里第一本 deck**，不是刚导入的那本。

### 修复

- **导入后停在刚导入的 deck**（F-205）。导入要跑 `pdftoppm`（几秒到几十秒），这段时间里工作台
  5 s 轮询、宿主下发的打开指令、以及「新建 deck 还没进列表」都会改写「当前是哪本 deck」：
  - 工作台 `loadWorkbench` 增加并发序号，只让**最后发起**的那次结果落地——先发后回的旧请求
    不再把刚切过去的新 deck 覆盖回旧数据；
  - 导入成功不再直接切视图，改为 `openImportedDeck()`：打开后约 3 秒内以新 deck 为准核对几次，
    **用户一按鼠标 / 键盘就立刻停手**，不抢手动导航；
  - 导入进行中（`IMP.busy`）跳过 5 s 轮询；
  - `workbench(deckId)` 点名的 deck 暂时不在这次快照里时，返回 `requestedDeckId / requestedMissing`
    而不是静默退回 `decks[0]`（正是「打开第一本」的来源），工作台据此立刻重试。

### 验证

- `verify/smoke.mjs` 120/120（新增 2 条：`requestedMissing` 语义、工作台并发 / 导入核对守卫的静态检查），
  `scripts/harness-check.mjs` 9 项 0 失败。
- 真机路径复核（0.2.2-rc.1 隔离实例 + Playwright 驱动真实工作台页面）：`workbench?deckId=<不存在的 id>`
  返回 `requestedMissing: true`；走 UI 导入一份 3 页 PDF 后，工作台最后一次 `workbench` 请求 = 新导入的 deck。

## [0.2.25] · 2026-11-06

> desktop App 升级到 DSH 0.2.2-rc.1 后，新建 deck 会话直接报错：
> `agent-preset/invalid: deck-capabilities ... ctx.tools.presentAs is not a function`。

### 新增

- **目录 PDF 导入**：工作台「⇪ 导入 PDF」把一份现有的 PDF 拆成逐页整页图（`pdftoppm`，默认 120 dpi /
  ≤40 页），直接落成一本 image deck；同目录若有同名 `.md`（页数与 PDF 一致）会当作脚本源抽取，
  没有就把其余 md 收进 materials，intent 末尾补「导入说明（推断 · 待确认）」。
  路由 `POST /api/deck-studio.deck-import`（错误按 code：`pdftoppm-missing` / `no-pdf` / `not-found` /
  `bad-dir` / `import-failed`）。PPTX 与「逐页看图推意图」留二期。

### 修复

- **兼容 DSH 0.2.2 移除 `ctx.tools.presentAs()`**：0.2.2 把原生工具执行改由基座
  `dsh-tool-executor-native` 挂载，`presentAs` 这个 API 被删掉；插件在 preset 挂载阶段调用它会让
  整个 `deck-capabilities` 预设校验失败——不只是新建会话报错，已有 deck 会话也恢复不了 agent
  （对话列停在 `Session unavailable`）。新增 `lib/present-native.js`：`presentNative(tools)` 做
  feature-detect，只有宿主提供 `presentAs` 才调用，0.2.1 / 0.2.2 两条线都能挂载；`lib/capabilities.js`
  （子 agent 设置 + `apply`）与 `lib/review-agent.js`（审稿子 agent）统一改走它。
- **回归用例**：`verify/capabilities.mjs` 增「0.2.2 宿主没有 presentAs 仍能挂载并跑 research」，
  `verify/review-agent.mjs` 增「没有 presentAs 仍能跑审稿」。

### 验证

- `verify/capabilities.mjs` 13/13、`verify/review-agent.mjs` 14/14、`verify/smoke.mjs` 118/118、
  `scripts/harness-check.mjs` 9 项 0 失败。
- 真机对照（0.2.2-rc.1 内置 CLI + 隔离 `DSH_HOME`，未动桌面 App）：未修版
  `session/create {agentPreset:"deck-studio"}` 复现同一条 `agent-preset/invalid`；修后返回 ok，
  `session/list` 里该会话 `agentAvailable: true`（未修版为 `false`）。

## [0.2.24] · 2026-11-05

> 全屏演示的整页图不放大：1280×720 的页面在大屏上缩在中间一小块，四周全是留白。

### 修复

- **放映图只写 `max-width / max-height`**：这两个属性只负责**缩小**，不放大——页面图（源里 baseline
  常见 1280×720）在 2K/5K 屏上就永远是自然尺寸。改成 `width/height: 100%` + `object-fit: contain`，
  大图缩小、小图放大都按比例铺满可用区域（保留 16:9 不裁切）。
- 阴影从 `box-shadow` 换成 `filter: drop-shadow`，跟着图片轮廓走；否则元素盒是整块舞台，
  会出现一大圈方形阴影压在画面上。

### 验证

- 用 headless Chrome 按用户屏幕尺寸 **2730×1536** 渲染同一张页图（`samples/deckline-intro/pages/p01.png`，
  1280×720）做前后对比：旧样式图宽约 1155px（约 42%，四周大片留白，与反馈截图一致）；
  新样式铺满到约 2540px 宽（留 22px 边距 + 底部工具条位置），16:9 比例不变。
- `node --check` 不涉及；CSS 改动后跑公开仓 integrity 门禁（三处版本 0.2.24）。

## [0.2.23] · 2026-11-05

> 回滚 0.2.22 的一次激进改动，并给 Dock 加错误边界 + 尺寸夹取：不再出现「整片变灰、啥也看不到」。

### 修复

- **回退 `sessionId` 透传（0.2.22）**：真机上出现「点账对话 → 原生界面 → 5–10s 后工作台闪出 →
  不到 1s 整片变灰」。让 `conversation.content` 在 `shell.overlay` 上下文里带 `sessionId` 去查宿主的
  主区 `pendingInteraction`，会把整棵 Dock 子树搞崩且不报错。先回退，保住对话可用——ask 的露出另想办法。
- **Dock 错误边界**：`DockErrorBoundary` 收住 Chat Dock 子树的任何渲染异常，把错误原因、重试按钮和
  「去宿主主区对话」的出路画在对话列里，不再退化成一片空白灰。
- **Dock 尺寸夹取**：测量偶尔会拿到「整窗」尺寸（面板刚切换、iframe 还没布局），fixed 覆盖层会盖住
  整个应用。现在 left/top/width/height 都夹在视口内，最小 120×160。

### 验证

- `node --check client.js` 通过；`DockErrorBoundary` / 视口夹取 / 回退后的 `DeckChatBody` 都在产物内。
- 公开仓 integrity 门禁本地跑通（三处版本 0.2.23）。

### 已知限制

- 桌面 Dock 里 ask / 审批仍然不显示（这是 0.2.22 想解决但方式不安全的问题）。下一步计划：
  在对话列顶部给「有待处理的确认」横条 + 一键在宿主主区打开该会话，而不是在主区 overlay 里硬渲染。

## [0.2.22] · 2026-11-05

> 修「Agent 的 ask / 审批在工作台对话列里不弹，必须退出工作台去主区对话才看得到」。

### 修复

- **Dock 没把 `sessionId` 透给 `conversation.content` factory（P0）**：宿主的 composer 链靠
  `useSessionStatus(s => s.get(sessionId)?.pendingInteraction)` 取待处理交互，再
  `renderSlotChain("conversation.composer", { sessionId, session, pendingInteraction })`；
  审批 / 提问面板（`dsh-client-ui-approval` 注册在 `conversation.composer` 上，`select` 判 `PendingApproval`）
  只有拿到 `pendingInteraction` 才渲染。我们以前只传 `{ variant, phase, hero }` → factory 里
  `sessionId` 是 `undefined` → `pendingInteraction` 恒为 `undefined` → Dock 里一个 ask 都不弹。
  现在把会话 id 透传下去（槽位 props 优先，退回 Dock 当前 retain 的 `sessionId`）。
- 顺带让内嵌路径同样带上 id（`variant: "embedded"` + sessionId），行为与主区对话一致。

### 验证

- `node --check client.js` 通过。
- 依据宿主产物核对链路：`dsh-client-ui-conversation/lib/client.js` 的 composer 链确实以
  `sessionId` 取 `pendingInteraction`；`dsh-client-ui-approval/lib/client.js` 确实按
  `pendingInteraction instanceof PendingApproval` 选择渲染面板 —— 说明缺的就是这个入参。
- 公开仓 integrity 门禁本地跑通（三处版本 0.2.22）。

## [0.2.21] · 2026-11-05

> 修「点左侧会话，工作区弹出来了，但停在首页而不是那本 deck」。

### 修复

- **指令来得比脚本还早（P0）**：工作台 iframe 的 `open-binding` 监听原本注册在 boot **末尾**
  （中间还有 `loadWorkbench` / `refreshSessions` 等多次 await），而宿主在面板刚挂载时就 postMessage，
  且发完立刻清掉了 pending —— 消息直接丢失，面板只好停在工作区首页。
  现在监听在脚本**最开头**注册：没 boot 完先暂存，boot 完再执行（`OPEN_BINDING` 队列）。
- **加送达确认**：工作台执行完回 `dsh-deck-studio:open-binding-ack`；宿主**收到 ack 才清 pending**，
  期间由 `workbench-ready` + 60/220/600/1400/2600/4200ms 多档重试兜底，20s 未 ack 才放弃。
  之前是「发出去就当送达」，面板重挂载那次必然丢。
- **失败可见**：deck / design 画布打不开时 flash 具体原因，并回 `ok:false` 的 ack（宿主记 warning）。

### 验证

- `node --check client.js` 通过；workbench 内联脚本 parse 通过。
- 时序核对：监听注册位置在脚本第 1 段（早于所有 await）→ 面板挂载瞬间到达的消息也能落到 pending；
  boot 末尾 `booted = true` 先置位再消费 pending，避免消费过程中新指令被吞。
- 公开仓 integrity 门禁本地跑通（三处版本 0.2.21）。

## [0.2.20] · 2026-11-05

> 修「新建 deck 后点发送：会话建出来了，但绑定没写成、工作区不弹、提示 session … is not retained」。

### 修复

- **发首条指令前没有 retain（P0）**：`sendToSession` 直接 `sessions.scope(sessionId)`，而刚建出来的会话
  还没被 Dock retain 过 → scope 为 null → 抛 `session … is not retained` → 整条 `ensure` 失败。
  后果是连锁的：工作台不写绑定（deck 变「未绑定」）、Dock 不出会话、从侧栏点这个会话也拉不起工作区。
  现在发之前先自己 `sessions.retain(sessionId, { source })` 再取 scope。
- **首条指令失败不再拖垮绑定**：`ensure` 拿到会话后即使 prompt 没发出去，也返回 `ok: true` 并带
  `notice`（「会话已建好并绑定，但首条指令没发出去…」），工作台照写绑定、照弹工作区，提示用 toast 显示。
- **失败可见**：`ensureDeckConversation` 打开会话失败时除了改 chip，再弹一条 error toast（之前只改徽标文案）。

### 验证

- `node --check client.js` 通过；workbench 内联脚本 parse 通过。
- 公开仓 integrity 门禁本地原样跑通（三处版本 0.2.20、隐私 0 命中）。
- 复现链路核对：截图里 `session-5e98b127… is not retained` 正是 `sendToSession` 的第 565 行旧逻辑抛出，
  修复后就地 retain；prompt 失败降级为 notice，不再中断绑定。

## [0.2.19] · 2026-11-05

> 修 0.2.18 的排版事故：新建弹窗里「表单 / 探索」两张卡各占半屏、文字竖排成一列。

### 修复

- **模式卡被基础 input 规则接管**：`.nd-mode-opt input{width:auto}` 与
  `.newdeck-body input{width:100%}` **同权重**、且前者写在前面，于是 radio 拿到 `width:100%` +
  `padding:7px 9px`，撑满整行，把文字挤成一字一行、卡片被顶到半屏高。
  现在改成 `.newdeck-body .nd-mode-opt input[type="radio"]`（权重更高）并且整块样式挪到基础 input
  规则**之后**，radio 恢复原生尺寸（顺带 `accent-color` 对齐主题色）；卡片改用两列 grid。
- **探索模式漏藏「成功标准」**：字段清单少列了 `ndSuccess`，切到探索模式还留着这一栏。
  已补进清单，并让「场合 / 成功标准」这种成对行在两个字段都藏起来时整行收掉（不留空栅格）。

### 验证

- 用 headless Chrome 把新建弹窗单独渲染成图（表单模式 900×1150、探索模式 900×640）逐张核对：
  两张模式卡并排、高度正常、文字横排；探索模式只剩「标题 + 风格 + 说明」。
- workbench 内联脚本 parse 通过；公开仓 integrity 门禁本地跑通（三处版本 0.2.19）。

## [0.2.18] · 2026-11-05

> 新建 Deck 支持**表单模式 / 探索模式**：主意还模糊时，一句标题也能开工，边聊边把简报定清楚。

### 功能

- **两种开工方式（对齐 html deck-studio 的 form / explore）**：新建弹窗顶部加模式切换。
  表单模式不变（受众 / 意图 / 页数 / 密度 / 场合 / 边界 / 参考资料先填）；
  探索模式只留「标题 + 风格」，其余字段隐藏但**保留已填值**（切回表单还在），页数先占 1 页占位。
  隐藏用的是显式 `display:none` + 取消 `required`——`.newdeck-body .field` 是 `display:flex`，
  单靠 `hidden` 属性和原生校验会互相打架。
- **探索式建档留痕**：`createDeck` 接受 `mode: "explore"`，`script.md` / `intent.md` frontmatter 写
  `creation-mode: explore`，意图页顶部加一行「创建模式：探索式 —— 简报随对话补充」，
  免得后面读到「待补」被当成漏填表单；注册表与 `deck.created` 事件也记 `creationMode`。
- **探索式首条 prompt**：建完直接把一段「别问我要表单、按顺序带我想清楚」的指令发进会话——
  一次问完 3–5 个关键问题 → 用 `deck_doc_update` 回写 intent（没依据标「待确认」不编）→
  给一版故事线草案（页数不确定给区间）→ 我确认后才动 script，出图要明确说。

### 验证

- 服务端实跑（临时 dataRoot）：探索式建档 → `pages=1`、`script.md` 与 `intent.md` 都带
  `creation-mode: explore`、意图页有「创建模式：探索式」、注册表 `creationMode: explore`、
  `state()` 里这本 deck 正常列出。
- 表单模式回归：`pages=4` 建出 4 页、无探索标记、意图里的受众原样保留。
- `node --check`（index.js / client.js / lib/deck-templates.js）与 workbench 内联脚本
  （255,824 字符）parse 通过；公开仓 integrity 门禁本地跑通（三处版本 0.2.18）。

## [0.2.17] · 2026-11-05

> 对齐 html deck-studio 的新交互：**从左侧会话直接拉起工作区开始干活**，不用先点 Deckline 面板再挑 deck。

### 功能

- **会话 → 工作区（一步进入）**：客户端订阅宿主 `sessions.list`，读「当前主区会话」
  （`retainedBy.mainView`）；切到一本**已绑定 deck / design 的会话**时自动 `selectPanel` 打开
  Deckline 工作台并切到那本 deck（design 绑定则进它的风格画布）。守卫与 html deck-studio 同构：
  启动时先只记当前会话（不抢视图）、会话变化那一刻主区若停在别的插件面板就不抢、260ms 防抖 +
  token 校验避免连点乱跳。
- **会话行「⋯」菜单入口**：`sidebar.workspaces.session.menu.item` 增加「在 Deckline 打开」——
  选中某个会话即可把它的 deck 拉到工作台；**未绑定**的会话不再静默，工作台会弹出提示告诉你怎么绑。
- **iframe 就绪握手**：工作台加载完主动发 `dsh-deck-studio:workbench-ready`，宿主把待发的
  「打开某本 deck」补发一次（外加 60/220/600/1400ms 重试），避免面板刚挂载时丢指令。

### 验证

- `node --check client.js` 通过；workbench.html 内联脚本（253,778 字符）parse 通过。
- 公开仓 integrity 门禁本地原样跑通：三处版本一致 0.2.17、隐私扫描 0 命中。
- 复用 html deck-studio 已在真机验证过的同款守卫（面板判定 / 防抖 / ready 桥接），未改其协议名。

## [0.2.16] · 2026-11-04

> 修的是「从没有会话的 deck，点 ＋ 新建会话没反应、永远绑不上」。

### 修复

- **无会话 deck 建不出会话（P0）**：桌面宿主里 `resolveSessionWorkspace` 的三级全落空——shell `cwd`
  是 profile 目录（被工作区守卫挡掉）、源目录还没登记成工作区、客户端 `workspaces` 服务也没有
  `initializeDefault`——于是每次都抛「无法确定启动工作区」，deck 只要有会话就能续聊、没有会话就
  永远建不出来。现在服务端在工作台载荷里给出 `active.sessionWorkspacePath`（deck 项目目录，
  源落在 `node_modules` / App 包时退回 `<dataRoot>/decks/<id>`），宿主桥按它建/复用工作区
  （尽力重命名为 `Deckline · <deck 名>`，重名不影响建会话）。
- **点了 ＋ 没反应**：`newChatForTarget()` 在拿不到目标时静默 `return`、失败只写进 chip 的 title。
  现在两种失败都走常驻 toast（含宿主返回的原因），并且 `catch` 里的异常也不再被吞掉。

### 验证

- `node --check` 通过（client.js / index.js）；workbench.html 内联脚本 parse 通过、deck 卡片模板
  `<div>` 开闭平衡；公开仓 integrity 门禁本地原样跑通（三处版本一致 0.2.16）。
- 载荷核对：`active.sessionWorkspacePath` 在示例 deck 上给出 `<dataRoot>/decks/sample-deckline-intro`
  （源在插件安装位，按预期回落），普通 deck 给出其源目录。

## [0.2.15] · 2026-11-04

> 修的是「装完打开，默认 deck 一屏空白、资源明明在却不显示」这一类。

### 修复

- **ghost deck 补挂（P0）**：工作副本里还留着 `decks/<id>/deck.json`、但注册表 / profile 的 `decks`
  里已经没有条目的 deck，过去只在列表里露一个标题（没有 adapter）——源里已出好的整页图 baseline、
  资源库、封面、9 份文档全都拿不到，打开就是一屏「未出图」的空白页，看起来像「资源都在就是没显示」。
  现在启动时按 manifest 的 `source.root` 补挂只读 adapter（`adoptManifestDecks()`，在 adapters 之前跑）；
  源读不到的标 `unmounted`，首页卡片显示「源未挂载 · 只剩工作副本」，不再伪装成正常的空白 deck。
- **示例 deck 常驻**：`bootstrapSampleDeck()` 过去用「`config.decks` 非空就跳过」判定，会被导入预设风格时
  自动建的 8 本风格画布顶掉——装过风格的机器上示例 deck 永远不再登记，正是上面那种 ghost deck 的来源。
  现在改成「这份示例没挂上才登记」；旧路径失效时自动回到包内 `seeds/samples/deckline-intro`。

### 验证

- 用本机真实数据目录（`<dataRoot>` = `~/.dsh/deckline`）的副本实跑安装包逻辑：`adapters` 9 本
  （含 `sample-deckline-intro`），示例 deck 10 页 `slide.render` 全部非 null（`revision: "source"`，
  p01 998 KB），`active.resources` 3 项，9 份文档 missing 由 9 降到 6（intent / script / materials 找回）。
- 源被拔掉的 ghost deck：`unmounted: true` + `sourceAvailable: false` 在 `state` 与 `workbench` 两处载荷都带出。

## [0.2.14] · 2026-11-04

> 本版主修 **DSH Desktop（Electron 宿主）里的使用体验**：desktop 里左栏对话卡在 "Loading plugins…"、
> 源里出好的整页图全部显示「未出图」、Inspector 报“读取正文失败”这一整类问题，根因都是
> 「桌面宿主的页面起源于自定义协议 `dsh-app://`，嵌套 DSH 子帧拿不到 boot 注入、流式端点也不可达」。
> 这一版把桌面里的对话换成宿主原生渲染，同屏保住。

### 功能

- **桌面：原生会话 Dock（F-202B / ADR-0027）**：Deckline 工作台在桌面宿主里不再内嵌 DSH 子页面。
  改为用宿主 `shell.overlay` + `SessionProvider` + `sessions.retain` 把**真·原生会话**渲染到工作台
  对话列的位置——聊天是原生的（附件 / 工具调用 / 审批 / 流式全都在），而且「左对话 + 右画布」
  **同屏保住**。绑定 chip / 会话菜单 / ＋ / ↗ 顶部三件全部保留；桌面里新建 / 切换会话自动绑定当前
  deck，不再产生未绑定会话；`sessions.retain` 报"目录未就绪"（unknown session）时视为自愈错误短重试。
- **桌面：会话数据对齐预置**：桌面宿主实例此前不读受控源 deck 配置——源里已出好的整页图全部显示
  「未出图」、Inspector 报「读取正文失败：当前数据目录没有这本 deck 的 script」。桌面实例需在宿主
  profile 里配 `dataRoot` / `decks` / `projectsRoot`（与产品 profile 同源）即可对齐，见 docs/install.md。
- **入口与降级**：桌面 Dock 未就绪时对话列显示降级卡（「在宿主主区打开」）；
  `#chatDockArea` 空态有「还没有绑定会话——点上方 ＋ 新建」提示；对话列顶栏 pill 桌面显示
  「对话 · 原生（桌面 Dock）」，可一键切回工作台。

### 修复

- **Dock 显示错会话**：桌面里隐藏了原 iframe，但其 localStorage 继承宿主 origin——工作台把
  宿主当前会话读成了"这一页的会话"，1.2s 心跳会把 Dock 顶掉。现在桌面只读工作台维护的绑定
  会话状态，绑哪本 deck 就显示哪本。
- **＋ 新建失败可见 + 工作区守卫**：会话失败原因写进绑定徽标（之前只写按钮 title，用户看起来
  像点了没反应）；桌面 shell 的 `process.cwd()` 指向 App 包目录，不再把它登记成用户工作区
  （守卫 App 包 / 系统 / 私有路径），落到 deck 源工作区或默认工作区；`/Applications/…` 之类的
  系统路径不会被误登记。
- **契约测试**：新增 `verify/client-dock.mjs`（Dock 注册形状 + 桥接 wiring 契约，无 DOM）挂进
  `npm run smoke`；修一处 smoke 对本机 `location.json` 指针的环境敏感失败。

### harness

- 云端 PR 流与产物完整性门禁（F-200 / F-201）：GitHub Actions（node 22/24 双矩阵）跑全量 smoke /
  静态门禁 / 公开包白名单 + 包白名单；公开仓 integrity 门禁 + PR 模板与纪律（分支 → PR → 双农梯绿
  → squash）；公开仓 main 已加禁强推 / 禁删 ruleset。desktop 排障链条全记录：上游问题单材料
  （desktop 壳子帧 boot 注入 / 流可达的最小复现）已整理成文件待报给 DSH 上游。

### 已知限制

- 桌面对话 Dock 依赖宿主 `shell.overlay` + `SessionProvider` 契约（DSH 0.2.1-rc.5 验证）；web 宿主
  （http 起源）行为不变，仍走工作台内嵌 DSH 对话。
- 桌面实例需在宿主 profile 里配置插件的 `dataRoot` / `decks` / `projectsRoot`，否则只有工作副本可见、
  源图与正文读不到——链接安装后请按 docs/install.md 对齐。

## [0.2.13] · 2026-10-31

### 功能

- **首页「关于」单页（F-193 / F-194 / F-195）**：左栏「使用手册」下方新增常驻 **关于** 入口——入口上直接显示
  当前版本 chip，有新版时亮小圆点（升级入口不再只藏在顶栏图标里）。点进去是**一页从上到下**的信息：
  作者 + 微信公众号（同一块：头像 / 一句话 / 名称 / 资源库二维码）→ 版本与更新（检查新版本）→
  开源地址与反馈（仓库 / 提 issue）→ 其他开源项目（Deckline / GitHub 主页）。
  公众号二维码只从运行期资源库（`<dataRoot>/resources`）读取，仓库不携带个人二维码，缺图时降级成配置提示；
  外链缺地址时 toast 说明，点击不会静默无反应。
  作者卡最后按反馈做成上下两段式（头像+一句话 / 分隔线 / 公众号名称+二维码），信息不重复。

- **侧栏入口改为面板行（F-197）**：DSH 侧栏的 Deckline 入口从「脚部按钮」换成 `sidebar.panellist` 面板行，
  和 Plugins / Automation tasks 同形态；图标由 `▦` 字符换成 16px 单色 SVG（叠卡片 + 星芒，`currentColor`
  跟随深浅色主题），点击仍然直接打开 Deck 工作台。

### 验证

- 契约冒烟 110/110（含 F-193–F-196「关于」静态契约：单入口 / 更新状态共用 / 二维码来源 / 外链兜底）。
- 真机 e2e 18/18；关于页定向验收 PASS；`audit:ui` 175 有反应 / 0 报错（1 项 design 页既有疑似死按钮，与本次无关）。
- F-197：13090 真机 DOM 实测侧栏 3 条面板行（Plugins / Automation tasks / Deckline），Deckline 行内
  1 个 `viewBox="0 0 16 16"` 的单色 SVG、4 个形状，`sidebar.footer.action` 下已无 deck 条目。

## [0.2.12] · 2026-10-29

> 修的是「数据明明出过图，换了个启动方式就全没了」。
> 一句话口径：**换端口不改数据，换 dataRoot 才改数据。**

### 功能

- **dataRoot 解析优先级（P0）**：`DSH_DECK_DATA_ROOT` > 指针文件 `$DSH_HOME/deckline/location.json`
  > profile patch `deck-studio.config.dataRoot` > 默认 `$DSH_HOME/deckline`。
  命中来源（env / pointer / profile / default）在顶栏黄条、设置页第一屏与自检面板直接显示，不再靠猜。
- **指针文件 `location.json`（P0）**：位置固定在 `$DSH_HOME/deckline/`（不随 dataRoot 配置移动，否则自指），
  权限 `0600`，只存 `version / dataRoot / projectsRoot / setBy / updatedAt`，不含任何 key；
  可被顶栏黄条的「切到这个目录」写入——写入前校验目录存在 / 可写 / 这本 deck 的正文确实在里面，
  写完原地重建服务并重注册工具，**不重启 DSH、不清会话**，切换成功后回到原来那本 deck。
- **数据四态与顶栏黄条（P0）**：`ok`（正文在）/ `partial`（有图没正文，revision 丢了）/
  `mismatch`（只剩 `decks/<id>/` 残留，或别处真有这本 deck 的正文）/ `absent`（本地目录里完全没痕迹）。
  `mismatch` / `partial` 出黄条，并列出最多 3 个候选目录（按 deck 数与图数排序，只列真存着这本 deck 正文的），
  点一下就切过去；`absent` **不出黄条**——受控源 deck 第一次打开本来就没有工作副本，属正常初始化，
  只在自检面板里显示「还没初始化」；本机新建 deck 的 `absent` 完全静默（首次打开就该初始化，不是异常）。
- **自检面板与「复制诊断信息」（P0）**：新增 `GET /api/deck-studio.self-check`，一次给出 dataRoot /
  projectsRoot / workspacePath / DSH_HOME / 指针文件 / env 覆盖 / 版本 / 出图节点 / 注册与磁盘上的 deck 差集；
  脱敏诊断文本由后端生成，前端只负责复制，避免两套脱敏口径。

### 行为变化

- **env 与 profile 同时配置 dataRoot 时，env 优先**（此前 profile 里的值对 `dataRoot` 生效）。
  只配一处的用户不受影响；两处都配过且值不同的老用户会命中 env 指定的目录，
  启动时打一行 `warn` 留痕：`dataRoot 同时由环境变量与 profile 配置指定，已按 env 生效（env=…，profile=…）`。

### 修复与配置

- **切换闸（P0）**：`POST /api/deck-studio.data-dir` 切换窗口内的新请求立即返回
  `409 {"error":{"code":"switching"}}`（不排队——排队会把毫秒窗口放大成超时）；切换失败回滚配置、
  注册表与指针文件，不留「指针指到坏目录」的半截状态。

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
