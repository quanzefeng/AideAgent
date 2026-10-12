// OpenAI Responses API adapter: input/tool mapping, request body shape,
// SSE stream parsing, and chat/completions URL derivation for aux calls.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

beforeEach(() => {
  vi.stubEnv("DEBUG_REASONING", "");
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("toChatCompletionsUrl", () => {
  it("maps .../responses onto .../chat/completions, leaves other shapes alone", async () => {
    const { toChatCompletionsUrl } = await import("../core/format-adapters.ts");
    expect(toChatCompletionsUrl("https://api.openai.com/v1/responses")).toBe("https://api.openai.com/v1/chat/completions");
    expect(toChatCompletionsUrl("https://api.openai.com/v1/chat/completions")).toBe("https://api.openai.com/v1/chat/completions");
    expect(toChatCompletionsUrl("https://host/v1")).toBe("https://host/v1");
  });
});

describe("toResponsesInput", () => {
  it("merges system messages into instructions", async () => {
    const { toResponsesInput } = await import("../core/format-adapters.ts");
    const { instructions, input } = toResponsesInput([
      { role: "system", content: "You are helpful." },
      { role: "system", content: "Be brief." },
      { role: "user", content: "hi" },
    ]);
    expect(instructions).toBe("You are helpful.\n\nBe brief.");
    expect(input).toEqual([{ role: "user", content: "hi" }]);
  });

  it("converts assistant tool_calls to function_call items and tool results to function_call_output", async () => {
    const { toResponsesInput } = await import("../core/format-adapters.ts");
    const { instructions, input } = toResponsesInput([
      { role: "user", content: "read a.txt" },
      { role: "assistant", content: "on it", tool_calls: [{ id: "call_1", type: "function", function: { name: "file_read", arguments: '{"path":"a.txt"}' } }] },
      { role: "tool", tool_call_id: "call_1", content: "file body" },
    ]);
    expect(instructions).toBeNull();
    expect(input).toEqual([
      { role: "user", content: "read a.txt" },
      { role: "assistant", content: "on it" },
      { type: "function_call", call_id: "call_1", name: "file_read", arguments: '{"path":"a.txt"}' },
      { type: "function_call_output", call_id: "call_1", output: "file body" },
    ]);
  });

  it("maps image_url content parts to input_image items", async () => {
    const { toResponsesInput } = await import("../core/format-adapters.ts");
    const { input } = toResponsesInput([
      { role: "user", content: [{ type: "text", text: "what is this" }, { type: "image_url", image_url: { url: "data:image/png;base64,AAA" } }] },
    ]);
    expect(input[0].content).toEqual([
      { type: "input_text", text: "what is this" },
      { type: "input_image", image_url: "data:image/png;base64,AAA" },
    ]);
  });
});

describe("toResponsesTools", () => {
  it("flattens chat-style tool defs into the Responses flat function shape", async () => {
    const { toResponsesTools } = await import("../core/format-adapters.ts");
    const tools = toResponsesTools(false, false);
    expect(tools.length).toBeGreaterThan(0);
    for (const t of tools) {
      expect(t.type).toBe("function");
      expect(typeof t.name).toBe("string");
      expect(typeof t.description).toBe("string");
      expect(t.parameters).toBeTypeOf("object");
      expect(t).not.toHaveProperty("function");
    }
  });
});

describe("responsesCall", () => {
  const responsesSSE =
    'data: {"type":"response.reasoning_summary_text.delta","delta":"think..."}\n\n' +
    'data: {"type":"response.output_text.delta","delta":"ok"}\n\n' +
    'data: {"type":"response.completed","response":{"status":"completed","usage":{"input_tokens":10,"output_tokens":5,"total_tokens":15}}}\n\n';

  const responsesToolSSE =
    'data: {"type":"response.output_item.added","item":{"type":"function_call","id":"fc_1","call_id":"call_1","name":"file_read"}}\n\n' +
    'data: {"type":"response.function_call_arguments.delta","item_id":"fc_1","delta":"{\\"path\\":"}\n\n' +
    'data: {"type":"response.function_call_arguments.delta","item_id":"fc_1","delta":"\\"a.txt\\"}"}\n\n' +
    'data: {"type":"response.output_item.done","item":{"type":"function_call","id":"fc_1","call_id":"call_1","name":"file_read","arguments":"{\\"path\\":\\"a.txt\\"}"}}\n\n' +
    'data: {"type":"response.completed","response":{"status":"completed","usage":{"input_tokens":10,"output_tokens":5,"total_tokens":15}}}\n\n';

  let captured: { url: string, body: any, auth: string | null };
  let nextSSE: string;
  let fetchMock: any;

  beforeEach(() => {
    captured = { url: "", body: null, auth: null };
    nextSSE = responsesSSE;
    fetchMock = vi.fn(async (url: any, init: any) => {
      captured.url = String(url);
      captured.body = JSON.parse(init.body);
      captured.auth = init.headers?.Authorization ?? null;
      return new Response(nextSSE, { status: 200, headers: { "Content-Type": "text/event-stream" } });
    });
    vi.stubGlobal("fetch", fetchMock);
  });

  it("POSTs to .../v1/responses with Bearer auth, flat tools, and instructions", async () => {
    const { responsesCall } = await import("../core/format-adapters.ts");
    const r = await responsesCall(
      [{ role: "system", content: "sys" }, { role: "user", content: "hi" }],
      "https://example.test/v1/responses", "sk-test", "test-model",
      new AbortController().signal, "none", false, false, true,
    );
    expect(captured.url).toBe("https://example.test/v1/responses");
    expect(captured.auth).toBe("Bearer sk-test");
    expect(captured.body.instructions).toBe("sys");
    expect(captured.body.input).toEqual([{ role: "user", content: "hi" }]);
    expect(captured.body.stream).toBe(true);
    expect(captured.body.max_output_tokens).toBeGreaterThan(0);
    expect(Array.isArray(captured.body.tools)).toBe(true);
    for (const t of captured.body.tools) expect(t.type).toBe("function");
    expect(captured.body).not.toHaveProperty("reasoning");
    expect(r.content).toBe("ok");
    expect(r.reasoningContent).toBe("think...");
    expect(r.finishReason).toBe("stop");
    expect(r.tcs).toEqual([]);
    expect(r.usage).toEqual({ input_tokens: 10, output_tokens: 5, total_tokens: 15 });
  });

  it("maps effort levels onto reasoning.effort (max→high, none omits)", async () => {
    const { responsesCall } = await import("../core/format-adapters.ts");
    for (const [lvl, expected] of [["low", "low"], ["medium", "medium"], ["high", "high"], ["max", "high"]] as const) {
      captured.body = null;
      await responsesCall(
        [{ role: "user", content: "hi" }],
        "https://example.test/v1/responses", "sk-test", "test-model",
        new AbortController().signal, lvl, false, false, true,
      );
      expect(captured.body.reasoning).toEqual({ effort: expected, summary: "auto" });
    }
  });

  it("accepts a bare host URL and appends /v1/responses", async () => {
    const { responsesCall } = await import("../core/format-adapters.ts");
    await responsesCall(
      [{ role: "user", content: "hi" }],
      "https://example.test", "sk-test", "test-model",
      new AbortController().signal, "none", false, false, true,
    );
    expect(captured.url).toBe("https://example.test/v1/responses");
  });

  it("assembles function calls from SSE deltas with output_item.done as authority", async () => {
    const { responsesCall } = await import("../core/format-adapters.ts");
    nextSSE = responsesToolSSE;
    const r = await responsesCall(
      [{ role: "user", content: "read a.txt" }],
      "https://example.test/v1/responses", "sk-test", "test-model",
      new AbortController().signal, "none", true, false, true,
    );
    expect(r.tcs).toEqual([
      { id: "call_1", type: "function", function: { name: "file_read", arguments: '{"path":"a.txt"}' } },
    ]);
    expect(r.finishReason).toBe("tool_calls");
  });
});
