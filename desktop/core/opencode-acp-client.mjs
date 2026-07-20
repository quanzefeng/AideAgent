// ── OpenCode ACP (Agent Client Protocol) client ─────────────────────
//
// Drives a local `opencode acp` subprocess via JSON-RPC 2.0 over stdio.
//
// Protocol spec: Agent Client Protocol v1 — https://agentclientprotocol.com/protocol
// Verified against opencode v1.17.9 source: anomalyco/opencode/packages/opencode/src/acp.
//
// Method names are SLASH-SEPARATED on the wire (the @agentclientprotocol/sdk
// TypeScript API uses camelCase like `newSession`, but the JSON-RPC method
// name is `session/new`). Confirmed by the spec text:
//   "all Agents MUST support session/new, session/prompt, session/cancel,
//    and session/update."
//
// Notification method is `session/update` (also slash-separated).
// The notification payload carries { sessionId, update: { sessionUpdate: "...", ... } }
// where `sessionUpdate` is the discriminator field (a string) — distinct from
// the JSON-RPC method name.

import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const POST_RESPONSE_QUIET_MS = 500;
const IS_WIN = process.platform === "win32";

// Per-request timeout. If the opencode subprocess doesn't reply within this
// window, the pending Promise rejects with a TimeoutError so the caller can
// surface "opencode 无响应" instead of hanging forever. 120s is generous
// enough for `initialize` (spawns the CLI) and `session/prompt` (first token
// may take a while on cold models), but short enough that a dead subprocess
// is caught before the user gives up and force-quits the app.
const REQUEST_TIMEOUT_MS = 120_000;

// Set DEBUG_OPENCODE_ACP=1 to enable verbose protocol logging.
const DEBUG = process.env.DEBUG_OPENCODE_ACP === "1" || process.env.DEBUG_OPENCODE_ACP === "true";
function dbg(...args) { if (DEBUG) console.log("[acp]", ...args); }

export class OpencodeAcpClient extends EventEmitter {
  /**
   * @param {object} opts
   * @param {string} opts.binPath Absolute path to the `opencode` binary.
   * @param {string} [opts.cwd] Working directory for the agent session.
   * @param {object} [opts.clientInfo] Identifies us in the initialize handshake.
   * @param {Array<object>} [opts.mcpServers] MCP server configs forwarded to opencode.
   * @param {string|null} [opts.modelId] Optional model id (e.g. "anthropic/claude-sonnet-4").
   *   Forwarded to ACP `session/new` so opencode binds that model. When null,
   *   opencode picks its own default.
   */
  constructor({ binPath, cwd, clientInfo, mcpServers = [], modelId } = {}) {
    super();
    if (!binPath) throw new Error("OpencodeAcpClient: binPath required");
    this.binPath = binPath;
    this.cwd = cwd || process.cwd();
    this.clientInfo = clientInfo || { name: "AideAgent", version: "1.0.0" };
    this.mcpServers = mcpServers;
    /**
     * Optional model id forwarded to ACP `session/new`. When null, opencode
     * picks its own default (usually models[0]). When set, opencode is told
     * to bind the session to that provider/model pair.
     * @type {string|null}
     */
    this.modelId = modelId;

    /** @type {import('node:child_process').ChildProcess|null} */
    this.proc = null;
    /** @type {number} */
    this._nextId = 1;
    /** @type {Map<number, { resolve: Function, reject: Function, method: string }>} */
    this._pending = new Map();
    /** @type {string|null} */
    this._sessionId = null;
    /** @type {string} */
    this._readBuf = "";
    /** @type {Promise<void>|null} */
    this._readyPromise = null;
    /** @type {boolean} */
    this._closed = false;
    /** @type {Array<object>} authMethods returned by initialize (may be empty) */
    this._authMethods = [];
    /**
     * Agent's prompt capabilities advertised via `initialize` (ACP spec).
     * Determines which content block types we can send in `session/prompt`:
     *   - image:           {type:"image", data, mimeType}
     *   - embeddedContext: {type:"resource", resource:{...}}
     * Baseline (text + resource_link) is always assumed supported per spec.
     * @type {{ image?: boolean, audio?: boolean, embeddedContext?: boolean }}
     */
    this._promptCapabilities = { image: false, audio: false, embeddedContext: false };
  }

/**
     * Initialize the ACP session: spawn the opencode subprocess (acp subcommand
     * needed) + `newSession`, and resolve once a session is ready.
     * @returns {Promise<{ sessionId: string, models?: Array<object>, modes?: Array<object> }>}
     */
  async start() {
    // Synchronously stamp _readyPromise BEFORE the first await in _start().
    // The previous version assigned it AFTER the `if` check, leaving a
    // tiny window where two concurrent start() calls could both pass the
    // check and both enter _start(), spawning two `opencode acp` subprocesses.
    // The first subprocess's sessionId would be lost when the second call
    // overwrote _readyPromise, leaving the first as an orphan.
    if (this._readyPromise) return this._readyPromise;
    const p = this._start();
    this._readyPromise = p;
    // Swallow rejection here so the cached promise doesn't trigger
    // unhandled-rejection warnings; start()'s awaiter still sees it.
    p.catch(() => {});
    return p;
  }

  async _start() {
    this.proc = spawn(this.binPath, ["acp"], {
      cwd: this.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      shell: IS_WIN,
    });

    this.proc.on("error", (err) => {
      this._failAllPending(err);
      this.emit("error", err);
    });
    this.proc.on("exit", (code, signal) => {
      this._closed = true;
      this._failAllPending(new Error(`opencode exited (code=${code}, signal=${signal})`));
      this.emit("exit", { code, signal });
    });
    this.proc.stderr?.on("data", (chunk) => {
      this.emit("stderr", chunk.toString("utf-8"));
    });
    this.proc.stdout?.on("data", (chunk) => this._onStdoutChunk(chunk));

    // 1. Initialize — protocolVersion 1.
    const initResult = await this._request("initialize", {
      protocolVersion: 1,
      clientInfo: this.clientInfo,
    });
    this._authMethods = initResult.authMethods || [];
    // Capture agent prompt capabilities (ACP v1 spec). These tell us which
    // content block types we can include in `session/prompt` requests.
    const caps = initResult.agentCapabilities?.promptCapabilities;
    if (caps) {
      this._promptCapabilities = {
        image: Boolean(caps.image),
        audio: Boolean(caps.audio),
        embeddedContext: Boolean(caps.embeddedContext),
      };
    }
    dbg("initialize result:", JSON.stringify(initResult));
    dbg("prompt capabilities:", JSON.stringify(this._promptCapabilities));

    // 2. Authenticate if opencode requires it. We can't actually perform
    // interactive login from here; the user must run `opencode auth login`
    // in a terminal. We surface this as a stream:error so the UI can show
    // a clear hint instead of silently getting `end_turn` with no text.
    if (this._authMethods.length > 0) {
      dbg("auth required:", this._authMethods);
      try {
        await this._request("authenticate", { methodId: this._authMethods[0].id });
      } catch (err) {
        dbg("authenticate failed:", err.message);
        this.emit("auth-required", { authMethods: this._authMethods, error: err.message });
      }
    }

    // 3. Create a session. JSON-RPC method is `session/new` (slash-separated).
    // The `modelId` parameter exists in the ACP spec but opencode v1.17
    // silently ignores it — the spawned session always picks its own
    // default model. We deliberately do NOT pass modelId here; the actual
    // switch happens via `session/set_config_option` after the session is
    // created (see step 4 below).
    const newSessionParams = {
      cwd: this.cwd,
      mcpServers: this.mcpServers,
    };
    const sessionResult = await this._request("session/new", newSessionParams);
    this._sessionId = sessionResult.sessionId;
    if (!this._sessionId) throw new Error("session/new returned no sessionId");

    // 4. Apply the user-selected model via config update. ACP `session/set_config_option`
    //    is the only path opencode actually honors — passing `modelId` to
    //    `session/new` is silently dropped. Verified empirically with v1.17.11.
    //    No-op when no modelId was set (opencode picks its own default).
    if (this.modelId) {
      try {
        await this._request("session/set_config_option", {
          sessionId: this._sessionId,
          configId: "model",
          value: this.modelId,
        });
      } catch (/** @type {any} */ e) {
        // Non-fatal: fall back to opencode's default model and surface the
        // failure in the ready event so the renderer can warn the user.
        console.warn(`[OpencodeAcpClient] failed to set model ${this.modelId}: ${e.message}`);
      }
    }

    const result = {
      sessionId: this._sessionId,
      models: sessionResult.models,
      modes: sessionResult.modes,
      configOptions: sessionResult.configOptions,
    };
    this.emit("ready", result);
    return result;
  }

  /**
   * Send a prompt turn. Resolves once the agent finishes the turn (the
   * `prompt` response arrives AND any trailing notifications have been
   * dispatched).
   * @param {string|Array<object>} text
   * @returns {Promise<{ stopReason: string }>}
   */
  async sendPrompt(text) {
    if (!this._sessionId) throw new Error("not started: call start() first");
    if (this._closed) throw new Error("client closed");

    // Convert plain string to ACP content-block array.
    const promptBlocks = typeof text === "string"
      ? [{ type: "text", text: String(text ?? "") }]
      : text;

    let responseReceived = false;
    let quietTimer = null;
    let resolveDone, rejectDone;
    const donePromise = new Promise((res, rej) => { resolveDone = res; rejectDone = rej; });
    donePromise.catch(() => {}); // suppress unhandled-rejection warnings

    const armQuietTimer = () => {
      if (quietTimer) clearTimeout(quietTimer);
      quietTimer = setTimeout(() => {
        quietTimer = null;
        resolveDone({ stopReason: "end_turn" });
      }, POST_RESPONSE_QUIET_MS);
    };

    const onUpdate = (params) => {
      this._dispatchUpdate(params);
      if (responseReceived) armQuietTimer();
    };
    this.on("session-update", onUpdate);
    try {
      const result = await this._request("session/prompt", {
        sessionId: this._sessionId,
        prompt: promptBlocks,
      });
      responseReceived = true;
      armQuietTimer();
      const ret = await donePromise;
      return { stopReason: ret.stopReason || (result && result.stopReason) || "end_turn" };
    } catch (err) {
      rejectDone(err);
      throw err;
    } finally {
      this.off("session-update", onUpdate);
      if (quietTimer) clearTimeout(quietTimer);
    }
  }

  /**
   * Build ACP content blocks from a list of file attachments. Honors the
   * agent's `promptCapabilities` advertised via `initialize`:
   *   - image           → {type:"image", mimeType, data (base64)}
   *   - embeddedContext → {type:"resource", resource:{uri, mimeType, text|blob}}
   *   - fallback (no caps, or binary without embeddedContext) → {type:"resource_link"}
   *     with a `file://` URI pointing to a temp file we drop on disk. The agent
   *     can then read it with its own file tools.
   *
   * `file.dataUrl` is a `data:<mime>;base64,<payload>` string. The payload is
   * extracted here. Caller is responsible for cleanup of any temp dir returned
   * via `tempDir` in the result.
   *
   * @param {Array<{name:string, type:string, dataUrl:string, size?:number}>} files
   * @returns {{ blocks: Array<object>, tempDir: string|null, dropped: Array<{name:string, reason:string}> }}
   */
  buildFileBlocks(files) {
    if (!Array.isArray(files) || files.length === 0) {
      return { blocks: [], tempDir: null, dropped: [] };
    }

    const caps = this._promptCapabilities || {};
    const blocks = [];
    const dropped = [];
    let tempDir = null;

    // Lazily create a temp dir for resource_link fallback.
    const ensureTempDir = () => {
      if (!tempDir) {
        tempDir = mkdtempSync(join(tmpdir(), "aideagent-opencode-"));
      }
      return tempDir;
    };

    for (const file of files) {
      const name = file.name || "attachment";
      const mime = file.type || "application/octet-stream";
      const dataUrl = file.dataUrl || "";
      const commaIdx = dataUrl.indexOf(",");
      const base64Payload = commaIdx >= 0 ? dataUrl.slice(commaIdx + 1) : dataUrl;

      if (!base64Payload) {
        dropped.push({ name, reason: "empty dataUrl" });
        continue;
      }

      // 1. Image → {type:"image"} when agent supports it. Images are
      //    best transmitted inline so the model can "see" them directly
      //    without needing to call any file tools.
      if (mime.startsWith("image/") && caps.image) {
        blocks.push({
          type: "image",
          mimeType: mime,
          data: base64Payload,
        });
        continue;
      }

      // 2. All other files (text, PDF, binary, unknown) → write to a
      //    real temp file and emit a `resource_link` with a `file://` URI.
      //
      //    Why prefer `resource_link` over `{type:"resource"}` (embedded
      //    text)? Empirical testing with opencode v1.17.9 shows:
      //      - `resource` (text inline) works syntactically, but the
      //        model often only emits `agent_thought_chunk` and never
      //        `agent_message_chunk`, leaving the user with a "已停止"
      //        placeholder.
      //      - `resource_link` to a real file path works reliably: the
      //        model can call `file_read` on the URI and produces a
      //        normal text response.
      //    ACP spec guarantees `resource_link` is the baseline that ALL
      //    agents MUST support, so this is the safest option.
      try {
        const dir = ensureTempDir();
        const safeName = name.replace(/[\\/:*?"<>|]/g, "_");
        const filePath = join(dir, safeName);
        writeFileSync(filePath, Buffer.from(base64Payload, "base64"));
        blocks.push({
          type: "resource_link",
          uri: filePath.startsWith("/") ? `file://${filePath}` : `file:///${filePath.replace(/\\/g, "/")}`,
          name: safeName,
          mimeType: mime,
          size: file.size,
        });
      } catch (err) {
        dropped.push({ name, reason: `temp write failed: ${err.message}` });
      }
    }

    return { blocks, tempDir, dropped };
  }

  /**
   * Clean up any temp directory created by `buildFileBlocks` (resource_link
   * fallback). Safe to call even if no temp dir was created.
   * @param {string|null} tempDir
   */
  cleanupFileBlocks(tempDir) {
    if (!tempDir) return;
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch (err) {
      dbg("cleanupFileBlocks failed:", err.message);
    }
  }

  /**
   * Get the agent's prompt capabilities (populated by `initialize`).
   * @returns {{ image: boolean, audio: boolean, embeddedContext: boolean }}
   */
  getPromptCapabilities() {
    return { ...this._promptCapabilities };
  }

  /**
   * Cancel an in-flight prompt turn.
   */
  cancel() {
    if (!this._sessionId || this._closed) return;
    this._notify("session/cancel", { sessionId: this._sessionId });
  }

  /**
   * Tear down: kill the process (opencode closes its ACP session on EOF).
   */
  async stop() {
    if (this._closed) return;
    this._closed = true;
    if (this.proc && !this.proc.killed) {
      try { this.proc.kill(); } catch { /* ignore */ }
    }
    this._failAllPending(new Error("client stopped"));
  }

  // ── Internal: transport ────────────────────────────────────────────

  /** @param {Buffer|string} chunk */
  _onStdoutChunk(chunk) {
    this._readBuf += chunk.toString("utf-8");
    let nlIdx;
    while ((nlIdx = this._readBuf.indexOf("\n")) !== -1) {
      const line = this._readBuf.slice(0, nlIdx).trim();
      this._readBuf = this._readBuf.slice(nlIdx + 1);
      if (!line) continue;
      dbg("RECV", line);
      let msg;
      try { msg = JSON.parse(line); }
      catch (err) { this.emit("parse-error", { line, error: err }); continue; }
      this._onMessage(msg);
    }
  }

  /** @param {object} msg JSON-RPC 2.0 message */
  _onMessage(msg) {
    // 1. Response to one of OUR requests (has id + result/error, no method).
    if (typeof msg.id === "number" && (msg.result !== undefined || msg.error !== undefined)) {
      const pending = this._pending.get(msg.id);
      if (!pending) return;
      this._pending.delete(msg.id);
      if (msg.error) {
        const err = new Error(msg.error.message || JSON.stringify(msg.error));
        err.code = msg.error.code;
        pending.reject(err);
      } else {
        pending.resolve(msg.result);
      }
      return;
    }
    // 2. Server→client REQUEST (has both `id` AND `method`). ACP spec:
    //    `session/request_permission` is the canonical case — the agent asks
    //    us to approve a tool call and waits for a JSON-RPC response. If we
    //    don't reply, the agent hangs forever. Auto-approve here so the
    //    turn keeps moving; emit `permission-request` so the UI can show it.
    if (typeof msg.id === "number" && msg.method) {
      if (msg.method === "session/request_permission" && msg.params) {
        // Pick the first "allow_once" option if present, else the first
        // option, else a synthetic "allow-once" — never reject, since the
        // current UX treats OpenCode as an auto-approve runtime. The UI
        // gets a `permission-request` event for visibility only.
        const options = Array.isArray(msg.params.options) ? msg.params.options : [];
        const allowOnce = options.find((o) => o.kind === "allow_once") || options[0];
        const optionId = (allowOnce && allowOnce.optionId) || "allow-once";
        try {
          this._sendResponse(msg.id, { outcome: { outcome: "selected", optionId } });
        } catch { /* ignore — stdin may be closed */ }
        this.emit("permission-request", {
          id: msg.id,
          toolCallId: msg.params.toolCall?.toolCallId,
          kind: msg.params.toolCall?.kind,
          title: msg.params.toolCall?.title,
          options,
          approved: optionId,
        });
      } else {
        // Unknown server-initiated request — respond with a benign empty
        // result so the agent doesn't hang. Emit for observability.
        try { this._sendResponse(msg.id, {}); } catch { /* ignore */ }
        this.emit("unknown-request", msg);
      }
      return;
    }
    // 3. Notification (has `method`, no `id`). ACP spec: `session/update`
    //    is the agent→client notification for streaming chunks/tool calls.
    if (msg.method === "session/update" && msg.params) {
      this.emit("session-update", msg.params);
      return;
    }
    // Other notifications (e.g. progress). Emit for callers that care.
    if (msg.method) {
      this.emit("notification", msg);
      return;
    }
    this.emit("unknown-message", msg);
  }

  /** Send a JSON-RPC method call. Rejects with a TimeoutError if the agent
   *  doesn't reply within `REQUEST_TIMEOUT_MS` — prevents the caller from
   *  hanging forever when the subprocess stalls. */
  _request(method, params) {
    return new Promise((resolve, reject) => {
      if (!this.proc || !this.proc.stdin || this.proc.stdin.destroyed) {
        return reject(new Error("opencode stdin not writable"));
      }
      const id = this._nextId++;
      const timer = setTimeout(() => {
        if (this._pending.has(id)) {
          this._pending.delete(id);
          const err = new Error(`opencode ${method} timed out after ${REQUEST_TIMEOUT_MS}ms`);
          err.name = "TimeoutError";
          err.code = "ACP_TIMEOUT";
          reject(err);
        }
      }, REQUEST_TIMEOUT_MS);
      this._pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
        method,
      });
      const payload = JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n";
      dbg("SEND", payload.trim());
      this.proc.stdin.write(payload, (err) => {
        if (err) {
          if (this._pending.has(id)) {
            clearTimeout(timer);
            this._pending.delete(id);
          }
          reject(err);
        }
      });
    });
  }

  /** Send a JSON-RPC notification (fire-and-forget). */
  _notify(method, params) {
    if (!this.proc || !this.proc.stdin || this.proc.stdin.destroyed) return;
    const payload = JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n";
    dbg("NOTIFY", payload.trim());
    try { this.proc.stdin.write(payload); } catch { /* ignore */ }
  }

  /**
   * Send a JSON-RPC response to a server→client request (e.g. the agent's
   * `session/request_permission`). Without this reply the agent hangs.
   * @param {number} id - the request id from the incoming message
   * @param {object} result - the result payload
   */
  _sendResponse(id, result) {
    if (!this.proc || !this.proc.stdin || this.proc.stdin.destroyed) return;
    const payload = JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n";
    dbg("RESP", payload.trim());
    try { this.proc.stdin.write(payload); } catch { /* ignore */ }
  }

  _failAllPending(err) {
    for (const [, pending] of this._pending) pending.reject(err);
    this._pending.clear();
  }

  /**
   * Translate a `sessionUpdate` notification into our renderer's events.
   *
   * opencode's actual update shapes (from event.ts):
   *   { sessionUpdate: "agent_message_chunk", messageId, content: {type:"text", text:"..."} }
   *   { sessionUpdate: "agent_thought_chunk", messageId, content: {type:"text", text:"..."} }
   *   { sessionUpdate: "user_message_chunk",   messageId, content: {type:"text", text:"..."} }
   *   { sessionUpdate: "tool_call",            toolCallId, toolName, ... }
   *   { sessionUpdate: "tool_call_update",     toolCallId, ... }
   *   { sessionUpdate: "available_commands_update", availableCommands: [...] }
   *   { sessionUpdate: "usage_update",         used, size, cost }
   */
  _dispatchUpdate(params) {
    const u = params?.update;
    if (!u) return;
    const discriminator = u.sessionUpdate || u.type;
    dbg("UPDATE", discriminator, JSON.stringify(u).slice(0, 240));

    // Extract text from the content block: { type:"text", text:"..." }
    const extractText = (content) => {
      if (!content) return "";
      if (typeof content === "string") return content;
      if (content.text) return content.text;
      if (content.delta) return content.delta;
      if (content.content) return extractText(content.content);
      return "";
    };

    if (discriminator === "agent_message_chunk") {
      const text = extractText(u.content);
      if (text) this.emit("text-chunk", text);
    } else if (discriminator === "agent_thought_chunk") {
      const text = extractText(u.content);
      if (text) this.emit("reasoning-chunk", text);
    } else if (discriminator === "user_message_chunk") {
      // User echo — ignore (we already rendered the user's input).
    } else if (discriminator === "tool_call") {
      const toolName = u.toolName || u.tool || "tool";
      const args = u.arguments || u.args || u.input || {};
      this.emit("tool-start", { name: toolName, args, toolCallId: u.toolCallId });
    } else if (discriminator === "tool_call_update") {
      const toolName = u.toolName || u.tool || "tool";
      const result = u.result ?? u.output ?? u;
      this.emit("tool-result", { name: toolName, result, toolCallId: u.toolCallId });
    } else if (discriminator === "available_commands_update") {
      this.emit("commands-update", u.availableCommands || []);
    } else if (discriminator === "usage_update") {
      this.emit("usage", u);
    } else {
      this.emit("unknown-update", u);
    }
  }
}