/**
 * task / event / trace 运行时落盘（契约：docs/runtime-trace.md）。
 *
 * 全部 JSONL 追加、末行快照为最新状态（last-wins），不重写历史：
 * - `.deck/tasks.jsonl`            —— task 生命周期，每次迁移追加一条完整快照；
 * - `.deck/events.jsonl`           —— 事件索引（envelope）；
 * - `.deck/events/<eventId>.json`  —— 事件载荷（payloadRef 指过去）。
 *
 * 同步 fs：插件低频写，简单可靠优先；冒烟测试直接建临时目录即可。
 * @module dsh-plugin-deck-studio/store
 */

import { appendFileSync, mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

/** TASK 生命周期合法迁移（runtime-trace.md）。 */
const TASK_FLOW = {
  queued: ["running", "cancelled"],
  running: ["waiting-user", "succeeded", "failed", "cancelled"],
  "waiting-user": ["succeeded", "failed", "cancelled"],
};

/** 事件 envelope 的 status 词表。 */
export const EVENT_STATUS = ["started", "progress", "waiting-user", "succeeded", "failed"];

/** 生成 `prefix_<base36 时间><4 位随机>` 形如 task_lq2... 的 id。 */
export function makeId(prefix) {
  const time = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 6);
  return `${prefix}_${time}${rand}`;
}

/** ISO 时间戳（毫秒精度）。 */
export function nowIso() {
  return new Date().toISOString();
}

/**
 * 创建 store。目录惰性创建：读空目录返回空列表，不抛。
 * @param {string} dataRoot - `.deck/` 绝对路径。
 */
export function createRuntimeStore(dataRoot) {
  const tasksPath = join(dataRoot, "tasks.jsonl");
  const eventsPath = join(dataRoot, "events.jsonl");
  const eventsDir = join(dataRoot, "events");

  function ensureDirs() {
    mkdirSync(eventsDir, { recursive: true });
  }

  function appendLine(file, value) {
    ensureDirs();
    appendFileSync(file, `${JSON.stringify(value)}\n`, "utf8");
  }

  function readLines(file) {
    if (!existsSync(file)) return [];
    const out = [];
    for (const line of readFileSync(file, "utf8").split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        out.push(JSON.parse(trimmed));
      } catch {
        // 损坏行不炸读取；trace 页能看到“有行解析失败”比黑屏诚实。
        out.push({ corrupt: true, line: trimmed.slice(0, 200) });
      }
    }
    return out;
  }

  /** 追加事件；payload 一并落 `events/<eventId>.json`。返回 envelope。 */
  function recordEvent({ type, sessionId = null, taskId = null, deckId = null, slideIds = [], actor = "system", status = "succeeded", payload = {} }) {
    const eventId = makeId("evt");
    const envelope = {
      eventId,
      timestamp: nowIso(),
      sessionId,
      taskId,
      deckId,
      slideIds,
      type,
      actor,
      status,
      payloadRef: `events/${eventId}.json`,
    };
    ensureDirs();
    writeFileSync(join(eventsDir, `${eventId}.json`), `${JSON.stringify({ envelope, payload }, null, 2)}\n`, "utf8");
    appendLine(eventsPath, envelope);
    return envelope;
  }

  /** 读事件（envelope 升序 = 追加序）。 */
  function events(limit = 100) {
    const all = readLines(eventsPath).filter((line) => !line.corrupt);
    return typeof limit === "number" && limit > 0 ? all.slice(-limit) : all;
  }

  /** 读一个事件的完整载荷（含 envelope）；读不到返回 null。 */
  function eventPayload(eventId) {
    const file = join(eventsDir, `${String(eventId).replace(/[^a-zA-Z0-9_]/g, "")}.json`);
    if (!existsSync(file)) return null;
    try {
      return JSON.parse(readFileSync(file, "utf8"));
    } catch {
      return null;
    }
  }

  /** 创建 task（初始 queued）。 */
  function taskCreate({ kind, deckId = null, slideIds = [], actor = "agent", sessionId = null, inputRefs = [] }) {
    if (!TASK_FLOW.queued) throw new Error("unreachable");
    const record = {
      taskId: makeId("task"),
      sessionId,
      deckId,
      slideIds,
      kind,
      status: "queued",
      actor,
      createdAt: nowIso(),
      startedAt: null,
      finishedAt: null,
      inputRefs,
      outputRefs: [],
      error: null,
    };
    appendLine(tasksPath, record);
    recordEvent({ type: "task.created", sessionId, taskId: record.taskId, deckId, slideIds, actor, status: "started", payload: { kind, inputRefs } });
    return { ...record };
  }

  /** 追加一条迁移快照（last-wins）。非法迁移抛错，防止 task 状态漂移。 */
  function taskUpdate(taskId, patch) {
    const current = taskGet(taskId);
    if (!current) throw new Error(`task not found: ${taskId}`);
    const nextStatus = patch.status ?? current.status;
    if (nextStatus !== current.status) {
      const allowed = TASK_FLOW[current.status] ?? [];
      if (!allowed.includes(nextStatus)) {
        throw new Error(`illegal task transition ${current.status} → ${nextStatus} (${taskId})`);
      }
    }
    const next = {
      ...current,
      ...patch,
      taskId: current.taskId,
      createdAt: current.createdAt,
      status: nextStatus,
      startedAt: patch.startedAt ?? (nextStatus === "running" && !current.startedAt ? nowIso() : current.startedAt),
      finishedAt: patch.finishedAt ?? (["succeeded", "failed", "cancelled"].includes(nextStatus) ? nowIso() : current.finishedAt),
    };
    appendLine(tasksPath, next);
    if (nextStatus !== current.status) {
      recordEvent({
        type: "task.status",
        sessionId: next.sessionId,
        taskId: next.taskId,
        deckId: next.deckId,
        slideIds: next.slideIds,
        actor: patch.actor ?? next.actor,
        status: nextStatus === "succeeded" ? "succeeded" : nextStatus === "failed" ? "failed" : "progress",
        payload: { from: current.status, to: nextStatus, error: next.error ?? null, outputRefs: next.outputRefs },
      });
    }
    return next;
  }

  /** 最新快照；不存在返回 null。 */
  function taskGet(taskId) {
    let found = null;
    for (const line of readLines(tasksPath)) {
      if (!line.corrupt && line.taskId === taskId) found = line;
    }
    return found;
  }

  /** 每个 task 的最新快照，最近创建的在前。 */
  function taskList(limit = 50) {
    const latest = new Map();
    for (const line of readLines(tasksPath)) {
      if (line.corrupt) continue;
      latest.set(line.taskId, line);
    }
    const all = [...latest.values()].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
    return typeof limit === "number" && limit > 0 ? all.slice(0, limit) : all;
  }

  /** `.deck/` 内现有 deck id（有 decks/<id>/deck.json 的）。 */
  function listDeckIds() {
    const dir = join(dataRoot, "decks");
    if (!existsSync(dir)) return [];
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && existsSync(join(dir, entry.name, "deck.json")))
      .map((entry) => entry.name)
      .sort();
  }

  return {
    get dataRoot() {
      return dataRoot;
    },
    recordEvent,
    events,
    eventPayload,
    taskCreate,
    taskUpdate,
    taskGet,
    taskList,
    listDeckIds,
  };
}
