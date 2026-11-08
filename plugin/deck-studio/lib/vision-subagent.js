/**
 * 用「DSH 默认模型 + 一次性内部 Sub Agent」跑视觉评审（F-218）。
 *
 * 为什么需要它：审图要求用户单独配一个视觉模型（endpoint / model / key），这对用户是纯负担——
 * DSH 自己的模型本来就能看图。所以默认走这条零配置通道，独立 relay 只作为可选覆盖。
 *
 * 与 `lib/image-review.js` 的分工：
 * - `image-review.js` 负责「审什么」（双转写 / 盲述 / 对照 / 打分）——纯编排，不关心传输；
 * - 本模块只负责「怎么把图 + prompt 送进 DSH 模型、把文字拿回来」。
 *
 * 约束（与 F-170 听众评审同一条隔离纪律）：
 * - 复用 `deck-studio-review` provider（无 preset、无工具、只出 JSON）；
 * - 每次调用是**一次性会话**，不继承父会话历史，避免把上文的稿子/结论当证据；
 * - 图片走 DSH 的 image 内容块（inline：`{ type: "image", mediaType, data }`），不做 OCR。
 */

import { readFileSync } from "node:fs";
import { extname } from "node:path";

import { REVIEW_AGENT_PROVIDER } from "./review-agent.js";

/** 文件扩展名 → DSH 认的 mediaType。 */
export function mediaTypeOf(file) {
  const ext = extname(String(file ?? "")).toLowerCase();
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".webp") return "image/webp";
  return "image/png";
}

/**
 * 一次视觉调用要发的消息内容：prompt 文本 + 一张图。
 * 抽成纯函数是为了能在测试里断言形状（不需要真模型）。
 */
export function buildVisionContent({ prompt, imagePath, readFile = readFileSync } = {}) {
  const text = String(prompt ?? "");
  if (!text.trim()) throw new Error("视觉评审 prompt 为空");
  if (!imagePath) throw new Error("视觉评审缺少图片路径");
  const bytes = readFile(imagePath);
  if (!bytes?.length) throw new Error(`视觉评审读到的图片是空的：${imagePath}`);
  return [
    { type: "text", text },
    { type: "image", mediaType: mediaTypeOf(imagePath), data: Buffer.from(bytes).toString("base64") },
  ];
}

/** 从一次性会话的输出里取正文（只认 text 块，忽略思考/工具块）。 */
export function textOfActivation(result) {
  const blocks = Array.isArray(result?.output) ? result.output : [];
  return blocks
    .filter((block) => block?.type === "text" && String(block.text ?? "").trim())
    .map((block) => String(block.text))
    .join("\n")
    .trim();
}

/**
 * 造一个可注入 `runImageReview` 的 `askVision`：
 * 每次调用新建一个一次性会话，发「文本 + 图片」，把正文交回去。
 *
 * @param {object} options
 * @param {object} options.runtime 宿主 `subagents` 服务（要有 startActivation）
 * @param {object} [options.parent] 父 agent（来自工具 exec.agent）
 * @param {string} [options.cwd] 子会话工作目录
 * @param {AbortSignal} [options.signal] 取消信号
 * @param {number} [options.timeoutMs] 单次调用超时（默认 180s，与 relay 通道一致）
 * @param {string} [options.label] activation 标签（trace 里能看到是哪一页）
 */
export function createSubagentVision({ runtime, parent = null, cwd = "", signal = null, timeoutMs = 180_000, label = "deck-vision" } = {}) {
  if (!runtime?.startActivation) throw new Error("内部子代理不可用：无法用 DSH 默认模型做视觉评审");
  return async function askVision({ prompt, imagePath, maxTokens } = {}) {
    if (!imagePath) throw new Error("视觉评审缺少图片路径");
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    if (signal?.aborted) controller.abort();
    else signal?.addEventListener?.("abort", onAbort, { once: true });
    let timer;
    let activation;
    const timeout = new Promise((_resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error(`审图超时（${Math.round(Number(timeoutMs) / 1000)}s）`));
      }, Number(timeoutMs));
      timer?.unref?.();
    });
    try {
      activation = await runtime.startActivation({
        provider: REVIEW_AGENT_PROVIDER,
        label,
        request: {
          prompt: buildVisionContent({ prompt, imagePath }),
          ...(cwd ? { cwd } : {}),
          ...(Number.isSafeInteger(maxTokens) && maxTokens > 0 ? { agentOptions: { maxTokens } } : {}),
          ...(parent ? { parent } : {}),
        },
        signal: controller.signal,
        delivery: "caller",
      });
      const result = await Promise.race([activation.result, timeout]);
      if (controller.signal.aborted) throw new Error("审图已取消或超时");
      if (result?.stopReason !== "completed") throw new Error(`审图子代理未正常完成（${result?.stopReason ?? "unknown"}）`);
      const text = textOfActivation(result);
      if (!text) throw new Error("审图子代理没有返回任何文字（模型可能不支持图片输入）");
      return text;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener?.("abort", onAbort);
      try {
        await activation?.dispose?.();
      } catch {
        /* 释放失败不影响结论 */
      }
    }
  };
}
