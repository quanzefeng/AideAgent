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

// 尽早暴露到 documentElement，供 CSS 动效降级块与 boot 序列读取
try {
  document.documentElement.dataset.hud = localStorage.getItem(HUD_KEY) === "off" ? "off" : "on";
  document.documentElement.dataset.hudMotion = localStorage.getItem(HUD_MOTION_KEY) === "on" ? "on" : "auto";
} catch {}

/** @returns {boolean} 用户是否启用了 HUD 覆盖层 */
export function hudEnabled() {
  try {
    return localStorage.getItem(HUD_KEY) !== "off";
  } catch {
    return HUD_DEFAULT === "on";
  }
}

/** @param {boolean} on @returns {void} */
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
    '<div class="hud-tag" id="hud-tag">AIDeAgent // HUD</div>' +
    // 顶部数据条（阶段3由 IPC 实时填充）
    '<div class="hud-topbar" id="hud-topbar">' +
      '<span class="hud-topbar-item" id="hud-engine">ENGINE: --</span>' +
      '<span class="hud-topbar-item" id="hud-token">TOKEN: --</span>' +
      '<span class="hud-topbar-item" id="hud-ctx">CTX: --%</span>' +
    '</div>' +
    // 右上雷达扫描
    '<div class="hud-radar" id="hud-radar">' +
      '<div class="hud-radar-rings"></div>' +
      '<div class="hud-radar-sweep"></div>' +
      '<div class="hud-radar-dot hud-radar-dot-1"></div>' +
      '<div class="hud-radar-dot hud-radar-dot-2"></div>' +
    '</div>' +
    // 底部扫描线 + 状态
    '<div class="hud-bottom">' +
      '<span class="hud-scanline"></span>' +
      '<span class="hud-status" id="hud-status">SYSTEM ONLINE</span>' +
    '</div>';

  document.body.appendChild(ov);
  document.documentElement.dataset.hud = hudEnabled() ? "on" : "off";
  document.documentElement.dataset.hudMotion = hudMotionEnabled() ? "on" : "auto";
  ov.style.display = hudEnabled() ? "" : "none";
}

/**
 * 注入 HUD 实时数据（由阶段3 IPC 订阅调用）
 * @param {Record<string, string|number>} data 字段：engine/token/ctx/status/clock
 * @returns {void}
 */
export function hudSetData(data = {}) {
  const map = {
    engine: "hud-engine",
    token: "hud-token",
    ctx: "hud-ctx",
    status: "hud-status",
  };
  for (const [key, id] of Object.entries(map)) {
    if (!(key in data)) continue;
    const el = document.getElementById(id);
    if (el) el.textContent = String(data[key]);
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
    // 强制开启时，若系统 reduce 导致 boot 已跳过，不再复现；仅实时反映到 HUD 动效
  });
}

/** @returns {void} 自初始化 */
function init() {
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => {
      injectHud();
      bindMotionToggle();
    });
  } else {
    injectHud();
    bindMotionToggle();
  }
}

init();

export { injectHud };
