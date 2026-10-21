import { describe, it, expect, beforeEach } from "vitest";
import {
  createAgentSession,
  assignSessionId,
  getAgentSession,
  getOrCreateAgentSession,
  removeAgentSession,
  getActiveAgentSession,
  setActiveAgentSession,
  resetActiveAgentSession,
  activateAgentSession,
  currentAgentSession,
  runInAgentSession,
  clearAgentSession,
  recordUsage,
  genId,
} from "../core/agent-session.ts";

describe("agent-session", () => {
  beforeEach(() => {
    resetActiveAgentSession({ workspace: process.cwd() });
  });

  it("registers a session as soon as it gets an id", () => {
    const s = createAgentSession({ id: "ses_test_register" });
    expect(getAgentSession("ses_test_register")).toBe(s);

    assignSessionId(s, "ses_test_renamed");
    expect(getAgentSession("ses_test_register")).toBeUndefined();
    expect(getAgentSession("ses_test_renamed")).toBe(s);
    expect(s.id).toBe("ses_test_renamed");

    removeAgentSession("ses_test_renamed");
    expect(getAgentSession("ses_test_renamed")).toBeUndefined();
  });

  it("getOrCreate returns the registered object instead of overwriting it", () => {
    const first = createAgentSession({ id: "ses_test_getorcreate", title: "first" });
    const second = getOrCreateAgentSession("ses_test_getorcreate", { title: "second" });
    expect(second).toBe(first);
    expect(second.title).toBe("first");
  });

  it("scopes state to the ALS-bound session, across await boundaries", async () => {
    const a = createAgentSession({ id: "ses_als_a", workspace: "C:\\ws-a" });
    const b = createAgentSession({ id: "ses_als_b", workspace: "C:\\ws-b" });

    const seen = await runInAgentSession(a, async () => {
      const before = currentAgentSession();
      await new Promise(r => setTimeout(r, 5));
      const after = currentAgentSession();
      return { before, after };
    });
    expect(seen.before).toBe(a);
    expect(seen.after).toBe(a);

    const seenB = runInAgentSession(b, () => currentAgentSession());
    expect(seenB).toBe(b);
    expect(currentAgentSession()).not.toBe(a);
  });

  it("keeps two concurrent runs isolated", async () => {
    const a = createAgentSession({ id: "ses_concurrent_a", workspace: "C:\\ws-a" });
    const b = createAgentSession({ id: "ses_concurrent_b", workspace: "C:\\ws-b" });

    const run = (session: ReturnType<typeof createAgentSession>, delay: number) =>
      runInAgentSession(session, async () => {
        await new Promise(r => setTimeout(r, delay));
        return {
          id: currentAgentSession().id,
          workspace: currentAgentSession().workspace,
        };
      });

    const [ra, rb] = await Promise.all([run(a, 10), run(b, 2)]);
    expect(ra).toEqual({ id: "ses_concurrent_a", workspace: "C:\\ws-a" });
    expect(rb).toEqual({ id: "ses_concurrent_b", workspace: "C:\\ws-b" });
  });

  it("falls back to the active session outside a binding", () => {
    const active = getActiveAgentSession();
    expect(currentAgentSession()).toBe(active);

    const other = createAgentSession({ workspace: "C:\\other" });
    runInAgentSession(other, () => {
      expect(currentAgentSession()).toBe(other);
    });
    expect(currentAgentSession()).toBe(active);
  });

  it("activate reuses a registered session and retargets a draft otherwise", () => {
    const registered = createAgentSession({ id: "ses_test_activate", title: "loaded" });
    expect(activateAgentSession("ses_test_activate")).toBe(registered);
    expect(getActiveAgentSession()).toBe(registered);

    resetActiveAgentSession();
    const draft = getActiveAgentSession();
    expect(draft.id).toBeNull();
    const loadedNew = activateAgentSession("ses_test_new_loaded");
    expect(loadedNew).toBe(draft);
    expect(draft.id).toBe("ses_test_new_loaded");
    expect(getAgentSession("ses_test_new_loaded")).toBe(draft);
  });

  it("resetActiveAgentSession creates a fresh draft and preserves workspace", () => {
    const old = getActiveAgentSession();
    old.workspace = "C:\\keep-me";
    old.history.push({ role: "user", content: "old" });
    const fresh = resetActiveAgentSession();
    expect(fresh).not.toBe(old);
    expect(fresh.id).toBeNull();
    expect(fresh.workspace).toBe("C:\\keep-me");
    expect(fresh.history).toEqual([]);
  });

  it("clearAgentSession keeps identity, workspace and runtime but drops content", () => {
    const s = createAgentSession({
      id: "ses_test_clear",
      workspace: "C:\\keep",
      runtime: "opencode",
      history: [{ role: "user", content: "hi" }],
      planMode: true,
      turnCounter: 3,
    });
    s.todoList.push({ id: "1" });
    s.taskStore.set("t1", { status: "pending" });
    s.sysPromptCache = "cached";
    s.contextBlockBaseCache = "ctx";

    clearAgentSession(s);

    expect(s.id).toBe("ses_test_clear");
    expect(s.workspace).toBe("C:\\keep");
    expect(s.runtime).toBe("opencode");
    expect(s.planMode).toBe(true);
    expect(s.history).toEqual([]);
    expect(s.todoList).toEqual([]);
    expect(s.taskStore.size).toBe(0);
    expect(s.turnCounter).toBe(0);
    expect(s.sysPromptCache).toBeNull();
    expect(s.contextBlockBaseCache).toBeNull();
  });

  it("recordUsage accumulates token counts per session", () => {
    const a = createAgentSession({ id: "ses_usage_a" });
    const b = createAgentSession({ id: "ses_usage_b" });

    recordUsage(a, { promptTokens: 100, outputTokens: 20, cacheReadTokens: 50, cacheWriteTokens: 5 });
    recordUsage(a, { promptTokens: 200, outputTokens: 30 });

    expect(a.usage.requests).toBe(2);
    expect(a.usage.inputTokens).toBe(300);
    expect(a.usage.outputTokens).toBe(50);
    expect(a.usage.cacheReadTokens).toBe(50);
    expect(a.usage.cacheWriteTokens).toBe(5);
    expect(a.usage.lastPromptTokens).toBe(200);
    expect(a.usage.lastOutputTokens).toBe(30);
    expect(a.usage.lastRequestAt).not.toBeNull();

    expect(b.usage.requests).toBe(0);
    expect(b.usage.inputTokens).toBe(0);
  });

  it("genId produces unique ses_ ids", () => {
    const ids = new Set(Array.from({ length: 100 }, () => genId()));
    expect(ids.size).toBe(100);
    for (const id of ids) expect(id).toMatch(/^ses_/);
  });
});
