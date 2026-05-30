import { describe, it, expect } from "vitest";
import { estimateTokens, trimToBudget, estimateMessageTokens } from "../core/token-budget.mjs";

describe("Token Budget", () => {
  describe("estimateTokens", () => {
    it("returns 0 for empty/null input", () => {
      expect(estimateTokens("")).toBe(0);
      expect(estimateTokens(null)).toBe(0);
      expect(estimateTokens(undefined)).toBe(0);
    });

    it("estimates ASCII text", () => {
      // 4 ASCII chars → ceil(4 * 0.25) = 1 token
      expect(estimateTokens("abcd")).toBe(1);
      // 8 ASCII chars → ceil(8 * 0.25) = 2 tokens
      expect(estimateTokens("abcdefgh")).toBe(2);
    });

    it("estimates CJK text", () => {
      // 1 CJK char → ceil(1 * 1.5) = 2 tokens (rounded up)
      expect(estimateTokens("你")).toBe(2);
      // 2 CJK chars → ceil(2 * 1.5) = 3 tokens
      expect(estimateTokens("你好")).toBe(3);
    });

    it("estimates mixed ASCII and CJK", () => {
      // "你好ab" → 2 CJK (3 tokens) + 2 ASCII (1 token) = 4
      const result = estimateTokens("你好ab");
      expect(result).toBeGreaterThan(0);
      expect(typeof result).toBe("number");
    });
  });

  describe("trimToBudget", () => {
    it("returns original text if within budget", () => {
      const text = "short text";
      expect(trimToBudget(text, 1000)).toBe(text);
    });

    it("truncates text when over budget", () => {
      const longText = "a".repeat(10000);
      const result = trimToBudget(longText, 100);
      expect(result.length).toBeLessThan(longText.length);
      expect(result).toContain("truncated");
    });

    it("returns original if null/empty", () => {
      expect(trimToBudget("", 100)).toBe("");
      expect(trimToBudget(null, 100)).toBe(null);
    });
  });

  describe("estimateMessageTokens", () => {
    it("estimates simple message array", () => {
      const msgs = [
        { role: "user", content: "hello" },
        { role: "assistant", content: "hi there" },
      ];
      const result = estimateMessageTokens(msgs);
      expect(result.totalTokens).toBeGreaterThan(0);
      expect(result.systemTokens).toBe(0);
      expect(result.historyTokens).toBeGreaterThan(0);
      expect(result.toolResultTokens).toBe(0);
    });

    it("handles system messages separately", () => {
      const msgs = [
        { role: "system", content: "You are a helpful assistant" },
        { role: "user", content: "hello" },
      ];
      const result = estimateMessageTokens(msgs);
      expect(result.systemTokens).toBeGreaterThan(0);
      expect(result.historyTokens).toBeGreaterThan(0);
    });

    it("handles tool messages", () => {
      const msgs = [
        { role: "tool", content: "file contents here" },
      ];
      const result = estimateMessageTokens(msgs);
      expect(result.toolResultTokens).toBeGreaterThan(0);
    });

    it("handles messages with tool_calls", () => {
      const msgs = [
        {
          role: "assistant",
          content: "let me check",
          tool_calls: [{ function: { name: "bash", arguments: '{"command":"ls"}' } }],
        },
      ];
      const result = estimateMessageTokens(msgs);
      expect(result.historyTokens).toBeGreaterThan(0);
    });

    it("handles non-string content", () => {
      const msgs = [
        { role: "user", content: [{ type: "text", text: "hello" }] },
      ];
      const result = estimateMessageTokens(msgs);
      expect(result.totalTokens).toBeGreaterThan(0);
    });

    it("returns zero for empty array", () => {
      const result = estimateMessageTokens([]);
      expect(result.totalTokens).toBe(0);
      expect(result.systemTokens).toBe(0);
      expect(result.historyTokens).toBe(0);
      expect(result.toolResultTokens).toBe(0);
    });
  });
});
