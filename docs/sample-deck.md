# Sample deck：用《Deckline 产品说明手册》跑通第一条产线

简体中文 · [English](sample-deck.en.md)

仓库自带一个 10 页示例 deck：[`samples/deckline-intro/`](../samples/deckline-intro/)——含逐页脚本、每页 prompt、
10 张已渲染的示例页（`pages/`）和同一份结果的 PPTX（`deckline-intro.pptx`），可以直接看效果再复刻。
它介绍 Deckline 自己是什么、为什么做、怎么用、怎么装——顺便用来验证整条闭环：
**新建 Deck → Agent 起草 intent/script → 确认 → 逐页出图 → 治理文档 → 导出**。

> 关键：**内容是在首页「＋ 新建 Deck」弹窗里填的**，不是你事后往 Chat 里粘一大段话。
> 弹窗里的字段会被插件带进给 Agent 的整理 prompt，Agent 接着起草 intent / script，你只负责确认 diff。

弹窗字段速查（可直接复制）：[`samples/deckline-intro/popup.md`](../samples/deckline-intro/popup.md)。

## 第 1 步：首页「＋ 新建 Deck」，按下面逐字段填

| 字段 | 填什么 |
|---|---|
| **主题 / 标题** | `Deckline 产品说明手册` |
| **项目目录名**（可选） | `deckline-intro` |
| **受众 / 用户** | `第一次接触 Deckline 的人：会用 DSH、做分享材料的产品 / 咨询 / 培训 / 内容创作者；被「改稿、版本、找不到图」折磨过的人。` |
| **想讲什么话题** | `一句话：Deckline 不是又一个 PPT 编辑器，而是把「讲给谁、讲什么、怎么出图」变成一条可追踪的产线——Chat 里讨论、工作台里逐页出图、风格可复用、源文件只读。` |
| **意图 / 希望大家带走什么** | `① 记住三句话：Chat 里讨论、工作台里出图、源文件只读；② 愿意按 README 花 5 分钟装一个并跑通第一个 deck；③ 知道边界：一期只做 image deck，出图按页、可点名批量连出，不碰 HTML deck。` |
| **参考资料**（可选） | 见下方「真材料清单」整段复制（README / docs / 代码路径 / 截图 / logo，详见 [`samples/deckline-intro/materials.md`](../samples/deckline-intro/materials.md)） |
| **风格** | 点选 preset **`FYI · 高端深色（玻璃质感）`**；想换就取消再点 `BIZ` 或 `SWS`，也可以自定义描述 |

**参考资料 · 一页摘要 + 真材料 + 链接（整段复制进「参考资料」框）**：

> 这里给的是仓库里的**真实材料**（一页事实摘要 + README / 产品文档 / 代码路径 / 预设风格 / logo / 截图 / 链接），
> 不是「我设计好的 10 页大纲」。每份材料用在哪一页见 [`samples/deckline-intro/materials.md`](../samples/deckline-intro/materials.md)。

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
  docs/styles.md —— 9 个预设风格 + 自定义风格方法
  docs/sample-deck.md —— 用示例 deck 跑通流程（本页步骤来源）

【2. 代码（真实链接）】
  plugin/deck-studio/index.js —— 宿主路由与数据契约（workbench / deck-create / page-render / doc / export…）
  plugin/deck-studio/lib/ —— deck 工作区 / 9 份治理文档 / 出图与 revision/QA / 风格 / Agent 工具
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


## 第 2 步：点「创建并开始对话」

提交后插件会自动做三件事（**不需要你再粘 Chat 稿**）：

1. 建好 deck 源目录 + 9 份必备文档骨架（intent / script / design / 修改日志 / 反馈 / 调研 / 支撑材料 / 审稿 / 事实核对）；
2. 自动打开这个 deck 的会话，把**受众 / 话题 / 意图 / 参考资料 / 风格**拼成一条整理 prompt 发给 Agent；
3. Agent 先复述目标、列出还要你补的资料 → 补完整 intent → 起 script 草案（不直接出图）。

你要做的只有：

- 看 **中间工作区** 的 intent diff → 确认（确认后才落 revision）；
- 看 script 草案 diff：标题 ≤20 字、直接写结论、每页有画面说明 → 确认；
- 不满意就继续和 Agent 说，改动同样走 diff → 确认。

## 第 3 步：出图（可点名批量）

- 右侧出图节点选好后，说「先出 P01」或「把 P01–P10 都出一下」：点名多页 = 已确认，Agent 按页序连续出；
  每页一张整页图、各自留版本，失败只重出那一页；
- 不满意就让它改 prompt 重出，**旧版本会保留**，可随时回退；
- 中途切 **Design / 修改日志 / 治理** 标签检查文档和版本；
- 全部出完：`导出` → PDF / PPTX / 交接包（script + prompt + 每页图 + 9 份文档 + 事件）。

## 期望结果

- 10 页整页图片 deck，风格统一（示例是深色玻璃质感）；
- 每页都有 prompt、图片、版本、事件记录，能回退到任意一版；
- 治理文档 9 份齐备（含审稿 / 事实核对），可直接交接给下一个人；
- 你已经把「新建 → 确认 → 出图 → 导出」完整跑了一遍——这就是 Deckline 的全部核心操作。

## 说明

- 示例 deck 源在 [`samples/deckline-intro/`](../samples/deckline-intro/)，可以注册进 profile 的 `decks[]`
  当公开演示（见 [install.md](install.md) 第 2 节）；
- 样张是风格示意；文字多的页建议「少字 / 英文占位」，精确文字可在出图后叠字；
- 一次失败/重出不影响旧版本，源 deck 目录始终只读。
