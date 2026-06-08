// ── AideAgent — Main Entry Point ────────────────────────────
// Thin entry: app lifecycle + window creation + module wiring.
// All business logic lives in core/*.mjs modules.

import { app, BrowserWindow, session, Menu, nativeImage } from "electron";
import { join } from "node:path";
import mcpManager from "./mcp-manager.mjs";
import sessionDb from "./session-db.mjs";
import * as skills from "./skills-store.mjs";

import { setMainWindow, PROJECT_ROOT, initWorkspaceFromConfig } from "./core/state.mjs";
import { registerIpcHandlers } from "./core/ipc-handlers.mjs";
import { registerWechatIpc, autoStartWechat } from "./core/wechat-bridge.mjs";
import { initUpdateManager } from "./update-manager.mjs";

const isDev = process.argv.includes("--dev");

app.commandLine.appendSwitch("no-sandbox");

// ── Window Management ──────────────────────────────────────

function createWindow() {
  const preloadPath = join(PROJECT_ROOT, "preload.cjs").replace(/\\/g, "/");
  console.log("[main] preload path:", preloadPath);

  try {
    if (session?.defaultSession?.registerPreloadScript) {
      session.defaultSession.registerPreloadScript({ type: "frame", filePath: preloadPath });
      console.log("[main] registerPreloadScript called (global)");
    }
  } catch (/** @type {any} */ e) {
    console.error("[main] session preload registration error:", e.message);
  }

  const mainWindow = new BrowserWindow({
    width: 1200, height: 800,
    minWidth: 800, minHeight: 600,
    title: "AI Code Chat",
    icon: nativeImage.createFromPath(join(PROJECT_ROOT, "icon.ico")),
    backgroundColor: "#0a0a0f",
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      sandbox: false,
      webSecurity: true,
    },
  });

  Menu.setApplicationMenu(null);

  mainWindow.webContents.on("preload-error", (event, preloadPath, error) => {
    console.error("[main] PRELOAD ERROR:", preloadPath, error.message);
  });

  mainWindow.webContents.on("did-finish-load", () => {
    mainWindow.webContents.executeJavaScript("typeof window.aideagent !== 'undefined'").then((hasAPI) => {
      console.log("[main] window.aideagent available in renderer:", hasAPI);
      if (!hasAPI) {
        console.error("[main] PRELOAD FAILED - window.aideagent is undefined!");
      }
    }).catch((err) => {
      console.error("[main] preload verification error:", err.message);
    });
  });

  mainWindow.webContents.on("did-fail-load", (event, errorCode, errorDescription) => {
    console.error("[main] FAIL LOAD:", errorCode, errorDescription);
  });

  mainWindow.loadFile(join(PROJECT_ROOT, "renderer", "index.html"));
  if (isDev) mainWindow.webContents.openDevTools();
  mainWindow.on("closed", () => { setMainWindow(null); });

  setMainWindow(mainWindow);

  // Initialize update manager
  initUpdateManager(mainWindow);
}

// ── App Lifecycle ──────────────────────────────────────────

app.whenReady().then(async () => {
  // ── One-time migration: rename old config dir .goodagent → .aideagent ──
  const { existsSync, renameSync } = await import("node:fs");
  const oldDir = join(app.getPath("home"), ".goodagent");
  const newDir = join(app.getPath("home"), ".aideagent");
  if (existsSync(oldDir) && !existsSync(newDir)) {
    try {
      renameSync(oldDir, newDir);
      console.log("[migration] Renamed ~/.goodagent → ~/.aideagent");
    } catch (/** @type {any} */ e) {
      console.error("[migration] Failed to rename ~/.goodagent → ~/.aideagent:", e.message);
    }
  }

  // Load persisted workspace before window creation so the renderer's
  // first-pick detection sees the right state on first paint.
  initWorkspaceFromConfig();

  createWindow();

  // CORS headers for custom API endpoints
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    const headers = { ...details.responseHeaders };
    headers["access-control-allow-origin"] = ["*"];
    headers["access-control-allow-methods"] = ["GET, POST, PUT, DELETE, OPTIONS"];
    headers["access-control-allow-headers"] = ["Content-Type, Authorization, X-Requested-With"];
    callback({ responseHeaders: headers });
  });

  // ── TEST_MODE 短路：跳过 MCP/WeChat 等慢启动子进程 ──
  // 由 Playwright/手动测试设置 AIDEAGENT_TEST_MODE=1
  // 不启动 MCP（edge-browser 等子进程）和 WeChat bot —— 这俩在 app.quit() 时不会优雅退出
  // 拖住 Playwright worker teardown 30-60s
  const isTestMode = process.env.AIDEAGENT_TEST_MODE === "1";
  if (isTestMode) console.log("[main] TEST_MODE: skipping MCP init + WeChat autostart");

  if (!isTestMode) {
    mcpManager.init().catch(e => console.error("[main] mcpManager.init error:", e.message));
  }

  try { sessionDb.migrateFromJson(join(app.getPath("userData"), "sessions")); } catch { /* ignored */ }

  try {
    const count = sessionDb.listSessions(1000).length;
    console.log("[startup] sessions in DB:", count);
  } catch { /* ignored */ }

  try { const r = skills.runCurator(); if (r.archived > 0) console.log(`[curator] archived ${r.archived} stale skills`); } catch { /* ignored */ }
  try { skills.reindexSkills(); } catch (/** @type {any} */ e) { console.error("[skills-store] reindex:", e.message); }

  const CURATOR_INTERVAL = 6 * 60 * 60 * 1000;
  setInterval(() => {
    try { const r = skills.runCurator(); if (r.archived > 0) console.log(`[curator] archived ${r.archived} stale skills`); }
    catch (/** @type {any} */ e) { console.error("[curator] periodic run failed:", e.message); }
  }, CURATOR_INTERVAL);

  // Register all IPC handlers
  registerIpcHandlers();
  registerWechatIpc();
  if (!isTestMode) {
    autoStartWechat();
  }
});

app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
app.on("will-quit", () => {
  try { sessionDb.close(); } catch { /* ignored */ }
  try {
    import("./lsp-manager.mjs").then(m => m.default.shutdown()).catch(() => {});
  } catch { /* ignored */ }
});
