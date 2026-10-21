import { describe, it, expect, beforeEach } from "vitest";
import {
  createAgentSession,
  setActiveAgentSession,
  getActiveAgentSession,
  runInAgentSession,
} from "../core/agent-session.ts";
import {
  getHistory,
  setHistory,
  getTaskStore,
  setPlanMode,
  getPlanMode,
  getSessionId,
  setSessionId,
} from "../core/state.ts";

describe("state ↔ session isolation", () => {
  let a: ReturnType<typeof createAgentSession>;
  let b: ReturnType<typeof createAgentSession>;

  beforeEach(() => {
    a = createAgentSession({ id: "ses_state_a", workspace: "C:\\state-a" });
    b = createAgentSession({ id: "ses_state_b", workspace: "C:\\state-b" });
    setActiveAgentSession(a);
  });

  it("routes history and task state to the bound session, not the active one", () => {
    setHistory([{ role: "user", content: "desktop" }]);
    getTaskStore().set("desktop-task", { status: "pending" });

    runInAgentSession(b, () => {
      expect(getHistory()).toEqual([]);
      expect(getTaskStore().size).toBe(0);

      setHistory([{ role: "user", content: "wechat" }]);
      getTaskStore().set("wx-task", { status: "done" });
      expect(getSessionId()).toBe("ses_state_b");
    });

    expect(getHistory()).toEqual([{ role: "user", content: "desktop" }]);
    expect(getTaskStore().has("desktop-task")).toBe(true);
    expect(getTaskStore().has("wx-task")).toBe(false);
    expect(b.history).toEqual([{ role: "user", content: "wechat" }]);
    expect(b.taskStore.has("wx-task")).toBe(true);
  });

  it("keeps plan mode per session", () => {
    setPlanMode(true);
    runInAgentSession(b, () => {
      expect(getPlanMode()).toBe(false);
      setPlanMode(true);
    });
    expect(getPlanMode()).toBe(true);

    runInAgentSession(createAgentSession({ id: "ses_state_c" }), () => {
      expect(getPlanMode()).toBe(false);
    });
  });

  it("setSessionId inside a run binds the id to that session, not the active one", () => {
    const draft = createAgentSession({ workspace: "C:\\draft" });
    runInAgentSession(draft, () => setSessionId("ses_bound_inside"));
    expect(draft.id).toBe("ses_bound_inside");
    expect(getActiveAgentSession()).toBe(a);
  });
});
