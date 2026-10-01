/**
 * HUD 遥测（赛博朋克皮肤 · 阶段 3）
 *
 * 把主进程的实时 IPC 事件接入 HUD 覆盖层：
 *   - sess     ← 会话短哈希（session:update）
 *   - status   ← 流状态（stream:start / tool:start / tool:result / stream:done）
 *
 * 设计目标：
 *   1. 只读订阅：绝不在主进程外写状态，纯渲染
 *   2. 幂等 & 优雅降级：preload 未就绪时静默跳过
 *   3. 同步刷新：IPC 事件本就低频，直接写 DOM，不依赖 rAF
 *      （rAF 在后台/隐藏 Electron 窗口中会被节流，导致测试与真实场景不一致）
 *   4. CSP 纯净：零第三方，全部手写
 */

import { hudEnabled, hudSetData } from "./hud-overlay.ts";

/** 状态行文案（kebab key → display） */
const STATUS_TEXT = {
  idle: "STANDBY",
  streaming: "STREAMING",
  tool: "TOOL RUNNING",
  done: "READY",
  subagent: "SUBAGENT",
};

/** 内部状态快照（模块级，避免闭包散落） */
/** @type {{ sessionId: string, status: string }} */
const _state = {
  sessionId: "",
  status: "idle",
};

/** 会话 ID → 高对比短哈希（6 位大写 hex，用于 HUD 展示） */
function shortSessionHash(id: any) {
  if (!id) return "--";
  let h = 0;
  for (let i = 0; i < id.length; i++) {
    h = (h * 31 + id.charCodeAt(i)) >>> 0;
  }
  return h.toString(16).toUpperCase().padStart(6, "0").slice(-6);
}

/** @returns {Record<string, string|number>} 组装 HUD 展示数据 */
function _snapshot() {
  return {
    sess: `SID: ${shortSessionHash(_state.sessionId)}`,
    status: (STATUS_TEXT as any)[/** @type {keyof typeof STATUS_TEXT} */ (_state.status)] || "STANDBY",
  };
}

/** @returns {void} 立即刷入 HUD（仅当 HUD 开启） */
function flushAll() {
  if (!hudEnabled()) return;
  // 暴露 agent 状态到 DOM 属性，供 CSS 状态联动（雷达加速 / 角落闪烁等）
  document.documentElement.dataset.hudState = _state.status;
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

  // 引擎：会话更新携带 sessionId（用于右下角 SID 短哈希）
  /** @param {any} d */
  const onSession = (d: any) => {
    if (d?.sessionId) _state.sessionId = String(d.sessionId);
    flushAll();
  };

  // 流状态机
  const onStreamStart = () => { _state.status = "streaming"; flushAll(); };
  /** @param {any} d */
  const onToolStart = (d: any) => { _state.status = d?.name ? "tool" : "streaming"; flushAll(); };
  // A late tool:result after stream:done must not revive STREAMING.
  const onToolResult = () => { if (_state.status === "tool" || _state.status === "streaming") _state.status = "streaming"; flushAll(); };
  /** @param {any} d */
  const onSubagent = (d: any) => { _state.status = d?.done ? "streaming" : "subagent"; flushAll(); };
  const onDone = () => { _state.status = "idle"; flushAll(); };

  // 惰性挂载：event name 存在才订阅
  /** @param {string} name @param {(d?: any) => void} fn */
  const bind = (name: any, fn: any) => {
    try {
      const f = (bridge as any)[name];
      if (typeof f === "function") f(fn);
    } catch { /* preload 未就绪时静默跳过 */ }
  };

  bind("onSessionUpdate", onSession);
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
