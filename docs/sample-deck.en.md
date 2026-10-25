# Sample deck: run the first pipeline with the Deckline product handbook

The repository ships a 10-page sample deck source: [`samples/deckline-intro/`](../samples/deckline-intro/).
It describes what Deckline is, why it exists, how to use it and how to install it — and doubles as an
end-to-end check of the whole loop:
**new deck → agent drafts intent/script → confirm → render page by page → governance docs → export**.

> Key point: **the content is entered in the "＋ New Deck" dialog on the home page**, not pasted into chat
> afterwards. The dialog fields are carried into the planning prompt sent to the agent; the agent drafts
> intent / script and you only confirm the diffs.

Field cheat sheet (copy-paste ready): [`samples/deckline-intro/popup.md`](../samples/deckline-intro/popup.md).

> **Language note**: the workbench UI is currently Chinese-first (English UI strings are on the roadmap).
> For this walkthrough, keep the Chinese values below — they are what the dialog and the agent expect.

## Step 1: "＋ New Deck" on the home page, fill the fields

| Field | Value |
|---|---|
| **Topic / title** | `Deckline 产品说明手册` |
| **Project directory name** (optional) | `deckline-intro` |
| **Audience / users** | `第一次接触 Deckline 的人：会用 DSH、做分享材料的产品 / 咨询 / 培训 / 内容创作者；被「改稿、版本、找不到图」折磨过的人。` |
| **What to talk about** | `一句话：Deckline 不是又一个 PPT 编辑器，而是把「讲给谁、讲什么、怎么出图」变成一条可追踪的产线——Chat 里讨论、工作台里逐页出图、风格可复用、源文件只读。` |
| **Intent / takeaways** | `① 记住三句话：Chat 里讨论、工作台里出图、源文件只读；② 愿意按 README 花 5 分钟装一个并跑通第一个 deck；③ 知道边界：一期只做 image deck，出图按页、可点名批量连出，不碰 HTML deck。` |
| **References** (optional) | Copy the whole "real material list" below (README / docs / code paths / screenshots / logo; see [`samples/deckline-intro/materials.md`](../samples/deckline-intro/materials.md)) |
| **Style** | Pick the preset **`FYI · 高端深色（玻璃质感）`**; to switch, deselect then pick `BIZ` or `SWS`, or write a custom description |

**References · one-page summary + real material + links (copy the whole block into the References field)**:

> These are the **real materials** in the repository (a one-page fact summary + README / product docs /
> code paths / preset styles / logo / screenshots / links), not a hand-designed 10-page outline. Which
> material feeds which page: [`samples/deckline-intro/materials.md`](../samples/deckline-intro/materials.md).

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


## Step 2: click "创建并开始对话"

After submitting, the plugin does three things automatically (**no need to paste an outline into chat**):

1. Creates the deck source directory and the skeletons of the 7 required documents (intent / script /
   design / changelog / feedback / research / materials);
2. Opens a conversation for the deck and sends the **audience / topic / intent / references / style** as a
   planning prompt to the agent;
3. The agent restates the goal, lists what it still needs from you → completes intent → drafts the script
   (it does not render images yet).

What you do:

- Review the intent diff in the **middle workspace** → confirm (a revision is only written after
  confirmation);
- Review the script draft diff: titles ≤20 characters, conclusions stated directly, every page has a
  visual note → confirm;
- Keep talking to the agent if anything is off; changes go through the same diff → confirm flow.

## Step 3: render (named batches welcome)

- Pick the render node on the right, then say "render P01 first" or "render P01–P10": a named batch counts as
  confirmed and the agent renders in sequence; each page keeps its own image and revisions, so a failed page can
  be retried on its own;
- Unhappy with a page? Ask for a prompt change and re-render — **old revisions are kept**, roll back anytime;
- Use the **Design / changelog / governance** tabs to inspect documents and revisions along the way;
- When done: `导出` (export) → PDF / PPTX / handoff package (script + prompts + page images + 7 documents + events).

## Expected result

- A 10-page full-image deck with a consistent style (the sample uses dark glass);
- Every page has its prompt, image, revision and events, and can roll back to any revision;
- All 7 governance documents present, ready to hand off to the next person;
- You have run the whole "new → confirm → render → export" loop — that is the core of Deckline.

## Notes

- The sample deck source lives in [`samples/deckline-intro/`](../samples/deckline-intro/); you can register
  it in the profile's `decks[]` as a public demo (see [install.md](install.md) section 2);
- Samples illustrate the style; for text-heavy pages prefer "little text / English placeholders", and
  overlay exact text after rendering;
- A failed or re-run render never affects old revisions, and the source deck directory stays read-only.
