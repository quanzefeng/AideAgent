// ── Permission Layer — tool / path / command policy ─────────
//
// Before this module, only `bash` was gated (by a regex + a dialog). File
// writes, git commits, skill creation and every MCP tool ran automatically
// with no workspace boundary. This module answers one question for every
// tool call:
//
//     allow | ask | deny
//
// Defaults are deliberately boring and safe:
//   - reads inside the workspace (and app-managed roots)  → allow
//   - reads outside the workspace                         → ask
//   - writes inside the workspace                         → allow in "auto",
//                                                           ask in "ask"
//   - writes outside the workspace                        → ask
//   - dangerous shell commands                            → ask
//   - unknown / MCP tools                                 → ask
//   - non-interactive sessions (WeChat) never "ask": they deny.
//
// "full" is the deliberate opt-out: every tool/path/command is allowed without
// a prompt, except for explicit deny rules. It is still subject to plan mode.
// Non-interactive sessions use full access only when
// `allowUnattendedFullAccess` is explicitly true; otherwise they evaluate as
// "auto" so a WeChat message cannot silently run arbitrary commands.
//
// Users can override any of this in ~/.aideagent/permissions.json:
//
//   {
//     "mode": "auto" | "ask" | "readonly" | "full",
//     "allowUnattendedFullAccess": false,
//     "rules": [
//       { "tool": "bash", "pattern": "npm install", "action": "ask" },
//       { "tool": "file_write", "pattern": "src/", "action": "allow" },
//       { "tool": "*", "pattern": ".ssh", "action": "deny" }
//     ]
//   }
//
// `pattern` is matched case-insensitively against the command (bash), the
// resolved absolute + workspace-relative path (file tools), or the JSON args
// (everything else). Deny rules always win; allow rules are checked next.

import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

export type PermissionMode = "auto" | "ask" | "readonly" | "full";
export type PermissionAction = "allow" | "ask" | "deny";

export interface PermissionRule {
  tool: string;
  action: PermissionAction;
  pattern?: string;
}

export interface PermissionConfig {
  mode: PermissionMode;
  rules: PermissionRule[];
  /**
   * Full access is meant for an interactive desktop session. WeChat/background
   * sessions fall back to "auto" unless this is explicitly enabled.
   */
  allowUnattendedFullAccess?: boolean;
}

export interface PermissionDecision {
  action: PermissionAction;
  /** Short machine-readable reason, e.g. "outside-workspace". */
  reason: string;
  /** Dialog title, already localized. */
  title: string;
  /** Dialog body (command / path / args). */
  detail: string;
  /**
   * True for the explicit "full access" decision. The tool executor uses this
   * to skip its legacy dangerous-command check.
   */
  unrestricted?: boolean;
}

const DEFAULT_CONFIG: PermissionConfig = { mode: "auto", rules: [] };
let _config: PermissionConfig | null = null;
let _configPathOverride: string | null = null;

function configPath(): string {
  return _configPathOverride || join(homedir(), ".aideagent", "permissions.json");
}

function normalizeMode(value: any): PermissionMode {
  return value === "ask" || value === "readonly" || value === "full" ? value : "auto";
}

function normalizeRules(value: any): PermissionRule[] {
  return Array.isArray(value)
    ? value
      .filter((r: any) => r && typeof r.tool === "string"
        && (r.action === "allow" || r.action === "ask" || r.action === "deny"))
      .map((r: any) => ({
        tool: r.tool,
        action: r.action,
        ...(typeof r.pattern === "string" && r.pattern ? { pattern: r.pattern } : {}),
      }))
    : [];
}

export function loadPermissionConfig(): PermissionConfig {
  if (_config) return _config;
  try {
    const raw = readFileSync(configPath(), "utf-8");
    const parsed = JSON.parse(raw);
    const mode = normalizeMode(parsed?.mode);
    const rules = normalizeRules(parsed?.rules);
    _config = {
      mode,
      rules,
      ...(parsed?.allowUnattendedFullAccess === true ? { allowUnattendedFullAccess: true } : {}),
    };
  } catch {
    _config = { ...DEFAULT_CONFIG };
  }
  return _config;
}

export function savePermissionConfig(cfg: Partial<PermissionConfig>): PermissionConfig {
  // Treat this as a merge: the settings UI may update only `mode`, and older
  // callers relied on rules being preserved. Passing `rules` explicitly still
  // replaces the list (including an empty list).
  const prev = _config || loadPermissionConfig();
  const allowUnattendedFullAccess = cfg.allowUnattendedFullAccess !== undefined
    ? cfg.allowUnattendedFullAccess === true
    : prev.allowUnattendedFullAccess === true;
  const next: PermissionConfig = {
    mode: cfg.mode !== undefined ? normalizeMode(cfg.mode) : prev.mode,
    rules: cfg.rules !== undefined ? normalizeRules(cfg.rules) : prev.rules,
    ...(allowUnattendedFullAccess ? { allowUnattendedFullAccess: true } : {}),
  };
  _config = next;
  try {
    const p = configPath();
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, JSON.stringify(next, null, 2), "utf-8");
  } catch (e: any) {
    console.warn("[permissions] failed to save config:", e?.message || e);
  }
  return next;
}

/** Test hook. */
export function _setPermissionConfigForTests(cfg: PermissionConfig | null, path?: string | null): void {
  _config = cfg;
  if (path !== undefined) _configPathOverride = path;
}

// ── Tool classification ─────────────────────────────────────

const READ_ONLY_TOOLS = new Set([
  "file_read", "view_image", "grep", "glob", "lsp",
  "web_search", "web_fetch", "read_memory", "kb_search", "kb_get_note",
  "list_skills", "list_memories", "list_kb", "list_mcp", "list_tools",
  "get_session_info", "context_recall", "TaskList",
  "git_diff", "AskUserQuestion", "Agent",
]);

const WRITE_TOOLS = new Set([
  "file_write", "file_edit", "create_skill", "kb_write",
  "git_commit", "git_branch", "gh_pr", "gh_issue", "gh_repo",
  "TaskCreate", "TaskUpdate", "TodoWrite", "write_memory",
]);

// App-managed roots: reading these is part of normal operation (skills,
// memories, hooks) and should not nag the user.
function appRoots(): string[] {
  return [
    join(homedir(), ".aideagent"),
    join(homedir(), ".claude"),
    join(homedir(), ".agents"),
  ];
}

const PATH_ARG_TOOLS = new Set(["file_read", "file_write", "file_edit", "view_image", "grep", "glob", "lsp"]);

const FORMAT_ARGS = new Set(["file_content", "content", "new_string", "old_string", "body", "text"]);

function toolPaths(tool: string, args: any, workspace: string): string[] {
  if (!args || typeof args !== "object") return [];
  const raw: string[] = [];
  if (PATH_ARG_TOOLS.has(tool)) {
    if (typeof args.path === "string" && args.path.trim()) raw.push(args.path);
    if (typeof args.file_path === "string" && args.file_path.trim()) raw.push(args.file_path);
  }
  return raw.map(p => normalizePath(p, workspace));
}

function normalizePath(p: string, workspace: string): string {
  const abs = isAbsolute(p) ? p : resolve(workspace, p);
  // Resolve symlinks for existing paths so a link inside the workspace
  // cannot point a write at ~/.ssh. For new files, resolve the parent.
  try {
    const real = realpathSync.native(abs);
    return real;
  } catch {
    try {
      const parent = realpathSync.native(dirname(abs));
      return join(parent, relBasename(abs));
    } catch {
      return abs;
    }
  }
}

function relBasename(p: string): string {
  const s = p.replace(/[\\/]+$/, "");
  const i = Math.max(s.lastIndexOf("/"), s.lastIndexOf("\\"));
  return i >= 0 ? s.slice(i + 1) : s;
}

function inside(root: string, abs: string): boolean {
  const rel = relative(resolve(root), resolve(abs));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function displayPath(abs: string, workspace: string): string {
  const rel = relative(workspace, abs);
  return rel && !rel.startsWith("..") && !isAbsolute(rel) ? rel : abs;
}

// ── Shell classification ────────────────────────────────────

// Commands that only read. Kept intentionally narrow; anything with a shell
// separator / pipe / redirect is excluded so `git status && curl ... | sh`
// cannot ride an allowlisted prefix.
const READ_ONLY_COMMAND = /^(?:ls|dir|pwd|cat|type|head|tail|more|wc|sort|uniq|tree|find|where|which|rg|grep|Get-ChildItem|Get-Content|Select-String|Get-Location|Resolve-Path|Test-Path|git\s+(?:status|diff|log|show|branch|remote|rev-parse|describe|blame)|npm\s+(?:test|run\s+(?:test|lint|typecheck|build))|npx\s+tsc\s+--noEmit|node\s+--version|python\s+--version|echo)\b/i;
const SHELL_META = /[;&|><`$(){}]/;
const ALWAYS_ASK_COMMAND = /\b(?:sudo|rm|rmdir|del|erase|format|diskpart|curl|wget|Invoke-WebRequest|Invoke-RestMethod|ssh|scp|nc|ncat|chmod|chown|mkfs|dd|shutdown|reboot|reg\s+add|schtasks|start-process|new-service|set-itemproperty)\b/i;

function isReadOnlyCommand(cmd: string): boolean {
  const c = String(cmd || "").trim();
  if (!c || SHELL_META.test(c)) return false;
  return READ_ONLY_COMMAND.test(c);
}

// ── Decision ────────────────────────────────────────────────

export interface ToolPermissionInput {
  tool: string;
  args: any;
  workspace: string;
  interactive: boolean;
}

function matchRule(rule: PermissionRule, tool: string, haystack: string): boolean {
  if (rule.tool !== "*" && rule.tool !== tool) return false;
  if (!rule.pattern) return true;
  try {
    return haystack.toLowerCase().includes(rule.pattern.toLowerCase());
  } catch { return false; }
}

function matchesAnyRule(rules: PermissionRule[], action: PermissionAction, tool: string, haystack: string): PermissionRule | null {
  for (const r of rules) {
    if (r.action === action && matchRule(r, tool, haystack)) return r;
  }
  return null;
}

function deny(detail: string, reason = "policy"): PermissionDecision {
  return { action: "deny", reason, title: "操作被拒绝", detail };
}

function ask(title: string, detail: string, reason = "confirm"): PermissionDecision {
  return { action: "ask", reason, title, detail };
}

function allow(reason = "allowed", unrestricted = false): PermissionDecision {
  return {
    action: "allow",
    reason,
    title: "",
    detail: "",
    ...(unrestricted ? { unrestricted: true } : {}),
  };
}

export function evaluateToolCall(input: ToolPermissionInput): PermissionDecision {
  const { tool, args, workspace, interactive } = input;
  const cfg = loadPermissionConfig();
  // Full access is only active for an interactive desktop session unless the
  // user explicitly opted into unattended full access. Otherwise evaluate the
  // call as "auto" so WeChat/background sessions keep their existing safety.
  const fullAccessActive = cfg.mode === "full"
    && (interactive || cfg.allowUnattendedFullAccess === true);
  const mode: PermissionMode = cfg.mode === "full" && !fullAccessActive ? "auto" : cfg.mode;
  const paths = toolPaths(tool, args, workspace);
  const shells = tool === "bash" && typeof args?.command === "string" ? [args.command] : [];
  const haystack = [
    tool,
    ...paths,
    ...paths.map(p => displayPath(p, workspace)),
    ...shells,
    tool === "bash" ? "" : safeJson(args),
  ].join("\n");

  // 1. Explicit deny rules win, even in full mode. They are the user's hard
  //    guardrail (e.g. protect ~/.ssh or .env).
  const denied = matchesAnyRule(cfg.rules, "deny", tool, haystack);
  if (denied) return deny(`匹配规则: ${tool} ${denied.pattern || "*"} → deny`, "rule-deny");

  // 2. Full access: no path boundary, no dangerous-command prompt, no MCP
  //    prompt. The tool executor checks `unrestricted` so its legacy second
  //    net does not re-prompt for `rm`/`sudo`.
  if (fullAccessActive) return allow("full-access", true);

  // 3. Read-only mode blocks every mutation. `bash` is classified below:
  //    read-only commands (git status, rg, ...) remain usable, everything
  //    else is denied by readOnlyCommandDecision.
  if (mode === "readonly" && tool !== "bash" && !READ_ONLY_TOOLS.has(tool)) {
    return deny("当前为只读模式（permissions.json mode=readonly）。", "readonly-mode");
  }

  // 4. Explicit allow rules (except for shell commands that are inherently
  //    dangerous — an allowlist entry can still opt in, but the default
  //    "allow" rule must be explicit, which this is).
  const allowed = matchesAnyRule(cfg.rules, "allow", tool, haystack);
  if (allowed) return allow("rule-allow");

  // 5. Unknown / MCP tools: ask. We cannot reason about their side effects.
  if (!READ_ONLY_TOOLS.has(tool) && !WRITE_TOOLS.has(tool) && tool !== "bash") {
    return ask(`调用外部工具 ${tool}`, truncate(safeJson(args), 1200), "mcp-or-unknown");
  }

  // 6. Shell.
  if (tool === "bash") {
    const cmd = String(args?.command || "");
    const ro = readOnlyCommandDecision(cmd, mode, interactive);
    if (ro) return ro;
    if (ALWAYS_ASK_COMMAND.test(cmd)) {
      return ask("执行命令", cmd, "dangerous-command");
    }
    if (mode === "ask") return ask("执行命令", cmd, "ask-mode");
    return allow();
  }

  // 7. File reads: workspace + app roots are fine; elsewhere ask.
  if (READ_ONLY_TOOLS.has(tool)) {
    if (paths.length > 0 && paths.every(p => !inside(workspace, p))) {
      const everyAppRoot = paths.every(p => appRoots().some(root => inside(root, p)));
      if (everyAppRoot) return allow("app-root");
      return ask("读取工作区外的文件", paths.map(p => displayPath(p, workspace)).join("\n"), "outside-workspace-read");
    }
    return allow();
  }

  // 8. Writes.
  if (WRITE_TOOLS.has(tool)) {
    // App-managed stores (skills / memory / KB notes) are not project files.
    if (tool === "create_skill" || tool === "kb_write" || tool === "write_memory") {
      return allow("app-managed-store");
    }
    if (tool === "gh_pr" || tool === "gh_issue" || tool === "gh_repo") {
      return ask(`GitHub 操作: ${tool}`, truncate(safeJson(args), 1200), "remote-write");
    }
    if (tool === "git_branch" && (args?.action === "list" || args?.action === "current")) {
      return allow();
    }
    if (paths.length > 0) {
      const outside = paths.filter(p => !inside(workspace, p));
      if (outside.length > 0) {
        return ask("修改工作区外的文件", outside.map(p => displayPath(p, workspace)).join("\n"), "outside-workspace-write");
      }
      if (mode === "ask") {
        return ask("修改文件", paths.map(p => displayPath(p, workspace)).join("\n"), "ask-mode");
      }
      return allow();
    }
    // Writes without a path (git commit/branch actions, TaskUpdate, ...).
    if (tool === "git_commit" || (tool === "git_branch" && mode !== "ask")) return allow();
    if (mode === "ask") return ask(`执行写操作: ${tool}`, truncate(safeJson(args), 1200), "ask-mode");
    return allow();
  }

  return mode === "ask" ? ask(`执行工具: ${tool}`, truncate(safeJson(args), 1200)) : allow();
}

function readOnlyCommandDecision(cmd: string, mode: PermissionMode, interactive: boolean): PermissionDecision | null {
  if (mode === "readonly") {
    return isReadOnlyCommand(cmd) ? allow("readonly-command") : deny("当前为只读模式，只允许读取类命令。", "readonly-mode");
  }
  if (isReadOnlyCommand(cmd)) return allow("readonly-command");
  return null;
}

function safeJson(v: any): string {
  try { return JSON.stringify(v ?? {}); } catch { return String(v); }
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + `\n…(已截断 ${s.length - n} 字符)` : s;
}
