/**
 * 烟雾测试套件 —— 在做任何 app.js 重构之前先建立 baseline
 *
 * 策略：先测最便宜的（进程能起来），再测最关键的（CSS 变量能更新）。
 * 详细 E2E 测试在 Step 3 拆 app.js 时按需补充。
 */
import { test, expect, _electron as electron } from "@playwright/test";

// ── 共享环境 ──────────────────────────────────────
// AIDEAGENT_TEST_MODE=1 → main.mjs 跳过 MCP/WeChat 慢启动
// 这样 app.quit() 5s 内能优雅退出
const testEnv = {
  ...process.env,
  ELECTRON_DISABLE_SANDBOX: "1",
  NODE_ENV: "test",
  AIDEAGENT_TEST_MODE: "1",
};

// 强制 kill Electron 进程（备选，close 失败时用）
const killApp = (app) => {
  try {
    const proc = app?.process?.();
    if (proc && !proc.killed) proc.kill("SIGKILL");
  } catch (e) {
    /* 已退出 */
  }
};

// 带超时的关闭：5s 没完就强制 kill
const closeApp = async (app) => {
  if (!app) return;
  try {
    await Promise.race([
      app.close(),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("close-timeout")), 5000)
      ),
    ]);
  } catch (e) {
    killApp(app);
  }
};

// ── 共享启动器 ──────────────────────────────────────
const launchApp = async () => {
  const app = await electron.launch({
    args: ["."],
    env: testEnv,
    timeout: 30_000,
  });
  const window = await app.firstWindow({ timeout: 15_000 });
  await window.waitForLoadState("domcontentloaded", { timeout: 10_000 });
  // 等 1s 让 bg-settings 等模块完成 init
  await window.waitForTimeout(1000);
  // 清空 localStorage，确保每个测试从干净状态开始。
  // bg-settings 在 init 时会读 localStorage 恢复主题；不清理会导致
  // test 6 (gray) 的状态泄漏到下一次 run，让 test 4 (click gray) 看到
  // 已经是 gray 状态，点了无变化。
  await window.evaluate(() => localStorage.clear());
  await window.reload();
  await window.waitForLoadState("domcontentloaded", { timeout: 10_000 });
  await window.waitForTimeout(500);
  return { app, window };
};

// ── 1. 进程能起来（最便宜） ────────────────────────
test("sanity: Electron launches and process is alive", async () => {
  const app = await electron.launch({ args: ["."], env: testEnv, timeout: 30_000 });
  await new Promise((r) => setTimeout(r, 3000));
  expect(app.process().pid).toBeGreaterThan(0);
  await closeApp(app);
});

// ── 2. 主窗口 + 关键元素 ───────────────────────────
test("main window loads and prompt input is visible", async () => {
  const { app, window } = await launchApp();
  await expect(window.locator("#prompt-input")).toBeVisible();
  await closeApp(app);
});

// ── 打开设置面板（用侧边栏按钮，Ctrl+I 没实现） ─────────
const openAppearance = async (window) => {
  // 1) 点侧边栏的设置按钮
  await window.locator("#settings-btn").click();
  await window.waitForTimeout(400);
  // 2) 确认 modal 真的 active
  const modalActive = await window.evaluate(
    () => document.getElementById("settings-modal")?.classList.contains("active")
  );
  if (!modalActive) throw new Error("settings modal did not open after #settings-btn click");
  // 3) 切到外观 tab
  await window.locator('#settings-modal [data-tab="appearance"]').click();
  await window.waitForTimeout(400);
};

// ── 3. 设置面板 + 外观 tab + 7 个预设 ──────────────
test("settings: appearance tab shows 7 preset swatches", async () => {
  const { app, window } = await launchApp();
  await openAppearance(window);
  await expect(window.locator(".bg-preset-swatch")).toHaveCount(7);
  await closeApp(app);
});

// ── 4. 点击预设 → CSS 变量实际更新 ─────────────────
test("clicking gray preset updates --bg CSS variable", async () => {
  const { app, window } = await launchApp();
  await openAppearance(window);

  const before = await window.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue("--bg").trim()
  );
  await window.locator('[data-preset="gray"]').click();
  await window.waitForTimeout(300);
  const after = await window.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue("--bg").trim()
  );
  expect(after).not.toBe(before);
  expect(after.toLowerCase()).toBe("#f3f4f6");
  await closeApp(app);
});

// ── 5. 2D 色板：点击 → 预览 → 应用 ────────────────
test("2D color picker: click → preview → apply writes --bg", async () => {
  const { app, window } = await launchApp();
  await openAppearance(window);

  const square = window.locator("#bg-color-square");
  await expect(square).toBeVisible();

  const box = await square.boundingBox();
  if (!box) throw new Error("bg-color-square has no bounding box");
  await window.mouse.click(box.x + box.width * 0.8, box.y + box.height * 0.2);

  const previewText = await window.locator("#bg-color-pending-hex").textContent();
  expect(previewText).toMatch(/^#[0-9a-f]{6}$/i);
  expect(previewText?.toLowerCase()).not.toBe("#ffffff");

  const bgBeforeApply = await window.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue("--bg").trim()
  );
  await window.locator("#bg-color-apply-btn").click();
  await window.waitForTimeout(300);

  const bgAfterApply = await window.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue("--bg").trim()
  );
  expect(bgAfterApply).not.toBe(bgBeforeApply);
  expect(bgAfterApply.toLowerCase()).toBe(previewText?.toLowerCase());
  await closeApp(app);
});

// ── 6. localStorage 持久化 ────────────────────────
test("theme persists to localStorage with correct shape", async () => {
  const { app, window } = await launchApp();
  await openAppearance(window);

  await window.locator('[data-preset="gray"]').click();
  await window.waitForTimeout(300);

  const stored = await window.evaluate(() => localStorage.getItem("AideAgent_theme"));
  expect(stored).toBeTruthy();
  const parsed = JSON.parse(stored);
  expect(parsed.preset).toBe("gray");
  expect(parsed.bg.toLowerCase()).toBe("#f3f4f6");
  await closeApp(app);
});

// ── 7. cyberpunk 预设：点击 → 暗色变量生效 ──────────
test("cyberpunk preset applies dark bg and neon accent", async () => {
  const { app, window } = await launchApp();
  await openAppearance(window);

  await window.locator('[data-preset="cyberpunk"]').click();
  await window.waitForTimeout(300);

  const bg = await window.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue("--bg").trim()
  );
  const accent = await window.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue("--accent").trim()
  );
  expect(bg.toLowerCase()).toBe("#0a0a0f");
  expect(accent.toLowerCase()).toBe("#00e5ff");
  await closeApp(app);
});

// ── 8. HUD overlay：默认注入且不拦截交互 ────────────
test("hud overlay injects by default and ignores pointer events", async () => {
  const { app, window } = await launchApp();

  const overlay = window.locator("#hud-overlay");
  await expect(overlay).toBeVisible();
  const corner = await window.locator(".hud-corner-tl").count();
  expect(corner).toBe(1);

  const pointerEvents = await window.evaluate(() =>
    getComputedStyle(document.getElementById("hud-overlay")).pointerEvents
  );
  expect(pointerEvents).toBe("none");

  // 默认开启（localStorage 未显式关闭）
  const on = await window.evaluate(() => document.documentElement.dataset.hud);
  expect(on).toBe("on");
  await closeApp(app);
});

// ── 9. HUD 开关：data-hud="off" 隐藏覆盖层 ──────────
test("hud overlay hides when data-hud is off", async () => {
  const { app, window } = await launchApp();

  await window.evaluate(() => {
    localStorage.setItem("AideAgent_hud", "off");
    document.documentElement.dataset.hud = "off";
  });
  await window.reload();
  await window.waitForLoadState("domcontentloaded", { timeout: 10_000 });
  await window.waitForTimeout(500);

  const visible = await window.locator("#hud-overlay").isVisible();
  expect(visible).toBe(false);
  await closeApp(app);
});

// ── 10. Boot 序列：默认出现并自行结束 ──────────────
test("boot sequence appears on launch and self-removes", async () => {
  const { app, window } = await launchApp();

  // launchApp 完成后 boot 仍应存在（POWER_ON 阶段）
  const boot = window.locator("#boot-screen");
  await expect(boot).toBeAttached();
  // boot 尚在时，日志区应有内容（至少一行启动文本）
  await expect(window.locator("#boot-log .boot-line").first()).toBeVisible({ timeout: 3000 });
  // 等待自动结束（状态机总时长 < 6s，给足余量）
  await expect(boot).not.toBeAttached({ timeout: 8000 });
  await closeApp(app);
});

// ── 11. Boot 可点击跳过 ───────────────────────────
test("boot sequence skips on click", async () => {
  const { app, window } = await launchApp();

  // 立即点击 boot（不等动画跑完），应立即进入 fade 并移除
  const boot = window.locator("#boot-screen");
  await expect(boot).toBeAttached();
  await boot.click({ position: { x: 20, y: 20 }, timeout: 2000 });
  await expect(boot).not.toBeAttached({ timeout: 3000 });
  await closeApp(app);
});

// ── 13. 阶段3 实时数据：IPC 事件填充 HUD 数据条 ────────
test("hud telemetry fills topbar from IPC events", async () => {
  const { app, window } = await launchApp();

  // 初始：遥测模块自绘 STANDBY（而非 HTML 默认的 SYSTEM ONLINE）
  await expect(window.locator("#hud-status")).toHaveText("STANDBY", { timeout: 3000 });

  // 通过真实 preload 桥发送 context:usage
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0].webContents.send("context:usage", {
      totalTokens: 5000,
      systemTokens: 1000,
      historyTokens: 3000,
      toolResultTokens: 1000,
      windowSize: 20000,
      usagePct: 25,
    });
  });
  await expect(window.locator("#hud-ctx")).toHaveText("CTX: 25%", { timeout: 3000 });

  // 发送 tool:start → 状态切到 TOOL RUNNING
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0].webContents.send("tool:start", { name: "read_file", args: {} });
  });
  await expect(window.locator("#hud-status")).toHaveText("TOOL RUNNING", { timeout: 3000 });

  // stream:done → 回到 STANDBY
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0].webContents.send("stream:done");
  });
  await expect(window.locator("#hud-status")).toHaveText("STANDBY", { timeout: 3000 });

  await closeApp(app);
});

// ── 12. Boot 跟随 HUD 开关：关闭时不出现 ────────────
test("boot sequence is skipped when HUD is off", async () => {
  const { app, window } = await launchApp();

  await window.evaluate(() => {
    localStorage.setItem("AideAgent_hud", "off");
    document.documentElement.dataset.hud = "off";
  });
  await window.reload();
  await window.waitForLoadState("domcontentloaded", { timeout: 10_000 });
  await window.waitForTimeout(500);

  const bootCount = await window.locator("#boot-screen").count();
  expect(bootCount).toBe(0);
  await closeApp(app);
});
