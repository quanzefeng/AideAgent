import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, rmSync, readdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import {
  listPrompts,
  readPrompt,
  createPrompt,
  updatePrompt,
  deletePrompt,
  MAX_BODY_BYTES,
  MAX_TITLE_LENGTH,
  getPromptsDir,
} from "../prompts-store.mjs";

// ── Test isolation strategy ─────────────────────────────────
//
// prompts-store writes to the user's real ~/.aideagent/prompts/ directory.
// To avoid polluting user data, every test in this suite uses `TEST_PREFIX`
// in the title and cleans up everything matching that prefix in afterEach.
// This is the same pattern used by memory-store.test.mjs.
const TEST_PREFIX = "vitest_prompt_";

const REAL_DIR = getPromptsDir();

/** Helper: list every test prompt we created (by title prefix). */
function listTestPrompts() {
  return listPrompts().filter((p) => p.title && p.title.startsWith(TEST_PREFIX));
}

/** Helper: delete all test prompts. Called from afterEach AND before each test. */
function cleanupTestPrompts() {
  for (const p of listTestPrompts()) {
    try { deletePrompt(p.id); } catch { /* ignored */ }
  }
}

describe("Prompts Store", () => {
  beforeEach(() => {
    cleanupTestPrompts();
  });

  afterEach(() => {
    cleanupTestPrompts();
  });

  describe("constants", () => {
    it("MAX_BODY_BYTES is 16 KB", () => {
      expect(MAX_BODY_BYTES).toBe(16 * 1024);
    });

    it("MAX_TITLE_LENGTH is 100", () => {
      expect(MAX_TITLE_LENGTH).toBe(100);
    });

    it("getPromptsDir returns a valid path", () => {
      const dir = getPromptsDir();
      expect(typeof dir).toBe("string");
      expect(dir.length).toBeGreaterThan(0);
      expect(existsSync(dir)).toBe(true);
    });
  });

  describe("createPrompt", () => {
    it("creates a prompt and returns id + filename", () => {
      const result = createPrompt({
        title: TEST_PREFIX + "create_basic",
        body: "Hello world",
      });
      expect(result.ok).toBe(true);
      expect(result.id).toBeTruthy();
      expect(result.filename).toBe(result.id + ".md");
      expect(result.title).toBe(TEST_PREFIX + "create_basic");
    });

    it("trims the title", () => {
      const result = createPrompt({
        title: "  " + TEST_PREFIX + "trimmed  ",
        body: "body",
      });
      expect(result.ok).toBe(true);
      expect(result.title).toBe(TEST_PREFIX + "trimmed");
    });

    it("refuses empty title", () => {
      const result = createPrompt({ title: "", body: "body" });
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/title/i);
    });

    it("refuses whitespace-only title", () => {
      const result = createPrompt({ title: "   ", body: "body" });
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/title/i);
    });

    it("refuses empty body", () => {
      const result = createPrompt({ title: TEST_PREFIX + "x", body: "" });
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/body/i);
    });

    it("refuses body over MAX_BODY_BYTES", () => {
      const tooBig = "x".repeat(MAX_BODY_BYTES + 1);
      const result = createPrompt({ title: TEST_PREFIX + "huge", body: tooBig });
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/too large/i);
    });

    it("accepts body at exactly MAX_BODY_BYTES", () => {
      const justRight = "x".repeat(MAX_BODY_BYTES);
      const result = createPrompt({ title: TEST_PREFIX + "exact", body: justRight });
      expect(result.ok).toBe(true);
    });

    it("refuses title over MAX_TITLE_LENGTH", () => {
      const longTitle = "a".repeat(MAX_TITLE_LENGTH + 1);
      const result = createPrompt({ title: longTitle, body: "body" });
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/too long/i);
    });

    it("quotes title with special chars in YAML", () => {
      const result = createPrompt({
        title: TEST_PREFIX + 'has "quotes" and: colons',
        body: "body",
      });
      expect(result.ok).toBe(true);
      // Re-read to confirm YAML round-trips the title safely
      const read = readPrompt(result.id);
      expect(read.title).toBe(TEST_PREFIX + 'has "quotes" and: colons');
    });

    it("preserves Chinese / non-ASCII title", () => {
      const result = createPrompt({
        title: TEST_PREFIX + "写日报",
        body: "body",
      });
      expect(result.ok).toBe(true);
      const read = readPrompt(result.id);
      expect(read.title).toBe(TEST_PREFIX + "写日报");
    });
  });

  describe("readPrompt", () => {
    it("returns null for non-existent id", () => {
      expect(readPrompt("00000000-0000-0000-0000-000000000000")).toBeNull();
    });

    it("returns the full prompt object for an existing id", () => {
      const created = createPrompt({
        title: TEST_PREFIX + "read_basic",
        body: "read body content",
      });
      const read = readPrompt(created.id);
      expect(read).toBeTruthy();
      expect(read.id).toBe(created.id);
      expect(read.title).toBe(TEST_PREFIX + "read_basic");
      expect(read.body).toBe("read body content");
      expect(read.created).toBeTruthy();
      expect(read.updated).toBeTruthy();
      expect(read.filename).toBe(created.id + ".md");
    });

    it("accepts id with or without .md suffix", () => {
      const created = createPrompt({
        title: TEST_PREFIX + "suffix_test",
        body: "body",
      });
      expect(readPrompt(created.id)).toBeTruthy();
      expect(readPrompt(created.id + ".md")).toBeTruthy();
    });
  });

  describe("listPrompts", () => {
    it("returns an array", () => {
      expect(Array.isArray(listPrompts())).toBe(true);
    });

    it("includes newly created prompts", () => {
      const a = createPrompt({ title: TEST_PREFIX + "list_a", body: "a" });
      const b = createPrompt({ title: TEST_PREFIX + "list_b", body: "b" });
      const list = listPrompts();
      const ids = list.map((p) => p.id);
      expect(ids).toContain(a.id);
      expect(ids).toContain(b.id);
    });

    it("sorts newest-first by mtime", async () => {
      const first = createPrompt({ title: TEST_PREFIX + "old", body: "1" });
      // Small delay so mtime differs deterministically
      await new Promise((r) => setTimeout(r, 50));
      const second = createPrompt({ title: TEST_PREFIX + "new", body: "2" });
      const list = listPrompts().filter((p) => p.title.startsWith(TEST_PREFIX));
      expect(list.length).toBe(2);
      expect(list[0].id).toBe(second.id);
      expect(list[1].id).toBe(first.id);
    });
  });

  describe("updatePrompt", () => {
    it("updates body only", () => {
      const created = createPrompt({ title: TEST_PREFIX + "upd_body", body: "old body" });
      const result = updatePrompt(created.id, { body: "new body" });
      expect(result.ok).toBe(true);
      const read = readPrompt(created.id);
      expect(read.body).toBe("new body");
      expect(read.title).toBe(TEST_PREFIX + "upd_body");
    });

    it("updates title only", () => {
      const created = createPrompt({ title: TEST_PREFIX + "upd_title_old", body: "body" });
      const result = updatePrompt(created.id, { title: TEST_PREFIX + "upd_title_new" });
      expect(result.ok).toBe(true);
      const read = readPrompt(created.id);
      expect(read.title).toBe(TEST_PREFIX + "upd_title_new");
      expect(read.body).toBe("body");
    });

    it("updates both title and body", () => {
      const created = createPrompt({ title: TEST_PREFIX + "upd_both_old", body: "old" });
      const result = updatePrompt(created.id, {
        title: TEST_PREFIX + "upd_both_new",
        body: "new",
      });
      expect(result.ok).toBe(true);
      const read = readPrompt(created.id);
      expect(read.title).toBe(TEST_PREFIX + "upd_both_new");
      expect(read.body).toBe("new");
    });

    it("bumps updated timestamp", async () => {
      const created = createPrompt({ title: TEST_PREFIX + "upd_time", body: "v1" });
      const before = readPrompt(created.id);
      await new Promise((r) => setTimeout(r, 50));
      updatePrompt(created.id, { body: "v2" });
      const after = readPrompt(created.id);
      expect(after.updated).not.toBe(before.updated);
    });

    it("preserves created timestamp", () => {
      const created = createPrompt({ title: TEST_PREFIX + "upd_created", body: "v1" });
      const before = readPrompt(created.id);
      updatePrompt(created.id, { body: "v2" });
      const after = readPrompt(created.id);
      expect(after.created).toBe(before.created);
    });

    it("returns error for non-existent id", () => {
      const result = updatePrompt("00000000-0000-0000-0000-000000000000", { body: "x" });
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/not found/i);
    });

    it("returns error when result would be empty body", () => {
      const created = createPrompt({ title: TEST_PREFIX + "upd_empty", body: "v1" });
      const result = updatePrompt(created.id, { body: "" });
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/body/i);
    });
  });

  describe("deletePrompt", () => {
    it("deletes an existing prompt", () => {
      const created = createPrompt({ title: TEST_PREFIX + "del_ok", body: "body" });
      const result = deletePrompt(created.id);
      expect(result.ok).toBe(true);
      expect(readPrompt(created.id)).toBeNull();
    });

    it("returns error for non-existent id", () => {
      const result = deletePrompt("00000000-0000-0000-0000-000000000000");
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/not found/i);
    });

    it("accepts id with .md suffix", () => {
      const created = createPrompt({ title: TEST_PREFIX + "del_suffix", body: "body" });
      const result = deletePrompt(created.id + ".md");
      expect(result.ok).toBe(true);
      expect(readPrompt(created.id)).toBeNull();
    });
  });
});