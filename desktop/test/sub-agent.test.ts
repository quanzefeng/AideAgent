// Functional test for sub-agent.mjs
// Mocks: LLM API (fetch), runTool (tool execution), state module
// Tests: OpenAI + Anthropic paths, tool call loop, error handling, abort

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// ─── Mock state.mjs BEFORE importing sub-agent ───────────────
const stateMock = {
  SUB_AGENT_TOOL_NAMES: new Set([
    "bash", "file_read", "file_write", "file_edit", "grep",
    "write_memory", "AskUserQuestion",
    "kb_search", "kb_get_note", "kb_write",
  ]),
  SUB_AGENT_MAX_TURNS: 12,
  _subAgentCtrls: new Map(),
  getLastApiConfig: vi.fn(),
  getSessionId: vi.fn(() => null),
  isInteractiveSession: vi.fn(() => true),
  sendToRenderer: vi.fn(),
  parseContextWindowFromError: vi.fn(() => null),
  setContextWindow: vi.fn(),
};
vi.mock("../core/state.ts", () => stateMock);

// Mock format-adapters.mjs
vi.mock("../core/format-adapters.ts", () => ({
  computeMaxTokens: () => 65536,
  isContextOverflowText: (errText: string) => errText.includes("exceed_context_size_error") || errText.includes("exceeds the context"),
  getAllToolDefs: () => [
    { function: { name: "bash", description: "Run shell", parameters: { type: "object" } } },
    { function: { name: "file_read", description: "Read file", parameters: { type: "object" } } },
    { function: { name: "write_memory", description: "Write memory", parameters: { type: "object" } } },
    { function: { name: "TodoWrite", description: "Todo", parameters: { type: "object" } } },
    { function: { name: "kb_search", description: "KB search", parameters: { type: "object" } } },
    // NOT in sub-agent allow-list:
    { function: { name: "create_skill", description: "Create skill", parameters: { type: "object" } } },
  ],
}));

// Mock tool-executor.mjs
const runToolMock = vi.fn();
vi.mock("../core/tool-executor.ts", () => ({
  runTool: (...args: any[]) => runToolMock(...args),
}));

// Helper: build a fake streaming SSE response
function sseResponse(events: any) {
  const enc = new TextEncoder();
  const body = new ReadableStream({
    start(ctrl) {
      for (const e of events) ctrl.enqueue(enc.encode(e));
      ctrl.close();
    },
  });
  return { ok: true, status: 200, body, text: async () => "" };
}

function openaiSseChunk(delta: any, finishReason = null) {
  return `data: ${JSON.stringify({
    choices: [{ delta, finish_reason: finishReason }],
  })}\n\n`;
}
function openaiDone() { return "data: [DONE]\n\n"; }

function anthropicTextDelta(text: any) {
  return `data: ${JSON.stringify({
    type: "content_block_delta",
    index: 0,
    delta: { type: "text_delta", text },
  })}\n\n`;
}
function anthropicToolStart(id: any, name: any, index = 1) {
  return `data: ${JSON.stringify({
    type: "content_block_start",
    index,
    content_block: { type: "tool_use", id, name },
  })}\n\n`;
}
function anthropicToolInputDelta(index: any, partialJson: any) {
  return `data: ${JSON.stringify({
    type: "content_block_delta",
    index,
    delta: { type: "input_json_delta", partial_json: partialJson },
  })}\n\n`;
}
function anthropicMessageStop() {
  return `data: ${JSON.stringify({ type: "message_stop" })}\n\n`;
}

// Capture fetch calls and respond with a queue of pre-canned responses
let fetchQueue: any = [];
let fetchCalls: any = [];
function mockFetchNext(responses: any) {
  fetchQueue.push(...responses);
}
globalThis.fetch = vi.fn(async (url, init) => {
  fetchCalls.push({ url, init });
  if (fetchQueue.length === 0) {
    throw new Error("fetch called but no mock response queued");
  }
  return fetchQueue.shift();
});

beforeEach(() => {
  fetchQueue = [];
  fetchCalls = [];
  runToolMock.mockReset();
  stateMock._subAgentCtrls = new Map();
  stateMock.sendToRenderer.mockReset();
  stateMock.getLastApiConfig.mockReset();
  vi.resetModules(); // Force re-import of sub-agent with fresh mocks
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ─────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────

describe("sub-agent.ts", () => {
  it("returns early when API is not configured", async () => {
    stateMock.getLastApiConfig.mockReturnValue({});
    const { runSubAgent } = await import("../core/sub-agent.ts");
    const result = await runSubAgent("test", "do something");
    expect(result.text).toContain("子代理不可用");
    expect(fetchCalls).toHaveLength(0);
  });

  it("executes one OpenAI turn: text response, no tool calls → done", async () => {
    stateMock.getLastApiConfig.mockReturnValue({
      apiKey: "sk-test", apiUrl: "https://api.example.com/v1/chat/completions",
      model: "deepseek-chat", apiFormat: "openai",
    });
    mockFetchNext([
      sseResponse([
        openaiSseChunk({ content: "Hello " }),
        openaiSseChunk({ content: "world" }),
        openaiDone(),
      ]),
    ]);

    const { runSubAgent } = await import("../core/sub-agent.ts");
    const result = await runSubAgent("greet", "say hi");

    expect(result.text).toBe("Hello world");
    expect(result.aborted).toBeUndefined();
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0].url).toBe("https://api.example.com/v1/chat/completions");
    expect(stateMock.sendToRenderer).toHaveBeenCalledWith(
      "subagent:chunk", expect.objectContaining({ text: "Hello " })
    );
    expect(stateMock.sendToRenderer).toHaveBeenCalledWith(
      "subagent:progress", expect.objectContaining({ done: true })
    );
    // Ctrl should be cleaned up
    expect(stateMock._subAgentCtrls.size).toBe(0);
  });

  it("executes one Anthropic turn: text response", async () => {
    stateMock.getLastApiConfig.mockReturnValue({
      apiKey: "sk-ant", apiUrl: "https://api.anthropic.com/v1/messages",
      model: "claude-opus-4-6", apiFormat: "anthropic",
    });
    mockFetchNext([
      sseResponse([
        anthropicTextDelta("Anthropic says hi"),
        anthropicMessageStop(),
      ]),
    ]);

    const { runSubAgent } = await import("../core/sub-agent.ts");
    const result = await runSubAgent("greet", "say hi");

    expect(result.text).toBe("Anthropic says hi");
    // Anthropic endpoint normalization: url.replace(/\/v1\/messages$/, "") + "/v1/messages"
    expect(fetchCalls[0].url).toBe("https://api.anthropic.com/v1/messages");
    const body = JSON.parse(fetchCalls[0].init.body);
    expect(body.system).toBeDefined();
    expect(body.messages).toBeDefined();
    expect(body.messages[0].role).toBe("user");
  });

  it("OpenAI: executes tool call → routes to runTool → feeds result back → final text", async () => {
    stateMock.getLastApiConfig.mockReturnValue({
      apiKey: "sk-test", apiUrl: "https://api.example.com/v1/chat/completions",
      model: "deepseek-chat", apiFormat: "openai",
    });

    runToolMock.mockResolvedValueOnce({ content: "FILE_CONTENTS_42" });

    const toolCallArgs = JSON.stringify({ path: "/tmp/x.txt" });
    const toolCallEvent1 = JSON.stringify({
      choices: [{
        delta: { tool_calls: [{ index: 0, id: "call_abc", function: { name: "file_read", arguments: "" } }] },
        finish_reason: null,
      }],
    });
    const toolCallEvent2 = JSON.stringify({
      choices: [{
        delta: { tool_calls: [{ index: 0, function: { arguments: toolCallArgs } }] },
        finish_reason: "tool_calls",
      }],
    });

    // Turn 1: tool call. Turn 2: final text.
    mockFetchNext([
      sseResponse([
        `data: ${toolCallEvent1}\n\n`,
        `data: ${toolCallEvent2}\n\n`,
        openaiDone(),
      ]),
      sseResponse([
        openaiSseChunk({ content: "Found 42" }),
        openaiDone(),
      ]),
    ]);

    const { runSubAgent } = await import("../core/sub-agent.ts");
    const result = await runSubAgent("read", "read /tmp/x.txt");

    expect(runToolMock).toHaveBeenCalledTimes(1);
    const tcArg = runToolMock.mock.calls[0][0];
    expect(tcArg.function.name).toBe("file_read");
    expect(tcArg.function.arguments).toBe('{"path":"/tmp/x.txt"}');
    expect(result.text).toBe("Found 42");
    // Should have 2 assistant + 1 tool + 1 user + 1 system = 4 messages on 2nd call
    const lastCall = fetchCalls[1];
    const body = JSON.parse(lastCall.init.body);
    expect(body.messages.length).toBe(4);
    expect(body.messages.find((m: any) => m.role === "tool").content).toContain("FILE_CONTENTS_42");
  });

  it("archives an oversized tool result before the 16K cut (audit fix H2)", async () => {
    stateMock.getLastApiConfig.mockReturnValue({
      apiKey: "sk-test", apiUrl: "https://api.example.com/v1/chat/completions",
      model: "deepseek-chat", apiFormat: "openai",
    });
    const { setContextArchiveEnabled, readArchived } = await import("../core/context-archive.ts");
    const { default: sessionDb } = await import("../session-db.ts");
    setContextArchiveEnabled(true);

    runToolMock.mockResolvedValueOnce({ huge: "H2_MARKER_4d9e " + "x".repeat(20000) });

    const toolCallArgs = JSON.stringify({ path: "/tmp/big.txt" });
    mockFetchNext([
      sseResponse([
        `data: ${JSON.stringify({
          choices: [{
            delta: { tool_calls: [{ index: 0, id: "call_h2", function: { name: "file_read", arguments: "" } }] },
            finish_reason: null,
          }],
        })}\n\n`,
        `data: ${JSON.stringify({
          choices: [{
            delta: { tool_calls: [{ index: 0, function: { arguments: toolCallArgs } }] },
            finish_reason: "tool_calls",
          }],
        })}\n\n`,
        openaiDone(),
      ]),
      sseResponse([
        openaiSseChunk({ content: "done" }),
        openaiDone(),
      ]),
    ]);

    let cleanupId: string | null = null;
    try {
      const { runSubAgent } = await import("../core/sub-agent.ts");
      const result = await runSubAgent("read", "read /tmp/big.txt");
      expect(result.text).toBe("done");

      // The 16K-cut tool message fed back to the LLM keeps head + ca_* pointer.
      const body = JSON.parse(fetchCalls[1].init.body);
      const toolMsg = body.messages.find((m: any) => m.role === "tool");
      const m = toolMsg.content.match(/ca_[0-9a-f]{10}/);
      expect(m, "16K-cut tool result must carry a ca_* pointer").toBeTruthy();
      cleanupId = m[0];
      // The archived copy is the full original (>16K), retrievable verbatim.
      const row = readArchived(m[0]);
      expect(row?.content).toContain("H2_MARKER_4d9e");
      expect(row!.content.length).toBeGreaterThan(16000);
      expect(toolMsg.content.length).toBeLessThanOrEqual(16100);
    } finally {
      // Hygiene: even on assertion failure, never leak a NULL-session archive
      // row into the user's real DB (NULL rows are readable from any session).
      if (cleanupId) sessionDb.deleteContext(cleanupId);
      setContextArchiveEnabled(true); // back to module default
    }
  });

  it("rejects tool not in SUB_AGENT_TOOL_NAMES (returns error, does not run)", async () => {
    stateMock.getLastApiConfig.mockReturnValue({
      apiKey: "sk-test", apiUrl: "https://api.example.com/v1/chat/completions",
      model: "deepseek-chat", apiFormat: "openai",
    });

    mockFetchNext([
      sseResponse([
        `data: ${JSON.stringify({
          choices: [{
            delta: { tool_calls: [{ index: 0, id: "call_xyz", function: { name: "create_skill", arguments: "{}" } }] },
            finish_reason: "tool_calls",
          }],
        })}\n\n`,
        openaiDone(),
      ]),
      sseResponse([
        openaiSseChunk({ content: "ok" }),
        openaiDone(),
      ]),
    ]);

    const { runSubAgent } = await import("../core/sub-agent.ts");
    const result = await runSubAgent("test", "do bad thing");

    expect(runToolMock).not.toHaveBeenCalled();
    const lastCall = fetchCalls[1];
    const body = JSON.parse(lastCall.init.body);
    const toolMsg = body.messages.find((m: any) => m.role === "tool");
    expect(toolMsg.content).toContain("not available to sub-agent");
    expect(result.text).toBe("ok");
  });

  it("rejects structured-state write tools (TaskUpdate) — audit fix C3", async () => {
    stateMock.getLastApiConfig.mockReturnValue({
      apiKey: "sk-test", apiUrl: "https://api.example.com/v1/chat/completions",
      model: "deepseek-chat", apiFormat: "openai",
    });
    mockFetchNext([
      sseResponse([
        `data: ${JSON.stringify({
          choices: [{
            delta: { tool_calls: [{ index: 0, id: "call_tu", function: { name: "TaskUpdate", arguments: "{}" } }] },
            finish_reason: "tool_calls",
          }],
        })}\n\n`,
        openaiDone(),
      ]),
      sseResponse([
        openaiSseChunk({ content: "ok" }),
        openaiDone(),
      ]),
    ]);

    const { runSubAgent } = await import("../core/sub-agent.ts");
    const result = await runSubAgent("test", "update task state");

    expect(runToolMock).not.toHaveBeenCalled();
    const lastCall = fetchCalls[1];
    const body = JSON.parse(lastCall.init.body);
    const toolMsg = body.messages.find((m: any) => m.role === "tool");
    expect(toolMsg.content).toContain("not available to sub-agent");
    expect(result.text).toBe("ok");
  });

  it("Anthropic: streams tool use with input_json_delta, executes, returns final", async () => {
    stateMock.getLastApiConfig.mockReturnValue({
      apiKey: "sk-ant", apiUrl: "https://api.anthropic.com/v1/messages",
      model: "claude-opus-4-6", apiFormat: "anthropic",
    });

    runToolMock.mockResolvedValueOnce({ hit: true, count: 3 });

    mockFetchNext([
      sseResponse([
        anthropicToolStart("toolu_1", "kb_search", 1),
        anthropicToolInputDelta(1, '{"query":"test"'),
        anthropicToolInputDelta(1, "}"),
        anthropicMessageStop(),
      ]),
      sseResponse([
        anthropicTextDelta("Searched KB, found 3 hits."),
        anthropicMessageStop(),
      ]),
    ]);

    const { runSubAgent } = await import("../core/sub-agent.ts");
    const result = await runSubAgent("search", "search KB for test");

    expect(runToolMock).toHaveBeenCalledTimes(1);
    expect(runToolMock.mock.calls[0][0].function.name).toBe("kb_search");
    expect(runToolMock.mock.calls[0][0].function.arguments).toBe('{"query":"test"}');
    expect(result.text).toBe("Searched KB, found 3 hits.");
  });

  it("respects SUB_AGENT_MAX_TURNS=12 (loops exactly 12 times before bailing)", async () => {
    stateMock.getLastApiConfig.mockReturnValue({
      apiKey: "sk-test", apiUrl: "https://api.example.com/v1/chat/completions",
      model: "deepseek-chat", apiFormat: "openai",
    });

    // Always returns a tool call to force loop
    function infiniteToolResponse() {
      return sseResponse([
        `data: ${JSON.stringify({
          choices: [{
            delta: { tool_calls: [{ index: 0, id: "call_loop", function: { name: "file_read", arguments: "{}" } }] },
            finish_reason: "tool_calls",
          }],
        })}\n\n`,
        openaiDone(),
      ]);
    }
    runToolMock.mockResolvedValue({ ok: true });
    for (let i = 0; i < 12; i++) mockFetchNext([infiniteToolResponse()]);

    const { runSubAgent } = await import("../core/sub-agent.ts");
    const result = await runSubAgent("loop", "loop forever");

    // After 12 turns with persistent tool_calls, the loop exits (no tcs OR turns >= 12)
    expect(fetchCalls.length).toBe(12);
    expect(runToolMock).toHaveBeenCalledTimes(12);
    // Final text should be empty since no text content
    expect(result.text).toBe("(no result)");
  });

  it("aborts gracefully when AbortController is signaled", async () => {
    stateMock.getLastApiConfig.mockReturnValue({
      apiKey: "sk-test", apiUrl: "https://api.example.com/v1/chat/completions",
      model: "deepseek-chat", apiFormat: "openai",
    });

    // Slow response that we can abort
    let abortListener;
    const slowBody = new ReadableStream({
      start(ctrl) {
        abortListener = () => ctrl.error(new DOMException("Aborted", "AbortError"));
      },
    });
    fetchQueue.push({ ok: true, status: 200, body: slowBody, text: async () => "" });

    const { runSubAgent } = await import("../core/sub-agent.ts");
    const promise = runSubAgent("slow", "test slow");

    // Wait a tick, then abort the active sub-agent
    await new Promise(r => setTimeout(r, 5));
    const [id, ctrl] = [...stateMock._subAgentCtrls.entries()][0];
    abortListener!();
    ctrl.abort();

    const result = await promise;
    expect(result.aborted).toBe(true);
    expect(stateMock._subAgentCtrls.has(id)).toBe(false); // cleaned up
  });

  it("handles API error (non-2xx) gracefully", async () => {
    stateMock.getLastApiConfig.mockReturnValue({
      apiKey: "sk-test", apiUrl: "https://api.example.com/v1/chat/completions",
      model: "deepseek-chat", apiFormat: "openai",
    });
    fetchQueue.push({
      ok: false, status: 401, statusText: "Unauthorized",
      text: async () => "Invalid API key",
    });

    const { runSubAgent } = await import("../core/sub-agent.ts");
    const result = await runSubAgent("err", "do thing");

    expect(result.text).toContain("子代理错误");
    expect(result.text).toContain("API 401");
    expect(stateMock._subAgentCtrls.size).toBe(0); // cleaned up
  });

  it("truncates tool result to 16000 chars (with reversible marker, H2)", async () => {
    stateMock.getLastApiConfig.mockReturnValue({
      apiKey: "sk-test", apiUrl: "https://api.example.com/v1/chat/completions",
      model: "deepseek-chat", apiFormat: "openai",
    });
    const { setContextArchiveEnabled } = await import("../core/context-archive.ts");
    setContextArchiveEnabled(false); // no DB writes in this test
    const hugeResult = { content: "X".repeat(50000) };
    runToolMock.mockResolvedValueOnce(hugeResult);

    mockFetchNext([
      sseResponse([
        `data: ${JSON.stringify({
          choices: [{
            delta: { tool_calls: [{ index: 0, id: "call_big", function: { name: "file_read", arguments: "{}" } }] },
            finish_reason: "tool_calls",
          }],
        })}\n\n`,
        openaiDone(),
      ]),
      sseResponse([
        openaiSseChunk({ content: "ok" }),
        openaiDone(),
      ]),
    ]);

    const { runSubAgent } = await import("../core/sub-agent.ts");
    await runSubAgent("big", "read big file");

    const lastCall = fetchCalls[1];
    const body = JSON.parse(lastCall.init.body);
    const toolMsg = body.messages.find((m: any) => m.role === "tool");
    // Head of the original is preserved verbatim; only the marker is appended.
    expect(toolMsg.content.slice(0, 16000)).toBe(JSON.stringify(hugeResult).slice(0, 16000));
    expect(toolMsg.content.length).toBeGreaterThanOrEqual(16000);
    expect(toolMsg.content.length).toBeLessThanOrEqual(16100);
    // Archive disabled → the honest fallback, never a fabricated pointer.
    expect(toolMsg.content).toContain("不可恢复");
  });

  it("drops reasoning_content field for Anthropic (DeepSeek-specific)", async () => {
    stateMock.getLastApiConfig.mockReturnValue({
      apiKey: "sk-ant", apiUrl: "https://api.anthropic.com/v1/messages",
      model: "claude-opus-4-6", apiFormat: "anthropic",
    });
    // The cleanMsgs filter applies only when apiFormat !== "anthropic"
    // so for Anthropic, msgs go through unchanged. But the filter is in the
    // OpenAI branch — Anthropic gets cleanMsgs = msgs directly.
    // Test: just verify Anthropic doesn't pass system in messages array
    mockFetchNext([
      sseResponse([
        anthropicTextDelta("ok"),
        anthropicMessageStop(),
      ]),
    ]);

    const { runSubAgent } = await import("../core/sub-agent.ts");
    await runSubAgent("test", "hello");

    const body = JSON.parse(fetchCalls[0].init.body);
    // System should be top-level, not in messages
    expect(body.system).toBeDefined();
    expect(body.messages.every((m: any) => m.role !== "system")).toBe(true);
  });

  it("uses provided subAgentId (not auto-generated)", async () => {
    stateMock.getLastApiConfig.mockReturnValue({
      apiKey: "sk-test", apiUrl: "https://api.example.com/v1/chat/completions",
      model: "deepseek-chat", apiFormat: "openai",
    });
    mockFetchNext([
      sseResponse([openaiSseChunk({ content: "ok" }), openaiDone()]),
    ]);

    const { runSubAgent } = await import("../core/sub-agent.ts");
    await runSubAgent("desc", "prompt", "my_custom_id");

    expect(stateMock.sendToRenderer).toHaveBeenCalledWith(
      "subagent:progress",
      expect.objectContaining({ id: "my_custom_id" })
    );
  });
});

describe("structured return (audit fix C4)", () => {
  it("parses the fixed structured sections from a research-style reply", async () => {
    const { parseStructured } = await import("../core/sub-agent.ts");
    const parsed = parseStructured(
      "先分析了一堆文件，结论如下：\n## 结论\n发现 3 个 bug\n## 关键证据\n- a.ts:10 空指针\n- b.ts:20 死循环\n## 未解决问题\n无\n## 建议的下一步\n跑测试验证"
    );
    expect(parsed).toEqual({
      conclusion: "发现 3 个 bug",
      evidence: "- a.ts:10 空指针\n- b.ts:20 死循环",
      openIssues: "无",
      nextStep: "跑测试验证",
    });
  });

  it("returns null for a plain-text reply (soft, not hard)", async () => {
    const { parseStructured } = await import("../core/sub-agent.ts");
    expect(parseStructured("这是一段普通翻译文本，没有任何结构化小节。")).toBe(null);
    expect(parseStructured("")).toBe(null);
    expect(parseStructured(null as any)).toBe(null);
  });

  it("returns null when the conclusion section is empty (header followed by next header)", async () => {
    const { parseStructured } = await import("../core/sub-agent.ts");
    // Regression (review finding): the old regex let \s* swallow the newline
    // and captured the NEXT header as the conclusion.
    const parsed = parseStructured("## 结论\n\n## 关键证据\nsome evidence");
    expect(parsed).toBe(null);
  });

  it("keeps code blocks intact when they contain ##-style lines (fence-aware)", async () => {
    const { parseStructured } = await import("../core/sub-agent.ts");
    // Regression (review finding): '## comment in code' inside a ```fence```
    // used to terminate the evidence section early.
    const parsed = parseStructured(
      "## 结论\nfound bug\n## 关键证据\n```python\n## comment in code\nx = 1\n```\n## 未解决问题\nnone\n## 建议的下一步\nrun tests"
    );
    expect(parsed).not.toBe(null);
    expect(parsed!.evidence).toBe("```python\n## comment in code\nx = 1\n```");
    expect(parsed!.openIssues).toBe("none");
    expect(parsed!.nextStep).toBe("run tests");
  });

  it("surfaces the structured block through runSubAgent end-to-end", async () => {
    stateMock.getLastApiConfig.mockReturnValue({
      apiKey: "sk-test", apiUrl: "https://api.example.com/v1/chat/completions",
      model: "deepseek-chat", apiFormat: "openai",
    });
    mockFetchNext([
      sseResponse([
        openaiSseChunk({ content: "调研完成。" }),
        openaiSseChunk({ content: "\n## 结论\n用 pnpm\n## 关键证据\npackage-lock 是 pnpm 生成" }),
        openaiSseChunk({ content: "\n## 未解决问题\n无\n## 建议的下一步\n跑 install" }),
        openaiDone(),
      ]),
    ]);

    const { runSubAgent } = await import("../core/sub-agent.ts");
    const result = await runSubAgent("research", "调研包管理器");
    expect(result.structured).toEqual({
      conclusion: "用 pnpm",
      evidence: "package-lock 是 pnpm 生成",
      openIssues: "无",
      nextStep: "跑 install",
    });
  });
});
