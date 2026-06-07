// ── Prompt profile E2E tests ──────────────────────────
// Covers the prompt-store module (modules/prompt-store.mjs):
//   - prompt:list / prompt:default / prompt:save / prompt:activate / prompt:delete
//   - Default profile auto-load
//   - Add profile → new chip appears with auto-generated name
//   - Switching profile loads its content into the editor
//   - Delete via custom confirm dialog
//
// State note: prompt profiles persist in userData/system-prompt-profiles.json.
// To make tests independent, each test starts by deleting all non-default
// profiles (deletes from any prior run + anything created by previous tests
// in this run). The "default" profile is always preserved by the backend.

import { test, expect, _electron as electron } from "@playwright/test";

// ── Shared env + helpers (mirror smoke.test.mjs) ───────
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
  // Clean state: clear localStorage AND all non-default prompt profiles
  await window.evaluate(() => localStorage.clear());
  // Delete any non-default profiles from previous runs
  const allProfiles = await window.evaluate(() =>
    window.aideagent.listPromptProfiles()
  );
  if (allProfiles?.profiles) {
    for (const id of Object.keys(allProfiles.profiles)) {
      if (id !== "default") {
        await window.evaluate((pid) =>
          window.aideagent.deletePromptProfile(pid), id
        );
      }
    }
  }
  // Reload so the renderer re-reads the cleaned store
  await window.reload();
  await window.waitForLoadState("domcontentloaded", { timeout: 10_000 });
  await window.waitForTimeout(500);
  return { app, window };
};

const openPromptTab = async (window) => {
  await window.locator("#settings-btn").click();
  await window.waitForTimeout(400);
  const modalActive = await window.evaluate(
    () => document.getElementById("settings-modal")?.classList.contains("active")
  );
  if (!modalActive) throw new Error("settings modal did not open");
  await window.locator('#settings-modal [data-tab="prompt"]').click();
  await window.waitForTimeout(500);
  // Wait for lazy-load to complete (loadPromptStore is async on first click)
  await window.waitForFunction(() =>
    document.getElementById("prompt-sections")?.children?.length > 0
  , { timeout: 5000 });
};

// ── 1. Default profile loads on tab open ───────────────
test("prompt: tab opens with default profile pre-loaded", async () => {
  const { app, window } = await launchApp();
  await openPromptTab(window);

  // Default chip is in the selector
  await expect(
    window.locator('.prompt-profile-chip[data-profile-id="default"]')
  ).toBeVisible();
  // Default chip is active
  const isActive = await window.evaluate(() =>
    document
      .querySelector('.prompt-profile-chip[data-profile-id="default"]')
      ?.classList.contains("active")
  );
  expect(isActive).toBe(true);
  // Name input has the localized default name
  const nameVal = await window
    .locator("#prompt-name-input")
    .inputValue();
  expect(nameVal.length).toBeGreaterThan(0);
  // Content is non-empty (DEFAULT_PROMPT is a long multi-line string)
  const contentVal = await window
    .locator("#prompt-content-area")
    .inputValue();
  expect(contentVal.length).toBeGreaterThan(50);
  // Save button is visible (default profile is rendered even though it
  // can't be deleted)
  await expect(window.locator("#prompt-save-btn")).toBeVisible();
  // Delete button is disabled for default
  await expect(window.locator("#prompt-delete-btn")).toBeDisabled();

  await closeApp(app);
});

// ── 2. Add profile creates a new chip ──────────────────
test("prompt: add profile shows new chip with auto-generated name", async () => {
  const { app, window } = await launchApp();
  await openPromptTab(window);

  const beforeCount = await window
    .locator(".prompt-profile-chip")
    .count();
  expect(beforeCount).toBe(1); // only "default"

  // Click the + button
  await window.locator("#prompt-add-profile-btn").click();
  // The new profile activates → renderPromptEditor rebuilds the editor
  await window.waitForTimeout(500);

  const afterCount = await window
    .locator(".prompt-profile-chip")
    .count();
  expect(afterCount).toBe(2);

  // New chip is active (after addNewProfile, currentProfileId is the new one)
  const activeCount = await window
    .locator(".prompt-profile-chip.active")
    .count();
  expect(activeCount).toBe(1);
  const activeProfileId = await window.evaluate(() =>
    document
      .querySelector(".prompt-profile-chip.active")
      ?.getAttribute("data-profile-id")
  );
  expect(activeProfileId).not.toBe("default");

  // Auto-generated name: localized "prompt.created" template rendered
  // (e.g., "系统提示词1" in zh-CN, "System Prompt 1" in en)
  const newChipText = await window
    .locator(`.prompt-profile-chip[data-profile-id="${activeProfileId}"]`)
    .textContent();
  expect(newChipText?.trim().length).toBeGreaterThan(0);

  await closeApp(app);
});

// ── 3. Switching profile loads its content ─────────────
test("prompt: switching profile updates the editor content", async () => {
  const { app, window } = await launchApp();
  await openPromptTab(window);

  // Add a new profile
  await window.locator("#prompt-add-profile-btn").click();
  await window.waitForTimeout(500);

  // Type unique content into the new profile
  const uniqueContent = "TEST_PROFILE_CONTENT_" + Date.now();
  await window.locator("#prompt-content-area").fill(uniqueContent);
  // Save it
  await window.locator("#prompt-save-btn").click();
  await window.waitForTimeout(300);
  // Wait for the "Saved" status to appear (proves the IPC round-trip)
  await expect(window.locator("#prompt-settings-status")).toContainText(
    /(已保存|Saved)/,
    { timeout: 3000 }
  );

  // Switch to default
  await window
    .locator('.prompt-profile-chip[data-profile-id="default"]')
    .click();
  await window.waitForTimeout(400);
  // Default content is the long DEFAULT_PROMPT — definitely not our test string
  const defaultContent = await window
    .locator("#prompt-content-area")
    .inputValue();
  expect(defaultContent).not.toBe(uniqueContent);
  expect(defaultContent.length).toBeGreaterThan(50);

  // Switch back to the test profile
  const testProfileId = await window.evaluate(() => {
    const chips = document.querySelectorAll(".prompt-profile-chip");
    for (const c of chips) {
      if (c.getAttribute("data-profile-id") !== "default") {
        return c.getAttribute("data-profile-id");
      }
    }
    return null;
  });
  expect(testProfileId).toBeTruthy();
  await window
    .locator(`.prompt-profile-chip[data-profile-id="${testProfileId}"]`)
    .click();
  await window.waitForTimeout(400);
  const reloadedContent = await window
    .locator("#prompt-content-area")
    .inputValue();
  expect(reloadedContent).toBe(uniqueContent);

  await closeApp(app);
});

// ── 4. Delete removes the profile via confirm dialog ───
test("prompt: delete non-default profile after confirm", async () => {
  const { app, window } = await launchApp();
  await openPromptTab(window);

  // Add a new profile
  await window.locator("#prompt-add-profile-btn").click();
  await window.waitForTimeout(500);
  expect(await window.locator(".prompt-profile-chip").count()).toBe(2);

  // Click delete (triggers custom confirm modal — not native confirm)
  await window.locator("#prompt-delete-btn").click();
  // Wait for the confirm modal to appear
  await window.locator("#confirm-modal.active").waitFor({ state: "visible", timeout: 2000 });
  // Click OK
  await window.locator("#confirm-modal-ok").click();
  await window.waitForTimeout(500);

  // Profile is gone, default is back as active
  const finalCount = await window
    .locator(".prompt-profile-chip")
    .count();
  expect(finalCount).toBe(1);
  const activeId = await window.evaluate(() =>
    document
      .querySelector(".prompt-profile-chip.active")
      ?.getAttribute("data-profile-id")
  );
  expect(activeId).toBe("default");

  await closeApp(app);
});
