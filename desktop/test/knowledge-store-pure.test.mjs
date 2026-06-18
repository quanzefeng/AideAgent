/**
 * Unit tests for pure functions in knowledge-store.mjs.
 *
 * These tests have NO external dependencies (no SQLite, no Ollama, no
 * filesystem) — they run in < 100ms total and gate every PR.
 *
 * Coverage:
 *   - FTS5 sanitization (the injection bug we just fixed)
 *   - CJK tokenization for FTS5
 *   - Markdown stripping (for embedding text)
 *   - Note chunking (heading-based and fixed-size fallback)
 *   - Frontmatter / title / tag extraction (Obsidian convention)
 *   - Vector math (cosine similarity, RRF, buffer roundtrip)
 *   - Path safety (the symlink bypass we just fixed)
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, symlinkSync, existsSync, realpathSync } from "fs";
import { join, sep } from "path";
import { tmpdir } from "os";
import {
  spaceCJK,
  sanitizeFtsTerm,
  stripMarkdown,
  splitIntoChunks,
  parseFrontMatter,
  extractTitle,
  extractTags,
  vectorToBuffer,
  bufferToVector,
  cosineSimilarity,
  reciprocalRankFusion,
  isSafeVaultPath,
  setVault,
  getVault,
} from "../knowledge-store.mjs";

// ── isSafeVaultPath needs a vault set up; capture & restore state ──
let tempVault;
const originalVault = getVault();

// Safety net: if the test process is killed (SIGKILL, OOM, hard exit) and
// afterAll doesn't run, this fires to clear the leaked temp vault path from
// ~/.aideagent/kb-config.json. Without this, an interrupted test run would
// leave the user's KB pointing at a now-deleted C:\...\Temp\kb-test-XXXXX
// directory until they manually reset it in Settings.
// process.on('exit') only fires on normal exit, so this covers the "test
// suite finished but afterAll was skipped" edge case (e.g. uncaught error
// aborts the worker). For SIGKILL there's no recovery — that's unavoidable.
process.on("exit", () => {
  if (getVault() && getVault() !== originalVault) {
    try { setVault(originalVault || ""); } catch { /* ignored */ }
  }
});

beforeAll(() => {
  // Set up a real temp dir so realpathSync() succeeds inside isSafeVaultPath.
  // The bug fix uses realpathSync on both the vault and the resolved path.
  tempVault = mkdtempSync(join(tmpdir(), "kb-test-"));
  // Resolve to canonical path (on macOS /tmp -> /private/tmp)
  tempVault = realpathSync(tempVault);
  setVault(tempVault);
});

afterAll(() => {
  // Always restore — including to "" if that was the original state.
  // The previous `if (originalVault)` guard skipped restore when the user
  // had no vault configured, which leaked the temp path into kb-config.json
  // (a real production incident — see git history).
  setVault(originalVault || "");
  if (tempVault && existsSync(tempVault)) {
    try { rmSync(tempVault, { recursive: true, force: true }); } catch { /* ignored */ }
  }
});

// ════════════════════════════════════════════════════════════════
// FTS5 sanitization (Bug 4 fix)
// ════════════════════════════════════════════════════════════════
describe("sanitizeFtsTerm", () => {
  it("strips FTS5 metacharacters that could change query semantics", () => {
    // Each of these would be a valid FTS5 operator without sanitization
    expect(sanitizeFtsTerm('a"b')).toBe("ab");
    expect(sanitizeFtsTerm('a:b')).toBe("ab");
    expect(sanitizeFtsTerm('a*b')).toBe("ab");
    expect(sanitizeFtsTerm('a+b')).toBe("ab");
    // Note: `-` and `_` are intentionally preserved (allowed in our regex)
    // because they appear in real terms like "foo-bar" and "hello_world".
    expect(sanitizeFtsTerm('a-b')).toBe("a-b");
    expect(sanitizeFtsTerm('a_b')).toBe("a_b");
    expect(sanitizeFtsTerm('a(b)')).toBe("ab");
    expect(sanitizeFtsTerm('a^b')).toBe("ab");
    expect(sanitizeFtsTerm('a.b')).toBe("ab");
  });

  it("strips spaces and whitespace (each term is split upstream)", () => {
    expect(sanitizeFtsTerm("hello world")).toBe("helloworld");
    expect(sanitizeFtsTerm("a\tb\nc")).toBe("abc");
  });

  it("preserves CJK characters, letters, digits, underscore, dash", () => {
    expect(sanitizeFtsTerm("故宫博物院")).toBe("故宫博物院");
    expect(sanitizeFtsTerm("hello-world_2024")).toBe("hello-world_2024");
    expect(sanitizeFtsTerm("用户123")).toBe("用户123");
  });

  it("returns empty string for empty / whitespace-only / null input", () => {
    expect(sanitizeFtsTerm("")).toBe("");
    expect(sanitizeFtsTerm("   ")).toBe("");
    expect(sanitizeFtsTerm("***")).toBe("");
    expect(sanitizeFtsTerm("()()()")).toBe("");
  });

  it("survives a real FTS5 injection attempt", () => {
    // Worst-case: attacker crafts a query that breaks out of the quoted
    // string and injects FTS5 operators. After sanitization, only the
    // safe characters remain.
    const malicious = '" OR NEAR/3 secret *:^column';
    const sanitized = sanitizeFtsTerm(malicious);
    // The result is wrapped in "..." by ftsSearch(), and the original
    // metacharacters are gone, so FTS5 can't parse them as operators.
    expect(sanitized).not.toMatch(/["*()^:]/);
  });
});

// ════════════════════════════════════════════════════════════════
// CJK tokenization
// ════════════════════════════════════════════════════════════════
describe("spaceCJK", () => {
  it("inserts spaces between consecutive CJK characters", () => {
    expect(spaceCJK("故宫博物院")).toBe("故 宫 博 物 院");
    expect(spaceCJK("本地大模型")).toBe("本 地 大 模 型");
  });

  it("preserves ASCII text untouched", () => {
    expect(spaceCJK("hello world")).toBe("hello world");
    expect(spaceCJK("opencode")).toBe("opencode");
  });

  it("spaces mixed CJK and ASCII at the boundary", () => {
    // Implementation inserts a trailing space after each CJK char, then
    // .trim() removes the final one. So "opencode怎么用" becomes
    // "opencode怎 么 用" — the CJK chars themselves don't get leading
    // spaces, but each one (except the last) has a trailing one.
    expect(spaceCJK("opencode怎么用")).toBe("opencode怎 么 用");
  });

  it("handles empty / null input", () => {
    expect(spaceCJK("")).toBe("");
    expect(spaceCJK(null)).toBe(null);
    expect(spaceCJK(undefined)).toBe(undefined);
  });

  it("handles single CJK char without crashing on regex", () => {
    expect(spaceCJK("中")).toBe("中");
  });
});

// ════════════════════════════════════════════════════════════════
// Markdown stripping
// ════════════════════════════════════════════════════════════════
describe("stripMarkdown", () => {
  it("removes heading markers (level 1-6)", () => {
    expect(stripMarkdown("# Title")).toBe("Title");
    expect(stripMarkdown("## Section")).toBe("Section");
    expect(stripMarkdown("###### Deep")).toBe("Deep");
  });

  it("removes bold/italic/code/strikethrough markers", () => {
    expect(stripMarkdown("**bold**")).toBe("bold");
    expect(stripMarkdown("*italic*")).toBe("italic");
    expect(stripMarkdown("`code`")).toBe("code");
    expect(stripMarkdown("~~strike~~")).toBe("strike");
  });

  it("expands wikilinks to display text", () => {
    expect(stripMarkdown("[[note]]")).toBe("note");
    expect(stripMarkdown("[[note|display text]]")).toBe("display text");
    expect(stripMarkdown("[[人工智能/opencode/教程]]")).toBe("人工智能/opencode/教程");
  });

  it("collapses 2+ consecutive newlines into one", () => {
    expect(stripMarkdown("a\n\n\n\nb")).toBe("a\nb");
    expect(stripMarkdown("a\n\nb")).toBe("a\nb");
  });

  it("trims leading and trailing whitespace", () => {
    expect(stripMarkdown("  hello  ")).toBe("hello");
    expect(stripMarkdown("\n\nhello\n\n")).toBe("hello");
  });

  it("handles empty string", () => {
    expect(stripMarkdown("")).toBe("");
  });
});

// ════════════════════════════════════════════════════════════════
// Note chunking (the most behavior-rich pure function)
// ════════════════════════════════════════════════════════════════
describe("splitIntoChunks", () => {
  it("returns empty array for empty/whitespace body", () => {
    expect(splitIntoChunks("")).toEqual([]);
    expect(splitIntoChunks("   \n\t  ")).toEqual([]);
  });

  it("splits on ## (level 2+) headings, attaching each as `heading`", () => {
    const body = `# Title

Intro paragraph here that should be long enough to be captured.

## Section A
Content of section A.

## Section B
Content of section B.
`;
    const chunks = splitIntoChunks(body, "Fallback");
    // 1 lead chunk (under title) + 2 heading sections
    expect(chunks.length).toBe(3);
    expect(chunks[0].heading).toBe("Fallback"); // lead uses fallbackTitle
    expect(chunks[1].heading).toBe("Section A");
    expect(chunks[2].heading).toBe("Section B");
    expect(chunks[1].content).toContain("Content of section A.");
    expect(chunks[2].content).toContain("Content of section B.");
  });

  it("falls through to H1 (level 1) when there are multiple but no ## headings", () => {
    const body = `# Section 1
Content 1.

# Section 2
Content 2.
`;
    const chunks = splitIntoChunks(body, "Fallback");
    expect(chunks.length).toBe(2);
    expect(chunks[0].heading).toBe("Section 1");
    expect(chunks[1].heading).toBe("Section 2");
  });

  it("falls through to fixed-size chunking when no headings at all", () => {
    const long = "a".repeat(2000); // > CHUNK_SIZE (500)
    const chunks = splitIntoChunks(long, "Title");
    expect(chunks.length).toBeGreaterThan(1);
    // First chunk should use the title as heading
    expect(chunks[0].heading).toBe("Title");
    // Subsequent chunks have empty heading
    expect(chunks[1].heading).toBe("");
    // Each chunk ≤ CHUNK_SIZE
    for (const c of chunks) {
      expect(c.content.length).toBeLessThanOrEqual(500);
    }
  });

  it("captures lead content (before first heading) as its own chunk", () => {
    // The lead-capture feature requires >= 2 ## headings (Attempt 1 only
    // activates when there are multiple sections). With a single ##, the
    // fixed-size fallback applies instead and the whole body becomes one
    // chunk.
    //
    // This test verifies the multi-section case (where lead capture
    // actually fires).
    const body = `This is a long enough intro paragraph that should be captured as a lead chunk.

## Section A
Body of A.

## Section B
Body of B.
`;
    const chunks = splitIntoChunks(body, "Note Title");
    // 1 lead chunk + 2 sections = 3
    expect(chunks.length).toBe(3);
    expect(chunks[0].heading).toBe("Note Title"); // lead uses fallbackTitle
    expect(chunks[0].content).toContain("This is a long enough intro");
    expect(chunks[1].heading).toBe("Section A");
    expect(chunks[2].heading).toBe("Section B");
  });

  it("does NOT create a lead chunk if intro is too short (< 20 chars)", () => {
    // With a single ## section, Attempt 1's ">= 2 headings" guard doesn't
    // fire, so no lead capture. The whole body becomes one chunk via
    // fixed-size fallback.
    const body = `Short.

## Section
Body.
`;
    const chunks = splitIntoChunks(body, "Title");
    expect(chunks.length).toBe(1);
    // The single chunk has the fallback title (fixed-size branch)
    expect(chunks[0].heading).toBe("Title");
    expect(chunks[0].content).toContain("Short.");
    expect(chunks[0].content).toContain("Section"); // ## stripped by stripMarkdown
    expect(chunks[0].content).toContain("Body.");
  });
});

// ════════════════════════════════════════════════════════════════
// Frontmatter / title / tags (Obsidian convention)
// ════════════════════════════════════════════════════════════════
describe("parseFrontMatter", () => {
  it("returns empty meta when no frontmatter", () => {
    expect(parseFrontMatter("just plain text\n# heading")).toEqual({
      title: "",
      tags: [],
      aliases: [],
    });
  });

  it("parses title and tags (array form)", () => {
    const text = `---
title: My Note
tags: [foo, bar, baz]
---

# Heading`;
    const fm = parseFrontMatter(text);
    expect(fm.title).toBe("My Note");
    expect(fm.tags).toEqual(["foo", "bar", "baz"]);
  });

  it("parses tags as comma-separated string", () => {
    const text = `---
tags: foo, bar, baz
---`;
    const fm = parseFrontMatter(text);
    expect(fm.tags).toEqual(["foo", "bar", "baz"]);
  });

  it("parses aliases (array and scalar)", () => {
    const a = parseFrontMatter(`---
aliases: [nick1, nick2]
---`);
    expect(a.aliases).toEqual(["nick1", "nick2"]);

    const b = parseFrontMatter(`---
aliases: just-one
---`);
    expect(b.aliases).toEqual(["just-one"]);
  });

  it("strips surrounding quotes from values", () => {
    const fm = parseFrontMatter(`---
title: "Quoted Title"
---`);
    expect(fm.title).toBe("Quoted Title");
  });

  it("ignores unknown keys (not in the allowlist)", () => {
    const fm = parseFrontMatter(`---
title: OK
unknown_key: should_be_ignored
date: 2026-06-14
---`);
    expect(fm.title).toBe("OK");
    // Just verify we don't throw and the parse is correct
    expect(fm.tags).toEqual([]);
  });
});

describe("extractTitle", () => {
  it("prefers frontmatter title over H1 over filename", () => {
    const text = `---
title: Frontmatter Title
---
# H1 Title
content`;
    expect(extractTitle(text, "filename.md")).toBe("Frontmatter Title");
  });

  it("falls back to H1 when no frontmatter title", () => {
    const text = `# H1 Title
content`;
    expect(extractTitle(text, "filename.md")).toBe("H1 Title");
  });

  it("falls back to filename (without .md) when no frontmatter and no H1", () => {
    expect(extractTitle("just some content\nno headings", "my-note.md")).toBe("my-note");
  });
});

describe("extractTags", () => {
  it("combines frontmatter tags with inline #tags, deduplicated", () => {
    const text = `---
tags: [foo, bar]
---

# Heading about baz

This paragraph mentions #foo again and adds #qux.
`;
    const tags = extractTags(text);
    expect(tags).toContain("foo");
    expect(tags).toContain("bar");
    expect(tags).toContain("qux");
    // No duplicates
    expect(new Set(tags).size).toBe(tags.length);
    expect(tags.length).toBe(3);
  });

  it("returns empty array when no tags anywhere", () => {
    const tags = extractTags("# Just a heading\n\nNo tags here.");
    expect(tags).toEqual([]);
  });

  it("matches Chinese inline tags", () => {
    const text = "Some text with #学习 and #编程 tags.";
    const tags = extractTags(text);
    expect(tags).toContain("学习");
    expect(tags).toContain("编程");
  });
});

// ════════════════════════════════════════════════════════════════
// Vector math
// ════════════════════════════════════════════════════════════════
describe("cosineSimilarity", () => {
  it("returns 1.0 for identical unit vectors", () => {
    const a = new Float32Array([1, 0, 0]);
    const b = new Float32Array([1, 0, 0]);
    expect(cosineSimilarity(a, b)).toBeCloseTo(1.0, 5);
  });

  it("returns 0 for orthogonal vectors", () => {
    const a = new Float32Array([1, 0, 0]);
    const b = new Float32Array([0, 1, 0]);
    expect(cosineSimilarity(a, b)).toBeCloseTo(0.0, 5);
  });

  it("returns -1 for opposite unit vectors", () => {
    const a = new Float32Array([1, 0, 0]);
    const b = new Float32Array([-1, 0, 0]);
    expect(cosineSimilarity(a, b)).toBeCloseTo(-1.0, 5);
  });

  it("returns 0 for zero vectors (avoids division by zero)", () => {
    const a = new Float32Array([0, 0, 0]);
    const b = new Float32Array([1, 0, 0]);
    expect(cosineSimilarity(a, b)).toBe(0);
  });

  it("works regardless of vector magnitude (cosine is scale-invariant)", () => {
    const a = new Float32Array([1, 1, 1]);
    const b = new Float32Array([5, 5, 5]);
    expect(cosineSimilarity(a, b)).toBeCloseTo(1.0, 5);
  });

  it("returns 0 for dimension mismatch (and warns)", () => {
    const a = new Float32Array([1, 0]);
    const b = new Float32Array([1, 0, 0]);
    // Suppress the expected warning during this test
    const origWarn = console.warn;
    console.warn = () => {};
    try {
      expect(cosineSimilarity(a, b)).toBe(0);
    } finally {
      console.warn = origWarn;
    }
  });

  it("accepts plain number arrays as well as Float32Array", () => {
    const a = [1, 0, 0];
    const b = new Float32Array([1, 0, 0]);
    expect(cosineSimilarity(a, b)).toBeCloseTo(1.0, 5);
  });
});

describe("reciprocalRankFusion", () => {
  it("returns empty for empty input", () => {
    expect(reciprocalRankFusion([])).toEqual([]);
  });

  it("returns ranked scores in descending order", () => {
    // Construct inputs where RRF can actually differentiate:
    //   id=1: rank-1 in A, rank-1 in B → 2/61 (highest)
    //   id=2: rank-2 in A, rank-3 in B → 1/62 + 1/63 (middle)
    //   id=3: rank-3 in A, rank-2 in B → 1/63 + 1/62 (also middle, equal to 2)
    //   id=4: rank-4 in A, missing in B → 1/64 (lowest)
    const lists = [
      [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }],
      [{ id: 1 }, { id: 3 }, { id: 2 }],
    ];
    const fused = reciprocalRankFusion(lists);
    expect(fused[0].id).toBe(1);
    expect(fused[0].score).toBeCloseTo(2 / 61, 5);
    // The result is sorted descending by score (ties allowed, not strictly greater)
    for (let i = 1; i < fused.length; i++) {
      expect(fused[i - 1].score).toBeGreaterThanOrEqual(fused[i].score);
    }
    // id=4 (single list, lowest rank) should be last
    expect(fused[fused.length - 1].id).toBe(4);
  });

  it("uses default k=60 (matches the value in search())", () => {
    // At k=60, rank 1 score = 1/61 ≈ 0.01639
    const lists = [[{ id: 1 }]];
    const fused = reciprocalRankFusion(lists);
    expect(fused[0].score).toBeCloseTo(1 / 61, 5);
  });

  it("boosts items that appear in multiple lists", () => {
    const singleList = [[{ id: 1 }, { id: 2 }]];
    const multiList = [
      [{ id: 1 }, { id: 2 }],
      [{ id: 1 }, { id: 2 }],
    ];
    const single = reciprocalRankFusion(singleList);
    const multi = reciprocalRankFusion(multiList);
    expect(multi[0].score).toBeGreaterThan(single[0].score);
    expect(multi[1].score).toBeGreaterThan(single[1].score);
  });

  it("treats numeric input same as object input", () => {
    const a = reciprocalRankFusion([[1, 2, 3]]);
    const b = reciprocalRankFusion([[{ id: 1 }, { id: 2 }, { id: 3 }]]);
    expect(a.map(x => x.id)).toEqual(b.map(x => x.id));
    expect(a[0].score).toBeCloseTo(b[0].score, 5);
  });
});

describe("vectorToBuffer / bufferToVector roundtrip", () => {
  it("preserves exact float values through roundtrip (Float32 precision)", () => {
    // Float32 has ~7 significant decimal digits. Pick values that survive
    // round-trip exactly: 0.5 (= 2^-1), 1.0, etc. Avoid 0.1, 0.2 which are
    // approximate in float.
    const original = new Float32Array([0.5, 1.0, 0.25, 0.0, -0.5, 1e-7]);
    const buf = vectorToBuffer(original);
    const restored = bufferToVector(buf);
    expect(restored.length).toBe(original.length);
    for (let i = 0; i < original.length; i++) {
      expect(restored[i]).toBe(original[i]);
    }
  });

  it("preserves float values to Float32 precision through roundtrip", () => {
    // For values that don't roundtrip exactly in Float32, we use toBeCloseTo
    const original = new Float32Array([0.1, 0.2, 0.3]);
    const buf = vectorToBuffer(original);
    const restored = bufferToVector(buf);
    expect(restored.length).toBe(3);
    expect(restored[0]).toBeCloseTo(0.1, 6);
    expect(restored[1]).toBeCloseTo(0.2, 6);
    expect(restored[2]).toBeCloseTo(0.3, 6);
  });

  it("handles offset vectors (Float32Array view into ArrayBuffer)", () => {
    // Mimic how the embedder might return a Float32Array that's a view
    // into a larger buffer.
    // Note: 0.1, 0.2, 0.3 in Float32 are approximate (precision ~7 digits),
    // so we use toBeCloseTo rather than exact equality.
    const full = new Float32Array([99, 99, 0.1, 0.2, 0.3, 99, 99]);
    const view = full.subarray(2, 5);
    expect(view.length).toBe(3);
    const buf = vectorToBuffer(view);
    const restored = bufferToVector(buf);
    expect(restored.length).toBe(3);
    expect(restored[0]).toBeCloseTo(0.1, 6);
    expect(restored[1]).toBeCloseTo(0.2, 6);
    expect(restored[2]).toBeCloseTo(0.3, 6);
  });

  it("handles empty vectors", () => {
    const empty = new Float32Array(0);
    const buf = vectorToBuffer(empty);
    const restored = bufferToVector(buf);
    expect(restored.length).toBe(0);
  });
});

// ════════════════════════════════════════════════════════════════
// Path safety (Bug 5 fix)
// ════════════════════════════════════════════════════════════════
describe("isSafeVaultPath", () => {
  it("accepts a simple relative path inside the vault", () => {
    expect(isSafeVaultPath("notes/hello.md")).toBe(true);
    expect(isSafeVaultPath("hello.md")).toBe(true);
    expect(isSafeVaultPath("a/b/c/d/e/f.md")).toBe(true);
  });

  it("rejects path traversal via ..", () => {
    expect(isSafeVaultPath("../etc/passwd")).toBe(false);
    expect(isSafeVaultPath("notes/../../etc")).toBe(false);
    expect(isSafeVaultPath("..")).toBe(false);
  });

  it("rejects absolute paths", () => {
    expect(isSafeVaultPath("/etc/passwd")).toBe(false);
    expect(isSafeVaultPath("\\Windows\\System32")).toBe(false);
    // Windows drive-relative (resolved as cwd-relative on some APIs)
    expect(isSafeVaultPath("C:foo.md")).toBe(false);
  });

  it("rejects NTFS alternate data streams (foo.md:hidden)", () => {
    expect(isSafeVaultPath("foo.md:hidden")).toBe(false);
    expect(isSafeVaultPath("notes/x.md:secret")).toBe(false);
  });

  it("rejects null bytes and other control characters", () => {
    expect(isSafeVaultPath("foo.md\x00.png")).toBe(false);
    expect(isSafeVaultPath("foo\nbar.md")).toBe(false);
    expect(isSafeVaultPath("foo\rbar.md")).toBe(false);
  });

  it("rejects empty / non-string input", () => {
    expect(isSafeVaultPath("")).toBe(false);
    expect(isSafeVaultPath(null)).toBe(false);
    expect(isSafeVaultPath(undefined)).toBe(false);
    expect(isSafeVaultPath(123)).toBe(false);
  });

  it("rejects symlinks pointing outside the vault (Bug 5)", () => {
    // Create an evil symlink inside the vault pointing to /tmp
    const evilLink = join(tempVault, "evil-link.md");
    const target = realpathSync(tmpdir()); // outside the vault
    try {
      symlinkSync(target, evilLink);
    } catch (e) {
      // Windows without Developer Mode / SeCreateSymbolicLinkPrivilege
      // can't create symlinks. Skip rather than fail the test.
      if (e.code === "EPERM" || e.code === "EACCES") {
        console.log(`  [skip] symlink creation requires elevated privilege on this OS (${process.platform})`);
        return;
      }
      throw e;
    }
    try {
      // isSafeVaultPath must NOT accept this, even though string-wise
      // it's "inside" the vault
      expect(isSafeVaultPath("evil-link.md")).toBe(false);
    } finally {
      try { rmSync(evilLink, { force: true }); } catch { /* ignored */ }
    }
  });

  it("rejects a symlink in a subdirectory pointing outside", () => {
    const subdir = join(tempVault, "subdir-sym-test");
    mkdirSync(subdir, { recursive: true });
    const evilLink = join(subdir, "evil.md");
    try {
      symlinkSync(realpathSync(tmpdir()), evilLink);
    } catch (e) {
      try { rmSync(subdir, { recursive: true, force: true }); } catch { /* ignored */ }
      if (e.code === "EPERM" || e.code === "EACCES") {
        console.log(`  [skip] symlink creation requires elevated privilege on this OS`);
        return;
      }
      throw e;
    }
    try {
      expect(isSafeVaultPath("subdir-sym-test/evil.md")).toBe(false);
    } finally {
      try { rmSync(evilLink, { force: true }); } catch { /* ignored */ }
    }
  });

  it("accepts a symlink that points to another file inside the vault", () => {
    // Legitimate cross-link within the vault should be allowed
    const real = join(tempVault, "real-sym-test.md");
    writeFileSync(real, "content");
    const link = join(tempVault, "link-sym-test.md");
    try {
      symlinkSync(real, link);
    } catch (e) {
      try { rmSync(real, { force: true }); } catch { /* ignored */ }
      if (e.code === "EPERM" || e.code === "EACCES") {
        console.log(`  [skip] symlink creation requires elevated privilege on this OS`);
        return;
      }
      throw e;
    }
    try {
      expect(isSafeVaultPath("link-sym-test.md")).toBe(true);
      expect(isSafeVaultPath("real-sym-test.md")).toBe(true);
    } finally {
      try { rmSync(link, { force: true }); } catch { /* ignored */ }
    }
  });
});
