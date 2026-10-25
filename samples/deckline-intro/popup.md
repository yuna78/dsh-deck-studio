# 「＋ 新建 Deck」弹窗：字段速查（复制即用）

首页左下 **＋ 新建 Deck**，按下表填（详细步骤见 [docs/sample-deck.md](../../docs/sample-deck.md)）。

## 主题 / 标题

```text
Deckline 产品说明手册
```

## 项目目录名（可选）

```text
deckline-intro
```

## 受众 / 用户

```text
第一次接触 Deckline 的人：会用 DSH、做分享材料的产品 / 咨询 / 培训 / 内容创作者；被「改稿、版本、找不到图」折磨过的人。
```

## 想讲什么话题

```text
一句话：Deckline 不是又一个 PPT 编辑器，而是把「讲给谁、讲什么、怎么出图」变成一条可追踪的产线——Chat 里讨论、工作台里逐页出图、风格可复用、源文件只读。
```

## 意图 / 希望大家带走什么

```text
① 记住三句话：Chat 里讨论、工作台里出图、源文件只读；② 愿意按 README 花 5 分钟装一个并跑通第一个 deck；③ 知道边界：一期只做 image deck，出图按页、可点名批量连出，不碰 HTML deck。
```

## 参考资料（一页摘要 + 真材料 + 链接，整段复制）

> 不再给「我设计的 10 页大纲」，而是：**一页事实摘要 + 仓库真实文件 + 代码/文档链接**。
> 完整说明见 [`materials.md`](materials.md)，摘要见
> [`materials/project-summary.md`](materials/project-summary.md)。

```text
项目材料（都在本仓库，请先读再写；事实以这些为准，不要编）：

【0. 先读】samples/deckline-intro/materials/project-summary.md —— 一页事实摘要：
  定位 / 用户问题 / 三段式工作台 / 核心闭环 / deck 与 design / 一期边界 / 关键数字 / 安装 / 许可 / 链接。
  （摘要每条都标了来源；摘要没写的，回查来源文件或问我，不要自己编。）

【1. 文档（真实链接）】
  README.md —— 产品定位 / 三段式 / 5 分钟安装 / 命令
  CHANGELOG.md —— v0.1.0 能力清单与边界
  docs/productization.md —— 产品化定位、路线图、发布范围、一期边界
  docs/install.md —— 安装、profile 配置、出图节点与 key 放置、fake 模式
  docs/styles.md —— 8 个预设风格 + 自定义风格方法
  docs/sample-deck.md —— 用示例 deck 跑通流程（本页步骤来源）

【2. 代码（真实链接）】
  plugin/deck-studio/index.js —— 宿主路由与数据契约（workbench / deck-create / page-render / doc / export…）
  plugin/deck-studio/lib/ —— deck 工作区 / 7 份治理文档 / 出图与 revision/QA / 风格 / Agent 工具
  plugin/deck-studio/ui/ —— 三栏 UI 结构（workbench.html · workbench.css · client.js）
  plugin/deck-studio/seeds/styles/*.json · seeds/samples/*.jpg —— 8 份预设风格定义与样张

【3. 品牌与截图】
  assets/logo/ —— 品牌 logo（封面 / 内页可用）
  samples/deckline-intro/materials/screenshots/01~04.png —— 工作台 / 首页 Decks / Designs / 新建 Deck 弹窗

【4. 现成稿（结构参考，可改写）】
  samples/deckline-intro/script.md · intent.md —— 这套示例 deck 已写好的 10 页逐页稿

【5. 链接】
  公开仓库（发布后）：https://github.com/yuna78/dsh-deck-studio
  现在真机测试：用上面这些「仓库相对路径」即可（Agent 的 cwd 就是本仓库根目录）

写法要求：先复述你读到的产品定位（一句话 + 三个痛点 + 边界），再起 10 页 script；
每页直接写结论、标题 ≤20 字、带画面说明、备注来源文件（如 P05 ← README.md）；
不确定的事实回查上面文件或问我，不要编造数字 / 客户 / 案例 / URL。
```

## 风格

- 点选 preset：**FYI · 高端深色（玻璃质感）**（推荐）；或 `BIZ` 商务蓝灰 / `SWS` 瑞士极简黑白红；
- 自定义：先再点一次取消选中，然后在「自己描述风格」框写，例如：
  `深色玻璃质感：近黑炭底、半透明玻璃面板、紫青极光、香槟金细线；信息密度低、留白大；不要 3D、不要照片、不要 logo。`

## 提交之后

点 **「创建并开始对话」**：插件会建好源目录 + 7 份文档骨架，并自动把上面这些字段作为整理 prompt 发给 Agent
（先复述目标 → 补 intent → 起 script 草案，不直接出图）。你只需要确认 intent / script 的 diff，然后一页一页出图。
