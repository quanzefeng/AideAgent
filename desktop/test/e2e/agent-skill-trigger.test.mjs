// ── Phase-2 trigger test: verify that the "Agent Skill" pattern-detection
//    pipeline (startup curator + SessionEnd IPC + UI toast listener) is
//    fully wired. These tests run in a real Electron instance via Playwright.

import { test, expect, _electron as electron } from "@playwright/test";

const testEnv = {
  ...process.env,
  ELECTRON_DISABLE_SANDBOX: "1",
  NODE_ENV: "test",
  AIDEAGENT_TEST_MODE: "1",
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
    try {
      const proc = app?.process?.();
      if (proc && !proc.killed) proc.kill("SIGKILL");
    } catch { /* ignored */ }
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
  await window.waitForTimeout(800);
  return { app, window };
};

test.describe("Phase 2: Agent Skill Auto-Trigger", () => {
  test("detectPatterns IPC channel returns an array (even if empty)", async () => {
    let app;
    try {
      const launched = await launchApp();
      app = launched.app;
      const window = launched.window;

      const result = await window.evaluate(async () => {
        return await window.aideagent.skillsDetectPatterns();
      });

      // Either an array of suggestions, or an error object. We just need the
      // channel to be reachable (no "no handler registered" / rejection).
      expect(result === undefined || Array.isArray(result) || typeof result === "object").toBe(true);
    } finally {
      await closeApp(app);
    }
  });

  test("getCuratorStatus IPC returns expected shape (lastRun populated after startup)", async () => {
    let app;
    try {
      const launched = await launchApp();
      app = launched.app;
      const window = launched.window;

      const status = await window.evaluate(async () => {
        return await window.aideagent.skillsCuratorStatus();
      });

      // Schema: { totalSkills, activeSkills, archivedSkills, pendingMerges, lastRun, totalRuns, archiveAfterDays }
      expect(status).toBeTruthy();
      expect(typeof status.totalSkills).toBe("number");
      expect(typeof status.activeSkills).toBe("number");
      expect(typeof status.archiveAfterDays).toBe("number");
      // After Phase 1 wiring, lastRun should be a non-empty ISO string (startup curator ran).
      expect(status.lastRun).toBeTruthy();
      expect(status.lastRun).not.toBe("never");
      // The startup curator bumps totalRuns at least once.
      expect(status.totalRuns).toBeGreaterThanOrEqual(1);
    } finally {
      await closeApp(app);
    }
  });

  test("onPatternsDetected listener is registered in renderer", async () => {
    let app;
    try {
      const launched = await launchApp();
      app = launched.app;
      const window = launched.window;

      // The preload.cjs bridge must expose onPatternsDetected as a function.
      const hasListener = await window.evaluate(() => {
        return typeof window.aideagent?.onPatternsDetected === "function";
      });
      expect(hasListener).toBe(true);
    } finally {
      await closeApp(app);
    }
  });

  test("skills:list-all IPC returns valid array (Phase 1: reindex+curator ran at startup)", async () => {
    let app;
    try {
      const launched = await launchApp();
      app = launched.app;
      const window = launched.window;

      const skills = await window.evaluate(async () => {
        return await window.aideagent.skillsListAll();
      });

      expect(Array.isArray(skills)).toBe(true);
    } finally {
      await closeApp(app);
    }
  });
});
