import { describe, it, expect } from "vitest";
import { listSkills, saveSkill, loadSkill, deleteSkill, setSkillStatus, getUsageScore, buildSkillsContext, getCuratorStatus, searchSkills } from "../skills-store.mjs";

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
