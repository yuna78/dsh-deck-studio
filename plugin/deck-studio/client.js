/**
 * dsh-plugin-deck-studio —— 观测面板（浏览器半）。
 *
 * 只画界面、只 fetch `/api/deck-studio.*`；不碰文件系统、无外网请求。
 * 数据全部由宿主半聚合好（浏览器半只做展示，不重算业务口径）。
 *
 * 形态：主区「Deck 工作台」面板（iframe 复用 /api/deck-studio.app?embed=1）。
 * 启动后自动打开（零点击进入），侧栏只保留一个带图标的「Deckline」面板入口（与其它插件同形态）；
 * 不再注册右侧 dockkit 观测标签页（F-63：入口太多且丑），也不再占用侧栏脚部按钮。
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
    /**
     * F-202B（ADR-0027）：桌面宿主的 shell 起源是自定义协议（如 dsh-app://），嵌 DSH 页面的
     * 子帧拿不到 boot 注入、流式端点也不可达 —— 桌面里对话改用「原生会话 Dock」；
     * web（http）宿主继续走工作台内嵌的 DSH iframe。
     */
    const DESKTOP_SHELL = !/^(https?:)$/.test(location.protocol);
    /** 桌面 Dock 渲染会话用的子弹槽名（shell.overlay 条目下的 session 作用域子槽）。 */
    const CHAT_SLOT = `${WORKBENCH_KEY}.chat`;

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

    /** 侧栏图标（panellist 行用）：叠卡片 + 星芒，单色 currentColor，跟随主题深浅色。 */
    function DeckGlyph({ size }) {
      const edge = size || 16;
      return h("svg", {
        width: edge,
        height: edge,
        viewBox: "0 0 16 16",
        fill: "none",
        "aria-hidden": "true",
        style: { display: "block" },
      },
        h("rect", {
          x: 4.8, y: 2.4, width: 8.2, height: 6.2, rx: 1.5,
          stroke: "currentColor", strokeWidth: 1.2, opacity: 0.55,
        }),
        h("rect", {
          x: 2.4, y: 5.2, width: 9.2, height: 6.8, rx: 1.6,
          stroke: "currentColor", strokeWidth: 1.35,
        }),
        h("path", {
          d: "M4.6 7.6h4.6M4.6 9.6h3",
          stroke: "currentColor", strokeWidth: 1.2, strokeLinecap: "round",
        }),
        h("path", {
          d: "M12.5 9.9l.45 1.15 1.15.45-1.15.45-.45 1.15-.45-1.15-1.15-.45 1.15-.45z",
          fill: "currentColor",
        }),
      );
    }

    function MainPanel() {
      return h("div", { style: { height: "100%", minHeight: 0 } }, h(DeckBody));
    }

    /**
     * 主区「Deck 工作台」：iframe 复用工作台页面本身（不 embed）。
     * 打开先到主页（#/home/decks），点 deck 后是左中右三栏：左原生 Chat / 中间整页图片 / 右资料库。
     * 对话仍走 DSH 原生 Chat（工作台左栏嵌 `/?decklineChat=1`），权限、附件、模型、思考过程、气泡都是原生的。
     */

    /**
     * 桌面 Dock（F-202B / ADR-0027 升级）：桌面里不再嵌 DSH 页面，用宿主 `shell.overlay` +
     * SessionProvider + `sessions.retain` 把**原生会话**渲染到工作台对话列的位置
     * （multichat / html-deck-studio 同款做法，注册形状已在该宿主验证）。
     * 工作台（iframe）把当前绑定会话经 `dsh-deck-studio:chat-session` 报上来；
     * Dock 测量工作台 iframe 里 `#chatDockArea` 的矩形后固定覆盖其上。
     */
    /** 客户端插件体：样式 + 槽位注册。 */
    function apply(ctx) {
      injectStylesheet();
    function WorkbenchFrame() {
      return h("iframe", {
        id: "dsh-deck-workbench-frame",
        ref: (node) => setWorkbenchFrame(node),
        title: "Deckline 工作台",
        src: "/api/deck-studio.app#/home/decks",
        style: { width: "100%", height: "100%", border: 0, display: "block", background: "#faf8f2" },
        // F-102：全屏演示要能用真全屏；跨域 iframe 没有这项授权时 requestFullscreen 会被拒。
        allow: "clipboard-write; fullscreen",
        allowFullScreen: true,
      });
    }

      const dockState = { sessionId: "", listeners: new Set() };
      function publishDockSession(sessionId) {
        const next = typeof sessionId === "string" ? sessionId : "";
        if (dockState.sessionId === next) return;
        dockState.sessionId = next;
        for (const listener of dockState.listeners) listener();
      }
      function subscribeDockSession(listener) {
        dockState.listeners.add(listener);
        return () => dockState.listeners.delete(listener);
      }

      /**
       * Dock 覆盖层的临时隐藏（F-217）：工作台里的会话下拉展开时，需要一个「宿主不挡」的矩形。
       * 覆盖层是宿主 DOM（fixed, z-index 40），iframe 里画的菜单永远在它下面——所以开合下拉时
       * 由工作台发消息、宿主把覆盖层 visibility:hidden（保留布局，不触发重新测量）。
       */
      const dockVisibility = { hidden: false, listeners: new Set() };
      function setDockHidden(hidden) {
        const next = hidden === true;
        if (dockVisibility.hidden === next) return;
        dockVisibility.hidden = next;
        for (const listener of dockVisibility.listeners) listener();
      }
      function subscribeDockHidden(listener) {
        dockVisibility.listeners.add(listener);
        return () => dockVisibility.listeners.delete(listener);
      }

      /** 工作台 iframe 元素引用（React ref）；Dock 靠它测矩形 / 报「Dock 已就绪」。 */
      const frameState = { el: null, listeners: new Set() };
      function setWorkbenchFrame(node) {
        const next = node ?? null;
        if (frameState.el === next) return;
        frameState.el = next;
        for (const listener of frameState.listeners) listener();
      }
      function subscribeWorkbenchFrame(listener) {
        frameState.listeners.add(listener);
        return () => frameState.listeners.delete(listener);
      }

      /** 会话内容视图：复用宿主 `conversation.session` 槽（不是复制品）。 */
      function DeckChatView(props) {
        return props.renderSlot("conversation.session", { view: "chat" });
      }
      function DeckChatBody({ useSession, useConversation, renderFactorySlot }) {
        const session = useSession((value) => value);
        const active = useConversation((value) => value).activeTargets;
        const phase = (!session.blank || session.running || active.size > 0) ? "active" : "hero";
        /**
         * 0.2.23：**回退** 0.2.22 的 sessionId 透传。
         *
         * 为什么当时要透传：宿主的 composer 链是
         *   useSessionStatus(s => s.get(sessionId)?.pendingInteraction) → renderSlotChain(...)
         * 审批面板要靠 pendingInteraction 才渲染，我们没传 sessionId 就永远不弹 ask。
         *
         * 为什么回退：透传之后真机上「点会话 → 工作台闪出 → 不到 1s 整片变灰」——
         * 说明在 shell.overlay 这个上下文里让 composer 链去查宿主的主区 pendingInteraction 会直接崩掉
         * 整棵 Dock 子树（外面看不到原因，只看到灰屏）。宁可先保住对话可用，再想别的办法把 ask 露出来。
         */
        return renderFactorySlot("conversation.content", { variant: "embedded", phase, hero: phase === "hero" }, { slots: { views: DeckChatView } });
      }

      /**
       * 0.2.23：Dock 子树的错误边界。
       *
       * 之前 slot 里任何一个组件抛错，整个 overlay 会变成一片空白灰，用户完全不知道发生了什么
       * （这次灰屏就是）。用边界把错误收住，至少把原因写在屏幕上 + 给重试和「去主区对话」的出路。
       */
      class DockErrorBoundary extends React.Component {
        constructor(props) {
          super(props);
          this.state = { error: null };
        }
        static getDerivedStateFromError(error) {
          return { error };
        }
        componentDidCatch(error) {
          try {
            ctx.logger?.warn?.("deck-studio: chat dock crashed", error);
          } catch {
            /* 日志不可用时忽略 */
          }
        }
        render() {
          if (!this.state.error) return this.props.children;
          const message = String(this.state.error?.message ?? this.state.error ?? "未知错误");
          return h(
            "div",
            { style: { height: "100%", padding: 16, overflow: "auto", background: "#fdf7f3", color: "#7a3b2e", fontSize: 12, lineHeight: 1.7 } },
            h("div", { style: { fontWeight: 600, marginBottom: 6 } }, "对话区加载失败"),
            h("div", { style: { color: "#5c6464", wordBreak: "break-word" } }, message),
            h(
              "button",
              {
                type: "button",
                style: { marginTop: 10, marginRight: 8, padding: "4px 10px", fontSize: 12, cursor: "pointer" },
                onClick: () => this.setState({ error: null }),
              },
              "重试",
            ),
            h("div", { style: { marginTop: 10, color: "#5c6464" } }, "也可以点顶栏「☰ DSH」去宿主主区的对话里继续。"),
          );
        }
      }
      /** Dock：测量工作台对话占位矩形；用 retain 的会话引用喂 SessionProvider。 */
      function DeckChatDock({ SessionProvider, renderSlot }) {
        const sessionId = React.useSyncExternalStore(subscribeDockSession, () => dockState.sessionId);
        // 主区面板卸载/重建时 iframe 元素会换，Dock 必须跟着重算位置，否则切走再切回来就不见了。
        const frameEl = React.useSyncExternalStore(subscribeWorkbenchFrame, () => frameState.el);
        const dockHidden = React.useSyncExternalStore(subscribeDockHidden, () => dockVisibility.hidden);
        const [rect, setRect] = React.useState(null);
        const [reference, setReference] = React.useState(null);
        React.useEffect(() => {
          const measure = () => {
            let next = null;
            try {
              const outer = frameEl?.getBoundingClientRect?.();
              // 只盖住对话框的内容区（#chatDockArea），把上面的绑定/＋/会话菜单那一行留出来。
              const inner = frameEl?.contentDocument?.querySelector("#chatDockArea")?.getBoundingClientRect?.();
              if (outer && inner && outer.width > 0 && inner.width > 4 && inner.height > 4) {
                next = {
                  left: Math.round(outer.left + inner.left),
                  top: Math.round(outer.top + inner.top),
                  width: Math.round(inner.width),
                  height: Math.round(inner.height),
                };
              }
            } catch {
              next = null;
            }
            setRect((prev) => (prev && next && prev.left === next.left && prev.top === next.top && prev.width === next.width && prev.height === next.height) ? prev : next);
          };
          measure();
          if (!frameEl) { setRect(null); return undefined; }
          const timer = setInterval(measure, 800);
          window.addEventListener("resize", measure);
          return () => { clearInterval(timer); window.removeEventListener("resize", measure); };
        }, [frameEl]);
        // 引用放 state（不是 ref）：StrictMode 的 effect 重放与 ref 释放会让提交渲染时 ref 为空。
        React.useEffect(() => {
          const sessions = ctx.sessions;
          if (!sessionId || typeof sessions?.retain !== "function") { setReference(null); return undefined; }
          let held = null;
          try { held = sessions.retain(sessionId, { source: WORKBENCH_KEY }); } catch (error) { ctx.logger?.warn?.(`deck-studio: retain failed: ${error?.message ?? error}`); }
          setReference(held ?? null);
          return () => { try { held?.release?.(); } catch { /* 已释放 */ } };
        }, [sessionId]);
        // Dock 已在渲染：告诉工作台 iframe 收起降级卡（#chatHostCard）。
        React.useEffect(() => {
          if (!rect || !reference || !frameEl?.contentWindow) return;
          try { frameEl.contentWindow.postMessage({ type: "dsh-deck-studio:chat-dock" }, "*"); } catch { /* 不可达时降级卡留着 */ }
        }, [rect, reference]);
        if (!SessionProvider || !renderSlot || !reference || !rect) return null;
        // 0.2.23：把覆盖层夹在可视区内。测量一旦拿到「整窗」尺寸（面板刚切换、iframe 还没布局），
        // 这个 fixed 覆盖层会把整个应用盖住，看起来就是「整片灰、啥也没有」。
        const viewportW = typeof window !== "undefined" ? window.innerWidth : rect.width;
        const viewportH = typeof window !== "undefined" ? window.innerHeight : rect.height;
        const left = Math.max(0, Math.min(rect.left, Math.max(0, viewportW - 120)));
        const top = Math.max(0, Math.min(rect.top, Math.max(0, viewportH - 120)));
        const width = Math.max(120, Math.min(rect.width, viewportW - left));
        const height = Math.max(160, Math.min(rect.height, viewportH - top));
        return h("div", {
          "data-deck-studio-chat-dock": "",
          // 会话下拉展开时（工作台发 chat-dock-visibility:false）临时隐藏：保留布局与测量，
          // 只把覆盖层让开，让 iframe 里的下拉能被看见、能点。
          style: { position: "fixed", left: `${left}px`, top: `${top}px`, width: `${width}px`, height: `${height}px`, zIndex: 40, display: "flex", flexDirection: "column", minHeight: 0, overflow: "hidden", background: "var(--paper,#faf8f2)", borderRight: "1px solid var(--line,#e8e2d6)", pointerEvents: dockHidden ? "none" : "auto", visibility: dockHidden ? "hidden" : "visible" },
        }, h(DockErrorBoundary, null, h(SessionProvider, { session: reference }, renderSlot(CHAT_SLOT, {}))));
      }
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

      /**
       * 0.2.17：从 DSH 侧栏的会话直接拉起 Deckline 工作区（对齐 html-deck-studio 的同款交互）。
       *
       * 宿主把「当前主区会话」记在 `sessions.list` 的 `retainedBy.mainView` 上。切到一本
       * 已绑定 deck / design 的会话时，自动打开工作台并切到那本 deck —— 省掉「先点 Deckline
       * 面板、再选 deck」两步；会话行「⋯」菜单里也给一个显式入口。
       */
      const activeMainSessionId = () => {
        try {
          const list = ctx.sessions?.list?.getSnapshot?.();
          if (!list?.byId) return "";
          return Object.values(list.byId).find((row) => (row?.retainedBy?.mainView ?? 0) > 0)?.id ?? "";
        } catch {
          return "";
        }
      };
      const activePanelIdOf = () => {
        try {
          return layout?.panelInfo?.getSnapshot?.()?.activePanelId ?? null;
        } catch {
          return null;
        }
      };
      /** 会话 → 绑定实体（服务端绑定表；3s 内复用，列表频繁变化时不重复打接口）。 */
      let bindingsCache = { at: 0, rows: [] };
      const readSessionBindings = async () => {
        if (Date.now() - bindingsCache.at < 3000) return bindingsCache.rows;
        try {
          const res = await fetch("/api/deck-studio.session-bindings", { headers: { accept: "application/json" } });
          const data = await res.json();
          bindingsCache = { at: Date.now(), rows: Array.isArray(data?.bindings) ? data.bindings : [] };
        } catch {
          bindingsCache = { at: Date.now(), rows: bindingsCache.rows };
        }
        return bindingsCache.rows;
      };
      /**
       * 待发往工作台 iframe 的「打开某个 deck / design」指令。
       *
       * 0.2.21：发出去**不清空**——面板刚挂载时 iframe 里的脚本还没起来，早发的那几帧会被丢掉，
       * 表现成「工作区弹出来了但停在首页」。现在等 iframe 回 `open-binding-ack` 才算送达，
       * 期间由 ready 消息 + 多档定时重试兜底；20s 还没 ack 就放弃，避免下次误打开旧 deck。
       */
      let pendingOpen = null;
      const flushPendingOpen = () => {
        const pending = pendingOpen;
        const win = frameState.el?.contentWindow;
        if (!pending || !win) return;
        try {
          win.postMessage({ type: "dsh-deck-studio:open-binding", ...pending }, "*");
        } catch {
          /* iframe 还没就绪：等 ready 消息或下一次重试 */
        }
      };
      const scheduleFlush = () => {
        [60, 220, 600, 1400, 2600, 4200].forEach((delay) => window.setTimeout(flushPendingOpen, delay));
      };
      const openBindingInWorkbench = (target) => {
        if (!target || (!target.id && !target.notice)) return false;
        openWorkbench();
        pendingOpen = { kind: target.kind ?? "deck", id: target.id ?? "", title: target.title ?? "", notice: target.notice ?? "" };
        flushPendingOpen();
        scheduleFlush();
        const expected = pendingOpen;
        window.setTimeout(() => {
          if (pendingOpen === expected) pendingOpen = null;
        }, 20000);
        return true;
      };
      /** 侧栏点了一个会话：已绑定就直接进那本 deck；没绑定就进工作台并说明怎么绑。 */
      const openSessionInWorkbench = async (sessionId, options = {}) => {
        const id = String(sessionId ?? "").trim();
        if (!id) return false;
        const rows = await readSessionBindings();
        const binding = rows.find((row) => row?.sessionId === id) ?? null;
        if (!binding) {
          if (options.auto) return false;
          return openBindingInWorkbench({
            kind: "none",
            id: "",
            notice: "这个会话还没有绑定 deck / 风格：先选一本 deck，用「＋」新建或切换绑定。",
          });
        }
        return openBindingInWorkbench({
          kind: binding.kind === "design" ? "design" : "deck",
          id: binding.id,
          title: binding.title ?? "",
        });
      };
      /** 会话行「⋯」菜单项：在 Deckline 里打开这个会话绑定的 deck（未绑定给可见提示）。 */
      function OpenDecklineMenuItem({ sessionId, useMenuOpenState }) {
        const menu = typeof useMenuOpenState === "function" ? useMenuOpenState : () => [false, () => {}];
        const [, setMenuOpen] = menu();
        const [busy, setBusy] = React.useState(false);
        const label = busy ? "正在打开 Deckline…" : "在 Deckline 打开";
        const onSelect = () => {
          try {
            setMenuOpen(false);
          } catch {
            /* 菜单状态不可用时仍然执行动作 */
          }
          if (busy) return;
          setBusy(true);
          void openSessionInWorkbench(sessionId).finally(() => setBusy(false));
        };
        return h(
          "button",
          {
            type: "button",
            role: "menuitem",
            "aria-label": label,
            "data-deck-studio-open": "",
            disabled: busy,
            style: {
              width: "100%",
              minHeight: 32,
              padding: "0 12px",
              fontSize: 13,
              display: "flex",
              alignItems: "center",
              justifyContent: "flex-start",
              textAlign: "left",
              border: 0,
              background: "transparent",
              color: "var(--dsw-alias-label-primary)",
              borderRadius: "var(--dsw-radius-sm)",
              cursor: busy ? "default" : "pointer",
            },
            onClick: onSelect,
          },
          label,
        );
      }

      /**
       * 会话行尾悬停按钮（`sidebar.workspaces.session.row.action`）：
       * 点一下就把它绑定的 deck / 设计在 Deckline 打开——比"先点行开对话、再点 ⋯ 菜单"少两步。
       * 宿主会拦掉点击不让它触发行选中，所以这里也显式 stopPropagation。
       */
      function OpenDecklineRowAction({ sessionId }) {
        const [busy, setBusy] = React.useState(false);
        const onOpen = (event) => {
          event?.preventDefault?.();
          event?.stopPropagation?.();
          if (busy) return;
          setBusy(true);
          void openSessionInWorkbench(sessionId).finally(() => setBusy(false));
        };
        return h(
          "button",
          {
            type: "button",
            title: "在 Deckline 打开",
            "aria-label": "在 Deckline 打开",
            "data-deck-studio-row-open": "",
            disabled: busy,
            onClick: onOpen,
            style: {
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              width: 22,
              height: 22,
              padding: 0,
              border: 0,
              background: "transparent",
              color: "var(--dsw-alias-label-secondary, var(--dsw-alias-label-primary))",
              borderRadius: "var(--dsw-radius-sm)",
              cursor: busy ? "default" : "pointer",
            },
          },
          h(DeckGlyph, { size: 14 }),
        );
      }

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
        /**
         * 0.2.20：刚建出来的会话还没被 Dock retain 过，`sessions.scope()` 就是 null——
         * 以前直接抛 `session … is not retained`，于是「新建 deck 后点发送」整条链路失败：
         * 会话建出来了却没绑定、工作区也不弹。这里先自己 retain 一次再取 scope。
         */
        let scoped = sessions.scope(sessionId);
        if (!scoped && typeof sessions.retain === "function") {
          try {
            sessions.retain(sessionId, { source: WORKBENCH_KEY });
          } catch (error) {
            ctx.logger?.warn?.(`deck-studio: retain before send failed: ${error?.message ?? error}`);
          }
          scoped = sessions.scope(sessionId);
        }
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
        /**
         * F-211：优先用工作台指定的会话。
         *
         * 以前只按 `dsh.sessions.current` 发——那是宿主主区（or web iframe）的当前会话。
         * 桌面 Dock 模式（F-202B / ADR-0027）下，工作台左栏显示的是 `dsh-deck-studio:chat-session`
         * 报上来的 deck 绑定会话，两者经常不是同一个：指令落进隔壁会话，界面却提示已发送。
         * 2026-11-07 真机：指令进了未绑定的 session-a274e455，绑定的 session-e2eda8c9 什么都没收到。
         */
        const sendToChat = async (text, sessionId) => {
          const target = String(sessionId ?? "").trim() || currentSessionId();
          if (!target) throw new Error("no current session");
          return sendToSession(target, text);
        };
        const onMessage = (event) => {
          if (event?.data?.type !== "dsh-deck-studio:prompt") return;
          const text = String(event.data.text ?? "");
          const sessionId = String(event.data.sessionId ?? "").trim();
          if (!text.trim()) return;
          const reply = (payload) => {
            try {
              event.source?.postMessage({ type: "dsh-deck-studio:prompt-ack", ...payload }, "*");
            } catch {
              /* 跨窗口失效就忽略 */
            }
          };
          sendToChat(text, sessionId)
            .then((sentTo) => reply({ ok: true, sessionId: sentTo }))
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
          // 0.2.28：`workspaces.create()` 的成功返回值是 `{ workspace, created }`（服务端 HTTP 契约就是
          // `workspaceView(...)` 包一层）；以前直接读 `.workspaceId`，永远 undefined → 抛错 → 建会话失败。
          // html-deck 那边一直是 `result.workspace ?? result` 再取 `workspaceId ?? id`，所以它没这问题。
          const created = await workspaces.create({ path });
          const row = created?.workspace ?? created;
          const workspaceId = row?.workspaceId ?? row?.id;
          if (!workspaceId) throw new Error("工作区创建未返回 workspaceId（返回：" + JSON.stringify(created)?.slice(0, 200) + "）");
          return workspaceId;
        };
        const title = String(data.title ?? "").trim().slice(0, 60);
        const desiredName = title ? `Deckline · ${title}` : "";
        /**
         * 给「deck 自己的工作区」命名（F-210）：侧栏要能一眼看出这是哪本 deck。
         * 重名 / rename 失败只影响侧栏文案，绝不能让建会话失败（html-deck 同款容错）。
         */
        const nameDeckWorkspace = async (workspaceId) => {
          if (!desiredName || typeof workspaces.rename !== "function") return workspaceId;
          try {
            const snapshot = workspaces.list?.getSnapshot?.();
            const rows = snapshot?.phase === "ready" ? snapshot.items ?? [] : items;
            const taken = rows.some((item) => String(item.name ?? "") === desiredName && (item.workspaceId ?? item.id) !== workspaceId);
            if (!taken) await workspaces.rename(workspaceId, desiredName);
          } catch {
            /* 名字冲突 / 权限问题：会话照建 */
          }
          return workspaceId;
        };
        /**
         * 0.2.16 / F-210：**deck 自己的项目目录排第一**。
         * 以前它排在 cwd / sourceRoot 之后，源目录挂在一个更大的工作区下时永远轮不到它——
         * 于是会话落进「sharing」这种大工作区，侧栏永远看不到以 deck 命名的项目。
         */
        const projectPath = String(data.sessionWorkspacePath ?? "").trim();
        if (projectPath) {
          const exact = items.find((item) => normalize(item.path) === normalize(projectPath));
          const exactId = exact?.workspaceId ?? exact?.id;
          if (exactId) return nameDeckWorkspace(exactId);
          try {
            return nameDeckWorkspace(await register(projectPath));
          } catch (error) {
            // 建不了（路径非法 / 落在别的工作区里 / 权限）：退回父工作区，至少别让「开对话」失败。
            const parent = containing(projectPath);
            ctx.logger?.warn?.(`deck-studio: 建 deck 工作区失败（${projectPath}）：${error?.message ?? error}${parent ? "；退回父工作区" : ""}`);
            if (parent?.workspaceId ?? parent?.id) return parent.workspaceId ?? parent.id;
            throw error;
          }
        }
        const configured = String(data.workspacePath ?? "").trim();
        if (configured) return register(configured);
        const cwd = String(data.cwd ?? "").trim();
        if (cwd) {
          const hit = containing(cwd);
          if (hit) return hit.workspaceId;
          // 不把插件安装目录或 DSH 私有数据目录登记成用户工作区。
          const path = normalize(cwd);
          const internal = /(^|\/)node_modules(\/|$)|(^|\/)\.dsh(\/|$)/.test(path);
          // F-202B：桌面宿主里 shell 的 process.cwd 是 App 包目录（/Applications/DeepSeek Harness.app）
          // ——把它登记成用户工作区是错的（web 宿主的 cwd 才是启动目录）。这类系统路径视为不可信，
          // 落到 sourceRoot / 默认工作区兜底，而不是新建一个垃圾工作区。
          const systemPath = path === "/" || path.startsWith("/Applications/") || /^(\/System(\/|$)|\/Library(\/|$)|\/private\/var|\/usr\/|\/opt\/|\/Volumes\/)/.test(path);
          if (path && !internal && !systemPath) return register(cwd);
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
            /**
             * F-202B（ADR-0027）：`open !== false` = 把会话切到宿主主区（web 内嵌 iframe 的原语义，
             * 桌面「在主区打开」的显式入口）；`open:false` = 桌面 Dock 模式——会话已在工作台
             * 左栏原生渲染，只把会话准备好并回 id，不抢宿主主区。会话目录未就绪时短重试
             * （`sessions.retain: unknown session...` 是自愈错误，不是会话丢失）。
             */
            if ((data.action === "open" || data.action === "ensure") && data.open !== false) {
              const delays = [0, 300, 700, 1500, 2500];
              let lastError = null;
              for (const delay of delays) {
                if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
                try { await uiWorkspace.openSession(sessionId); lastError = null; break; } catch (error) {
                  lastError = error;
                  if (!/sessions\.retain|unknown session/i.test(String(error?.message ?? error))) throw error;
                }
              }
              if (lastError) throw lastError;
              if (data.takeMain === true && DESKTOP_SHELL) closeWorkbench();
            }
            let notice = "";
            if (data.prompt && data.action === "ensure" && sessionId !== String(data.sessionId ?? "")) {
              // 0.2.20：首条指令发不出去不该让整条 ensure 失败——会话已经建好，
              // 绑定必须照写（否则 deck 变「未绑定」，工作区也不会自动弹出来）。
              try {
                await sendToSession(sessionId, String(data.prompt));
              } catch (error) {
                notice = `会话已建好并绑定，但首条指令没发出去：${error?.message ?? error}；在工作台里再发一次即可。`;
                ctx.logger?.warn?.(`deck-studio: prompt send failed after ensure: ${error?.message ?? error}`);
              }
            }
            reply({ ok: true, sessionId, ...(notice ? { notice } : {}) });
          } catch (error) {
            ctx.logger?.warn?.("deck-studio: conversation bridge failed", error);
            reply({ ok: false, reason: String(error?.message ?? error) });
          }
        };
        window.addEventListener("message", onMessage);
        return () => window.removeEventListener("message", onMessage);
      }, "deck-studio: conversation bridge");

      /* 桌面 Dock 的会话源：工作台（iframe）周期性把当前绑定会话报上来。 */
      ctx.effect(() => {
        const onMessage = (event) => {
          const data = event?.data ?? {};
          if (data?.type !== "dsh-deck-studio:chat-session" || typeof data.sessionId !== "string") return;
          if (event.source !== (frameState.el?.contentWindow ?? null)) return;
          publishDockSession(data.sessionId);
        };
        window.addEventListener("message", onMessage);
        return () => window.removeEventListener("message", onMessage);
      }, "deck-studio: chat-session bridge");

      /* F-217：工作台开合会话下拉时，把 Dock 覆盖层临时让开（否则下拉画在覆盖层下面，看起来没反应）。 */
      ctx.effect(() => {
        const onMessage = (event) => {
          const data = event?.data ?? {};
          if (data?.type !== "dsh-deck-studio:chat-dock-visibility") return;
          if (event.source !== (frameState.el?.contentWindow ?? null)) return;
          setDockHidden(data.visible === false);
        };
        window.addEventListener("message", onMessage);
        return () => {
          window.removeEventListener("message", onMessage);
          setDockHidden(false);
        };
      }, "deck-studio: chat-dock visibility bridge");

      /**
       * F-202B：桌面「原生会话 Dock」——shell.overlay 容器 + session 作用域内容槽
       * （multichat / html-deck-studio 同款注册形状，SessionProvider 由宿主注入）。
       * web（http 起源）不用 Dock：工作台 iframe 里的 DSH 对话本来就是好的。
       */
      if (DESKTOP_SHELL) {
        ctx.effect(
          () => ctx.slots.inject("shell.overlay", () => ctx.slots.register({
            name: "shell.overlay",
            id: `${WORKBENCH_KEY}.chat`,
            order: 58,
            children: { [CHAT_SLOT]: { kind: "single", scope: "session" } },
          }, DeckChatDock)),
          "deck-studio: chat dock",
        );
        ctx.effect(
          () => ctx.slots.inject(CHAT_SLOT, () => ctx.slots.register({ name: CHAT_SLOT }, DeckChatBody)),
          "deck-studio: chat dock body",
        );
      }

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

        /**
         * 0.2.17：切到「已绑定 deck / design 的会话」时自动拉起工作区。
         * 只在会话真的换了、且主区没有停在别的插件面板时动作；启动时先只记住当前会话不抢视图，
         * 工作台自己打开的那一下不算用户切换（pendingOpen / 自身面板判定都挡掉）。
         */
        ctx.effect(() => {
          const store = ctx.sessions?.list;
          if (!store?.subscribe) return undefined;
          let primed = false;
          let lastActive = "";
          let timer = null;
          let token = 0;
          const onChange = () => {
            const list = store.getSnapshot?.();
            if (!list || list.phase !== "ready") return;
            const active = activeMainSessionId();
            if (!primed) {
              primed = true;
              lastActive = active;
              return;
            }
            if (active === lastActive) return;
            lastActive = active;
            if (!active) return;
            // 会话变化的那一刻取面板：宿主随后会 selectPanel(null)，晚一步就分不清原来停在哪。
            const panelAtChange = activePanelIdOf();
            const mine = ++token;
            window.clearTimeout(timer);
            timer = window.setTimeout(() => {
              if (mine !== token || activeMainSessionId() !== active) return;
              if (panelAtChange !== null && panelAtChange !== WORKBENCH_KEY) return;
              const panel = activePanelIdOf();
              if (panel !== null && panel !== WORKBENCH_KEY) return;
              void openSessionInWorkbench(active, { auto: true }).catch((error) =>
                ctx.logger?.warn?.(`deck-studio: auto-open bound session failed: ${error?.message ?? error}`));
            }, 260);
          };
          const dispose = store.subscribe(onChange);
          onChange();
          return () => {
            window.clearTimeout(timer);
            token += 1;
            if (typeof dispose === "function") dispose();
          };
        }, "deck-studio: session → workbench");

        // 工作台 iframe 就绪：把还没送出去的「打开某本 deck」补发一次。
        ctx.effect(() => {
          const onReady = (event) => {
            if (event.data?.type !== "dsh-deck-studio:workbench-ready") return;
            if (event.source !== (frameState.el?.contentWindow ?? null)) return;
            flushPendingOpen();
          };
          window.addEventListener("message", onReady);
          return () => window.removeEventListener("message", onReady);
        }, "deck-studio: workbench ready bridge");

        // 工作台确认收到「打开某本 deck」→ 才算送达，清掉 pending（没 ack 就继续重试）。
        ctx.effect(() => {
          const onAck = (event) => {
            const data = event.data ?? {};
            if (data.type !== "dsh-deck-studio:open-binding-ack") return;
            if (event.source !== (frameState.el?.contentWindow ?? null)) return;
            if (!pendingOpen || String(data.id ?? "") !== String(pendingOpen.id ?? "")) return;
            const failed = data.ok === false;
            pendingOpen = null;
            if (failed) ctx.logger?.warn?.(`deck-studio: open binding failed: ${data.reason ?? "unknown"}`);
          };
          window.addEventListener("message", onAck);
          return () => window.removeEventListener("message", onAck);
        }, "deck-studio: open-binding ack bridge");

        // 唯一入口：侧栏面板行「Deckline」（与 plugins / schedules 等插件同一种形态，带图标）；
        // → 对话用工作台里的「← 回到对话」。
        // 会话行「⋯」菜单 + 行尾悬停按钮：**不放进 hasRightbar / selectPanel 分支**。
        // 这两个 slot 是宿主可选契约（旧 DSH 没有就只记一条警告）；但一旦被右栏服务门禁包住，
        // 桌面宿主没加载 sidebar-right 时菜单会整个消失——用户看到的效果就是「点会话没反应」。
        try {
          ctx.effect(
            () => ctx.slots.inject("sidebar.workspaces.session.menu.item", () =>
              ctx.slots.register({
                name: "sidebar.workspaces.session.menu.item",
                id: "dsh-plugin-deck-studio.open-binding",
                order: 150,
              }, OpenDecklineMenuItem)),
            "deck-studio: session menu entry",
          );
          ctx.effect(
            () => ctx.slots.inject("sidebar.workspaces.session.row.action", () =>
              ctx.slots.register({
                name: "sidebar.workspaces.session.row.action",
                id: "dsh-plugin-deck-studio.open-binding-row",
                order: 150,
              }, OpenDecklineRowAction)),
            "deck-studio: session row action",
          );
        } catch (error) {
          ctx.logger?.warn?.(`deck-studio: session menu slot unavailable: ${error?.message ?? error}`);
        }

        if (hasRightbar) {
          if (layout?.selectPanel) {
            ctx.effect(
              () => ctx.slots.inject("sidebar.panellist", () =>
                ctx.slots.register({ name: "sidebar.panellist", id: WORKBENCH_KEY, order: 46, label: () => "Deckline" }, DeckGlyph)),
              "deck-studio: workbench sidebar entry",
            );
          }
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
