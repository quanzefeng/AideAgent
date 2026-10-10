import { describe, it, expect } from "vitest";
import { promptRelevanceTerms, buildSystemPrompt } from "../core/system-prompt.ts";

describe("promptRelevanceTerms (Phase 3a session ranking)", () => {
  it("returns no terms for empty/whitespace input", () => {
    expect(promptRelevanceTerms("")).toEqual([]);
    expect(promptRelevanceTerms("   ")).toEqual([]);
  });

  it("extracts lowercase ascii words of length >= 2", () => {
    const terms = promptRelevanceTerms("Fix the Login_Bug in auth");
    expect(terms).toContain("fix");
    expect(terms).toContain("login_bug");
    expect(terms).toContain("auth");
    expect(terms).not.toContain("a"); // single chars are dropped
  });

  it("extracts CJK bigrams so Chinese prompts can match sessions", () => {
    const terms = promptRelevanceTerms("登录修复");
    expect(terms).toContain("登录");
    expect(terms).toContain("录修");
    expect(terms).toContain("修复");
  });

  it("is capped at 40 terms", () => {
    const terms = promptRelevanceTerms("abcdefghij klmnopqrst uvwxyz0123 ".repeat(10));
    expect(terms.length).toBeLessThanOrEqual(40);
    expect(terms.length).toBeGreaterThan(0);
  });
});

describe("buildSystemPrompt dynamic/static split (Phase 3)", () => {
  it("returns system prompt plus recombinable context blocks", async () => {
    const r = await buildSystemPrompt(
      [], "TestAgent", "登录 bug 怎么修", false, false, true, false, "deepseek-v4-flash",
    );
    expect(r.role).toBe("system");
    expect(r.content.length).toBeGreaterThan(500);
    // static + dynamic recombine into contextBlock by contract
    expect([r.dynamicContextBlock || "", r.staticContextBlock || ""].filter(Boolean).join("\n\n")).toBe(r.contextBlock || "");
    // the static half is the session-stable skill inventory
    expect(r.staticContextBlock).toContain("Available Skills");
  }, 30000);

  it("caps the 最近对话 section at 1,200 chars", async () => {
    const r = await buildSystemPrompt(
      [], "TestAgent", "这个问题和之前的登录修复有关系吗", false, false, true, false, "deepseek-v4-flash",
    );
    const m = (r.dynamicContextBlock || "").match(/\*\*最近对话：\*\*\n([\s\S]*?)(?=\n\n\*\*|$)/);
    if (m) expect(m[1].length).toBeLessThanOrEqual(1200);
  }, 30000);
});
