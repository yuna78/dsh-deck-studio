# Sample deck：Deckline 产品说明手册

这是随仓库分发的**示例 deck 源**（10 页 image deck）：介绍 Deckline 是什么、为什么做、
工作台怎么用、怎么安装配置、边界与路线图。

**跑通流程请用弹窗字段速查：[`popup.md`](popup.md)**（对应 [docs/sample-deck.md](../../docs/sample-deck.md)）。

用途：

1. **看着像什么**：`script.md` 是逐页脚本（标题 / 副标题 / 页面内容 / 画面说明），
   `intent.md` 是给谁讲、讲什么、成功标准；配一份风格（示例用 `FYI` 高端深色，也可以换任意预设）。
2. **跑通流程**：把这个目录的 `script.md` 内容作为素材，粘贴进 Deckline 的 Chat，
   按 [docs/sample-deck.md](../../docs/sample-deck.md) 的三步走完
   「新建 deck → Agent 起草 intent/script → 确认 → 逐页出图 → 导出」。
3. **公开演示**：公开仓库里可以直接把本目录注册成一个 deck（profile patch `decks[]`）。

## 这份示例里有什么

```
samples/deckline-intro/
  README.md            # 本文件
  intent.md            # 意图（给谁讲 / 讲什么 / 带走什么 / 成功标准）
  script.md            # 10 页逐页脚本（标题 / 副标题 / 主张 / 正文 / 画面说明）
  prompts/p01..p10.txt # 每页实际用的 visualBrief（参考写法，可改写）
  pages/p01..p10.png   # 每页渲染结果（1280×720，示例输出长什么样）
  deckline-intro.pptx  # 同一份结果的 PPTX（每页一张整页图，方便直接翻）
  assets/              # 封面用到的 logo 参考图（Deckline 字标 / mark）
  materials/           # 参考截图与项目说明（运行 deck 时可作资料）
  materials.md · popup.md  # 资料清单 / 新建弹窗字段速查
```

> `pages/` 与 `deckline-intro.pptx` 是**示例产物**，不是源文件：Deckline 每次出图都会留版本，
> 源 deck 仍然只有 md；图片可以直接看，也可以删掉后自己按脚本重出一遍。
> `assets/` 里的 logo 仅作参考，替换成你自己的品牌时改这里即可。

## 怎么用

- **只想看**：打开 `deckline-intro.pptx`，或翻 `pages/`。
- **想复刻**：把 `script.md` 内容作为素材粘进 Deckline 的 Chat，按
  [docs/sample-deck.md](../../docs/sample-deck.md) 的三步跑「新建 deck → 起草 → 确认 → 逐页出图 → 导出」。
- **想注册成现成 deck**：在 profile patch 的 `decks[]` 里指向本目录（源只读，编辑产物写 `.deck/`）。
