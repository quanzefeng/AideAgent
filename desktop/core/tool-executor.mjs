// ── Tool Executor — runTool dispatch ────────────────────────

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import * as memory from "../memory-store.mjs";
import * as skills from "../skills-store.mjs";
import * as kb from "../knowledge-store.mjs";
import mcpManager from "../mcp-manager.mjs";
import { scanSkills } from "./skill-scanner.mjs";
import * as hookManager from "./hook-manager.mjs";
import {
  SHELL, IS_WINDOWS, getWorkspace, MAX_OUTPUT, DANGEROUS, GIT_SAFE, GH_SAFE,
  getPlanMode, pendingPerms, nextPermId, sendToRenderer,
  taskStore, getTodoList, setTodoList,
  _askResolvers, nextAskId,
  getLastApiConfig,
} from "./state.mjs";

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
      const outStr = r.err ? r.out + "\n--- stderr ---\n" + r.err : r.out;
      const truncated = outStr.length > MAX_OUTPUT ? outStr.slice(0, MAX_OUTPUT) + `\n...(truncated ${outStr.length} chars)` : outStr;
      return { stdout: r.out, stderr: r.err, exit_code: r.code, output: truncated };
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
        if (!content.includes(args.old_string)) return { error: "old_string not found in file" };
        await writeFile(args.path, content.replace(args.old_string, args.new_string), "utf-8");
        return { success: true, path: args.path };
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
        const apiKey = process.env.TAVILY_API_KEY;
        if (!apiKey) return { error: "TAVILY_API_KEY environment variable not set. Set it to enable web search." };
        const res = await fetch("https://api.tavily.com/search", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
          body: JSON.stringify({ query: args.query, max_results: maxRes, search_depth: "basic", topic: "general", include_answer: false }),
          signal: AbortSignal.timeout(15000),
        });
        if (!res.ok) return { error: `Tavily API ${res.status}: ${res.statusText}` };
        const data = await res.json();
        return { query: args.query, results: data.results?.map(r => ({ title: r.title, url: r.url, content: r.content, score: r.score })) || [] };
      } catch (e) { return { error: e.message }; }
    }
    case "skill": {
      try {
        const installedSkills = scanSkills();
        const skill = installedSkills.find(s => s.name === args.name);
        if (!skill) return { error: `Skill "${args.name}" not found. Available: ${installedSkills.map(s => s.name).join(", ")}` };
        const content = readFileSync(skill.path, "utf-8");
        return { name: skill.name, description: skill.description, content };
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
      try {
        let skill = skills.loadSkill(args.name);
        // Fallback to L3 installed skills
        if (!skill) {
          const installedSkills = scanSkills();
          skill = installedSkills.find(s => s.name === args.name);
        }
        if (!skill) {
          const l2 = skills.listSkills().map(s => s.name).join(", ");
          const l3 = scanSkills().map(s => s.name).join(", ");
          const all = [...new Set([...l2.split(", "), ...l3.split(", ")].filter(Boolean))].join(", ");
          return { error: `Skill "${args.name}" not found. Available skills: ${all || "(none)"}` };
        }
        skills.recordSkillUsage(args.name, true);
        return { name: skill.name, description: skill.description, content: skill.body || skill.content || "(no instructions)" };
      } catch (e) { return { error: e.message }; }
    }
    case "create_skill": {
      try {
        const { name, description, prompt } = args;
        const existing = skills.loadSkill(name);
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
      return { task: { id, subject: task.subject } };
    }
    case "TaskUpdate": {
      const t = taskStore.get(args.taskId);
      if (!t) return { error: `Task ${args.taskId} not found` };
      const updatedFields = [];
      if (args.status === "deleted") {
        taskStore.delete(args.taskId);
        return { success: true, taskId: args.taskId, updatedFields: ["status"], statusChange: { from: t.status, to: "deleted" } };
      }
      if (args.status) { t.status = args.status; taskStore.set(args.taskId, t); updatedFields.push("status"); }
      if (args.subject) { t.subject = args.subject; taskStore.set(args.taskId, t); updatedFields.push("subject"); }
      if (args.description) { t.description = args.description; taskStore.set(args.taskId, t); updatedFields.push("description"); }
      return { success: true, taskId: args.taskId, updatedFields };
    }
    case "TaskList": {
      const tasks = Array.from(taskStore.values()).filter(t => t.status !== "deleted");
      return {
        tasks: tasks.map(t => ({ id: t.id, subject: t.subject, status: t.status, activeForm: t.activeForm })),
        summary: `${tasks.filter(t => t.status === "completed").length}/${tasks.length} completed, ${tasks.filter(t => t.status === "in_progress").length} in progress`,
      };
    }
    case "TodoWrite": {
      const oldTodos = [...getTodoList()];
      setTodoList((args.todos || []).map((t, i) => ({ id: `todo_${i + 1}`, content: t.content, status: t.status, activeForm: t.activeForm })));
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
