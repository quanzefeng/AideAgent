/**
 * 界面风格（skin）+ 主题联动的回归测试
 *
 * 覆盖：
 *   - 7 个风格卡渲染；切换写入 data-skin，刷新后保持
 *   - 默认主题下切换皮肤会套用推荐预设（paper → cream）
 *   - terminal 强制深色 CRT 配色，并禁用"主题外观"区域
 *   - 暗色主题下聊天区跟随主题底色（回归：曾被写死成浅色渐变）
 *   - 用户手动选过预设后，切皮肤不再覆盖其配色
 */
import { test, expect, _electron as electron } from "@playwright/test";

const testEnv = {
  ...process.env,
  ELECTRON_DISABLE_SANDBOX: "1",
  NODE_ENV: "test",
  AIDEAGENT_TEST_MODE: "1",
};

const closeApp = async (app: any) => {
  if (!app) return;
  try {
    await Promise.race([
      app.close(),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("close-timeout")), 5000)
      ),
    ]);
  } catch {
    try {
      const proc = app?.process?.();
      if (proc && !proc.killed) proc.kill("SIGKILL");
    } catch {
      /* 已退出 */
    }
  }
};

const launchApp = async () => {
  const app = await electron.launch({ args: ["."], env: testEnv, timeout: 30_000 });
  const window = await app.firstWindow({ timeout: 15_000 });
  await window.waitForLoadState("domcontentloaded", { timeout: 10_000 });
  await window.waitForTimeout(800);
  // 与 smoke.test.ts 一致：每个用例从干净状态开始
  await window.evaluate(() => localStorage.clear());
  await window.reload();
  await window.waitForLoadState("domcontentloaded", { timeout: 10_000 });
  await window.waitForTimeout(600);
  return { app, window };
};

const openAppearance = async (window: any) => {
  await window.locator("#settings-btn").click();
  await window.waitForTimeout(300);
  await window.locator('#settings-modal [data-tab="appearance"]').click();
  await window.waitForTimeout(300);
};

const readVar = (window: any, name: string) =>
  window.evaluate(
    (n: string) =>
      getComputedStyle(document.documentElement).getPropertyValue(n).trim(),
    name
  );

test("skin grid: 7 styles, switching sets data-skin and persists after reload", async () => {
  const { app, window } = await launchApp();
  await openAppearance(window);
  await expect(window.locator(".skin-card")).toHaveCount(7);

  await window.locator('.skin-card[data-skin="paper"]').click();
  await window.waitForTimeout(350);
  expect(await window.evaluate(() => document.documentElement.dataset.skin)).toBe("paper");
  expect(await window.evaluate(() => localStorage.getItem("AideAgent_skin"))).toBe("paper");
  // 默认主题已是暖米，暖纸的推荐预设同为 cream → 无需改写主题
  expect(await readVar(window, "--bg")).toBe("#faf6ef");
  expect(await window.evaluate(() => localStorage.getItem("AideAgent_theme"))).toBeNull();

  await window.reload();
  await window.waitForLoadState("domcontentloaded");
  await window.waitForTimeout(700);
  expect(await window.evaluate(() => document.documentElement.dataset.skin)).toBe("paper");
  expect(await readVar(window, "--bg")).toBe("#faf6ef");
  await closeApp(app);
});

test("terminal skin forces CRT palette and locks theme controls", async () => {
  const { app, window } = await launchApp();
  await openAppearance(window);

  await window.locator('.skin-card[data-skin="terminal"]').click();
  await window.waitForTimeout(350);
  expect(await readVar(window, "--bg")).toBe("#0b100c");
  expect(await readVar(window, "--text")).toBe("#8fd6a4");
  await expect(window.locator(".skin-theme-note")).toBeVisible();
  const locked = await window.evaluate(() => {
    const el = document.getElementById("theme-controls");
    return el ? getComputedStyle(el).pointerEvents : null;
  });
  expect(locked).toBe("none");

  // 切回经典风格：恢复主题配色与可交互状态
  await window.locator('.skin-card[data-skin="classic"]').click();
  await window.waitForTimeout(350);
  expect(await readVar(window, "--bg")).toBe("#faf6ef");
  expect(await window.locator(".skin-theme-note").isVisible()).toBe(false);
  const unlocked = await window.evaluate(() => {
    const el = document.getElementById("theme-controls");
    return el ? getComputedStyle(el).pointerEvents : null;
  });
  expect(unlocked).not.toBe("none");
  await closeApp(app);
});

test("dark theme: chat area follows theme background and secondary text stays readable", async () => {
  const { app, window } = await launchApp();
  await window.evaluate(() => {
    localStorage.setItem(
      "AideAgent_theme",
      JSON.stringify({
        preset: "dark_purple",
        bg: "#1e1b2e",
        brightness: 1,
        accent: "#a78bfa",
        auto: false,
      })
    );
    localStorage.setItem("AideAgent_skin", "classic");
    localStorage.setItem("AideAgent_hud", "off");
  });
  await window.reload();
  await window.waitForLoadState("domcontentloaded");
  await window.waitForTimeout(800);

  expect(await window.evaluate(() => document.documentElement.dataset.themeMode)).toBe("dark");
  const chatBg = await window.evaluate(
    () => getComputedStyle(document.getElementById("chat-area")!).backgroundImage
  );
  // 回归：曾经写死 #edf2fa 浅色渐变，暗色主题下浅字配浅底
  expect(chatBg).not.toContain("237, 242, 250");
  expect(chatBg).not.toContain("#edf2fa");
  // 主题底色参与渐变
  expect(chatBg).toContain("30, 27, 46");
  // 次要文字/悬停色随暗色主题派生，而不是沿用浅色默认值
  expect(await readVar(window, "--text-light")).not.toBe("#555570");
  expect(await readVar(window, "--bg-hover")).not.toBe("#dce3ef");

  await window.evaluate(() => localStorage.clear());
  await closeApp(app);
});

test("manual preset is not overwritten by a skin's suggested preset", async () => {
  const { app, window } = await launchApp();
  await openAppearance(window);

  // 手动选"纯白"
  await window.locator('#bg-preset-grid [data-preset="white"]').click();
  await window.waitForTimeout(250);

  // 切到玻璃（推荐暗紫）——不应覆盖用户的选择
  await window.locator('.skin-card[data-skin="glass"]').click();
  await window.waitForTimeout(350);
  let stored = JSON.parse(
    await window.evaluate(() => localStorage.getItem("AideAgent_theme") || "{}")
  );
  expect(stored.preset).toBe("white");
  expect(await readVar(window, "--bg")).toBe("#ffffff");

  // 恢复默认后再切玻璃：默认主题仍会自动套用推荐预设
  await window.locator("#bg-reset-btn").click();
  await window.waitForTimeout(250);
  await window.locator('.skin-card[data-skin="classic"]').click();
  await window.waitForTimeout(250);
  await window.locator('.skin-card[data-skin="glass"]').click();
  await window.waitForTimeout(350);
  stored = JSON.parse(
    await window.evaluate(() => localStorage.getItem("AideAgent_theme") || "{}")
  );
  expect(stored.preset).toBe("dark_purple");
  expect(stored.auto).toBe(true);

  await window.evaluate(() => localStorage.clear());
  await closeApp(app);
});
