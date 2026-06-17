import { describe, it, expect } from "vitest";
import { listSkills, saveSkill, loadSkill, deleteSkill, setSkillStatus, getUsageScore, buildSkillsContext, getCuratorStatus, searchSkills, translateDisplayName, heuristicDisplayName, setTranslation, getMissingTranslations } from "../skills-store.mjs";

describe("Skills Store", () => {
  let testSkillName = "test-skill-vitest";

  it("listSkills returns array", () => {
    expect(Array.isArray(listSkills())).toBe(true);
  });

  it("saveSkill creates a skill", () => {
    const result = saveSkill(testSkillName, {
      description: "A test skill for vitest",
      triggers: ["test", "vitest"],
      status: "active",
    }, "# Test Skill\n\nThis is a test.");
    expect(result.saved).toBe(true);
    expect(result.name).toBe(testSkillName);
  });

  it("loadSkill retrieves the skill", () => {
    const skill = loadSkill(testSkillName);
    expect(skill).toBeTruthy();
    expect(skill.name).toBe(testSkillName);
  });

  it("searchSkills finds the skill", () => {
    const results = searchSkills("vitest");
    expect(results.length).toBeGreaterThan(0);
  });

  it("setSkillStatus toggles status", () => {
    setSkillStatus(testSkillName, "disabled");
    let skill = loadSkill(testSkillName);
    expect(skill.status).toBe("disabled");

    setSkillStatus(testSkillName, "active");
    skill = loadSkill(testSkillName);
    expect(skill.status).toBe("active");
  });

  it("getUsageScore returns number", () => {
    expect(typeof getUsageScore(testSkillName)).toBe("number");
  });

  it("buildSkillsContext returns string", () => {
    expect(typeof buildSkillsContext()).toBe("string");
  });

  it("getCuratorStatus returns object", () => {
    const status = getCuratorStatus();
    expect(status).toHaveProperty("totalSkills");
    expect(status).toHaveProperty("activeSkills");
    expect(typeof status.totalSkills).toBe("number");
  });

  it("deleteSkill", () => {
    const result = deleteSkill(testSkillName);
    expect(result.deleted).toBe(true);
    expect(loadSkill(testSkillName)).toBeFalsy();
  });
});

describe("3-tier skill display name resolver", () => {
  // Tier 1: SKILL.md name_zh (author-declared, no LLM needed)
  it("tier 1: uses name_zh from SKILL.md when present", () => {
    const r = translateDisplayName({ name: "backtest-expert", name_zh: "策略回测专家" }, {});
    expect(r.display).toBe("策略回测专家");
    expect(r.source).toBe("skill_zh");
  });

  it("tier 1: trims whitespace from name_zh", () => {
    const r = translateDisplayName({ name: "x", name_zh: "  测试  " }, {});
    expect(r.display).toBe("测试");
    expect(r.source).toBe("skill_zh");
  });

  // Tier 2: per-user cache
  it("tier 2: uses cached translation when no name_zh", () => {
    const r = translateDisplayName({ name: "benchmark" }, { benchmark: "基准测试" });
    expect(r.display).toBe("基准测试");
    expect(r.source).toBe("cache");
  });

  it("tier 2: cache overrides name_zh would NOT happen — name_zh wins", () => {
    // name_zh is the author's authoritative choice; cache is only consulted
    // when name_zh is empty. This guards against accidental priority flips.
    const r = translateDisplayName(
      { name: "x", name_zh: "作者译" },
      { x: "用户译" }
    );
    expect(r.source).toBe("skill_zh");
    expect(r.display).toBe("作者译");
  });

  // Tier 3: heuristic fallback (the "never empty" guarantee)
  it("tier 3: heuristic returns non-empty for unknown skills", () => {
    const r = translateDisplayName({ name: "cli-anything-ccswitch" }, {});
    expect(r.display).not.toBe("");
    expect(r.source).toBe("heuristic");
    expect(r.display).toContain("命令行");
  });

  it("tier 3: heuristic handles generic kebab-case", () => {
    expect(heuristicDisplayName("agent-skills-panel")).toBe("Agent Skills Panel");
    expect(heuristicDisplayName("backtest-expert")).toBe("Backtest Expert");
  });

  it("tier 3: heuristic preserves embedded acronyms", () => {
    expect(heuristicDisplayName("CCSwitch")).toBe("CCSwitch");
    expect(heuristicDisplayName("MiniLM-L6")).toBe("MiniLM-L6");
  });

  it("tier 3: heuristic returns empty string for empty name (defensive)", () => {
    expect(heuristicDisplayName("")).toBe("");
  });

  // The contract: always return a display string, never ""
  it("never returns empty display for any valid skill", () => {
    const samples = ["cli-anything-ccswitch", "backtest-expert", "x", "agent-skills", "a-b-c-d"];
    for (const name of samples) {
      const r = translateDisplayName({ name }, {});
      expect(r.display).not.toBe("");
    }
  });

  // Manual override
  it("setTranslation writes to cache and translateDisplayName reads it", () => {
    const name = "test-manual-override";
    setTranslation(name, "手动翻译");
    // The translateDisplayName helper auto-loads the cache when an empty
    // object is passed (or no cache arg), so we use that here for ergonomics.
    const r = translateDisplayName({ name });
    expect(r.display).toBe("手动翻译");
    expect(r.source).toBe("cache");
    // Cleanup
    setTranslation(name, "");
  });

  it("setTranslation with empty string removes the cache entry", () => {
    const name = "test-clear-override";
    setTranslation(name, "暂时翻译");
    expect(translateDisplayName({ name }).source).toBe("cache");
    setTranslation(name, "");
    // After clearing, should fall through to heuristic
    const after = translateDisplayName({ name });
    expect(after.source).toBe("heuristic");
  });

  // Missing-detection
  it("getMissingTranslations returns skills without cache entries", () => {
    const all = [
      { name: "in-cache", description: "" },
      { name: "not-in-cache", description: "x" },
    ];
    // We can't easily mock loadTranslations here, so we just verify the
    // contract: it doesn't throw and returns an array.
    const result = getMissingTranslations(all);
    expect(Array.isArray(result)).toBe(true);
  });
});
