/**
 * HUD 覆盖层（赛博朋克皮肤，纯装饰）
 *
 * 设计目标：
 *   1. 纯装饰层：pointer-events:none，绝不拦截任何交互
 *   2. 可剥离：html[data-hud="off"] 一键关闭（localStorage["AideAgent_hud"]）
 *   3. 不依赖第三方库（CSP 纯净），全部手写 DOM/CSS
 *   4. 数据单向注入：hudSetData() 由阶段3的 IPC 订阅驱动
 */

const HUD_KEY = "AideAgent_hud";
const HUD_DEFAULT = "on";
const HUD_MOTION_KEY = "AideAgent_hud_motion";
const HUD_VSCAN_KEY = "AideAgent_hud_vscan";
const HUD_VSCAN_DEFAULT = "off";

// 尽早暴露到 documentElement，供 CSS 动效降级块与 boot 序列读取
try {
  document.documentElement.dataset.hud = localStorage.getItem(HUD_KEY) === "off" ? "off" : "on";
  document.documentElement.dataset.hudMotion = localStorage.getItem(HUD_MOTION_KEY) === "on" ? "on" : "auto";
  document.documentElement.dataset.hudVscan = localStorage.getItem(HUD_VSCAN_KEY) === "on" ? "on" : "off";
} catch {}

/** @returns {boolean} 用户是否启用了 HUD 覆盖层 */
export function hudEnabled() {
  try {
    return localStorage.getItem(HUD_KEY) !== "off";
  } catch {
    return HUD_DEFAULT === "on";
  }
}/** @param {boolean} on @returns {void} */
export function hudSetEnabled(on) {
  try {
    localStorage.setItem(HUD_KEY, on ? "on" : "off");
  } catch {}
  document.documentElement.dataset.hud = on ? "on" : "off";
  const ov = document.getElementById("hud-overlay");
  if (ov) ov.style.display = on ? "" : "none";
}

/**
 * HUD 动画是否被强制开启（"on" = 忽略系统 prefers-reduced-motion，"auto" = 跟随系统）
 * @returns {boolean}
 */
export function hudMotionEnabled() {
  try {
    return localStorage.getItem(HUD_MOTION_KEY) === "on";
  } catch {
    return false;
  }
}

/** @param {boolean} on @returns {void} 强制/取消强制 HUD 动画（忽略系统减少动效偏好） */
export function hudSetMotionEnabled(on) {
  try {
    localStorage.setItem(HUD_MOTION_KEY, on ? "on" : "auto");
  } catch {}
  document.documentElement.dataset.hudMotion = on ? "on" : "auto";
  const cb = document.getElementById("hud-motion-checkbox");
  if (cb) cb.checked = on;
}

/**
 * HUD 垂直扫描线是否开启（独立子开关，默认关闭；不随总开关/动画开关联动）
 * @returns {boolean}
 */
export function hudVscanEnabled() {
  try {
    return localStorage.getItem(HUD_VSCAN_KEY) === "on";
  } catch {
    return HUD_VSCAN_DEFAULT === "on";
  }
}

/** @param {boolean} on @returns {void} 开启/关闭 HUD 垂直扫描线 */
export function hudSetVscanEnabled(on) {
  try {
    localStorage.setItem(HUD_VSCAN_KEY, on ? "on" : "off");
  } catch {}
  document.documentElement.dataset.hudVscan = on ? "on" : "off";
  const cb = document.getElementById("hud-vscan-checkbox");
  if (cb) cb.checked = on;
}

/** @returns {void} 创建覆盖层 DOM（幂等） */
function injectHud() {
  if (document.getElementById("hud-overlay")) return;

  const ov = document.createElement("div");
  ov.id = "hud-overlay";
  ov.setAttribute("aria-hidden", "true");
  ov.innerHTML =
    // 四角括号
    '<span class="hud-corner hud-corner-tl"></span>' +
    '<span class="hud-corner hud-corner-tr"></span>' +
    '<span class="hud-corner hud-corner-bl"></span>' +
    '<span class="hud-corner hud-corner-br"></span>' +
    // 左上角标识
    '<div class="hud-tag" id="hud-tag" data-text="AIDeAgent // HUD">AIDeAgent // HUD</div>' +
    // 顶部数据条（阶段3由 IPC 实时填充）
    '<div class="hud-topbar" id="hud-topbar">' +
      '<span class="hud-topbar-item" id="hud-engine">ENGINE: --</span>' +
      '<span class="hud-topbar-item" id="hud-token">TOKEN: --</span>' +
      '<span class="hud-topbar-item" id="hud-ctx">CTX: --%</span>' +
      '<span class="hud-topbar-item" id="hud-clock">--:--:--</span>' +
      '<span class="hud-topbar-item" id="hud-fps">-- FPS</span>' +
    '</div>' +
    // 上下文占用能量条（右下角，随 ctxPct 填充）
    '<div class="hud-ctxbar"><span class="hud-ctxbar-fill" id="hud-ctxbar"></span></div>' +
    // 右下角数据条：坐标 + 会话短哈希
    '<div class="hud-datastrip">' +
      '<span class="hud-topbar-item" id="hud-coord">31.23N 121.47E</span>' +
      '<span class="hud-topbar-item" id="hud-sess">SID: --</span>' +
    '</div>' +
    // 右上雷达扫描
    '<div class="hud-radar hud-radar-right" id="hud-radar">' +
      '<div class="hud-radar-rings"></div>' +
      '<div class="hud-radar-sweep"></div>' +
      '<div class="hud-radar-dot hud-radar-dot-1"></div>' +
      '<div class="hud-radar-dot hud-radar-dot-2"></div>' +
    '</div>' +
    // 左上雷达扫描（镜像）
    '<div class="hud-radar hud-radar-left" id="hud-radar-left">' +
      '<div class="hud-radar-rings"></div>' +
      '<div class="hud-radar-sweep"></div>' +
      '<div class="hud-radar-dot hud-radar-dot-1"></div>' +
      '<div class="hud-radar-dot hud-radar-dot-2"></div>' +
    '</div>' +
    // 对话区垂直扫描线（仅覆盖对话主界面，不遮侧边栏）
    '<div class="hud-vscan" aria-hidden="true"></div>' +
    // 底部状态
    '<div class="hud-bottom">' +
      '<span class="hud-status" id="hud-status">SYSTEM ONLINE</span>' +
    '</div>';

  document.body.appendChild(ov);
  document.documentElement.dataset.hud = hudEnabled() ? "on" : "off";
  document.documentElement.dataset.hudMotion = hudMotionEnabled() ? "on" : "auto";
  ov.style.display = hudEnabled() ? "" : "none";
}

/**
 * 注入 HUD 实时数据（由阶段3 IPC 订阅调用）
 * @param {Record<string, string|number>} data 字段：engine/token/ctx/status/sess/clock + ctxBar(0-100 数值)
 * @returns {void}
 */
export function hudSetData(data = {}) {
  const map = {
    engine: "hud-engine",
    token: "hud-token",
    ctx: "hud-ctx",
    status: "hud-status",
    sess: "hud-sess",
    coord: "hud-coord",
  };
  for (const [key, id] of Object.entries(map)) {
    if (!(key in data)) continue;
    const el = document.getElementById(id);
    if (el) el.textContent = String(data[key]);
  }
  // 上下文能量条填充（0-100）
  if ("ctxBar" in data) {
    const bar = document.getElementById("hud-ctxbar");
    if (bar) {
      const pct = Math.max(0, Math.min(100, Number(data.ctxBar) || 0));
      bar.style.width = pct + "%";
    }
  }
}

/** @returns {void} 绑定设置面板里的 HUD 动画开关（幂等） */
function bindMotionToggle() {
  const cb = document.getElementById("hud-motion-checkbox");
  if (!cb || cb.dataset.bound) return;
  cb.dataset.bound = "1";
  cb.checked = hudMotionEnabled();
  cb.addEventListener("change", () => {
    hudSetMotionEnabled(cb.checked);
  });
}

/** @returns {void} 绑定设置面板里的 HUD 垂直扫描线开关（幂等） */
function bindVscanToggle() {
  const cb = document.getElementById("hud-vscan-checkbox");
  if (!cb || cb.dataset.bound) return;
  cb.dataset.bound = "1";
  cb.checked = hudVscanEnabled();
  cb.addEventListener("change", () => {
    hudSetVscanEnabled(cb.checked);
  });
}

/** @returns {void} 自初始化 */
function init() {
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => {
      injectHud();
      bindMotionToggle();
      bindVscanToggle();
      startClockFps();
    });
  } else {
    injectHud();
    bindMotionToggle();
    bindVscanToggle();
    startClockFps();
  }
}

// ── 时钟 + FPS 自驱动（不依赖 IPC，纯前端） ──
let _fpsFrames = 0;
let _fpsLast = performance.now();
let _clockTimer = null;

/** @returns {void} 每秒刷新本地时钟（跟随系统时区） */
function tickClock() {
  const el = document.getElementById("hud-clock");
  if (!el) return;
  const d = new Date();
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  el.textContent = `${hh}:${mm}:${ss}`;
}

/** @returns {void} 用 rAF 统计真实 FPS，每 500ms 刷新 */
function tickFps() {
  _fpsFrames++;
  const now = performance.now();
  if (now - _fpsLast >= 500) {
    const fps = Math.round((_fpsFrames * 1000) / (now - _fpsLast));
    const el = document.getElementById("hud-fps");
    if (el) el.textContent = `${fps} FPS`;
    _fpsFrames = 0;
    _fpsLast = now;
  }
  requestAnimationFrame(tickFps);
}

/** @returns {void} 启动时钟 + FPS 循环（幂等） */
function startClockFps() {
  if (_clockTimer) return;
  tickClock();
  _clockTimer = setInterval(tickClock, 1000);
  requestAnimationFrame(tickFps);
}

init();

export { injectHud };
