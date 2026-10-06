import { describe, it, expect, afterEach } from "vitest";
import { toAnthropicMessages, computeMaxTokens, isContextOverflowText } from "../core/format-adapters.ts";
import { setContextWindow, DEFAULT_CONTEXT_WINDOW, CONTEXT_WINDOW } from "../core/state.ts";
import { estimateTokens } from "../core/token-budget.ts";

afterEach(() => {
  setContextWindow(DEFAULT_CONTEXT_WINDOW);
});

describe("computeMaxTokens", () => {
  it("caps at 65536 when the window is roomy", () => {
    setContextWindow(262144);
    expect(computeMaxTokens([{ role: "user", content: "hi" }], [])).toBe(65536);
  });

  it("shrinks below the cap once the prompt eats the window", () => {
    setContextWindow(131072);
    const content = "x".repeat(300_000);
    const msgs = [{ role: "user", content }];
    const toolDefs = [{ type: "function", function: { name: "bash", description: "run", parameters: { type: "object", properties: { command: { type: "string" } } } } }];
    const max = computeMaxTokens(msgs, toolDefs);
    expect(max).toBeLessThan(65536);
    expect(max).toBeGreaterThanOrEqual(4096);
    // The exact inequality the API rejected: prompt + max_tokens <= window.
    expect(estimateTokens(content) + max).toBeLessThanOrEqual(CONTEXT_WINDOW);
    // Still leaves the model a usable reply budget.
    expect(max).toBeGreaterThan(10_000);
  });

  it("never drops below the 4096 floor", () => {
    setContextWindow(4096);
    expect(computeMaxTokens([{ role: "user", content: "y".repeat(100_000) }])).toBe(4096);
  });

  it("reproduces the reported failure: 65816 prompt + 65536 > 131072", () => {
    setContextWindow(131072);
    const content = "x".repeat(65816 * 4); // ≈65816 ASCII tokens
    expect(estimateTokens(content)).toBe(65816);
    const max = computeMaxTokens([{ role: "user", content }]);
    expect(max).toBeLessThan(65536);
    expect(estimateTokens(content) + max).toBeLessThanOrEqual(131072);
  });
});

describe("isContextOverflowText", () => {
  it("matches llama.cpp exceed_context_size_error", () => {
    expect(isContextOverflowText('{"error":{"type":"exceed_context_size_error","n_ctx":65536}}')).toBe(true);
  });

  it("matches the strata 'exceeds the context (N)' 400 body", () => {
    const body = '{"error": {"type": "invalid_request_error", "message": "prompt (65816 tokens) + max tokens (65536) exceeds the context (131072); requests are never truncated."}}';
    expect(isContextOverflowText(body)).toBe(true);
  });

  it("matches 'exceeds the available context size'", () => {
    expect(isContextOverflowText("exceeds the available context size (65536)")).toBe(true);
  });

  it("ignores unrelated errors", () => {
    expect(isContextOverflowText('{"error":{"type":"invalid_request_error","message":"model not found"}}')).toBe(false);
    expect(isContextOverflowText("429 too many requests")).toBe(false);
  });
});

describe("Format Adapters", () => {
  describe("toAnthropicMessages", () => {
    it("extracts system message separately", () => {
      const msgs = [
        { role: "system", content: "You are helpful" },
        { role: "user", content: "hello" },
      ];
      const result = toAnthropicMessages(msgs);
      expect(result.system).toBe("You are helpful");
      expect(result.messages).toHaveLength(1);
      expect(result.messages[0].role).toBe("user");
    });

    it("converts user text messages", () => {
      const msgs = [{ role: "user", content: "hello" }];
      const result = toAnthropicMessages(msgs);
      expect(result.messages).toHaveLength(1);
      expect(result.messages[0]).toEqual({ role: "user", content: "hello" });
    });

    it("converts assistant text messages", () => {
      const msgs = [{ role: "assistant", content: "hi there" }];
      const result = toAnthropicMessages(msgs);
      expect(result.messages).toHaveLength(1);
      expect(result.messages[0].role).toBe("assistant");
      expect(result.messages[0].content).toEqual([{ type: "text", text: "hi there" }]);
    });

    it("converts assistant messages with tool_calls", () => {
      const msgs = [
        {
          role: "assistant",
          content: "let me check",
          tool_calls: [
            {
              id: "call_123",
              function: { name: "bash", arguments: '{"command":"ls"}' },
            },
          ],
        },
      ];
      const result = toAnthropicMessages(msgs);
      expect(result.messages).toHaveLength(1);
      const content = result.messages[0].content;
      expect(content).toHaveLength(2);
      expect(content[0]).toEqual({ type: "text", text: "let me check" });
      expect(content[1]).toEqual({
        type: "tool_use",
        id: "call_123",
        name: "bash",
        input: { command: "ls" },
      });
    });

    it("converts tool result messages", () => {
      const msgs = [
        { role: "tool", tool_call_id: "call_123", content: "file.txt" },
      ];
      const result = toAnthropicMessages(msgs);
      expect(result.messages).toHaveLength(1);
      expect(result.messages[0]).toEqual({
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "call_123", content: "file.txt" }],
      });
    });

    it("handles empty messages", () => {
      const result = toAnthropicMessages([]);
      expect(result.messages).toHaveLength(0);
      expect(result.system).toBeNull();
    });

    it("returns null system when no system message", () => {
      const msgs = [{ role: "user", content: "hello" }];
      const result = toAnthropicMessages(msgs);
      expect(result.system).toBeNull();
    });

    it("handles multiple messages in order", () => {
      const msgs = [
        { role: "system", content: "sys" },
        { role: "user", content: "q1" },
        { role: "assistant", content: "a1" },
        { role: "user", content: "q2" },
      ];
      const result = toAnthropicMessages(msgs);
      expect(result.system).toBe("sys");
      expect(result.messages).toHaveLength(3);
      expect(result.messages[0].role).toBe("user");
      expect(result.messages[1].role).toBe("assistant");
      expect(result.messages[2].role).toBe("user");
    });
  });
});
