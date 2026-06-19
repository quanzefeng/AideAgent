/**
 * Regression tests for P3方案 3(b) and 3(c) — memory selection hardening.
 *
 * (b) Type hard constraint: user/feedback must always be in the selection
 *     when available, even if the LLM skips them.
 * (c) TTL on _surfacedMemories: memories surfaced in turn N can be selected
 *     again in turn N + 50+.
 *
 * We don't exercise the LLM call path — we test the post-LLM `enforceTypeCaps`
 * and `balanceByType` helpers indirectly via `selectRelevantMemories` with
 * `candidates.length <= 8` (fast path) and a fake LLM (mocked fetch).
 *
 * NOTE: selectRelevantMemories imports from `core/state.mjs` which uses
 * `_currentTurn` and `_surfacedMemories`. We reset both between tests so
 * the order in this file doesn't affect outcomes.
 */

import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";

// We need to mock fetch BEFORE importing memory-selection.mjs, because
// selectRelevantMemories calls fetch() during the slow path.
const mockFetch = vi.fn();
globalThis.fetch = mockFetch;

import {
  markSurfaced, isSurfaced, pruneSurfacedMemories, getCurrentTurn,
  bumpTurnCounter, resetSurfacedMemories, resetTurnCounter,
  getSurfacedMemoriesSnapshot,
} from "../core/state.mjs";
import { selectRelevantMemories } from "../core/memory-selection.mjs";
import * as memory from "../memory-store.mjs";

// Mock listMemories so we can control the candidate pool without polluting
// the user's real memory store (which has 30+ project memories on disk).
// Tests below provide their own candidates via mockReturnValueOnce.
const listMemoriesSpy = vi.spyOn(memory, "listMemories");

describe("Memory Selection (P3方案3b/3c)", () => {
  // Seed a known set of memories for each test
  let seedFiles = [];

  beforeEach(() => {
    // Reset surfaced-state to avoid cross-test pollution
    resetSurfacedMemories();
    resetTurnCounter();
    mockFetch.mockReset();
    listMemoriesSpy.mockReset();
  });

  afterAll(() => {
    listMemoriesSpy.mockRestore();
  });

  describe("3(b) Type hard constraint — balanceByType / fast path", () => {
    it("≤8 candidates: returns all (no LLM)", async () => {
      // Mock listMemories to return a small fixed candidate set so the
      // fast path (≤8 candidates) is taken regardless of disk state.
      listMemoriesSpy.mockReturnValueOnce([
        { filename: "p1.md", name: "sel_test_p1", type: "project", body: "alpha", description: "p", mtimeMs: Date.now() },
        { filename: "p2.md", name: "sel_test_p2", type: "project", body: "beta", description: "p", mtimeMs: Date.now() },
        { filename: "u1.md", name: "sel_test_u1", type: "user", body: "user body", description: "u", mtimeMs: Date.now() },
      ]);

      const out = await selectRelevantMemories("any query", "fake-key", "https://example.com/v1", "deepseek-chat", "openai");
      expect(out).toContain("[user] sel_test_u1");
      expect(out).toContain("[project] sel_test_p1");
      expect(mockFetch).not.toHaveBeenCalled();
    });
  });

  describe("3(b) Type hard constraint — enforceTypeCaps / slow path", () => {
    it(">8 candidates with LLM skipping user/feedback: enforceTypeCaps adds them back", async () => {
      // Build 11 candidates: 1 user, 2 feedback, 8 project
      const now = Date.now();
      const candidates = [
        { filename: "sel_b_user.md", name: "sel_b_user", type: "user", body: "I am a software engineer", description: "u", mtimeMs: now },
        { filename: "sel_b_fb1.md", name: "sel_b_fb1", type: "feedback", body: "don't use ts-ignore", description: "f", mtimeMs: now },
        { filename: "sel_b_fb2.md", name: "sel_b_fb2", type: "feedback", body: "verify with real web tools", description: "f", mtimeMs: now },
        ...Array.from({ length: 8 }, (_, i) => ({
          filename: `sel_b_p${i}.md`, name: `sel_b_p${i}`, type: "project",
          body: `project memory ${i} body`, description: `p${i}`, mtimeMs: now,
        })),
      ];
      listMemoriesSpy.mockReturnValueOnce(candidates);

      // Mock LLM to return ONLY 8 project memories (skip user/feedback)
      const llmPickedFiles = Array.from({ length: 8 }, (_, i) => `sel_b_p${i}.md`);
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          choices: [{ message: { content: JSON.stringify({ selected_memories: llmPickedFiles }) } }],
        }),
      });

      const out = await selectRelevantMemories("any query", "fake-key", "https://example.com/v1", "deepseek-chat", "openai");

      // After enforceTypeCaps, the user memory MUST be in the output
      expect(out).toContain("[user] sel_b_user");
      // Feedback MUST be present (at least 1, cap is 2)
      expect(out).toContain("[feedback] sel_b_fb");
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it(">8 candidates with LLM picking user/feedback correctly: no override needed", async () => {
      const now = Date.now();
      const candidates = [
        { filename: "sel_ok_user.md", name: "sel_ok_user", type: "user", body: "user body", description: "u", mtimeMs: now },
        { filename: "sel_ok_fb1.md", name: "sel_ok_fb1", type: "feedback", body: "fb body 1", description: "f", mtimeMs: now },
        { filename: "sel_ok_fb2.md", name: "sel_ok_fb2", type: "feedback", body: "fb body 2", description: "f", mtimeMs: now },
        ...Array.from({ length: 8 }, (_, i) => ({
          filename: `sel_ok_p${i}.md`, name: `sel_ok_p${i}`, type: "project",
          body: `p body ${i}`, description: `p${i}`, mtimeMs: now,
        })),
      ];
      listMemoriesSpy.mockReturnValueOnce(candidates);

      // Mock LLM to return the right mix already
      const llmPicked = [
        "sel_ok_user.md", "sel_ok_fb1.md", "sel_ok_fb2.md",
        "sel_ok_p0.md", "sel_ok_p1.md", "sel_ok_p2.md", "sel_ok_p3.md", "sel_ok_p4.md",
      ];
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          choices: [{ message: { content: JSON.stringify({ selected_memories: llmPicked }) } }],
        }),
      });

      const out = await selectRelevantMemories("query", "k", "https://example.com/v1", "deepseek-chat", "openai");
      expect(out).toContain("[user] sel_ok_user");
      expect(out).toContain("[feedback] sel_ok_fb1");
      expect(out).toContain("[feedback] sel_ok_fb2");
    });
  });

  describe("3(c) TTL on _surfacedMemories", () => {
    it("markSurfaced + isSurfaced round-trip", () => {
      markSurfaced("foo.md");
      expect(isSurfaced("foo.md", getCurrentTurn())).toBe(true);
    });

    it("memory becomes 'fresh' again after TTL expires", () => {
      markSurfaced("foo.md");
      // jump turn counter forward beyond the TTL
      const TTL_PLUS_ONE = 51;
      for (let i = 0; i < TTL_PLUS_ONE; i++) bumpTurnCounter();
      expect(isSurfaced("foo.md", getCurrentTurn())).toBe(false);
    });

    it("pruneSurfacedMemories removes expired entries", () => {
      markSurfaced("keep_short.md");
      for (let i = 0; i < 100; i++) bumpTurnCounter();
      markSurfaced("keep_long.md");
      pruneSurfacedMemories(getCurrentTurn());
      // After prune, only "keep_long.md" should remain
      const snap = new Set(getSurfacedMemoriesSnapshot().map(x => x.filename));
      expect(snap.has("keep_long.md")).toBe(true);
      expect(snap.has("keep_short.md")).toBe(false);
    });

    it("resetSurfacedMemories clears everything (used by auto-compress)", () => {
      markSurfaced("a.md");
      markSurfaced("b.md");
      resetSurfacedMemories();
      expect(isSurfaced("a.md", getCurrentTurn())).toBe(false);
      expect(isSurfaced("b.md", getCurrentTurn())).toBe(false);
    });
  });
});