/**
 * 界面可改的生图设置：模式 / 尺寸 / 出图节点（endpoint + key + 模型）。
 *
 * F-126 起设置写 `$dataRoot/render-settings.json`（本机数据目录，不进 git），启动时覆盖
 * config.render，保存即生效、不用重启。F-146 起节点可以「新增 / 编辑 / 删除」：
 * 小白只需要填 节点名 + 接口地址 + API Key + 模型名，key 直接存本机设置文件（0600），
 * 不要求理解环境变量；高级用户仍可用 env 变量名 / key 文件路径。
 *
 * 纪律（不能破）：
 * - 设置文件只在本机数据目录，权限 0600，不进仓库、不进 profile；payload 只回 keyConfigured / keySource，
 *   绝不把 key 值返回给 UI；
 * - endpoint 必须是 http(s) URL；payload 里也不会出现完整 key；
 * - profile 里的节点在第一次用设置页保存节点后由设置文件接管（设置页可以把它们一起编辑）。
 *
 * @module dsh-plugin-deck-studio/render-settings
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expandHome } from "./config.js";
import { keyConfigured, renderModelPayload } from "./render-nodes.js";

export const RENDER_SETTINGS_FILE = "render-settings.json";
const MAX_NODES = 12;
const MODEL_RE = /^[A-Za-z0-9._:\/-]{1,80}$/;

const asTrimmed = (value) => (typeof value === "string" ? value.trim() : "");

/** 读本机保存的设置；坏文件当没配（并给 warning，不崩）。 */
export function readRenderSettings(dataRoot) {
  const file = join(dataRoot, RENDER_SETTINGS_FILE);
  if (!existsSync(file)) return { found: false, file, values: null };
  try {
    const raw = JSON.parse(readFileSync(file, "utf8"));
    return { found: true, file, values: normalizeSettings(raw) };
  } catch (error) {
    return { found: false, file, warning: `render-settings.json 解析失败：${error?.message ?? error}`, values: null };
  }
}

function normalizeNode(raw = {}, index = 0) {
  return {
    id: asTrimmed(raw.id),
    name: asTrimmed(raw.name) || asTrimmed(raw.id) || `节点 ${index + 1}`,
    endpoint: asTrimmed(raw.endpoint),
    models: (Array.isArray(raw.models) ? raw.models : []).map(asTrimmed).filter(Boolean),
    apiKey: asTrimmed(raw.apiKey),
    apiKeyEnv: asTrimmed(raw.apiKeyEnv),
    apiKeyFile: expandHome(asTrimmed(raw.apiKeyFile)),
    editEndpoint: asTrimmed(raw.editEndpoint),
    editTransport: asTrimmed(raw.editTransport),
  };
}

function normalizeSettings(raw = {}) {
  return {
    mode: asTrimmed(raw.mode) === "real" ? "real" : "fake",
    size: asTrimmed(raw.size),
    default: asTrimmed(raw.default),
    nodes: (Array.isArray(raw.nodes) ? raw.nodes : []).map(normalizeNode).filter((node) => node.endpoint || node.models.length),
    // 兼容 F-126 的单节点老设置（也可以被新节点列表接管后再回填）
    endpoint: asTrimmed(raw.endpoint),
    model: asTrimmed(raw.model),
    apiKeyEnv: asTrimmed(raw.apiKeyEnv),
    apiKeyFile: expandHome(asTrimmed(raw.apiKeyFile)),
    updatedAt: asTrimmed(raw.updatedAt),
  };
}

function makeNodeId(name, taken) {
  const base = String(name ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32);
  let id = base || `node-${Math.random().toString(36).slice(2, 7)}`;
  let suffix = 2;
  while (taken.has(id)) id = `${base || "node"}-${suffix++}`;
  return id;
}

function normalizeKeyText(value) {
  return asTrimmed(value).replace(/^["']|["']$/g, "");
}

/** 校验 + 落盘；返回规范化后的设置（抛错 = 不合法，前端直接显示）。 */
export function saveRenderSettings(dataRoot, payload = {}, now = new Date()) {
  const values = normalizeSettings(payload);
  if (values.size && !/^\d{3,4}x\d{3,4}$/.test(values.size)) throw new Error("尺寸格式应为 宽x高，例如 2560x1440");
  if (values.endpoint && !/^https?:\/\/[^\s]+$/i.test(values.endpoint)) throw new Error("接口地址（endpoint）必须是 http(s) 开头的完整 URL");
  if (values.model && !MODEL_RE.test(values.model)) throw new Error("模型名只允许字母 / 数字 / . _ : / -（≤80 字）");
  if (values.apiKeyEnv && !/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(values.apiKeyEnv)) throw new Error("key 环境变量名不合法（字母数字下划线，不能以数字开头）");

  if (Array.isArray(payload?.nodes)) {
    if (values.nodes.length > MAX_NODES) throw new Error(`节点最多 ${MAX_NODES} 个`);
    const taken = new Set();
    values.nodes = values.nodes.map((node) => {
      const id = node.id && /^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/.test(node.id) ? node.id : makeNodeId(node.name, taken);
      if (taken.has(id)) throw new Error(`节点 id 重复：${id}`);
      taken.add(id);
      if (!node.endpoint) throw new Error(`节点「${node.name}」缺接口地址（endpoint，http(s) 开头，一般以 /v1 结尾）`);
      if (!/^https?:\/\/[^\s]+$/i.test(node.endpoint)) throw new Error(`节点「${node.name}」的接口地址（endpoint）必须是 http(s) 开头的完整 URL`);
      if (!node.models.length) throw new Error(`节点「${node.name}」至少填一个模型名`);
      const bad = node.models.find((model) => !MODEL_RE.test(model));
      if (bad) throw new Error(`节点「${node.name}」的模型名不合法：${bad}`);
      const key = normalizeKeyText(node.apiKey);
      if (key && !/^\S{8,300}$/.test(key)) throw new Error(`节点「${node.name}」的 API Key 格式不对（不能有空格，8–300 字符）`);
      if (node.apiKeyEnv && !/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(node.apiKeyEnv)) throw new Error(`节点「${node.name}」的环境变量名不合法`);
      return { ...node, id, apiKey: key };
    });
    if (values.mode === "real" && !values.nodes.length) throw new Error("real 模式至少要有一个节点（填接口地址 + 模型）");
    // 默认节点：显式指定且合法就用它，否则用第一个节点的第一个模型
    const wantedDefault = values.default;
    const slash = wantedDefault.indexOf("/");
    const defaultNode = slash > 0 ? values.nodes.find((node) => node.id === wantedDefault.slice(0, slash)) : null;
    const defaultModel = defaultNode?.models.find((model) => model === wantedDefault.slice(slash + 1));
    values.default = defaultNode && defaultModel ? `${defaultNode.id}/${defaultModel}` : values.nodes[0] ? `${values.nodes[0].id}/${values.nodes[0].models[0]}` : "";
  } else {
    if (values.mode === "real" && !values.endpoint) throw new Error("real 模式必须填接口地址（endpoint，出图节点的完整 URL）");
    if (values.mode === "real" && !values.model) throw new Error("real 模式必须填模型名");
    values.default = "";
  }

  // 编辑节点时 UI 不回传 key：按 id 从已有设置文件里把 key 找回来，避免「编辑一次 key 就没了」
  if (Array.isArray(payload?.nodes)) {
    const previous = readRenderSettings(dataRoot);
    const previousKeys = new Map((previous.values?.nodes ?? []).map((node) => [node.id, node.apiKey]).filter(([, key]) => key));
    values.nodes = values.nodes.map((node) => ({ ...node, apiKey: node.apiKey || previousKeys.get(node.id) || "" }));
  }

  const merged = { ...values, updatedAt: now.toISOString() };
  mkdirSync(dataRoot, { recursive: true });
  writeFileSync(join(dataRoot, RENDER_SETTINGS_FILE), `${JSON.stringify(merged, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  return merged;
}

/**
 * 把保存的设置套到 config.render 上（原地改）：
 * - 有节点列表：整表接管（profile 节点在第一次保存时已经被 UI 一起提交），按 id 回填旧 key；
 * - 只有 F-126 老设置（endpoint + model）：保留 profile 其它节点，追加「自定节点」。
 */
export function applyRenderSettings(config, saved) {
  const values = saved?.values;
  if (!values) return false;
  const render = config.render ?? (config.render = {});
  if (values.mode) render.mode = values.mode;
  if (values.size) render.size = values.size;
  for (const key of ["endpoint", "model", "apiKeyEnv", "apiKeyFile"]) {
    if (values[key]) render[key] = values[key];
  }
  if (Array.isArray(values.nodes) && values.nodes.length) {
    const existing = Array.isArray(render.nodes) ? render.nodes.filter((node) => node && node.id) : [];
    const byId = new Map(existing.map((node) => [node.id, node]));
    render.nodes = values.nodes.map((node) => ({
      ...node,
      // 编辑节点时 UI 不回传 key（payload 里没有明文），这里按 id 保留本机已存的 key
      apiKey: node.apiKey || byId.get(node.id)?.apiKey || "",
    }));
    render.default = values.default || `${render.nodes[0].id}/${render.nodes[0].models[0]}`;
    return true;
  }
  if (values.endpoint && values.model) {
    // F-145：不再把节点列表压成「自定节点」一个——profile 里的多节点要留着。
    const existing = Array.isArray(render.nodes) ? render.nodes.filter((node) => node && node.id) : [];
    const same = existing.find((node) => node.endpoint === values.endpoint && (node.models ?? []).includes(values.model));
    if (same) {
      render.default = `${same.id}/${values.model}`;
    } else {
      const custom = {
        id: "custom",
        name: "自定节点（设置页）",
        endpoint: values.endpoint,
        apiKeyEnv: values.apiKeyEnv,
        apiKeyFile: values.apiKeyFile,
        models: [values.model],
      };
      render.nodes = [...existing.filter((node) => node.id !== "custom"), custom];
      render.default = `custom/${values.model}`;
    }
  }
  return true;
}

/**
 * 对外 payload（设置页 + 工作台顶栏用）。只给 keyConfigured / keySource，不给 key。
 */
export function renderSettingsPayload(config, { env = process.env, saved = null } = {}) {
  const stored = saved ?? readRenderSettings(config.dataRoot);
  const values = stored.values ?? normalizeSettings({
    mode: config.render?.mode,
    size: config.render?.size,
    endpoint: config.render?.endpoint,
    model: config.render?.model,
    apiKeyEnv: config.render?.apiKeyEnv,
    apiKeyFile: config.render?.apiKeyFile,
  });
  const modelPayload = renderModelPayload(config.render, { env });
  const activeNode = modelPayload.nodes.find((node) => node.id === modelPayload.active?.nodeId) ?? modelPayload.nodes[0] ?? null;
  return {
    found: Boolean(stored.values),
    file: stored.file,
    ...(stored.warning ? { warning: stored.warning } : {}),
    mode: values.mode,
    size: values.size,
    nodes: modelPayload.nodes,
    default: modelPayload.nodes[0] ? `${modelPayload.nodes[0].id}/${modelPayload.nodes[0].models[0]}` : "",
    // 兼容老调用：把当前节点当成「单节点字段」返回
    endpoint: activeNode?.endpoint ?? values.endpoint,
    model: modelPayload.active?.model ?? values.model,
    apiKeyEnv: activeNode?.apiKeyEnv ?? values.apiKeyEnv,
    apiKeyFile: activeNode?.apiKeyFile ?? values.apiKeyFile,
    keyConfigured: activeNode ? activeNode.keyConfigured : keyConfigured({ apiKeyEnv: values.apiKeyEnv, apiKeyFile: values.apiKeyFile }, env),
    active: modelPayload.active,
    ready: modelPayload.active ? Boolean(activeNode?.keyConfigured) && Boolean(activeNode?.endpoint) : false,
    updatedAt: values.updatedAt || "",
  };
}
