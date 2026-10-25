/**
 * design（风格）注册表 + 会话绑定表。
 *
 * 背景（F-43）：Designs 页可以「添加风格」——弹窗描述画面 → 建一个 0 页空白 deck
 * 当画布 → 左侧 chat 新建会话开始工作。这个会话绑定的是 design，不是那个空白 deck。
 * 规则：每个会话必须绑定一个 deck 或一个 design。
 *
 * 存储（都在 .deck/ 下，不进 git）：
 * - `designs-registry.json`：`{ designs: [{ designId, name, abbr, description, constraints,
 *   reference, canvasDeckId, createdAt }] }`
 * - `session-bindings.json`：`{ bindings: { <sessionId>: { kind, id, title, createdAt, updatedAt } } }`
 *
 * DSH 会话本身没有「绑定」字段，所以绑定表在插件侧维护；客户端建/切会话后调
 * `/api/deck-studio.session-bind` 落表。
 * @module dsh-plugin-deck-studio/designs
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const KIND_LABEL = { deck: "Deck", design: "Design" };

function readJson(file, fallback) {
  try {
    if (!existsSync(file)) return fallback;
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJson(file, value) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

/** 风格缩写：2–6 位字母/数字，目录名直接用（`designs/<ABBR>/`）。 */
export function normalizeAbbr(value) {
  const abbr = String(value ?? "").trim();
  if (!/^[A-Za-z][A-Za-z0-9]{1,5}$/.test(abbr)) throw new Error("风格缩写要 2–6 位字母/数字，且以字母开头（如 PC）");
  return abbr.toUpperCase();
}

/**
 * @param {{dataRoot: string}} input
 */
export function createDesignRegistry({ dataRoot }) {
  const designFile = join(dataRoot, "designs-registry.json");
  const bindingFile = join(dataRoot, "session-bindings.json");
  // deck → design 关联（F-51）：正式 deck 登记它用哪个风格，源文件不动。
  const deckDesignFile = join(dataRoot, "deck-designs.json");

  function listDesigns() {
    const raw = readJson(designFile, { designs: [] });
    return Array.isArray(raw?.designs) ? raw.designs.filter((item) => item?.designId && item?.canvasDeckId) : [];
  }

  function upsertDesign(entry) {
    const designs = listDesigns().filter((item) => item.designId !== entry.designId);
    designs.push(entry);
    writeJson(designFile, { designs });
    return entry;
  }

  function findDesignByAbbr(abbr) {
    const key = String(abbr ?? "").toUpperCase();
    return listDesigns().find((item) => String(item.abbr).toUpperCase() === key) ?? null;
  }

  function findDesign(designId) {
    return listDesigns().find((item) => item.designId === designId) ?? null;
  }

  function removeDesign(designId) {
    const designs = listDesigns();
    const target = designs.find((item) => item.designId === designId) ?? null;
    if (!target) return null;
    writeJson(designFile, { designs: designs.filter((item) => item.designId !== designId) });
    return target;
  }

  /** deck → design 关联表：`{ associations: { <deckId>: { designId, updatedAt } } }`（F-51）。 */
  function listDeckDesigns() {
    const raw = readJson(deckDesignFile, { associations: {} });
    return raw?.associations && typeof raw.associations === "object" ? raw.associations : {};
  }

  function deckDesignFor(deckId) {
    const association = listDeckDesigns()[deckId];
    return association?.designId ? association : null;
  }

  function setDeckDesign(deckId, designId) {
    const associations = listDeckDesigns();
    if (designId) associations[deckId] = { designId, updatedAt: new Date().toISOString() };
    else delete associations[deckId];
    writeJson(deckDesignFile, { associations });
    return designId ? associations[deckId] : null;
  }

  function listBindings() {
    const raw = readJson(bindingFile, { bindings: {} });
    const bindings = raw?.bindings && typeof raw.bindings === "object" ? raw.bindings : {};
    return Object.entries(bindings)
      .filter(([sessionId, value]) => sessionId && value?.kind && value?.id)
      .map(([sessionId, value]) => ({ sessionId, ...value }));
  }

  /** 会话绑定；同会话重复绑定直接覆盖（用户改主意时以最新为准）。 */
  function upsertBinding({ sessionId, kind, id, title = "" }) {
    if (!sessionId) throw new Error("sessionId 不能为空");
    if (kind !== "deck" && kind !== "design") throw new Error(`未知绑定类型：${kind}`);
    const raw = readJson(bindingFile, { bindings: {} });
    const bindings = raw?.bindings && typeof raw.bindings === "object" ? raw.bindings : {};
    const existing = bindings[sessionId];
    const now = new Date().toISOString();
    bindings[sessionId] = {
      kind,
      id,
      title: String(title || "").slice(0, 80),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    writeJson(bindingFile, { bindings });
    return { sessionId, ...bindings[sessionId], kindLabel: KIND_LABEL[kind] };
  }

  function removeBinding(sessionId) {
    const raw = readJson(bindingFile, { bindings: {} });
    const bindings = raw?.bindings && typeof raw.bindings === "object" ? raw.bindings : {};
    if (!bindings[sessionId]) return false;
    delete bindings[sessionId];
    writeJson(bindingFile, { bindings });
    return true;
  }

  /** 找某个 deck / design 已绑定的会话（用于「点 deck 复用上次会话」）。 */
  function bindingFor(kind, id) {
    return listBindings().find((binding) => binding.kind === kind && binding.id === id) ?? null;
  }

  /** 删掉某个 deck / design 的全部会话绑定（删除实体时用）。 */
  function removeBindingsFor(kind, id) {
    const raw = readJson(bindingFile, { bindings: {} });
    const bindings = raw?.bindings && typeof raw.bindings === "object" ? raw.bindings : {};
    let removed = 0;
    for (const [sessionId, value] of Object.entries(bindings)) {
      if (value?.kind === kind && value?.id === id) {
        delete bindings[sessionId];
        removed += 1;
      }
    }
    if (removed) writeJson(bindingFile, { bindings });
    return removed;
  }

  return {
    designFile,
    bindingFile,
    deckDesignFile,
    listDesigns,
    upsertDesign,
    findDesign,
    findDesignByAbbr,
    removeDesign,
    listDeckDesigns,
    deckDesignFor,
    setDeckDesign,
    listBindings,
    upsertBinding,
    removeBinding,
    removeBindingsFor,
    bindingFor,
  };
}
