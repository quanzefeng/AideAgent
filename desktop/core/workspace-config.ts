// ── Workspace Config Persistence ──────────────────────────────
// Stores the user's chosen workspace directory as a small JSON file
// inside Electron's userData folder. Read once on app boot, and
// updated whenever the user picks a new workspace.
//
// File: <userData>/workspace-config.json
// Shape: { "current": "<absolute path>" }
//
// Validates that the persisted path still exists and is a directory
// before returning it; otherwise returns null so the caller can
// fall back to process.cwd() and prompt the user to pick again.

import { app } from "electron";
import { readFileSync, writeFileSync, existsSync, statSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const CONFIG_FILENAME = "workspace-config.json";

function getConfigPath() {
  return join(app.getPath("userData"), CONFIG_FILENAME);
}

/**
 * Load the persisted workspace config. Returns the parsed object
 * if the file exists AND the current path is a valid directory;
 * otherwise returns null (treated as "no workspace chosen yet").
 */
export function loadWorkspaceConfig() {
  try {
    const p = getConfigPath();
    if (!existsSync(p)) return null;
    const raw = readFileSync(p, "utf-8");
    const cfg = JSON.parse(raw);
    if (!cfg || typeof cfg !== "object") return null;
    if (typeof cfg.current !== "string" || !cfg.current) return null;
    // Validate the persisted path still exists and is a directory.
    // If the user moved/deleted the folder, treat as no config and
    // let the caller prompt them to pick again.
    try {
      if (!existsSync(cfg.current)) return null;
      if (!statSync(cfg.current).isDirectory()) return null;
    } catch {
      return null;
    }
    return cfg;
  } catch (/** @type {any} */ e) {
    console.error("[ws-cfg] load failed:", e.message);
    return null;
  }
}

/**
 * Persist the workspace config. Creates the userData directory
 * if it does not exist. Returns { ok: true } on success or
 * { error: <message> } on failure (caller can log/ignore).
 * @param {Object} cfg
 */
export function saveWorkspaceConfig(cfg) {
  try {
    const userData = app.getPath("userData");
    mkdirSync(userData, { recursive: true });
    const p = join(userData, CONFIG_FILENAME);
    writeFileSync(p, JSON.stringify(cfg, null, 2), "utf-8");
    return { ok: true };
  } catch (/** @type {any} */ e) {
    console.error("[ws-cfg] save failed:", e.message);
    return { error: e.message };
  }
}

/**
 * Convenience: returns true if a valid workspace has been
 * persisted. Used by the first-launch picker to decide whether
 * to show the modal.
 */
export function hasPersistedWorkspace() {
  return loadWorkspaceConfig() !== null;
}
