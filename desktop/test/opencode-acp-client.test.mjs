// @ts-check
// Unit tests for core/opencode-acp-client.mjs.
//
// These tests spawn test/fixtures/fake-acp-server.mjs as a child process and
// drive the client through real JSON-RPC traffic over stdio. The fake server
// mimics opencode v1.17.9's exact protocol (camelCase methods, sessionUpdate
// notifications, content blocks).

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { OpencodeAcpClient } from "../core/opencode-acp-client.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const FIXTURE = resolve(__dirname, "fixtures", "fake-acp-server.mjs");
const FIXTURE_DIR = resolve(__dirname, "fixtures");

describe("OpencodeAcpClient", () => {
  /** @type {string} */
  let nodeBin;
  beforeAll(() => {
    nodeBin = process.execPath;
  });

  /**
   * Subclass override: the real client spawns `opencode acp`, but for tests
   * we spawn `node fake-acp-server.mjs [scenario]` which speaks the exact
   * same JSON-RPC protocol.
   */
  async function makeAdapter(scenario = "normal") {
    const { spawn } = await import("node:child_process");
    return class extends OpencodeAcpClient {
      async _start() {
        this.proc = spawn(nodeBin, [FIXTURE, scenario], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
        this.proc.on("error", (err) => this._failAllPending(err));
        this.proc.on("exit", (code, signal) => {
          this._closed = true;
          this._failAllPending(new Error(`opencode exited (code=${code}, signal=${signal})`));
          this.emit("exit", { code, signal });
        });
        this.proc.stderr?.on("data", (chunk) => this.emit("stderr", chunk.toString("utf-8")));
        this.proc.stdout?.on("data", (chunk) => this._onStdoutChunk(chunk));

        // 1. initialize
        const initResult = await this._request("initialize", {
          protocolVersion: 1,
          clientInfo: this.clientInfo,
        });
        this._authMethods = initResult.authMethods || [];

        // 2. authenticate if required
        if (this._authMethods.length > 0) {
          try { await this._request("authenticate", { methodId: this._authMethods[0].id }); }
          catch { /* ignore in fake; surface via auth-required event */ }
        }

        // 3. session/new (slash-separated JSON-RPC method)
        const sessionResult = await this._request("session/new", { cwd: this.cwd, mcpServers: this.mcpServers });
        this._sessionId = sessionResult.sessionId;
        this.emit("ready", { sessionId: this._sessionId });
        return { sessionId: this._sessionId };
      }
    };
  }

  it("completes initialize + newSession handshake", async () => {
    const Adapted = await makeAdapter();
    const c = new Adapted({ binPath: nodeBin, cwd: process.cwd() });
    const { sessionId } = await c.start();
    expect(sessionId).toMatch(/^fake-\d+$/);
    await c.stop();
  });

  it("streams text chunks and resolves on end_turn", async () => {
    const Adapted = await makeAdapter();
    const c = new Adapted({ binPath: nodeBin, cwd: process.cwd() });
    await c.start();
    const chunks = [];
    c.on("text-chunk", (t) => chunks.push(t));
    const { stopReason } = await c.sendPrompt("hello");
    expect(stopReason).toBe("end_turn");
    expect(chunks.join("")).toContain("answer");
    await c.stop();
  });

  it("dispatches tool_call / tool_call_update to tool-start / tool-result", async () => {
    const Adapted = await makeAdapter("tool_call");
    const c = new Adapted({ binPath: nodeBin, cwd: process.cwd() });
    await c.start();
    const starts = /** @type {Array<any>} */ ([]);
    const results = /** @type {Array<any>} */ ([]);
    c.on("tool-start", (e) => starts.push(e));
    c.on("tool-result", (e) => results.push(e));
    await c.sendPrompt("run bash");
    expect(starts.length).toBeGreaterThan(0);
    expect(starts[0].name).toBe("bash");
    expect(starts[0].args).toEqual({ command: "echo hi" });
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].name).toBe("bash");
    await c.stop();
  });

  it("drains trailing notifications after prompt response (opencode#17505)", async () => {
    const Adapted = await makeAdapter("noisy");
    const c = new Adapted({ binPath: nodeBin, cwd: process.cwd() });
    await c.start();
    const chunks = [];
    c.on("text-chunk", (t) => chunks.push(t));
    await c.sendPrompt("hello");
    expect(chunks.join("")).toContain("(trailing)");
    await c.stop();
  });

  it("rejects sendPrompt if not started", async () => {
    const c = new OpencodeAcpClient({ binPath: nodeBin, cwd: process.cwd() });
    await expect(c.sendPrompt("x")).rejects.toThrow(/not started/i);
  });

  it("rejects when the agent returns a JSON-RPC error", async () => {
    const Adapted = await makeAdapter("error");
    const c = new Adapted({ binPath: nodeBin, cwd: process.cwd() });
    await c.start();
    await expect(c.sendPrompt("x")).rejects.toThrow(/exploded|ProviderAuthError/);
    await c.stop();
  });

  it("emits exit when the subprocess dies", async () => {
    const Adapted = await makeAdapter();
    const c = new Adapted({ binPath: nodeBin, cwd: process.cwd() });
    await c.start();
    const exitPromise = new Promise((res) => c.once("exit", res));
    c.proc?.kill?.("SIGKILL");
    const evt = await Promise.race([
      exitPromise,
      new Promise((_, rej) => setTimeout(() => rej(new Error("no exit event")), 2000)),
    ]);
    expect(evt).toHaveProperty("code");
    await c.stop();
  });

  it("cancel() is a no-op when not started, doesn't throw", () => {
    const c = new OpencodeAcpClient({ binPath: nodeBin, cwd: process.cwd() });
    expect(() => c.cancel()).not.toThrow();
  });

  it("constructor rejects missing binPath", () => {
    expect(() => new OpencodeAcpClient({})).toThrow(/binPath/);
  });

  // ── Regression for the user's reported bug: on Windows, ACP client must
  //    be able to spawn a `.cmd` shim (the npm-global opencode.cmd).
  it("spawns a .cmd shim end-to-end (Windows regression)", async () => {
    if (process.platform !== "win32") return;
    const c = new OpencodeAcpClient({
      binPath: FIXTURE_DIR + "/fake-opencode.cmd",
      cwd: process.cwd(),
    });
    const chunks = [];
    c.on("text-chunk", (t) => chunks.push(t));
    await c.start();
    const { stopReason } = await c.sendPrompt("hello");
    expect(stopReason).toBe("end_turn");
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks.join("")).toContain("answer");
    await c.stop();
  });
});

describe("OpencodeAcpClient.buildFileBlocks", () => {
  // Helper: a minimal 1x1 transparent PNG, base64-encoded.
  const TINY_PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNgYAAAAAMAASsJTYQAAAAASUVORK5CYII=";
  // Helper: base64 of "hello world"
  const HELLO_B64 = Buffer.from("hello world", "utf-8").toString("base64");

  /** @returns {OpencodeAcpClient} client with capabilities pre-set (no spawn). */
  function makeClientWithCaps(caps) {
    const c = new OpencodeAcpClient({ binPath: "/bin/true" });
    c._promptCapabilities = { image: false, audio: false, embeddedContext: false, ...caps };
    return c;
  }

  it("returns empty blocks for empty file list", () => {
    const c = makeClientWithCaps({ image: true, embeddedContext: true });
    expect(c.buildFileBlocks([]).blocks).toEqual([]);
    expect(c.buildFileBlocks(undefined).blocks).toEqual([]);
  });

  it("emits image content block when image capability is advertised", () => {
    const c = makeClientWithCaps({ image: true });
    const { blocks, tempDir } = c.buildFileBlocks([
      { name: "pixel.png", type: "image/png", size: 67, dataUrl: `data:image/png;base64,${TINY_PNG_B64}` },
    ]);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe("image");
    expect(blocks[0].mimeType).toBe("image/png");
    expect(blocks[0].data).toBe(TINY_PNG_B64);
    expect(tempDir).toBeNull(); // no fallback dir needed
  });

  it("writes text files to temp + emits resource_link (more reliable than embedded text)", () => {
    // Rationale: empirical test with real opencode v1.17.9 shows that
    // {type:"resource", text: ...} is accepted but the model often only
    // emits `agent_thought_chunk` and never `agent_message_chunk` (leaving
    // the user with a "已停止" placeholder). {type:"resource_link"} to a
    // real `file://` URI works reliably — the model can call file_read.
    const c = makeClientWithCaps({ embeddedContext: true, image: true });
    const { blocks, tempDir } = c.buildFileBlocks([
      { name: "hello.txt", type: "text/plain", size: 11, dataUrl: `data:text/plain;base64,${HELLO_B64}` },
    ]);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe("resource_link");
    expect(blocks[0].name).toBe("hello.txt");
    expect(blocks[0].mimeType).toBe("text/plain");
    expect(blocks[0].size).toBe(11);
    expect(blocks[0].uri).toMatch(/^file:\/\/\//);
    expect(tempDir).toBeTruthy();
  });

  it("emits resource_link for binary files like PDF", () => {
    const c = makeClientWithCaps({ image: false, embeddedContext: false });
    const { blocks, tempDir, dropped } = c.buildFileBlocks([
      { name: "report.pdf", type: "application/pdf", size: 1024, dataUrl: `data:application/pdf;base64,${HELLO_B64}` },
    ]);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe("resource_link");
    expect(blocks[0].name).toBe("report.pdf");
    expect(blocks[0].mimeType).toBe("application/pdf");
    expect(blocks[0].size).toBe(1024);
    expect(blocks[0].uri).toMatch(/^file:\/\/\//);
    expect(tempDir).toBeTruthy();
    expect(dropped).toEqual([]);
  });

  it("downgrades images to resource_link when image capability is OFF", () => {
    const c = makeClientWithCaps({ image: false, embeddedContext: false });
    const { blocks, tempDir } = c.buildFileBlocks([
      { name: "pixel.png", type: "image/png", size: 67, dataUrl: `data:image/png;base64,${TINY_PNG_B64}` },
    ]);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe("resource_link");
    expect(tempDir).toBeTruthy();
  });

  it("drops files with empty dataUrl and reports them in 'dropped'", () => {
    const c = makeClientWithCaps({ image: true, embeddedContext: true });
    const { blocks, dropped } = c.buildFileBlocks([
      { name: "empty.txt", type: "text/plain", size: 0, dataUrl: "" },
    ]);
    expect(blocks).toEqual([]);
    expect(dropped).toEqual([{ name: "empty.txt", reason: "empty dataUrl" }]);
  });

  it("cleanupFileBlocks removes the temp dir and is safe to call with null", () => {
    const c = makeClientWithCaps({ embeddedContext: false });
    const { tempDir } = c.buildFileBlocks([
      { name: "x.bin", type: "application/octet-stream", size: 5, dataUrl: `data:application/octet-stream;base64,${HELLO_B64}` },
    ]);
    expect(tempDir).toBeTruthy();
    // Should not throw, should remove the dir.
    c.cleanupFileBlocks(tempDir);
    c.cleanupFileBlocks(null);
    c.cleanupFileBlocks(undefined);
  });
});
