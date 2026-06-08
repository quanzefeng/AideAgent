import { test, expect, _electron as electron } from "@playwright/test";

const testEnv = {
  ...process.env,
  ELECTRON_DISABLE_SANDBOX: "1",
  NODE_ENV: "test",
  AIDEAGENT_TEST_MODE: "1",
};

const killApp = (app) => {
  try {
    const proc = app?.process?.();
    if (proc && !proc.killed) proc.kill("SIGKILL");
  } catch (e) { /* 已退出 */ }
};

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

const launchApp = async () => {
  const app = await electron.launch({
    args: ["."],
    env: testEnv,
    timeout: 30_000,
  });
  const window = await app.firstWindow({ timeout: 15_000 });
  await window.waitForLoadState("domcontentloaded", { timeout: 10_000 });
  await window.waitForTimeout(500);
  await window.evaluate(() => localStorage.clear());
  await window.reload();
  await window.waitForLoadState("domcontentloaded", { timeout: 10_000 });
  await window.waitForTimeout(500);
  return { app, window };
};

const openSkillsTab = async (window) => {
  await window.locator("#settings-btn").click();
  await window.waitForTimeout(400);
  const modalActive = await window.evaluate(
    () => document.getElementById("settings-modal")?.classList.contains("active")
  );
  if (!modalActive) throw new Error("settings modal did not open");
  await window.locator('#settings-modal [data-tab="skills"]').click();
  await window.waitForTimeout(500);
};

test.describe("Skills Panel", () => {
  test("skills: tab opens with skills list and refresh button", async () => {
    let app;
    try {
      const launched = await launchApp();
      app = launched.app;
      const window = launched.window;

      await openSkillsTab(window);

      // Check skills list container exists
      const skillsList = window.locator("#local-skills-list");
      await expect(skillsList).toBeVisible();

      // Check refresh button exists
      const refreshBtn = window.locator("#skills-refresh-btn");
      await expect(refreshBtn).toBeVisible();

      // Check skills count display exists
      const skillsCount = window.locator("#skills-count");
      await expect(skillsCount).toBeVisible();
    } finally {
      await closeApp(app);
    }
  });

  test("skills: IPC listSkills returns valid structure", async () => {
    let app;
    try {
      const launched = await launchApp();
      app = launched.app;
      const window = launched.window;

      await openSkillsTab(window);

      const result = await window.evaluate(async () => {
        return await window.aideagent.listSkills();
      });

      // listSkills returns an array of skill paths
      expect(Array.isArray(result)).toBe(true);
    } finally {
      await closeApp(app);
    }
  });

  test("skills: refresh button is clickable", async () => {
    let app;
    try {
      const launched = await launchApp();
      app = launched.app;
      const window = launched.window;

      await openSkillsTab(window);

      await window.locator("#skills-refresh-btn").click();
      await window.waitForTimeout(500);

      const modalStillActive = await window.evaluate(
        () => document.getElementById("settings-modal")?.classList.contains("active")
      );
      expect(modalStillActive).toBe(true);
    } finally {
      await closeApp(app);
    }
  });
});
