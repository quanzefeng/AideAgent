// ── Hook Manager — event-driven script execution ─────────────

import { spawn } from "node:child_process";
import { join, resolve } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";

let _cache = null;   // { PreToolUse: [...], PostToolUse: [...], SessionEnd: [...] }
let _workspace = "";

function loadConfig(dir) {
  const configPath = join(dir, "hooks", "hooks.json");
  try {
    if (!existsSync(configPath)) return {};
    const raw = readFileSync(configPath, "utf-8");
    return JSON.parse(raw);
  } catch { return {}; }
}

function mergeConfigs(base, override) {
  const result = { ...base };
  for (const key of Object.keys(override)) {
    if (Array.isArray(override[key])) {
      result[key] = [...(result[key] || []), ...override[key]];
    }
  }
  return result;
}

export function initHookManager(workspace) {
  _workspace = workspace || "";
  // project-level hooks first, then global hooks
  let config = {};
  if (_workspace) {
    config = mergeConfigs(config, loadConfig(_workspace));
  }
  config = mergeConfigs(config, loadConfig(join(homedir(), ".goodagent")));
  _cache = Object.keys(config).length > 0 ? config : null;
}

function runScript(script, data, timeoutMs = 5000) {
  return new Promise(resolve => {
    const parts = [];
    const child = spawn("node", [script], {
      cwd: _workspace,
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

// Resolve script path safely — must stay within workspace or global hooks dir
function safeScriptPath(script) {
  if (!script || typeof script !== "string") return null;
  const abs = resolve(_workspace, script);
  if (!abs.startsWith(resolve(_workspace) + "/") && !abs.startsWith(resolve(_workspace) + "\\")) {
    return null; // path traversal attempt
  }
  return abs;
}

/**
 * Fire a hook event.
 * For "PreToolUse": returns { blocked, reason, modified, args } — awaits all scripts.
 * For others: fire-and-forget, returns null.
 */
export async function fire(event, data) {
  if (!_cache) return null;
  const scripts = _cache[event];
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
      const absPath = safeScriptPath(script);
      if (!absPath || !existsSync(absPath)) continue;

      const decision = await runScript(absPath, data, timeout);
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
    const absPath = safeScriptPath(script);
    if (!absPath || !existsSync(absPath)) continue;
    runScript(absPath, data, entry.timeout || 5000).catch(() => {});
  }
  return null;
}
