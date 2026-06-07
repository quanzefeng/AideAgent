// ── Font + Language E2E tests ──────────────────────────
// Covers the font-settings module (modules/font-settings.mjs) + the
// translations module's lang/applyLang functions.
//
// Font: a single <select id="font-select"> with 2 options. Changing it
//   writes localStorage.AideAgent_font and updates the --chat-font CSS
//   variable on document.documentElement.
//
// Language: a <select id="lang-select"> with zh + en. Changing it writes
//   localStorage.AideAgent_lang and applyLang() rewrites every
//   [data-i18n] element's textContent.
//
// All tests start from a clean localStorage so a previous run can't
// leak font/lang choice into the next test.

import { test, expect, _electron as electron } from "@playwright/test";

// ── Shared env + helpers (mirror prompt.test.mjs) ───────
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
  // Clean state: clear localStorage (font + lang keys both live here)
  await window.evaluate(() => localStorage.clear());
  await window.reload();
  await window.waitForLoadState("domcontentloaded", { timeout: 10_000 });
  await window.waitForTimeout(500);
  return { app, window };
};

// Open a specific settings tab; expects settings-btn to be in the header.
const openSettingsTab = async (window, tab) => {
  await window.locator("#settings-btn").click();
  await window.waitForTimeout(400);
  const modalActive = await window.evaluate(
    () => document.getElementById("settings-modal")?.classList.contains("active")
  );
  if (!modalActive) throw new Error("settings modal did not open");
  await window.locator(`#settings-modal [data-tab="${tab}"]`).click();
  await window.waitForTimeout(300);
};

// ── Font tests ──────────────────────────────────────────

test("font: select shows default font with 2 options on first load", async () => {
  const { app, window } = await launchApp();
  await openSettingsTab(window, "font");

  await expect(window.locator("#font-select")).toBeVisible();
  const optionCount = await window.locator("#font-select option").count();
  expect(optionCount).toBe(2);

  // Default value is the first option (YaHei)
  const defaultValue = await window
    .locator("#font-select")
    .evaluate((el) => el.options[el.selectedIndex].value);
  expect(defaultValue).toContain("Microsoft YaHei");

  // --chat-font CSS var is set to the default on documentElement
  const cssVar = await window.evaluate(() =>
    document.documentElement.style.getPropertyValue("--chat-font")
  );
  expect(cssVar).toContain("Microsoft YaHei");

  await closeApp(app);
});

test("font: changing font updates localStorage and --chat-font CSS var", async () => {
  const { app, window } = await launchApp();
  await openSettingsTab(window, "font");

  // Pick the second option (Serif)
  const serifValue = await window
    .locator("#font-select option")
    .nth(1)
    .getAttribute("value");
  expect(serifValue).toContain("Noto Serif");
  await window.locator("#font-select").selectOption(serifValue);
  await window.waitForTimeout(200);

  // localStorage updated
  const stored = await window.evaluate(() =>
    localStorage.getItem("AideAgent_font")
  );
  expect(stored).toBe(serifValue);

  // CSS var updated
  const cssVar = await window.evaluate(() =>
    document.documentElement.style.getPropertyValue("--chat-font")
  );
  expect(cssVar).toBe(serifValue);

  await closeApp(app);
});

test("font: choice persists across reload", async () => {
  const { app, window } = await launchApp();
  await openSettingsTab(window, "font");

  // Change to serif
  const serifValue = await window
    .locator("#font-select option")
    .nth(1)
    .getAttribute("value");
  await window.locator("#font-select").selectOption(serifValue);
  await window.waitForTimeout(200);

  // Reload (do NOT clear localStorage this time)
  await window.reload();
  await window.waitForLoadState("domcontentloaded", { timeout: 10_000 });
  await window.waitForTimeout(500);

  // localStorage survived
  const stored = await window.evaluate(() =>
    localStorage.getItem("AideAgent_font")
  );
  expect(stored).toBe(serifValue);

  // CSS var survived (font-settings module re-applies on init)
  const cssVar = await window.evaluate(() =>
    document.documentElement.style.getPropertyValue("--chat-font")
  );
  expect(cssVar).toBe(serifValue);

  // The select shows the persisted value too
  await openSettingsTab(window, "font");
  const currentValue = await window
    .locator("#font-select")
    .evaluate((el) => el.value);
  expect(currentValue).toBe(serifValue);

  await closeApp(app);
});

// ── Language tests ──────────────────────────────────────

test("lang: select shows zh by default on first load", async () => {
  const { app, window } = await launchApp();

  // The lang-select lives inside the language panel
  await openSettingsTab(window, "language");
  await expect(window.locator("#lang-select")).toBeVisible();

  // Default is zh
  const currentLang = await window
    .locator("#lang-select")
    .evaluate((el) => el.value);
  expect(currentLang).toBe("zh");

  // Modal title is in Chinese (settings.title → "设置")
  const titleZh = await window.evaluate(() =>
    document.querySelector('[data-i18n="settings.title"]')?.textContent?.trim()
  );
  expect(titleZh).toBe("设置");

  await closeApp(app);
});

test("lang: changing to en updates data-i18n text to English", async () => {
  const { app, window } = await launchApp();
  await openSettingsTab(window, "language");

  // Sanity: starts in zh
  expect(
    await window.locator("#lang-select").evaluate((el) => el.value)
  ).toBe("zh");

  // Change to en
  await window.locator("#lang-select").selectOption("en");
  await window.waitForTimeout(200);

  // localStorage updated
  const stored = await window.evaluate(() =>
    localStorage.getItem("AideAgent_lang")
  );
  expect(stored).toBe("en");

  // applyLang ran: settings.title is now "Settings"
  const titleEn = await window.evaluate(() =>
    document.querySelector('[data-i18n="settings.title"]')?.textContent?.trim()
  );
  expect(titleEn).toBe("Settings");

  // And the language panel label switched too (lang.interface → "Interface Language")
  const labelEn = await window.evaluate(() =>
    document.querySelector('[data-i18n="lang.interface"]')?.textContent?.trim()
  );
  expect(labelEn).toBe("Interface Language");

  await closeApp(app);
});

test("lang: choice persists across reload", async () => {
  const { app, window } = await launchApp();
  await openSettingsTab(window, "language");
  await window.locator("#lang-select").selectOption("en");
  await window.waitForTimeout(200);

  // Reload without clearing localStorage
  await window.reload();
  await window.waitForLoadState("domcontentloaded", { timeout: 10_000 });
  await window.waitForTimeout(500);

  // Title should be in English after reload (applyLang ran on init)
  const titleEn = await window.evaluate(() =>
    document.querySelector('[data-i18n="settings.title"]')?.textContent?.trim()
  );
  expect(titleEn).toBe("Settings");

  // Open the language tab to check the select
  await openSettingsTab(window, "language");
  const currentLang = await window
    .locator("#lang-select")
    .evaluate((el) => el.value);
  expect(currentLang).toBe("en");

  await closeApp(app);
});
