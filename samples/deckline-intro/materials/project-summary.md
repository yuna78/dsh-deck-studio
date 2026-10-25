# Deckline 一页事实摘要

> 给 Agent / 给第一次接触 Deckline 的人。
> 写《Deckline 产品说明手册》时，**事实只引用本摘要 + [`materials.md`](../materials.md) 里列的材料**；
> 本摘要没写的内容，回查来源文件或问用户，不要编。

## 1. 一句话

Deckline 是 **DSH（DeepSeek Harness）的 image deck 工作台插件**：左边 DSH 原生 Chat、中间 deck 工作区、
右边资料库 / 设计风格 / 资源库 / 会话；把「讲给谁、讲什么、怎么出图」做成一条可追踪的产线，
不是又一个 PPT 编辑器。
（来源：`README.md`）

## 2. 用户问题（为什么做）

- 想法在聊天、稿子在 PPT、图在另一个工具里，上下文断裂；
- 改稿频繁，但版本、原因、影响了哪几页说不清；
- 风格不可复用，每份 deck 都重新描述画面语言；
- 换人接手要重翻聊天记录，交接成本高。
（来源：`README.md`、`docs/productization.md`）

## 3. 工作台三段式

- **左**：DSH 原生 Chat —— 讨论、提案、确认，对话就是操作入口；
- **中**：deck 工作区 —— 整页图片 storyboard、逐页画面说明、版本、样张墙；
- **右**：资料库 —— 受控源文件、历史 / 事件、Inspector、设置（出图节点 / 模型 / 尺寸）。
（来源：`README.md`、`docs/sample-deck.md`）

## 4. 核心闭环

`intent（意图）→ script（逐页脚本提案）→ 用户确认 → revision（新版本，不覆盖旧版）→
单页 image prompt → QA 门禁 → 出图 → 治理文档 / 修改日志 → 导出（PDF / PPTX / 交接包）`。

- 任何改动先提案、看 diff，用户确认后才落版本；
- 出图**按页留痕**，可点名批量 / 整份连出；
- 每页保留 prompt、图片、版本、QA 和事件，可回退。
（来源：`README.md`、`CHANGELOG.md`、`docs/productization.md`）

## 5. 两种实体（别混）

- **deck**：一份交付物 —— 整页图 + 7 份治理文档 + 治理分；
- **design（风格）**：一份可复用的视觉资产 —— 风格描述 + 样张，有自己的 0 页画布；
  deck 可以关联一个 design，换 deck 也能复用同一风格。
（来源：`docs/styles.md`、`docs/sample-deck.md`）

## 6. 一期边界（不做什么）

- 只做 image deck（整页图片）；不做 HTML deck 渲染器（另立项目）；
- 不做 PPT 原生图层编辑；不默认批量出整套图；
- 源 deck 目录**只读**；编辑产物写本地 `.deck/`（已 gitignore，不进仓库）；
- 暂不做多人实时协作 / 云端账户 / 复杂权限。
（来源：`README.md`、`docs/productization.md`、`CHANGELOG.md`）

## 7. 关键数字（可引用）

- **7 份**治理文档：意图 / 脚本 / Design / 修改日志 / 反馈 / 调研 / 支撑材料；
- **8 个**预设风格：BIZ / FYI / JPN / EDT / TEC / SKT / SWS / GRD，每个带真实样张；
- 出图按页、版本 copy-on-write（旧版本保留）；
- README 安装路径：建 profile → 装插件 → 配置 → 启动，约 **5 分钟**；
- 许可 **MIT**；npm 包名 **dsh-plugin-deck-studio**；版本 **v0.1.0**。
（来源：`CHANGELOG.md`、`docs/styles.md`、`README.md`、`docs/productization.md`）

## 8. 安装与配置（给 P08 用）

- 前置：Node.js ≥ 20、pnpm 10+、DSH ≥ 0.1.7；
- 三条命令：建 `deckline` profile → `dsh plugin add` 装插件 → 启动；
- 生图 key 放 env 或 key 文件（`apiKeyEnv` / `apiKeyFile`），不进仓库；界面只显示是否配置；
- 没有 key 也能用 `fake` 模式跑通流程。
（来源：`README.md`、`docs/install.md`）

## 9. 链接（写 P04 / P07 / P08 时可引用）

| 类型 | 链接 |
|---|---|
| 公开仓库 | `https://github.com/yuna78/dsh-deck-studio`（发布后可用；现在真机测试用本仓库相对路径） |
| 项目摘要 | `samples/deckline-intro/materials/project-summary.md`（本文） |
| 文档 | `README.md` · `docs/productization.md` · `docs/install.md` · `docs/styles.md` · `docs/sample-deck.md` · `CHANGELOG.md` |
| 代码入口 | `plugin/deck-studio/index.js`（路由 / 数据契约）· `plugin/deck-studio/lib/`（工作区 / 文档 / 出图 / 风格 / Agent 工具）· `plugin/deck-studio/ui/`（三栏 UI） |
| 预设风格 | `plugin/deck-studio/seeds/styles/*.json` · `plugin/deck-studio/seeds/samples/*.jpg` |
| 品牌 | `assets/logo/`（logo svg / png / mark） |
| 截图 | `samples/deckline-intro/materials/screenshots/01-workbench-deck.png` · `02-home-decks.png` · `03-home-designs.png` · `04-new-deck-popup.png` |
| 现成逐页稿 | `samples/deckline-intro/script.md` · `samples/deckline-intro/intent.md`（10 页结构参考，可改写） |

## 10. 写作纪律（给 Agent）

- 只引用本摘要、`materials.md` 材料、`script.md` 现成稿里的事实；
- 缺的数字 / 案例 / 客户 / URL **不要编**：回查来源文件，或写「待补」/问用户；
- 每页在备注里写来源文件（如 `P05 ← README.md`），方便用户核对；
- 标题 ≤ 20 字、直接写结论、每页带画面说明；
- 不写真实客户名、不写内部路径、不写 key。
