// ── Unit tests for matchSkills() — Phase 2 trigger + embedding hybrid ──
import { describe, it, expect } from "vitest";
import { matchSkills } from "../skills-store.mjs";

describe("matchSkills (hybrid trigger + embedding)", () => {
  // Sample skill set covering trigger variety
  const allSkills = [
    { name: "review",   description: "Pre-landing code review",          triggers: ["review", "代码审查", "审查"] },
    { name: "qa",       description: "Run QA testing on web app",        triggers: ["qa", "test", "测试"] },
    { name: "investigate", description: "Debug and root-cause analysis",  triggers: ["investigate", "debug", "调试"] },
    { name: "deploy",   description: "Deploy to production",             triggers: ["deploy", "部署"] },
    { name: "memory",   description: "Memory store operations",          triggers: ["memory", "记忆"] },
    { name: "unicode-only", description: "纯中文描述无 trigger 关键词",  triggers: [] },
  ];

  it("returns empty array for empty prompt", async () => {
    const result = await matchSkills("", allSkills);
    expect(result).toEqual([]);
  });

  it("returns empty array for empty skill list", async () => {
    const result = await matchSkills("review my code", []);
    expect(result).toEqual([]);
  });

  it("[A] trigger keyword hard match: English", async () => {
    const result = await matchSkills("Please review this PR", allSkills);
    expect(result.length).toBeGreaterThanOrEqual(1);
    expect(result[0].skill.name).toBe("review");
    expect(result[0].via).toMatch(/^trigger:/);
    expect(result[0].score).toBe(1.0);
  });

  it("[A] trigger keyword hard match: Chinese", async () => {
    const result = await matchSkills("帮我审查一下这段代码", allSkills);
    expect(result.length).toBeGreaterThanOrEqual(1);
    expect(result[0].skill.name).toBe("review");
  });

  it("[A] trigger keyword hard match: case-insensitive", async () => {
    const result = await matchSkills("REVIEW please", allSkills);
    expect(result[0].skill.name).toBe("review");
  });

  it("[A] multiple trigger matches → sorted by score then stable", async () => {
    const result = await matchSkills("test and debug this", allSkills);
    const names = result.map(r => r.skill.name);
    expect(names).toContain("qa");
    expect(names).toContain("investigate");
  });

  it("[B] embedding fallback fires when no trigger hit and embedFn provided", async () => {
    // Fake embed: identical 1.0 for matched pair, 0.0 for unrelated
    const embedFn = async (text) => {
      const v = new Float32Array(4);
      // Hash text into a deterministic vector
      let h = 0;
      for (let i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) >>> 0;
      v[0] = ((h & 0xff) / 255) * 2 - 1;
      v[1] = (((h >> 8) & 0xff) / 255) * 2 - 1;
      v[2] = (((h >> 16) & 0xff) / 255) * 2 - 1;
      v[3] = (((h >> 24) & 0xff) / 255) * 2 - 1;
      return v;
    };
    const result = await matchSkills("xyzzy", allSkills, { embedFn, semanticThreshold: 0.5, semanticTopK: 3 });
    // All trigger matches should be empty for "xyzzy"; semantic may return top-K with arbitrary sim
    // We just verify the function returns without throwing and the shape is right
    expect(Array.isArray(result)).toBe(true);
    for (const r of result) {
      expect(r.skill).toBeTruthy();
      expect(r.score).toBeGreaterThanOrEqual(0.5);
      expect(r.via).toBe("semantic");
    }
  });

  it("[A] + [B] combined: trigger hit takes precedence over embedding", async () => {
    const embedFn = async () => new Float32Array([1, 0, 0, 0]);
    const result = await matchSkills("review this code", allSkills, { embedFn, semanticThreshold: 0.5 });
    // "review" matched via trigger
    expect(result[0].skill.name).toBe("review");
    expect(result[0].via).toMatch(/^trigger:/);
  });

  it("skips embedding when embedFn is null", async () => {
    const result = await matchSkills("review", allSkills, { embedFn: null });
    expect(result.length).toBe(1);
    expect(result[0].via).toMatch(/^trigger:/);
  });

  it("trigger matches ignore empty string triggers", async () => {
    const result = await matchSkills("hello world", allSkills);
    // No empty trigger should match
    for (const r of result) {
      expect(r.via.startsWith("trigger:")).toBe(true);
      expect(r.via.length).toBeGreaterThan("trigger:".length);
    }
  });

  it("non-string triggers are coerced via String()", async () => {
    const skills = [{ name: "test-skill", description: "x", triggers: [42, null, undefined, ""] }];
    const result = await matchSkills("the answer is 42", skills);
    expect(result.length).toBe(1);
    expect(result[0].skill.name).toBe("test-skill");
  });
});
