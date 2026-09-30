import { describe, it, expect } from "vitest";
import { buildTurnHistory } from "../core/agent-loop.ts";

describe("buildTurnHistory", () => {
  it("keeps prior turns including their tool rows (saveSession is DELETE+re-insert)", () => {
    const prior = [
      { role: "user", content: "q1" },
      {
        role: "tool",
        content: "r1",
        tool_calls: [{ id: "t1", type: "function", function: { name: "bash", arguments: "{}" } }],
      },
      { role: "assistant", content: "a1" },
    ];
    const out = buildTurnHistory({
      priorTurns: prior,
      prompt: "q2",
      tools: [{ id: "t2", name: "grep", args: { pattern: "x" }, result: "found" }],
      assistantContent: "a2",
    });
    expect(out.length).toBe(6);
    expect(out[0]).toEqual(prior[0]);
    expect(out[1]).toEqual(prior[1]);
    expect(out[2]).toEqual(prior[2]);
    expect(out[3]).toEqual({ role: "user", content: "q2" });
    expect(out[4].role).toBe("tool");
    expect(out[4].tool_call_id).toBe("t2");
    expect(out[4].tool_calls![0].function.name).toBe("grep");
    expect(out[5]).toEqual({ role: "assistant", content: "a2" });
  });

  it("emits this turn as user → tool entries → assistant", () => {
    const out = buildTurnHistory({
      priorTurns: [],
      prompt: "hello",
      tools: [
        { id: "a", name: "file_read", args: { path: "x.ts" }, result: "file body" },
        { id: "b", name: "bash", args: { command: "ls" }, result: "ok" },
      ],
      assistantContent: "done",
    });
    expect(out.map(m => m.role)).toEqual(["user", "tool", "tool", "assistant"]);
    expect(out[1].tool_call_id).toBe("a");
    expect(out[2].tool_call_id).toBe("b");
  });

  it("uses a file-list placeholder when prompt is empty", () => {
    const out = buildTurnHistory({
      priorTurns: [],
      prompt: "",
      files: [{ name: "a.png" }, { name: "b.pdf" }],
      assistantContent: "saw them",
    });
    expect(out[0].content).toBe("[a.png, b.pdf]");
    expect(out[out.length - 1].content).toBe("saw them");
  });

  it("attaches assistantReasoning as reasoning_content", () => {
    const out = buildTurnHistory({
      priorTurns: [],
      prompt: "q",
      assistantContent: "a",
      assistantReasoning: "thinking…",
    });
    const asst = out[out.length - 1];
    expect(asst.reasoning_content).toBe("thinking…");
  });

  it("truncates oversized tool args/result", () => {
    const out = buildTurnHistory({
      priorTurns: [],
      prompt: "q",
      tools: [{ id: "t", name: "bash", args: { cmd: "x".repeat(2000) }, result: "y".repeat(5000) }],
      assistantContent: "a",
    });
    const tool = out[1];
    expect(tool.tool_calls![0].function.arguments.length).toBeLessThanOrEqual(500);
    expect(tool.content.length).toBeLessThanOrEqual(2000);
  });

  it("does not mutate priorTurns", () => {
    const prior = [{ role: "user", content: "old" }];
    const frozenLen = prior.length;
    buildTurnHistory({
      priorTurns: prior,
      prompt: "new",
      assistantContent: "a",
    });
    expect(prior.length).toBe(frozenLen);
  });
});
