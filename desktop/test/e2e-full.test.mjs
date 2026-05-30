import { describe, it, expect, afterAll } from "vitest";
import sessionDb from "../session-db.mjs";
import * as memory from "../memory-store.mjs";
import * as skills from "../skills-store.mjs";

describe("Session DB E2E", () => {
  let sessionId;

  it("create session", () => {
    const s = sessionDb.createSession("E2E Test");
    expect(s.id).toBeTruthy();
    sessionId = s.id;
  });

  it("save session with history", () => {
    sessionDb.saveSession(sessionId, [
      { role: "user", content: "Hello world test" },
      { role: "assistant", content: "Hi there!" },
      { role: "user", content: "Can you search me?" },
    ], "Test Session");
    const loaded = sessionDb.loadSession(sessionId);
    expect(loaded.history.length).toBe(3);
  });

  it("list sessions", () => {
    expect(sessionDb.listSessions(10).length).toBeGreaterThanOrEqual(1);
  });

  it("search FTS5", () => {
    const r = sessionDb.searchMessages("search", 10);
    expect(r.length).toBeGreaterThan(0);
  });

  it("search CJK fallback (no crash)", () => {
    sessionDb.searchMessages("测试", 10);
  });

  it("update title", () => {
    sessionDb.updateTitle(sessionId, "Updated Title");
    expect(sessionDb.loadSession(sessionId).title).toBe("Updated Title");
  });

  it("getLastSession excludeId", () => {
    const s2 = sessionDb.createSession("A");
    sessionDb.saveSession(s2.id, [{ role: "user", content: "a" }], "A");
    const s3 = sessionDb.createSession("B");
    sessionDb.saveSession(s3.id, [{ role: "user", content: "b" }], "B");
    const last = sessionDb.getLastSession(2, s3.id);
    expect(last).toBeTruthy();
    expect(last.id).not.toBe(s3.id);
    sessionDb.deleteSession(s2.id);
    sessionDb.deleteSession(s3.id);
  });

  it("delete session", () => {
    sessionDb.deleteSession(sessionId);
    expect(sessionDb.loadSession(sessionId)).toBeNull();
  });

  afterAll(() => {
    sessionDb.close();
  });
});

describe("Memory Store E2E", () => {
  let origUser;

  it("read user memory", () => {
    origUser = memory.readUserMemory();
  });

  it("write user memory", () => {
    memory.writeUserMemory("## Test\n- Item 1\n- Item 2");
    expect(memory.readUserMemory()).toContain("Item 1");
  });

  it("append user memory", () => {
    memory.appendUserMemory("- Item 3");
    expect(memory.readUserMemory()).toContain("Item 3");
  });

  it("check duplicate detection", () => {
    expect(memory.checkDuplicate("user", "Test Item 1 Item 2")).toBe(true);
    expect(memory.checkDuplicate("user", "Completely different content here")).toBe(false);
  });

  afterAll(() => {
    if (origUser !== undefined) memory.writeUserMemory(origUser);
  });
});

describe("Skills Store E2E", () => {
  const beforeCount = skills.listSkills().length;

  it("list skills", () => {
    expect(skills.listSkills()).toBeInstanceOf(Array);
  });

  it("save and load skill", () => {
    skills.saveSkill("test-skill", {
      name: "test-skill", description: "A test skill", triggers: ["test"],
      version: "1.0.0", status: "active", created_at: new Date().toISOString(),
    }, "## Steps\n1. Do A\n2. Do B\n## Notes\n- Important");

    const list = skills.listSkills();
    expect(list.length).toBeGreaterThanOrEqual(1);
    const sk = skills.loadSkill("test-skill");
    expect(sk.body).toContain("Steps");
  });

  it("record usage", () => {
    skills.recordSkillUsage("test-skill", true);
    skills.recordSkillUsage("test-skill", true);
    const sk = skills.listSkills().find(s => s.name === "test-skill");
    expect(sk.usage_count).toBeGreaterThanOrEqual(2);
  });

  it("set status", () => {
    skills.setSkillStatus("test-skill", "archived");
    const sk = skills.listSkills().find(s => s.name === "test-skill");
    expect(sk.status).toBe("archived");
    skills.setSkillStatus("test-skill", "active");
  });

  it("health score", () => {
    const h = skills.getSkillHealth("test-skill");
    expect(h.totalScore).toBeGreaterThanOrEqual(0);
    expect(["healthy", "ok", "weak"]).toContain(h.status);
  });

  it("curator status", () => {
    const cs = skills.getCuratorStatus();
    expect(cs.totalSkills).toBeGreaterThanOrEqual(1);
  });

  it("run curator", () => {
    const r = skills.runCurator();
    expect(r).toHaveProperty("lastRun");
  });

  it("delete skill", () => {
    skills.deleteSkill("test-skill");
    const afterCount = skills.listSkills().length;
    expect(afterCount).toBe(beforeCount);
  });
});
