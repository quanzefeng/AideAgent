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
  } catch (e) { /* already exited */ }
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

const openAgentTab = async (window) => {
  await window.locator("#settings-btn").click();
  await window.waitForTimeout(400);
  const modalActive = await window.evaluate(
    () => document.getElementById("settings-modal")?.classList.contains("active")
  );
  if (!modalActive) throw new Error("settings modal did not open");
  await window.locator('#settings-modal [data-tab="avatar"]').click();
  await window.waitForTimeout(400);
};

test.describe("agent-name module", () => {
  test("agent-name: tab shows inputs on first load", async () => {
    const { app, window } = await launchApp();
    try {
      await openAgentTab(window);

      const agentInput = window.locator("#agent-name-input");
      const userNameInput = window.locator("#user-name-input");

      await expect(agentInput).toBeVisible();
      await expect(userNameInput).toBeVisible();

      // Check inputs have default values (not empty after init)
      const agentValue = await agentInput.inputValue();
      const userValue = await userNameInput.inputValue();
      expect(agentValue.length).toBeGreaterThan(0);
      expect(userValue.length).toBeGreaterThan(0);
    } finally {
      await closeApp(app);
    }
  });

  test("agent-name: typing agent name and saving persists to localStorage", async () => {
    const { app, window } = await launchApp();
    try {
      await openAgentTab(window);

      await window.locator("#agent-name-input").fill("TestBot");
      await window.locator("#save-agent-name-btn").click();
      await window.waitForTimeout(300);

      const saved = await window.evaluate(() =>
        localStorage.getItem("AideAgent_name")
      );
      expect(saved).toBe("TestBot");
    } finally {
      await closeApp(app);
    }
  });

  test("agent-name: agent name updates sidebar display after reload", async () => {
    const { app, window } = await launchApp();
    try {
      await openAgentTab(window);

      await window.locator("#agent-name-input").fill("MyBot");
      await window.locator("#save-agent-name-btn").click();
      await window.waitForTimeout(300);

      await window.reload();
      await window.waitForLoadState("domcontentloaded", { timeout: 10_000 });
      await window.waitForTimeout(500);

      const display = window.locator("#sidebar-brand");
      await expect(display).toContainText("MyBot");
    } finally {
      await closeApp(app);
    }
  });

  test("agent-name: user name persists to localStorage", async () => {
    const { app, window } = await launchApp();
    try {
      await openAgentTab(window);

      await window.locator("#user-name-input").fill("TestUser");
      await window.locator("#save-user-name-btn").click();
      await window.waitForTimeout(300);

      const saved = await window.evaluate(() =>
        localStorage.getItem("AideAgent_user_name")
      );
      expect(saved).toBe("TestUser");
    } finally {
      await closeApp(app);
    }
  });
});
