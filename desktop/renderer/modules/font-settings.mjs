// @ts-check — minimal JSDoc typing for this small self-init module.
// @ts-check — 此自初始化模块的最小 JSDoc 类型注解。
const FONT_KEY = "AideAgent_font";

export function applyChatFont(fontValue) {
  document.documentElement.style.setProperty("--chat-font", fontValue);
}

export function loadChatFont() {
  return localStorage.getItem(FONT_KEY) || "'Microsoft YaHei UI', 'Microsoft YaHei', sans-serif";
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
