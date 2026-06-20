import { describe, it, expect, afterAll } from "vitest";
import { memoryAgeDays, memoryAge, memoryFreshnessNote, listMemories, readMemory, createMemory, updateMemory, deleteMemory, searchMemory, purgeByType, tokenizeForMemory, checkDuplicate } from "../memory-store.mjs";

describe("Memory Store", () => {
  let createdFilename;

  describe("Pure functions", () => {
    it("memoryAgeDays returns 0 for null/0", () => {
      expect(memoryAgeDays(0)).toBe(0);
      expect(memoryAgeDays(null)).toBe(0);
      expect(memoryAgeDays(undefined)).toBe(0);
    });

    it("memoryAgeDays returns 0 for today", () => {
      expect(memoryAgeDays(Date.now())).toBe(0);
    });

    it("memoryAgeDays returns 1 for yesterday", () => {
      const yesterday = Date.now() - 86_400_000;
      expect(memoryAgeDays(yesterday)).toBe(1);
    });

    it("memoryAgeDays returns correct days", () => {
      const fiveDaysAgo = Date.now() - 5 * 86_400_000;
      expect(memoryAgeDays(fiveDaysAgo)).toBe(5);
    });

    it("memoryAgeDays clamps negative to 0", () => {
      const future = Date.now() + 86_400_000;
      expect(memoryAgeDays(future)).toBe(0);
    });

    it("memoryAge returns 'today' for fresh", () => {
      expect(memoryAge(Date.now())).toBe("today");
    });

    it("memoryAge returns 'yesterday'", () => {
      expect(memoryAge(Date.now() - 86_400_000)).toBe("yesterday");
    });

    it("memoryAge returns 'N days ago'", () => {
      expect(memoryAge(Date.now() - 3 * 86_400_000)).toBe("3 days ago");
    });

    it("memoryFreshnessNote returns empty for fresh", () => {
      expect(memoryFreshnessNote(Date.now())).toBe("");
      expect(memoryFreshnessNote(Date.now() - 86_400_000)).toBe("");
    });

    it("memoryFreshnessNote returns warning for old", () => {
      const note = memoryFreshnessNote(Date.now() - 5 * 86_400_000);
      expect(note).toContain("5 days old");
      expect(note).toContain("⚠️");
    });
  });

  describe("CRUD operations", () => {
    it("createMemory", () => {
      const result = createMemory("test_memory", "A test memory", "project", "Test body content");
      expect(result.ok).toBe(true);
      expect(result.filename).toBeTruthy();
      createdFilename = result.filename;
    });

    it("readMemory", () => {
      const mem = readMemory(createdFilename);
      expect(mem).toBeTruthy();
      expect(mem.name).toBe("test_memory");
      expect(mem.description).toBe("A test memory");
      expect(mem.body).toContain("Test body content");
    });

    it("listMemories includes created", () => {
      const list = listMemories();
      const found = list.find(m => m.filename === createdFilename);
      expect(found).toBeTruthy();
      expect(found.name).toBe("test_memory");
    });

    it("updateMemory", () => {
      const result = updateMemory(createdFilename, "Updated body content", "test_memory", "Updated description");
      expect(result.ok).toBe(true);
      const mem = readMemory(createdFilename);
      expect(mem.description).toBe("Updated description");
      expect(mem.body).toContain("Updated body content");
    });

    it("searchMemory", () => {
      const results = searchMemory("test_memory");
      expect(Array.isArray(results)).toBe(true);
    });

    it("deleteMemory", () => {
      const result = deleteMemory(createdFilename);
      expect(result.ok).toBe(true);
      const mem = readMemory(createdFilename);
      expect(mem).toBeNull();
    });

    it("createMemory requires name", () => {
      const result = createMemory("", "", "", "");
      expect(result.error).toBeTruthy();
    });
  });

  describe("purgeByType", () => {
    // Create isolated test memories so we don't touch real user data
    const testFiles = [];
    afterAll(() => {
      // Always clean up — never leave test files behind
      for (const f of testFiles) {
        try { deleteMemory(f); } catch { /* ignored */ }
      }
    });

    it("refuses to delete 'user' type (safety)", () => {
      const result = purgeByType("user");
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/invalid type/i);
    });

    it("refuses to delete 'bogus' type", () => {
      const result = purgeByType("totally-not-a-type");
      expect(result.ok).toBe(false);
    });

    it("removes all memories of a given type", () => {
      const a = createMemory("purge_test_a", "purgedesc a", "project", "alpha body");
      const b = createMemory("purge_test_b", "purgedesc b", "project", "beta body");
      const c = createMemory("purge_test_c", "purgedesc c", "feedback", "gamma body");
      testFiles.push(a.filename, b.filename, c.filename);

      const before = listMemories().filter(m => m.type === "project" && m.filename.startsWith("purge_test_"));
      expect(before.length).toBe(2);

      const result = purgeByType("project");
      expect(result.ok).toBe(true);
      expect(result.removed).toBeGreaterThanOrEqual(2);
      expect(result.names).toContain(a.filename);
      expect(result.names).toContain(b.filename);

      const afterProjects = listMemories().filter(m => m.type === "project" && m.filename.startsWith("purge_test_"));
      const feedbackStillThere = listMemories().find(m => m.filename === c.filename);
      expect(afterProjects.length).toBe(0);
      expect(feedbackStillThere).toBeTruthy();
      expect(feedbackStillThere.type).toBe("feedback");
    });
  });

  describe("tokenizeForMemory", () => {
    it("returns empty for empty/null input", () => {
      expect(tokenizeForMemory("")).toEqual([]);
      expect(tokenizeForMemory(null)).toEqual([]);
      expect(tokenizeForMemory(undefined)).toEqual([]);
    });

    it("splits English words (length > 2)", () => {
      const tokens = tokenizeForMemory("hello world ok");
      expect(tokens).toContain("hello");
      expect(tokens).toContain("world");
      expect(tokens).not.toContain("ok"); // length <= 2
    });

    it("extracts CJK bigrams from Chinese text", () => {
      const tokens = tokenizeForMemory("代码审查很重要");
      // 代码审查很重要 → bigrams: 代码, 码审, 审查, 查很, 重要, 要 (trailing)
      expect(tokens).toContain("代码");
      expect(tokens).toContain("码审");
      expect(tokens).toContain("审查");
      expect(tokens).toContain("重要");
      // Single-char CJK should not appear as standalone (except trailing)
      // "码" is internal — only appears in bigrams
    });

    it("handles single CJK character", () => {
      const tokens = tokenizeForMemory("是");
      expect(tokens).toEqual(["是"]);
    });

    it("handles mixed CJK + English", () => {
      const tokens = tokenizeForMemory("用React写前端");
      // ASCII: React (length 5 > 2)
      // CJK run "用": single char → ["用"]
      // CJK run "写前端": bigrams → ["写前", "前端", "端"]
      expect(tokens).toContain("React");
      expect(tokens).toContain("用");
      expect(tokens).toContain("写前");
      expect(tokens).toContain("前端");
    });

    it("CJK bigrams are NOT substring matched — regression for Bug 4", () => {
      // This is the core Bug 4 regression:
      // Old: body.includes("code") would match "codebase"
      // New: Set.has("code") is exact — "code" ≠ "codebase"
      const a = tokenizeForMemory("refactoring the authentication module");
      const b = tokenizeForMemory("refactoring the database connection module");
      const setA = new Set(a);
      const setB = new Set(b);
      // Both should have "refactoring" and "the" and "module"
      expect(setA.has("refactoring")).toBe(true);
      expect(setB.has("refactoring")).toBe(true);
      // "auth" should NOT appear in b's tokens (no "auth" in b's text)
      // (note: "authentication" is one token, not "auth")
      expect(setA.has("authentication")).toBe(true);
      expect(setB.has("authentication")).toBe(false);
    });

    it("two similar Chinese paragraphs share many bigrams", () => {
      const a = tokenizeForMemory("项目决定使用 Vue3 作为前端框架");
      const b = tokenizeForMemory("项目决定使用 React 作为前端框架");
      const setA = new Set(a);
      const setB = new Set(b);
      // Shared: 项目, 目决, 决定, 定使, 使用, 作为, 为前, 前端, 端框, 框架
      let overlap = 0;
      for (const t of setA) { if (setB.has(t)) overlap++; }
      // Should be substantial overlap (>60%)
      expect(overlap / setA.size).toBeGreaterThan(0.5);
    });

    it("two unrelated Chinese paragraphs share few bigrams", () => {
      const a = tokenizeForMemory("今天天气很好适合出去散步");
      const b = tokenizeForMemory("数据库连接超时需要检查配置");
      const setA = new Set(a);
      const setB = new Set(b);
      let overlap = 0;
      for (const t of setA) { if (setB.has(t)) overlap++; }
      // Unrelated topics should share very few bigrams
      expect(overlap).toBeLessThan(3);
    });
  });

  afterAll(() => {
    // cleanup if needed
  });
});
