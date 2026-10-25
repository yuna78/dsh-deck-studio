# 安装与配置（Deckline · DSH 插件）

简体中文 · [English](install.en.md)

Deckline（`dsh-plugin-deck-studio`）是 DeepSeek Harness（DSH）的 **image deck 工作台插件**：
左侧 DSH 原生 Chat、中间整页图片 deck 工作区、右侧资料库 / Designs / 资源库 / 会话。
它不是独立 App，必须挂在 DSH 的 profile 上运行。

> 目标用户：用 DSH 做内容/演示的人。装完后你可以：读 script 改 deck、按页出图（可点名批量连出）、管理治理文档、
> 登记自己的设计风格（上传样张），并用 8 个预设风格直接开工。

## 0. 前置条件

插件0.2.6起需要 DSH 0.2.1-rc.2 或更新的0.2.x；升级后重启 DSH。若手写 profile 仍声明 `preset-deck-critic`，请移除；旧 `review.presetId` 已忽略，评审改由插件内部调度，不需选审稿模式。

| 依赖 | 版本 | 说明 |
|---|---|---|
| Node.js | `^22.19` 或 `≥ 24` | 与 DSH 运行时一致；Node 23 不在支持范围 |
| pnpm | 10+ | DSH 用 pnpm 管理 profile 依赖 |
| DSH | `≥ 0.2.1-rc.2 < 0.3`（插件0.2.6起） | **用 npm 全局安装的发行版**：`npm i -g @deepseek-ai/dsh@0.2.1-rc.2`；已验证 0.2.1-rc.2，见 [compat.md](compat.md)。从源码自编译的 dsh 若缺内置包（如 `@deepseek-ai/dsh-agent-preset`）会启动失败，见 4.3 |
| 一个 LLM provider key | — | 例：`DEEPSEEK_API_KEY` / `OPENAI_API_KEY`（profile 里配置，见 DSH 文档） |
| 一个 image 节点 key | — | 生成整页图用；可先用 fake 模式体验（见第 4 节） |

```sh
node -v && pnpm -v && dsh --version
```

## 1. 安装（三种方式，选一种）

### A. 从 npm 安装（推荐，所有人同一条命令）

> 在 [npmjs.com](https://www.npmjs.com/) 搜 `deckline` 或 `ppt dsh` 也能找到本包（关键词已含 PPT / PPTX / PowerPoint / 幻灯片）。

```sh
# 1) 建一个 deckline profile（基于 DSH 自带 web 模板）
dsh --profile deckline --from-default-profile web

# 2) 装插件；dsh plugin add 会自动把组合包加入 profile 并默认启用
dsh plugin --profile deckline add dsh-plugin-deck-studio@0.2.4
```

> 国内网络直连 `registry.npmjs.org` 可能很慢（20 MB 包实测约 19 KB/s，要十几分钟）。换镜像会快很多：
> ```sh
> npm_config_registry=https://registry.npmmirror.com dsh plugin --profile deckline add dsh-plugin-deck-studio@0.2.4
> ```
> 或一次性 `npm config set registry https://registry.npmmirror.com`。

### A2. 从 DSH 插件市场安装（图形化，等价于 A）

DSH 目前没有官方插件市场，市场是「索引源」模式：添加下面这个索引，就能在「插件 → 发现」里搜到 Deckline 并安装。

1. 侧栏 **插件** → 「实验性插件」旁 **更多** → 启用 **自定义插件市场**；重新打开插件页，出现 **发现** 标签。
2. **发现** → **添加索引源**，填：

   ```
   https://cdn.jsdelivr.net/gh/yuna78/dsh-deck-studio@main/market-index.json
   ```

   国内网络用上面这条；能直连 GitHub 也可以用：

   ```
   https://raw.githubusercontent.com/yuna78/dsh-deck-studio/main/market-index.json
   ```

3. 搜索 `Deckline` 或 `PPT` → **安装**，会安装 `dsh-plugin-deck-studio@0.2.4`（索引里声明了国内镜像 registry）。
4. 之后同 A 的第 3 步启动。

索引文件就是仓库根目录的 [`market-index.json`](../market-index.json)（格式 1），新版本发布后更新版本号即可。

> 注意：DSH 的实验性插件市场是可选组件，版本需与当前 DSH 配套。若「发现」页提示市场组件不兼容（或插件被自动禁用），
> 直接用上面的 A（npm 命令）安装，效果相同。


### B. 从 Git 仓库安装（可选；仓库未公开时需要 GitHub 权限）

```sh
dsh --profile deckline --from-default-profile web
dsh plugin --profile deckline add "github:<你的账号>/dsh-deck-studio#path:/plugin/deck-studio"
```

> pnpm 对 git 子目录的支持随版本变化；如果 `#path:` 报错，用方式 C（clone 后本地安装）最稳。

### C. 本地 clone 安装（开发 / 调试推荐）

```sh
git clone https://github.com/<你的账号>/dsh-deck-studio.git
cd dsh-deck-studio
pnpm install --ignore-scripts   # 可选：只跑插件的话可跳过

dsh --profile deckline --from-default-profile web
dsh plugin --profile deckline add "$PWD/plugin/deck-studio"
```

安装完成后检查：

```sh
dsh --profile deckline --dump-config | grep -n "deck-studio" | head
```

看到 `deck-studio` 与 `preset-deck-studio` 两行即安装成功。

## 2. 首次配置：decks / 工作区 / 端口

Deckline 的配置都在 **profile patch 层**：`~/.dsh/profiles/deckline/cordis.patch.yml`。
仓库里给了可直接抄的样例：[`plugin/deck-studio/cordis.example.yml`](../plugin/deck-studio/cordis.example.yml)。

最少需要（追加到 profile 的 `cordis.patch.yml` 末尾）：

```yaml
# 你的 deck 源目录（只读引用；可以是任意已有 deck 目录）
- id: deck-studio
  name: 'dsh-plugin-deck-studio'
  config:
    displayName: 'Deckline'
    userName: ''            # 留空 = 首页只显示「欢迎你」；填了就显示「XX，欢迎你」
    # 新建 deck 源文件根：留空 = <dataRoot>/projects/<deck-id>/source
    projectsRoot: '/absolute/path/to/your/decks'
    # workspacePath: '/absolute/path/to/your/workspace'  # DSH 会话工作区，不是保存位置
    decks:
      - id: my-deck
        label: '我的 deck'
        sourceRoot: '/absolute/path/to/my-deck'
```

> `decks[].sourceRoot` 是受控源，始终只读：Deckline 不会写入它；编辑工作副本、版本和出图落在 `dataRoot`。
> 通过「＋ 新建 Deck」创建的本机 deck 是另一种情况：用户确认后，script / intent 等源文件可以回写到该本机项目目录。
> 没有现成 deck 也可以先用「＋ 新建 Deck」建一个。

### 每个 deck 的项目规则（可选）

在 deck 项目根放一个 `deck.rules.md`，就这份 deck 的创作约束写清楚（受众、禁忌、品牌、必须遵守的事实），
Deck Agent 每次 `deck_source_overview` 时会读到并遵守：

```md
# 项目规则
- 受众：公司内部业务与 IT，不假设技术背景
- 禁忌：不承诺未经验证的效率数字；不点名真实客户
- 视觉：米白纸张 + 彩铅，不要 3D
```

- 只约束**这一份 deck**，不影响其他 deck；不写就等于没有规则（可选能力）。
- 它**不能覆盖**产品硬纪律（客户源只读 / QA 门禁 / 不编造 / 需用户确认）——冲突时以硬纪律为准，Agent 会说明。
- 上限 8 KB；读取时不会回写，也不会因为文件内容自动执行任何操作。
- 不叫 `AGENTS.md`：`AGENTS.md` 属于 DSH 的工作区指令，Deckline 不依赖它。

## 2.5 数据在哪里：源 deck / 文档 / 图片 / 导出

Deckline 的数据分两处：**你的 deck 源**（`projectsRoot`，纯 md + 源图）和**运行数据**（`dataRoot`，
工作副本 / 出图 / 事件）。新建 deck 后找不到文件时，先看这张表。

| 内容 | 位置 | 说明 |
|---|---|---|
| 新建 deck 的源文档 | `<projectsRoot>/<目录名>/` | `intent.md` / `script.md` / `style-reference.md`；确认后的 `docs/*.md` 回写到这里；`prompts/`、`pages/`、`outputs/` 同层 |
| 工作副本 + 治理文档 | `<dataRoot>/decks/<deckId>/docs/` | changelog / feedback / research / materials / review / fact-check 等；确认前只在这里 |
| script 全文 revision | `<dataRoot>/decks/<deckId>/script/revisions/vNNN.md` | copy-on-write，`current.md` 始终最新 |
| 出图整页图片 | `<dataRoot>/decks/<deckId>/slides/<pageId>/versions/<vNNN>/image.png` | 每版一目录，同放 `prompt.txt` / `content.json` / `qa.json`；旧版本不覆盖 |
| 风格样张 | `<dataRoot>/projects/<canvasDeckId>/source/designs/<ABBR>/sample-vNNN.png`（或你放的 `designs/<ABBR>/`） | 界面里导入 / 粘贴的样张 |
| 导出包 | 浏览器下载目录 | 「导出」生成的 zip（PDF / PPTX / 交接包），不写进上面两处 |

- **`dataRoot` 默认 `$DSH_HOME/deckline`**（通常是 `~/.dsh/deckline`）——不在插件包里，升级插件不会覆盖；
  可在 profile patch 配 `dataRoot: '/your/path'`，或环境变量 `DSH_DECK_DATA_ROOT` 覆盖。
- **`projectsRoot`** 决定本机新建 deck 的源文件落在哪；不配置时落在 `<dataRoot>/projects/<deckId>/source`。它不决定聊天会话绑定的工作区。
- **`workspacePath`** 只决定会话绑定哪个 DSH workspace，与 `projectsRoot` / `dataRoot` 相互独立；未配置时插件按启动目录和源目录自动选择工作区。
- **受控源 deck 只读**：`decks[].sourceRoot` 指向的已有 deck 目录，插件永远不写；本机新建 deck 在用户确认后可回写自己的源文件。
- **备份**：把 `dataRoot` 和 `projectsRoot` 一起打包即可（文档 + 图 + 事件都在里面）：
  ```sh
  tar czf deckline-backup-$(date +%Y%m%d).tgz "$DSH_HOME/deckline" "<你的 projectsRoot>"
  ```
- 工作台「设置」面板会显示当前数据目录；开发环境也建议使用独立的 `dataRoot`，不要把运行数据写进仓库。
- **preset 工具实例要和根挂载用同一个数据根**（F-98）：DSH 面板路由与 Agent 工具是两个实例，根挂载里覆盖了
  `dataRoot` / `projectsRoot` 时，preset 的 `deck-studio-tools` 也要写同一组值（推荐 YAML 锚点），
  否则新建 deck 只进一边的注册表，Agent 会报「未知 deck：…」。

## 3. 启动

```sh
dsh --profile deckline --port 13090
```

浏览器打开终端打印的 `http://127.0.0.1:13090/?token=…`。
`--port` 可换；不换默认 13090，避免和 DSH web profile 的 3080 冲突。

## 4. 配置生图 key（正式出图必看）

Deckline 支持：

- **fake 模式**（默认，不联网）：出占位 SVG，能完整体验流程；
- **real 模式**：调用 OpenAI 兼容的 `/v1/images/generations` 节点出真图。

> 插件**不内置任何出图节点地址**（provider 中立）：real 模式必须自己配 endpoint + key，
> 否则设置面板会提示「还没配地址 / key」，出图会明确报错而不是偷偷打到一个默认节点。

### 4.0 在界面里配（推荐，保存即生效）

不需要改 profile、不需要重启：

1. 打开工作台，进任意 deck（没有 deck 就先新建一个）；
2. 右栏点 **⚙ 设置**；
3. 填：**模式**（fake / real）、**生图节点 endpoint**、**模型**、**key 环境变量名**（或 **key 文件路径**）、**出图尺寸**；
4. 点 **保存并生效**。

保存后写入本机数据目录 `<dataRoot>/render-settings.json`（默认 `~/.dsh/deckline/render-settings.json`；
已 gitignore）：节点可直存 API key（0600，界面只显示「已保存」，payload 不回显），也可改用变量名 / key 文件；
下次启动自动生效，并覆盖 profile 里的 render 配置。

key 仍然只放本机：

```sh
export DSH_DECK_IMAGE_API_KEY="sk-…"      # 名字和设置页填的一致
```

> 设置页适合自己用；要把同一套配置分发给团队，再用下面的 profile patch。

### 4.1 用环境变量（最简单）

```sh
# 生图节点（任意 OpenAI 兼容中转都行）
export DSH_DECK_IMAGE_ENDPOINT="https://your-image-relay.example.com/v1/images/generations"
export DSH_DECK_IMAGE_MODEL="your-image-model"
export DSH_DECK_IMAGE_API_KEY="sk-…"          # 只放在你的 shell / 密钥管理里
```

### 4.2 用 profile patch（推荐：多节点 + 团队共享配置）

在 `~/.dsh/profiles/deckline/cordis.patch.yml` 里覆盖 `deck-studio` 的 render 配置：

```yaml
- id: deck-studio
  name: 'dsh-plugin-deck-studio'
  config:
    # …上面的 displayName / decks 保持
    render:
      mode: real
      size: '2560x1440'
      default: 'main/gpt-image-2.5-sunburst'
      nodes:
        - id: main
          name: '主节点'
          endpoint: 'https://your-image-relay.example.com/v1/images/generations'
          # 修图（deck_image_edit）用的 edits 端点；不填就由上面的 endpoint 派生
          # （/v1/images/generations → /v1/images/edits）。
          # editEndpoint: 'https://your-image-relay.example.com/v1/images/edits'
          # 中转只吃 JSON、不收 multipart 时改 json（默认 multipart）
          # editTransport: 'multipart'
          # 二选一：环境变量名，或本机 key 文件（KEY=VALUE 格式，chmod 600，永不进 git）
          apiKeyEnv: 'DSH_DECK_IMAGE_API_KEY'
          apiKeyFile: '~/.config/image-relay.env'
          models:
            - 'gpt-image-2.5-sunburst'
            - 'gpt-image-2'
```

要点：

- **key 不进仓库、不进 profile 的明文配置**：配置里只出现 `apiKeyEnv`（环境变量名）或 `apiKeyFile`（本机文件路径）。
- 工作台「设置」面板会显示每个节点的 **key 是否配置**（只显示布尔值和来源，不显示 key 本身）。
- 没配 key / 仍是 fake 模式时，设置面板会直接给出提示。
- 模型名填你的中转实际开放的模型；常见 OpenAI 兼容名 `gpt-image-2` 系列的模型 id 以节点 `/v1/models` 为准。
- 工作台「设置 → 出图节点」可以直接切换线路，也能**新增 / 编辑 / 删除节点**：填 名称 + 接口地址 + API Key +
  模型名即可（key 存本机 `<dataRoot>/render-settings.json`，0600，不进 git；也可改用 env / key 文件）；
  切换写当前 deck 的 `render-selection.json`，下一次出图生效，不用重启。
- **修图**（`deck_image_edit`）需要节点支持 `POST /v1/images/edits`（multipart：`image` + `prompt` + `size` + `model`）。
  回车节点通常和出图同源；不填 `editEndpoint` 就按上面的规则派生，派生不出来（自定义路径）时工具会明确报错、不猜地址。
  只吃 JSON 的中转设 `editTransport: 'json'`（底图转 data URL 放在 `image` 字段）。

## 5. 自己加 design（两种方式）

### 方式一：在界面里加（推荐，可以贴图）

1. 首页 → **Designs** → **＋ 添加风格**；
2. 填名称 / 缩写 / 画面描述（prompt 用）；
3. 在「样张图片」区 **直接 ⌘V 粘贴、拖入、或点选文件**（png/jpg/webp，可多张，≤12MB/张）；
4. 创建后会：建风格 + 0 页空白画布 + 一个 design 会话，样张立刻出现在 Designs 卡与预览里。

已有风格想补样张：点风格卡右上角 **眼睛** → 预览弹层底部「＋ 添加样张」，同样支持粘贴 / 选文件。

### 方式二：放文件到磁盘

样张存在 `designs/<ABBR>/` 下（ABBR 是你的风格缩写）：

- 画布目录（推荐）：`<dataRoot>/projects/<canvasDeckId>/source/designs/<ABBR>/`；
- 或任何受控 deck 源里的 `designs/<ABBR>/`（Deckline 会自动扫描并合并展示）。

放完刷新页面即可。支持 png / jpg / webp；命名随意（`sample-01.jpg` 之类便于排序）。

### 用预设风格（不用自己写 prompt）

Designs 页 **＋ 导入预设风格** 会一次导入 8 个自带风格（商务咨询 / 高端深色 fancy / 日系极简 /
杂志编辑 / 科技蓝图 / 手绘白板 / 瑞士极简 / 渐变极光），每个都带样张，见 [docs/styles.md](styles.md)。

## 6. 排障

| 现象 | 处理 |
|---|---|
| 端口被占 | `dsh --profile deckline --port 13100`；或 `lsof -tiTCP:13090 -sTCP:LISTEN` 杀掉旧进程 |
| 页面 404 / 白屏 | 确认插件组合包已启用：`dsh --profile deckline --dump-config \| grep deck-studio` |
| 没有「生图」按钮 / 出图失败 | 设置面板看 key 是否配置；确认 `render.mode: real`；节点 endpoint 可 `curl` 通 |
| 新 deck 目录落错位置 | 配 `projectsRoot`；否则落在 `<dataRoot>/projects/`（默认 `<DSH_HOME>/deckline/projects/`） |
| 数据 / 样张在哪 | 见 §2.5：源 deck 在 `projectsRoot`，工作副本 / 出图在 `dataRoot`（默认 `~/.dsh/deckline`） |
| 升级插件 | `dsh plugin --profile deckline install <spec>`，或重新 `add` 新版本 |

## 7. 开发者：本地验证

```sh
node plugin/deck-studio/verify/smoke.mjs        # 契约冒烟 46 项（无需网络与 key）
node scripts/harness-check.mjs                 # 指令链 / 链接 / 脱敏 / 台账门禁
dsh --profile deck-studio --no-open             # 本仓开发 profile（端口按本机配置）
```

插件无第三方运行时依赖（只用 Node 内置模块）；改 `plugin/deck-studio/index.js` 需要重启 profile，
只改 `ui/` 里的 html/css 会热更新。

## 2.5 首次启动会自动准备好什么（bootstrap）

装完第一次启动（DSH 0.2.x 会先弹一次 Preview Notice，点 **Continue** 即可），Deckline 默认做四件事：

| 现象 | 默认行为 | 不想要怎么办 |
|---|---|---|
| 左侧 DSH 外壳栏（工作区 / 会话） | 收起隐藏，只留 Deckline 导航 | profile 里 `hideShellSidebar: false` |
| Decks 页 | 自动登记 **Deckline 示例手册**（仓库 `samples/deckline-intro`，只读） | 配了任意 `decks[]` 就不登记；或 `bootstrap: false` |
| 资源库 | 自动拷入品牌素材（logo / mark）到 `<dataRoot>/resources` | 该目录非空时不动；或 `bootstrap: false` |
| Designs 页 | 自动导入 8 个预设风格（含样张） | 已有风格时不重复；或 `bootstrap: false` |
| 问候语 / 新 deck 作者 | 首次启动弹「先记个名字」，存 `<dataRoot>/user.json`；首页显示「XX，欢迎你」，新 deck 的 owner / 封面作者默认用它 | 点「稍后」不写；之后可在 profile 里用 `userName` 覆盖 |

自举只在「空」的时候发生，重复启动不会覆盖你已有的内容；想彻底关掉，在 profile patch 里给根挂载加
`bootstrap: false`（见 `plugin/deck-studio/cordis.patch.yml` 里两项都开了这个开关）。

## 4.3 启动报 `Cannot find package '@deepseek-ai/dsh-agent-preset'`

说明当前跑的不是完整的 DSH 发行版：Deckline 的 preset 子树用的是 DSH 内置包
`@deepseek-ai/dsh-agent-preset` / `@deepseek-ai/dsh-persona`，它们随 npm 发行版一起安装；从源码 checkout
或不完整的自编译安装里可能没有。

```sh
which -a dsh          # 看实际用的是哪个 dsh
dsh --version
npm i -g @deepseek-ai/dsh@0.2.1-rc.2   # 用 npm 发行版
hash -r
dsh --profile deckline --port 13090
```

如果必须用源码版 DSH，需要在那个安装里补齐 `@deepseek-ai/dsh-agent-preset` 依赖，或把本插件的
preset 子树挂载去掉（只保留工作台，不在 Chat 里用 Deck Agent）——不推荐，Deckline 的核心流程依赖 Agent 工具。
