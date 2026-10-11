import { describe, it, expect, beforeEach } from "vitest";
import { buildTurnHistory } from "../core/agent-loop.ts";
import { setContextArchiveEnabled, readArchived } from "../core/context-archive.ts";
import sessionDb from "../session-db.ts";

// buildTurnHistory now archives oversized tool args/results before the DB
// truncation (audit fix H1). Keep every test that is not explicitly checking
// the archive away from the user's real DB.
beforeEach(() => setContextArchiveEnabled(false));

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

  it("truncates oversized tool args/result and marks the cut (irrecoverable when archive is off)", () => {
    setContextArchiveEnabled(false);
    const out = buildTurnHistory({
      priorTurns: [],
      prompt: "q",
      tools: [{ id: "t", name: "bash", args: { cmd: "x".repeat(2000) }, result: "y".repeat(5000) }],
      assistantContent: "a",
    });
    const tool = out[1];
    // Head of the original is preserved verbatim…
    expect(tool.content.slice(0, 2000)).toBe("y".repeat(5000).slice(0, 2000));
    // …the truncation marker is appended (head 2000 + ≤100 chars of note)…
    expect(tool.content.length).toBeGreaterThan(2000);
    expect(tool.content.length).toBeLessThanOrEqual(2100);
    expect(tool.tool_calls![0].function.arguments.length).toBeLessThanOrEqual(600);
    // archive disabled → the honest "不可恢复" fallback, never a fake pointer
    expect(tool.content).toContain("不可恢复");
  });

  it("archives the full oversized tool result before the DB truncation (reversible)", () => {
    setContextArchiveEnabled(true);
    let cleanupId: string | null = null;
    try {
      const full = "H1_MARKER_5c81 原始工具输出 " + "z".repeat(5000);
      const out = buildTurnHistory({
        priorTurns: [],
        prompt: "q",
        tools: [{ id: "t1", name: "bash", args: {}, result: full }],
        assistantContent: "a",
      });
      const tool = out[1];
      const m = (tool.content as string).match(/ca_[0-9a-f]{10}/);
      expect(m, "truncated content must carry a ca_* pointer").toBeTruthy();
      cleanupId = m![0];
      const row = readArchived(cleanupId);
      expect(row).toBeTruthy();
      expect(row.content).toBe(full); // byte-identical original, recoverable
      expect(row.kind).toBe("tool_result");
      expect(row.source).toBe("saveSession");
    } finally {
      // Hygiene: even on assertion failure, never leak a NULL-session archive
      // row into the user's real DB (NULL rows are readable from any session).
      if (cleanupId) sessionDb.deleteContext(cleanupId);
      setContextArchiveEnabled(false); // restore the beforeEach invariant
    }
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
