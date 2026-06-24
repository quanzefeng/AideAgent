#!/usr/bin/env node
// ── Fake ACP server (test fixture) ─────────────────────────────
//
// Mimics opencode v1.17.9's `opencode acp` JSON-RPC protocol EXACTLY:
//   - Method names are camelCase (initialize, newSession, prompt, …)
//   - Notifications use "sessionUpdate" (not "session/update")
//   - Update payloads carry { sessionUpdate, messageId, content: {type,text} }
//   - initialize returns authMethods when user isn't logged in
//
// Usage: `node test/fixtures/fake-acp-server.mjs [scenario]`
// Scenarios:
//   normal     (default): 3 chunks + response + 1 trailing chunk
//   quick      : 1 chunk + response (no trailing)
//   noisy      : 5 chunks spread across time
//   error      : respond with jsonrpc error
//   auth       : initialize returns authMethods (forces auth-required flow)
//   tool_call  : trigger tool_call + tool_call_update events

import { EOL } from "node:os";

const SCENARIO = process.argv[2] || "normal";

let readBuf = "";
let sessionCounter = 0;

process.stdin.setEncoding("utf-8");
process.stdin.on("data", (chunk) => {
  readBuf += chunk;
  let nlIdx;
  while ((nlIdx = readBuf.indexOf("\n")) !== -1) {
    const line = readBuf.slice(0, nlIdx).trim();
    readBuf = readBuf.slice(nlIdx + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    handle(msg);
  }
});

function write(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

function notify(method, params) {
  write({ jsonrpc: "2.0", method, params });
}

function respond(id, result) {
  write({ jsonrpc: "2.0", id, result });
}

function rpcError(id, code, message) {
  write({ jsonrpc: "2.0", id, error: { code, message } });
}

async function handle(msg) {
  if (!msg || msg.jsonrpc !== "2.0") return;
  const { id, method, params } = msg;

  // ── initialize ──
  if (method === "initialize") {
    if (SCENARIO === "auth") {
      respond(id, {
        protocolVersion: params?.protocolVersion ?? 1,
        agentCapabilities: {
          loadSession: true,
          mcpCapabilities: { http: true, sse: true },
          promptCapabilities: { embeddedContext: true, image: true },
        },
        authMethods: [{ id: "opencode-login", name: "Login with opencode", description: "Run `opencode auth login`" }],
        agentInfo: { name: "fake-opencode", version: "1.17.9" },
      });
    } else {
      respond(id, {
        protocolVersion: params?.protocolVersion ?? 1,
        agentCapabilities: {
          loadSession: true,
          mcpCapabilities: { http: true, sse: true },
          promptCapabilities: { embeddedContext: true, image: true },
        },
        agentInfo: { name: "fake-opencode", version: "1.17.9" },
      });
    }
    return;
  }

  // ── authenticate ──
  if (method === "authenticate") {
    respond(id, {});
    return;
  }

  // ── session/new ──
  if (method === "session/new") {
    const sessionId = `fake-${++sessionCounter}`;
    respond(id, {
      sessionId,
      configOptions: [
        { id: "model", name: "Model", type: "select", options: [{ value: "fake-model", label: "fake-model" }], currentValue: "fake-model" },
      ],
    });
    return;
  }

  // ── session/prompt ──
  if (method === "session/prompt") {
    const sessionId = params?.sessionId;
    const messageId = "msg-" + Date.now();
    if (SCENARIO === "error") {
      rpcError(id, -32000, "ProviderAuthError: no provider configured");
      return;
    }

    // Emit chunks in the EXACT shape opencode uses (matches event.ts).
    // JSON-RPC method is `session/update` (slash), but the discriminator
    // field inside the payload is `sessionUpdate` (camelCase).
    const emitChunk = (text) => {
      notify("session/update", {
        sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          messageId,
          content: { type: "text", text },
        },
      });
    };

    const chunks = SCENARIO === "noisy"
      ? ["alpha ", "beta ", "gamma ", "delta ", "epsilon"]
      : SCENARIO === "quick"
        ? ["hello"]
        : ["Thinking...\n\n", "Here is my ", "answer."];
    for (const c of chunks) {
      emitChunk(c);
      await sleep(SCENARIO === "noisy" ? 15 : 5);
    }

    if (SCENARIO === "noisy") {
      // Emit one more chunk AFTER the response (simulates anomalyco/opencode#17505).
      setTimeout(() => {
        notify("session/update", {
          sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            messageId,
            content: { type: "text", text: " (trailing)" },
          },
        });
      }, 10);
    }

    if (SCENARIO === "tool_call") {
      notify("session/update", {
        sessionId,
        update: {
          sessionUpdate: "tool_call",
          toolCallId: "tc1",
          toolName: "bash",
          arguments: { command: "echo hi" },
        },
      });
      setTimeout(() => {
        notify("session/update", {
          sessionId,
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId: "tc1",
            toolName: "bash",
            result: { stdout: "hi\n", stderr: "", exitCode: 0 },
          },
        });
      }, 10);
    }

    respond(id, { stopReason: "end_turn" });
    return;
  }

  // ── session/cancel ──
  if (method === "session/cancel") {
    return;
  }

  rpcError(id, -32601, `Method not found: ${method}`);
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// Emit stderr noise occasionally to verify it doesn't break protocol parsing.
setInterval(() => {
  if (!process.stderr.destroyed) process.stderr.write(`[fake-acp-server] tick ${Date.now()}${EOL}`);
}, 1000).unref();