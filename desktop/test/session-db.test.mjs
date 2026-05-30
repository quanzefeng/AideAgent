import { describe, it, expect, afterAll } from "vitest";
import sessionDb from "../session-db.mjs";

describe("Session DB", () => {
  let createdId;
  const beforeCount = sessionDb.listSessions(1000).length;

  it("create session", () => {
    const s = sessionDb.createSession("技术讨论");
    expect(s.id).toBeTruthy();
    createdId = s.id;
  });

  it("save and load session", () => {
    sessionDb.saveSession(createdId, [
      { role: "user", content: "Python和Go有什么区别？" },
      { role: "assistant", content: "Python是解释型语言，Go是编译型语言。" },
      { role: "user", content: "那性能方面呢？" },
      { role: "assistant", content: "Go的性能接近C，Python慢很多但在IO密集型场景表现好。" },
    ], "Python vs Go");

    const loaded = sessionDb.loadSession(createdId);
    expect(loaded.history.length).toBe(4);
    expect(loaded.title).toBe("Python vs Go");
  });

  it("list sessions", () => {
    const list = sessionDb.listSessions(10);
    expect(list.length).toBeGreaterThanOrEqual(1);
  });

  it("search messages", () => {
    const r = sessionDb.searchMessages("Python", 10);
    expect(r.length).toBeGreaterThan(0);
    expect(r[0].snippet).toBeTruthy();
  });

  it("update title", () => {
    sessionDb.updateTitle(createdId, "Python vs Go 全面对比");
    const loaded = sessionDb.loadSession(createdId);
    expect(loaded.title).toContain("Go");
  });

  it("getLastSession", () => {
    const last = sessionDb.getLastSession(2);
    expect(last).toBeTruthy();
    expect(last.messages.length).toBeLessThanOrEqual(2);
    expect(last.messages.length).toBeGreaterThan(0);
  });

  it("getStatus", () => {
    const st = sessionDb.getStatus();
    expect(st.sessionCount).toBeGreaterThanOrEqual(1);
    expect(st.messageCount).toBeGreaterThan(0);
  });

  it("delete session", () => {
    sessionDb.deleteSession(createdId);
    const afterCount = sessionDb.listSessions(1000).length;
    expect(afterCount).toBe(beforeCount);
  });

  afterAll(() => {
    sessionDb.close();
  });
});
