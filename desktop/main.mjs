import { app, BrowserWindow, ipcMain, dialog, session, Menu } from "electron";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, execSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, statSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import { readFile, writeFile, mkdir, readdir, unlink } from "node:fs/promises";
import mcpManager from "./mcp-manager.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
app.commandLine.appendSwitch("no-sandbox");
const isDev = process.argv.includes("--dev");

// Prefer pwsh (PowerShell 7+ with native UTF-8) over powershell.exe (uses system code page, breaks on Chinese)
const PS_EXE = (() => { try { execSync("where pwsh", { stdio: "ignore" }); return "pwsh"; } catch { return "powershell"; } })();

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
  // Start enabled MCP servers (async, non-blocking)
  mcpManager.init().catch(e => console.error("[main] mcpManager.init error:", e.message));
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
  // Extract simple YAML key-value pairs and arrays
  for (const line of yaml.split("\n")) {
    const kv = line.match(/^\s*(\w[\w-]*)\s*:\s*(.+)/);
    if (kv) {
      const val = kv[2].trim();
      if (val.startsWith("[")) {
        try { meta[kv[1]] = JSON.parse(val.replace(/'/g, '"')); } catch {}
      } else if (val.startsWith("|") || val.startsWith(">")) {
        // multi-line scalar — skip for now, just use the first line
      } else {
        meta[kv[1]] = val.replace(/^["']|["']$/g, "");
      }
    }
    // Handle array items under a key (e.g. triggers:\n  - weekly retro)
    const arrMatch = line.match(/^\s+-\s+(.+)/);
    if (arrMatch && meta.triggers) {
      // determine which key this belongs to by finding the last key
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
];

// ── Tool Executor ──────────────────────────────────────────

const WORKSPACE = process.cwd();
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

// ── Session Persistence ──────────────────────────────────────
const SESSION_DIR = join(app.getPath("userData"), "sessions");

async function ensureSessionDir() {
  try { await mkdir(SESSION_DIR, { recursive: true }); } catch {}
}

function sessionFilePath(id) {
  return join(SESSION_DIR, `${id}.json`);
}

async function saveSession(id, hist, title) {
  await ensureSessionDir();
  const file = sessionFilePath(id);
  let data;
  try {
    const raw = await readFile(file, "utf8");
    data = JSON.parse(raw);
  } catch { data = {}; }
  data.id = id;
  data.title = title || data.title || (hist.length > 0 ? hist[0].content?.slice(0, 30) : "(空对话)");
  data.updatedAt = Date.now();
  if (!data.createdAt) data.createdAt = Date.now();
  data.history = hist;
  await writeFile(file, JSON.stringify(data, null, 2), "utf8");
}

async function listSessions() {
  await ensureSessionDir();
  try {
    const files = await readdir(SESSION_DIR);
    const sessions = [];
    for (const f of files) {
      if (!f.endsWith(".json")) continue;
      try {
        const raw = await readFile(join(SESSION_DIR, f), "utf8");
        const data = JSON.parse(raw);
        sessions.push({ id: data.id, title: data.title, createdAt: data.createdAt, updatedAt: data.updatedAt });
      } catch {}
    }
    sessions.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    return sessions;
  } catch { return []; }
}

async function loadSession(id) {
  try {
    const raw = await readFile(sessionFilePath(id), "utf8");
    return JSON.parse(raw);
  } catch { return null; }
}

async function deleteSession(id) {
  try { await unlink(sessionFilePath(id)); } catch {}
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

function buildSystemPrompt(enabledSkills, agentName) {
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

**Rules:**
1. USE THE TOOLS. Don't just suggest — actually run commands, read files, make changes.
2. First explore the project with \`dir\` or \`Get-ChildItem\`.
3. When you need current information, news, or docs — use \`web_search\` and \`web_fetch\`.
4. Show relevant code when explaining.
5. Use \`file_edit\` or \`file_write\` for code changes.
6. Keep responses concise with Markdown formatting.
7. Always respond in the same language the user uses (if they write in Chinese, answer in Chinese; if English, answer in English).`;
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

  return { role: "system", content };
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

  const sysPrompt = buildSystemPrompt(enabledSkills, agentName);
  const msgs = [sysPrompt, ...history, userMessage];
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
  if (history.length > 40) history = history.slice(-40);

  // Auto-save after each turn
  if (sessionId) {
    const title = getHistoryTitle(history);
    saveSession(sessionId, history, title).catch(() => {});
  }

  return { text: allText || "(no text response)" };
}

// ── IPC Handlers ────────────────────────────────────────────

ipcMain.handle("query:submit", async (event, { prompt, apiKey, apiUrl, model, apiFormat = "openai", files = [], enabledSkills, reasoning = true, agentName }) => {
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

ipcMain.handle("permission:respond", (event, { id, allow }) => {
  const resolve = pendingPerms.get(id);
  if (resolve) { resolve(allow); pendingPerms.delete(id); }
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
    return { ...skill, content };
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


