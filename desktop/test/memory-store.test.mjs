import { describe, it, expect, afterAll } from "vitest";
import { memoryAgeDays, memoryAge, memoryFreshnessNote, listMemories, readMemory, createMemory, updateMemory, deleteMemory, searchMemory } from "../memory-store.mjs";

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

  afterAll(() => {
    // cleanup if needed
  });
});
