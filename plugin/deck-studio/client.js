/**
 * dsh-plugin-deck-studio —— 观测面板（浏览器半）。
 *
 * 只画界面、只 fetch `/api/deck-studio.*`；不碰文件系统、无外网请求。
 * 数据全部由宿主半聚合好（浏览器半只做展示，不重算业务口径）。
 *
 * 形态：主区「Deck 工作台」面板（iframe 复用 /api/deck-studio.app?embed=1）。
 * 启动后自动打开（零点击进入），左侧 foote 只保留一个「Deckline」入口用于重新打开；
 * 不再注册右侧 dockkit 观测标签页（F-63：入口太多且丑）。
 * 宿主没有 layout 主区面板契约时降级为 main 面板 + sidebar.panellist。
 *
 * Chatbox 说明（ADR-0006 D1）：对话入口就是 DSH 原生 Chat——选择
 * 「Deckline · image deck」preset 即进入 Deck Agent 会话；本面板只负责
 * 观测 task / event / proposal / deck 状态。
 */
window.__ModuleLoader__.load({
  id: "dsh-plugin-deck-studio",
  factory: (require) => {
    "use strict";
    var module = { exports: {} };
    var exports = module.exports;

    const React = require("react");
    const h = React.createElement;

    const PLUGIN_ID = "dsh-plugin-deck-studio";
    const KIND = "deck-studio";
    const PANEL_KEY = "deck-studio-panel";
    const WORKBENCH_KEY = "deck-studio-workbench";
    const ROUTE_PREFIX = "/api/deck-studio.";
    const POLL_MS = 5000;

    /** 路由白名单：getJson 只放行这一族地址。 */
    async function getJson(path) {
      if (!path.startsWith(ROUTE_PREFIX)) throw new Error(`blocked non-plugin route: ${path}`);
      const response = await fetch(path, { headers: { accept: "application/json" } });
      if (!response.ok) throw new Error(`${path} → HTTP ${response.status}`);
      return response.json();
    }

    /** 样式：结构色走 GUI 令牌并带兜底，不写死白底黑字。 */
    function injectStylesheet() {
      if (document.getElementById("dsh-deck-studio-style")) return;
      const style = document.createElement("style");
      style.id = "dsh-deck-studio-style";
      style.textContent = `
#dsh-deck-studio-panel{font-size:12px;color:var(--dsw-alias-text-primary,#18343b);line-height:1.55;height:100%;overflow:auto;padding:14px;box-sizing:border-box}
#dsh-deck-studio-panel .dds-card{border:1px solid var(--dsw-alias-border-primary,#d6d0c4);border-radius:8px;background:var(--dsw-alias-surface-primary,#fffdf8);padding:10px 12px;margin-bottom:10px}
#dsh-deck-studio-panel .dds-eyebrow{font-size:10px;letter-spacing:.08em;text-transform:uppercase;color:var(--dsw-alias-text-tertiary,#728086);margin:0 0 6px}
#dsh-deck-studio-panel h3{margin:0 0 6px;font-size:13px}
#dsh-deck-studio-panel .dds-meta{color:var(--dsw-alias-text-secondary,#5c6464);font-size:11px}
#dsh-deck-studio-panel .dds-warn{color:#b3591e;font-size:11px}
#dsh-deck-studio-panel table{width:100%;border-collapse:collapse;font-size:11px}
#dsh-deck-studio-panel th{ text-align:left;color:var(--dsw-alias-text-tertiary,#728086);font-weight:600;border-bottom:1px solid var(--dsw-alias-border-primary,#d6d0c4);padding:3px 6px;white-space:nowrap}
#dsh-deck-studio-panel td{padding:3px 6px;border-bottom:1px dashed var(--dsw-alias-border-secondary,#e8e2d6);vertical-align:top}
#dsh-deck-studio-panel .dds-pill{display:inline-block;padding:1px 7px;border-radius:9px;font-size:10px;border:1px solid var(--dsw-alias-border-primary,#c9c2b4)}
#dsh-deck-studio-panel .dds-succeeded{color:#1c7c46;border-color:#1c7c46}
#dsh-deck-studio-panel .dds-failed{color:#b3261e;border-color:#b3261e}
#dsh-deck-studio-panel .dds-waiting-user{color:#8a6100;border-color:#c5882f;background:color-mix(in srgb,#c5882f 12%,transparent)}
#dsh-deck-studio-panel .dds-open-workbench{display:inline-block;padding:6px 12px;border-radius:6px;background:#0c4651;color:#faf8f2;font-size:12px;text-decoration:none}
#dsh-deck-studio-panel .dds-open-workbench:hover{background:#0f6975}
#dsh-deck-studio-panel .dds-running,#dsh-deck-studio-panel .dds-queued{color:#0f6975;border-color:#1496a8}
#dsh-deck-studio-panel .dds-cancelled{color:var(--dsw-alias-text-tertiary,#728086)}
#dsh-deck-studio-panel .dds-foot{margin-top:8px;color:var(--dsw-alias-text-tertiary,#728086);font-size:10px;display:flex;justify-content:space-between;gap:8px}
#dsh-deck-studio-panel code{font-size:10.5px;color:var(--dsw-alias-text-secondary,#0f6975)}
`;
      document.head.appendChild(style);
    }

    /**
     * F-69：把 DSH 外壳左侧栏收起时整列收成 0 宽。
     * 官方 collapsed 在 Web 端仍保留 56px 图标栏；只有 profile 显式配置
     * `hideShellSidebar: true` 才注入，避免影响其他 profile（如开发用 3080）。
     */
    function injectShellSidebarStyle() {
      if (document.getElementById("dsh-deck-studio-shell-sidebar-style")) return;
      const style = document.createElement("style");
      style.id = "dsh-deck-studio-shell-sidebar-style";
      style.textContent = `
div[data-sidebar-collapsed]{grid-template-columns:0px minmax(0px,1fr) 0px!important}
`;
      document.head.appendChild(style);
    }

    /** 状态药丸。 */
    function Pill({ value }) {
      const cls = String(value ?? "").replace(/[^a-z-]/gi, "") || "cancelled";
      return h("span", { className: `dds-pill dds-${cls}` }, String(value ?? "—"));
    }

    function fmtTime(iso) {
      if (!iso) return "—";
      try {
        return new Date(iso).toLocaleTimeString("zh-CN", { hour12: false });
      } catch {
        return iso;
      }
    }

    /** 面板体：状态 + 待确认 + 任务 + 事件。 */
    function DeckBody(props) {
      const [state, setState] = React.useState(null);
      const [error, setError] = React.useState(null);
      const [tick, setTick] = React.useState(0);

      React.useEffect(() => {
        let alive = true;
        async function poll() {
          try {
            const next = await getJson("/api/deck-studio.state");
            if (alive) {
              setState(next);
              setError(null);
            }
          } catch (err) {
            if (alive) setError(err?.message ?? String(err));
          }
        }
        poll();
        const timer = setInterval(poll, POLL_MS);
        return () => {
          alive = false;
          clearInterval(timer);
        };
      }, [tick]);

      const refresh = () => setTick((value) => value + 1);

      if (error) {
        return h("div", { id: "dsh-deck-studio-panel" },
          h("div", { className: "dds-card" },
            h("p", { className: "dds-eyebrow" }, "Deckline"),
            h("h3", null, "读不到运行状态"),
            h("p", { className: "dds-warn" }, String(error)),
            h("p", { className: "dds-meta" }, "确认 profile 里已挂载 dsh-plugin-deck-studio 且路由可用。"),
            h("button", { onClick: refresh }, "重试"),
          ));
      }
      if (!state) {
        return h("div", { id: "dsh-deck-studio-panel" }, h("p", { className: "dds-meta" }, "加载中…"));
      }

      const waiting = state.pendingProposals ?? [];
      const tasks = state.tasks ?? [];
      const events = state.events ?? [];
      const decks = state.decks ?? [];

      return h("div", { id: "dsh-deck-studio-panel" },
        h("div", { className: "dds-card" },
          h("p", { className: "dds-eyebrow" }, "Deckline · 观测"),
          h("h3", null, state.displayName ?? "dsh-deck-studio"),
          h("p", { className: "dds-meta" },
            `渲染：${state.renderMode} · ${state.renderModel} ｜ 工具：${state.toolsMounted ? "已挂载" : "未挂载（观测模式）"} ｜ 数据：${state.dataRoot}`),
          h("p", { className: "dds-meta" },
            "对话入口 = DSH 原生 Chat，选择「Deckline · image deck」preset 即进入 Deck Agent 会话。"),
          h("p", { style: { marginTop: 10 } },
            h("a", { href: "/api/deck-studio.app", target: "_blank", rel: "noreferrer", className: "dds-open-workbench" },
              "打开完整工作台 UI ↗"),
            h("div", { className: "dds-meta" },
              "三栏 Observation 工作台：左侧 Chat 直连 DSH 会话，中间 storyboard 与右侧 Inspector 读真实 .deck 数据。"),
          ),
        ),

        h("div", { className: "dds-card" },
          h("p", { className: "dds-eyebrow" }, `受控 deck 源（${decks.length}）`),
          decks.length === 0
            ? h("p", { className: "dds-meta" }, "未配置 deck 源——检查 preset 配置里的 decks。")
            : decks.map((deck) => h("div", { key: deck.deckId, style: { marginBottom: 8 } },
                h("div", null, h("b", null, deck.deckId), " ", h("span", { className: "dds-meta" }, `· ${deck.title}`)),
                h("div", { className: "dds-meta" },
                  `${deck.pageCount} 页 · ${deck.status || "—"} · 源${deck.sourceAvailable ? "可读" : "不可读"}`),
                ...(deck.warnings ?? []).map((warning, index) => h("div", { key: index, className: "dds-warn" }, `⚠ ${warning}`)),
              )),
        ),

        h("div", { className: "dds-card" },
          h("p", { className: "dds-eyebrow" }, `待你确认（${waiting.length}）`),
          waiting.length === 0
            ? h("p", { className: "dds-meta" }, "暂无 waiting-user 提案。")
            : waiting.map((proposal) => h("div", { key: proposal.proposalId, style: { marginBottom: 8 } },
                h("div", null, h("code", null, proposal.proposalId), " ", h("b", null, `${proposal.pageId} · ${proposal.field}`)),
                proposal.reason ? h("div", { className: "dds-meta" }, `理由：${proposal.reason}`) : null,
                h("div", { className: "dds-meta" }, `创建于 ${fmtTime(proposal.createdAt)} · 在 Chat 里回复确认或驳回即可。`),
              )),
        ),

        h("div", { className: "dds-card" },
          h("p", { className: "dds-eyebrow" }, `任务（最近 ${tasks.length}）`),
          h("table", null,
            h("thead", null, h("tr", null, ["task", "类型", "状态", "deck", "页", "创建"].map((label) => h("th", { key: label }, label)))),
            h("tbody", null,
              tasks.length === 0
                ? h("tr", null, h("td", { colSpan: 6, className: "dds-meta" }, "还没有任务——去 Chat 里开始。"))
                : tasks.map((task) => h("tr", { key: task.taskId },
                    h("td", null, h("code", null, task.taskId)),
                    h("td", null, task.kind),
                    h("td", null, h(Pill, { value: task.status })),
                    h("td", null, task.deckId ?? "—"),
                    h("td", null, (task.slideIds ?? []).join(",") || "—"),
                    h("td", { className: "dds-meta" }, fmtTime(task.createdAt)),
                  ))),
          ),
          Object.keys(state.taskCounts ?? {}).length > 0
            ? h("p", { className: "dds-meta", style: { marginTop: 6 } },
                Object.entries(state.taskCounts).map(([key, value]) => `${key}:${value}`).join(" ｜ "))
            : null,
        ),

        h("div", { className: "dds-card" },
          h("p", { className: "dds-eyebrow" }, `事件流水（最近 ${events.length}）`),
          h("table", null,
            h("thead", null, h("tr", null, ["时间", "事件", "状态", "对象", "角色"].map((label) => h("th", { key: label }, label)))),
            h("tbody", null,
              events.length === 0
                ? h("tr", null, h("td", { colSpan: 5, className: "dds-meta" }, "暂无事件。"))
                : events.map((event) => h("tr", { key: event.eventId },
                    h("td", { className: "dds-meta" }, fmtTime(event.timestamp)),
                    h("td", null, event.type),
                    h("td", null, h(Pill, { value: event.status })),
                    h("td", { className: "dds-meta" }, [event.deckId, ...(event.slideIds ?? [])].filter(Boolean).join(" / ") || "—"),
                    h("td", null, event.actor),
                  ))),
          ),
        ),

        h("div", { className: "dds-foot" },
          h("span", null, `↻ 每 ${Math.round(POLL_MS / 1000)} 秒刷新`),
          h("span", null, `v${state.version ?? "?"} · ${fmtTime(state.generatedAt)}`),
          h("button", { onClick: refresh }, "立即刷新"),
        ),
        props?.onOpenWorkbench
          ? h("div", { style: { marginTop: 10 } },
              h("button", { className: "dds-open-workbench", onClick: props.onOpenWorkbench, style: { border: 0, cursor: "pointer" } }, "打开 Deck 工作台（对话用 DSH 原生 Chat）"))
          : null,
      );
    }

    /** 侧栏 glyph（降级 panellist / footer 用）。 */
    function DeckGlyph() {
      return h("span", { style: { fontSize: 13 } }, "▦");
    }

    function MainPanel() {
      return h("div", { style: { height: "100%", minHeight: 0 } }, h(DeckBody));
    }

    /**
     * 主区「Deck 工作台」：iframe 复用工作台页面本身（不 embed）。
     * 打开先到主页（#/home/decks），点 deck 后是左中右三栏：左原生 Chat / 中间整页图片 / 右资料库。
     * 对话仍走 DSH 原生 Chat（工作台左栏嵌 `/?decklineChat=1`），权限、附件、模型、思考过程、气泡都是原生的。
     */
    function WorkbenchFrame() {
      return h("iframe", {
        id: "dsh-deck-workbench-frame",
        title: "Deckline 工作台",
        src: "/api/deck-studio.app#/home/decks",
        style: { width: "100%", height: "100%", border: 0, display: "block", background: "#faf8f2" },
        // F-102：全屏演示要能用真全屏；跨域 iframe 没有这项授权时 requestFullscreen 会被拒。
        allow: "clipboard-write; fullscreen",
        allowFullScreen: true,
      });
    }

    /** 客户端插件体：样式 + 槽位注册。 */
    function apply(ctx) {
      injectStylesheet();
      // 工作台左栏会把 DSH 原生 Chat 以 `/?decklineChat=1` 嵌进来（同源 iframe）。
      // 那个嵌套的 DSH 实例不再自动打开工作台，否则会层层嵌套（F-68）。
      const chatEmbed = new URLSearchParams(window.location.search).get("decklineChat") === "1";
      if (chatEmbed) ctx.logger?.info?.("deck-studio client: chat-embed mode (bridge only, no workbench shell)");
      const openTab = () => {
        const sidebarRight = ctx.get?.("sidebarRight") ?? ctx.sidebarRight;
        if (!sidebarRight?.openTab) throw new Error("右侧面板服务（ctx.sidebarRight）未加载");
        sidebarRight.openTab(KIND);
      };
      const layout = ctx.get?.("layout") ?? ctx.layout ?? null;
      /** F-69：是否收起宿主左侧栏 —— 只认 profile 显式配置，默认不动其他 profile 的 DSH 界面。 */
      let hideShellSidebar = false;
      /** F-69：DSH 外壳左侧栏默认收起（Web 端 collapsed 仍留 56px 图标栏，样式里已收成 0px）。 */
      const collapseShellSidebar = () => {
        try {
          if (!layout?.toggleSidebar) return;
          if (document.querySelector("[data-sidebar-collapsed]")) return;
          layout.toggleSidebar();
        } catch (error) {
          ctx.logger?.warn?.("deck-studio: collapse shell sidebar failed", error);
        }
      };
      const openWorkbench = () => {
        if (!layout?.selectPanel) throw new Error("布局服务（ctx.layout）未加载，无法打开工作台");
        layout.selectPanel(WORKBENCH_KEY);
        if (hideShellSidebar) collapseShellSidebar();
      };
      const closeWorkbench = () => layout?.selectPanel?.(null);

      const currentSessionId = () => {
        try {
          const raw = window.localStorage.getItem("dsh.sessions.current");
          return raw ? JSON.parse(raw).sessionId || "" : "";
        } catch {
          return "";
        }
      };
      const sendToSession = async (sessionId, text) => {
        const sessions = ctx.sessions;
        if (!sessions?.scope) throw new Error("sessions service unavailable");
        if (!sessionId) throw new Error("no target session");
        const scoped = sessions.scope(sessionId);
        if (!scoped) throw new Error(`session ${sessionId} is not retained`);
        // 会话级上下文需要显式 inject 才能拿到 conversation 服务。
        await new Promise((resolve, reject) => {
          let started = false;
          const timer = setTimeout(() => {
            if (!started) reject(new Error("conversation service unavailable in session scope"));
          }, 1500);
          scoped.inject(["conversation"], (scopedCtx) => {
            started = true;
            clearTimeout(timer);
            Promise.resolve(scopedCtx.conversation.send(text)).then(resolve, reject);
          });
        });
        return sessionId;
      };


      // 工作台 iframe → 宿主：回到 Conversation（原生对话）
      ctx.effect(() => {
        const onMessage = (event) => {
          if (event?.data?.type === "dsh-deck-studio:close") closeWorkbench();
        };
        window.addEventListener("message", onMessage);
        return () => window.removeEventListener("message", onMessage);
      }, "deck-studio: workbench close bridge");

      /* 工作台 iframe → 宿主：把一条完整 prompt 发进当前会话的原生 Chat。 */
      ctx.effect(() => {
        const sendToChat = async (text) => {
          const sessionId = currentSessionId();
          if (!sessionId) throw new Error("no current session");
          return sendToSession(sessionId, text);
        };
        const onMessage = (event) => {
          if (event?.data?.type !== "dsh-deck-studio:prompt") return;
          const text = String(event.data.text ?? "");
          if (!text.trim()) return;
          const reply = (payload) => {
            try {
              event.source?.postMessage({ type: "dsh-deck-studio:prompt-ack", ...payload }, "*");
            } catch {
              /* 跨窗口失效就忽略 */
            }
          };
          sendToChat(text)
            .then((sessionId) => reply({ ok: true, sessionId }))
            .catch((error) => {
              ctx.logger?.warn?.("deck-studio: prompt bridge failed", error);
              reply({ ok: false, reason: String(error?.message ?? error) });
            });
        };
        window.addEventListener("message", onMessage);
        return () => window.removeEventListener("message", onMessage);
      }, "deck-studio: prompt bridge");

      /**
       * F-164：自动新建的会话要落进一个 DSH 工作区，而不是「未分组」。
       * F-165：显式 workspacePath → 启动目录所属工作区 / 登记启动目录 → 源目录工作区 → 默认工作区。
       * 工作区创建失败必须报错，不能悄悄建立未分组会话。
       */
      /** 取一个可选服务：没 inject 的服务用 ctx.xxx 直取会 throw，这里统一吞掉。 */
      function optionalService(name) {
        try {
          const viaGet = ctx.get?.(name);
          if (viaGet) return viaGet;
        } catch {
          /* ctx.get 不可用 */
        }
        try {
          return ctx[name] ?? null;
        } catch {
          return null;
        }
      }

      async function resolveSessionWorkspace(data) {
        const workspaces = optionalService("workspaces");
        if (!workspaces?.list?.getSnapshot || !workspaces?.create) {
          throw new Error("工作区服务不可用，未创建会话；请检查 DSH 版本并重试");
        }
        await workspaces.refresh?.();
        const items = workspaces.list.getSnapshot().items ?? [];
        const normalize = (path) => String(path ?? "").replace(/\\/g, "/").replace(/\/+$/, "");
        const containing = (path) => items
          .filter((item) => normalize(path) === normalize(item.path) || normalize(path).startsWith(`${normalize(item.path)}/`))
          .sort((a, b) => b.path.length - a.path.length)[0];
        const register = async (path) => {
          const workspace = await workspaces.create({ path });
          if (!workspace?.workspaceId) throw new Error("工作区创建未返回 workspaceId");
          return workspace.workspaceId;
        };
        const configured = String(data.workspacePath ?? "").trim();
        if (configured) return register(configured);
        const cwd = String(data.cwd ?? "").trim();
        if (cwd) {
          const hit = containing(cwd);
          if (hit) return hit.workspaceId;
          // 不把插件安装目录或 DSH 私有数据目录登记成用户工作区。
          const path = normalize(cwd);
          const internal = /(^|\/)node_modules(\/|$)|(^|\/)\.dsh(\/|$)/.test(path);
          if (path && path !== "/" && !internal) return register(cwd);
        }
        const sourceRoot = String(data.sourceRoot ?? "").trim();
        const sourceWorkspace = sourceRoot ? containing(sourceRoot) : null;
        if (sourceWorkspace) return sourceWorkspace.workspaceId;
        const fallback = await workspaces.initializeDefault?.();
        if (fallback?.workspaceId) return fallback.workspaceId;
        throw new Error("无法确定启动工作区，未创建会话；请配置 workspacePath 后重试");
      }

      async function ensureConversationSession(data) {
        const sessions = ctx.sessions;
        if (!sessions?.create) throw new Error("sessions service unavailable");
        const sessionId = String(data.sessionId ?? "").trim();
        if (sessionId) {
          await sessions.refresh?.();
          const readPreset = () => {
            const state = sessions.list?.getSnapshot?.();
            const row = state?.byId?.[sessionId] || state?.items?.find((item) => (item.sessionId || item.id) === sessionId);
            return row?.projectionValues?.agentPreset ?? row?.projections?.values?.agentPreset
              ?? state?.projectionsBySession?.[sessionId]?.values?.agentPreset;
          };
          await sessions.refreshProjections?.(sessionId);
          const preset = readPreset();
          if (preset === "deck-studio") return sessionId;
          if (!preset) throw new Error("无法核对会话模式，请刷新后重试；原会话已保留");
          // 已有非空会话不能换 preset：保留原历史，另建制作会话，工作台负责追加绑定。
        }
        const workspaceId = await resolveSessionWorkspace(data);
        const created = await sessions.create({ workspaceId, agentPreset: "deck-studio" });
        if (!created) throw new Error("session create returned no id");
        return created;
      }

      /* 工作台 → 宿主：建/切会话并绑定 deck|design（F-43：每个会话必须有绑定）。
       * - action=open：切到给定 sessionId；
       * - action=ensure：核对制作模式后复用，否则指定工作区和 Deckline preset 新建再切，
       *   然后可选地把首条 prompt 发进去（design 会话确认后「chat 开始工作」）。 */
      ctx.effect(() => {
        const onMessage = async (event) => {
          const data = event?.data ?? {};
          if (data.type !== "dsh-deck-studio:conversation") return;
          const reply = (payload) => {
            try {
              event.source?.postMessage({ type: "dsh-deck-studio:conversation-ack", requestId: data.requestId ?? null, ...payload }, "*");
            } catch {
              /* 跨窗口失效忽略 */
            }
          };
          try {
            const uiWorkspace = optionalService("uiWorkspace");
            if (!uiWorkspace?.openSession) throw new Error("uiWorkspace service unavailable");
            let sessionId = String(data.sessionId ?? "").trim();
            if (data.action === "ensure") sessionId = await ensureConversationSession(data);
            if (!sessionId) throw new Error("没有目标会话");
            if (data.action === "open" || data.action === "ensure") uiWorkspace.openSession(sessionId);
            if (data.prompt && data.action === "ensure" && sessionId !== String(data.sessionId ?? "")) {
              await sendToSession(sessionId, String(data.prompt));
            }
            reply({ ok: true, sessionId });
          } catch (error) {
            ctx.logger?.warn?.("deck-studio: conversation bridge failed", error);
            reply({ ok: false, reason: String(error?.message ?? error) });
          }
        };
        window.addEventListener("message", onMessage);
        return () => window.removeEventListener("message", onMessage);
      }, "deck-studio: conversation bridge");

      if (!chatEmbed) {
        /* 工作台顶栏「☰ DSH」→ 宿主：临时展开 / 收起左侧栏（需要看会话、插件、设置时用）。 */
        ctx.effect(() => {
          const onMessage = (event) => {
            if (event?.data?.type !== "dsh-deck-studio:toggle-shell-sidebar") return;
            if (!hideShellSidebar) return;
            try {
              layout?.toggleSidebar?.();
            } catch (error) {
              ctx.logger?.warn?.("deck-studio: toggle shell sidebar failed", error);
            }
          };
          window.addEventListener("message", onMessage);
          return () => window.removeEventListener("message", onMessage);
        }, "deck-studio: shell sidebar bridge");

        /* F-69：读 profile 配置决定是否收起宿主左侧栏（默认 false，其他 profile / 3080 不受影响）。 */
        ctx.effect(() => {
          let cancelled = false;
          getJson(`${ROUTE_PREFIX}status`)
            .then((status) => {
              if (cancelled || status?.hideShellSidebar !== true) return;
              hideShellSidebar = true;
              injectShellSidebarStyle();
              collapseShellSidebar();
            })
            .catch((error) => ctx.logger?.warn?.("deck-studio: hideShellSidebar config unavailable", error));
          return () => {
            cancelled = true;
          };
        }, "deck-studio: hide shell sidebar config");

        const hasRightbar = Boolean(ctx.sidebarRightTabs?.register && ctx.sidebarRight?.openTab);

        // 主区工作台面板：DSH 原生 Chat 保留在侧栏，主区显示 deck 观测/编辑。
        if (layout?.selectPanel) {
          ctx.effect(
            () => ctx.slots.inject("main", () => ctx.slots.register({ name: "main", key: WORKBENCH_KEY }, WorkbenchFrame)),
            "deck-studio: workbench main panel",
          );
        }

        // 启动即打开工作台（F-63：不用先点左侧 Deckline 再点右侧按钮）。
        // 等布局槽位注册完成再打开；若用户已经切到别的面板（如 Plugins）就不抢占。
        ctx.effect(() => {
          let timer = 0;
          let attempts = 0;
          const open = () => {
            try {
              const activePanelId = layout?.panelInfo?.getSnapshot?.()?.activePanelId ?? null;
              if (activePanelId === null) openWorkbench();
            } catch (error) {
              if (attempts++ < 6) timer = window.setTimeout(open, 500);
              else ctx.logger?.warn?.("deck-studio: auto-open workbench failed", error);
            }
          };
          timer = window.setTimeout(open, 700);
          return () => window.clearTimeout(timer);
        }, "deck-studio: auto-open workbench");

        // 唯一入口：侧栏脚部一个「Deckline」按钮（重新打开工作台）；→ 对话用工作台里的「← 回到对话」。
        if (hasRightbar) {
          ctx.effect(
            () => ctx.slots.inject("sidebar.footer.action", () =>
              ctx.slots.register({ name: "sidebar.footer.action", id: `${PLUGIN_ID}-workbench` }, (props) => {
                const button = h("button", { onClick: openWorkbench, title: "打开 Deck 工作台（对话在 DSH 原生 Chat）", style: { cursor: "pointer" } },
                  h("span", { style: { fontSize: 13 } }, "▤"), props?.wide ? h("span", { style: { marginLeft: 4 } }, "Deckline") : null);
                return button;
              })),
            "deck-studio: workbench footer button",
          );
          ctx.logger?.info?.("deck-studio client: workbench-only mode");
        } else {
          ctx.effect(
            () => ctx.slots.inject("main", () => ctx.slots.register({ name: "main", key: PANEL_KEY }, () => h(DeckBody, { onOpenWorkbench: openWorkbench }))),
            "deck-studio: main panel (fallback)",
          );
          ctx.effect(
            () => ctx.slots.inject("sidebar.panellist", () =>
              ctx.slots.register({ name: "sidebar.panellist", id: PANEL_KEY, order: 46, label: () => "Deckline" }, DeckGlyph)),
            "deck-studio: sidebar button (fallback)",
          );
          ctx.logger?.info?.("deck-studio client: main-panel fallback mode");
        }
      }
    }

    exports.apply = apply;
    exports.inject = ["slots", "sidebarRightTabs", "sidebarRight", "layout", "sessions", "conversation", "uiWorkspace"];
    exports.PLUGIN_ID = PLUGIN_ID;
    exports.KIND = KIND;
    exports.PANEL_KEY = PANEL_KEY;
    exports.WORKBENCH_KEY = WORKBENCH_KEY;
    exports.DeckBody = DeckBody;

    return module.exports;
  },
});
