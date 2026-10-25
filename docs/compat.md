# DSH 兼容矩阵（定期回归记录）

> 口径：DSH 处于 prerelease 阶段，没有 stable 线；本项目**定期批次**回归，不逐 rc 跟。
> 每个批次记录：证实的版本、验证范围、断点、复现方式。已知限制与路线见 [productization.md](productization.md) 与 [install.md](install.md)。

## 当前支持声明

| 项 | 值 | 说明 |
|---|---|---|
| `peerDependencies["@deepseek-ai/dsh"]` | `>=0.1.7-0 <0.2.0 \|\| >=0.2.0-0 <0.3.0 \|\| >=0.2.1-0 <0.3.0` | 装到 0.3+ 会被 DSH 的 peer 检查拦下 |
| `engines.dsh` | `>=0.1.7-0 <0.3.0` | 元数据口径，同 peer |
| `engines.node` | `^22.19.0 \|\| >=24.0.0` | 与 DSH 运行时要求一致；**Node 23 不在范围内** |
| 已验证版本 | `0.1.7-rc.2`（旧基线）· `0.2.1-rc.2`（2026-10-21：隔离环境 + 本地全局升级后真机回归） | 见下表 |

## 回归记录

### 批次 1 · 2026-10-21 · DSH `0.2.1-rc.2`

隔离环境，不动本机 `0.1.7-rc.2` 与运行中的 deck-studio profile：

```bash
# 临时安装（Node 必须 ^22.19 || >=24；本机默认 Node 23.11 不满足，用 nvm v24.21.0）
npm i --prefix /tmp/dsh02 @deepseek-ai/dsh@0.2.1-rc.2
export DSH_HOME=/tmp/dsh02-home PATH="$HOME/.nvm/versions/node/v24.21.0/bin:$PATH"
dsh --profile deckline-02 --from-default-profile web --dump-config
dsh plugin --profile deckline-02 add <repo>/plugin/deck-studio
dsh --profile deckline-02 --port 13290
```

| 检查项 | 结果 | 证据 |
|---|---|---|
| `dsh -V` / CLI 启动 | ✅ `0.2.1-rc.2` | 需 Node 24（0.2.x 的 `bin.js` 用 `import.meta.main`，Node 23 会静默不执行） |
| 插件安装（本地 link） | ✅ 无 peer 冲突，进入 `dsh.profile.bundles` | `dsh plugin add` 输出 `+ dsh-plugin-deck-studio link:…` |
| 组合配置（根 mount / preset / tools） | ✅ `deck-studio`、`preset-deck-studio`、`deck-studio-tools` 均在 `--dump-config` 中 | 无组合报错 |
| Web 启动 + 插件装载 | ✅ 侧栏出现「Deckline」，`/api/deck-studio.app` iframe 加载 | 截图 `/tmp/f86-02-home.png` |
| Deckline 首页 | ✅ Decks / Designs / 资源库 / Conversations + 数据（designs 11） | `/tmp/f86-02-app-home.png` |
| Designs 列表 + 预设风格 | ✅ 11 个风格（含 8 个预设），「导入预设风格」入口在 | `/tmp/f86-02-designs.png` |
| Design 详情（BIZ / PCL） | ✅ 3/4 张样张、风格定义、样张墙 | `/tmp/f86-02-design-biz.png` |
| 样张媒体 GET | ✅ 200 / 1,383,788 bytes | `/api/deck-studio.media?…designs%2FBIZ%2Fsample-v001.png` |
| 设置面板（节点自配口径） | ✅ 显示「生图配置未就绪 / 未配置 endpoint / key 未配置」+ docs 指引 | `/tmp/f86-02-settings.png` |
| 控制台 / 页面异常 | ✅ 0 console error、0 pageerror | 同上脚本输出 |
| Agent 工具链路 | ⏭ 未验证（隔离 home 无 LLM key） | 下批用真 key 跑 `S01/S02` + `--only` |
| 真出图（real render） | ⏭ 未验证 | 需本机节点/key；fake 模式已验证 |

**观察项（不阻塞）**：iframe 内导航时 `/plugins/events`（DSH 的插件事件 SSE）报 `ERR_ABORTED`，
页面功能与数据均正常，判断为导航时主动中断连接，记录待后续批次复核。

**结论**：`0.2.1-rc.2` 在「插件安装 → 组合 → Web 加载 → Deckline 应用/样张/设置」链路上可用；
agent 工具链路与真出图待下批补验。支持声明暂不收紧到 0.2.x-only，保持 `0.1.7–0.2.x` 区间。

## 下批要做（每月 / 或 DSH 0.3 发布前）

1. 真出图探活 1 页（0.2.1 上，确认 image adapter 无破坏）；
2. 合并评估脚本修复：S11「读到的原文含报错字样」误报、S13 台账表解析口径；
3. 复核 `/plugins/events` ERR_ABORTED；
4. 若 DSH 发布 0.3.x：先按本表跑一遍，再更新 `peerDependencies` / 本文件 / README 支持声明。

### 批次 2 · 2026-10-21 · DSH `0.2.1-rc.2` 真机 + Agent 链路（本地全局升级后）

批次 1 的隔离环境没有 LLM key，Agent 链路未验证；本机升级到 `0.2.1-rc.2` 后用真 key 补验，同时发现一个
0.2.x 的破坏性差异并已修复。

| 检查项 | 结果 | 证据 |
|---|---|---|
| 真机数据迁移 | ✅ decks 5→7 / designs 11 / conversations 20 均保留 | 升级回归（见下节「本地环境升级记录」） |
| persona 提示词变量 | ❌→✅ 0.2.x 只注册 `provider` / `model` 两个变量；插件 persona suffix 里的 `{{cwd}}` 使每个 Agent 回合直接 `turn/end` 报 `unknown prompt variable "{{cwd}}"`，Chat 完全不回话 | 会话 `session.v4.jsonl.zstd` 的 `turn/end` error；修复 commit `1dd8695`（改成静态「工作目录是本 deck 仓库根目录，以工具返回路径为准」）+ smoke 增加禁 `{{cwd}}` 断言 |
| Agent 全场景评估 | ✅ 16 场景中 15 通过（S01–S16） | `.deck/eval/run-20261021-000149/report.md` |
| S11 假失败 | ✅ 复跑 PASS（eval 误报：`deck_file_read` 读到 `smoke.mjs` 原文里含「未知 deck」字样被当成工具报错） | 临时补丁复跑 `.deck/eval/run-20261021-001453/report.md`；正式修复待评估脚本合并 |
| S13 新增场景 | ⏭ 非 0.2.1 回归：检查器按标准台账表解析，agent 用自定义台账表 → 解析 0 条 | 同 report.md；属 WIP 场景口径问题 |
| 工具链路 | ✅ 真实调用 overview / 读文件 / 读文档 / 文档更新 / script 提案 / note_change / style_update | eval 每回合工具序列 |
| real 出图探活（adapter） | ✅ 2026-10-21 在 DSH 0.2.1 的 Node 24 上跑 `createRealRenderer`：POST 200 / 18.5s，1024×1024 PNG 1.3MB，图片内容与 prompt 一致 | `/tmp/f94-probe/out5/image.png`；探针脚本一次性放 /tmp，不入库 |
| CDN 下载抖动 | ⚠️→✅ 中转返回 `data[0].url` 走 Cloudflare CDN，本网络下连续 4 次 `ETIMEDOUT` 后第 5 次成功；插件已加**5 次指数退避重试**（`lib/render.js`） | probe 日志 `fetch#2–#6`；smoke 新增重试测试 |
| smoke / 公开包 | ✅ 47/47；96 文件 / 5.87 MB（含 4 份英文文档） | `smoke.mjs` / `build-public-bundle.mjs` |

**结论**：`0.2.1-rc.2` 上插件与 Agent 链路可用，但 **persona 提示词变量只能用 `provider` / `model`**；
本仓已修复并加 smoke 防回归；real 出图 adapter 已在 0.2.1 的 Node 24 上以一页 1024×1024 探活通过。

**操作观察（不阻塞）**：13090 重启后约 1 分钟内，`/api/deck-studio.app` 可能还没把 `STATE.data.active`
挂好（脚本直接 `goto` 会误判「工作台没加载」）；等插件 patch 应用完成或先 warm-up 一次再跑自动化。
`/plugins/events` 仍是导航时 `ERR_ABORTED`，功能正常。

## 升级记录（0.2.1-rc.2，验证机）

**升级前**：全局 `@deepseek-ai/dsh@0.1.7-rc.2`；**升级后**：`0.2.1-rc.2`（npm `latest`）。

```bash
# 建议先备份 profile（仓库外）
tar -czf ~/dsh-profiles-backup.tgz -C ~/.dsh profiles
# 升级全局包（Node 需 ^22.19 || >=24）
npm i -g @deepseek-ai/dsh@0.2.1-rc.2
# 重启 profile
dsh --profile deckline --no-open
```

**回归结果**：

| 检查项 | 结果 |
|---|---|
| `dsh --version` | ✅ `0.2.1-rc.2` |
| `--dump-config` | ✅ 0 stderr，插件 / 预设 / tools 条目不丢 |
| 启动 13090 | ✅ 正常打印 token，无迁移报错 |
| 既有数据 | ✅ 升级后 decks / designs / 资源库 / Conversations / 治理数据都在 |
| Deckline 应用 | ✅ 首页 / Design 列表 / Deck 工作台（意图 / 脚本 / Design / 日志… + image storyboard） |
| 出图节点 | ✅ 节点 `/v1/models` 探活 200 |
| 页面异常 | ✅ 0 pageerror |

**运行要求**：LLM 与出图节点的 key 由 profile / 环境变量提供（出图节点见 `apiKeyEnv`）。不带 key 时服务能起，
但 chat / 出图会失败；fake 模式下不配 key 也能走完整流程。

**回滚**：`npm i -g @deepseek-ai/dsh@0.1.7-rc.2` → 解压备份的 `profiles` 覆盖 `~/.dsh/profiles` → 重启。

## 已知安装失败：缺 DSH 内置包

- 症状：`dsh --profile <your> --port 13090` 启动时报
  `failed to import loader entry preset-deck-studio (@deepseek-ai/dsh-agent-preset): Cannot find package '@deepseek-ai/dsh-agent-preset'`。
- 原因：当前 `dsh` 不是完整 npm 发行版（常见于从源码 checkout / 自编译，或 PATH 里指向了旧安装）。
- 处理：`which -a dsh` 确认实际路径 → 用 `npm i -g @deepseek-ai/dsh@0.2.1-rc.2` 的发行版启动；
  已在本机验证 0.2.1-rc.2 正常。详见 [install.md](install.md) §4.3。

## 最低版本与 0.1.5

- Deckline 要求 **DSH ≥ 0.1.7 < 0.3**；**0.1.5 及更早不支持**（没有 preset 需要的
  `@deepseek-ai/dsh-agent-preset` 等内置包，启动会直接报 `Cannot find package`）。
- 用 `dsh --version` 确认；是 0.1.x 旧安装（常见于源码 checkout / 旧 PATH）时，改用
  `npm i -g @deepseek-ai/dsh@0.2.1-rc.2` 的发行版，并确认 `which -a dsh` 第一个是它。
- 升级后建议重建 deckline profile（`dsh --profile deckline --from-default-profile web --dump-config` 后再
  `dsh plugin --profile deckline add ...`），避免沿用旧版本的 profile 模板。
