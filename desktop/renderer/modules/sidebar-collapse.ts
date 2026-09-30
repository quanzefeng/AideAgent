/**
 * 侧栏折叠（ChatGPT 式收起/展开）
 *
 * 交互参考主流聊天客户端：
 *  - 收起按钮：侧栏底部（.sidebar-footer-actions 上方），点击后侧栏滑出，
 *    chat 区自动占满；折叠状态持久化到 localStorage["AideAgent_sidebar"]。
 *  - 展开按钮：折叠时出现在主界面左上角（悬浮小圆钮），点击恢复侧栏。
 *
 * 实现：html[data-sidebar="collapsed"] 驱动 CSS（width→0 + 淡出过渡），
 * 展开按钮 absolute 定位不参与布局，:has 无需 JS 监听窗口变化。
 */

const KEY = "AideAgent_sidebar";
const STATE_COLLAPSED = "collapsed";
const STATE_EXPANDED = "expanded";

/** @returns {boolean} 当前是否折叠 */
export function sidebarCollapsed() {
  try {
    return localStorage.getItem(KEY) === STATE_COLLAPSED;
  } catch {
    return false;
  }
}

/** @returns {void} 应用折叠状态到 <html>（启动恢复 / 切换共用） */
function applyState() {
  document.documentElement.dataset.sidebar = sidebarCollapsed() ? STATE_COLLAPSED : STATE_EXPANDED;
}

/** @returns {void} 绑定按钮（幂等） */
function bind() {
  const collapseBtn = document.getElementById("sidebar-collapse-btn");
  const expandBtn = document.getElementById("sidebar-expand-btn");
  if (!collapseBtn || !expandBtn) return;

  collapseBtn.addEventListener("click", () => {
    try { localStorage.setItem(KEY, STATE_COLLAPSED); } catch {}
    applyState();
  });
  expandBtn.addEventListener("click", () => {
    try { localStorage.setItem(KEY, STATE_EXPANDED); } catch {}
    applyState();
  });
  collapseBtn.dataset.bound = "1";
  expandBtn.dataset.bound = "1";
}

/** @returns {void} 自初始化 */
function init() {
  applyState();
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", bind);
  } else {
    bind();
  }
}

init();
