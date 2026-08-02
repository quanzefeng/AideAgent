/**
 * 启动序列（赛博朋克皮肤 · 阶段 2）
 *
 * 设计目标：
 *   1. 一次性开机画面：POWER_ON → POST → NET_INIT → AUTH → READY
 *   2. 纯 CSS steps() 打字机 + 手写 JS 状态机（CSP 纯净，零第三方）
 *   3. 跟随 HUD 总开关（AideAgent_hud）：关闭时不出现
 *   4. prefers-reduced-motion 时跳过打字动画，极速完成
 *   5. 任意点击 / 按键 / SKIP 按钮可跳过，fade 后自毁
 */

import { hudEnabled, hudMotionEnabled } from "./hud-overlay.mjs";
import { loadAgentName } from "./agent-name.mjs";

/** 阶段定义：每个阶段一条启动日志。delay = 本行完成后的停顿(ms) */
const STAGES = [
  { key: "boot.power_on", delay: 250 },
  { key: "boot.post", delay: 250 },
  { key: "boot.net_init", delay: 250 },
  { key: "boot.auth", delay: 350 },
];

/** @returns {boolean} 尊重系统"减少动态"偏好（HUD 动画开关强制开启时忽略） */
function prefersReducedMotion() {
  if (hudMotionEnabled()) return false;
  try {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}

/** @returns {string} 单行打字动画时长 */
function typeDuration(text) {
  return Math.min(650, 90 + text.length * 26) + "ms";
}

/** @returns {number} 打字 steps 数（>=2，越接近字符数越平滑） */
function typeSteps(text) {
  return Math.max(2, text.length);
}

/** @returns {Promise<void>} 等待 duration 且未被取消 */
function wait(ms, token) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    token.timers.push(timer);
  });
}

/** @returns {void} 立即跳过（跳到 READY） */
function cancelBoot(boot, token) {
  token.cancelled = true;
  for (const t of token.timers) clearTimeout(t);
  token.timers = [];
  finishBoot(boot, token, true);
}

/** @returns {void} READY 行 + 进度条打满 + fade + 自毁 */
async function finishBoot(boot, token, instant) {
  if (boot.dataset.done) return;
  boot.dataset.done = "1";
  boot.classList.remove("typing");
  const name = loadAgentName() || "AideAgent";
  appendLine(boot, t("boot.ready", { name }), instant);
  const bar = document.getElementById("boot-progress-bar");
  if (bar) bar.style.width = "100%";
  const foot = document.querySelector(".boot-foot");
  if (foot) foot.style.opacity = "0";
  if (instant) {
    boot.classList.add("boot-done");
    setTimeout(() => {
      boot.remove();
      token.cleanup?.();
    }, 80);
    return;
  }
  await wait(450, token);
  if (token.cancelled) return;
  boot.classList.add("boot-done");
  await wait(450, token);
  if (token.cancelled) return;
  boot.remove();
  token.cleanup?.();
}

/** @returns {void} 把一行固定进日志 */
function appendLine(boot, text, instant) {
  const log = boot.querySelector("#boot-log");
  if (!log) return;
  const line = document.createElement("div");
  line.className = "boot-line";
  line.innerHTML = `<span class="boot-arrow">&gt;</span><span class="boot-text"></span>`;
  line.querySelector(".boot-text").textContent = text;
  log.appendChild(line);
  if (!instant) {
    // 让新行以打字动画进入
    const txt = line.querySelector(".boot-text");
    txt.classList.add("typing");
    txt.style.setProperty("--boot-steps", String(typeSteps(text)));
    txt.style.setProperty("--boot-dur", typeDuration(text));
  }
  boot.querySelector("#boot-current")?.classList.add("hidden");
}

/** @returns {void} 状态机主流程 */
async function runBoot(boot, token) {
  const reduced = prefersReducedMotion();

  if (reduced) {
    // 无障碍：全部行瞬时给出，快速收尾
    for (const s of STAGES) appendLine(boot, t(s.key), true);
    finishBoot(boot, token, true);
    return;
  }

  const current = boot.querySelector("#boot-text");
  const curWrap = boot.querySelector("#boot-current");
  const bar = document.getElementById("boot-progress-bar");

  for (let i = 0; i < STAGES.length; i++) {
    const s = STAGES[i];
    const text = t(s.key);
    // 显示本行并启动 CSS steps() 打字动画
    curWrap?.classList.remove("hidden");
    if (current) {
      current.textContent = text;
      current.classList.remove("typing");
      // 重新触发动画：重置后再加类
      void current.offsetWidth;
      current.style.setProperty("--boot-steps", String(typeSteps(text)));
      current.style.setProperty("--boot-dur", typeDuration(text));
      current.classList.add("typing");
    }
    if (bar) bar.style.width = `${Math.round(((i + 0.5) / STAGES.length) * 100)}%`;
    // 等打字动画走完 + 阶段停顿
    await wait(parseInt(typeDuration(text), 10) + s.delay, token);
    if (token.cancelled) return;
    // 行入日志，进入下一阶段
    appendLine(boot, text, true);
    current?.classList.remove("typing");
  }

  if (token.cancelled) return;
  finishBoot(boot, token, false);
}

/** @returns {HTMLElement} 创建 boot 覆盖层 DOM */
function createBootScreen() {
  const boot = document.createElement("div");
  boot.id = "boot-screen";
  boot.innerHTML = `
    <div class="boot-inner">
      <div class="boot-head">AIDEAGENT // BOOT SEQUENCE</div>
      <div class="boot-log" id="boot-log"></div>
      <div class="boot-current" id="boot-current">
        <span class="boot-arrow">&gt;</span>
        <span class="boot-text" id="boot-text"></span>
        <span class="boot-caret"></span>
      </div>
      <div class="boot-progress"><span class="boot-progress-bar" id="boot-progress-bar"></span></div>
      <div class="boot-foot">
        <button class="boot-skip" id="boot-skip" type="button"></button>
      </div>
    </div>
  `;
  return boot;
}

/** @returns {void} 挂载并启动 boot（幂等；HUD 关闭时静默跳过） */
function injectBoot() {
  if (document.getElementById("boot-screen")) return;
  if (!hudEnabled()) return;

  const boot = createBootScreen();
  const skipBtn = boot.querySelector("#boot-skip");
  if (skipBtn) skipBtn.textContent = t("boot.skip");
  document.body.appendChild(boot);

  const token = { cancelled: false, timers: [], cleanup: null };
  // 任意点击 / 按键 / SKIP 按钮都可跳过
  const onSkip = () => cancelBoot(boot, token);
  const onKey = () => cancelBoot(boot, token);
  boot.addEventListener("click", onSkip);
  window.addEventListener("keydown", onKey);
  skipBtn?.addEventListener("click", onSkip);
  // boot 自毁后回收全局监听，避免泄漏
  token.cleanup = () => {
    boot.removeEventListener("click", onSkip);
    window.removeEventListener("keydown", onKey);
  };

  runBoot(boot, token);
}

/** @returns {void} 自初始化（DOM 就绪后挂载） */
function init() {
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", injectBoot);
  } else {
    injectBoot();
  }
}

init();

export { injectBoot };
