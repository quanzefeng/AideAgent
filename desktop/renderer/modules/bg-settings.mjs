/**
 * 主题外观设置（背景色 + 5 变量联动）
 * 模式同 font-settings.mjs：localStorage 存值，运行时覆盖 :root 的 CSS 变量
 *
 * 存储格式 (localStorage["AideAgent_theme"]):
 *   { preset: string, bg: "#rrggbb", brightness: 0.6~1.2, accent: "#rrggbb" }
 *
 * 派生规则（联动 5 个 CSS 变量）：
 *   --bg          = hsl(bg) * brightness
 *   --bg-surface  = 略暗（同色相，亮度 -2.5%）
 *   --bg-card     = 极亮时→纯白；暗色时→比 bg 亮 8%
 *   --text        = 暗主题→#e8e8f0；亮主题→#1a1a2e（自适应阈值 L=0.5）
 *   --accent      = 用户单独选定（默认 #f59e0b）
 */

const THEME_KEY = "AideAgent_theme";

// ── Type-safe DOM lookup helpers ──────────────────────────────────
// These wrap document.getElementById with a JSDoc type so we don't need
// to cast at every call site. Use the right helper for the element type.
/** @param {string} id @returns {HTMLCanvasElement | null} */
const $canvas = (id) => /** @type {HTMLCanvasElement | null} */ (document.getElementById(id));
/** @param {string} id @returns {HTMLInputElement | null} */
const $input = (id) => /** @type {HTMLInputElement | null} */ (document.getElementById(id));

// ── 预设主题 ──
const PRESETS = {
  cream:       { bg: "#faf6ef", accent: "#f59e0b" },
  white:       { bg: "#ffffff", accent: "#3b82f6" },
  light_blue:  { bg: "#eef2f9", accent: "#6366f1" },
  gray:        { bg: "#f3f4f6", accent: "#0ea5e9" },
  dark_gray:   { bg: "#2a2d3a", accent: "#818cf8" },
  dark_purple: { bg: "#1e1b2e", accent: "#a78bfa" },
};

const DEFAULT_THEME = { preset: "cream", bg: "#faf6ef", brightness: 1.0, accent: "#f59e0b" };

// ── HSL 数学 ─────────────────────────────────────
/** @param {string} hex @returns {[number, number, number]} */
function hexToHsl(hex) {
  hex = String(hex || "").replace("#", "");
  if (hex.length === 3) hex = hex.split("").map(c => c + c).join("");
  if (hex.length !== 6) return [220, 0, 0.95];
  const r = parseInt(hex.slice(0, 2), 16) / 255;
  const g = parseInt(hex.slice(2, 4), 16) / 255;
  const b = parseInt(hex.slice(4, 6), 16) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  let h = 0, s = 0;
  const l = (max + min) / 2;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r)      h = ((g - b) / d + (g < b ? 6 : 0));
    else if (max === g) h = ((b - r) / d + 2);
    else                h = ((r - g) / d + 4);
    h /= 6;
  }
  return [h * 360, s, l];
}

/** @param {number} h @param {number} s @param {number} l @returns {string} */
function hslToHex(h, s, l) {
  h = (((h % 360) + 360) % 360) / 360;
  if (s <= 0) {
    const v = Math.round(l * 255);
    return "#" + [v, v, v].map(c => c.toString(16).padStart(2, "0")).join("");
  }
  /** @type {(p: number, q: number, t: number) => number} */
  const hue2rgb = (p, q, t) => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1/6) return p + (q - p) * 6 * t;
    if (t < 1/2) return q;
    if (t < 2/3) return p + (q - p) * (2/3 - t) * 6;
    return p;
  };
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const r = hue2rgb(p, q, h + 1/3);
  const g = hue2rgb(p, q, h);
  const b = hue2rgb(p, q, h - 1/3);
  return "#" + [r, g, b].map(c => Math.round(c * 255).toString(16).padStart(2, "0")).join("");
}

// HSL → RGB（用于 Canvas 像素绘制）
/** @param {number} h @param {number} s @param {number} l @returns {[number, number, number]} */
function hslToRgb(h, s, l) {
  h = (((h % 360) + 360) % 360) / 360;
  if (s <= 0) {
    const v = Math.round(l * 255);
    return [v, v, v];
  }
  /** @type {(p: number, q: number, t: number) => number} */
  const hue2rgb = (p, q, t) => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1/6) return p + (q - p) * 6 * t;
    if (t < 1/2) return q;
    if (t < 2/3) return p + (q - p) * (2/3 - t) * 6;
    return p;
  };
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  return [
    Math.round(hue2rgb(p, q, h + 1/3) * 255),
    Math.round(hue2rgb(p, q, h) * 255),
    Math.round(hue2rgb(p, q, h - 1/3) * 255)
  ];
}

// ── 2D 色板绘制 ──
/** @param {CanvasRenderingContext2D} ctx @param {number} hue @param {number} w @param {number} h */
function paintSLSquare(ctx, hue, w, h) {
  const img = ctx.createImageData(w, h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const s = x / (w - 1);
      const l = 1 - y / (h - 1);
      const [r, g, b] = hslToRgb(hue, s, l);
      const i = (y * w + x) * 4;
      img.data[i] = r;
      img.data[i+1] = g;
      img.data[i+2] = b;
      img.data[i+3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
}

/** @param {CanvasRenderingContext2D} ctx @param {number} w @param {number} h */
function paintHueBar(ctx, w, h) {
  const img = ctx.createImageData(w, h);
  for (let x = 0; x < w; x++) {
    const hue = (x / (w - 1)) * 360;
    for (let y = 0; y < h; y++) {
      const [r, g, b] = hslToRgb(hue, 1, 0.5);
      const i = (y * w + x) * 4;
      img.data[i] = r;
      img.data[i+1] = g;
      img.data[i+2] = b;
      img.data[i+3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
}

// ── 主题派生：bg + brightness + accent → 5 CSS 变量 ──
/** @param {{ bg: string, brightness: number, accent: string }} theme */
function deriveTheme(theme) {
  const [h, s, l] = hexToHsl(theme.bg);
  const adjL = Math.max(0, Math.min(1, l * theme.brightness));
  const isDark = adjL < 0.5;
  return {
    "--bg": hslToHex(h, s, adjL),
    "--bg-surface": hslToHex(h, Math.max(0, s * 0.9), Math.max(0, Math.min(1, adjL - (isDark ? 0.03 : 0.025)))),
    "--bg-card": isDark
      ? hslToHex(h, s, Math.min(1, adjL + 0.08))
      : "#ffffff",
    "--text": isDark ? "#e8e8f0" : "#1a1a2e",
    "--accent": theme.accent,
  };
}

/** @param {{ bg: string, brightness: number, accent: string }} theme */
function applyTheme(theme) {
  const vars = deriveTheme(theme);
  const root = document.documentElement;
  for (const [k, v] of Object.entries(vars)) {
    root.style.setProperty(k, v);
  }
  // 同步别名（保持设计系统其他引用一致）
  root.style.setProperty("--text-primary", vars["--text"]);
  root.style.setProperty("--text-secondary", vars["--text"]);
  root.style.setProperty("--bg-primary", vars["--bg"]);
  root.style.setProperty("--bg-secondary", vars["--bg-card"]);
  root.style.setProperty("--bg-tertiary", vars["--bg-surface"]);
  // 边框自适应明暗
  const [hh, ss, ll] = hexToHsl(theme.bg);
  const finalL = ll * theme.brightness;
  if (finalL < 0.5) {
    root.style.setProperty("--border", "rgba(255,255,255,0.12)");
    root.style.setProperty("--border-hover", "rgba(255,255,255,0.22)");
  } else {
    root.style.setProperty("--border", "#d0d5e2");
    root.style.setProperty("--border-hover", "#b8bfd0");
  }
}

function loadTheme() {
  try {
    const stored = JSON.parse(localStorage.getItem(THEME_KEY) || "null");
    if (stored && typeof stored.bg === "string" && typeof stored.accent === "string") {
      return { ...DEFAULT_THEME, ...stored, brightness: Number(stored.brightness) || 1.0 };
    }
  } catch {}
  return { ...DEFAULT_THEME };
}

/** @param {Object} theme */
function saveTheme(theme) {
  localStorage.setItem(THEME_KEY, JSON.stringify(theme));
}

// ── UI 绑定 ─────────────────────────────────────
/** @param {string} key @returns {string} */
function t(key) { return (typeof window.t === "function" ? window.t(key) : key); }

/** @param {string} s @returns {boolean} */
function isValidHex(s) { return /^#[0-9a-f]{6}$/i.test(String(s || "").trim()); }

// ── 2D 色板状态 ──
/** @type {[number, number, number]} */
let pendingBgHSL = [0, 0, 1];   // [h, s, l] 暂存色
/** @type {CanvasRenderingContext2D | null} */
let slCanvasCtx = null;         // SL square 画布上下文
let slCanvasW = 0, slCanvasH = 0;

/** @param {{ bg: string }} theme */
function syncColorPicker(theme) {
  pendingBgHSL = hexToHsl(theme.bg);
  const slInd = document.getElementById("bg-color-sl-indicator");
  const hueInd = document.getElementById("bg-color-hue-indicator");
  const pHex = document.getElementById("bg-color-pending-hex");
  const pPrev = document.getElementById("bg-color-pending-preview");
  if (slInd) {
    slInd.style.left = (pendingBgHSL[1] * 100) + "%";
    slInd.style.top = ((1 - pendingBgHSL[2]) * 100) + "%";
  }
  if (hueInd) {
    hueInd.style.left = ((pendingBgHSL[0] / 360) * 100) + "%";
  }
  const hex = hslToHex(...pendingBgHSL);
  if (pHex) pHex.textContent = hex;
  if (pPrev) pPrev.style.background = hex;
  if (slCanvasCtx) {
    paintSLSquare(slCanvasCtx, pendingBgHSL[0], slCanvasW, slCanvasH);
  }
}

function initColorPicker() {
  const square = $canvas("bg-color-square");
  const hueBar = $canvas("bg-color-hue-bar");
  if (!square || !hueBar) return;

  slCanvasCtx = square.getContext("2d");
  slCanvasW = square.width;
  slCanvasH = square.height;
  const hueCtx = hueBar.getContext("2d");
  if (!hueCtx) return;

  // 首次绘制：色相条（静态）+ SL 方块（按当前色相）
  paintHueBar(hueCtx, hueBar.width, hueBar.height);
  if (slCanvasCtx) paintSLSquare(slCanvasCtx, pendingBgHSL[0], slCanvasW, slCanvasH);
  syncColorPicker({ bg: hslToHex(...pendingBgHSL) });

  // ── SL 方块：鼠标点击/拖动 → 改 S 和 L ──
  /** @type {(clientX: number, clientY: number) => void} */
  const onSLEvent = (clientX, clientY) => {
    const rect = square.getBoundingClientRect();
    const x = (clientX - rect.left) / rect.width;
    const y = (clientY - rect.top) / rect.height;
    pendingBgHSL[1] = Math.max(0, Math.min(1, x));
    pendingBgHSL[2] = Math.max(0, Math.min(1, 1 - y));
    if (slCanvasCtx) paintSLSquare(slCanvasCtx, pendingBgHSL[0], slCanvasW, slCanvasH);
    syncColorPicker({ bg: hslToHex(...pendingBgHSL) });
  };
  let draggingSL = false;
  square.addEventListener("mousedown", (e) => {
    draggingSL = true; onSLEvent(e.clientX, e.clientY);
  });
  document.addEventListener("mousemove", (e) => {
    if (draggingSL) onSLEvent(e.clientX, e.clientY);
  });
  document.addEventListener("mouseup", () => { draggingSL = false; });

  // ── 色相条：点击/拖动 → 改 H，重绘 SL ──
  /** @type {(clientX: number) => void} */
  const onHueEvent = (clientX) => {
    const rect = hueBar.getBoundingClientRect();
    const x = (clientX - rect.left) / rect.width;
    pendingBgHSL[0] = Math.max(0, Math.min(360, x * 360));
    if (slCanvasCtx) paintSLSquare(slCanvasCtx, pendingBgHSL[0], slCanvasW, slCanvasH);
    syncColorPicker({ bg: hslToHex(...pendingBgHSL) });
  };
  let draggingHue = false;
  hueBar.addEventListener("mousedown", (e) => {
    draggingHue = true; onHueEvent(e.clientX);
  });
  document.addEventListener("mousemove", (e) => {
    if (draggingHue) onHueEvent(e.clientX);
  });
  document.addEventListener("mouseup", () => { draggingHue = false; });

  // ── 应用按钮：把暂存色写入主题 ──
  const applyBtn = document.getElementById("bg-color-apply-btn");
  if (applyBtn) {
    applyBtn.addEventListener("click", () => {
      const hex = hslToHex(...pendingBgHSL);
      const theme = { ...loadTheme(), preset: "custom", bg: hex };
      saveTheme(theme);
      applyTheme(theme);
      applyToUI(theme);
    });
  }
}

/** @param {{ brightness: number, accent: string, preset: string, bg: string }} theme */
function applyToUI(theme) {
  const slider = $input("bg-brightness-slider");
  const sliderVal = document.getElementById("bg-brightness-value");
  const accentPicker = $input("bg-accent-picker");
  const accentHex = $input("bg-accent-hex");
  if (slider) slider.value = String(Math.round(theme.brightness * 100));
  if (sliderVal) sliderVal.textContent = Math.round(theme.brightness * 100) + "%";
  if (accentPicker) accentPicker.value = theme.accent;
  if (accentHex) accentHex.value = theme.accent;
  document.querySelectorAll(".bg-preset-swatch").forEach(el => {
    const sw = /** @type {HTMLElement} */ (el);
    sw.classList.toggle("active", sw.dataset.preset === theme.preset);
  });
  syncColorPicker(theme);
}

/** @param {{ preset: string, brightness: number }} currentTheme */
function renderPresets(currentTheme) {
  const grid = document.getElementById("bg-preset-grid");
  if (!grid) return;
  grid.innerHTML = "";
  for (const [key, p] of Object.entries(PRESETS)) {
    const [h, s, l] = hexToHsl(p.bg);
    const surface = hslToHex(h, s, Math.max(0, Math.min(1, l - 0.03)));
    const el = document.createElement("div");
    el.className = "bg-preset-swatch" + (currentTheme.preset === key ? " active" : "");
    el.dataset.preset = key;
    el.title = p.bg;
    el.innerHTML =
      '<div class="bg-preset-colors">' +
        '<div style="background:' + p.bg + '"></div>' +
        '<div style="background:' + surface + '"></div>' +
        '<div style="background:' + p.accent + '"></div>' +
      '</div>' +
      '<span>' + (t("bg.preset." + key) || key) + '</span>';
    el.addEventListener("click", () => {
      const theme = { preset: key, bg: p.bg, accent: p.accent, brightness: currentTheme.brightness };
      saveTheme(theme);
      applyTheme(theme);
      applyToUI(theme);
    });
    grid.appendChild(el);
  }
}

/** @param {{ preset: string, bg: string, brightness: number, accent: string }} initial */
function bindControls(initial) {
  const slider = $input("bg-brightness-slider");
  const sliderVal = document.getElementById("bg-brightness-value");
  const accentPicker = $input("bg-accent-picker");
  const accentHex = $input("bg-accent-hex");
  const resetBtn = document.getElementById("bg-reset-btn");

  /** @param {Object} patch */
  const update = (patch) => {
    const theme = { ...loadTheme(), ...patch };
    saveTheme(theme);
    applyTheme(theme);
    applyToUI(theme);
  };

  if (slider) {
    slider.addEventListener("input", () => {
      const v = parseInt(slider.value, 10);
      if (sliderVal) sliderVal.textContent = v + "%";
      update({ brightness: v / 100 });
    });
  }
  if (accentPicker) {
    accentPicker.addEventListener("input", () => {
      const v = accentPicker.value;
      if (accentHex) accentHex.value = v;
      update({ accent: v });
    });
  }
  if (accentHex) {
    accentHex.addEventListener("change", () => {
      let v = accentHex.value.trim().toLowerCase();
      if (v && !v.startsWith("#")) v = "#" + v;
      if (isValidHex(v)) {
        if (accentPicker) accentPicker.value = v;
        update({ accent: v });
      } else {
        accentHex.value = loadTheme().accent;
      }
    });
  }
  if (resetBtn) {
    resetBtn.addEventListener("click", () => {
      const theme = { ...DEFAULT_THEME };
      saveTheme(theme);
      applyTheme(theme);
      applyToUI(theme);
    });
  }
}

// ── 自初始化 ────────────────────────────────────
const theme = loadTheme();
applyTheme(theme);  // 启动时立即应用主题（不依赖 DOM 可用性）

const init = () => {
  renderPresets(theme);
  initColorPicker();
  bindControls(theme);
  applyToUI(theme);
};

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}

export { loadTheme, saveTheme, applyTheme, DEFAULT_THEME, PRESETS };
