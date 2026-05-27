import { app, BrowserWindow, ipcMain, dialog, session, Menu } from "electron";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, execSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, statSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { randomUUID } from "node:crypto";
import QRCode from "qrcode";
import os from "node:os";
import { readFile, writeFile, mkdir, readdir, unlink } from "node:fs/promises";
import mcpManager from "./mcp-manager.mjs";
import sessionDb from "./session-db.mjs";
import * as memory from "./memory-store.mjs";
import * as skills from "./skills-store.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
app.commandLine.appendSwitch("no-sandbox");
const isDev = process.argv.includes("--dev");

// Prefer pwsh (PowerShell 7+ with native UTF-8) over powershell.exe (uses system code page, breaks on Chinese)
const PS_EXE = (() => { try { execSync("where pwsh", { stdio: "ignore" }); return "pwsh"; } catch { return "powershell"; } })();

function bumpVersion(ver) {
  const parts = ver.split(".").map(Number);
  parts[2] = (parts[2] || 0) + 1;
  return parts.join(".");
}

// ── Window Management ──────────────────────────────────────
let mainWindow = null;

function createWindow() {
  const preloadPath = join(__dirname, "preload.cjs").replace(/\\/g, "/");
  console.log("[main] preload path:", preloadPath);
  console.log("[main] preload exists:", existsSync(preloadPath));

  // Register preload script using Electron 40+ API
  // session.setPreloads is deprecated - replaced by registerPreloadScript
  try {
    if (session?.defaultSession?.registerPreloadScript) {
      session.defaultSession.registerPreloadScript({ type: "frame", filePath: preloadPath });
      console.log("[main] registerPreloadScript called (global)");
    }
  } catch (e) {
    console.error("[main] session preload registration error:", e.message);
  }

  mainWindow = new BrowserWindow({
    width: 1200, height: 800,
    minWidth: 800, minHeight: 600,
    title: "AI Code Chat",
    icon: join(__dirname, "icon.ico"),
    backgroundColor: "#0a0a0f",
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      sandbox: false,
      webSecurity: false,
      allowRunningInsecureContent: true,
    },
  });

  // Remove default Electron menu (File/Edit/View/Window/Help)
  Menu.setApplicationMenu(null);

  // Catch preload errors
  mainWindow.webContents.on("preload-error", (event, preloadPath, error) => {
    console.error("[main] PRELOAD ERROR:", preloadPath, error.message);
  });

  mainWindow.webContents.on("did-finish-load", () => {
    // Verify preload exposed the API by checking from renderer via executeJavaScript
    mainWindow.webContents.executeJavaScript("typeof window.goodAgent !== 'undefined'").then((hasAPI) => {
      console.log("[main] window.goodAgent available in renderer:", hasAPI);
      if (!hasAPI) {
        console.error("[main] PRELOAD FAILED - window.goodAgent is undefined!");
      }
    }).catch((err) => {
      console.error("[main] preload verification error:", err.message);
    });
  });

  mainWindow.webContents.on("did-fail-load", (event, errorCode, errorDescription) => {
    console.error("[main] FAIL LOAD:", errorCode, errorDescription);
  });

  mainWindow.loadFile(join(__dirname, "renderer", "index.html"));
  if (isDev) mainWindow.webContents.openDevTools();
  mainWindow.on("closed", () => { mainWindow = null; });
}

app.whenReady().then(async () => {
  createWindow();
  mcpManager.init().catch(e => console.error("[main] mcpManager.init error:", e.message));
  // Migrate old JSON sessions to SQLite
  try { sessionDb.migrateFromJson(join(app.getPath("userData"), "sessions")); } catch {}
  // Run skill curator on startup
  try { const r = skills.runCurator(); if (r.archived > 0) console.log(`[curator] archived ${r.archived} stale skills`); } catch {}
  // Rebuild SQLite skills index on startup
  try { skills.reindexSkills(); } catch (e) { console.error("[skills-store] reindex:", e.message); }
  // Start curator periodic timer (every 6 hours)
  const CURATOR_INTERVAL = 6 * 60 * 60 * 1000; // 6 hours
  setInterval(() => {
    try { const r = skills.runCurator(); if (r.archived > 0) console.log(`[curator] archived ${r.archived} stale skills`); }
    catch (e) { console.error("[curator] periodic run failed:", e.message); }
  }, CURATOR_INTERVAL);
});
app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
app.on("activate", () => { if (mainWindow === null) createWindow(); });

function sendToRenderer(channel, data) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, data);
  }
}

// ── Skill Scanner ────────────────────────────────────────────
const SKILL_DIRS = [
  join("C:", "Users", "7", ".agents", "skills"),
  join("C:", "Users", "7", ".agents"),
  join("C:", "Users", "7", ".claude", "skills"),
];

function parseFrontMatter(text) {
  const meta = { name: "", description: "", triggers: [], allowed_tools: [] };
  const match = text.match(/^---\s*\n([\s\S]*?)\n---/);
  if (!match) return meta;
  const yaml = match[1];
  const arrayKeys = new Set(["triggers", "allowed_tools", "allowed-tools"]);
  for (const line of yaml.split("\n")) {
    const kv = line.match(/^\s*(\w[\w-]*)\s*:\s*(.+)/);
    if (kv) {
      const key = kv[1];
      const val = kv[2].trim();
      if (val.startsWith("[")) {
        try { meta[key] = JSON.parse(val); } catch {
          // Fallback: split unquoted bracket content
          meta[key] = val.slice(1, -1).split(",").map(s => s.trim().replace(/^['"]|['"]$/g, "")).filter(Boolean);
        }
      } else if (val.startsWith("|") || val.startsWith(">")) {
        // multi-line scalar — skip
      } else if (arrayKeys.has(key)) {
        // Scalar value for array-typed key → wrap or split
        const clean = val.replace(/^["']|["']$/g, "");
        meta[key] = clean.includes(",") ? clean.split(",").map(s => s.trim()).filter(Boolean) : [clean];
      } else {
        meta[key] = val.replace(/^["']|["']$/g, "");
      }
    }
  }
  return meta;
}

function scanSkills() {
  const skills = [];
  const seen = new Set();
  for (const dir of SKILL_DIRS) {
    if (!existsSync(dir)) continue;
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith(".") || entry.name === "node_modules" || entry.name === ".git" || entry.name === "dist") continue;
      const skillPath = join(dir, entry.name, "SKILL.md");
      if (!existsSync(skillPath)) continue;
      // Dedup by name (first wins)
      if (seen.has(entry.name)) continue;
      seen.add(entry.name);
      try {
        const content = readFileSync(skillPath, "utf-8");
        const meta = parseFrontMatter(content);
        skills.push({
          name: meta.name || entry.name,
          description: meta.description || "",
          version: meta.version || "",
          triggers: Array.isArray(meta.triggers) ? meta.triggers : [],
          allowedTools: Array.isArray(meta["allowed-tools"]) ? meta["allowed-tools"] : [],
          path: skillPath,
          source: dir.includes(".agents") ? "agents" : "claude",
        });
      } catch {}
    }
  }
  skills.sort((a, b) => a.name.localeCompare(b.name));
  return skills;
}

// ── Tool Definitions (OpenAI function calling) ─────────────
const TOOL_DEFS = [
  {
    type: "function",
    function: {
      name: "bash",
      description: "Execute a PowerShell command on Windows. Use for file operations, git, npm, running scripts, exploring project structure.",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", description: "The PowerShell command to execute" },
          description: { type: "string", description: "Brief description shown to user" },
        },
        required: ["command"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "file_read",
      description: "Read the full text content of a file.",
      parameters: {
        type: "object", properties: {
          path: { type: "string", description: "Path to the file" },
        }, required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "file_write",
      description: "Create or overwrite a file. Auto-creates parent directories.",
      parameters: {
        type: "object", properties: {
          path: { type: "string", description: "Path to the file" },
          content: { type: "string", description: "The full file content" },
        }, required: ["path", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "file_edit",
      description: "Edit a file by replacing exact matching text (surgical edit).",
      parameters: {
        type: "object", properties: {
          path: { type: "string", description: "Path to the file" },
          old_string: { type: "string", description: "Exact text to find" },
          new_string: { type: "string", description: "Replacement text" },
        }, required: ["path", "old_string", "new_string"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "grep",
      description: "Search file contents with regex. Returns file:line matches.",
      parameters: {
        type: "object", properties: {
          pattern: { type: "string", description: "Regex to search" },
          include: { type: "string", description: "File filter (e.g. *.ts)" },
          path: { type: "string", description: "Directory to search (default: workspace)" },
        }, required: ["pattern"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "glob",
      description: "Find files matching a glob pattern (e.g. **/*.ts, src/**/*.css).",
      parameters: {
        type: "object", properties: {
          pattern: { type: "string", description: "Glob pattern" },
          path: { type: "string", description: "Directory (default: workspace)" },
        }, required: ["pattern"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "web_fetch",
      description: "Fetch a URL and extract readable text content. Use to read web pages, documentation, articles, or API responses.",
      parameters: {
        type: "object", properties: {
          url: { type: "string", description: "The URL to fetch (must start with http:// or https://)" },
          max_length: { type: "number", description: "Maximum characters to return (default: 8000, max: 50000)" },
        }, required: ["url"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "web_search",
      description: "Search the internet for current information. Use when you need up-to-date news, facts, documentation, or data not in training. Returns AI-friendly snippets with source URLs.",
      parameters: {
        type: "object", properties: {
          query: { type: "string", description: "The search query" },
          max_results: { type: "number", description: "Number of results to return (1-10, default: 5)" },
        }, required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "skill",
      description: "Load a user-installed skill (a guided workflow in SKILL.md format). Skills provide step-by-step instructions for specific tasks like code review, QA testing, debugging, deployment, etc. Call this first to see what skills are available, then load the one you need.",
      parameters: {
        type: "object", properties: {
          name: { type: "string", description: "The skill name to load (e.g. 'review', 'qa', 'investigate')" },
        }, required: ["name"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "write_memory",
      description: "Save an important fact to permanent memory. Four types: 'user' (about the user), 'feedback' (guidance/corrections from user), 'project' (ongoing work context), 'reference' (external system pointers). Use 'name' and 'description' fields for future search. If updating, provide 'filename'.\n\nDO NOT save: code patterns/architecture (derivable from files), git history (git log is authoritative), debug solutions (the fix is in the code), info already in CLAUDE.md, or ephemeral task state. Only save non-obvious, non-derivable context.",
      parameters: {
        type: "object", properties: {
          type: { type: "string", enum: ["user", "feedback", "project", "reference"], description: "Memory type: user (personal info/preferences), feedback (user's guidance/corrections), project (ongoing work context), reference (external system pointers)" },
          name: { type: "string", description: "Short descriptive name (e.g. 'user_role', 'feedback_tests_must_hit_db')" },
          description: { type: "string", description: "One-line summary used for relevance search" },
          content: { type: "string", description: "The information to remember, in markdown format. For feedback type: start with the rule, then **Why:** and **How to apply:**." },
          filename: { type: "string", description: "If updating existing memory, provide the filename (e.g. 'user_role.md')" },
        }, required: ["type", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "invoke_skill",
      description: "Load and execute a saved skill. Skills are reusable workflows created by the user or generated by the agent. Call this tool to get the full skill instructions when you need to perform a task that has a matching skill.",
      parameters: {
        type: "object", properties: {
          name: { type: "string", description: "The skill name to invoke" },
        }, required: ["name"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "create_skill",
      description: "Create a new reusable skill OR update an existing one. If a skill with this name already exists, the new information will be merged in and the version bumped. Call this when you notice the user repeatedly asking for the same kind of task, or when you discover a better way to do something already in a skill.",
      parameters: {
        type: "object", properties: {
          name: { type: "string", description: "Skill name (lowercase-hyphenated, e.g. 'deploy-frontend')" },
          description: { type: "string", description: "Short description of what this skill does (updated if skill exists)" },
          prompt: { type: "string", description: "Description of the task pattern to encode as a skill, or improvements to add to existing skill" },
        }, required: ["name", "description", "prompt"],
      },
    },
  },
  // ── Task Management ──
  {
    type: "function",
    function: {
      name: "TaskCreate",
      description: "Create a new task to track progress during complex multi-step work. Use for organizing 3+ distinct steps.",
      parameters: {
        type: "object", properties: {
          subject: { type: "string", description: "A brief title for the task" },
          description: { type: "string", description: "What needs to be done" },
          activeForm: { type: "string", description: "Present continuous form shown during execution (e.g. 'Running tests')" },
        }, required: ["subject", "description"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "TaskUpdate",
      description: "Update a task's status or details. Mark tasks in_progress when starting, completed when done. Use 'deleted' to remove irrelevant tasks.",
      parameters: {
        type: "object", properties: {
          taskId: { type: "string", description: "The ID of the task to update" },
          status: { type: "string", enum: ["pending", "in_progress", "completed", "deleted"], description: "New status" },
          subject: { type: "string", description: "New subject for the task" },
          description: { type: "string", description: "New description for the task" },
        }, required: ["taskId"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "TaskList",
      description: "List all tasks in the task list to see current progress.",
      parameters: { type: "object", properties: {} },
    },
  },
  // ── Todo Management ──
  {
    type: "function",
    function: {
      name: "TodoWrite",
      description: "Update the session todo checklist. Use proactively to track progress. Exactly one task in_progress at a time. Mark tasks complete immediately after finishing. Provide both 'content' (imperative) and 'activeForm' (present continuous) for each task.",
      parameters: {
        type: "object", properties: {
          todos: {
            type: "array",
            description: "The full todo list (replaces previous list)",
            items: {
              type: "object",
              properties: {
                content: { type: "string", description: "What to do (imperative, e.g. 'Fix auth bug')" },
                status: { type: "string", enum: ["pending", "in_progress", "completed"], description: "Current status" },
                activeForm: { type: "string", description: "Present continuous (e.g. 'Fixing auth bug')" },
              },
              required: ["content", "status", "activeForm"],
            },
          },
        }, required: ["todos"],
      },
    },
  },
  // ── User Interaction ──
  {
    type: "function",
    function: {
      name: "AskUserQuestion",
      description: "Ask the user multiple-choice questions to gather information, clarify ambiguity, or understand preferences. Use when you need user input before proceeding.",
      parameters: {
        type: "object", properties: {
          questions: {
            type: "array", minItems: 1, maxItems: 4,
            description: "Questions to ask (1-4)",
            items: {
              type: "object",
              properties: {
                question: { type: "string", description: "The complete question, ending with ?" },
                header: { type: "string", description: "Short label (max 12 chars)" },
                options: {
                  type: "array", minItems: 2, maxItems: 4,
                  description: "Available choices (2-4)",
                  items: {
                    type: "object",
                    properties: {
                      label: { type: "string", description: "Display text (1-5 words)" },
                      description: { type: "string", description: "What this option means" },
                    },
                    required: ["label", "description"],
                  },
                },
                multiSelect: { type: "boolean", description: "Allow multiple selections (default false)" },
              },
              required: ["question", "header", "options"],
            },
          },
        }, required: ["questions"],
      },
    },
  },
  // ── Sub-agent ──
  {
    type: "function",
    function: {
      name: "Agent",
      description: "Launch a read-only sub-agent to search the web or explore code IN PARALLEL while you continue other work. Sub-agents can use: web_search, web_fetch, file_read, grep, glob. Use this when you need to gather information from multiple sources simultaneously. The sub-agent works independently and returns a text summary. Example: to search for latest AI news while also checking code, call Agent twice with different prompts.",
      parameters: {
        type: "object", properties: {
          description: { type: "string", description: "Short name for this sub-task (e.g. 'search AI news', 'find TODO files')" },
          prompt: { type: "string", description: "The complete task for the sub-agent. Be specific about what to find and what format to return. Example: 'Search the web for the top 3 AI news stories this week and summarize each in 2-3 sentences.'" },
        }, required: ["description", "prompt"],
      },
    },
  },
];

// ── Tool Executor ──────────────────────────────────────────

let WORKSPACE = process.cwd();
const MAX_OUTPUT = 12000;
const DANGEROUS = [/rm\s+-rf/i, /Remove-Item.*-Recurse/i, /del\s+\/f/i, /rd\s+\/s/i, /format\s+\w:/i, /diskpart/i];

// On Windows, PowerShell defaults to GB2312/CodePage 936 (or other system code page).
// We must set UTF-8 encoding explicitly to avoid ByteString errors with non-ASCII text.
const PS_UTF8_PREFIX = '$OutputEncoding = [Console]::OutputEncoding = [System.Text.Encoding]::UTF8; ';

function isDangerous(cmd) { return DANGEROUS.some(p => p.test(cmd)); }

const pendingPerms = new Map();
let permId = 0;

function requestPermission(cmd) {
  return new Promise(resolve => {
    const id = ++permId;
    pendingPerms.set(id, resolve);
    sendToRenderer("permission:request", { id, command: cmd });
  });
}

// Helper: run a PowerShell command and return decoded stdout + stderr as strings
function runPowerShell(command, opts = {}) {
  return new Promise(resolve => {
    try {
      const psArgs = ["-NoProfile", "-Command", PS_UTF8_PREFIX + command];
      const child = spawn(PS_EXE, psArgs, {
        cwd: WORKSPACE, shell: true, timeout: opts.timeout || 60000,
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

async function runTool(tc) {
  const { name, arguments: argsStr } = tc.function;
  const args = JSON.parse(argsStr);

  switch (name) {
    case "bash": {
      if (isDangerous(args.command)) {
        const ok = await requestPermission(args.command);
        if (!ok) return { error: "User denied this command" };
      }
      const r = await runPowerShell(args.command);
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
        const dir = args.path || WORKSPACE;
        const filter = args.include ? `-Include "${args.include}"` : "";
        const cmd = `Get-ChildItem -Path "${dir}" -Recurse ${filter} -File | Select-String -Pattern "${args.pattern}" | Select-Object -First 100 | % { "$($_.Filename):$($_.LineNumber): $($_.Line.Trim())" }`;
        const r = await runPowerShell(cmd, { timeout: 15000 });
        if (r.error) return { error: r.error };
        return { matches: r.out.trim().split("\n").filter(Boolean) };
      } catch (e) { return { error: e?.message || String(e) }; }
    }
    case "glob": {
      try {
        const dir = args.path || WORKSPACE;
        const cmd = `Get-ChildItem -Path '${dir}' -Recurse -Filter '${args.pattern}' | Select-Object -First 200 -ExpandProperty FullName`;
        const r = await runPowerShell(cmd, { timeout: 15000 });
        if (r.error) return { error: r.error };
        return { files: r.out.trim().split("\n").filter(Boolean).map(s => s.trim()) };
      } catch (e) { return { error: e?.message || String(e) }; }
    }
    case "web_fetch": {
      try {
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
        const skills = scanSkills();
        const skill = skills.find(s => s.name === args.name);
        if (!skill) return { error: `Skill "${args.name}" not found. Available: ${skills.map(s => s.name).join(", ")}` };
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

        // Update existing if filename provided
        if (filename) {
          const result = memory.updateMemory(filename, content, memName, memDesc, type);
          if (result.error) return result;
          return { saved: true, type, name: memName, filename: result.filename || filename, updated: true };
        }

        // Create new
        const result = memory.createMemory(memName, memDesc, type, content);
        if (result.error) return result;
        return { saved: true, type, name: result.name, filename: result.filename };
      } catch (e) { return { error: e.message }; }
    }
    case "invoke_skill": {
      try {
        const skill = skills.loadSkill(args.name);
        if (!skill) return { error: `Skill "${args.name}" not found. Use list_skills to see available skills.` };
        skills.recordSkillUsage(args.name, true);
        return { name: skill.name, description: skill.description, content: skill.body || "(no instructions)" };
      } catch (e) { return { error: e.message }; }
    }
    case "create_skill": {
      try {
        const { name, description, prompt } = args;
        const existing = skills.loadSkill(name);
        const cfg = loadWxConfig();
        const apiKey = cfg.apiKey || _lastApiConfig.apiKey;
        const apiUrl = cfg.apiUrl || _lastApiConfig.apiUrl;
        const model = cfg.model || _lastApiConfig.model;
        if (!apiKey || !apiUrl) return { error: "API not configured — configure in Settings first" };

        // Build generation prompt — if updating, include existing content
        const genPrompt = existing
          ? `IMPROVE this existing skill with new information. Current skill content:\n\n${existing.body || ""}\n\nImprovements to add: ${prompt}\n\nMerge the improvements into the existing steps and notes. Keep all useful existing content.`
          : `Create a reusable skill for: ${prompt}`;

        const result = await skills.generateSkill(genPrompt, apiKey, apiUrl, model);
        if (result.error) return result;

        const parsed = result.skill || "";
        const fmMatch = parsed.match(/^---\s*\n([\s\S]*?)\n---/);
        const genBody = fmMatch ? parsed.slice(fmMatch[0].length).trim() : parsed;

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
    // ── Task Management ──
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
    // ── Todo Management ──
    case "TodoWrite": {
      const oldTodos = [..._todoList];
      _todoList = (args.todos || []).map((t, i) => ({ id: `todo_${i + 1}`, content: t.content, status: t.status, activeForm: t.activeForm }));
      return { oldTodos, newTodos: _todoList };
    }
    // ── Sub-agent ──
    case "Agent": {
      sendToRenderer("tool:start", { name: "Agent", args: { description: args.description } });
      try {
        const result = await runSubAgent(args.description, args.prompt);
        const output = result.text || "(no result)";
        sendToRenderer("tool:result", { name: "Agent", result: { output } });
        return { output, aborted: result.aborted || false };
      } catch (e) {
        sendToRenderer("tool:result", { name: "Agent", result: { error: e.message } });
        return { error: e.message };
      }
    }
    // ── User Interaction ──
    case "AskUserQuestion": {
      const questions = args.questions || [];
      if (questions.length === 0) return { error: "At least one question required" };
      return new Promise(resolve => {
        const qId = ++_askId;
        _askResolvers.set(qId, resolve);
        sendToRenderer("ask:question", { id: qId, questions });
        // Auto-resolve after 120s timeout
        setTimeout(() => {
          if (_askResolvers.has(qId)) {
            _askResolvers.delete(qId);
            resolve({ answers: {}, timed_out: true });
          }
        }, 120_000);
      });
    }
    default: {
      // Try MCP dispatch
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

// ── Session Persistence (SQLite) ─────────────────────────────
// Old JSON files: app.getPath("userData")/sessions/*.json
// New DB: ~/.goodagent/sessions.db

async function saveSession(id, hist, title) {
  try { sessionDb.saveSession(id, hist, title); } catch (e) { console.error("[session] save:", e.message); }
}

async function listSessions() {
  try { return sessionDb.listSessions(50); } catch { return []; }
}

async function loadSession(id) {
  try { return sessionDb.loadSession(id); } catch { return null; }
}

async function deleteSession(id) {
  try { sessionDb.deleteSession(id); } catch {}
}

function getHistoryTitle(hist) {
  if (!hist || hist.length === 0) return "(空对话)";
  const first = hist.find(m => m.role === "user");
  if (!first || !first.content) return "(空对话)";
  const text = typeof first.content === "string" ? first.content
    : Array.isArray(first.content) ? first.content.map(c => c.text || "").join(" ").trim()
    : "";
  return text.replace(/\s+/g, " ").slice(0, 30) + (text.length > 30 ? "…" : "");
}

// ── Agent Loop ─────────────────────────────────────────────
const MAX_TURNS = 25;

let abortCtrl = null;
let sessionId = null;
let history = [];
let _episodicSearched = false;  // only search once per session

// ── Task Store ──────────────────────────────────────────────
const taskStore = new Map(); // taskId -> { id, subject, description, status, activeForm, owner, metadata, createdAt }
let _todoList = []; // session todo checklist
let _askId = 0;
const _askResolvers = new Map(); // qId -> resolve function

// SYSTEM prompt is built dynamically in buildSystemPrompt(enabledSkills)

function genId() {
  return `ses_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

// ═══════════════════════════════════════════════════════════
// Format adapters — convert between OpenAI and Anthropic formats
// ═══════════════════════════════════════════════════════════

/** Merge static built-in tool defs with dynamic MCP tool defs. */
function getAllToolDefs() {
  const mcpDefs = mcpManager.listAllToolDefs();
  return [...TOOL_DEFS, ...mcpDefs];
}

function toAnthropicTools() {
  return getAllToolDefs().map(t => ({
    name: t.function.name,
    description: t.function.description,
    input_schema: t.function.parameters,
  }));
}

function toAnthropicMessages(msgs) {
  const messages = [];
  let system = null;
  for (const m of msgs) {
    if (m.role === "system") { system = m.content; continue; }
    if (m.role === "user") {
      // Handle both string and array content (vision)
      const content = typeof m.content === "string" ? m.content
        : Array.isArray(m.content) ? m.content.map(c => {
            if (c.type === "image_url") {
              return { type: "image", source: { type: "base64", media_type: c.image_url.url.split(";")[0].replace("data:", ""), data: c.image_url.url.split("base64,")[1] } };
            }
            return c;
          })
        : m.content;
      messages.push({ role: "user", content });
    } else if (m.role === "assistant") {
      const content = [];
      if (m.content) content.push({ type: "text", text: m.content });
      if (m.tool_calls) {
        for (const tc of m.tool_calls) {
          let input = {};
          try { input = JSON.parse(tc.function.arguments); } catch {}
          content.push({ type: "tool_use", id: tc.id, name: tc.function.name, input });
        }
      }
      messages.push({ role: "assistant", content });
    } else if (m.role === "tool") {
      messages.push({ role: "user", content: [{ type: "tool_result", tool_use_id: m.tool_call_id, content: m.content }] });
    }
  }
  return { messages, system };
}

// ── OpenAI-format streaming call ──
async function openaiCall(msgs, apiUrl, apiKey, model, signal, reasoning = true) {
  const body = { model: model || "deepseek-chat", messages: msgs, tools: getAllToolDefs(), stream: true, max_tokens: 8192 };
  // Control reasoning behavior — DeepSeek supports reasoning_content param
  if (reasoning === false) {
    // Explicitly suppress reasoning_content in response
    body.reasoning_content = null;
  }
  const res = await fetch(apiUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) {
    const body = (await res.text().catch(() => "")).slice(0, 300);
    throw new Error(`API ${res.status} (${res.statusText})\nURL: ${apiUrl}\nModel: ${model || "deepseek-chat"}\n${body ? "Response: " + body : ""}`);
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "", content = "", reasoningContent = "";
  const tcAccum = {};
  let finishReason = null;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    for (const line of buf.split("\n").slice(0, -1)) {
      const t = line.trim();
      if (!t || !t.startsWith("data:")) continue;
      const d = t.slice(5).trim();
      if (d === "[DONE]") continue;
      try {
        const j = JSON.parse(d);
        const delta = j.choices?.[0]?.delta || {};
        finishReason = j.choices?.[0]?.finish_reason;
        if (delta.content) { content += delta.content; sendToRenderer("stream:chunk", { text: delta.content, done: false }); }
        if (delta.reasoning_content) { reasoningContent += delta.reasoning_content; sendToRenderer("stream:reasoning", { text: delta.reasoning_content }); }
        if (delta.tool_calls) {
          for (const tc of delta.tool_calls) {
            if (!tcAccum[tc.index]) tcAccum[tc.index] = { id: "", type: "function", function: { name: "", arguments: "" } };
            if (tc.id) tcAccum[tc.index].id = tc.id;
            if (tc.function?.name) tcAccum[tc.index].function.name += tc.function.name;
            if (tc.function?.arguments) tcAccum[tc.index].function.arguments += tc.function.arguments;
          }
        }
      } catch {}
    }
    buf = buf.split("\n").pop() || "";
  }
  return { content, reasoningContent, finishReason, tcs: Object.values(tcAccum) };
}

// ── Anthropic-format streaming call ──
async function anthropicCall(msgs, apiUrl, apiKey, model, signal, reasoning = true) {
  const { messages, system } = toAnthropicMessages(msgs);
  // Normalize Anthropic endpoint URL
  const base = apiUrl.replace(/\/+$/, "");
  const endpoint = base.endsWith("/v1/messages") ? base
    : base.endsWith("/v1") ? base + "/messages"
    : base + "/v1/messages";
  const body = {
    model: model || "claude-sonnet-4-20250514",
    max_tokens: 8192,
    system: system || "",
    messages,
    tools: toAnthropicTools(),
    stream: true,
  };
  // Enable extended thinking for Anthropic when deep reasoning is on
  if (reasoning) {
    body.thinking = { type: "enabled", budget_tokens: 4096 };
  }
  const res = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) {
    const body = (await res.text().catch(() => "")).slice(0, 300);
    throw new Error(`API ${res.status} (${res.statusText})\nURL: ${endpoint}\nModel: ${model || "claude-sonnet-4-20250514"}\n${body ? "Response: " + body : ""}`);
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "", content = "", currentEvent = "";
  const tcAccum = {}; // index → { id, name, input }
  let finishReason = null;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop() || "";
    for (const line of lines) {
      const t = line.trim();
      if (t.startsWith("event: ")) { currentEvent = t.slice(7).trim(); }
      else if (t.startsWith("data: ")) {
        const d = t.slice(6).trim();
        if (!d) continue;
        try {
          const j = JSON.parse(d);
          if (j.type === "content_block_start" && j.content_block?.type === "text") {
            // text block started, no content yet
          } else if (j.type === "content_block_start" && j.content_block?.type === "thinking") {
            // thinking block started
          } else if (j.type === "content_block_delta" && j.delta?.type === "text_delta") {
            content += j.delta.text;
            sendToRenderer("stream:chunk", { text: j.delta.text, done: false });
          } else if (j.type === "content_block_delta" && j.delta?.type === "thinking_delta") {
            sendToRenderer("stream:reasoning", { text: j.delta.thinking });
          } else if (j.type === "content_block_start" && j.content_block?.type === "tool_use") {
            tcAccum[j.index] = { id: j.content_block.id, name: j.content_block.name, input: "" };
          } else if (j.type === "content_block_delta" && j.delta?.type === "input_json_delta") {
            if (tcAccum[j.index]) tcAccum[j.index].input += j.delta.partial_json;
          } else if (j.type === "message_delta") {
            finishReason = j.delta?.stop_reason;
          }
        } catch {}
      }
    }
  }
  // Convert Anthropic tool calls → internal format
  const tcs = Object.values(tcAccum).map(tc => ({
    id: tc.id, type: "function",
    function: { name: tc.name, arguments: tc.input },
  }));
  return { content, finishReason, tcs };
}

// ── L0 Working Memory: Token Budget Management ────────────
const TOKEN_BUDGET_WARN = 16000; // warn when system prompt exceeds this (conservative)
const TOKEN_BUDGET_HARD = 24000; // hard truncation limit

function estimateTokens(text) {
  if (!text) return 0;
  // Rough estimation: ~3.5 chars/token for mixed CJK/English
  // More accurate: CJK chars ~1.5 tokens each, ASCII ~0.25 tokens each
  let cjk = 0, ascii = 0;
  for (const ch of text) {
    if (ch > '\u00FF') cjk++;
    else ascii++;
  }
  return Math.ceil(cjk * 1.5 + ascii * 0.25);
}

function trimToBudget(text, budget) {
  if (!text || estimateTokens(text) <= budget) return text;
  // Truncate intelligently: keep first and last portions
  const maxChars = budget * 3.5;
  const half = Math.floor(maxChars * 0.6);
  return text.slice(0, half) + `\n\n...(truncated ${Math.ceil(estimateTokens(text) - budget)} tokens)...\n\n` + text.slice(-Math.floor(maxChars * 0.3));
}

function buildSystemPrompt(enabledSkills, agentName, userPrompt = "") {
  const allSkills = scanSkills();
  const filterSkills = enabledSkills && enabledSkills.length > 0
    ? allSkills.filter(s => enabledSkills.includes(s.name))
    : allSkills;
  const skillList = filterSkills.length > 0
    ? filterSkills.map(s => `  - \`${s.name}\`: ${s.description || "(no description)"}`).join("\n")
    : "  (no skills enabled)";

  // ── Build prompt body from active profile ──
  let content = "";
  try {
    const store = loadPromptProfiles();
    const profileId = store.activeProfile || "default";
    const profile = store.profiles[profileId];
    if (profile && profile.enabled) {
      const parts = [];
      for (const [key, sec] of Object.entries(profile.sections)) {
        if (sec.enabled && sec.content && sec.content.trim()) {
          const label = SECTION_LABELS[key] || key;
          let sectionContent = sec.content.trim();
          // Replace runtime placeholders
          sectionContent = sectionContent.replace(/\{\{WORKSPACE\}\}/g, WORKSPACE);
          parts.push(`## ${label}\n${sectionContent}`);
        }
      }
      if (parts.length > 0) {
        content = parts.join("\n\n");
      }
    }
  } catch (e) {
    console.error("[main] Failed to load prompt profiles:", e.message);
  }

  // ── Fallback if profile yielded no content ──
  if (!content) {
    content = `You are GoodAgent, an expert coding assistant running on Windows with direct access to the user's computer. Your name is GoodAgent, NOT Claude and NOT DeepSeek — you are a desktop AI coding agent called GoodAgent.

**Available tools:**
- \`bash\` — Run PowerShell commands (dir, git, npm, etc.)
- \`file_read\` — Read file contents
- \`file_write\` — Create or overwrite files
- \`file_edit\` — Replace exact text in files
- \`grep\` — Regex search in files
- \`glob\` — Find files by name pattern
- \`web_fetch\` — Fetch and extract content from any URL
- \`web_search\` — Search the internet for current information
- \`skill\` — Load a user-installed skill (SKILL.md workflow)
- \`TaskCreate\` — Create tasks to track complex multi-step work
- \`TaskUpdate\` — Update task status (pending/in_progress/completed/deleted)
- \`TaskList\` — List all tasks to see progress
- \`TodoWrite\` — Update a lightweight session todo checklist
- \`write_memory\` — Save important facts to permanent memory
- \`create_skill\` — Create or update reusable skill workflows
- \`Agent\` — Launch a read-only sub-agent for parallel research, code exploration, or web searches
- \`AskUserQuestion\` — Ask the user clarifying multiple-choice questions

**Rules:**
1. USE THE TOOLS. Don't just suggest — actually run commands, read files, make changes.
2. First explore the project with \`dir\` or \`Get-ChildItem\`.
3. When you need current information, news, or docs — use \`web_search\` and \`web_fetch\`.
4. Show relevant code when explaining.
5. Use \`file_edit\` or \`file_write\` for code changes.
6. Keep responses concise with Markdown formatting.
7. **You have episodic memory.** You can recall past conversations across sessions. When the user references something you've discussed before, acknowledge it and build on what you already know. You remember who the user is, what you've worked on together, and past decisions.
8. Always respond in the same language the user uses (if they write in Chinese, answer in Chinese; if English, answer in English).`;
  }

  // ── MCP servers info ──
  const mcpServers = mcpManager.listServers().filter(s => s.status === "running");
  let mcpSection = "";
  if (mcpServers.length > 0) {
    const lines = [];
    for (const server of mcpServers) {
      const toolNames = server.tools.map(t => `\`${t.name}\``).join(", ");
      lines.push(`  - **${server.name}**: ${toolNames}`);
    }
    mcpSection = `\n\n**MCP servers:**
${lines.join("\n")}\n
You can use the MCP tools listed above just like any other tool.`;
  }

  // ── Always append dynamic infrastructure ──
  content += `\n\n**Enabled skills (user-selected):**
${skillList}
${mcpSection}

Working directory: ${WORKSPACE}`;

  // ── Replace agent name if customized ──
  if (agentName && agentName !== "GoodAgent") {
    content = content.replace(/GoodAgent/g, agentName);
  }

  // ── Always inject memory awareness ──
  content += `\n\n**Memory:** You have persistent memory via \`write_memory\`. Save facts that are NOT derivable from code or git history.\n\n**Do NOT save:** code patterns/architecture (read the files), git history (git log is authoritative), debug solutions (fix is in code), CLAUDE.md content, or temporary task state. **DO save:** user preferences, project context (deadlines, stakeholder decisions), feedback/corrections, external system pointers.\n\nWhen a memory names a specific file or function, verify it exists before acting — memories can be stale.\n\nYou also have \`create_skill\` — use it when you notice repeated task patterns.`;

  // ── Inject available skills ──
  const skillsCtx = skills.buildSkillsContext();
  if (skillsCtx) content += skillsCtx;

  // ── Pattern detection hints ──
  try {
    const patterns = skills.detectPatterns(sessionDb);
    if (patterns.length > 0) {
      const hints = patterns.slice(0, 3).map(p =>
        `- "${p.phrase}" (${p.count} 次). 示例: "${p.examples[0]}"`
      ).join("\n");
      content += `\n\n**Repeated patterns detected in your conversation history:** These topics appear multiple times across sessions. If a pattern represents a reusable workflow, use \`create_skill\` to save it:\n${hints}`;
    }
  } catch {}

  // ── Inject episodic memory (once per session) ──
  let memorySections = [];
  try {
    if (userPrompt && !_episodicSearched) {
      _episodicSearched = true;
      const results = sessionDb.searchMessages(userPrompt, 8);
      if (results.length > 0) {
        const lines = results.map(r =>
          `- [${r.sessionTitle}] ${(r.snippet || "").replace(/<\/?mark>/g, "")}`
        ).join("\n");
        memorySections.push(`\n\n<memory-context>\n**以下是你的记忆——你过去与用户的对话中与此问题相关的部分：**\n${lines}\n</memory-context>`);
      }
    }
    // Always include PREVIOUS session for continuity (exclude current)
    const last = sessionDb.getLastSession(4, sessionId);
    if (last?.messages?.length) {
      const lines = last.messages.map(m => `- ${m.role}: ${(m.content || "").slice(0, 200)}`).join("\n");
      memorySections.push(`\n\n<memory-context>\n**上一段对话的延续——你的记忆：** [${last.title}]\n${lines}\n</memory-context>`);
    }
    // Inject permanent memory (USER.md + MEMORY.md) with budget-aware truncation
    try {
      const HOME = os.homedir();
      for (const [label, path] of [["USER.md", join(HOME, ".goodagent", "memories", "USER.md")], ["MEMORY.md", join(HOME, ".goodagent", "memories", "MEMORY.md")]]) {
        try {
          const text = readFileSync(path, "utf8").trim();
          if (text) memorySections.push({ label, text });
        } catch {}
      }
    } catch {}
  } catch {}

  // ── L0: Budget check — append memory sections, truncating if needed ──
  let baseTokens = estimateTokens(content);
  const memoryBudget = TOKEN_BUDGET_WARN - baseTokens;

  if (memoryBudget > 500) {
    // We have room — append all memory sections
    for (const sec of memorySections) {
      if (typeof sec === 'string') {
        content += sec;
      } else {
        const trimmed = sec.text.length > 2000 ? sec.text.slice(0, 2000) : sec.text;
        content += `\n\n<memory-context>\n**${sec.label} — 你的永久记忆：**\n${trimmed}\n</memory-context>`;
      }
    }
  } else {
    // Budget constrained — append only the most relevant sections, trimmed
    for (const sec of memorySections) {
      const space = TOKEN_BUDGET_HARD - estimateTokens(content);
      if (space < 200) break;
      if (typeof sec === 'string') {
        content += trimToBudget(sec, Math.max(200, space - 100));
      } else {
        const trimmed = sec.text.length > 800 ? sec.text.slice(0, 800) : sec.text;
        content += `\n\n<memory-context>\n**${sec.label} (摘要):**\n${trimmed}\n</memory-context>`;
      }
    }
  }

  return { role: "system", content };
}

// ── Sub-Agent Launcher ──────────────────────────────────────

/** Read-only tools for sub-agents */
const SUB_AGENT_TOOL_NAMES = new Set(["file_read", "grep", "glob", "web_search", "web_fetch", "TaskList"]);
const SUB_AGENT_MAX_TURNS = 8;

// Sub-agent uses its own abort controller (don't touch the main one)
let _subAbortCtrl = null;

async function runSubAgent(description, prompt) {
  const cfg = _lastApiConfig;
  if (!cfg.apiKey || !cfg.apiUrl) return { text: "(子代理不可用：请先在主对话中发送一条消息激活 API)" };

  if (_subAbortCtrl) _subAbortCtrl.abort();
  _subAbortCtrl = new AbortController();
  const { signal } = _subAbortCtrl;

  const subTools = getAllToolDefs().filter(t => SUB_AGENT_TOOL_NAMES.has(t.function?.name));

  // Build a minimal system prompt for the sub-agent
  const sysContent = `你是 GoodAgent 的子代理。你只能使用以下只读工具: file_read, grep, glob, web_search, web_fetch。
你的任务是: ${prompt}
完成后直接返回文本结果。如果需要搜索，使用 web_search。`;
  const msgs = [
    { role: "system", content: sysContent },
    { role: "user", content: prompt },
  ];

  console.error("[sub-agent] starting:", description);
  console.error("[sub-agent] cfg:", { hasKey: !!cfg.apiKey, url: cfg.apiUrl?.slice(0, 40), model: cfg.model, format: cfg.apiFormat });

  let allText = "";

  for (let turns = 0; turns < SUB_AGENT_MAX_TURNS; turns++) {
    try {
      const { apiKey, apiUrl, model, apiFormat } = cfg;
      const isAnthropic = apiFormat === "anthropic";

      // Use a non-reasoning model for sub-agents (reasoning is wasteful for search/read tasks)
      let subModel = model || "deepseek-chat";
      if (!isAnthropic && (subModel.includes("reasoner") || subModel.includes("-pro") || subModel.includes("v4"))) {
        subModel = "deepseek-chat"; // fallback to non-reasoning variant
      }
      if (isAnthropic) {
        subModel = model || "claude-haiku-4.5-20250514";
      }

      // Strip reasoning_content from messages (DeepSeek requires it be echoed back if present)
      const cleanMsgs = isAnthropic ? msgs : msgs.map(m => {
        if (m.role === "assistant" && m.reasoning_content !== undefined) {
          const { reasoning_content, ...rest } = m;
          return rest;
        }
        return m;
      });

      const body = {
        model: subModel,
        messages: cleanMsgs,
        tools: isAnthropic
          ? subTools.map(t => ({ name: t.function.name, description: t.function.description, input_schema: t.function.parameters }))
          : subTools,
        max_tokens: 4096,
      };
      const endpoint = isAnthropic
        ? apiUrl.replace(/\/+$/, "").replace(/\/v1\/messages$/, "") + "/v1/messages"
        : apiUrl;
      const headers = isAnthropic
        ? { "Content-Type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" }
        : { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` };

      if (isAnthropic) {
        const sys = cleanMsgs.find(m => m.role === "system");
        body.system = sys?.content || "";
        body.messages = cleanMsgs.filter(m => m.role !== "system");
      }

      console.error("[sub-agent] calling API:", endpoint.slice(0, 60), "model:", body.model);

      const res = await fetch(endpoint, {
        method: "POST", headers,
        body: JSON.stringify(body),
        signal,
      });

      if (!res.ok) {
        const errText = (await res.text().catch(() => "")).slice(0, 300);
        console.error("[sub-agent] API error:", res.status, errText);
        throw new Error(`API ${res.status}: ${errText}`);
      }

      const data = await res.json();
      let content = "";
      let tcs = [];

      if (isAnthropic) {
        for (const block of data.content || []) {
          if (block.type === "text") content += block.text;
          else if (block.type === "tool_use") {
            tcs.push({
              id: block.id, type: "function",
              function: { name: block.name, arguments: JSON.stringify(block.input) },
            });
          }
        }
      } else {
        const choice = data.choices?.[0];
        content = choice?.message?.content || "";
        tcs = (choice?.message?.tool_calls || []).map(tc => ({
          id: tc.id, type: "function",
          function: { name: tc.function?.name || "", arguments: tc.function?.arguments || "{}" },
        }));
      }

      console.error("[sub-agent] turn", turns, "content:", content?.slice(0, 80), "tcs:", tcs.length);

      allText += content || "";
      const asst = { role: "assistant", content: content || null };
      if (tcs.length > 0) asst.tool_calls = tcs;
      msgs.push(asst);

      if (tcs.length === 0) break;

      // Execute tools
      for (const tc of tcs) {
        const toolName = tc.function?.name;
        if (!SUB_AGENT_TOOL_NAMES.has(toolName)) {
          msgs.push({ role: "tool", tool_call_id: tc.id, content: JSON.stringify({ error: `Tool "${toolName}" not available to sub-agent` }) });
          continue;
        }
        let args;
        try { args = JSON.parse(tc.function.arguments); } catch { args = {}; }
        let result;
        try { result = await runTool(tc); } catch (e) { result = { error: e.message }; }
        const resultStr = JSON.stringify(result).slice(0, 8000);
        msgs.push({ role: "tool", tool_call_id: tc.id, content: resultStr });
      }
    } catch (err) {
      console.error("[sub-agent] error:", err.name, err.message);
      if (err.name === "AbortError") return { text: allText || "(aborted)", aborted: true };
      return { text: allText || `(子代理错误: ${err.message})` };
    }
  }

  console.error("[sub-agent] done, text length:", allText.length);
  return { text: allText || "(no result)" };
}

// ── AI Semantic Memory Selection ────────────────────────────

/**
 * Scan all memory files, then use a small API call to select the top 5 most
 * relevant ones for the current query. Returns the content of selected memories.
 * Falls back to returning all memories if the selection call fails.
 */
// Track which memories were already surfaced in prior turns
const _surfacedMemories = new Set();

async function selectRelevantMemories(query, apiKey, apiUrl, model, apiFormat) {
  const memories = memory.listMemories();
  if (memories.length === 0) return "";

  // Filter out already-surfaced memories to spend budget on fresh candidates
  const freshMemories = memories.filter(m => !_surfacedMemories.has(m.filename));
  const candidates = freshMemories.length >= 3 ? freshMemories : memories;
  if (candidates.length === 0) return "";

  if (candidates.length <= 5) {
    for (const m of candidates) _surfacedMemories.add(m.filename);
    return candidates.map(m => {
      const ageNote = memory.memoryFreshnessNote(m.mtimeMs);
      return `\n### [${m.type}] ${m.name}${ageNote}\n${m.body}`;
    }).join("\n");
  }

  // Build manifest with age info for smarter selection
  const manifest = candidates.map(m => {
    const ageDays = memory.memoryAgeDays(m.mtimeMs);
    const ageStr = ageDays > 30 ? ` [${ageDays}d old]` : ageDays > 7 ? ` [${ageDays}d]` : "";
    return `- ${m.filename} [${m.type}] ${m.name}: ${m.description}${ageStr}`;
  }).join("\n");

  const selectPrompt = `You are selecting memory files relevant to a user's query. From the list below, pick up to 5 files that are clearly useful. Be selective — if unsure, skip it. Do NOT select reference docs for tools already being used (unless they contain warnings/gotchas). Return ONLY a JSON array of filenames.

User query: ${query.slice(0, 500)}

Available memories:
${manifest}

Return: {"selected_memories": ["file1.md", "file2.md"]}`;

  try {
    const body = {
      model: model || "deepseek-chat",
      messages: [{ role: "user", content: selectPrompt }],
      max_tokens: 256,
      stream: false,
    };
    const endpoint = apiFormat === "anthropic"
      ? apiUrl.replace(/\/+$/, "").replace(/\/v1\/messages$/, "") + "/v1/messages"
      : apiUrl;
    const headers = apiFormat === "anthropic"
      ? { "Content-Type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" }
      : { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` };

    if (apiFormat === "anthropic") {
      body.system = "You select relevant memory files. Return ONLY valid JSON.";
      body.model = model || "claude-haiku-4.5-20250514";
    }

    const res = await fetch(endpoint, {
      method: "POST", headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    });
    if (res.ok) {
      const data = await res.json();
      const selectedText = apiFormat === "anthropic"
        ? (data.content?.[0]?.text || "")
        : (data.choices?.[0]?.message?.content || "");

      // Parse JSON array, fall back to comma-split
      let selectedNames = [];
      try {
        const parsed = JSON.parse(selectedText);
        selectedNames = (parsed.selected_memories || parsed || []).map(s => String(s).trim().replace(/\.md$/, ""));
      } catch {
        selectedNames = selectedText.split(/[,，\n]/).map(s => s.trim().replace(/\.md$/, "")).filter(Boolean);
      }

      // Validate against actual filenames (defense against hallucinated names)
      const validFilenames = new Set(candidates.map(m => m.filename));
      const validNames = selectedNames.filter(sn => {
        // Exact match
        if (validFilenames.has(sn)) return true;
        if (validFilenames.has(sn + ".md")) return true;
        // Contains match (more lenient)
        return candidates.some(m => m.filename.includes(sn) || sn.includes(m.filename.replace(/\.md$/, "")));
      });

      const selected = candidates.filter(m =>
        validNames.some(sn => m.filename === sn || m.filename === sn + ".md" || m.filename.includes(sn) || sn.includes(m.filename.replace(/\.md$/, "")))
      ).slice(0, 5);

      if (selected.length > 0) {
        for (const m of selected) _surfacedMemories.add(m.filename);
        return selected.map(m => {
          const ageNote = memory.memoryFreshnessNote(m.mtimeMs);
          return `\n### [${m.type}] ${m.name}${ageNote}\n${m.body}`;
        }).join("\n");
      }
    }
  } catch (e) {
    console.error("[memory] semantic selection failed:", e.message);
  }

  // Fallback: return newest 5
  const fallback = candidates.slice(0, 5);
  for (const m of fallback) _surfacedMemories.add(m.filename);
  return fallback.map(m => {
    const ageNote = memory.memoryFreshnessNote(m.mtimeMs);
    return `\n### [${m.type}] ${m.name}${ageNote}\n${m.body}`;
  }).join("\n");
}

// ── Main agent loop ──
async function agentLoop(prompt, apiKey, apiUrl, model, apiFormat = "openai", files = [], enabledSkills, reasoning = true, agentName) {
  if (abortCtrl) abortCtrl.abort();
  abortCtrl = new AbortController();
  const { signal } = abortCtrl;

  if (!sessionId) { sessionId = genId(); sendToRenderer("session:update", { sessionId }); }

  // ── Build user message with optional file attachments ──
  let userMessage;
  if (files && files.length > 0) {
    // OpenAI vision format: content array
    const contentParts = [];
    if (prompt) contentParts.push({ type: "text", text: prompt });

    for (const f of files) {
      if (f.type && f.type.startsWith("image/")) {
        contentParts.push({ type: "image_url", image_url: { url: f.dataUrl } });
      } else {
        // Non-image: try to decode base64 to text and append as context
        try {
          const base64Data = f.dataUrl.includes("base64,") ? f.dataUrl.split("base64,")[1] : f.dataUrl;
          const decoded = atob(base64Data);
          const fileDesc = `\n\n--- File: ${f.name} ---\n${decoded}\n--- End of ${f.name} ---\n`;
          contentParts.push({ type: "text", text: fileDesc });
        } catch {
          contentParts.push({ type: "text", text: `\n\n[Attachment: ${f.name} — unable to decode]` });
        }
      }
    }
    userMessage = { role: "user", content: contentParts };
  } else {
    userMessage = { role: "user", content: prompt };
  }

  const sysPrompt = buildSystemPrompt(enabledSkills, agentName, prompt);

  // ── Inject task/todo status into system context ──
  let sysContent = sysPrompt.content;
  const activeTasks = Array.from(taskStore.values()).filter(t => t.status !== "completed" && t.status !== "deleted");
  if (activeTasks.length > 0) {
    sysContent += "\n\n## 当前任务状态\n";
    for (const t of activeTasks) {
      const icon = t.status === "in_progress" ? "🔄" : "⬜";
      sysContent += `- ${icon} **${t.subject}** (${t.status}) — ${t.description}\n`;
    }
  }
  if (_todoList.length > 0) {
    sysContent += "\n## 当前 Todo 清单\n";
    for (const t of _todoList) {
      const icon = t.status === "completed" ? "✅" : t.status === "in_progress" ? "🔄" : "⬜";
      sysContent += `- ${icon} ${t.content}\n`;
    }
  }

  // ── Inject Agent & AskUserQuestion tool awareness ──
  // (Always appended so the model knows about these tools regardless of prompt profile)
  if (!sysContent.includes("AskUserQuestion")) {
    sysContent += `\n\n**AskUserQuestion:** You can ask the user up to 4 multiple-choice questions when you need clarification. Use this instead of guessing. The user will see a dialog and respond.`;
  }
  if (!sysContent.includes("\`Agent\`")) {
    sysContent += `\n\n**Agent (Sub-Agent):** You can launch read-only sub-agents (\`Agent\` tool) for parallel independent research. Sub-agents have access to file_read, grep, glob, web_search, web_fetch. Use them to search for information in parallel while you continue other work. A sub-agent returns a single text result. Example: \`Agent(description="search AI news", prompt="Search the web for the latest AI news this week and summarize the top 3 stories.")\``;
  }
  // Inject memory best practices if not already covered
  if (!sysContent.includes("Do NOT save")) {
    sysContent += `\n\n**Memory hygiene:** Do NOT save code patterns, architecture, or file paths as memories — those are derivable from the current project state. Only save non-obvious context: user preferences, stakeholder decisions, deadlines, corrections, external system references. If a memory claims a function or file exists, verify with grep/file_read before acting on it.`;
  }

  // ── Inject relevant memories ──
  try {
    const relevantMems = await selectRelevantMemories(prompt, apiKey, apiUrl, model, apiFormat);
    if (relevantMems) {
      sysContent += "\n\n## 相关记忆\n" + relevantMems;
    }
  } catch (e) {
    // Non-fatal: memory selection failure shouldn't block the query
    console.error("[memory] selection error:", e.message);
  }

  // ── L0 token budget check ──
  const estTokens = estimateTokens(sysContent);
  if (estTokens > TOKEN_BUDGET_WARN) {
    sendToRenderer("l0:budget", {
      estimatedTokens: estTokens,
      warnThreshold: TOKEN_BUDGET_WARN,
      hardThreshold: TOKEN_BUDGET_HARD,
      overWarn: estTokens > TOKEN_BUDGET_WARN,
      overHard: estTokens > TOKEN_BUDGET_HARD,
    });
    if (estTokens > TOKEN_BUDGET_HARD) {
      sysContent = trimToBudget(sysContent, TOKEN_BUDGET_HARD);
    }
  }

  const msgs = [{ role: "system", content: sysContent }, ...history, userMessage];
  let turns = 0;
  let allText = "", allReasoning = "";

  while (turns < MAX_TURNS) {
    turns++;

    // ── API call (format-dispatch) ──
    let content = "", reasoningContent = "", tcs = [];
    try {
      const callFn = apiFormat === "anthropic" ? anthropicCall : openaiCall;
      const result = await callFn(msgs, apiUrl, apiKey, model, signal, reasoning);
      content = result.content;
      reasoningContent = result.reasoningContent || "";
      allText += result.content;
      if (reasoningContent) allReasoning += reasoningContent;
      tcs = result.tcs;
    } catch (err) {
      if (err.name === "AbortError") return { text: allText, aborted: true };
      throw err;
    }

    // Append assistant message
    const asst = { role: "assistant", content: content || null };
    if (reasoningContent) asst.reasoning_content = reasoningContent;
    if (tcs.length > 0) asst.tool_calls = tcs;
    msgs.push(asst);

    if (tcs.length === 0) break;

    // ── Execute tools ──
    for (const tc of tcs) {
      let args;
      try { args = JSON.parse(tc.function.arguments); } catch { args = { raw: tc.function.arguments }; }
      sendToRenderer("tool:start", { name: tc.function.name, args });

      let result;
      try { result = await runTool(tc); } catch (e) { result = { error: e.message }; }

      let rStr = JSON.stringify(result);
      if (rStr.length > MAX_OUTPUT) rStr = rStr.slice(0, MAX_OUTPUT) + "\n...(truncated)";
      sendToRenderer("tool:result", { name: tc.function.name, result });
      msgs.push({ role: "tool", tool_call_id: tc.id, content: rStr });
    }
  }

  // Save conversation
  const historyAsst = { role: "assistant", content: allText || "" };
  if (allReasoning) historyAsst.reasoning_content = allReasoning;
  // For history, store text-only version of the user message
  const historyUser = { role: "user", content: prompt || (files && files.length > 0 ? `[${files.map(f => f.name).join(", ")}]` : "") };
  history.push(historyUser, historyAsst);

  // ── Session Compression (AI-driven) ──
  if (history.length > 40) {
    const oldHistory = history.slice(0, history.length - 20);
    const recent = history.slice(history.length - 20);

    let summary = "";
    try {
      // Build compaction prompt
      const convText = oldHistory.map(m => {
        const role = m.role === "user" ? "用户" : m.role === "assistant" ? "助手" : m.role;
        const text = (typeof m.content === "string" ? m.content : JSON.stringify(m.content || "")).replace(/[\r\n\t]+/g, " ").trim();
        return `[${role}]: ${text.slice(0, 500)}`;
      }).join("\n");

      const compactPrompt = `总结以下对话的关键信息。保留: 具体文件名、函数名、错误信息、用户明确提出的需求和偏好、已做出的决策。丢弃: 问候语、重复内容、工具调用的原始输出细节。

对话:
${convText}

用一段简洁的摘要总结（中文）:`;

      // Use a short non-streaming API call for compaction
      const body = {
        model: model || "deepseek-chat",
        messages: [{ role: "user", content: compactPrompt }],
        max_tokens: 2048,
        stream: false,
      };
      const endpoint = apiFormat === "anthropic"
        ? apiUrl.replace(/\/+$/, "").replace(/\/v1\/messages$/, "") + "/v1/messages"
        : apiUrl;
      const headers = apiFormat === "anthropic"
        ? { "Content-Type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" }
        : { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` };

      if (apiFormat === "anthropic") {
        body.system = "You are a helpful assistant that summarizes conversations concisely.";
        body.model = model || "claude-sonnet-4-20250514";
      }

      const res = await fetch(endpoint, {
        method: "POST", headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(30000),
      });
      if (res.ok) {
        const data = await res.json();
        summary = apiFormat === "anthropic"
          ? (data.content?.[0]?.text || "")
          : (data.choices?.[0]?.message?.content || "");
      }
    } catch (e) {
      console.error("[compress] AI compaction failed, using fallback:", e.message);
    }

    // Fallback to simple truncation if AI compaction fails
    if (!summary || summary.trim().length < 20) {
      const summaryLines = ["## 早期对话摘要\n"];
      let lastRole = "";
      for (const m of oldHistory.slice(-30)) {
        const role = m.role === "user" ? "用户" : "助手";
        const text = (typeof m.content === "string" ? m.content : "").replace(/[\r\n\t]+/g, " ").trim().slice(0, 180);
        if (!text) continue;
        if (role === lastRole) summaryLines.push(`  ...${text}`);
        else summaryLines.push(`- **${role}：** ${text}`);
        lastRole = role;
      }
      summary = summaryLines.join("\n");
    }

    // Save compressed version to session DB with parent chaining
    if (sessionId) {
      try {
        const parentId = sessionId;
        const compressedId = parentId + "_c" + Date.now().toString(36);
        sessionDb.saveSession(
          compressedId,
          [{ role: "system", content: summary }, ...recent],
          getHistoryTitle(recent)
        );
        sessionDb.updateTitle(parentId, getHistoryTitle(recent));
        recent.unshift({ role: "system", content: summary });
      } catch (e) { console.error("[compress]", e.message); }
    }

    history = recent;
  }

  // Auto-save after each turn
  if (sessionId) {
    const title = getHistoryTitle(history);
    saveSession(sessionId, history, title).catch(() => {});
  }

  return { text: allText || "(no text response)" };
}

// ── IPC Handlers ────────────────────────────────────────────

ipcMain.handle("query:submit", async (event, { prompt, apiKey, apiUrl, model, apiFormat = "openai", files = [], enabledSkills, reasoning = true, agentName }) => {
  // Cache for WeChat bot fallback
  if (apiKey && apiUrl) _lastApiConfig = { apiKey, apiUrl, model, apiFormat, agentName };
  sendToRenderer("stream:start", {});
  try { await agentLoop(prompt, apiKey, apiUrl, model, apiFormat, files, enabledSkills, reasoning, agentName); }
  catch (err) { sendToRenderer("stream:error", { message: err.message }); }
  sendToRenderer("stream:done", {});
});

ipcMain.handle("query:abort", () => {
  if (abortCtrl) { abortCtrl.abort(); abortCtrl = null; }
});

ipcMain.handle("session:reset", async () => {
  // Auto-save current session before resetting
  if (sessionId && history.length > 0) {
    const title = getHistoryTitle(history);
    await saveSession(sessionId, history, title);
  }
    sessionId = null; history = [];
    _episodicSearched = false;
    taskStore.clear();
    _todoList = [];
    _surfacedMemories.clear();
    // Notify renderer to clear task indicator too
    sendToRenderer("task:clear", {});
  });

ipcMain.handle("session:list", async () => {
  return await listSessions();
});

ipcMain.handle("session:load", async (_event, id) => {
  const data = await loadSession(id);
  if (data) {
    sessionId = data.id;
    history = data.history || [];
    sendToRenderer("session:update", { sessionId: data.id });
    return { sessionId: data.id, title: data.title, history: data.history || [] };
  }
  return null;
});

ipcMain.handle("session:delete", async (_event, id) => {
  await deleteSession(id);
});

ipcMain.handle("session:delete-message", async (_event, messageId) => {
  try { return sessionDb.deleteMessage(messageId); } catch (e) { return { error: e.message }; }
});

ipcMain.handle("session:edit-message", async (_event, messageId, newContent) => {
  try { return sessionDb.editMessage(messageId, newContent); } catch (e) { return { error: e.message }; }
});

ipcMain.handle("session:export-markdown", async (_event, id) => {
  try { return sessionDb.exportSession(id); } catch (e) { return { error: e.message }; }
});

ipcMain.handle("session:search", async (_event, query, limit) => {
  try { return sessionDb.searchMessages(query, limit); } catch (err) { return []; }
});

ipcMain.handle("session:last", async (_event, limit) => {
  try { return sessionDb.getLastSession(limit); } catch { return null; }
});

ipcMain.handle("session:status", async () => {
  try { return sessionDb.getStatus(); } catch { return { error: "unavailable" }; }
});

// ── Memory Store IPC ──────────────────────────────────────────

ipcMain.handle("memory:read-user", async () => memory.readUserMemory());
ipcMain.handle("memory:write-user", async (_e, content) => {
  memory.writeUserMemory(content);
  memory.rebuildIndex();
  return { ok: true };
});
ipcMain.handle("memory:append-user", async (_e, content) => {
  memory.appendUserMemory(content);
  memory.rebuildIndex();
  return { ok: true };
});
ipcMain.handle("memory:read-project", async () => memory.readProjectMemory());
ipcMain.handle("memory:write-project", async (_e, content) => {
  memory.writeProjectMemory(content);
  memory.rebuildIndex();
  return { ok: true };
});
ipcMain.handle("memory:append-project", async (_e, content) => {
  memory.appendProjectMemory(content);
  memory.rebuildIndex();
  return { ok: true };
});
ipcMain.handle("memory:search", async (_e, query) => memory.searchMemory(query || "", 10));
ipcMain.handle("memory:check-dup", async (_e, type, text) => memory.checkDuplicate(type, text));
ipcMain.handle("memory:index", async (_e, source, content) => { memory.rebuildIndex(); return { ok: true }; });

// ── Workspace IPC ──────────────────────────────────────────
ipcMain.handle("workspace:get", async () => WORKSPACE);
ipcMain.handle("workspace:set", async (_e, newPath) => {
  if (!newPath || typeof newPath !== "string") return { error: "invalid path" };
  try {
    const { statSync } = await import("node:fs");
    const st = statSync(newPath);
    if (!st.isDirectory()) return { error: "not a directory" };
  } catch { return { error: "path does not exist" }; }
  WORKSPACE = newPath;
  return { ok: true, workspace: WORKSPACE };
});
ipcMain.handle("workspace:pick", async () => {
  const win = BrowserWindow.getFocusedWindow() || mainWindow;
  const result = await dialog.showOpenDialog(win, {
    properties: ["openDirectory"],
    title: "选择工作区间",
    defaultPath: WORKSPACE,
  });
  if (result.canceled || !result.filePaths?.[0]) return { canceled: true };
  WORKSPACE = result.filePaths[0];
  return { ok: true, workspace: WORKSPACE };
});

// Multi-file memory API
ipcMain.handle("memory:list-all", async () => {
  try { return memory.listMemories(); } catch (e) { return []; }
});
ipcMain.handle("memory:read-one", async (_e, filename) => {
  return memory.readMemory(filename);
});
ipcMain.handle("memory:create", async (_e, { name, description, type, content }) => {
  return memory.createMemory(name, description, type, content);
});
ipcMain.handle("memory:update", async (_e, { filename, content, name, description, type }) => {
  return memory.updateMemory(filename, content, name, description, type);
});
ipcMain.handle("memory:delete", async (_e, filename) => {
  return memory.deleteMemory(filename);
});

// ── Skills IPC ─────────────────────────────────────────────

ipcMain.handle("skills:list-all", async () => skills.listSkills());
ipcMain.handle("skills:load-one", async (_e, name) => skills.loadSkill(name));
ipcMain.handle("skills:set-status", async (_e, name, status) => skills.setSkillStatus(name, status));
ipcMain.handle("skills:delete", async (_e, name) => skills.deleteSkill(name));
ipcMain.handle("skills:detect-patterns", async () => skills.detectPatterns(sessionDb));
ipcMain.handle("skills:curator-run", async () => skills.runCurator());
ipcMain.handle("skills:curator-status", async () => skills.getCuratorStatus());
ipcMain.handle("skills:curator-config", async (_e, config) => skills.setCuratorConfig(config || {}));
ipcMain.handle("skills:health", async (_e, name) => skills.getSkillHealth(name));
ipcMain.handle("skills:save", async (_e, name, meta, body) => skills.saveSkill(name, meta, body));
ipcMain.handle("skills:search", async (_e, query, limit) => skills.searchSkills(query, limit));
ipcMain.handle("skills:reindex", async () => { skills.reindexSkills(); return { ok: true }; });

ipcMain.handle("permission:respond", (event, { id, allow }) => {
  const resolve = pendingPerms.get(id);
  if (resolve) { resolve(allow); pendingPerms.delete(id); }
});

ipcMain.handle("ask:respond", (_event, { id, answers }) => {
  const resolve = _askResolvers.get(id);
  if (resolve) { resolve({ answers: answers || {} }); _askResolvers.delete(id); }
});

ipcMain.handle("skills:list", async () => {
  return scanSkills();
});

// ── System Prompt Profile Store ──────────────────────────────
let _promptStorePath = null;
function getPromptStorePath() {
  if (!_promptStorePath) {
    _promptStorePath = join(app.getPath("userData"), "system-prompt-profiles.json");
  }
  return _promptStorePath;
}

const DEFAULT_SECTIONS = {
  identity: {
    enabled: true,
    content: `You are GoodAgent, an expert coding assistant running on Windows with direct access to the user's computer. Your name is GoodAgent, NOT Claude and NOT DeepSeek — you are a desktop AI coding agent called GoodAgent.`,
  },
  workflow: {
    enabled: true,
    content: `1. First explore the project with \`dir\` or \`Get-ChildItem\`.
2. Understand the user's request clearly before taking action.
3. Plan your approach, then use the available tools to execute it.
4. Show relevant code when explaining changes.
5. Iterate based on user feedback to refine the result.`,
  },
  tools: {
    enabled: true,
    content: `**Available tools:**
- \`bash\` — Run PowerShell commands (dir, git, npm, etc.)
- \`file_read\` — Read file contents
- \`file_write\` — Create or overwrite files
- \`file_edit\` — Replace exact text in files
- \`grep\` — Regex search in files
- \`glob\` — Find files by name pattern
- \`web_fetch\` — Fetch and extract content from any URL
- \`web_search\` — Search the internet for current information
- \`skill\` — Load a user-installed skill (SKILL.md workflow)
- \`TaskCreate\` — Create tasks to track complex multi-step work
- \`TaskUpdate\` — Update task status (pending/in_progress/completed/deleted)
- \`TaskList\` — List all tasks to see progress
- \`TodoWrite\` — Update a lightweight session todo checklist
- \`write_memory\` — Save important facts to permanent memory
- \`create_skill\` — Create or update reusable skill workflows
- \`Agent\` — Launch a read-only sub-agent for parallel research, code exploration, or web searches
- \`AskUserQuestion\` — Ask the user clarifying multiple-choice questions

USE THE TOOLS. Don't just suggest — actually run commands, read files, make changes.`,
  },
  behavior: {
    enabled: true,
    content: `1. USE THE TOOLS. Don't just suggest — actually run commands, read files, make changes.
2. First explore the project with \`dir\` or \`Get-ChildItem\`.
3. When you need current information, news, or docs — use \`web_search\` and \`web_fetch\`.
4. Show relevant code when explaining.
5. Use \`file_edit\` or \`file_write\` for code changes.
6. Keep responses concise with Markdown formatting.
7. Always respond in the same language the user uses (if they write in Chinese, answer in Chinese; if English, answer in English).`,
  },
  communication: {
    enabled: false,
    content: `Keep responses concise with Markdown formatting. Always respond in the same language the user uses. Show relevant code when explaining your changes.`,
  },
  skills: {
    enabled: true,
    content: `If the user's request matches a skill's purpose, load it via the \`skill\` tool and follow its instructions.`,
  },
  safety: {
    enabled: true,
    content: `(No additional safety constraints configured. Edit this section to add security rules.)`,
  },
  runtime: {
    enabled: true,
    content: `You are running on Windows as a desktop AI coding agent.`,
  },
  examples: {
    enabled: false,
    content: ``,
  },
};

const SECTION_LABELS = {
  identity:      "身份定义",
  workflow:      "核心工作流",
  tools:         "工具使用协议",
  behavior:      "行为规范",
  communication: "沟通风格",
  skills:        "技能系统",
  safety:        "安全边界",
  runtime:       "运行时上下文",
  examples:      "示例",
};

function loadPromptProfiles() {
  try {
    if (existsSync(getPromptStorePath())) {
      const raw = readFileSync(getPromptStorePath(), "utf-8");
      const store = JSON.parse(raw);
      // ── Migration: populate empty default profile sections ──
      const def = store.profiles && store.profiles["default"];
      if (def && def.sections && def.sections.identity && !def.sections.identity.content) {
        def.sections = JSON.parse(JSON.stringify(DEFAULT_SECTIONS));
        savePromptProfiles(store);
        console.log("[main] Migrated default profile to DEFAULT_SECTIONS");
      }
      return store;
    }
  } catch (e) {
    console.error("[main] Failed to load prompt profiles:", e.message);
  }
  // Default: one profile with DEFAULT_SECTIONS
  return {
    activeProfile: "default",
    profiles: {
      default: {
        id: "default",
        name: "默认",
        enabled: true,
        sections: JSON.parse(JSON.stringify(DEFAULT_SECTIONS)),
      },
    },
  };
}

function savePromptProfiles(data) {
  try {
    const dir = dirname(getPromptStorePath());
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(getPromptStorePath(), JSON.stringify(data, null, 2), "utf-8");
  } catch (e) {
    console.error("[main] Failed to save prompt profiles:", e.message);
  }
}

ipcMain.handle("prompt:list", async () => {
  return loadPromptProfiles();
});

ipcMain.handle("prompt:save", async (_event, profile) => {
  const store = loadPromptProfiles();
  store.profiles[profile.id] = profile;
  savePromptProfiles(store);
  return { success: true };
});

ipcMain.handle("prompt:delete", async (_event, profileId) => {
  const store = loadPromptProfiles();
  if (profileId === "default") return { success: false, error: "Cannot delete default profile" };
  if (store.activeProfile === profileId) {
    store.activeProfile = "default";
  }
  delete store.profiles[profileId];
  savePromptProfiles(store);
  return { success: true };
});

ipcMain.handle("prompt:activate", async (_event, profileId) => {
  const store = loadPromptProfiles();
  if (!store.profiles[profileId]) return { success: false, error: "Profile not found" };
  store.activeProfile = profileId;
  savePromptProfiles(store);
  return { success: true };
});

ipcMain.handle("skills:load", async (_event, name) => {
  const skills = scanSkills();
  const skill = skills.find(s => s.name === name);
  if (!skill) return null;
  try {
    const content = readFileSync(skill.path, "utf-8");
    const meta = parseFrontMatter(content);
    const body = content.replace(/^---[\s\S]*?\n---\s*\n?/, "").trim();
    return { ...skill, body, content };
  } catch { return null; }
});

// ── MCP IPC Handlers ──────────────────────────────────────────

ipcMain.handle("mcp:list", async () => {
  return mcpManager.listServers();
});

ipcMain.handle("mcp:config", async () => {
  return mcpManager.loadConfig();
});

ipcMain.handle("mcp:add", async (_event, { name, config }) => {
  try {
    await mcpManager.addServer(name, config);
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

ipcMain.handle("mcp:add-remote", async (_event, { name, url, headers }) => {
  try {
    const config = {
      type: "streamableHttp",
      url,
      headers: headers || {},
    };
    await mcpManager.addServer(name, config);
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

ipcMain.handle("mcp:save-all", async () => {
  try {
    mcpManager.saveAllServers();
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

ipcMain.handle("mcp:remove", async (_event, name) => {
  try {
    await mcpManager.removeServer(name);
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

ipcMain.handle("mcp:restart", async (_event, name) => {
  try {
    const tools = await mcpManager.restartServer(name);
    return { success: true, tools };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

/**
 * Detect MCP servers from local config files (OpenCode, Claude Code, etc.)
 * Scans known locations for mcp.json / .mcp.json files and extracts server entries.
 */
ipcMain.handle("mcp:detect-local", async () => {
  const HOME = process.env.USERPROFILE || os.homedir();
  const APPDATA = process.env.APPDATA || join(HOME, "AppData", "Roaming");
  const found = [];

  /** Read MCP entries from a JSON file. Supports multiple key names and formats. */
  function readMcpServers(filePath, source, opts = {}) {
    if (!existsSync(filePath)) return [];
    try {
      const raw = readFileSync(filePath, "utf-8");
      const data = JSON.parse(raw);
      // Try each possible key in order: mcpServers (standard), mcp (OpenCode opencode.json)
      const keys = opts.keys || ["mcpServers"];
      let servers = {};
      for (const k of keys) {
        if (data[k] && typeof data[k] === "object") {
          servers = data[k];
          break;
        }
      }
      const entries = [];
      for (const [name, cfg] of Object.entries(servers)) {
        if (!cfg || typeof cfg !== "object") continue;
        const normalized = {
          source,
          serverName: name,
          kind: cfg.command ? "stdio" : "remote",
          command: cfg.command || "",
          args: cfg.args || [],
          env: cfg.env || {},
          url: cfg.baseUrl || cfg.url || "",
          headers: cfg.headers || {},
          description: cfg.description || "",
        };
        if (cfg.isActive === false || cfg.enabled === false) {
          normalized.disabled = true;
        }
        entries.push(normalized);
      }
      return entries;
    } catch (e) {
      console.error(`[mcp] Failed to read ${filePath}:`, e.message);
      return [];
    }
  }

  // Claude Code CLI: ~/.claude/.mcp.json (mcpServers key) + ~/.claude/settings.json (mcpServers key)
  for (const p of [join(HOME, ".claude", ".mcp.json"), join(HOME, ".claude", "settings.json")]) {
    found.push(...readMcpServers(p, "Claude Code"));
  }
  // OpenCode: mcp.json (mcpServers key) + opencode.json (mcp key)
  found.push(...readMcpServers(join(HOME, ".config", "opencode", "mcp.json"), "OpenCode"));
  found.push(...readMcpServers(join(HOME, ".config", "opencode", "opencode.json"), "OpenCode", { keys: ["mcp"] }));
  // Claude Desktop (App): %APPDATA%/Claude/*/mcp.json
  for (const p of [join(APPDATA, "Claude", "claude_dotfiles", "mcp.json"), join(APPDATA, "Claude", "mcp.json")]) {
    found.push(...readMcpServers(p, "Claude Desktop"));
  }

  // Deduplicate: keep the first occurrence per (source, serverName) pair
  const seen = new Set();
  const deduped = [];
  for (const entry of found) {
    const key = `${entry.source}||${entry.serverName}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(entry);
  }

  return deduped;
});

/**
 * Quick-add a SearXNG MCP server given just its URL.
 * Configures npx mcp-searxng@latest with proper env.
 */
ipcMain.handle("mcp:quick-add-searxng", async (_event, searxngUrl) => {
  try {
    if (!searxngUrl || typeof searxngUrl !== "string") {
      return { success: false, error: "请提供 SearXNG URL" };
    }
    // Validate URL
    const u = new URL(searxngUrl);
    if (!u.protocol.startsWith("http")) {
      return { success: false, error: "URL 必须以 http:// 或 https:// 开头" };
    }

    const config = {
      command: "npx",
      args: ["-y", "mcp-searxng@latest"],
      env: {
        SEARXNG_URL: searxngUrl.replace(/\/+$/, ""),
        SEARXNG_TIMEOUT: "15000",
        SEARXNG_SAFE_SEARCH: "1",
      },
    };
    await mcpManager.addServer("searxng", config);
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

ipcMain.handle("dialog:download-markdown", async (_event, content) => {
  const win = BrowserWindow.getFocusedWindow();
  if (!win) return { success: false, error: "No focused window" };

  const result = await dialog.showSaveDialog(win, {
    title: "下载为 Markdown",
    defaultPath: `agent-response-${Date.now()}.md`,
    filters: [{ name: "Markdown", extensions: ["md"] }],
  });

  if (result.canceled || !result.filePath) {
    return { success: false, canceled: true };
  }

  try {
    writeFileSync(result.filePath, content, "utf-8");
    return { success: true, filePath: result.filePath };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

// ════════════════════════════════════════════════════════════
//  WeChat iLink Bridge — QR Login + Bot
// ════════════════════════════════════════════════════════════

const WX_BASE = "https://ilinkai.weixin.qq.com";
const WX_BOT_TYPE = "3";
const WX_POLL_TIMEOUT = 40_000;
const WX_MSG_CHUNK = 4000;
const MSG_ITEM_TEXT = 1;
const MSG_TYPE_BOT = 2;
const MSG_STATE_FINISH = 2;

let wxBotToken = null;
let wxBotId = null;
let wxUserId = null;
let wxPollAbort = null;
let _lastApiConfig = {}; // cache from desktop chat

function randomWxUin() {
  return Buffer.from(String(Math.floor(Math.random() * 4294967296)), "utf-8").toString("base64");
}

function wxHeaders(token) {
  const h = {
    "Content-Type": "application/json",
    "X-WECHAT-UIN": randomWxUin(),
    "iLink-App-ClientVersion": "1",
  };
  if (token) {
    h["AuthorizationType"] = "ilink_bot_token";
    h["Authorization"] = `Bearer ${token}`;
  }
  return h;
}

async function getWechatQrcode() {
  try {
    const res = await fetch(`${WX_BASE}/ilink/bot/get_bot_qrcode?bot_type=${WX_BOT_TYPE}`, { headers: wxHeaders() });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    const data = await res.json();
    if (!data.qrcode) return { ok: false, error: "no qrcode" };
    const qrText = data.qrcode_img_content || data.qrcode;
    const qrDataUrl = await QRCode.toDataURL(qrText, { width: 280, margin: 2 });
    return { ok: true, qrcodeUrl: qrDataUrl, qrcodeId: data.qrcode };
  } catch (err) { return { ok: false, error: err.message }; }
}

async function pollQrcodeStatus(qrcodeId) {
  if (!qrcodeId) return { status: "error", error: "missing qrcodeId" };
  try {
    const url = `${WX_BASE}/ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcodeId)}`;
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 45_000);
    let res;
    try { res = await fetch(url, { headers: wxHeaders(), signal: ctrl.signal }); } finally { clearTimeout(t); }
    if (!res.ok) return { status: "error", error: `HTTP ${res.status}` };
    const data = await res.json();
    switch (data.status) {
      case "wait": return { status: "waiting" };
      case "scaned": return { status: "scanned" };
      case "confirmed":
        if (!data.bot_token) return { status: "error", error: "no token" };
        return { status: "confirmed", botToken: data.bot_token, botId: data.ilink_bot_id, userId: data.ilink_user_id };
      case "expired": return { status: "expired" };
      default: return { status: data.status || "waiting" };
    }
  } catch (err) { return { status: "error", error: err.message }; }
}

async function wxApi(endpoint, body, timeoutMs = WX_POLL_TIMEOUT) {
  if (!wxBotToken) throw new Error("not logged in");
  const url = new URL(endpoint, WX_BASE.endsWith("/") ? WX_BASE : WX_BASE + "/");
  const ctrl = new AbortController();
  const t = timeoutMs ? setTimeout(() => ctrl.abort(), timeoutMs + 5000) : null;
  try {
    const res = await fetch(url.toString(), {
      method: "POST", headers: wxHeaders(wxBotToken),
      body: JSON.stringify(body), signal: ctrl.signal,
    });
    if (!res.ok) { const txt = await res.text().catch(() => ""); throw new Error(`HTTP ${res.status}: ${txt.slice(0,100)}`); }
    return await res.json();
  } finally { if (t) clearTimeout(t); }
}

async function wxSendMessage(chatId, text, contextToken) {
  if (!contextToken) throw new Error("需要对方先发消息才能回复");
  for (let i = 0; i < text.length; i += WX_MSG_CHUNK) {
    await wxApi("ilink/bot/sendmessage", {
      msg: { from_user_id: "", to_user_id: chatId,         client_id: randomUUID(),
        message_type: MSG_TYPE_BOT, message_state: MSG_STATE_FINISH,
        item_list: [{ type: MSG_ITEM_TEXT, text_item: { text: text.slice(i, i + WX_MSG_CHUNK) } }],
        context_token: contextToken },
      base_info: { channel_version: "1.0.0" },
    }, 30000);
  }
}

function extractText(itemList) {
  let t = "";
  for (const it of itemList || []) { if (it.type === 1 && it.text_item?.text) t += it.text_item.text; }
  return t;
}

async function wxPollLoop() {
  wxPollAbort = new AbortController();
  let buf = "", fails = 0;
  console.log("[wechat] poll loop started");
  while (!wxPollAbort.signal.aborted) {
    try {
      const resp = await wxApi("ilink/bot/getupdates", { get_updates_buf: buf, base_info: { channel_version: "1.0.0" } });
      fails = 0; if (resp.get_updates_buf) buf = resp.get_updates_buf;
      const msgCount = (resp.msgs || []).length;
      if (msgCount > 0) console.log(`[wechat] received ${msgCount} messages`);
      sendToRenderer("wechat:bot-status", { status: "connected" });
      for (const msg of resp.msgs || []) {
        const uid = msg.from_user_id || "";
        if (!uid || uid.endsWith("@im.bot")) continue;
        const text = extractText(msg.item_list);
        if (!text) continue;
        console.log(`[wechat] incoming from ${uid}: "${text.substring(0, 50)}"`);
        sendToRenderer("wechat:incoming", { userId: uid, text: text.substring(0, 200) });
        try {
          const reply = await generateWxReply(text);
          console.log(`[wechat] replying: "${reply.substring(0, 50)}..."`);
          await wxSendMessage(uid, reply, msg.context_token);
        } catch (err) {
          console.error("[wechat] reply:", err.message);
          try { await wxSendMessage(uid, `[${err.message}]`, msg.context_token); } catch {}
        }
      }
    } catch (err) {
      if (err.name === "AbortError") continue;
      console.error(`[wechat] poll error (fail ${++fails}/3):`, err.message);
      if (fails >= 3) sendToRenderer("wechat:bot-status", { status: "error", error: err.message });
      await new Promise(r => setTimeout(r, 5000));
    }
  }
  console.log("[wechat] poll loop ended");
}

function loadWxConfig() {
  const p = join(process.env.USERPROFILE || os.homedir(), ".goodagent", "config", "wechat.json");
  try { return JSON.parse(readFileSync(p, "utf8")); } catch { return {}; }
}
function saveWxConfig(cfg) {
  const d = join(process.env.USERPROFILE || os.homedir(), ".goodagent", "config");
  try { mkdirSync(d, { recursive: true }); } catch {}
  writeFileSync(join(d, "wechat.json"), JSON.stringify(cfg, null, 2));
}

async function generateWxReply(prompt) {
  // Try wechat.json first, fallback to cached desktop config
  const cfg = loadWxConfig();
  const apiKey = cfg.apiKey || _lastApiConfig.apiKey;
  const apiUrl = cfg.apiUrl || _lastApiConfig.apiUrl;
  const model = cfg.model || _lastApiConfig.model || "deepseek-chat";
  const apiFormat = cfg.apiFormat || _lastApiConfig.apiFormat || "openai";

  if (!apiKey || !apiUrl) return "请先在桌面端发送一条消息激活 API，或重新扫码登录";

  try {
    const result = await agentLoop(prompt, apiKey, apiUrl, model, apiFormat, [], [], false, "");
    return result.text || "";
  } catch (err) {
    console.error("[wechat] agentLoop error:", err.message);
    return `[出错: ${err.message}]`;
  }
}

// ── IPC ─────────────────────────────────────────────────────

ipcMain.handle("wechat:get-qrcode", async () => await getWechatQrcode());
ipcMain.handle("wechat:poll-status", async (_e, qrcodeId) => await pollQrcodeStatus(qrcodeId));

ipcMain.handle("wechat:login", async (_e, creds) => {
  console.log("[wechat] login with creds:", { hasToken: !!creds.botToken, hasApiKey: !!creds.apiKey, apiUrl: creds.apiUrl });
  wxBotToken = creds.botToken; wxBotId = creds.botId; wxUserId = creds.userId;
  saveWxConfig({ botToken: creds.botToken, botId: creds.botId, userId: creds.userId, apiKey: creds.apiKey, apiUrl: creds.apiUrl, model: creds.model, apiFormat: creds.apiFormat });
  wxPollLoop().catch(e => console.error("[wechat] poll:", e.message));
  return { ok: true };
});

ipcMain.handle("wechat:logout", async () => {
  if (wxPollAbort) { wxPollAbort.abort("logout"); wxPollAbort = null; }
  wxBotToken = null; wxBotId = null; wxUserId = null;
  try { unlinkSync(join(process.env.USERPROFILE || os.homedir(), ".goodagent", "config", "wechat.json")); } catch {}
  sendToRenderer("wechat:bot-status", { status: "disconnected" });
  return { ok: true };
});

ipcMain.handle("wechat:get-status", async () => {
  const cfg = loadWxConfig();
  return { loggedIn: !!wxBotToken, botId: wxBotId || cfg.botId, userId: wxUserId || cfg.userId, status: wxBotToken ? "running" : "disconnected" };
});

// Sync desktop API config to WeChat config
ipcMain.handle("api:sync-to-wechat", async (_e, { apiUrl, apiKey, model, apiFormat }) => {
  const cfg = loadWxConfig();
  cfg.apiUrl = apiUrl; cfg.apiKey = apiKey; cfg.model = model; cfg.apiFormat = apiFormat;
  saveWxConfig(cfg);
  return { ok: true };
});

// Auto-start
app.whenReady().then(async () => {
  try {
    const cfg = loadWxConfig();
    if (cfg.botToken) {
      wxBotToken = cfg.botToken; wxBotId = cfg.botId; wxUserId = cfg.userId;
      console.log("[wechat] auto-starting bot from saved config");
      wxPollLoop().catch(e => console.error("[wechat] auto-start:", e.message));
    }
  } catch {}
});




