---
title: Deckline 产品说明手册
owner: Deckline
created: 2026-10-21
confidential: public
deck-type: handbook
render: image
pages: 10
status: draft
---

# 意图

## 讲给谁

第一次接触 Deckline 的人：会用 DSH / 会做分享材料的产品、咨询、培训、内容创作者。
他们大概率已经有一堆 PPT/Keynote，也都试过让 AI 直接生成整页图，但被「改稿、返工、找不到版本」折磨过。

## 讲什么

一句话：**Deckline 不是又一个 PPT 编辑器，而是把「讲给谁、讲什么、怎么出图」变成一条可追踪的产线。**

- 对话在 DSH 原生 Chat 里继续，deck 的每次改动有 script / diff / revision / 治理文档撑底；
- 出图按页：可点名多页 / 整份连续出，每页保留 prompt、图片、版本、QA 和事件，随时能回到任意一版；
- 风格（design）是独立资产：登记一次，换 deck 也能复用，还能直接贴样张；
- 源 deck 目录只读，所有编辑产物落在本地 `.deck/`——客户资料不会因为一次误操作被覆盖。

## 希望大家带走什么

1. 记住三句话：**Chat 里讨论、工作台里出图、源文件只读**；
2. 愿意按 README 的花 5 分钟装一个，跑通第一个 deck；
3. 知道这件事有边界：一期只做 image deck，出图按页、可点名批量连出，不碰 HTML deck。

## 成功标准

听众看完能向同事复述：「Deckline 是 DSH 上的 image deck 工作台，用对话改 deck、按页出图（可批量）、
风格可以复用，安装就是一条 `dsh plugin add`。」

## 不讲的

- 不讲实现细节（代码结构 / 数据 schema / 工具名）；
- 不讲客户案例细节；
- 不承诺「一键出整套 deck」。

## 风格

示例用 **FYI · 高端深色（玻璃质感）**：近黑炭底、玻璃面板、紫青极光、香槟金。
也可以换 `BIZ`（商务蓝灰）或 `SWS`（瑞士极简黑白红）。
