// ── Tool Executor — runTool dispatch ────────────────────────

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { safeStorage } from "electron";
import * as memory from "../memory-store.mjs";
import * as skills from "../skills-store.mjs";
import * as kb from "../knowledge-store.mjs";
import mcpManager from "../mcp-manager.mjs";
import { scanSkills } from "./skill-scanner.mjs";
import { searchMeta } from "../search-engine/index.mjs";
import * as hookManager from "./hook-manager.mjs";
import sessionDb from "../session-db.mjs";
import {
  SHELL, IS_WINDOWS, getWorkspace, MAX_OUTPUT, DANGEROUS, GIT_SAFE, GH_SAFE,
  getPlanMode, pendingPerms, nextPermId, sendToRenderer,
  taskStore, getTodoList, setTodoList,
  _askResolvers, nextAskId,
  getLastApiConfig, getSessionId,
} from "./state.mjs";

/** Persist current task/todo state to the session DB (P2). Fire-and-forget. */
function persistSessionState() {
  const sid = getSessionId();
  if (!sid) return;
  try {
    sessionDb.saveSessionTasks(sid, Array.from(taskStore.values()).filter(t => t.status !== "deleted"));
    sessionDb.saveSessionTodos(sid, getTodoList());
  } catch (e) { /* persistence is best-effort; never block tool execution */ }
}

// Re-export for use by other modules
export { runShell, isDangerous, requestPermission };

function isDangerous(cmd) {
  if (GIT_SAFE.test(cmd.trim())) return false;
  if (GH_SAFE.test(cmd.trim())) return false;
  return DANGEROUS.some(p => p.test(cmd));
}

function requestPermission(cmd) {
  return new Promise(resolve => {
    const id = nextPermId();
    pendingPerms.set(id, resolve);
    sendToRenderer("permission:request", { id, command: cmd });
  });
}

// Cross-platform shell execution.
// Windows: invokes pwsh / powershell.exe via -Command
// POSIX:   invokes /bin/bash via -c
// Resolves with { out, err, code } on success, { error } on spawn failure.
function runShell(command, opts = {}) {
  return new Promise(resolve => {
    try {
      const args = SHELL.buildArgs(command);
      const child = spawn(SHELL.exe, args, {
        cwd: getWorkspace(), shell: false, timeout: opts.timeout || 60000,
      });
      const chunks = { out: [], err: [] };
      child.stdout.on("data", c => chunks.out.push(c));
      child.stderr.on("data", c => chunks.err.push(c));
      child.on("close", code => {
        const out = Buffer.concat(chunks.out).toString("utf-8");
        const err = Buffer.concat(chunks.err).toString("utf-8");
        resolve({ out, err, code });
      });
      child.on("error", e => resolve({ error: e.message }));
    } catch (e) { resolve({ error: e.message }); }
  });
}

// Safe spawn: exe + args array, no shell interpolation → no injection
function runSpawnSafe(exe, args, opts = {}) {
  return new Promise(resolve => {
    try {
      const child = spawn(exe, args, {
        cwd: getWorkspace(), shell: false, timeout: opts.timeout || 60000,
      });
      const chunks = { out: [], err: [] };
      child.stdout.on("data", c => chunks.out.push(c));
      child.stderr.on("data", c => chunks.err.push(c));
      child.on("close", code => {
        const out = Buffer.concat(chunks.out).toString("utf-8").trim();
        const err = Buffer.concat(chunks.err).toString("utf-8").trim();
        resolve({ out, err, code });
      });
      child.on("error", e => resolve({ error: e.message }));
    } catch (e) { resolve({ error: e.message }); }
  });
}

// Backward-compat alias — the old name still works.
export const runPowerShell = runShell;

// Read search provider preference from config file
function readSearchProviderPref() {
  try {
    const keyPath = join(homedir(), ".aideagent", "api-keys.enc");
    if (existsSync(keyPath)) {
      const data = readFileSync(keyPath);
      const store = safeStorage.isEncryptionAvailable()
        ? JSON.parse(safeStorage.decryptString(data))
        : JSON.parse(data.toString("utf8"));
      if (store._search_provider) return store._search_provider;
    }
  } catch {}
  return null; // null = no preference saved, will use Tavily if key available
}

// ── URL safety check — block internal/private hosts ───────
function isSafeUrl(u) {
  try {
    const x = new URL(u);
    if (!/^https?:$/.test(x.protocol)) return false;
    const host = x.hostname;
    if (host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host === "::1") return false;
    if (/^(10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|169\.254\.|fc00:|fe80:)/.test(host)) return false;
    return true;
  } catch { return false; }
}

// Lazy imports for circular dependency avoidance
let _runSubAgent = null;
async function getRunSubAgent() {
  if (!_runSubAgent) {
    const mod = await import("./sub-agent.mjs");
    _runSubAgent = mod.runSubAgent;
  }
  return _runSubAgent;
}

let _loadWxConfig = null;
async function getLoadWxConfig() {
  if (!_loadWxConfig) {
    const mod = await import("./wechat-bridge.mjs");
    _loadWxConfig = mod.loadWxConfig;
  }
  return _loadWxConfig;
}

let _bumpVersion = null;
async function getBumpVersion() {
  if (!_bumpVersion) {
    const mod = await import("./system-prompt.mjs");
    _bumpVersion = mod.bumpVersion;
  }
  return _bumpVersion;
}

/**
 * Dispatch a single tool call to the appropriate handler.
 *
 * @param {{ function: { name: string; arguments: string } }} tc - Tool call object
 *   from LLM response (OpenAI `tool_calls[i]` shape).
 * @returns {Promise<any>} Tool-specific result. Shape varies per tool name.
 *   Common shapes: `{ content: string }` (text), `{ error: string }` (failure),
 *   `{ [key: string]: any }` (structured data). Callers should handle `error` keys.
 */
export async function runTool(tc) {
  const { name, arguments: argsStr } = tc.function;
  const args = JSON.parse(argsStr);
  const planMode = getPlanMode();

  // Hard block: plan mode prevents ALL write operations at execution level
  if (planMode) {
    const WRITE_TOOLS = new Set(["bash", "file_write", "file_edit", "create_skill", "git_commit", "git_branch"]);
    const GH_WRITE_ACTIONS = { gh_pr: ["create", "merge", "close", "checkout"], gh_issue: ["create", "close", "reopen", "comment"], gh_repo: ["create", "clone"] };
    if (WRITE_TOOLS.has(name)) {
      return { error: `🚫 计划模式下禁止执行 "${name}" 操作。请先制定计划，等用户确认后再执行。` };
    }
    if (GH_WRITE_ACTIONS[name] && GH_WRITE_ACTIONS[name].includes(args.action)) {
      return { error: `🚫 计划模式下禁止执行 "${name}(${args.action})" 操作。请先制定计划，等用户确认后再执行。` };
    }
  }

  // ── PreToolUse hook ──
  const hookResult = await hookManager.fire("PreToolUse", { tool: name, args });
  if (hookResult?.blocked) {
    return { error: `Hook 拦截: ${hookResult.reason}` };
  }
  if (hookResult?.modified) {
    Object.assign(args, hookResult.args);
  }

  switch (name) {
    case "bash": {
      if (isDangerous(args.command)) {
        const ok = await requestPermission(args.command);
        if (!ok) return { error: "User denied this command" };
      }
      const r = await runShell(args.command);
      if (r.error) return { error: r.error };
      // P2: pagination support — let the LLM ask for head/tail/offset slices
      // when the output exceeds MAX_OUTPUT (60KB). Without this, the LLM gets
      // only the first 60KB and the tail is silently lost.
      let outStr = r.out;
      if (r.err) outStr = outStr + "\n--- stderr ---\n" + r.err;
      const fullLength = outStr.length;
      const fullLines = outStr.split("\n");
      const totalLines = fullLines.length;
      let truncated = false;
      let slicedOut = outStr;
      let slicedLines = null;
      const offset = Number.isFinite(args.offset) ? Math.max(0, Math.floor(args.offset)) : 0;
      const head = Number.isFinite(args.head) ? Math.max(0, Math.floor(args.head)) : 0;
      const tail = Number.isFinite(args.tail) ? Math.max(0, Math.floor(args.tail)) : 0;
      if (head > 0) {
        slicedLines = fullLines.slice(offset, offset + head);
        slicedOut = slicedLines.join("\n");
        truncated = (offset + head) < totalLines;
      } else if (tail > 0) {
        const start = Math.max(0, totalLines - tail);
        slicedLines = fullLines.slice(start, start + tail);
        slicedOut = slicedLines.join("\n");
        truncated = start > 0;
      } else if (outStr.length > MAX_OUTPUT) {
        slicedOut = outStr.slice(0, MAX_OUTPUT);
        truncated = true;
      }
      const result = {
        stdout: r.out,
        stderr: r.err,
        exit_code: r.code,
        output: slicedOut + (truncated ? `\n\n... (truncated: total ${fullLength} chars / ${totalLines} lines. Pass head=N or tail=N to see specific range, or offset=N to start at line N.)` : ""),
      };
      if (truncated) {
        result.truncated = true;
        result.totalLength = fullLength;
        result.totalLines = totalLines;
        result.hint = "Output was truncated. Re-run with head=N (first N lines), tail=N (last N lines), or offset=N (start at line N) to see specific parts.";
      }
      return result;
    }
    case "file_read": {
      try {
        const content = await readFile(args.path, "utf-8");
        if (content.length > MAX_OUTPUT) return { content: content.slice(0, MAX_OUTPUT) + `\n...(truncated ${content.length} chars)`, size: content.length };
        return { content, size: content.length };
      } catch (e) { return { error: e.message }; }
    }
    case "file_write": {
      try {
        const dir = dirname(args.path);
        if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
        await writeFile(args.path, args.content, "utf-8");
        return { success: true, path: args.path };
      } catch (e) { return { error: e.message }; }
    }
    case "file_edit": {
      try {
        const content = await readFile(args.path, "utf-8");
        if (!args.old_string) return { error: "old_string is required" };
        // P1 fix: find all occurrences (not just first via String.replace)
        // and require exactly one match by default, or explicit replaceAll=true.
        const occurrences = [];
        let from = 0;
        while (true) {
          const idx = content.indexOf(args.old_string, from);
          if (idx === -1) break;
          // Compute line number for better error messages
          const lineNum = content.slice(0, idx).split("\n").length;
          occurrences.push({ index: idx, line: lineNum });
          from = idx + args.old_string.length;
        }
        if (occurrences.length === 0) {
          return {
            error: `old_string not found in file. The exact substring was not located. Use file_read to inspect the file, or check whitespace/line endings.`,
            hint: "Note: the match is exact (no fuzzy/partial). Whitespace, line endings, and indentation must match exactly.",
          };
        }
        if (occurrences.length > 1 && !args.replaceAll) {
          return {
            error: `old_string matches ${occurrences.length} locations in the file (lines: ${occurrences.map(o => o.line).join(", ")}). file_edit requires an exact match. Either include more surrounding context in old_string to make it unique, or pass replaceAll=true if you intentionally want to replace all occurrences.`,
            matches: occurrences.map(o => ({ line: o.line, column: 0 })),
          };
        }
        const newContent = args.replaceAll
          ? content.split(args.old_string).join(args.new_string)
          : content.slice(0, occurrences[0].index) + args.new_string + content.slice(occurrences[0].index + args.old_string.length);
        await writeFile(args.path, newContent, "utf-8");
        return {
          success: true,
          path: args.path,
          replaced: occurrences.length,
          replaceAll: !!args.replaceAll,
          firstMatchLine: occurrences[0].line,
        };
      } catch (e) { return { error: e.message }; }
    }
    case "grep": {
      try {
        const dir = args.path || getWorkspace();
        const esc = s => String(s).replace(/'/g, "''");
        let cmd;
        if (IS_WINDOWS) {
          const filter = args.include ? `-Include '${esc(args.include)}'` : "";
          cmd = `Get-ChildItem -Path '${esc(dir)}' -Recurse ${filter} -File | Select-String -Pattern '${esc(args.pattern)}' | Select-Object -First 100 | % { "$($_.Filename):$($_.LineNumber): $($_.Line.Trim())" }`;
        } else {
          // POSIX: grep -rn supports --include='*.ext' glob for filtering
          const include = args.include ? `--include='${esc(args.include)}'` : "";
          cmd = `grep -rn ${include} '${esc(args.pattern)}' '${esc(dir)}' 2>/dev/null | head -n 100`;
        }
        const r = await runShell(cmd, { timeout: 15000 });
        if (r.error) return { error: r.error };
        return { matches: r.out.trim().split("\n").filter(Boolean) };
      } catch (e) { return { error: e?.message || String(e) }; }
    }
    case "glob": {
      try {
        const dir = args.path || getWorkspace();
        const esc = s => String(s).replace(/'/g, "''");
        let cmd;
        if (IS_WINDOWS) {
          cmd = `Get-ChildItem -Path '${esc(dir)}' -Recurse -Filter '${esc(args.pattern)}' | Select-Object -First 200 -ExpandProperty FullName`;
        } else {
          // POSIX: find -name 'pattern' (also use -path for ** support; basic -name is enough here)
          cmd = `find '${esc(dir)}' -name '${esc(args.pattern)}' 2>/dev/null | head -n 200`;
        }
        const r = await runShell(cmd, { timeout: 15000 });
        if (r.error) return { error: r.error };
        return { files: r.out.trim().split("\n").filter(Boolean).map(s => s.trim()) };
      } catch (e) { return { error: e?.message || String(e) }; }
    }
    case "web_fetch": {
      try {
        if (!isSafeUrl(args.url)) return { error: `URL not allowed. Only https?:// to public hosts are permitted.` };
        const maxLen = Math.min(args.max_length || 8000, 50000);
        const res = await fetch(args.url, {
          headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" },
          signal: AbortSignal.timeout(20000),
        });
        if (!res.ok) return { error: `HTTP ${res.status}: ${res.statusText}` };
        const html = await res.text();
        const text = html
          .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
          .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
          .replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi, "")
          .replace(/<header[^>]*>[\s\S]*?<\/header>/gi, "")
          .replace(/<footer[^>]*>[\s\S]*?<\/footer>/gi, "")
          .replace(/<[^>]+>/g, " ")
          .replace(/&[a-z]+;/g, " ")
          .replace(/\s+/g, " ")
          .trim();
        const truncated = text.length > maxLen ? text.slice(0, maxLen) + `\n...(truncated ${text.length} chars)` : text;
        return { content: truncated, url: args.url, size: text.length };
      } catch (e) { return { error: e.message }; }
    }
    case "web_search": {
      try {
        const maxRes = Math.min(args.max_results || 5, 10);
        const query = args.query;
        const savedPref = readSearchProviderPref();
        const provider = savedPref || "tavily";

        // ── Tavily (paid, needs API key) ───────────────────────
        if (provider === "tavily") {
          let tavilyKey = process.env.TAVILY_API_KEY;
          if (!tavilyKey) {
            try {
              const keyPath = join(homedir(), ".aideagent", "api-keys.enc");
              if (existsSync(keyPath)) {
                const data = readFileSync(keyPath);
                const store = safeStorage.isEncryptionAvailable()
                  ? JSON.parse(safeStorage.decryptString(data))
                  : JSON.parse(data.toString("utf8"));
                tavilyKey = store.tavily;
              }
            } catch { /* fallback */ }
          }
          if (tavilyKey) {
            const res = await fetch("https://api.tavily.com/search", {
              method: "POST",
              headers: { "Content-Type": "application/json", Authorization: `Bearer ${tavilyKey}` },
              body: JSON.stringify({ query, max_results: maxRes, search_depth: "basic", topic: "general", include_answer: false }),
              signal: AbortSignal.timeout(15000),
            });
            if (res.ok) {
              const data = await res.json();
              return { query, provider: "tavily", results: data.results?.map(r => ({ title: r.title, url: r.url, content: r.content, score: r.score })) || [] };
            }
          }
          // Tavily unavailable → fall through to metasearch
        }

        // ── Meta-search (free, Bing + DDG + GitHub, no API key) ──
        const meta = await searchMeta(query, maxRes);
        return {
          query: meta.query,
          provider: "metasearch",
          results: meta.results,
          ...(meta._warnings ? { _note: meta._warnings } : {}),
        };
      } catch (e) { return { error: e.message }; }
    }
    case "list_tools": {
      // P2-4: Authoritative tools inventory for the LLM.
      // The LLM already sees tool defs in its own context, but this tool
      // provides a structured summary with category breakdown and shadowing
      // detection (built-in tool names that are also exposed by MCP).
      try {
        const { getAllToolDefs } = await import("./format-adapters.mjs");
        const defs = getAllToolDefs(true, true) || [];
        // Categorize by inspecting name + description
        const categorize = (name) => {
          if (["file_read", "file_write", "file_edit", "grep", "glob", "lsp"].includes(name)) return "file";
          if (name === "bash") return "shell";
          if (["web_search", "web_fetch"].includes(name)) return "web";
          if (["git_diff", "git_commit", "git_branch"].includes(name)) return "git";
          if (["gh_pr", "gh_issue", "gh_repo"].includes(name)) return "github";
          if (["kb_search", "kb_write", "kb_get_note"].includes(name)) return "kb";
          if (["TaskCreate", "TaskUpdate", "TaskList", "TodoWrite", "AskUserQuestion", "Agent"].includes(name)) return "task";
          if (["skill", "invoke_skill", "create_skill", "list_skills"].includes(name)) return "skill";
          if (name === "write_memory") return "memory";
          if (["list_memories", "list_kb", "list_mcp", "list_tools"].includes(name)) return "meta";
          return "other";
        };
        const byCategory = {};
        const builtins = new Set();
        const allNames = [];
        for (const d of defs) {
          const n = d.function.name;
          allNames.push(n);
          const cat = categorize(n);
          byCategory[cat] = (byCategory[cat] || 0) + 1;
          // Built-in heuristic: built-ins live in tool-definitions.mjs, MCP tools
          // are anything else. Use a list of known built-ins for now.
          const KNOWN_BUILTINS = new Set([
            "bash", "file_read", "file_write", "file_edit", "grep", "glob", "lsp",
            "web_search", "web_fetch", "write_memory", "skill", "invoke_skill", "create_skill",
            "TaskCreate", "TaskUpdate", "TaskList", "TodoWrite", "AskUserQuestion", "Agent",
            "kb_search", "kb_write", "kb_get_note",
            "git_diff", "git_commit", "git_branch", "gh_pr", "gh_issue", "gh_repo",
            "list_skills", "list_memories", "list_kb", "list_mcp", "list_tools",
          ]);
          if (KNOWN_BUILTINS.has(n)) builtins.add(n);
        }
        // Shadowing: a tool name that exists in BOTH the built-in set AND
        // the MCP-only set. The LLM needs this to disambiguate which one
        // a bare `web_search(...)` call would route to.
        const shadowing = allNames.filter(n => {
          // If name appears more than once in defs, it's shadowed
          return allNames.indexOf(n) !== allNames.lastIndexOf(n);
        });
        const uniqueShadowing = [...new Set(shadowing)];
        return {
          total: defs.length,
          builtinCount: builtins.size,
          mcpCount: defs.length - builtins.size,
          byCategory,
          currentMode: getPlanMode() ? "plan" : "normal",
          shadowing: uniqueShadowing,
          shadowingNote: uniqueShadowing.length > 0
            ? `These tool names exist in both built-in and MCP forms. The runtime dispatch order is: MCP tools first, then built-in. To force built-in, the user must disable the MCP server in Settings → MCP.`
            : "No tool name conflicts detected.",
          // Per-tool summary (not full schemas to save tokens)
          tools: defs.map(d => ({
            name: d.function.name,
            category: categorize(d.function.name),
            description: (d.function.description || "").slice(0, 200),
          })),
        };
      } catch (e) { return { error: e.message }; }
    }
    case "list_mcp": {
      // P2-3: Authoritative MCP inventory for the LLM.
      // Prevents the failure mode of agent guessing which MCP servers exist
      // or trying to probe their state via filesystem.
      try {
        const all = mcpManager.listServers() || [];
        const statusFilter = args.statusFilter && args.statusFilter !== "all" ? args.statusFilter : null;
        const serverFilter = typeof args.serverName === "string" ? args.serverName : null;
        let filtered = all;
        if (statusFilter) filtered = filtered.filter(s => s.status === statusFilter);
        if (serverFilter) filtered = filtered.filter(s => s.name === serverFilter);
        // If a single server requested, return expanded tool details
        if (serverFilter && filtered.length === 1) {
          const s = filtered[0];
          return {
            name: s.name,
            status: s.status,
            error: s.error || null,
            toolCount: (s.tools || []).length,
            tools: (s.tools || []).map(t => ({ name: t.name, description: t.description })),
            config: s.config || null,
          };
        }
        // Summary view
        const byStatus = {};
        let totalTools = 0;
        for (const s of all) {
          byStatus[s.status || "unknown"] = (byStatus[s.status || "unknown"] || 0) + 1;
          totalTools += (s.tools || []).length;
        }
        return {
          totalServers: all.length,
          totalTools,
          byStatus,
          servers: filtered.map(s => ({
            name: s.name,
            status: s.status,
            toolCount: (s.tools || []).length,
            toolNames: (s.tools || []).map(t => t.name),
          })),
        };
      } catch (e) { return { error: e.message }; }
    }
    case "list_kb": {
      // P2-2: Authoritative KB inventory for the LLM.
      // Prevents the failure mode of agent bash-exploring the user's vault
      // and trying to manually traverse subdirectories.
      try {
        const vault = kb.getVault() || null;
        if (!vault) {
          return {
            total: 0,
            byPath: {},
            notes: [],
            canonicalPath: null,
            warning: "No knowledge base vault configured. User must set one in Settings → 知识库 before KB tools can be used.",
          };
        }
        const limit = Number.isFinite(args.limit) ? Math.max(1, Math.min(500, Math.floor(args.limit))) : 50;
        const offset = Number.isFinite(args.offset) ? Math.max(0, Math.floor(args.offset)) : 0;
        const result = kb.listNotes(offset, limit);
        const byPath = {};
        for (const n of (result.notes || [])) {
          const dir = (n.rel_path || "").split(/[\\/]/).slice(0, -1).join("/") || "(root)";
          byPath[dir] = (byPath[dir] || 0) + 1;
        }
        return {
          total: result.total || 0,
          returned: (result.notes || []).length,
          offset,
          limit,
          byPath,
          canonicalPath: vault,
          warning: "These are the indexed KB notes. Do not bash/grep the vault directory directly — that bypasses the FTS5+vector index and is much slower.",
          notes: (result.notes || []).map(n => ({
            id: n.id,
            rel_path: n.rel_path,
            title: n.title,
            size: n.size,
            mtime: n.mtime_ms ? new Date(n.mtime_ms).toISOString() : null,
          })),
        };
      } catch (e) { return { error: e.message }; }
    }
    case "list_memories": {
      // P2-1: Authoritative structured memory inventory for the LLM.
      // Prevents the failure mode of agent bash-exploring ~/.aideagent/memories
      // and mistaking unrelated markdown files for memories.
      try {
        const all = memory.listMemories() || [];
        const typeFilter = args.type && args.type !== "all" ? args.type : null;
        const searchTerm = typeof args.search === "string" ? args.search.toLowerCase().trim() : "";
        let filtered = typeFilter ? all.filter(m => m.type === typeFilter) : all;
        if (searchTerm) {
          filtered = filtered.filter(m =>
            (m.name || "").toLowerCase().includes(searchTerm) ||
            (m.description || "").toLowerCase().includes(searchTerm) ||
            (m.filename || "").toLowerCase().includes(searchTerm)
          );
        }
        const byType = {};
        for (const m of all) {
          const t = m.type || "unknown";
          byType[t] = (byType[t] || 0) + 1;
        }
        // Also count USER.md and MEMORY.md size for total context awareness
        const home = require("node:os").homedir();
        const userPath = require("node:path").join(home, ".aideagent", "memories", "USER.md");
        const memoryPath = require("node:path").join(home, ".aideagent", "memories", "MEMORY.md");
        const fileMeta = {};
        for (const [label, p] of [["USER.md", userPath], ["MEMORY.md", memoryPath]]) {
          try {
            const stat = require("node:fs").statSync(p);
            fileMeta[label] = { path: p, size: stat.size, mtime: stat.mtime.toISOString() };
          } catch { /* not present */ }
        }
        return {
          total: all.length,
          byType,
          filtered: filtered.length,
          canonicalPath: "~/.aideagent/memory/",
          specialFiles: fileMeta,
          warning: "These are the canonical memory files. Files in `~/.aideagent/memories/` (note the trailing 's') are unrelated markdown and are NOT memories.",
          memories: filtered.map(m => ({
            filename: m.filename,
            name: m.name,
            description: m.description,
            type: m.type,
            mtime: new Date(m.mtimeMs || 0).toISOString(),
          })),
        };
      } catch (e) { return { error: e.message }; }
    }
    case "list_skills": {
      // Fix-2: Authoritative structured skill inventory for the LLM.
      // Prevents the failure mode of agent bash-exploring D:\claude_skills\ and
      // mistaking a third-party clone for an installed skill source.
      try {
        const all = scanSkills();
        const sourceFilter = args.source && args.source !== "all" ? args.source : null;
        let filtered = sourceFilter ? all.filter(s => s.source === sourceFilter) : all;
        // Per-skill lookup short-circuit
        if (args.name) {
          const target = filtered.find(s => s.name === args.name);
          if (!target) {
            const allNames = all.filter(s => !sourceFilter || s.source === sourceFilter).map(s => `\`${s.name}\``).join(", ");
            return { error: `Skill "${args.name}" not found in loaded skills. Available: ${allNames || "(none)"}` };
          }
          return {
            name: target.name,
            description: target.description,
            version: target.version,
            source: target.source,
            sourcePath: target.path,
            triggers: target.triggers || [],
            allowedTools: target.allowedTools || [],
          };
        }
        // Aggregate view
        const bySource = {};
        const nameCount = new Map();
        for (const s of filtered) {
          bySource[s.source || "unknown"] = (bySource[s.source || "unknown"] || 0) + 1;
          nameCount.set(s.name, (nameCount.get(s.name) || 0) + 1);
        }
        const includeDuplicates = args.includeDuplicates !== false; // default true
        const duplicateNames = includeDuplicates
          ? [...nameCount.entries()].filter(([, n]) => n > 1).map(([n, c]) => ({ name: n, occurrences: c }))
          : [];
        return {
          total: filtered.length,
          bySource,
          canonicalPaths: {
            agents: "~/​.agents/skills/",
            claude: "~/​.claude/skills/",
          },
          warning: "These are the ONLY canonical skill sources. Files in other directories (e.g. D:\\claude_skills\\skills-main\\skills\\) are third-party GitHub clones and are NOT loadable via the `skill` tool.",
          duplicates: duplicateNames,
          duplicatesCount: duplicateNames.length,
          skills: filtered.map(s => ({
            name: s.name,
            description: s.description,
            source: s.source,
            version: s.version,
            triggers: s.triggers || [],
          })),
        };
      } catch (e) { return { error: e.message }; }
    }
    case "skill": {
      // P2 fix: unified lookup — L2 (agent-created) first, L3 (installed) fallback.
      // Previously this only searched L3 installed skills, forcing the LLM to pick
      // between two near-identical tools (`skill` vs `invoke_skill`). Now both names
      // work the same way. `invoke_skill` is kept as a deprecated alias below.
      try {
        let skill = /** @type {any} */ (skills.loadSkill(args.name));
        let tier = "L2";
        if (!skill) {
          const installedSkills = scanSkills();
          skill = installedSkills.find(s => s.name === args.name);
          tier = "L3";
        }
        if (!skill) {
          const l2 = skills.listSkills().map(s => s.name).join(", ");
          const l3 = scanSkills().map(s => s.name).join(", ");
          const all = [...new Set([...l2.split(", "), ...l3.split(", ")].filter(Boolean))].join(", ");
          return { error: `Skill "${args.name}" not found. Available skills: ${all || "(none)"}` };
        }
        skills.recordSkillUsage(args.name, true);
        return {
          name: skill.name,
          description: skill.description,
          content: skill.body || skill.content || readFileSync(skill.path, "utf-8"),
          tier,
        };
      } catch (e) { return { error: e.message }; }
    }
    case "write_memory": {
      try {
        const { type, content, name, description, filename } = args;
        if (!type || !content) return { error: "type and content required" };
        if (memory.checkDuplicate(type, content)) return { note: "Similar memory already exists — nothing new added" };

        const memName = name || (type + "_" + Date.now().toString(36));
        const memDesc = description || "Memory of type " + type;

        if (filename) {
          const result = memory.updateMemory(filename, content, memName, memDesc, type);
          if (result.error) return result;
          return { saved: true, type, name: memName, filename: result.filename || filename, updated: true };
        }

        const result = memory.createMemory(memName, memDesc, type, content);
        if (result.error) return result;
        return { saved: true, type, name: result.name, filename: result.filename };
      } catch (e) { return { error: e.message }; }
    }
    case "invoke_skill": {
      // Deprecated alias for `skill` (P2: unified the two tools).
      // We re-route to the same handler to keep the unified behavior,
      // and tag the response so callers can see they hit the old name.
      try {
        let skill = /** @type {any} */ (skills.loadSkill(args.name));
        let tier = "L2";
        if (!skill) {
          const installedSkills = scanSkills();
          skill = installedSkills.find(s => s.name === args.name);
          tier = "L3";
        }
        if (!skill) {
          const l2 = skills.listSkills().map(s => s.name).join(", ");
          const l3 = scanSkills().map(s => s.name).join(", ");
          const all = [...new Set([...l2.split(", "), ...l3.split(", ")].filter(Boolean))].join(", ");
          return { error: `Skill "${args.name}" not found. Available skills: ${all || "(none)"}` };
        }
        skills.recordSkillUsage(args.name, true);
        return {
          name: skill.name,
          description: skill.description,
          content: skill.body || skill.content || readFileSync(skill.path, "utf-8"),
          tier,
          _deprecated: "invoke_skill is an alias for `skill`; please use `skill` going forward",
        };
      } catch (e) { return { error: e.message }; }
    }
    case "create_skill": {
      try {
        const { name, description, prompt } = args;
        // skills.loadSkill returns full meta (triggers, version, created_at) but
        // TS infers a narrow shape — cast to any for accessing the full fields.
        const existing = /** @type {any} */ (skills.loadSkill(name));
        const loadWxConfig = await getLoadWxConfig();
        const cfg = loadWxConfig();
        const apiConfig = getLastApiConfig();
        const apiKey = cfg.apiKey || apiConfig.apiKey;
        const apiUrl = cfg.apiUrl || apiConfig.apiUrl;
        const model = cfg.model || apiConfig.model;
        if (!apiKey || !apiUrl) return { error: "API not configured — configure in Settings first" };

        const genPrompt = existing
          ? `IMPROVE this existing skill with new information. Current skill content:\n\n${existing.body || ""}\n\nImprovements to add: ${prompt}\n\nMerge the improvements into the existing steps and notes. Keep all useful existing content.`
          : `Create a reusable skill for: ${prompt}`;

        const result = await skills.generateSkill(genPrompt, apiKey, apiUrl, model);
        if (result.error) return result;

        const parsed = result.skill || "";
        const fmMatch = parsed.match(/^---\s*\n([\s\S]*?)\n---/);
        const genBody = fmMatch ? parsed.slice(fmMatch[0].length).trim() : parsed;

        const bumpVersion = await getBumpVersion();
        const meta = {
          name,
          description,
          triggers: existing?.triggers || [name],
          version: existing ? bumpVersion(existing.version || "1.0.0") : "1.0.0",
          status: "active",
          created_at: existing?.created_at || new Date().toISOString(),
          updated_at: new Date().toISOString(),
        };
        return skills.saveSkill(name, meta, genBody);
      } catch (e) { return { error: e.message }; }
    }
    case "TaskCreate": {
      const id = randomUUID();
      const task = {
        id, subject: args.subject, description: args.description,
        status: "pending", activeForm: args.activeForm || args.subject,
        owner: "", metadata: args.metadata || {}, createdAt: new Date().toISOString(),
      };
      taskStore.set(id, task);
      persistSessionState();
      return { task: { id, subject: task.subject } };
    }
    case "TaskUpdate": {
      const t = taskStore.get(args.taskId);
      if (!t) return { error: `Task ${args.taskId} not found` };
      const updatedFields = [];
      if (args.status === "deleted") {
        taskStore.delete(args.taskId);
        persistSessionState();
        return { success: true, taskId: args.taskId, updatedFields: ["status"], statusChange: { from: t.status, to: "deleted" } };
      }
      // ── Evidence required to mark a task completed (P0 anti-hallucination) ──
      // Forces the LLM to attach proof: command output, file path, or diff summary.
      // Empty evidence is accepted but recorded as "unverified" so users can see it.
      if (args.status === "completed") {
        if (!args.evidence || (typeof args.evidence === "string" && args.evidence.trim().length === 0)) {
          t.evidence = null;
          t.unverified = true;
          updatedFields.push("unverified");
        } else if (typeof args.evidence === "string") {
          t.evidence = args.evidence.trim().slice(0, 1000);
          t.unverified = false;
          updatedFields.push("evidence");
        } else {
          return { error: "evidence must be a string (e.g. command output, file path, or diff summary)" };
        }
        t.completedAt = new Date().toISOString();
        updatedFields.push("completedAt");
      }
      if (args.status) { t.status = args.status; taskStore.set(args.taskId, t); updatedFields.push("status"); }
      if (args.subject) { t.subject = args.subject; taskStore.set(args.taskId, t); updatedFields.push("subject"); }
      if (args.description) { t.description = args.description; taskStore.set(args.taskId, t); updatedFields.push("description"); }
      t.updatedAt = new Date().toISOString();
      persistSessionState();
      return { success: true, taskId: args.taskId, updatedFields, unverified: t.unverified || false };
    }
    case "TaskList": {
      const tasks = Array.from(taskStore.values()).filter(t => t.status !== "deleted");
      return {
        tasks: tasks.map(t => ({ id: t.id, subject: t.subject, status: t.status, activeForm: t.activeForm, evidence: t.evidence, unverified: t.unverified || false })),
        summary: `${tasks.filter(t => t.status === "completed").length}/${tasks.length} completed, ${tasks.filter(t => t.status === "in_progress").length} in progress`,
      };
    }
    case "TodoWrite": {
      const oldTodos = [...getTodoList()];
      setTodoList((args.todos || []).map((t, i) => ({ id: `todo_${i + 1}`, content: t.content, status: t.status, activeForm: t.activeForm })));
      persistSessionState();
      return { oldTodos, newTodos: getTodoList() };
    }
    case "Agent": {
      const subAgentId = `sub_${Date.now().toString(36)}${Math.random().toString(36).slice(2,6)}`;
      sendToRenderer("subagent:start", { id: subAgentId, description: args.description });
      try {
        const runSubAgent = await getRunSubAgent();
        const result = await runSubAgent(args.description, args.prompt, subAgentId);
        const output = result.text || "(no result)";
        sendToRenderer("subagent:done", { id: subAgentId, description: args.description, output });
        return { output, aborted: result.aborted || false };
      } catch (e) {
        sendToRenderer("subagent:done", { id: subAgentId, description: args.description, error: e.message });
        return { error: e.message };
      }
    }
    case "AskUserQuestion": {
      const questions = args.questions || [];
      if (questions.length === 0) return { error: "At least one question required" };
      return new Promise(resolve => {
        const qId = nextAskId();
        _askResolvers.set(qId, resolve);
        sendToRenderer("ask:question", { id: qId, questions });
        setTimeout(() => {
          if (_askResolvers.has(qId)) {
            _askResolvers.delete(qId);
            resolve({ answers: {}, timed_out: true });
          }
        }, 120_000);
      });
    }
    case "kb_search": {
      try {
        const { query, limit = 5 } = args;
        if (!query) return { error: "query required" };
        const results = await kb.search(query, limit);
        if (results.length === 0) return { results: [], message: "No matching notes found in knowledge base." };
        return {
          results: results.map(r => ({
            title: r.title,
            path: r.rel_path,
            snippet: (r.snippet || "").slice(0, kb.getConfig().maxChars || 10000),
          })),
          count: results.length,
        };
      } catch (e) { return { error: e.message }; }
    }
    case "kb_write": {
      try {
        const { path: notePath, content: noteContent, tags } = args;
        if (!notePath || !noteContent) return { error: "path and content required" };
        const existing = kb.getNote(notePath);
        if (existing) {
          const result = await kb.updateNote(notePath, noteContent);
          return { ...result, action: "updated", path: notePath };
        } else {
          const result = await kb.createNote(notePath, noteContent, tags || []);
          return { ...result, action: "created", path: notePath };
        }
      } catch (e) { return { error: e.message }; }
    }
    case "kb_get_note": {
      try {
        const { path: notePath } = args;
        if (!notePath) return { error: "path required" };
        const note = kb.getNote(notePath);
        if (!note) return { error: `Note not found: ${notePath}` };
        return {
          path: note.rel_path,
          title: note.title,
          content: note.content.slice(0, kb.getConfig().maxChars || 10000),
        };
      } catch (e) { return { error: e.message }; }
    }
    case "lsp": {
      try {
        const { default: lspManager } = await import("../lsp-manager.mjs");
        const op = args.operation;
        let result;
        if (op === "goToDefinition") result = await lspManager.goToDefinition(args.filePath, args.line, args.character);
        else if (op === "findReferences") result = await lspManager.findReferences(args.filePath, args.line, args.character);
        else if (op === "hover") result = await lspManager.hover(args.filePath, args.line, args.character);
        else if (op === "documentSymbol") result = await lspManager.documentSymbol(args.filePath);
        else return { error: `Unknown LSP operation: ${op}` };
        return { operation: op, result: result.text, resultCount: result.count };
      } catch (e) { return { error: `LSP error: ${e.message}` }; }
    }
    case "git_diff": {
      try {
        const cmd = args.staged ? "git diff --cached" : (args.file ? `git diff -- "${args.file}"` : "git diff");
        const r = await runShell(cmd);
        const stat = await runShell("git diff --stat");
        return { diff: r.out || "(no changes)", stats: stat.out || "" };
      } catch (e) { return { error: e.message }; }
    }
    case "git_commit": {
      try {
        if (args.files && args.files.length > 0) {
          for (const f of args.files) await runShell(`git add "${f}"`);
        } else {
          await runShell("git add -A");
        }
        let msg = args.message;
        if (!msg) {
          const diff = await runShell("git diff --cached");
          return { needsMessage: true, diff: (diff.out || "").slice(0, 8000), hint: "请根据以上 diff 生成 commit message，然后再次调用 git_commit 并传入 message 参数。" };
        }
        const gitArgs = ["commit", "-m", msg];
        if (args.amend) gitArgs.unshift("--amend");
        const r = await runSpawnSafe("git", gitArgs);
        return { output: r.out || r.err, success: r.code === 0 };
      } catch (e) { return { error: e.message }; }
    }
    case "git_branch": {
      try {
        let r;
        switch (args.action) {
          case "list": r = await runShell("git branch"); break;
          case "current": r = await runShell("git branch --show-current"); break;
          case "create": r = await runSpawnSafe("git", ["checkout", "-b", args.name]); break;
          case "switch": r = await runSpawnSafe("git", ["checkout", args.name]); break;
          default: return { error: `Unknown action: ${args.action}` };
        }
        return { output: r.out || r.err, success: r.code === 0 };
      } catch (e) { return { error: e.message }; }
    }
    case "gh_pr": {
      try {
        let cmd;
        switch (args.action) {
          case "create": {
            const ghArgs = ["pr", "create"];
            if (args.title) ghArgs.push("--title", args.title);
            if (args.body) ghArgs.push("--body", args.body);
            if (args.base) ghArgs.push("--base", args.base);
            if (args.head) ghArgs.push("--head", args.head);
            const r = await runSpawnSafe("gh", ghArgs);
            return { output: r.out || r.err, success: r.code === 0 };
          }
          case "view": {
            cmd = args.pr ? `gh pr view ${args.pr}` : "gh pr view";
            if (args.json) cmd += " --json number,title,state,author,createdAt,mergedAt,url,headRefName,baseRefName,body,reviewDecision,mergeable,labels,assignees,reviews";
            break;
          }
          case "list": {
            cmd = "gh pr list";
            if (args.state) cmd += ` --state ${args.state}`;
            if (args.limit) cmd += ` --limit ${args.limit}`;
            if (args.reviewer) cmd += ` --reviewer "${args.reviewer}"`;
            if (args.json) cmd += " --json number,title,state,author,createdAt,url,headRefName,baseRefName,reviewDecision,labels";
            break;
          }
          case "diff": {
            if (!args.pr) return { error: "PR number or URL is required for diff" };
            cmd = `gh pr diff ${args.pr}`;
            break;
          }
          case "merge": {
            cmd = args.pr ? `gh pr merge ${args.pr} --merge` : "gh pr merge --merge";
            break;
          }
          case "checkout": {
            if (!args.pr) return { error: "PR number or URL is required for checkout" };
            cmd = `gh pr checkout ${args.pr}`;
            break;
          }
          case "close": {
            if (!args.pr) return { error: "PR number or URL is required for close" };
            cmd = `gh pr close ${args.pr}`;
            break;
          }
          default: return { error: `Unknown gh_pr action: ${args.action}` };
        }
        const r = await runShell(cmd);
        return { output: r.out || r.err, success: r.code === 0 };
      } catch (e) { return { error: e.message }; }
    }
    case "gh_issue": {
      try {
        let cmd;
        switch (args.action) {
          case "create": {
            const ghArgs = ["issue", "create"];
            if (args.title) ghArgs.push("--title", args.title);
            if (args.body) ghArgs.push("--body", args.body);
            const r = await runSpawnSafe("gh", ghArgs);
            return { output: r.out || r.err, success: r.code === 0 };
          }
          case "view": {
            cmd = args.issue ? `gh issue view ${args.issue}` : "gh issue view";
            if (args.json) cmd += " --json number,title,state,author,createdAt,closedAt,url,body,labels,assignees,comments";
            break;
          }
          case "list": {
            cmd = "gh issue list";
            if (args.state) cmd += ` --state ${args.state}`;
            if (args.limit) cmd += ` --limit ${args.limit}`;
            if (args.label) cmd += ` --label "${args.label}"`;
            if (args.assignee) cmd += ` --assignee "${args.assignee}"`;
            if (args.json) cmd += " --json number,title,state,author,createdAt,url,labels,assignees";
            break;
          }
          case "close": {
            if (!args.issue) return { error: "Issue number or URL is required" };
            cmd = `gh issue close ${args.issue}`;
            break;
          }
          case "reopen": {
            if (!args.issue) return { error: "Issue number or URL is required" };
            cmd = `gh issue reopen ${args.issue}`;
            break;
          }
          case "comment": {
            if (!args.issue) return { error: "Issue number or URL is required" };
            if (!args.body) return { error: "Comment body is required" };
            cmd = `gh issue comment ${args.issue} --body "${args.body.replace(/"/g, '\\"')}"`;
            break;
          }
          default: return { error: `Unknown gh_issue action: ${args.action}` };
        }
        const r = await runShell(cmd);
        return { output: r.out || r.err, success: r.code === 0 };
      } catch (e) { return { error: e.message }; }
    }
    case "gh_repo": {
      try {
        let cmd;
        switch (args.action) {
          case "view": {
            cmd = args.repo ? `gh repo view ${args.repo}` : "gh repo view";
            break;
          }
          case "list": {
            cmd = "gh repo list";
            if (args.limit) cmd += ` --limit ${args.limit}`;
            if (args.visibility) cmd += ` --visibility ${args.visibility}`;
            break;
          }
          case "readme": {
            cmd = args.repo ? `gh api repos/${args.repo}/readme -q .content | python -m base64 -d 2>/dev/null || gh api repos/${args.repo}/readme -q .content` : "gh api repos/$(gh repo view --json nameWithOwner -q .nameWithOwner)/readme -q .content";
            break;
          }
          case "clone": {
            if (!args.repo && !args.url) return { error: "Repository (owner/repo) or URL is required" };
            const target = args.repo || args.url;
            cmd = `gh repo clone ${target}`;
            break;
          }
          case "create": {
            if (!args.name) return { error: "Repository name is required" };
            const parts = [`gh repo create "${args.name.replace(/"/g, '\\"')}"`];
            if (args.description) parts.push(`--description "${args.description.replace(/"/g, '\\"')}"`);
            if (args.private) parts.push("--private");
            else parts.push("--public");
            cmd = parts.join(" ");
            break;
          }
          default: return { error: `Unknown gh_repo action: ${args.action}` };
        }
        const r = await runShell(cmd);
        return { output: r.out || r.err, success: r.code === 0 };
      } catch (e) { return { error: e.message }; }
    }
    default: {
      try {
        const mcpResult = await mcpManager.callTool(name, args);
        const contentText = (mcpResult.content || [])
          .map(c => c.type === "text" ? c.text : JSON.stringify(c))
          .join("\n");
        const result = mcpResult.isError
          ? { error: contentText }
          : { output: contentText };
        return result;
      } catch (mcpErr) {
        return { error: `Unknown tool: ${name} (MCP: ${mcpErr.message})` };
      }
    }
  }
}
