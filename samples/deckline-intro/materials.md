# Sample deck 的真实材料包（给 Agent 写作用）

写《Deckline 产品说明手册》不要凭空编。下面这些**都是本仓库里的真实文件**：一页事实摘要、
README、产品文档、代码路径、预设风格定义与样张、品牌 logo、产品截图。
把清单贴进首页「＋ 新建 Deck」弹窗的**参考资料**字段（或第一次对话时让 Agent 先读这个文件），
Agent 再据此起草 intent / script。

> 不要再把「我设计好的 10 页大纲」当材料——大纲是设计稿，不是事实来源。材料是下面这些。

## 贴进弹窗「参考资料」的整段（复制即用）

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
  plugin/deck-studio/lib/deck-workspace.js —— deck 工作区与源目录只读规则
  plugin/deck-studio/lib/deck-docs.js —— 7 份治理文档骨架
  plugin/deck-studio/lib/render.js —— 出图 / revision / QA 门禁
  plugin/deck-studio/lib/designs.js —— 风格（design）定义与样张
  plugin/deck-studio/lib/tools.js —— Agent 工具（deck_* / design sample）
  plugin/deck-studio/ui/workbench.html · workbench.css · client.js —— 三栏 UI 结构与入口
  plugin/deck-studio/seeds/styles/*.json · seeds/samples/*.jpg —— 8 份预设风格定义与样张

【3. 品牌与截图】
  assets/logo/deckline-logo.svg|png · deckline-mark.svg|png —— 品牌 logo（封面 / 内页可用）
  samples/deckline-intro/materials/screenshots/01-workbench-deck.png —— 工作台（storyboard + 资料库）
  samples/deckline-intro/materials/screenshots/02-home-decks.png —— 首页 Decks
  samples/deckline-intro/materials/screenshots/03-home-designs.png —— Designs 风格库
  samples/deckline-intro/materials/screenshots/04-new-deck-popup.png —— 新建 Deck 弹窗

【4. 现成稿（结构参考，可改写）】
  samples/deckline-intro/script.md · intent.md —— 这套示例 deck 已写好的 10 页逐页稿

【5. 链接】
  公开仓库（发布后）：https://github.com/yuna78/dsh-deck-studio
  现在真机测试：用上面这些「仓库相对路径」即可（Agent 的 cwd 就是本仓库根目录）

写法要求：先复述你读到的产品定位（一句话 + 三个痛点 + 边界），再起 10 页 script；
每页直接写结论、标题 ≤20 字、带画面说明、备注来源文件（如 P05 ← README.md）；
不确定的事实回查上面文件或问我，不要编造数字 / 客户 / 案例 / URL。
```

## 链接怎么给（本地 / 公开后）

| 场景 | 链接形式 |
|---|---|
| 现在真机测试 | **仓库相对路径**：`README.md`、`docs/install.md`、`plugin/deck-studio/index.js`…（Agent 的 cwd 就是本仓库根目录） |
| 公开仓库发布后 | `https://github.com/yuna78/dsh-deck-studio/blob/main/<相对路径>`，例如 `…/blob/main/docs/install.md`；仓库根本身 `https://github.com/yuna78/dsh-deck-studio` |
| 只想给「总结」 | `samples/deckline-intro/materials/project-summary.md`（一页事实摘要，自带来源标注） |

> 注意：`docs/architecture.md`、`docs/product-brief.md`、`CURRENT.md`、`HANDOVER.md` 是**内部文档，
> 不随公开包分发**；它们里的关键事实已经浓缩进 `project-summary.md`，公开材料里只链接上面列出的文件。
> 公开仓库还没 push（负责人发布动作），所以现在先用本地相对路径；发布后把路径替换成 GitHub URL 即可。

## 材料明细（每份用在哪一页）

| 材料 | 真实路径 | 用途 |
|---|---|---|
| 一页事实摘要 | [`materials/project-summary.md`](materials/project-summary.md) | P01–P10 的事实底座（先读这个） |
| README | [`README.md`](../../README.md) | P01 封面定位、P03 一句话定义、P10 上手三步 |
| CHANGELOG | [`CHANGELOG.md`](../../CHANGELOG.md) | P09 已支持 / 未支持、v0.1.0 |
| 产品化文档 | [`docs/productization.md`](../../docs/productization.md) | P03 定位、P09 边界、P10 路线图与许可 |
| 安装文档 | [`docs/install.md`](../../docs/install.md) | P08 安装 / 配置 / key / fake 模式 |
| 风格目录 | [`docs/styles.md`](../../docs/styles.md) | P06 风格是资产（8 预设 + 自定义） |
| 示例流程 | [`docs/sample-deck.md`](../../docs/sample-deck.md) | P10 上手三步（本页流程的完整版） |
| 代码（宿主） | [`plugin/deck-studio/index.js`](../../plugin/deck-studio/index.js) | P04 / P05 的真实路由与数据契约 |
| 代码（工作区/文档/出图） | [`plugin/deck-studio/lib/`](../../plugin/deck-studio/lib/) | P04 / P05 / P07 只读源、文档骨架、出图与治理 |
| 代码（UI） | [`plugin/deck-studio/ui/`](../../plugin/deck-studio/ui/) | P04 三栏工作台截图对应实现 |
| 预设风格定义 | [`plugin/deck-studio/seeds/styles/`](../../plugin/deck-studio/seeds/styles/) | P06 风格卡 / 样张语言 |
| 预设样张 | [`plugin/deck-studio/seeds/samples/`](../../plugin/deck-studio/seeds/samples/) | P06 配图、也说明「候选图」标准 |
| 品牌 logo | [`assets/logo/`](../../assets/logo/) | P01 封面 / 页脚 logo |
| 产品截图 | [`materials/screenshots/`](materials/screenshots/) | P04 / P06 / P08 插图（demo 假数据渲染，不含客户信息） |
| 示例逐页稿 | [`script.md`](script.md) · [`intent.md`](intent.md) | 结构参考（10 页怎么排） |

## 用法 A：从弹窗新建（推荐）

1. 首页点「＋ 新建 Deck」；
2. 标题 / 目录名 / 受众 / 话题 / 意图按 [`popup.md`](popup.md) 填；
3. 参考资料：把上面「贴进弹窗」的整段粘进去；
4. 风格：选 `FYI`（或 `BIZ` / `SWS`），点「创建并开始对话」。

## 用法 B：已有会话里补材料

在 Chat 里说一句：

```text
先读 samples/deckline-intro/materials/project-summary.md 和 materials.md，再按里面的真实材料写 10 页 script；
不要编产品定位，引用事实时回查对应文件，每页备注来源。
```

## 注意

- 这些材料里没有客户名、客户数据、个人路径、API key —— 可以直接贴给 Agent；
- 截图是 **demo 模式**用虚构 deck 渲染的，样张取自插件自带的公开预设图，不含任何客户内容；
- 代码路径按本仓库根目录相对路径读写；Agent 的 cwd 就是本仓库时可直接读；
- 材料清单里的路径都在公开打包白名单内（`samples/`、`docs/` 四份对外文档、`plugin/`、`assets/logo/`），
  发布版里同样存在；内部文档不在其中，事实已收进 `project-summary.md`。
