// ── Session Info ──────────────────────────────────────────
//
// Aggregated snapshot of EVERYTHING the user might ask "how is my
// AideAgent configured" questions about. Used by the `get_session_info`
// tool so the AI doesn't have to guess — it just calls the tool.
//
// Architecture:
//   - Renderer pushes its localStorage state via `session-info:update` IPC
//     (wrapped automatically by `installLocalStorageHook` in the
//     renderer-side session-info.mjs).
//   - Main reads file-based configs fresh on each call (cheap, ensures
//     no stale data after disk edits by other tools).
//   - `getSessionInfo(args)` returns a merged object. Optional `keys`
//     param filters to specific top-level sections (e.g. `["api",
//     "workspace"]`) to keep tool output small for narrow questions.
//
// SECURITY: This module NEVER returns API key values. Only "key is
// configured for provider X" booleans. Encrypted key files are
// readable in principle but reading them is a no-op (DPAPI-encrypted
// blob — useless to the model). The `~/.aideagent/api-keys.enc`
// path is intentionally not enumerated here.

import { existsSync, readFileSync, statSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir, platform, arch, release } from "node:os";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

/* ── Module state ──────────────────────────────────────── */

/** @type {object | null} Latest snapshot pushed from the renderer. */
let _rendererSnapshot = null;

/**
 * Test hooks. Production code never calls these.
 * @param {object} overrides
 */
export function _setTestPaths(overrides) {
  Object.assign(_testPaths, overrides);
}
const _testPaths = {};

/**
 * Resolve the home directory (`~/.aideagent/` parent). Injected in tests
 * to use a temp dir.
 */
function _homedir() {
  return _testPaths.homedir || homedir();
}

/**
 * Resolve the Electron userData dir (where workspace-config.json,
 * mcp-servers.json, system-prompt-profiles.json live).
 * Lazy-imports `electron` so this module can be `require`d in tests
 * that don't have Electron loaded — if electron isn't available we
 * return null and the file-based sections are simply omitted.
 */
function _userDataDir() {
  if (_testPaths.userData) return _testPaths.userData;
  try {
    const { app } = require("electron");
    return app.getPath("userData");
  } catch {
    return null;
  }
}

/**
 * Push the latest renderer snapshot. Called from the
 * `session-info:update` IPC handler.
 * @param {object} snapshot
 */
export function setRendererSnapshot(snapshot) {
  _rendererSnapshot = snapshot;
}

/** @returns {object | null} */
export function getRendererSnapshot() {
  return _rendererSnapshot;
}

/* ── File readers (pure, testable) ─────────────────────── */

function safeReadJson(path) {
  try {
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return null;
  }
}

function readWorkspace() {
  const dir = _userDataDir();
  if (!dir) return null;
  return safeReadJson(join(dir, "workspace-config.json"));
}

function readKbConfig() {
  return safeReadJson(join(_homedir(), ".aideagent", "kb-config.json"));
}

function readMcpConfig() {
  const dir = _userDataDir();
  if (!dir) return null;
  const raw = safeReadJson(join(dir, "mcp-servers.json"));
  if (!raw) return null;
  // Summarize: server count + names + builtins. Don't dump every env var.
  const servers = raw.servers || {};
  return {
    serverCount: Object.keys(servers).length,
    serverNames: Object.keys(servers),
    builtins: raw.builtins || {},
  };
}

function readSystemPromptProfile() {
  const dir = _userDataDir();
  if (!dir) return null;
  const raw = safeReadJson(join(dir, "system-prompt-profiles.json"));
  if (!raw) return null;
  return {
    activeProfile: raw.activeProfile || null,
    profileCount: Object.keys(raw.profiles || {}).length,
    profileNames: Object.keys(raw.profiles || {}),
  };
}

function readMemorySummary() {
  const dir = join(_homedir(), ".aideagent", "memory");
  if (!existsSync(dir)) return { dir, fileCount: 0, totalBytes: 0, files: [] };
  let files;
  try { files = readdirSync(dir).filter((f) => f.endsWith(".md")); }
  catch { return { dir, fileCount: 0, totalBytes: 0, files: [] }; }
  let total = 0;
  const details = [];
  for (const f of files) {
    try {
      const st = statSync(join(dir, f));
      total += st.size;
      details.push({ name: f, size: st.size });
    } catch { /* ignore */ }
  }
  details.sort((a, b) => b.size - a.size);
  return { dir, fileCount: files.length, totalBytes: total, files: details };
}

function readSkillsSummary() {
  const root = join(_homedir(), ".aideagent", "skills");
  if (!existsSync(root)) {
    return { dir: root, agentManaged: 0, archived: 0, list: [] };
  }
  let entries;
  try { entries = readdirSync(root, { withFileTypes: true }); }
  catch { return { dir: root, agentManaged: 0, archived: 0, list: [] }; }
  let agentManaged = 0;
  let archived = 0;
  const list = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    if (e.name === "_archive") {
      try {
        archived = readdirSync(join(root, "_archive"))
          .filter((x) => {
            try { return statSync(join(root, "_archive", x)).isDirectory(); }
            catch { return false; }
          }).length;
      } catch { archived = 0; }
      continue;
    }
    agentManaged++;
    const skillMd = join(root, e.name, "SKILL.md");
    if (existsSync(skillMd)) {
      try {
        const content = readFileSync(skillMd, "utf-8");
        const name = (content.match(/^name:\s*(.+)$/m) || [])[1]?.trim();
        const desc = (content.match(/^description:\s*(.+)$/m) || [])[1]?.trim();
        list.push({
          dir: e.name,
          name: name || e.name,
          description: desc ? desc.slice(0, 120) : null,
        });
      } catch { /* ignore */ }
    }
  }
  return { dir: root, agentManaged, archived, list };
}

/* ── Public API ────────────────────────────────────────── */

/**
 * Return the current AideAgent session info. The merged shape:
 *
 *   {
 *     runtime: "aide" | "opencode",                   // (renderer)
 *     api:      { provider, model, apiUrl, apiFormat },  // (renderer, if aide)
 *     appearance: { lang, theme_preset, theme_accent, font, font_weights },
 *     identity:   { agent_name, user_name, has_user_avatar },
 *     toggles:    { reasoning_enabled, search_provider },
 *     workspace:  { current: "/abs/path" } | null,
 *     kb:         { vaultPath, provider, ... } | null,
 *     mcp:        { serverCount, serverNames, builtins } | null,
 *     system_prompt: { activeProfile, profileCount, profileNames } | null,
 *     memory:     { fileCount, totalBytes, files: [{name, size}] },
 *     skills:     { agentManaged, archived, list: [{dir, name, description}] },
 *     paths:      { aideagent_dir, user_data_dir },
 *     app:        { version, platform, arch, electron, node },
 *   }
 *
 * @param {object} [args]
 * @param {string[]} [args.keys] Top-level keys to return. Default: all.
 * @returns {object}
 */
export function getSessionInfo(args = {}) {
  const requested = Array.isArray(args.keys) && args.keys.length > 0
    ? new Set(args.keys)
    : null;

  const all = {
    runtime: _rendererSnapshot?.runtime || "aide",
    api: _rendererSnapshot?.api || null,
    appearance: _rendererSnapshot?.appearance || null,
    identity: _rendererSnapshot?.identity || null,
    toggles: _rendererSnapshot?.toggles || null,
    workspace: readWorkspace(),
    kb: readKbConfig(),
    mcp: readMcpConfig(),
    system_prompt: readSystemPromptProfile(),
    memory: readMemorySummary(),
    skills: readSkillsSummary(),
    paths: {
      aideagent_dir: join(_homedir(), ".aideagent"),
      user_data_dir: _userDataDir(),
    },
    app: {
      version: pkgVersion(),
      platform: platform(),
      arch: arch(),
      node: process.version,
      os_release: release(),
    },
  };

  if (!requested) return all;

  const filtered = {};
  for (const k of requested) if (k in all) filtered[k] = all[k];
  return {
    requested: [...requested],
    found: Object.keys(filtered),
    missing: [...requested].filter((k) => !(k in all)),
    data: filtered,
  };
}

let _pkgVersion = null;
function pkgVersion() {
  if (_pkgVersion !== null) return _pkgVersion;
  try {
    const pkg = JSON.parse(
      readFileSync(join(__dirname, "..", "package.json"), "utf-8")
    );
    _pkgVersion = pkg.version || "unknown";
  } catch {
    _pkgVersion = "unknown";
  }
  return _pkgVersion;
}