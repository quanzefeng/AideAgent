// ── Shared State for GoodAgent Main Process ──────────────────
// All mutable state shared across modules lives here.
// Modules import from this file and mutate the exported objects.

import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";

export const __dirname = dirname(fileURLToPath(import.meta.url));
export const PROJECT_ROOT = dirname(__dirname);
export const isDev = process.argv.includes("--dev");

// Prefer pwsh (PowerShell 7+ with native UTF-8) over powershell.exe
export const PS_EXE = (() => { try { execSync("where pwsh", { stdio: "ignore" }); return "pwsh"; } catch { return "powershell"; } })();

// ── Window ──────────────────────────────────────────────────
export let mainWindow = null;
export function setMainWindow(win) { mainWindow = win; }
export function getMainWindow() { return mainWindow; }

// ── Workspace ───────────────────────────────────────────────
export let WORKSPACE = process.cwd();
export function setWorkspace(ws) { WORKSPACE = ws; }
export function getWorkspace() { return WORKSPACE; }

// ── Constants ───────────────────────────────────────────────
export const MAX_OUTPUT = 12000;
export const DANGEROUS = [/rm\s+-rf/i, /Remove-Item.*-Recurse/i, /del\s+\/f/i, /rd\s+\/s/i, /format\s+\w:/i, /diskpart/i];
export const GIT_SAFE = /^git\s+(add|status|diff|commit|branch|checkout|log|show|stash|fetch|pull|push|merge|rebase|reset|remote|tag)/i;
export const GH_SAFE = /^gh\s+(pr|issue|repo|gist|auth|api|browse|codespace|secret|gpg|ssh|config|extension)/i;
export const PS_UTF8_PREFIX = '$OutputEncoding = [Console]::OutputEncoding = [System.Text.Encoding]::UTF8; ';

// ── Agent Loop State ────────────────────────────────────────
export const MAX_TURNS = 35;
export const CONTEXT_WINDOW = 262144;
export const CONTEXT_WARN_PCT = 0.80;
export const CONTEXT_COMPRESS_PCT = 0.90;
export const TOOL_RESULT_KEEP_CHARS = 500;

export let abortCtrl = null;
export function setAbortCtrl(ctrl) { abortCtrl = ctrl; }
export function getAbortCtrl() { return abortCtrl; }

export let sessionId = null;
export function setSessionId(id) { sessionId = id; }
export function getSessionId() { return sessionId; }

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

export const PLAN_MODE_READONLY = new Set([
  "file_read", "grep", "glob", "web_search", "web_fetch",
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
  "kb_search", "kb_get_note", "memory_search",
]);
export const SUB_AGENT_MAX_TURNS = 12;
export const _subAgentCtrls = new Map();

// ── Memory Selection ────────────────────────────────────────
export const _surfacedMemories = new Set();

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

export function sendToRenderer(channel, data) {
  const win = getMainWindow();
  if (win && !win.isDestroyed()) {
    win.webContents.send(channel, data);
  }
}
