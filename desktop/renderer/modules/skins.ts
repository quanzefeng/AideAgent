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
 *      老用户首次启动按旧开关迁移（旧默认 on → hud 皮肤）。
 *
 * 存储：localStorage["AideAgent_skin"] = classic | hud | glass | brutal
 */

import { hudSetEnabled } from './hud-overlay.ts';

const SKIN_KEY = "AideAgent_skin";
/** 旧版 HUD 总开关存储键（迁移源 + 反向同步目标） */
const LEGACY_HUD_KEY = "AideAgent_hud";

export type SkinId = "classic" | "hud" | "glass" | "brutal";

const SKIN_IDS: SkinId[] = ["classic", "hud", "glass", "brutal"];

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
];

// ── 存取 ────────────────────────────────────────────
function isSkinId(v: unknown): v is SkinId {
  return typeof v === "string" && (SKIN_IDS as string[]).includes(v);
}

/** @returns {SkinId} 当前皮肤（首次调用时从旧 HUD 开关迁移并落盘） */
export function getSkin(): SkinId {
  try {
    const stored = localStorage.getItem(SKIN_KEY);
    if (isSkinId(stored)) return stored;
    // 迁移：旧 HUD 开关默认 on → hud；显式 off → classic。
    const legacy = localStorage.getItem(LEGACY_HUD_KEY);
    const skin: SkinId = legacy === "off" ? "classic" : "hud";
    localStorage.setItem(SKIN_KEY, skin);
    return skin;
  } catch {
    return "hud"; // 与旧版 HUD_DEFAULT 一致
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

  return {};
}

// ── 设置面板 · 风格卡片 ─────────────────────────────
const SKIN_THUMBS: Record<SkinId, string> = {
  classic: "background:linear-gradient(90deg,#eef2f9 0 40%,#ffffff 40% 72%,#6366f1 72%);",
  hud:     "background:linear-gradient(90deg,#0a0a0f 0 45%,#101024 45% 72%,#00e5ff 72%);",
  glass:   "background:linear-gradient(120deg,rgba(255,255,255,0.9),rgba(255,255,255,0.30) 45%,rgba(99,102,241,0.40)),linear-gradient(90deg,#c7d2fe,#e0e7ff);",
  brutal:  "background:linear-gradient(90deg,#14161f 0 16%,#ffffff 16% 74%,#3b82f6 74%);border:2px solid #14161f;",
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
} catch {}

const init = () => renderSkinCards();
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}
