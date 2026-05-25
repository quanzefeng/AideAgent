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
class McpManager {
  constructor() {
    /** @type {Object<string, {process: import("child_process").ChildProcess|null, config: object, tools: Array, status: string, error: string|null, buffer: string}>} */
    this.servers = {};
    /** @type {Map<number, {resolve: Function, reject: Function, timer: NodeJS.Timeout, serverName: string}>} */
    this._pending = new Map();
    this._nextId = 0;
  }

  // ── Config persistence ──────────────────────────────────────

  getStorePath() {
    return join(app.getPath("userData"), "mcp-servers.json");
  }

  loadConfig() {
    try {
      if (existsSync(this.getStorePath())) {
        return JSON.parse(readFileSync(this.getStorePath(), "utf-8"));
      }
    } catch (e) {
      console.error("[mcp] Failed to load config:", e.message);
    }
    return { servers: {} };
  }

  saveConfig(config) {
    try {
      const dir = dirname(this.getStorePath());
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      writeFileSync(this.getStorePath(), JSON.stringify(config, null, 2), "utf-8");
    } catch (e) {
      console.error("[mcp] Failed to save config:", e.message);
    }
  }

  // ── Lifecycle ───────────────────────────────────────────────

  /** Start all enabled servers. Called once on app startup. */
  async init() {
    const config = this.loadConfig();
    const promises = [];
    for (const [name, cfg] of Object.entries(config.servers || {})) {
      if (cfg.enabled !== false) {
        const isRemote = cfg.type === "remote" || cfg.type === "streamableHttp" || cfg.url || cfg.baseUrl;
        const starter = isRemote ? this.startRemoteServer(name, cfg) : this.startServer(name, cfg);
        promises.push(
          starter.catch(e => {
            console.error(`[mcp] Failed to start "${name}":`, e.message);
          })
        );
      }
    }
    await Promise.allSettled(promises);
  }

  /** Start (or restart) a single MCP server. */
  async startServer(name, cfg) {
    if (this.servers[name]) await this.stopServer(name);

    const env = { ...process.env };
    if (cfg.env) Object.assign(env, cfg.env);

    const proc = spawn(cfg.command, cfg.args || [], {
      stdio: ["pipe", "pipe", "pipe"],
      env,
      shell: true,
    });

    const server = {
      process: proc,
      config: cfg,
      tools: [],
      status: "starting",
      error: null,
      buffer: "",
    };
    this.servers[name] = server;

    proc.stdout.on("data", chunk => {
      server.buffer += chunk.toString();
      this._processBuffer(name);
    });

    proc.stderr.on("data", chunk => {
      const text = chunk.toString().trim();
      if (text) console.error(`[mcp:${name}]`, text);
    });

    proc.on("error", err => {
      server.status = "error";
      server.error = err.message;
      this._rejectPendingForServer(name, err.message);
    });

    proc.on("close", code => {
      server.status = "stopped";
      server.process = null;
      this._rejectPendingForServer(name, `Server closed (code ${code})`);
    });

    try {
      // Step 1: Initialize
      const initResult = await this._request(name, "initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "goodagent", version: "1.0" },
      }, 15000);

      // Step 2: Initialized notification
      this._notify(name, "notifications/initialized", {});

      // Step 3: List and cache tools
      const listResult = await this._request(name, "tools/list", {}, 15000);
      server.tools = listResult.tools || [];
      server.status = "running";

      console.log(`[mcp] "${name}" started (${server.tools.length} tools)`);
      return server.tools;
    } catch (e) {
      server.status = "error";
      server.error = e.message;
      // Kill process on failed init
      if (proc.exitCode === null) proc.kill();
      throw e;
    }
  }

  // ── Remote (HTTP) MCP server support ────────────────────────────

  /**
   * Connect to a remote MCP server via HTTP (streamableHttp transport).
   * No child process — communicates over HTTP POST + JSON-RPC.
   */
  async startRemoteServer(name, cfg) {
    const server = {
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
    const _post = async (body, signal) => {
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
    const timeout = setTimeout(() => ac.abort(), 15000);

    try {
      // Step 1: Initialize
      const initResult = await _post({
        jsonrpc: "2.0",
        id: ++this._nextId,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "goodagent", version: "1.0" },
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
    } catch (e) {
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
  async _remoteRequest(name, method, params, timeout = 30000) {
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

  async stopServer(name) {
    const server = this.servers[name];
    if (!server) return;
    if (server.process && server.process.exitCode === null) {
      try { server.process.stdin.end(); } catch {}
      server.process.kill();
    }
    // For remote servers there's no child process — just remove from map
    delete this.servers[name];
  }

  async restartServer(name) {
    const config = this.servers[name]?.config || this._findConfig(name);
    if (!config) throw new Error(`Server "${name}" not found`);
    await this.stopServer(name);
    const isRemote = config.type === "remote" || config.type === "streamableHttp" || config.url || config.baseUrl;
    return isRemote ? this.startRemoteServer(name, config) : this.startServer(name, config);
  }

  /** Save a new or updated server config and start if enabled. */
  async addServer(name, cfg) {
    const config = this.loadConfig();
    config.servers[name] = cfg;
    this.saveConfig(config);
    if (cfg.enabled !== false) {
      const isRemote = cfg.type === "remote" || cfg.type === "streamableHttp" || cfg.url || cfg.baseUrl;
      return isRemote ? this.startRemoteServer(name, cfg) : this.startServer(name, cfg);
    }
  }

  /** Remove a server from config and stop it. */
  async removeServer(name) {
    await this.stopServer(name);
    const config = this.loadConfig();
    delete config.servers[name];
    this.saveConfig(config);
  }

  /** Persist all currently running servers to disk config. */
  saveAllServers() {
    const config = this.loadConfig();
    for (const [name, s] of Object.entries(this.servers)) {
      if (s.config) {
        config.servers[name] = s.config;
      }
    }
    this.saveConfig(config);
  }

  _findConfig(name) {
    const config = this.loadConfig();
    return config.servers?.[name];
  }

  // ── JSON-RPC primitives ─────────────────────────────────────

  _notify(name, method, params) {
    const server = this.servers[name];
    if (!server?.process?.stdin?.writable) {
      throw new Error(`Server "${name}" not running`);
    }
    const msg = JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n";
    server.process.stdin.write(msg);
  }

  _request(name, method, params, timeout = 30000) {
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
      server.process.stdin.write(msg);
    });
  }

  _processBuffer(name) {
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
          clearTimeout(pending.timer);
          if (msg.error) {
            pending.reject(new Error(msg.error.message || "JSON-RPC error"));
          } else {
            pending.resolve(msg.result);
          }
        }
        // Notifications with no ID are ignored
      } catch (e) {
        console.error(`[mcp:${name}] Parse error:`, e.message, trimmed.slice(0, 200));
      }
    }
  }

  _rejectPendingForServer(name, reason) {
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
  listAllToolDefs() {
    const defs = [];
    for (const [, server] of Object.entries(this.servers)) {
      if (server.status !== "running") continue;
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
  async callTool(name, args) {
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
}

// Singleton — imported by main.mjs
const mcpManager = new McpManager();
export default mcpManager;

