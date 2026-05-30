import { describe, it, expect } from "vitest";
import { toAnthropicMessages } from "../core/format-adapters.mjs";

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
