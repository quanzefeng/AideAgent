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

const openMemoryTab = async (window) => {
  await window.locator("#settings-btn").click();
  await window.waitForTimeout(400);
  const modalActive = await window.evaluate(
    () => document.getElementById("settings-modal")?.classList.contains("active")
  );
  if (!modalActive) throw new Error("settings modal did not open");
  await window.locator('#settings-modal [data-tab="memory"]').click();
  await window.waitForTimeout(500);
};

test("memory: tab opens with empty list or list container", async () => {
  let app, window;
  try {
    ({ app, window } = await launchApp());
    await openMemoryTab(window);

    const listExists = await window.evaluate(() => {
      const list = document.getElementById("memory-list");
      return !!list;
    });
    expect(listExists).toBe(true);

    const listVisible = await window.evaluate(() => {
      const list = document.getElementById("memory-list");
      if (!list) return false;
      const style = window.getComputedStyle(list);
      return style.display !== "none" && style.visibility !== "hidden";
    });
    expect(listVisible).toBe(true);

    const createBtnVisible = await window.evaluate(() => {
      const btn = document.getElementById("memory-new-btn");
      if (!btn) return false;
      const style = window.getComputedStyle(btn);
      return style.display !== "none" && style.visibility !== "hidden";
    });
    expect(createBtnVisible).toBe(true);
  } finally {
    await closeApp(app);
  }
});

test("memory: IPC memoryCreate and memoryListAll work", async () => {
  let app, window;
  try {
    ({ app, window } = await launchApp());
    await openMemoryTab(window);

    const testName = "test_memory_" + Date.now();
    const testBody = "This is test memory content";
    const createResult = await window.evaluate(async ({name, body}) => {
      return await window.aideagent.memoryCreate(name, "test desc", "project", body);
    }, {name: testName, body: testBody});
    expect(createResult).toHaveProperty("filename");

    await window.waitForTimeout(300);

    const listResult = await window.evaluate(async () => {
      return await window.aideagent.memoryListAll();
    });
    expect(Array.isArray(listResult)).toBe(true);

    const found = listResult.some(
      (m) => m.name === testName
    );
    expect(found).toBe(true);
  } finally {
    await closeApp(app);
  }
});

test("memory: IPC memoryDelete works", async () => {
  let app, window;
  try {
    ({ app, window } = await launchApp());
    await openMemoryTab(window);

    const testName = "delete_test_" + Date.now();
    const createResult = await window.evaluate(async (name) => {
      return await window.aideagent.memoryCreate(name, "to delete", "project", "delete me");
    }, testName);
    expect(createResult).toHaveProperty("filename");
    const filename = createResult.filename;

    await window.waitForTimeout(300);

    const deleteResult = await window.evaluate(async (f) => {
      return await window.aideagent.memoryDelete(f);
    }, filename);
    expect(deleteResult).toEqual({ ok: true });

    await window.waitForTimeout(300);

    const listResult = await window.evaluate(async () => {
      return await window.aideagent.memoryListAll();
    });
    const found = listResult.some((m) => m.filename === filename);
    expect(found).toBe(false);
  } finally {
    await closeApp(app);
  }
});

test("memory: create button is clickable", async () => {
  let app, window;
  try {
    ({ app, window } = await launchApp());
    await openMemoryTab(window);

    const initialCount = await window.evaluate(() => {
      return document.querySelectorAll(".memory-item").length;
    });

    await window.locator("#memory-new-btn").click();
    await window.waitForTimeout(300);

    const editorVisible = await window.evaluate(() => {
      const editor = document.getElementById("memory-editor-panel");
      if (!editor) return false;
      const style = window.getComputedStyle(editor);
      return style.display !== "none" && style.visibility !== "hidden";
    });

    const newCount = await window.evaluate(() => {
      return document.querySelectorAll(".memory-item").length;
    });

    const didSomething = editorVisible || newCount > initialCount;
    expect(didSomething).toBe(true);
  } finally {
    await closeApp(app);
  }
});
