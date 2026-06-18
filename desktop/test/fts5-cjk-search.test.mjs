/**
 * FTS5 CJK search integration tests.
 *
 * Regression coverage for the P0 bug where ftsSearch() applied
 * `sanitizeFtsTerm(spaceCJK(t))` — the sanitizer regex stripped the spaces
 * that spaceCJK had just added, collapsing the spaced query back to a
 * single token. Symptom: 100% of Chinese FTS5 searches returned 0 hits,
 * and kb_search results were carried entirely by vector recall + LLM rerank.
 *
 * The fix swapped the order to `spaceCJK(sanitizeFtsTerm(t))`. These tests
 * exercise the real ftsSearch() against a real isolated DB (no mocking)
 * so the order-of-operations invariant is locked in.
 *
 * Test setup mirrors rebuild-atomic.test.mjs: temp DB via _setDbPath,
 * vault restore in afterEach to avoid leaking into kb-config.json.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { setVault, getVault } from "../knowledge-store.mjs";
import { _setDbPath } from "../kb/db.mjs";
import { ftsInsertChunk, ftsSearch } from "../kb/search.mjs";
import { makeIsoKb } from "./helpers/iso-kb.mjs";

describe("FTS5 CJK search", () => {
  const originalVault = getVault();
  const iso = makeIsoKb({});

  beforeAll(() => {
    _setDbPath(iso.dbPath);
    // Seed three chunks: pure CJK, ASCII+CJK mix, pure ASCII
    ftsInsertChunk(1, "故宫介绍",     "故宫博物院位于北京，是明清两代的皇家宫殿。");
    ftsInsertChunk(2, "opencode教程", "opencode怎么用：首先安装到本地。");
    ftsInsertChunk(3, "本地模型",     "本地大模型推荐使用Ollama。");
  });

  afterAll(() => {
    _setDbPath(null);
    iso.cleanup();
    // Don't mutate user's real vault (test never set it; originalVault is what we read on import).
    setVault(originalVault || "");
  });

  it("matches a full multi-character CJK phrase", () => {
    const hits = ftsSearch("故宫博物院", 10);
    expect(hits.length).toBeGreaterThan(0);
    expect(Number(hits[0].chunk_id)).toBe(1);
  });

  it("matches a partial CJK substring (subset of indexed chars)", () => {
    const hits = ftsSearch("故宫", 10);
    expect(hits.length).toBeGreaterThan(0);
    expect(Number(hits[0].chunk_id)).toBe(1);
  });

  it("matches a CJK city name appearing mid-sentence", () => {
    // "北京" appears inside chunk 1's body ("位于北京")
    const hits = ftsSearch("北京", 10);
    expect(hits.length).toBeGreaterThan(0);
    expect(Number(hits[0].chunk_id)).toBe(1);
  });

  it("matches mixed ASCII + CJK in a single term", () => {
    // The bug previously caused "opencode怎么用" to collapse to one token
    // that didn't exist in the index (which had "opencode" + spaced CJK).
    const hits = ftsSearch("opencode怎么用", 10);
    expect(hits.length).toBeGreaterThan(0);
    expect(Number(hits[0].chunk_id)).toBe(2);
  });

  it("matches multi-CJK token of 4+ characters", () => {
    const hits = ftsSearch("本地大模型", 10);
    expect(hits.length).toBeGreaterThan(0);
    expect(Number(hits[0].chunk_id)).toBe(3);
  });

  it("still matches plain ASCII (regression check for the fix path)", () => {
    const hits = ftsSearch("Ollama", 10);
    expect(hits.length).toBeGreaterThan(0);
    expect(Number(hits[0].chunk_id)).toBe(3);
  });

  it("phrase semantics: non-adjacent CJK chars do NOT match", () => {
    // Chunk 1's body is "故 宫 博 物 院 位 于 北 京" (spaceCJK output).
    // Query "故博" is spaced to "故 博" and wrapped as a single phrase
    // '"故 博"' — FTS5 phrase search requires these tokens to be ADJACENT.
    // In the index 故 is followed by 宫 (not 博), so this misses.
    // This documents that the fix path is phrase match, not AND-of-terms.
    const hits = ftsSearch("故博", 10);
    expect(hits.length).toBe(0);
  });

  it("phrase semantics: adjacent CJK chars DO match", () => {
    // "宫博" is two adjacent characters in chunk 1's spaced index, so
    // a phrase query for it should hit.
    const hits = ftsSearch("宫博", 10);
    expect(hits.length).toBeGreaterThan(0);
    expect(Number(hits[0].chunk_id)).toBe(1);
  });
});
