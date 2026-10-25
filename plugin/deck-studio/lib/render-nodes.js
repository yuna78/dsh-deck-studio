/**
 * 出图节点与模型：多节点（url / key / model 列表）+ 当前 deck 的生效选择。
 *
 * 配置（profile 的 plugin config）：
 *   render:
 *     mode: real
 *     default: main/gpt-image-2.5-sunburst       # 缺省选择：节点 id / 模型 id
 *     nodes:
 *       - id: main
 *         name: 主节点（示例）
 *         endpoint: https://your-image-relay.example.com/v1/images/generations
 *         apiKeyEnv: DSH_DECK_IMAGE_API_KEY        # 只存 env 名 / key 文件路径，不存 key 本身
 *         apiKeyFile: ~/.config/relays.secret.env
 *         models: [gpt-image-2.5-sunburst, gpt-image-2.5-flare]
 *
 * 节点地址与 key 都只来自配置 / env / 本机 key 文件；仓库不携带任何真实节点地址（默认空）。
 * 兼容旧配置：没有 nodes 时，用 render.endpoint / model / apiKeyEnv / apiKeyFile 生成一个默认节点。
 * 所有对外 payload 只给 `keyConfigured` 布尔值，绝不返回 key。
 * @module dsh-plugin-deck-studio/render-nodes
 */

import { existsSync } from "node:fs";

const asTrimmed = (value) => (typeof value === "string" ? value.trim() : "");

/**
 * 归一化出图节点列表（过滤空节点/无模型节点；同时兼容旧的单节点配置）。
 * @param {Record<string, unknown>} render - config.render
 * @returns {Array<{id:string,name:string,endpoint:string,apiKeyEnv:string,apiKeyFile:string,models:string[]}>}
 */
export function normalizeRenderNodes(render = {}) {
  const rawNodes = Array.isArray(render?.nodes) ? render.nodes : [];
  const nodes = rawNodes
    .filter((node) => node && typeof node === "object")
    .map((node, index) => {
      const id = asTrimmed(node.id) || `node-${index + 1}`;
      const models = (Array.isArray(node.models) ? node.models : [])
        .map((model) => (typeof model === "string" ? model.trim() : asTrimmed(model?.id)))
        .filter(Boolean);
      return {
        id,
        name: asTrimmed(node.name) || id,
        // 节点字段缺省时回退到旧的顶层配置，保证老 profile 还能用
        endpoint: asTrimmed(node.endpoint) || asTrimmed(render?.endpoint),
        // 直接存在本机设置文件里的 key（F-146）：给「填名字 + 地址 + key + 模型」的小白流程用。
        apiKey: asTrimmed(node.apiKey),
        // 修图端点：不配就由 endpoint 派生（/v1/images/generations → /v1/images/edits）。
        editEndpoint: asTrimmed(node.editEndpoint) || asTrimmed(render?.editEndpoint),
        editTransport: asTrimmed(node.editTransport) || asTrimmed(render?.editTransport),
        apiKeyEnv: asTrimmed(node.apiKeyEnv) || asTrimmed(render?.apiKeyEnv),
        apiKeyFile: asTrimmed(node.apiKeyFile) || asTrimmed(render?.apiKeyFile),
        models,
      };
    })
    .filter((node) => node.models.length > 0);

  if (nodes.length) return nodes;

  // 旧配置：单个 endpoint + 单个 model
  const legacyModel = asTrimmed(render?.model);
  if (!render?.endpoint && !legacyModel) return [];
  return [
    {
      id: "default",
      name: "默认节点",
      endpoint: asTrimmed(render?.endpoint),
      apiKey: asTrimmed(render?.apiKey),
      editEndpoint: asTrimmed(render?.editEndpoint),
      editTransport: asTrimmed(render?.editTransport),
      apiKeyEnv: asTrimmed(render?.apiKeyEnv),
      apiKeyFile: asTrimmed(render?.apiKeyFile),
      models: legacyModel ? [legacyModel] : [],
    },
  ].filter((node) => node.models.length > 0);
}

/**
 * 配置里的缺省选择：`render.default`（nodeId/modelId）；兼容旧 `render.model`。
 * @returns {{nodeId:string, model:string}|null}
 */
export function defaultSelection(render = {}) {
  const nodes = normalizeRenderNodes(render);
  if (!nodes.length) return null;
  const raw = asTrimmed(render?.default);
  if (raw) {
    const slash = raw.indexOf("/");
    const nodeId = slash > 0 ? raw.slice(0, slash) : "";
    const model = slash > 0 ? raw.slice(slash + 1) : raw;
    const node = nodes.find((item) => item.id === nodeId);
    if (node && node.models.includes(model)) return { nodeId: node.id, model };
    const fallbackNode = nodes.find((item) => item.models.includes(model));
    if (fallbackNode) return { nodeId: fallbackNode.id, model };
  }
  const legacyModel = asTrimmed(render?.model);
  if (legacyModel) {
    const node = nodes.find((item) => item.models.includes(legacyModel));
    if (node) return { nodeId: node.id, model: legacyModel };
  }
  return { nodeId: nodes[0].id, model: nodes[0].models[0] };
}

/**
 * 校验一个选择是否合法；非法返回 null（调用方报错而不是悄悄用别的）。
 * @returns {{nodeId:string, nodeName:string, node:object, model:string, endpoint:string, apiKeyEnv:string, apiKeyFile:string, label:string}|null}
 */
export function resolveSelection(render = {}, selection = null) {
  const nodes = normalizeRenderNodes(render);
  const wanted = selection && (selection.nodeId || selection.model)
    ? {
        nodeId: asTrimmed(selection.nodeId),
        model: asTrimmed(selection.model),
      }
    : defaultSelection(render);
  if (!wanted) return null;
  const node = nodes.find((item) => item.id === wanted.nodeId) ?? nodes.find((item) => item.models.includes(wanted.model));
  if (!node) return null;
  if (wanted.model && !node.models.includes(wanted.model)) return null; // 显式指定了不存在的模型：拒绝，不悄悄替换
  const model = wanted.model || node.models[0];
  return {
    nodeId: node.id,
    nodeName: node.name,
    node,
    model,
    endpoint: node.endpoint,
    apiKey: node.apiKey,
    editEndpoint: node.editEndpoint,
    editTransport: node.editTransport,
    apiKeyEnv: node.apiKeyEnv,
    apiKeyFile: node.apiKeyFile,
    label: `${node.name} / ${model}`,
  };
}

/** key 是否已配置（env 变量存在或有 key 文件；不读、不返回 key 值本身）。 */
export function keyConfigured(node, env = process.env) {
  if (asTrimmed(node?.apiKey)) return true;
  const envName = asTrimmed(node?.apiKeyEnv);
  const file = asTrimmed(node?.apiKeyFile);
  if (envName && env[envName]) return true;
  return Boolean(file && existsSync(file));
}

/**
 * 对外 payload（设置面板 / 工作台状态）：节点列表（含 key 配置状态）+ 当前生效选择。
 * @param {Record<string, unknown>} render
 * @param {object} [options]
 * @param {NodeJS.ProcessEnv} [options.env]
 * @param {{nodeId:string, model:string}|null} [options.selection]
 */
export function renderModelPayload(render = {}, { env = process.env, selection = null } = {}) {
  const nodes = normalizeRenderNodes(render);
  const active = resolveSelection(render, selection) ?? resolveSelection(render, null);
  return {
    mode: asTrimmed(render?.mode) || "fake",
    size: asTrimmed(render?.size),
    active: active
      ? { nodeId: active.nodeId, nodeName: active.nodeName, model: active.model, label: active.label }
      : null,
    nodes: nodes.map((node) => ({
      id: node.id,
      name: node.name,
      endpoint: node.endpoint,
      models: node.models,
      apiKeyEnv: node.apiKeyEnv,
      apiKeyFile: node.apiKeyFile,
      keyConfigured: keyConfigured(node, env),
      // saved = key 存在本机设置文件；env / file = 用环境变量或 key 文件；none = 没配
      keySource: asTrimmed(node.apiKey) ? "saved" : node.apiKeyEnv && env[node.apiKeyEnv] ? "env" : node.apiKeyFile && existsSync(node.apiKeyFile) ? "file" : "none",
    })),
  };
}
