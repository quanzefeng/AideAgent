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

const openKbTab = async (window) => {
  await window.locator("#settings-btn").click();
  await window.waitForTimeout(400);
  const modalActive = await window.evaluate(
    () => document.getElementById("settings-modal")?.classList.contains("active")
  );
  if (!modalActive) throw new Error("settings modal did not open");
  await window.locator('#settings-modal [data-tab="knowledge-base"]').click();
  await window.waitForTimeout(500);
};

test.describe("Knowledge Base Panel", () => {
  test("kb: tab opens with vault and status elements visible", async () => {
    let app;
    try {
      const launched = await launchApp();
      app = launched.app;
      const window = launched.window;

      await openKbTab(window);

      // Check vault path element exists
      const vaultPath = window.locator("#kb-vault-path");
      await expect(vaultPath).toBeVisible();

      // Check scan button is visible
      const scanBtn = window.locator("#kb-scan-btn");
      await expect(scanBtn).toBeVisible();

      // Check status element exists
      const status = window.locator("#kb-status");
      await expect(status).toBeVisible();
    } finally {
      await closeApp(app);
    }
  });

  test("kb: scan button is clickable", async () => {
    let app;
    try {
      const launched = await launchApp();
      app = launched.app;
      const window = launched.window;

      await openKbTab(window);

      // Click scan button (should not crash even without vault)
      const scanBtn = window.locator("#kb-scan-btn");
      await expect(scanBtn).toBeVisible();
      await scanBtn.click();
      await window.waitForTimeout(500);

      // Verify modal is still open (app didn't crash)
      const modalActive = await window.evaluate(
        () => document.getElementById("settings-modal")?.classList.contains("active")
      );
      expect(modalActive).toBe(true);
    } finally {
      await closeApp(app);
    }
  });

test("kb: test search input accepts text", async () => {
  let app;
  try {
    const launched = await launchApp();
    app = launched.app;
    const window = launched.window;

    await openKbTab(window);

    // Click test search button to reveal the test area
    const testSearchBtn = window.locator("#kb-test-search-btn");
    await expect(testSearchBtn).toBeVisible();
    await testSearchBtn.click();
    await window.waitForTimeout(500);

    // Now the test search input should be visible
    const searchInput = window.locator("#kb-test-query");
    await expect(searchInput).toBeVisible();

    // Type a query
    await searchInput.fill("test query");
    await window.waitForTimeout(300);

    // Verify the input value
    const inputValue = await searchInput.inputValue();
    expect(inputValue).toBe("test query");
  } finally {
    await closeApp(app);
  }
});
});
