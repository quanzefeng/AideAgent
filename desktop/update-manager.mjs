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
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.logger = null; // disable default logger

  // Wire autoUpdater events → renderer
  autoUpdater.on("checking-for-update", () => {
    sendToRenderer("update:status", { status: "checking" });
  });

  autoUpdater.on("update-available", (info) => {
    sendToRenderer("update:status", {
      status: "available",
      version: info.version,
      releaseNotes: info.releaseNotes || "",
    });
  });

  autoUpdater.on("update-not-available", () => {
    sendToRenderer("update:status", { status: "not-available" });
  });

  autoUpdater.on("download-progress", (info) => {
    sendToRenderer("update:progress", {
      percent: info.percent,
      bytesPerSecond: info.bytesPerSecond,
      transferred: info.transferred,
      total: info.total,
    });
  });

  autoUpdater.on("update-downloaded", (info) => {
    sendToRenderer("update:status", {
      status: "downloaded",
      version: info.version,
    });
  });

  autoUpdater.on("error", (err) => {
    sendToRenderer("update:status", {
      status: "error",
      message: err.message || String(err),
    });
    _checking = false;
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
    }
    _checking = false;
    return { ok: true };
  });

  ipcMain.handle("update:install", () => {
    autoUpdater.quitAndInstall();
  });
}
