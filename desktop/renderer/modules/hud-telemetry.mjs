/**
 * HUD 遥测（赛博朋克皮肤 · 阶段 3）
 *
 * 把主进程的实时 IPC 事件接入 HUD 覆盖层顶部数据条：
 *   - engine   ← runtime 选择 + 会话模型（session:update / onOpencodeModels）
 *   - token    ← L0 预算（l0:budget，估算 token 数）
 *   - ctx      ← 上下文占用（context:usage，usagePct）
 *   - status   ← 流状态（stream:start / tool:start / tool:result / stream:done）
 *
 * 设计目标：
 *   1. 只读订阅：绝不在主进程外写状态，纯渲染
 *   2. 幂等 & 优雅降级：preload 未就绪时静默跳过
 *   3. 同步刷新：IPC 事件本就低频，直接写 DOM，不依赖 rAF
 *      （rAF 在后台/隐藏 Electron 窗口中会被节流，导致测试与真实场景不一致）
 *   4. CSP 纯净：零第三方，全部手写
 */

import { hudEnabled, hudSetData } from "./hud-overlay.mjs";

/** 引擎显示名（runtime → label） */
const RUNTIME_LABEL = {
  aide: "AIDeAgent",
  opencode: "OpenCode",
};

/** 状态行文案（kebab key → display） */
const STATUS_TEXT = {
  idle: "STANDBY",
  streaming: "STREAMING",
  tool: "TOOL RUNNING",
  done: "READY",
  subagent: "SUBAGENT",
};

/** 内部状态快照（模块级，避免闭包散落） */
/** @type {{ runtime: string, model: string, sessionId: string, tokens: number, ctxPct: number, status: string }} */
const _state = {
  runtime: "aide",
  model: "",
  sessionId: "",
  tokens: 0,
  ctxPct: 0,
  status: "idle",
};

/** @returns {Record<string, string>} 组装 HUD 展示数据 */
function _snapshot() {
  const engine = RUNTIME_LABEL[/** @type {keyof typeof RUNTIME_LABEL} */ (_state.runtime)] || _state.runtime || "?";
  const model = _state.model ? ` · ${_state.model}` : "";
  return {
    engine: `ENGINE: ${engine}${model}`,
    token: `TOKEN: ${_state.tokens ? _state.tokens.toLocaleString() : "--"}`,
    ctx: `CTX: ${_state.ctxPct ? _state.ctxPct + "%" : "--%"}`,
    status: STATUS_TEXT[/** @type {keyof typeof STATUS_TEXT} */ (_state.status)] || "STANDBY",
  };
}

/** @returns {void} 立即刷入 HUD（仅当 HUD 开启） */
function flushAll() {
  if (!hudEnabled()) return;
  const snap = _snapshot();
  hudSetData(snap);
}

/**
 * 订阅全部 HUD 相关 IPC 事件（幂等；可重复调用）
 * @param {any} bridge window.aideagent 桥（默认 window.aideagent）
 * @returns {void}
 */
export function initHudTelemetry(bridge = window.aideagent) {
  if (!bridge) return;

  // 引擎：会话更新携带 sessionId；模型名来自 opencode 模型列表
  /** @param {any} d */
  const onSession = (d) => {
    if (d?.sessionId) _state.sessionId = String(d.sessionId);
    flushAll();
  };
  // 模型名：opencode 握手返回的模型列表（opencode:ready → { models, ... }）
  /** @param {any} d */
  const onModels = (d) => {
    const list = Array.isArray(d) ? d : (d?.models || []);
    const first = list[0];
    const id = typeof first === "string" ? first : (first?.id || "");
    if (id) { _state.model = String(id); flushAll(); }
  };

  // token：L0 预算估算
  /** @param {any} d */
  const onBudget = (d) => {
    if (typeof d?.estimatedTokens === "number") _state.tokens = d.estimatedTokens;
    flushAll();
  };

  // ctx：上下文占用百分比
  /** @param {any} d */
  const onCtx = (d) => {
    if (typeof d?.usagePct === "number") _state.ctxPct = d.usagePct;
    flushAll();
  };

  // 流状态机
  const onStreamStart = () => { _state.status = "streaming"; flushAll(); };
  /** @param {any} d */
  const onToolStart = (d) => { _state.status = d?.name ? "tool" : "streaming"; flushAll(); };
  const onToolResult = () => { _state.status = "streaming"; flushAll(); };
  /** @param {any} d */
  const onSubagent = (d) => { _state.status = d?.done ? "streaming" : "subagent"; flushAll(); };
  const onDone = () => { _state.status = "idle"; flushAll(); };

  // 惰性挂载：event name 存在才订阅
  /** @param {string} name @param {(d?: any) => void} fn */
  const bind = (name, fn) => {
    try {
      const f = bridge[name];
      if (typeof f === "function") f(fn);
    } catch { /* preload 未就绪时静默跳过 */ }
  };

  bind("onSessionUpdate", onSession);
  bind("onOpencodeModels", onModels);
  bind("onL0Budget", onBudget);
  bind("onContextUsage", onCtx);
  bind("onStreamStart", onStreamStart);
  bind("onToolStart", onToolStart);
  bind("onToolResult", onToolResult);
  bind("onSubagentProgress", onSubagent);
  bind("onStreamDone", onDone);

  // 初始状态立即刷一次（HUD 数据条一开始就展示 STANDBY）
  flushAll();
}

/** @returns {void} 自初始化（DOM 就绪且桥可用后订阅） */
function init() {
  const start = () => initHudTelemetry(window.aideagent);
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start);
  } else {
    start();
  }
}

init();
