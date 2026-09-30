import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { app } from "electron";

/**
 * MCP Manager — manages MCP server child processes over JSON-RPC 2.0 (stdio).
 *
 * Protocol flow per server:
 *   1. Client sends "initialize" request
 *   2. Client sends "notifications/initialized" (fire-and-forget)
 *   3. Client sends "tools/list" → cache tool definitions
 *   4. For each tool call → "tools/call" request
 *
 * Config stored at: app.getPath("userData")/mcp-servers.json
 * Format matches Claude Code's .mcp.json for easy migration.
 */
/**
 * Built-in MCP server definitions.
 * These are pre-configured in code — users just toggle them on/off.
 */
const BUILTIN_SERVERS = Object.freeze({
  "edge-browser": {
    label: "Edge 浏览器",
    labelEn: "Edge Browser",
    description: "通过 Playwright 操控 Edge 浏览器，支持网页抓取、截图、自动化操作",
    descriptionEn: "Control Edge via Playwright — web scraping, screenshots, automation",
    command: "npx",
    args: ["-y", "@playwright/mcp@latest", "--browser", "msedge"],
    env: {},
    docs: "https://www.npmjs.com/package/@playwright/mcp",
  },
  "computer-use": {
    label: "桌面控制",
    labelEn: "Computer Use",
    description: "AI 桌面操控（截图、点击、键盘输入等），基于系统无障碍 API",
    descriptionEn: "Desktop control via accessibility APIs — screenshots, clicks, keyboard input",
    command: "npx",
    args: ["-y", "open-computer-use@0.1.52", "mcp"],
    env: {},
    docs: "https://github.com/iFurySt/open-codex-computer-use",
    defaultEnabled: false,
  },
});

/**
 * Validate an MCP server command + args before spawn. Returns null if safe
 * to spawn, or an error message string explaining why it was rejected.
 *
 * The check is conservative by design. A safe MCP command is one of:
 *   - an absolute path (e.g. `/usr/local/bin/foo`, `C:\Program Files\foo.exe`)
 *   - a bare binary name resolvable via PATH (e.g. `node`, `npx`, `uvx`)
 *   - a relative path with no shell metacharacters (e.g. `./server.sh`)
 *
 * Rejected: anything containing `;`, `&`, `|`, backticks, `$(...)`, `${...}`,
 * `>`, `<`, or newlines. These are all things that should never legitimately
 * appear in a command name or argument, but would let a shell re-interpret
 * the command if it were ever invoked via shell.
 *
 * @param {string} command
 * @param {Array<string> | undefined} args
 * @returns {string | null} null if safe, else reason
 */
const SHELL_METACHARS = /[;&|`$<>\\\n\r]/;
function validateMcpCommand(command: string, args: Array<string> | undefined): string | null {
  if (typeof command !== "string" || command.length === 0) {
    return "command must be a non-empty string";
  }
  if (SHELL_METACHARS.test(command)) {
    return `command contains shell metacharacter: ${command.slice(0, 40)}`;
  }
  if (Array.isArray(args)) {
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (typeof a !== "string") return `arg[${i}] is not a string`;
      if (SHELL_METACHARS.test(a)) {
        return `arg[${i}] contains shell metacharacter: ${a.slice(0, 40)}`;
      }
    }
  }
  return null;
}

interface McpServerEntry {
  process: import("child_process").ChildProcess | null;
  config: Record<string, any>;
  tools: any[];
  status: string;
  error: string | null;
  buffer: string;
}

class McpManager {
  servers: Record<string, McpServerEntry> = {};
  _pending: Map<number, { resolve: (v: any) => void, reject: (e: any) => void, timer: NodeJS.Timeout, serverName: string }> = new Map();
  _nextId = 0;
  _builtinState: Record<string, boolean> = {};

  constructor() {}

  // ── Config persistence ──────────────────────────────────────

  getStorePath() {
    return join(app.getPath("userData"), "mcp-servers.json");
  }

  loadConfig(): Record<string, any> {
    try {
      if (existsSync(this.getStorePath())) {
        const cfg = JSON.parse(readFileSync(this.getStorePath(), "utf-8"));
        return cfg;
      }
    } catch (e: any) {
      console.error("[mcp] Failed to load config:", e.message);
    }
    return { servers: {}, builtins: {} };
  }

  saveConfig(config: Record<string, any>): void {
    try {
      const dir = dirname(this.getStorePath());
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      writeFileSync(this.getStorePath(), JSON.stringify(config, null, 2), "utf-8");
    } catch (e: any) {
      console.error("[mcp] Failed to save config:", e.message);
    }
  }

  // ── Lifecycle ───────────────────────────────────────────────

  /** Start all enabled servers. Called once on app startup. */
  async init() {
    const config = this.loadConfig();
    this._builtinState = config.builtins || {};
    const promises: Promise<any>[] = [];
    for (const [name, cfg] of Object.entries(config.servers || {})) {
      const c = cfg as any;
      if (name in BUILTIN_SERVERS) continue; // duplicate of a builtin — started below
      if (c.enabled !== false) {
        const isRemote = c.type === "remote" || c.type === "streamableHttp" || c.url || c.baseUrl;
        const starter = isRemote ? this.startRemoteServer(name, c) : this.startServer(name, c);
        promises.push(
          starter.catch((e: any) => {
            console.error(`[mcp] Failed to start "${name}":`, e.message);
          })
        );
      }
    }
    // Start enabled builtin servers
    for (const [name, definition] of Object.entries(BUILTIN_SERVERS)) {
      // defaultEnabled: false = opt-in, only start if user explicitly enabled
      const state = this._builtinState[name];
      const shouldStart = (definition as any).defaultEnabled === false ? state === true : state !== false;
      if (shouldStart) {
        console.log(`[mcp] Starting builtin "${name}"...`);
        const cfg = { command: definition.command, args: [...definition.args], env: { ...definition.env } };
        promises.push(
          this.startServer(name, cfg).catch((e: any) => {
            console.error(`[mcp] Failed to start builtin "${name}":`, e.message);
          })
        );
      }
    }
    await Promise.allSettled(promises);
  }

  /** Start (or restart) a single MCP server. */
  async startServer(name: string, cfg: any) {
    if (this.servers[name]) await this.stopServer(name);

    // SECURITY: Validate command before spawn. A malicious or compromised
    // MCP config (e.g. pasted from a sketchy blog post) could otherwise
    // exploit `shell: true` to run arbitrary commands. We require:
    //   - command is a non-empty string
    //   - command does not contain shell metacharacters that would let
    //     `cmd.exe` / `sh` reinterpret it
    //   - args (if any) don't try to break out via `;`, `&`, `|`, backticks
    //     or `$(...)` substitution
    // The check is intentionally conservative — false positives (rejecting
    // a valid config) are better than RCE. Users who hit a false positive
    // can rename their binary or split the command.
    const cmdCheck = validateMcpCommand(cfg.command, cfg.args);
    if (cmdCheck) throw new Error(`MCP server "${name}" rejected: ${cmdCheck}`);

    const env = { ...process.env };
    if (cfg.env) Object.assign(env, cfg.env);

    // Windows requires `shell: true` to execute `.cmd` / `.bat` files via
    // `npx`, `pnpm`, etc. — without it, Node's spawn() returns ENOENT
    // because it looks for `npx.exe` and the npm-installed shim is
    // `npx.cmd`. With the validator above rejecting any shell-metachar
    // input, going through cmd.exe on Windows does NOT enable injection —
    // the dangerous inputs are blocked at validation time. macOS/Linux
    // keep `shell: false` to avoid the broader shell attack surface.
    const proc = spawn(cfg.command, cfg.args || [], {
      stdio: ["pipe", "pipe", "pipe"],
      env,
      shell: process.platform === "win32",
    });

    const server: McpServerEntry = {
      process: proc,
      config: cfg,
      tools: [],
      status: "starting",
      error: null,
      buffer: "",
    };
    this.servers[name] = server;

    proc.stdout.on("data", (chunk: any) => {
      server.buffer += chunk.toString();
      this._processBuffer(name);
    });

    proc.stderr.on("data", (chunk: any) => {
      const text = chunk.toString().trim();
      if (text) console.error(`[mcp:${name}]`, text);
    });

    proc.on("error", (err: any) => {
      server.status = "error";
      server.error = err.message;
      this._rejectPendingForServer(name, err.message);
    });

    proc.on("close", (code: any) => {
      server.status = "stopped";
      server.process = null;
      this._rejectPendingForServer(name, `Server closed (code ${code})`);
    });

    try {
      // Step 1: Initialize
      await this._request(name, "initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "AideAgent", version: "1.0" },
      }, 30000);

      // Step 2: Initialized notification
      this._notify(name, "notifications/initialized", {});

      // Step 3: List and cache tools
      const listResult = await this._request(name, "tools/list", {}, 30000) as any;
      server.tools = listResult.tools || [];
      server.status = "running";

      console.log(`[mcp] "${name}" started (${server.tools.length} tools)`);
      return server.tools;
    } catch (e: any) {
      server.status = "error";
      server.error = e.message;
      // Kill process on failed init — detach 'close' first so its late event
      // can't reject another attempt's pending requests (they're keyed by name).
      proc.removeAllListeners("close");
      if (proc.exitCode === null) proc.kill();
      server.process = null;
      throw e;
    }
  }

  // ── Remote (HTTP) MCP server support ────────────────────────────

  async startRemoteServer(name: string, cfg: any) {
    const server: McpServerEntry = {
      process: null,
      config: cfg,
      tools: [],
      status: "starting",
      error: null,
      buffer: "",
    };
    this.servers[name] = server;

    const url = cfg.url || cfg.baseUrl;
    if (!url) throw new Error(`Remote server "${name}" has no URL`);

    const headers = { ...(cfg.headers || {}) };
    if (!headers["Content-Type"]) headers["Content-Type"] = "application/json";

    // Helper: POST a JSON-RPC message to the remote endpoint
    const _post = async (body: any, signal: AbortSignal) => {
      const resp = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal,
      });
      if (!resp.ok) {
        const text = await resp.text().catch(() => "");
        throw new Error(`HTTP ${resp.status}${text ? ": " + text.slice(0, 200) : ""}`);
      }
      // streamableHttp may return SSE stream; for now read full response
      const text = await resp.text();
      if (!text) return {};
      try { return JSON.parse(text); } catch { return {}; }
    };

    const ac = new AbortController();
    const timeout = setTimeout(() => ac.abort(), 30000);

    try {
      // Step 1: Initialize
      const initResult = await _post({
        jsonrpc: "2.0",
        id: ++this._nextId,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "AideAgent", version: "1.0" },
        },
      }, ac.signal);
      if (initResult.error) throw new Error(initResult.error.message);

      // Step 2: Initialized notification (fire-and-forget)
      await _post({
        jsonrpc: "2.0",
        method: "notifications/initialized",
        params: {},
      }, ac.signal).catch(() => {});

      // Step 3: List and cache tools
      const listResult = await _post({
        jsonrpc: "2.0",
        id: ++this._nextId,
        method: "tools/list",
        params: {},
      }, ac.signal);
      if (listResult.error) throw new Error(listResult.error.message);
      server.tools = listResult.result?.tools || [];
      server.status = "running";

      console.log(`[mcp] Remote "${name}" connected (${server.tools.length} tools)`);
      return server.tools;
    } catch (e: any) {
      server.status = "error";
      server.error = e.message;
      delete this.servers[name];
      throw e;
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * Send a JSON-RPC request to a remote MCP server via HTTP POST.
   */
  async _remoteRequest(name: string, method: string, params: any, timeout = 30000) {
    const server = this.servers[name];
    if (!server) throw new Error(`Server "${name}" not found`);
    const url = server.config.url || server.config.baseUrl;
    if (!url) throw new Error(`Server "${name}" has no URL`);

    const headers = { ...(server.config.headers || {}) };
    if (!headers["Content-Type"]) headers["Content-Type"] = "application/json";

    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeout);

    try {
      const resp = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: ++this._nextId,
          method,
          params,
        }),
        signal: ac.signal,
      });
      if (!resp.ok) {
        const text = await resp.text().catch(() => "");
        throw new Error(`HTTP ${resp.status}${text ? ": " + text.slice(0, 200) : ""}`);
      }
      const text = await resp.text();
      if (!text) return {};
      const data = JSON.parse(text);
      if (data.error) throw new Error(data.error.message);
      return data.result;
    } finally {
      clearTimeout(timer);
    }
  }

  async stopServer(name: string) {
    const server = this.servers[name];
    if (!server) return;
    if (server.process) {
      // Detach the 'close' listener BEFORE kill. It fires asynchronously and
      // rejects pendings keyed by server *name* — a late close from the old
      // process would reject the replacement process's initialize handshake.
      server.process.removeAllListeners("close");
      if (server.process.exitCode === null) {
        try { server.process.stdin?.end(); } catch { /* ignored */ }
        server.process.kill();
      }
      server.process = null;
    }
    // For remote servers there's no child process — just remove from map
    delete this.servers[name];
  }

  /**
   * Stop ALL running MCP servers. Called by main.mjs on `app.on("will-quit")`
   * so npx subprocesses don't outlive the app. Without this, every restart
   * leaves orphaned `npx` children that hold file locks on Windows.
   * Best-effort: each stopServer is independent, so a single failure doesn't
   * skip the rest.
   */
  async shutdown() {
    const names = Object.keys(this.servers);
    await Promise.allSettled(names.map((n) => this.stopServer(n)));
  }

  async restartServer(name: string) {
    const config = this.servers[name]?.config || this._findConfig(name);
    if (!config) throw new Error(`Server "${name}" not found`);
    await this.stopServer(name);
    const c: any = config;
    const isRemote = c.type === "remote" || c.type === "streamableHttp" || c.url || c.baseUrl;
    return isRemote ? this.startRemoteServer(name, c) : this.startServer(name, c);
  }

  /** Save a new or updated server config and start if enabled. */
  async addServer(name: string, cfg: Record<string, any>) {
    const config = this.loadConfig();
    config.servers[name] = cfg;
    this.saveConfig(config);
    if (cfg.enabled !== false) {
      const isRemote = cfg.type === "remote" || cfg.type === "streamableHttp" || cfg.url || cfg.baseUrl;
      return isRemote ? this.startRemoteServer(name, cfg) : this.startServer(name, cfg);
    }
  }

  /** Remove a server from config and stop it. */
  async removeServer(name: string) {
    const config = this.loadConfig();
    delete config.servers[name];
    this.saveConfig(config);
    await this.stopServer(name);
  }

  /** Persist all currently running servers to disk config. */
  saveAllServers() {
    const config = this.loadConfig();
    for (const [name, s] of Object.entries(this.servers)) {
      if (name in BUILTIN_SERVERS) continue; // builtins are defined in code — never persist them
      if (s.config) {
        config.servers[name] = s.config;
      }
    }
    this.saveConfig(config);
  }

  _findConfig(name: string): any {
    const config = this.loadConfig();
    return config.servers?.[name];
  }

  // ── JSON-RPC primitives ─────────────────────────────────────

  _notify(name: string, method: string, params: any) {
    const server = this.servers[name];
    if (!server?.process?.stdin?.writable) {
      throw new Error(`Server "${name}" not running`);
    }
    const msg = JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n";
    server.process.stdin.write(msg);
  }

  _request(name: string, method: string, params: any, timeout = 30000) {
    const server = this.servers[name];
    if (!server?.process?.stdin?.writable) {
      return Promise.reject(new Error(`Server "${name}" not running`));
    }
    const id = ++this._nextId;
    const msg = JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n";

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._pending.delete(id);
        reject(new Error(`Request "${method}" to "${name}" timed out (${timeout}ms)`));
      }, timeout);
      this._pending.set(id, { resolve, reject, timer, serverName: name });
      server.process?.stdin?.write(msg);
    });
  }

  _processBuffer(name: string) {
    const server = this.servers[name];
    if (!server) return;

    const lines = server.buffer.split("\n");
    server.buffer = lines.pop() || ""; // keep incomplete trailing line

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const msg = JSON.parse(trimmed);

        // Match response to pending request by ID
        if (msg.id !== undefined && this._pending.has(msg.id)) {
          const pending = this._pending.get(msg.id);
          this._pending.delete(msg.id);
          if (!pending) continue;
          clearTimeout(pending.timer);
          if (msg.error) {
            pending.reject(new Error(msg.error.message || "JSON-RPC error"));
          } else {
            pending.resolve(msg.result);
          }
        }
        // Notifications with no ID are ignored
      } catch (e: any) {
        console.error(`[mcp:${name}] Parse error:`, e.message, trimmed.slice(0, 200));
      }
    }
  }

  _rejectPendingForServer(name: string, reason: string) {
    for (const [id, pending] of this._pending) {
      if (pending.serverName === name) {
        clearTimeout(pending.timer);
        pending.reject(new Error(reason));
        this._pending.delete(id);
      }
    }
  }

  // ── Public query API ────────────────────────────────────────

  /** Get all running servers with their status and tools. */
  listServers() {
    return Object.entries(this.servers).map(([name, s]) => ({
      name,
      status: s.status,
      error: s.error,
      tools: s.tools.map(t => ({ name: t.name, description: t.description })),
      config: s.config,
    }));
  }

  /** Get all tools from all running servers (with server name attached). */
  listAllTools() {
    const all = [];
    for (const [serverName, server] of Object.entries(this.servers)) {
      if (server.status !== "running") continue;
      for (const tool of server.tools) {
        all.push({ serverName, ...tool });
      }
    }
    return all;
  }

  /** Get all tool definitions in OpenAI function-calling format. */
  listAllToolDefs({ excludeServers = [], excludeCategories = [] }: { excludeServers?: string[], excludeCategories?: string[] } = {}) {
    const defs: any[] = [];
    for (const [serverName, server] of Object.entries(this.servers)) {
      if (server.status !== "running") continue;
      if (excludeServers.includes(serverName)) continue;
      const cfg = this.loadConfig().servers?.[serverName] || {};
      if (excludeCategories.length > 0 && excludeCategories.includes(cfg.category)) continue;
      for (const tool of server.tools) {
        defs.push({
          type: "function",
          function: {
            name: tool.name,
            description: tool.description || "",
            parameters: tool.inputSchema || { type: "object", properties: {} },
          },
        });
      }
    }
    return defs;
  }

  /** Call a tool by name across all running servers (stdio + remote). */
  async callTool(name: string, args: any) {
    for (const [serverName, server] of Object.entries(this.servers)) {
      if (server.status !== "running") continue;
      if (server.tools.some(t => t.name === name)) {
        const isRemote = !server.process;
        if (isRemote) {
          return this._remoteRequest(serverName, "tools/call", { name, arguments: args }, 60000);
        }
        return this._request(serverName, "tools/call", {
          name,
          arguments: args,
        }, 60000);
      }
    }
    throw new Error(`MCP tool "${name}" not found in any running server`);
  }

  // ── Built-in servers ────────────────────────────────────────

  /** Get definitions and state of all built-in servers. */
  getBuiltins() {
    const results: any[] = [];
    for (const [name, def] of Object.entries(BUILTIN_SERVERS as Record<string, any>)) {
      const running = this.servers[name];
      results.push({
        name,
        label: def.label,
        labelEn: def.labelEn,
        description: def.description,
        descriptionEn: def.descriptionEn,
        enabled: this._builtinState[name] !== false,
        running: running?.status === "running",
        status: running?.status || "stopped",
        error: running?.error || null,
        docs: def.docs,
        tools: running?.tools?.map(t => ({ name: t.name, description: t.description })) || [],
      });
    }
    return results;
  }

  /** Enable or disable a built-in server. */
  async toggleBuiltin(name: string, enabled: boolean) {
    if (!(BUILTIN_SERVERS as Record<string, any>)[name]) {
      throw new Error(`Unknown builtin server "${name}"`);
    }
    this._builtinState[name] = enabled;
    // Persist state to config
    const config = this.loadConfig();
    config.builtins = { ...this._builtinState };
    this.saveConfig(config);

    if (enabled) {
      const def = (BUILTIN_SERVERS as Record<string, any>)[name];
      const cfg = { command: def.command, args: [...def.args], env: { ...def.env } };
      await this.startServer(name, cfg);
    } else {
      await this.stopServer(name);
    }
  }

  /**
   * A compact signature of the current running MCP server + tool set. Used
   * by format-adapters as part of the tool-defs cache key so that adding,
   * removing, restarting, or toggling an MCP server invalidates the cached
   * LLM tool list (previously the cache only keyed on kbEnabled /
   * webSearchEnabled / planMode, so the model kept seeing stale tools).
   * @returns {string}
   */
  serverSignature() {
    const parts = [];
    for (const [name, server] of Object.entries(this.servers)) {
      if (server.status !== "running") continue;
      const toolNames = (server.tools || []).map(t => t.name).sort();
      parts.push(`${name}[${toolNames.join(",")}]`);
    }
    return parts.sort().join("|");
  }
}

// Singleton — imported by main.mjs
const mcpManager = new McpManager();
export default mcpManager;

