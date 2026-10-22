/**
 * 界面风格（皮肤）系统
 * --------------------------------------------------------------------------
 * 与 bg-settings 的色彩主题正交分层：
 *   - 皮肤 = 界面骨架 / 质感 / 结构装饰（html[data-skin="..."] CSS 门控）
 *   - 主题 = 色彩（bg / brightness / accent，bg-settings.ts 负责）
 * 任意皮肤 × 任意色彩可以自由组合（玻璃+暗色、粗野+浅色都合法）。
 *
 * 关键约定：
 *   1. applyTheme 用 documentElement.style 内联变量，优先级高于一切 CSS。
 *      因此皮肤要改「色彩类 token」（如玻璃的半透明 --bg-card、粗野的
 *      硬边框 --border），必须走 skinColorPatch() 这条 JS 管道，
 *      由 bg-settings 在 applyTheme 末尾 merge。纯 CSS 门控只负责
 *      结构装饰（backdrop-filter、描边加粗、硬投影位移等）。
 *   2. 皮肤切换通过 SKIN_CHANGE_EVENT 广播；bg-settings 监听后重刷主题，
 *      并在用户未自定义颜色（preset !== "custom"）时套用皮肤推荐预设。
 *   3. 旧 HUD 开关（AideAgent_hud / html[data-hud]）并入 hud 皮肤：
 *      skin=hud ⇔ data-hud="on"，两个存储键始终双向同步，
 *      老用户首次启动按旧开关迁移（旧默认 on → hud 皮肤）；
 *      全新安装默认 neu（拟态）。
 *
 * 存储：localStorage["AideAgent_skin"] = classic | hud | glass | brutal | paper | neu | terminal
 */

import { hudSetEnabled } from './hud-overlay.ts';

const SKIN_KEY = "AideAgent_skin";
/** 旧版 HUD 总开关存储键（迁移源 + 反向同步目标） */
const LEGACY_HUD_KEY = "AideAgent_hud";

export type SkinId = "classic" | "hud" | "glass" | "brutal" | "paper" | "neu" | "terminal";

const SKIN_IDS: SkinId[] = ["classic", "hud", "glass", "brutal", "paper", "neu", "terminal"];

export const SKIN_CHANGE_EVENT = "aide:skin-change";

/**
 * 皮肤推荐色彩预设（对应 bg-settings 的 PRESETS 键名）。
 * 切换皮肤时，若用户从未自定义颜色，bg-settings 自动套用。
 */
export const SKIN_SUGGESTED_PRESET: Record<SkinId, string | null> = {
  classic: null,
  hud: null,
  glass: "dark_purple",
  brutal: "white",
  paper: "cream",
  neu: "cream",
  // terminal 强制磷光配色（patch 覆盖色彩），推荐预设无意义
  terminal: null,
};

/**
 * 皮肤可能内联覆盖的「非派生」token。每次 applyTheme 先全部
 * removeProperty，防止上一个皮肤留下的内联值污染下一个皮肤。
 * （--bg-card/--border 等派生 token 本来就会被重新 set，列在这里
 * 只是为了语义完整。）
 */
export const SKIN_RESET_PROPS = [
  "--border", "--border-hover",
  "--shadow-card", "--shadow-modal",
  "--radius-sm", "--radius-md", "--radius-lg",
  "--radius-card", "--radius-bubble", "--radius-input", "--radius-modal",
  // terminal / neu 会强制以下 token；deriveTheme 不重算它们，必须显式清理
  "--bg-hover", "--bg-elevated",
  "--text-light", "--text-muted",
  "--danger", "--success",
  "--accent-hover", "--accent-dim", "--accent-light",
  "--overlay",
  // 拟态专用双阴影色（bg-settings 内联）
  "--neu-hl", "--neu-sh",
  // terminal 会接管聊天字体；离开 terminal 时由 bg-settings 恢复用户字体
  "--chat-font",
];

// ── 存取 ────────────────────────────────────────────
function isSkinId(v: unknown): v is SkinId {
  return typeof v === "string" && (SKIN_IDS as string[]).includes(v);
}

/** @returns {SkinId} 当前皮肤（首次调用时迁移/落盘；全新安装默认 neu） */
export function getSkin(): SkinId {
  try {
    const stored = localStorage.getItem(SKIN_KEY);
    if (isSkinId(stored)) return stored;
    // 迁移：存在旧 HUD 开关时按它映射（off → classic，on → hud）；
    // 旧键不存在 = 全新安装 → 默认 neu（拟态）。
    const legacy = localStorage.getItem(LEGACY_HUD_KEY);
    const skin: SkinId = legacy === null ? "neu" : legacy === "off" ? "classic" : "hud";
    localStorage.setItem(SKIN_KEY, skin);
    return skin;
  } catch {
    return "neu";
  }
}

/** 切换皮肤：落盘 + data-skin + 同步旧 HUD 开关 + 广播事件 */
export function setSkin(id: SkinId): void {
  try {
    localStorage.setItem(SKIN_KEY, id);
    localStorage.setItem(LEGACY_HUD_KEY, id === "hud" ? "on" : "off");
  } catch {}
  document.documentElement.dataset.skin = id;
  hudSetEnabled(id === "hud");
  window.dispatchEvent(new CustomEvent(SKIN_CHANGE_EVENT, { detail: { skin: id } }));
}

// ── 色彩工具（自带最小实现，避免与 bg-settings 形成导入环）──
/** @param {string} hex @returns {[number, number, number]} [h(0-360), s(0-1), l(0-1)] */
function hexToHsl(hex: string): [number, number, number] {
  const clean = String(hex || "").replace("#", "");
  const full = clean.length === 3 ? clean.split("").map((c) => c + c).join("") : clean;
  if (full.length !== 6) return [220, 0, 0.95];
  const r = parseInt(full.slice(0, 2), 16) / 255;
  const g = parseInt(full.slice(2, 4), 16) / 255;
  const b = parseInt(full.slice(4, 6), 16) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  let h = 0, s = 0;
  const l = (max + min) / 2;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r)      h = (g - b) / d + (g < b ? 6 : 0);
    else if (max === g) h = (b - r) / d + 2;
    else                h = (r - g) / d + 4;
    h /= 6;
  }
  return [h * 360, s, l];
}

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

// ── 皮肤色彩补丁 ────────────────────────────────────
export interface ThemeLike {
  bg: string;
  brightness: number;
  accent: string;
}

/**
 * 皮肤对色彩 token 的内联覆盖（applyTheme merge 用）。
 * classic / hud 返回空对象——hud 的视觉全部来自 CSS 门控。
 */
export function skinColorPatch(theme: ThemeLike, skin: SkinId = getSkin()): Record<string, string> {
  const [h, s, l] = hexToHsl(theme.bg);
  const adjL = clamp01(l * (theme.brightness || 1));
  const isDark = adjL < 0.5;
  const H = Math.round(h);
  const S = Math.round(s * 100);

  if (skin === "glass") {
    // 磨砂玻璃：所有卡片层半透明，由 CSS 的 backdrop-filter 完成磨砂。
    // 浅色主题卡片取纯白半透明，暗色主题取 bg 色相抬亮半透明。
    const card = isDark
      ? `hsla(${H}, ${S}%, ${Math.round(clamp01(adjL + 0.07) * 100)}%, 0.60)`
      : `hsla(${H}, ${Math.round(clamp01(s * 0.5) * 100)}%, 100%, 0.55)`;
    const elevated = isDark
      ? `hsla(${H}, ${S}%, ${Math.round(clamp01(adjL + 0.04) * 100)}%, 0.62)`
      : `hsla(${H}, ${S}%, 100%, 0.70)`;
    const surface = isDark
      ? `hsla(${H}, ${S}%, ${Math.round(clamp01(adjL - 0.02) * 100)}%, 0.55)`
      : `hsla(${H}, ${S}%, ${Math.round(clamp01(adjL - 0.01) * 100)}%, 0.50)`;
    const hover = isDark
      ? `hsla(${H}, ${S}%, ${Math.round(clamp01(adjL + 0.10) * 100)}%, 0.60)`
      : `hsla(${H}, ${S}%, ${Math.round(clamp01(adjL - 0.04) * 100)}%, 0.65)`;
    return {
      "--bg-card": card,
      "--bg-elevated": elevated,
      "--bg-surface": surface,
      "--bg-hover": hover,
      "--border": isDark ? "rgba(255, 255, 255, 0.18)" : "rgba(255, 255, 255, 0.70)",
      "--border-hover": isDark ? "rgba(255, 255, 255, 0.30)" : "rgba(255, 255, 255, 0.95)",
      "--shadow-card": isDark ? "0 8px 28px rgba(0, 0, 0, 0.45)" : "0 8px 28px rgba(15, 23, 42, 0.12)",
      "--overlay": isDark ? "rgba(4, 6, 16, 0.55)" : "rgba(30, 41, 59, 0.30)",
    };
  }

  if (skin === "brutal") {
    // 新粗野主义：高对比描边 + 硬位移投影 + 直角。色彩跟随主题明暗，
    // 但边框不再柔化——浅色用近黑描边，暗色用近白描边。
    const ink = isDark ? "#e8e8f0" : "#14161f";
    return {
      "--border": ink,
      "--border-hover": isDark ? "#ffffff" : "#000000",
      "--shadow-card": `4px 4px 0 ${isDark ? "rgba(232, 232, 240, 0.18)" : "rgba(20, 22, 31, 0.90)"}`,
      "--shadow-modal": `10px 10px 0 ${isDark ? "rgba(232, 232, 240, 0.14)" : "rgba(20, 22, 31, 0.85)"}`,
      "--radius-sm": "2px", "--radius-md": "2px", "--radius-lg": "2px",
      "--radius-card": "0px", "--radius-bubble": "0px",
      "--radius-input": "0px", "--radius-modal": "0px",
    };
  }

  if (skin === "paper") {
    // 暖纸风：卡片染暖白、描边转暖棕、阴影带纸墨温度。
    // 底色交给推荐预设 cream（暖米）；自定义背景色时保留用户色相。
    return {
      "--bg-card": isDark
        ? `hsl(${H}, ${Math.round(clamp01(s * 0.5) * 100)}%, ${Math.round(clamp01(adjL + 0.05) * 100)}%)`
        : "#fffdf7",
      "--bg-elevated": isDark
        ? `hsl(${H}, ${Math.round(clamp01(s * 0.6) * 100)}%, ${Math.round(clamp01(adjL + 0.03) * 100)}%)`
        : "#fffaf0",
      "--bg-surface": isDark
        ? `hsl(${H}, ${Math.round(clamp01(s * 0.6) * 100)}%, ${Math.round(clamp01(adjL - 0.01) * 100)}%)`
        : "#f6efe3",
      "--border": isDark ? "rgba(214, 199, 168, 0.18)" : "#e2d8c4",
      "--border-hover": isDark ? "rgba(214, 199, 168, 0.32)" : "#cbbda1",
      "--shadow-card": isDark ? "0 4px 24px rgba(0, 0, 0, 0.5)" : "0 4px 24px rgba(97, 74, 38, 0.10)",
    };
  }

  if (skin === "neu") {
    // 拟态：卡片与背景同色（浮雕感的前提），深浅由双阴影塑造；
    // 背景亮度钳制在中段——过亮/过暗时双向阴影都会失效。
    const baseL = isDark ? Math.max(adjL, 0.18) : Math.min(adjL, 0.90);
    const Lp = (v: number) => `${Math.round(clamp01(v) * 100)}%`;
    const token = (dl: number) => `hsl(${H}, ${S}%, ${Lp(baseL + dl)})`;
    return {
      "--bg": token(0),
      "--bg-card": token(0),
      "--bg-elevated": token(0.02),
      "--bg-surface": token(0),
      "--bg-hover": token(isDark ? 0.05 : -0.03),
      "--border": token(isDark ? 0.10 : -0.06),
      "--border-hover": token(isDark ? 0.16 : -0.10),
      "--neu-hl": isDark ? "rgba(255, 255, 255, 0.055)" : "rgba(255, 255, 255, 0.85)",
      "--neu-sh": isDark ? "rgba(0, 0, 0, 0.55)" : "rgba(94, 104, 124, 0.20)",
      "--shadow-card": "-5px -5px 12px var(--neu-hl), 6px 6px 14px var(--neu-sh)",
      "--shadow-modal": "-8px -8px 22px var(--neu-hl), 12px 12px 28px var(--neu-sh)",
      "--radius-card": "14px", "--radius-bubble": "14px",
      "--radius-input": "12px", "--radius-modal": "16px",
    };
  }

  if (skin === "terminal") {
    // 复古终端：磷光绿正文 + 琥珀强调 + CRT 深底。配色与用户主题无关——
    // 切进来强制深色（含 --text/--bg 等主色），切走由 applyTheme 重算恢复。
    return {
      "--bg": "#0b100c",
      "--bg-elevated": "#121a13",
      "--bg-card": "#101711",
      "--bg-surface": "#0d140e",
      "--bg-hover": "#1a261c",
      "--text": "#8fd6a4",
      "--text-light": "#5fa87c",
      "--text-muted": "#4c7f60",
      "--accent": "#ffb000",
      "--accent-hover": "#ffc73d",
      "--accent-dim": "rgba(255, 176, 0, 0.12)",
      "--accent-light": "rgba(255, 176, 0, 0.06)",
      "--hud-accent": "#ffb000",
      "--hud-accent-rgb": "255, 176, 0",
      "--hud-accent-contrast": "#0a0a0f",
      "--border": "#23402c",
      "--border-hover": "#35603f",
      "--shadow-card": "0 0 18px rgba(143, 214, 164, 0.08)",
      "--shadow-modal": "0 0 30px rgba(143, 214, 164, 0.12)",
      "--danger": "#ff5f56",
      "--success": "#7ee787",
      "--radius-sm": "2px", "--radius-md": "2px", "--radius-lg": "2px",
      "--radius-card": "2px", "--radius-bubble": "2px",
      "--radius-input": "0px", "--radius-modal": "2px",
      "--chat-font": "'Cascadia Code', 'Fira Code', 'JetBrains Mono', 'Consolas', monospace",
    };
  }

  return {};
}

// ── 设置面板 · 风格卡片 ─────────────────────────────
const SKIN_THUMBS: Record<SkinId, string> = {
  classic: "background:linear-gradient(90deg,#eef2f9 0 40%,#ffffff 40% 72%,#6366f1 72%);",
  hud:     "background:linear-gradient(90deg,#0a0a0f 0 45%,#101024 45% 72%,#00e5ff 72%);",
  glass:   "background:linear-gradient(120deg,rgba(255,255,255,0.9),rgba(255,255,255,0.30) 45%,rgba(99,102,241,0.40)),linear-gradient(90deg,#c7d2fe,#e0e7ff);",
  brutal:  "background:linear-gradient(90deg,#14161f 0 16%,#ffffff 16% 74%,#3b82f6 74%);border:2px solid #14161f;",
  paper:   "background:linear-gradient(90deg,#faf6ef 0 40%,#fffdf7 40% 72%,#f59e0b 72%);",
  neu:     "background:#e3e7ee;box-shadow:inset -2px -2px 5px rgba(94,104,124,0.28),inset 2px 2px 5px rgba(255,255,255,0.95);",
  terminal: "background:repeating-linear-gradient(0deg,rgba(143,214,164,0.22) 0 1px,transparent 1px 3px),linear-gradient(90deg,#0b100c 0 45%,#101711 45% 72%,#8fd6a4 72%);",
};

/** @param {string} key @returns {string} */
function t(key: string): string {
  return (typeof window.t === "function" ? window.t(key) : key);
}

function renderSkinCards(): void {
  const grid = document.getElementById("skin-grid");
  if (!grid) return;
  grid.innerHTML = "";
  const cur = getSkin();
  for (const id of SKIN_IDS) {
    const el = document.createElement("div");
    el.className = "bg-preset-swatch skin-card" + (id === cur ? " active" : "");
    el.dataset.skin = id;
    el.title = t("skin." + id + "_desc");
    el.innerHTML =
      '<div class="skin-thumb" style="' + SKIN_THUMBS[id] + '"></div>' +
      '<span data-i18n="skin.' + id + '">' + t("skin." + id) + "</span>";
    el.addEventListener("click", () => {
      setSkin(id);
      grid.querySelectorAll(".skin-card").forEach((c) => {
        c.classList.toggle("active", (c as HTMLElement).dataset.skin === id);
      });
    });
    grid.appendChild(el);
  }
}

// ── 自初始化 ────────────────────────────────────────
// 尽早写 data-skin / 同步旧 hud 键，避免首帧闪错皮肤。
// （hud-overlay 先于本模块求值并读取旧键；migrate + setItem 已把
// 旧键与本皮肤对齐，app.ts 里 hudSetEnabled 不会再打架。）
try {
  const skin = getSkin();
  document.documentElement.dataset.skin = skin;
  localStorage.setItem(LEGACY_HUD_KEY, skin === "hud" ? "on" : "off");
  // hud-overlay 先于本模块求值并按旧键初始化；这里显式对齐一次，
  // 否则 localStorage 里 skin 与 hud 键不一致时（如手改/中断写入）
  // 会在非 hud 皮肤上残留 HUD 覆盖层。
  hudSetEnabled(skin === "hud");
} catch {}

const init = () => renderSkinCards();
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}
