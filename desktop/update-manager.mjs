// ── Update Manager — electron-updater wrapper ──────────────

import electronUpdater from "electron-updater";
const { autoUpdater } = electronUpdater;
import { ipcMain, app } from "electron";
import { sendToRenderer } from "./core/state.mjs";

let _mainWindow = null;
let _checking = false;

export function initUpdateManager(/** @type {any} */ win) {
  _mainWindow = win;

  // Configure autoUpdater
  // Fix 6a: autoDownload = false so users get a "Download now" prompt before
  // ~200MB silently starts on metered connections. The renderer is now
  // responsible for calling `update:download` IPC after the user clicks.
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;
  // Fix 1: route autoUpdater logs through console (was `null` — killed all
  // diagnostic output for "update failed" reports). Use electron-log in prod
  // if console volume becomes a concern.
  autoUpdater.logger = console;

  // Helper: safely clear the OS-level progress indicator on the dock/taskbar.
  // `setProgressBar(-1)` removes the bar; we gate on isDestroyed() so an update
  // event that fires after window close doesn't crash the main process.
  const clearOsProgress = () => {
    if (_mainWindow && !_mainWindow.isDestroyed()) {
      _mainWindow.setProgressBar(-1);
    }
  };

  // Wire autoUpdater events → renderer
  autoUpdater.on("checking-for-update", () => {
    sendToRenderer("update:status", { status: "checking" });
  });

  autoUpdater.on("update-available", (info) => {
    // The "skipped" flag is set below in the update:skip IPC handler; if
    // the user already skipped THIS exact version in this session, we still
    // emit "available" (so the settings panel can show the version notes)
    // but with `skipped: true` so the toast stays quiet.
    const skipped = info.version === _skippedVersion;
    sendToRenderer("update:status", {
      status: "available",
      version: info.version,
      releaseNotes: info.releaseNotes || "",
      skipped,
    });
  });

  autoUpdater.on("update-not-available", () => {
    sendToRenderer("update:status", { status: "not-available" });
    clearOsProgress();
  });

  autoUpdater.on("download-progress", (info) => {
    sendToRenderer("update:progress", {
      percent: info.percent,
      bytesPerSecond: info.bytesPerSecond,
      transferred: info.transferred,
      total: info.total,
    });
    // Fix 4: sync dock/taskbar progress indicator (visible from every screen,
    // not just the Settings → About panel). electron-updater v6 has known
    // bugs where download-progress may skip events on differential / cached
    // downloads — the bar will jump, but that's better than no signal at all.
    if (_mainWindow && !_mainWindow.isDestroyed()) {
      _mainWindow.setProgressBar(info.percent / 100);
    }
  });

  autoUpdater.on("update-downloaded", (info) => {
    sendToRenderer("update:status", {
      status: "downloaded",
      version: info.version,
    });
    clearOsProgress();
  });

  autoUpdater.on("error", (err) => {
    sendToRenderer("update:status", {
      status: "error",
      message: err.message || String(err),
    });
    _checking = false;
    clearOsProgress();
  });

  // ── IPC Handlers ──────────────────────────────────────────

  ipcMain.handle("update:get-version", () => {
    return app.getVersion();
  });

  ipcMain.handle("update:check", async () => {
    if (_checking) return { ok: true, note: "already checking" };
    _checking = true;
    try {
      await autoUpdater.checkForUpdates();
    } catch (/** @type {any} */ err) {
      sendToRenderer("update:status", {
        status: "error",
        message: err.message || String(err),
      });
    } finally {
      // Fix 2: guarantee _checking resets even if `autoUpdater.checkForUpdates()`
      // rejects asynchronously outside the try-catch (e.g. via a downstream
      // event-handler throw), preventing future checks from being blocked.
      _checking = false;
    }
    return { ok: true };
  });

  ipcMain.handle("update:install", () => {
    autoUpdater.quitAndInstall();
  });

  // Fix 6b: renderer-driven download trigger. With autoDownload=false the
  // user must explicitly approve the download via toast or settings panel.
  ipcMain.handle("update:download", async () => {
    try {
      await autoUpdater.downloadUpdate();
      return { ok: true };
    } catch (/** @type {any} */ err) {
      sendToRenderer("update:status", {
        status: "error",
        message: err.message || String(err),
      });
      return { ok: false, error: err.message || String(err) };
    }
  });

  // Fix 7: skip a specific version. Pure metadata — we just remember the
  // skipped version in memory and re-emit "available" status with a
  // `skipped: true` flag so the renderer can hide the toast. The renderer's
  // localStorage is the source of truth across sessions; this in-memory
  // mirror is a fast-path so an in-flight check during the same session
  // doesn't re-prompt after the user just clicked skip.
  let _skippedVersion = null;
  ipcMain.handle("update:skip", (_e, version) => {
    if (typeof version === "string" && version) {
      _skippedVersion = version;
    }
    return { ok: true, skipped: _skippedVersion };
  });
}
