import { describe, it, expect } from "vitest";
import { normalizeToolPairing } from "../core/format-adapters.ts";

describe("normalizeToolPairing", () => {
  it("passes through well-formed live-loop messages unchanged", () => {
    const msgs = [
      { role: "system", content: "sys" },
      { role: "user", content: "hi" },
      { role: "assistant", content: "", tool_calls: [{ id: "c1", type: "function", function: { name: "bash", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "c1", content: "ok" },
      { role: "assistant", content: "done" },
    ];
    expect(normalizeToolPairing(msgs)).toEqual(msgs);
  });

  it("synthesizes an assistant before orphan tool rows from saved Format A history", () => {
    const msgs = [
      { role: "user", content: "q" },
      {
        role: "tool",
        content: "r",
        tool_calls: [{ id: "t1", type: "function", function: { name: "grep", arguments: "{\"p\":\"x\"}" } }],
      },
      { role: "assistant", content: "a" },
    ];
    const out = normalizeToolPairing(msgs);
    expect(out.map(m => m.role)).toEqual(["user", "assistant", "tool", "assistant"]);
    expect(out[1].tool_calls[0].id).toBe("t1");
    expect(out[1].tool_calls[0].function.name).toBe("grep");
    expect(out[2].tool_call_id).toBe("t1");
    expect(out[2].content).toBe("r");
    // tool row no longer carries the assistant-side metadata
    expect(out[2].tool_calls).toBeUndefined();
  });

  it("answers unanswered assistant tool_calls before the next non-tool message", () => {
    const msgs = [
      { role: "assistant", content: "", tool_calls: [{ id: "c1", type: "function", function: { name: "bash", arguments: "{}" } }] },
      { role: "user", content: "next question" },
    ];
    const out = normalizeToolPairing(msgs);
    expect(out.map(m => m.role)).toEqual(["assistant", "tool", "user"]);
    expect(out[1]).toEqual({ role: "tool", tool_call_id: "c1", content: "" });
  });

  it("generates an id when a tool row has neither tool_call_id nor tool_calls", () => {
    const msgs = [
      { role: "user", content: "q" },
      { role: "tool", content: "orphan" },
    ];
    const out = normalizeToolPairing(msgs);
    expect(out.map(m => m.role)).toEqual(["user", "assistant", "tool"]);
    expect(typeof out[2].tool_call_id).toBe("string");
    expect(out[2].tool_call_id.length).toBeGreaterThan(0);
  });

  it("handles mixed covered + orphan tool rows in one run", () => {
    const msgs = [
      { role: "assistant", content: "", tool_calls: [{ id: "c1", type: "function", function: { name: "bash", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "c1", content: "ok" },
      {
        role: "tool",
        content: "orphan-result",
        tool_calls: [{ id: "t9", type: "function", function: { name: "grep", arguments: "{}" } }],
      },
      { role: "assistant", content: "a" },
    ];
    const out = normalizeToolPairing(msgs);
    expect(out.map(m => m.role)).toEqual(["assistant", "tool", "assistant", "tool", "assistant"]);
    expect(out[1].tool_call_id).toBe("c1");
    expect(out[3].tool_call_id).toBe("t9");
  });

  it("returns empty/non-array input as-is", () => {
    expect(normalizeToolPairing([])).toEqual([]);
    expect(normalizeToolPairing(undefined as any)).toBeUndefined();
  });
});
