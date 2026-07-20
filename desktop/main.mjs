// ── AideAgent — Main Entry Point ────────────────────────────
// Thin entry: app lifecycle + window creation + module wiring.
// All business logic lives in core/*.mjs modules.

/** @typedef {{ name: string, fn: () => void | Promise<void> }} ShutdownEntry */
/** @type {{ curatorTimer?: NodeJS.Timeout | null }} */
const _aideagentInternal = (/** @type {any} */ (globalThis)).__aideagentInternal ?? {};
(/** @type {any} */ (globalThis)).__aideagentInternal = _aideagentInternal;

import { app, BrowserWindow, session, Menu, nativeImage } from "electron";
import { join } from "node:path";
import mcpManager from "./mcp-manager.mjs";
import lspManager from "./lsp-manager.mjs";
import sessionDb from "./session-db.mjs";
import * as skills from "./skills-store.mjs";
import * as kb from "./knowledge-store.mjs";

import { setMainWindow, PROJECT_ROOT, initWorkspaceFromConfig, sendToRenderer, getMainWindow } from "./core/state.mjs";
import { registerIpcHandlers } from "./core/ipc-handlers.mjs";
import { registerWechatIpc, autoStartWechat } from "./core/wechat-bridge.mjs";
import { initUpdateManager } from "./update-manager.mjs";

const isDev = process.argv.includes("--dev");

app.commandLine.appendSwitch("no-sandbox");

// ── Global error handlers ──────────────────────────────────
// Without these, any uncaught throw or unhandled promise rejection in the
// main process kills the Electron app, taking the long-running agent loop
// (and its in-flight turn state) with it. The user has to force-quit and
// restart — losing the working session mid-task. Log, notify the renderer,
// and stay alive.
process.on("uncaughtException", (err) => {
  console.error("[main] uncaughtException:", err?.stack || err);
  try {
    sendToRenderer("stream:error", { message: `[main] 未捕获异常: ${err?.message || err}` });
  } catch { /* renderer may be gone */ }
});
process.on("unhandledRejection", (reason) => {
  const err = reason instanceof Error ? reason : new Error(String(reason));
  console.error("[main] unhandledRejection:", err.stack || err);
  try {
    sendToRenderer("stream:error", { message: `[main] 后台任务异常: ${err.message}` });
  } catch { /* renderer may be gone */ }
});

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

  // Maximize after creation — more reliable than `maximize: true` in options on Windows
  mainWindow.maximize();

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

  // Skills (L2) startup wiring is handled later in this callback (line ~144):
  // reindexSkills() + runCurator() + 6h periodic interval. No need to duplicate.

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

  // ── KB startup sync ──────────────────────────────────────────
  // Scan vault and reindex any new/changed files since last shutdown.
  // Without this, files dropped into the vault while the app was closed
  // (or files the fs.watch watcher missed) would never get indexed until
  // the user manually clicks "重建索引". This is a lightweight mtime diff,
  // NOT a full rebuild — only changed files get re-extracted + re-embedded.
  if (!isTestMode) {
    try {
      const vault = kb.getVault();
      if (vault) {
        // Start the watcher first so future changes are caught live.
        // startWatcher is synchronous (returns { ok, error }); wrap in try/catch
        // instead of `.catch()` which doesn't exist on plain objects.
        try {
          const res = kb.startWatcher();
          if (res && res.error && res.error !== "already watching") {
            console.warn("[kb] watcher start:", res.error);
          }
        } catch (e) {
          console.error("[kb] watcher start:", e.message);
        }
        // Then do a one-time sync to catch anything that changed while offline.
        // Run async — don't block app startup on KB indexing.
        (async () => {
          try {
            const { scanVault } = await import("./kb/vault-scanner.mjs");
            const { reindexSingleFile } = await import("./kb/indexer.mjs");
            const { getDb } = await import("./kb/db.mjs");
            const db = getDb();
            const files = await scanVault(vault, vault);
            let newCount = 0, updatedCount = 0;
            for (const file of files) {
              const row = db.prepare("SELECT mtime_ms FROM kb_notes WHERE rel_path = ?").get(file.relPath);
              if (!row) { await reindexSingleFile(file.relPath); newCount++; }
              else if (Number(row.mtime_ms) !== file.mtimeMs) { await reindexSingleFile(file.relPath); updatedCount++; }
            }
            // Remove notes whose files no longer exist
            const indexed = db.prepare("SELECT rel_path FROM kb_notes").all();
            const existingPaths = new Set(files.map((f) => f.relPath));
            for (const row of indexed) {
              if (!existingPaths.has(String(row.rel_path))) {
                const nr = db.prepare("SELECT id FROM kb_notes WHERE rel_path = ?").get(String(row.rel_path));
                if (nr) {
                  db.prepare("DELETE FROM kb_chunks WHERE note_id = ?").run(Number(nr.id));
                  db.prepare("DELETE FROM kb_notes WHERE rel_path = ?").run(String(row.rel_path));
                }
              }
            }
            if (newCount > 0 || updatedCount > 0) {
              console.log(`[kb-startup] synced: ${newCount} new, ${updatedCount} updated`);
            }
          } catch (/** @type {any} */ e) {
            console.error("[kb-startup] sync error:", e.message);
          }
        })();
      }
    } catch (/** @type {any} */ e) {
      console.error("[kb-startup] init error:", e.message);
    }
  }

  const CURATOR_INTERVAL = 6 * 60 * 60 * 1000;
  const curatorTimer = setInterval(() => {
    try { const r = skills.runCurator(); if (r.archived > 0) console.log(`[curator] archived ${r.archived} stale skills`); }
    catch (/** @type {any} */ e) { console.error("[curator] periodic run failed:", e.message); }
  }, CURATOR_INTERVAL);
  // Make the curator timer unref()'d so it never blocks app exit, and
  // remember the handle so will-quit can clearInterval() it explicitly.
  // (unref alone is enough for tests; clearInterval is the belt-and-suspenders
  //  for production exits where a shutdown might fire before the next tick.)
  if (typeof curatorTimer.unref === "function") curatorTimer.unref();
  _aideagentInternal.curatorTimer = curatorTimer;

  // ── Register shutdown hooks (run on before-quit) ──
  // MCP: stop all npx children so they don't outlive the app
  addShutdownFn("mcp", () => mcpManager.shutdown());
  // WeChat: abort the poll loop
  addShutdownFn("wechat", async () => {
    const { getWxPollAbort } = await import("./core/state.mjs");
    const c = /** @type {AbortController | null | undefined} */ (getWxPollAbort());
    if (c) {
      try { c.abort(); } catch { /* already aborted */ }
    }
  });
  // KB: stop the file watcher
  addShutdownFn("kb-watcher", async () => {
    const ks = await import("./knowledge-store.mjs");
    try { ks.stopWatcher(); } catch { /* not watching — fine */ }
  });
  // KB SQLite: close the handle so WAL is checkpointed
  addShutdownFn("kb-db", async () => {
    const { closeDb } = await import("./kb/db.mjs");
    try { closeDb(); } catch { /* ignored */ }
  });
  // Memory: close FTS DB
  addShutdownFn("memory-db", async () => {
    const ms = await import("./memory-store.mjs");
    try { ms.closeFtsDb(); } catch { /* ignored */ }
  });
  // OpenCode ACP: stop the cached subprocess if any
  addShutdownFn("opencode-acp", async () => {
    const { getOpencodeAcpClient, setOpencodeAcpClient } = await import("./core/state.mjs");
    const c = getOpencodeAcpClient();
    if (c) {
      try { await c.stop(); } catch { /* already dead */ }
      setOpencodeAcpClient(null);
    }
  });
  // Skills curator: clear the interval
  addShutdownFn("skills-curator", () => {
    if (_aideagentInternal.curatorTimer) {
      try { clearInterval(_aideagentInternal.curatorTimer); } catch { /* ignored */ }
      _aideagentInternal.curatorTimer = null;
    }
  });
  // LSP: kill TS language server subprocesses
  addShutdownFn("lsp", () => lspManager.shutdown());
  // Session DB (was the only one in the original handler)
  addShutdownFn("session-db", () => { try { sessionDb.close(); } catch { /* ignored */ } });

  // Register all IPC handlers
  registerIpcHandlers();
  registerWechatIpc();
  if (!isTestMode) {
    autoStartWechat();
  }
});

app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });

/**
 * Comprehensive will-quit cleanup. Each module is responsible for its own
 * teardown (see addShutdownFn below); this handler just orchestrates.
 *
 * Without this, every restart leaks:
 *   - npx MCP server children (file locks on Windows)
 *   - the WeChat poll loop
 *   - the KB fs.watch handle
 *   - the opencode ACP subprocess
 *   - SQLite WAL journals for memory + KB DBs
 *   - the skills curator interval
 *
 * `before-quit` is preferred over `will-quit` because it fires before the
 * renderer is destroyed, giving async cleanup a chance to finish.
 */
/** @type {Array<{ name: string, fn: () => void | Promise<void> }>} */
const _shutdownFns = [];
/**
 * Register a cleanup function. Errors are caught and logged so one
 * failing shutdown doesn't block the rest.
 * @param {string} name
 * @param {() => void | Promise<void>} fn
 */
function addShutdownFn(name, fn) {
  _shutdownFns.push({ name, fn });
}
(/** @type {any} */ (globalThis)).__aideagentAddShutdownFn = addShutdownFn;

app.on("before-quit", () => {
  // Run shutdowns in parallel where possible. The shutdown functions are
  // best-effort — each one swallows its own errors. We give the whole
  // process up to 3s to finish, then return and let Electron close anyway
  // (a 30s orphan npx is better than a hung shutdown).
  const all = _shutdownFns.map(async (entry) => {
    try { await entry.fn(); }
    catch (/** @type {any} */ e) {
      console.error(`[shutdown] ${entry.name} failed:`, e?.message || e);
    }
  });
  // Block before-quit for up to 3 seconds. Returning a Promise that
  // resolves later doesn't actually delay quit in Electron, so this is
  // best-effort fire-and-forget.
  Promise.allSettled(all).catch(() => {});
  // Belt-and-suspenders: hard-kill any process we missed after 3s.
  setTimeout(() => {
    try { process.exit(0); } catch { /* already gone */ }
  }, 3000).unref?.();
});
