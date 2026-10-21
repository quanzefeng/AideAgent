import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { grepFiles } from "../core/fs-search.ts";

describe("fs-search", () => {
  let root = "";

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "aide-grep-"));
    await mkdir(join(root, "src"), { recursive: true });
    await mkdir(join(root, "node_modules", "pkg"), { recursive: true });
    await writeFile(join(root, "src", "a.ts"), "const needle = 1;\nnext line\n", "utf-8");
    await writeFile(join(root, "src", "b.js"), "// needle again\n", "utf-8");
    await writeFile(join(root, "node_modules", "pkg", "hidden.js"), "needle hidden\n", "utf-8");
    await writeFile(join(root, "README.md"), "Needle capital\n", "utf-8");
  });

  afterEach(async () => {
    // Windows may briefly keep directory handles after a killed rg process.
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  it("finds matches with path and line number", async () => {
    const res = await grepFiles({ pattern: "needle" }, root);
    expect(res.engine === "ripgrep" || res.engine === "native").toBe(true);
    expect(res.matches.some(m => m.includes("src/a.ts:1"))).toBe(true);
    expect(res.matches.some(m => m.includes("src/b.js:1"))).toBe(true);
    expect(res.matches.some(m => m.startsWith("src/a.ts:1: "))).toBe(true);
  });

  it("skips node_modules by default", async () => {
    const res = await grepFiles({ pattern: "needle" }, root);
    expect(res.matches.some(m => m.includes("node_modules"))).toBe(false);
  });

  it("filters files with include globs", async () => {
    const res = await grepFiles({ pattern: "needle", include: "*.ts", context: 0 }, root);
    expect(res.matches.length).toBeGreaterThan(0);
    expect(res.matches.every(m => m.includes(".ts:"))).toBe(true);
    expect(res.matches.some(m => m.includes("src/b.js"))).toBe(false);
  });

  it("is case-insensitive for lowercase patterns and case-sensitive when uppercase", async () => {
    const lower = await grepFiles({ pattern: "needle" }, root);
    expect(lower.matches.some(m => m.includes("README.md"))).toBe(true);

    const upper = await grepFiles({ pattern: "Needle" }, root);
    expect(upper.matches).toHaveLength(1);
    expect(upper.matches[0]).toContain("README.md");
  });

  it("adds context lines after a match", async () => {
    const res = await grepFiles({ pattern: "const needle", context: 1 }, root);
    expect(res.matches.some(m => m.includes("src/a.ts:1"))).toBe(true);
    expect(res.matches.some(m => m.trimStart().startsWith("| next line"))).toBe(true);
  });

  it("truncates at maxResults", async () => {
    await writeFile(join(root, "many.txt"), "hit\nhit\nhit\nhit\nhit\n", "utf-8");
    const res = await grepFiles({ pattern: "^hit$", maxResults: 2 }, root);
    expect(res.truncated).toBe(true);
    expect(res.matches.filter(m => m.includes("many.txt"))).toHaveLength(2);
  });

  it("searches a single file when path points at one", async () => {
    const res = await grepFiles({ pattern: "needle", path: "src/a.ts" }, root);
    expect(res.matches.some(m => m.includes("src/a.ts:1"))).toBe(true);
  });

  it("returns an empty result for a missing path", async () => {
    const res = await grepFiles({ pattern: "needle", path: "nope/" }, root);
    expect(res.matches).toEqual([]);
    expect(res.count).toBe(0);
  });

  it("rejects an empty pattern", async () => {
    await expect(grepFiles({ pattern: "" }, root)).rejects.toThrow(/pattern is required/i);
  });

  it("returns no matches when the signal is already aborted", async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const res = await grepFiles({ pattern: "needle" }, root, ctrl.signal);
    expect(res.matches).toEqual([]);
    expect(res.hint).toMatch(/aborted/i);
  });

  it("throws a useful error for invalid regex", async () => {
    await expect(grepFiles({ pattern: "[" }, root)).rejects.toThrow(/Invalid regex/i);
  });
});
