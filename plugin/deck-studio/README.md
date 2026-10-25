# Deckline · `dsh-plugin-deck-studio`

DSH（DeepSeek Harness）的 **image deck 工作台插件**：左侧原生 Chat、中间整页图片 deck、右侧资料 / Designs / 资源 / 会话。
用对话改稿、按页出图（可点名批量连出）、版本留存、导出 PDF / PPTX / 交接包——不是又一个 PPT 编辑器。

## 安装

```sh
# 1) 新建一个 profile（基于 DSH 自带 web 模板）
dsh --profile deckline --from-default-profile web

# 2) 安装本插件（安装后会自动注册 bundle，无需手动改配置文件）
dsh plugin --profile deckline add dsh-plugin-deck-studio@0.2.4

# 国内网络建议走镜像（否则从 npmjs.org 拉 20 MB 包可能很慢）
npm_config_registry=https://registry.npmmirror.com dsh plugin --profile deckline add dsh-plugin-deck-studio@0.2.4

# 3) 启动，浏览器打开终端打印的带 token 链接
dsh --profile deckline --port 13090
```

确认装上了（输出 `1` 才对）：

```sh
dsh --profile deckline --dump-config | grep -c "preset-deck-critic"
```

在 npmjs.com 搜 `deckline` 或 `ppt dsh` 也能找到。也可以在 DSH「插件 → 发现」里加索引源 `https://cdn.jsdelivr.net/gh/yuna78/dsh-deck-studio@main/market-index.json` 后点安装。

从源码 / Git 安装、Windows、以及完整配置（数据目录 / deck 源 / 出图节点 / key）见仓库文档：

- [docs/install.md](https://github.com/yuna78/dsh-deck-studio/blob/main/docs/install.md)（中文）
- [docs/install.en.md](https://github.com/yuna78/dsh-deck-studio/blob/main/docs/install.en.md)（English）
- [示例 deck 与效果](https://github.com/yuna78/dsh-deck-studio/tree/main/samples/deckline-intro)

## 快速开始（fake 模式，无需 key）

1. 首页点「＋ 新建 Deck」，填标题 / 受众 / 一句话意图；
2. 在 Chat 里让 Agent 起草 `intent.md` / `script.md`，确认后逐页出图；
3. 默认 fake 模式出占位图，能走完整个流程；要看真图再进「设置」填出图节点 endpoint / 模型 / key。

出图节点不内置：real 模式必须自己配 OpenAI 兼容的 `/v1/images/generations` 地址（key 存本机，
`~/.dsh/deckline/render-settings.json`，0600，不进 git、不回显）。

## 数据在哪

- 运行数据（工作副本 / 出图 / 事件）：`$DSH_HOME/deckline`（可用 `dataRoot` 覆盖）；
- 受控源 deck：`decks[].sourceRoot` 指向的目录，**只读**，Deckline 永不回写；
- 新建 deck：`projectsRoot` 或 `<dataRoot>/projects/<deckId>/source`。

## 许可

MIT © 2026 Yuna (Deckline)。见仓库 [LICENSE](https://github.com/yuna78/dsh-deck-studio/blob/main/LICENSE)。
