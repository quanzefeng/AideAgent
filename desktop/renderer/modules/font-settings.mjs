// @ts-check — minimal JSDoc typing for this small self-init module.
// @ts-check — 此自初始化模块的最小 JSDoc 类型注解。
const FONT_KEY = "AideAgent_font";
const FW_KEY = "AideAgent_font_weights";

export function applyChatFont(/** @type {string} */ fontValue) {
  document.documentElement.style.setProperty("--chat-font", fontValue);
}

export function loadChatFont() {
  return localStorage.getItem(FONT_KEY) || "'Microsoft YaHei UI', 'Microsoft YaHei', sans-serif";
}

// ── Font weights (P3方案B v3: clamp to YaHei reality) ─────
// P3方案C: Microsoft YaHei only ships THREE actual weights:
//   - 300 (Light) — only on Windows 11+; older Windows falls back to 400
//   - 400 (Regular) — universal
//   - 700 (Bold) — universal
// Any value in between (500/600) or above (800/900) gets fallback-clamped
// to the nearest available weight by the browser. With `font-synthesis:
// none` (style.css), that fallback is HONEST — no synthesized fake bold.
//
// We deliberately default semibold and bold to the SAME value (700)
// because YaHei has no distinct "semibold" or "extra bold" — there's
// only one bold weight. Showing different defaults would be misleading.
// normal=400 (Regular) and medium=400 are also the same because YaHei
// has no distinct Light weight on most Windows installs; the only
// reason to have separate keys is so users can change ONE without
// touching the other.
const FW_DEFAULTS = Object.freeze({
  normal:   400,
  medium:   400,
  semibold: 700,
  bold:     700,
});

// CSS font-weight accepts any positive integer 1-1000. We clamp to
// [100, 900] (the standard CSS weight scale: Thin/Extra-light/Light/
// Normal/Medium/Semi-bold/Bold/Extra-bold/Black). Out-of-range or
// non-numeric input falls back to the per-key default.
const FW_MIN = 100;
const FW_MAX = 900;

/**
 * Clamp a user-entered weight to a safe range, round to integer, and
 * fall back to the per-key default if the value is missing or non-numeric.
 * @param {string} key one of "normal" | "medium" | "semibold" | "bold"
 * @param {any} val
 * @returns {number}
 */
export function clampWeight(key, val) {
  if (typeof val !== "number" || !Number.isFinite(val)) return FW_DEFAULTS[key];
  const rounded = Math.round(val);
  return Math.max(FW_MIN, Math.min(FW_MAX, rounded));
}

/**
 * Inject the user's weight choices as inline custom-property values on
 * <html>. Empty / null input is a no-op (lets the call site pass the
 * result of `loadFontWeights()` even before persistence has happened).
 * @param {Partial<Record<keyof typeof FW_DEFAULTS, number>> | null} weights
 */
export function applyFontWeights(weights) {
  if (!weights) return;
  for (const [key, val] of Object.entries(weights)) {
    if (!(key in FW_DEFAULTS)) continue;
    document.documentElement.style.setProperty(`--fw-${key}`, String(val));
  }
}

/**
 * Read the user's weight choices from localStorage. Merges with defaults
 * and clamps each value into [FW_MIN, FW_MAX] via `clampWeight`. Invalid
 * entries (NaN, out-of-range, wrong type) are silently replaced with the
 * default rather than throwing — localStorage can hold anything and we
 * shouldn't crash the UI on a corrupt value.
 * @returns {Record<keyof typeof FW_DEFAULTS, number>}
 */
export function loadFontWeights() {
  const out = { ...FW_DEFAULTS };
  try {
    const stored = JSON.parse(localStorage.getItem(FW_KEY) || "{}");
    for (const key of Object.keys(FW_DEFAULTS)) {
      out[key] = clampWeight(key, stored[key]);
    }
  } catch { /* ignored — fall back to defaults */ }
  return out;
}

/** @param {Record<keyof typeof FW_DEFAULTS, number>} weights */
export function saveFontWeights(weights) {
  try {
    localStorage.setItem(FW_KEY, JSON.stringify(weights));
  } catch { /* localStorage quota — silently ignore */ }
}

// Self-initializing: set up font select on load
/** @type {HTMLSelectElement | null} */
const fontSelect = /** @type {HTMLSelectElement | null} */ (document.getElementById("font-select"));
if (fontSelect) {
  fontSelect.value = loadChatFont();
  fontSelect.addEventListener("change", () => {
    const val = fontSelect.value;
    localStorage.setItem(FONT_KEY, val);
    applyChatFont(val);
  });
  Array.from(fontSelect.options).forEach(opt => {
    opt.style.fontFamily = opt.value;
  });
}
applyChatFont(loadChatFont());

// ── Weight number inputs (P3方案B v3: preview + explicit save) ─
// UX contract:
//   - Typing in an input updates the CSS variable immediately so the
//     user sees a live preview (only this session — not persisted).
//   - The "Save" button persists the current 4 values to localStorage
//     and is only enabled when there's a dirty (unsaved) state.
//   - The "Reset" button restores the defaults, applies them, and
//     marks the form as dirty so the user still needs to press Save
//     to commit (or save on their behalf — see saveAndApply() call).
//
// This split solves the "I typed something but nothing happened"
// problem: previously we saved on blur, which silently dropped edits
// if the user closed the panel mid-edit. Now nothing is lost — the
// preview is always live, and persistence is explicit.

const initialWeights = loadFontWeights();
applyFontWeights(initialWeights);

/** @type {Record<string, HTMLInputElement>} */
const inputs = {};
for (const key of Object.keys(FW_DEFAULTS)) {
  const input = document.getElementById(`fw-${key}-input`);
  if (!(input instanceof HTMLInputElement)) continue;
  inputs[key] = input;
  input.value = String(initialWeights[key]);
}

/**
 * Read the 4 input fields, clamp each value, and apply to <html>.
 * Returns the (possibly modified) working weights object.
 * @returns {Record<keyof typeof FW_DEFAULTS, number>}
 */
function readAndApplyFromInputs() {
  /** @type {Record<keyof typeof FW_DEFAULTS, number>} */
  const w = { ...FW_DEFAULTS };
  for (const [key, input] of Object.entries(inputs)) {
    const raw = input.value.trim();
    const parsed = raw === "" ? NaN : Number(raw);
    w[key] = clampWeight(key, parsed);
  }
  applyFontWeights(w);
  return w;
}

/**
 * Compare current input values (after clamp) against the persisted
 * values in localStorage. Returns true if anything differs (dirty).
 */
function isDirty() {
  const persisted = loadFontWeights();
  for (const key of Object.keys(FW_DEFAULTS)) {
    const raw = inputs[key].value.trim();
    const parsed = raw === "" ? NaN : Number(raw);
    const clamped = clampWeight(key, parsed);
    if (clamped !== persisted[key]) return true;
  }
  return false;
}

/** Refresh the Save button's enabled state based on dirtiness. */
function refreshSaveButton() {
  const btn = document.getElementById("fw-save-btn");
  if (btn instanceof HTMLButtonElement) btn.disabled = !isDirty();
}

// Live preview on every keystroke — apply CSS, mark dirty.
for (const input of Object.values(inputs)) {
  input.addEventListener("input", () => {
    readAndApplyFromInputs();
    refreshSaveButton();
  });
  // On blur: clamp the visible value (so user sees normalized 100/900
  // after typing "99" or "9999"). Persistence still requires Save.
  input.addEventListener("blur", () => {
    const persisted = loadFontWeights();
    const key = Object.keys(inputs).find((k) => inputs[k] === input);
    if (!key) return;
    const raw = input.value.trim();
    const parsed = raw === "" ? NaN : Number(raw);
    const clamped = clampWeight(key, parsed);
    input.value = String(clamped);
    refreshSaveButton();
  });
}

// Save button — commit current values to localStorage.
const saveBtn = document.getElementById("fw-save-btn");
if (saveBtn instanceof HTMLButtonElement) {
  saveBtn.addEventListener("click", () => {
    const w = readAndApplyFromInputs();
    saveFontWeights(w);
    refreshSaveButton();
  });
}

// Reset button — restore defaults into inputs + apply + persist.
const resetBtn = document.getElementById("fw-reset-btn");
if (resetBtn instanceof HTMLButtonElement) {
  resetBtn.addEventListener("click", () => {
    for (const [key, input] of Object.entries(inputs)) {
      input.value = String(FW_DEFAULTS[key]);
    }
    saveFontWeights({ ...FW_DEFAULTS });
    applyFontWeights({ ...FW_DEFAULTS });
    refreshSaveButton();
  });
}

// Initial save-button state (disabled — nothing dirty yet).
refreshSaveButton();
