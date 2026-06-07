// @ts-check — JSDoc-typed settings tab switcher.
// @ts-check — 带 JSDoc 类型注解的设置 tab 切换器。
/**
 * Settings tab switching
 * --------------------------------------------------------------------------
 * 通用 12 个 settings tab 的切换逻辑。点击 tab 元素会切到对应 panel，
 * 其他模块（如 prompt tab 加载 profile）可在自己的 click listener 里
 * 主动调 switchSettingsTab。
 *
 * 元素约定（与 index.html 保持一致）：
 *   - Tab 元素：.settings-tab，且带 data-tab="<name>"
 *   - Panel 元素：#panel-<name>
 */

/**
 * Switch the active settings tab.
 * @param {string} tabName - the data-tab value of the target tab
 */
export function switchSettingsTab(tabName) {
  document.querySelectorAll(".settings-tab").forEach(t => t.classList.remove("active"));
  document.querySelectorAll(".settings-panel").forEach(p => p.classList.remove("active"));
  const tab = document.querySelector(`.settings-tab[data-tab="${tabName}"]`);
  const panel = document.getElementById(`panel-${tabName}`);
  if (tab) tab.classList.add("active");
  if (panel) panel.classList.add("active");
}

export function initSettingsTabs() {
  /** @type {NodeListOf<HTMLElement>} */
  const tabs = document.querySelectorAll(".settings-tab");
  tabs.forEach((tab) => {
    tab.addEventListener("click", () => {
      const name = tab.dataset.tab;
      if (name) switchSettingsTab(name);
    });
  });
}
