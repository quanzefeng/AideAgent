// ── Shared State for AideAgent Main Process ──────────────────
// All mutable state shared across modules lives here.
// Modules import from this file and mutate the exported objects.

import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";
import { loadWorkspaceConfig, saveWorkspaceConfig } from "./workspace-config.mjs";

export const __dirname = dirname(fileURLToPath(import.meta.url));
export const PROJECT_ROOT = dirname(__dirname);
export const isDev = process.argv.includes("--dev");

// ── Shell Selection (cross-platform) ────────────────────────
// Windows: PowerShell (prefer pwsh, fall back to powershell.exe)
// Linux / macOS: bash
export const IS_WINDOWS = process.platform === "win32";

export const PS_EXE = (() => {
  if (!IS_WINDOWS) return null;
  try { execSync("where pwsh", { stdio: "ignore" }); return "pwsh"; } catch { return "powershell"; }
})();

// Single source of truth for shell invocation.
// On Windows: { exe: "pwsh"/"powershell", buildArgs: cmd => [...] }
// On POSIX:  { exe: "bash", buildArgs: cmd => ["-c", cmd] }
export const SHELL = IS_WINDOWS
  ? {
      exe: PS_EXE,
      buildArgs: (cmd) => ["-NoProfile", "-Command", PS_UTF8_PREFIX + cmd],
    }
  : {
      exe: "/bin/bash",
      buildArgs: (cmd) => ["-c", cmd],
    };

// ── Window ──────────────────────────────────────────────────
export let mainWindow = null;
export function setMainWindow(win) { mainWindow = win; }
export function getMainWindow() { return mainWindow; }

// ── Workspace ───────────────────────────────────────────────
// WORKSPACE is the single source of truth for the user's project
// root. Initial value is the launch dir (or install dir when
// packaged); once `initWorkspaceFromConfig()` runs in app.whenReady,
// it is overridden by the persisted config (if any).
export let WORKSPACE = process.cwd();
export function setWorkspace(ws) {
  WORKSPACE = ws;
  // Persist synchronously — setWorkspace is called only from IPC
  // handlers (workspace:pick / workspace:set) which already validate
  // the path, so this is a single, predictable write per user action.
  saveWorkspaceConfig({ current: ws });
}
export function getWorkspace() { return WORKSPACE; }

/**
 * Load the persisted workspace config and override WORKSPACE if
 * a valid path is found. Call this once from main.mjs inside
 * `app.whenReady()` (before createWindow) so that the renderer
 * sees the user's last chosen project on launch.
 */
export function initWorkspaceFromConfig() {
  const cfg = loadWorkspaceConfig();
  if (cfg?.current) WORKSPACE = cfg.current;
}

// ── Constants ───────────────────────────────────────────────
export const MAX_OUTPUT = 60000;
// Dangerous command patterns, per-platform.
// Windows: catch raw `rm -rf` (PowerShell alias for Remove-Item), Remove-Item -Recurse,
//   del /f, rd /s, format <drive>:, diskpart.
// POSIX: catch `rm -rf` only when targeting root, sudo rm, dd to block devices, mkfs,
//   writes to /dev/sd*, chmod 777 /, chown of system paths.
export const DANGEROUS = IS_WINDOWS
  ? [
      /rm\s+-rf/i,
      /Remove-Item.*-Recurse/i,
      /del\s+\/f/i,
      /rd\s+\/s/i,
      /format\s+\w:/i,
      /diskpart/i,
    ]
  : [
      // /tmp and /var/tmp are scratch spaces; otherwise a top-level rm -rf is lethal.
      /rm\s+-rf\s+\/(?!tmp\b|var\/tmp)/i,
      /sudo\s+rm\s+-rf/i,
      /dd\s+if=.+of=\/dev\//i,
      /\bmkfs\b/i,
      />\s*\/dev\/sd[a-z]/i,
      /\bchmod\s+-R\s+777\s+\//i,
      // chown -R of system paths (not /home or /Users).
      /\bchown\s+-R\s+.+\s+\/(?!home|Users)/i,
    ];
export const GIT_SAFE = /^git\s+(add|status|diff|commit|branch|checkout|log|show|stash|fetch|pull|push|merge|rebase|reset|remote|tag)/i;
export const GH_SAFE = /^gh\s+(pr|issue|repo|gist|auth|api|browse|codespace|secret|gpg|ssh|config|extension)/i;
export const PS_UTF8_PREFIX = '$OutputEncoding = [Console]::OutputEncoding = [System.Text.Encoding]::UTF8; ';

// ── Agent Loop State ────────────────────────────────────────
export const MAX_TURNS = 50;
export const MAX_CONTINUATIONS = 5;
export const CONTEXT_WINDOW = 262144;
export const CONTEXT_WARN_PCT = 0.60;
export const CONTEXT_COMPRESS_PCT = 0.70;
// B5: was 2500 — too aggressive for LLM to make tool-calling decisions on
// truncated content. After 5-6 rounds of file_read/grep/web_fetch, the LLM
// would see only 2500 chars of recent tool output, decide "I have enough
// info" and stop calling tools ("give up mid-conversation"). Raise to 8000
// so the LLM has full context for the same turn + a few turns back. Pair
// with earlier CONTEXT_COMPRESS_PCT=0.70 so we compress BEFORE we run out,
// rather than waiting until 90% (too late — the conversation is already
// in "lazy completion" mode by then).
export const TOOL_RESULT_KEEP_CHARS = 8000;
export const LLM_CALL_TIMEOUT = 300_000; // 5 min per LLM API call — prevents infinite hang

export let abortCtrl = null;
export function setAbortCtrl(ctrl) { abortCtrl = ctrl; }
export function getAbortCtrl() { return abortCtrl; }

export let sessionId = null;
export function setSessionId(id) { sessionId = id; }
export function getSessionId() { return sessionId; }

/**
 * Long-lived `OpencodeAcpClient` instance reused across consecutive prompts
 * within the same OpenCode runtime session. Without this cache, every user
 * message would spawn a brand-new `opencode acp` subprocess + `session/new`,
 * causing total context loss between turns.
 *
 * Lifecycle:
 *   - Created on the first `runOpencodeAcp()` call after a session reset (or
 *     on the very first call ever).
 *   - Reused on subsequent `runOpencodeAcp()` calls in the same session.
 *   - Cleared on `session:reset` (ipc-handlers.mjs) and on subprocess crash.
 *
 * The cached instance is only "alive" when `!_closed && proc && !proc.killed`.
 * Consumers must check `isOpencodeAcpClientAlive(cached)` before reuse.
 *
 * @type {import("./opencode-acp-client.mjs").OpencodeAcpClient|null}
 */
export let opencodeAcpClient = null;
export function setOpencodeAcpClient(c) { opencodeAcpClient = c; }
export function getOpencodeAcpClient() { return opencodeAcpClient; }
/**
 * Test if the cached ACP client is still connected to a live subprocess.
 * Returns false when the client is null, has been stopped, or its process
 * has exited.
 */
export function isOpencodeAcpClientAlive(client = opencodeAcpClient) {
  if (!client) return false;
  // Private fields — guarded reads.
  if (client._closed) return false;
  if (!client.proc || client.proc.killed || client.proc.exitCode !== null) return false;
  return true;
}

export let history = [];
export function setHistory(h) { history = h; }
export function getHistory() { return history; }

export let _episodicSearched = false;
export function setEpisodicSearched(v) { _episodicSearched = v; }
export function getEpisodicSearched() { return _episodicSearched; }

// ── Task Store ──────────────────────────────────────────────
export const taskStore = new Map();
export let _todoList = [];
export function setTodoList(list) { _todoList = list; }
export function getTodoList() { return _todoList; }

export let _askId = 0;
export function nextAskId() { return ++_askId; }

export const _askResolvers = new Map();

// ── Plan Mode ───────────────────────────────────────────────
export let planMode = false;
export function setPlanMode(v) { planMode = v; }
export function getPlanMode() { return planMode; }

// ── Current Runtime ─────────────────────────────────────────
// Tracks which runtime ("aide" | "opencode") is active for the in-flight
// session. Set by `query:submit` so that downstream helpers (e.g. the
// `session:reset` saveSession helper in ipc-handlers.mjs) can persist the
// session with the correct runtime tag instead of hardcoding "aide".
// Default "aide" preserves behavior for legacy code paths that never set it.
export let currentRuntime = "aide";
export function setCurrentRuntime(rt) { currentRuntime = rt === "opencode" ? "opencode" : "aide"; }
export function getCurrentRuntime() { return currentRuntime; }

export const PLAN_MODE_READONLY = new Set([
  "file_read", "view_image", "grep", "glob", "web_search", "web_fetch",
  "Agent", "AskUserQuestion", "TaskList", "TodoWrite", "write_memory", "kb_write",
  "skill", "invoke_skill", "lsp",
]);

// ── Permissions ─────────────────────────────────────────────
export const pendingPerms = new Map();
export let permId = 0;
export function nextPermId() { return ++permId; }

// ── Sub-Agent ───────────────────────────────────────────────
export const SUB_AGENT_TOOL_NAMES = new Set([
  "bash", "file_read", "file_write", "file_edit", "grep", "glob",
  "web_fetch", "web_search", "skill", "write_memory", "invoke_skill",
  "create_skill", "TaskCreate", "TaskUpdate", "TaskList", "TodoWrite",
  "AskUserQuestion", "kb_write", "lsp", "git_diff", "git_commit",
  "git_branch", "gh_pr", "gh_issue", "gh_repo",
  "kb_search", "kb_get_note",
]);
export const SUB_AGENT_MAX_TURNS = 12;
export const _subAgentCtrls = new Map();

// ── Memory Selection ────────────────────────────────────────
// P3方案3(c): _surfacedMemories now has a per-turn TTL so that memories
// surfaced once can become candidates again after N conversation turns.
// Without TTL, a memory that the LLM surfaced in turn 1 stays "locked out"
// for the entire session even if the user's topic shifts — leading to the
// Agent seeing only stale memories and "answering about the wrong thing".
//
// Map<filename, { turn: number, expiresAt: number }> instead of Set<string>.
// Public API: markSurfaced(filename), pruneSurfacedMemories(now, ttl),
// isSurfaced(filename, now) — wrapped in helpers so callers don't have
// to think about the data shape.
const _SURFACED_TTL_TURNS = 50; // 50 turns ~= 1-2 hours of active conversation

/** @type {Map<string, { turn: number, expiresAt: number }>} */
const _surfacedMemories = new Map();

/** @param {string} filename */
export function markSurfaced(filename) {
  const turn = _currentTurn;
  _surfacedMemories.set(filename, { turn, expiresAt: turn + _SURFACED_TTL_TURNS });
}

/**
 * Drop expired entries. Cheap to call on every selection — Map.delete is O(1).
 * @param {number} now
 */
export function pruneSurfacedMemories(now) {
  for (const [k, v] of _surfacedMemories) {
    if (v.expiresAt <= now) _surfacedMemories.delete(k);
  }
}

/**
 * @param {string} filename
 * @param {number} now
 * @returns {boolean}
 */
export function isSurfaced(filename, now) {
  const v = _surfacedMemories.get(filename);
  return !!(v && v.expiresAt > now);
}

/** Get raw entries (for tests + debugging). */
export function getSurfacedMemoriesSnapshot() {
  return Array.from(_surfacedMemories.entries()).map(([k, v]) => ({ filename: k, ...v }));
}

/** Reset for tests. */
export function resetSurfacedMemories() {
  _surfacedMemories.clear();
}

// Per-session turn counter. Bumped once per LLM call by the agent loop.
// Memory-selection uses this to decide which "surfaced" memories have expired.
let _currentTurn = 0;
export function bumpTurnCounter() { _currentTurn++; return _currentTurn; }
export function getCurrentTurn() { return _currentTurn; }
/** Test-only: reset to 0. */
export function resetTurnCounter() { _currentTurn = 0; }

// ── Prompt Store ────────────────────────────────────────────
export let _promptStorePath = null;
export function setPromptStorePath(p) { _promptStorePath = p; }
export function getPromptStorePath() { return _promptStorePath; }

// ── WeChat State ────────────────────────────────────────────
export const WX_BASE = "https://ilinkai.weixin.qq.com";
export const WX_BOT_TYPE = "3";
export const WX_POLL_TIMEOUT = 40_000;
export const WX_MSG_CHUNK = 4000;
export const MSG_ITEM_TEXT = 1;
export const MSG_TYPE_BOT = 2;
export const MSG_STATE_FINISH = 2;

export let wxBotToken = null;
export function setWxBotToken(t) { wxBotToken = t; }
export function getWxBotToken() { return wxBotToken; }

export let wxBotId = null;
export function setWxBotId(id) { wxBotId = id; }
export function getWxBotId() { return wxBotId; }

export let wxUserId = null;
export function setWxUserId(id) { wxUserId = id; }
export function getWxUserId() { return wxUserId; }

export let wxPollAbort = null;
export function setWxPollAbort(a) { wxPollAbort = a; }
export function getWxPollAbort() { return wxPollAbort; }

export let _lastApiConfig = {};
export function setLastApiConfig(cfg) { _lastApiConfig = cfg; }
export function getLastApiConfig() { return _lastApiConfig; }

// ── Helpers ─────────────────────────────────────────────────
export function genId() {
  return `ses_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

// ── Renderer message ring buffer ─────────────────────────────
// When the window is destroyed or the renderer is reconnecting, stream
// events (chunks, tool results, metrics) are silently dropped. This
// buffer keeps the last MAX entries so a reconnecting renderer can
// replay missed events instead of showing a blank conversation.
const RENDERER_BUFFER_MAX = 200;
/** @type {Array<{channel:string,data:any,timestamp:number}>} */
const _rendererBuffer = [];
/** @param {string} channel @param {any} data */
function _pushBuffer(channel, data) {
  _rendererBuffer.push({ channel, data, timestamp: Date.now() });
  if (_rendererBuffer.length > RENDERER_BUFFER_MAX) _rendererBuffer.shift();
}

export function sendToRenderer(channel, data) {
  const win = getMainWindow();
  if (win && !win.isDestroyed()) {
    _pushBuffer(channel, data);
    win.webContents.send(channel, data);
  } else {
    // Window unavailable — still buffer so it can be replayed later.
    _pushBuffer(channel, data);
  }
}

/** Return the full buffer for replay (renderer calls this on reconnect). */
export function getRendererBuffer() {
  return _rendererBuffer.slice();
}

/** Clear buffer after successful replay. */
export function clearRendererBuffer() {
  _rendererBuffer.length = 0;
}
