// ── Hook Manager — event-driven script execution ─────────────

import { spawn } from "node:child_process";
import { join, resolve } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { getWorkspace } from "./state.ts";

// Cache is keyed by workspace. The previous module-level `_cache`/`_workspace`
// meant a WeChat session running concurrently with the desktop could re-init
// hooks for a different project and make the desktop fire the wrong scripts.
const _cacheByWorkspace = new Map<string, Record<string, any> | null>();
const GLOBAL_HOOKS_DIR = join(homedir(), ".aideagent");

function loadConfig(dir: string) {
  const configPath = join(dir, "hooks", "hooks.json");
  try {
    if (!existsSync(configPath)) return {};
    const raw = readFileSync(configPath, "utf-8");
    return JSON.parse(raw);
  } catch { return {}; }
}

function mergeConfigs(base: Record<string, any>, override: Record<string, any>) {
  const result = { ...base };
  for (const key of Object.keys(override)) {
    if (Array.isArray(override[key])) {
      result[key] = [...(result[key] || []), ...override[key]];
    }
  }
  return result;
}

export function initHookManager(workspace: string) {
  const ws = workspace || "";
  // project-level hooks first, then global hooks
  let config: Record<string, any> = {};
  if (ws) {
    config = mergeConfigs(config, loadConfig(ws));
  }
  config = mergeConfigs(config, loadConfig(join(homedir(), ".aideagent")));
  _cacheByWorkspace.set(ws, Object.keys(config).length > 0 ? config : null);
  return _cacheByWorkspace.get(ws);
}

function hooksForCurrentWorkspace(): { config: Record<string, any> | null, workspace: string } {
  const ws = getWorkspace() || "";
  const cached = _cacheByWorkspace.get(ws);
  if (cached !== undefined) return { config: cached, workspace: ws };
  return { config: initHookManager(ws) ?? null, workspace: ws };
}

function runScript(script: string, data: any, timeoutMs = 5000, workspace = ""): Promise<any> {
  return new Promise<any>(resolve => {
    const parts: Buffer[] = [];
    const child = spawn("node", [script], {
      cwd: workspace || undefined,
      shell: false,
      timeout: timeoutMs,
      stdio: ["pipe", "pipe", "pipe"],
    });
    child.stdin.write(JSON.stringify(data));
    child.stdin.end();
    child.stdout.on("data", c => parts.push(c));
    child.on("close", code => {
      if (code !== 0) return resolve(null);
      try {
        const out = Buffer.concat(parts).toString("utf-8").trim();
        if (!out) return resolve(null);
        resolve(JSON.parse(out));
      } catch { resolve(null); }
    });
    child.on("error", () => resolve(null));
    setTimeout(() => {
      try { child.kill(); } catch {}
      resolve(null); // timeout → null → allow
    }, timeoutMs);
  });
}

// Resolve script path safely — must stay within workspace or the global
// hooks dir. Global hooks (from ~/.aideagent/hooks/hooks.json) live outside
// the project workspace, so they'd be wrongly rejected by a workspace-only
// check. `resolve(dir, script)` also anchors relative scripts to the right
// base: project hooks → workspace, global hooks → ~/.aideagent.
function resolveScriptPath(script: string, base: string) {
  if (!script || typeof script !== "string") return null;
  const abs = resolve(base, script);
  return abs;
}

function withinBase(abs: string, base: string) {
  const root = resolve(base);
  return abs === root || abs.startsWith(root + "/") || abs.startsWith(root + "\\");
}

/**
 * Resolve a hook script path, rejecting path traversal outside the allowed
 * roots (project workspace + global hooks dir). Project-level hooks resolve
 * relative to the workspace; global hooks resolve relative to ~/.aideagent.
 * @param {string} script
 */
function safeScriptPath(script: string, workspace: string) {
  if (!script || typeof script !== "string") return null;
  // Absolute scripts: allow when inside workspace or global hooks dir.
  if (script.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(script)) {
    return withinBase(script, workspace) || withinBase(script, GLOBAL_HOOKS_DIR)
      ? script
      : null;
  }
  // Relative scripts: try workspace first (project hooks), then global dir.
  const wsPath = resolveScriptPath(script, workspace);
  if (wsPath && withinBase(wsPath, workspace)) return wsPath;
  const globalPath = resolveScriptPath(script, GLOBAL_HOOKS_DIR);
  if (globalPath && withinBase(globalPath, GLOBAL_HOOKS_DIR)) return globalPath;
  return null;
}

/**
 * Fire a hook event.
 * For "PreToolUse": returns { blocked, reason, modified, args } — awaits all scripts.
 * For others: fire-and-forget, returns null.
 */
export async function fire(event: string, data: any) {
  const { config: cache, workspace } = hooksForCurrentWorkspace();
  if (!cache) return null;
  const scripts = cache[event];
  if (!scripts || scripts.length === 0) return null;

  const tool = data?.tool;

  if (event === "PreToolUse") {
    for (const entry of scripts) {
      // enabled field: false to temporarily disable without deleting from config
      if (entry.enabled === false) continue;
      const script = entry.script;
      if (!script) continue;

      // tools filter: only fire for matching tools (empty = all tools)
      if (entry.tools && entry.tools.length > 0 && tool && !entry.tools.includes(tool)) continue;

      const timeout = entry.timeout || 5000;
      const onError = entry.onError || "allow";
      const absPath = safeScriptPath(script, workspace);
      if (!absPath || !existsSync(absPath)) continue;

      const decision = await runScript(absPath, data, timeout, workspace);
      // null decision = timeout / crash / non-JSON output
      if (!decision) {
        if (onError === "block") {
          return { blocked: true, reason: `Hook "${script}" failed or timed out` };
        }
        continue;
      }
      if (decision.decision === "block") {
        return { blocked: true, reason: decision.reason || "Blocked by hook" };
      }
      if (decision.decision === "modify" && decision.args) {
        return { blocked: false, modified: true, args: decision.args };
      }
    }
    return null; // allow
  }

  // PostToolUse / SessionEnd — fire-and-forget
  for (const entry of scripts) {
    if (entry.enabled === false) continue;
    const script = entry.script;
    if (!script) continue;
    if (entry.tools && entry.tools.length > 0 && tool && !entry.tools.includes(tool)) continue;
    const absPath = safeScriptPath(script, workspace);
    if (!absPath || !existsSync(absPath)) continue;
    runScript(absPath, data, entry.timeout || 5000, workspace).catch(() => {});
  }
  return null;
}
