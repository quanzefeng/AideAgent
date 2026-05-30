import { describe, it, expect } from "vitest";
import { genId, DANGEROUS, GIT_SAFE, GH_SAFE, PLAN_MODE_READONLY, SUB_AGENT_TOOL_NAMES, MAX_TURNS, CONTEXT_WINDOW } from "../core/state.mjs";

describe("State", () => {
  describe("genId", () => {
    it("generates a string starting with ses_", () => {
      const id = genId();
      expect(id).toMatch(/^ses_/);
    });

    it("generates unique IDs", () => {
      const ids = new Set();
      for (let i = 0; i < 100; i++) ids.add(genId());
      expect(ids.size).toBe(100);
    });
  });

  describe("DANGEROUS patterns", () => {
    it("matches dangerous commands", () => {
      expect(DANGEROUS.some(r => r.test("rm -rf /"))).toBe(true);
      expect(DANGEROUS.some(r => r.test("Remove-Item -Recurse C:\\temp"))).toBe(true);
      expect(DANGEROUS.some(r => r.test("del /f file.txt"))).toBe(true);
      expect(DANGEROUS.some(r => r.test("format c:"))).toBe(true);
      expect(DANGEROUS.some(r => r.test("diskpart"))).toBe(true);
    });

    it("does not match safe commands", () => {
      expect(DANGEROUS.some(r => r.test("ls -la"))).toBe(false);
      expect(DANGEROUS.some(r => r.test("cat file.txt"))).toBe(false);
    });
  });

  describe("GIT_SAFE pattern", () => {
    it("matches safe git commands", () => {
      expect(GIT_SAFE.test("git status")).toBe(true);
      expect(GIT_SAFE.test("git add .")).toBe(true);
      expect(GIT_SAFE.test("git commit -m msg")).toBe(true);
      expect(GIT_SAFE.test("git push origin main")).toBe(true);
      expect(GIT_SAFE.test("git log --oneline")).toBe(true);
    });

    it("does not match unknown git commands", () => {
      expect(GIT_SAFE.test("git rm -rf /")).toBe(false);
      expect(GIT_SAFE.test("git clean -fd")).toBe(false);
    });
  });

  describe("GH_SAFE pattern", () => {
    it("matches safe gh commands", () => {
      expect(GH_SAFE.test("gh pr list")).toBe(true);
      expect(GH_SAFE.test("gh issue create")).toBe(true);
      expect(GH_SAFE.test("gh repo clone x")).toBe(true);
    });

    it("does not match unknown gh commands", () => {
      expect(GH_SAFE.test("gh unknown")).toBe(false);
    });
  });

  describe("Constants", () => {
    it("MAX_TURNS is a positive number", () => {
      expect(MAX_TURNS).toBeGreaterThan(0);
    });

    it("CONTEXT_WINDOW is a positive number", () => {
      expect(CONTEXT_WINDOW).toBeGreaterThan(0);
    });

    it("PLAN_MODE_READONLY is a Set", () => {
      expect(PLAN_MODE_READONLY).toBeInstanceOf(Set);
      expect(PLAN_MODE_READONLY.has("file_read")).toBe(true);
      expect(PLAN_MODE_READONLY.has("grep")).toBe(true);
    });

    it("SUB_AGENT_TOOL_NAMES is a Set", () => {
      expect(SUB_AGENT_TOOL_NAMES).toBeInstanceOf(Set);
      expect(SUB_AGENT_TOOL_NAMES.has("bash")).toBe(true);
      expect(SUB_AGENT_TOOL_NAMES.has("file_read")).toBe(true);
    });
  });
});
