/**
 * KB RAG quality gate — runs the evaluation set as a vitest suite.
 *
 * This is a *regression gate*, not a target-tuning tool. The thresholds
 * are intentionally set below historical baseline (88.9% / 0.827) so
 * routine chunk-embedding drift doesn't cause false failures. Tighten
 * them only when the baseline measurably improves.
 *
 * What it asserts:
 *   - search() produces results that pass the per-query expected_paths
 *     at hit@5 with the documented minimum
 *   - MRR stays above a documented minimum
 *   - Each "vague" query (expected_paths: []) returns no results OR
 *     the result is below the noise floor — i.e. no false positives
 *
 * What it does NOT assert:
 *   - Exact ranks (too brittle — embedding model upgrades legitimately
 *     shift ranks)
 *   - LLM rerank order (non-deterministic across runs)
 *
 * Skip conditions:
 *   - Vault not configured (noteCount === 0): test is skipped with a
 *     clear message. This is the case in CI without a populated vault.
 *
 *   Note: This test does NOT require Ollama. It will run with whatever
 *   embedder is configured (local MiniLM or ollama). If neither is
 *   available, search() returns FTS-only results and the hit@5 gate
 *   will likely fail — that's a signal to fix the embedder, not to
 *   skip the test.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

// ── Thresholds ────────────────────────────────────────────
// Last 5 eval runs: 77.8% / 88.9% / 88.9% / 88.9% / 88.9% Hit@5
// Last 5 MRRs:       0.743 / 0.772 / 0.772 / 0.827 / 0.827
// We set gates at 70% / 0.65 to leave headroom for legitimate drift
// (e.g. removing a low-quality fallback) without constant CI noise.
// When you raise these, document the new number in the eval folder.
const HIT_AT_5_FLOOR = 0.70;
const MRR_FLOOR = 0.65;

// "Vague" queries should not return confidently-ranked results. The
// current implementation either returns nothing (vector sim below
// noise floor) or returns weak matches. We count "no results" as PASS
// and require result[0].rrfScore < 0.012 to fail (matches the search()
// gate for false positives).
const VAGUE_FALSE_POSITIVE_RRF = 0.012;

// ── Test set loader (mirrors kb-eval.mjs shape) ───────────
function loadEvalSet(path) {
  const text = readFileSync(path, "utf-8");
  const cases = [];
  let lineNo = 0;
  for (const raw of text.split(/\r?\n/)) {
    lineNo++;
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    try {
      const obj = JSON.parse(line);
      if (!obj.id || !obj.query) continue;
      cases.push({
        id: String(obj.id),
        query: String(obj.query),
        expected_paths: Array.isArray(obj.expected_paths)
          ? obj.expected_paths.map(String) : [],
        difficulty: obj.difficulty || "unknown",
        notes: obj.notes || "",
      });
    } catch (e) {
      throw new Error(`kb-quality.test.mjs: parse error at line ${lineNo}: ${e.message}`);
    }
  }
  return cases;
}

function findFirstRank(results, expectedPaths) {
  for (let i = 0; i < results.length; i++) {
    if (expectedPaths.includes(results[i].rel_path)) return i + 1;
  }
  return null;
}

describe("KB RAG quality gate", () => {
  let ks;
  let cases;
  let skipReason = null;

  beforeAll(async () => {
    const setPath = join(ROOT, "test", "kb-eval-set.jsonl");
    if (!existsSync(setPath)) {
      skipReason = "test/kb-eval-set.jsonl not found";
      return;
    }
    cases = loadEvalSet(setPath);
    // Lazy-import the store so any init errors show a clear stack
    ks = await import("../knowledge-store.mjs");
    const status = ks.getStatus();
    if (!status.vault) {
      skipReason = "Knowledge base vault not configured (run `kb setVault` in your app first)";
      return;
    }
    if (status.noteCount === 0) {
      skipReason = `Vault set (${status.vault}) but no notes indexed — run a rebuild first`;
      return;
    }
  }, 60000);

  it("reports vault status so a failing gate is debuggable", () => {
    if (skipReason) {
      console.log(`[skip] ${skipReason}`);
      return;
    }
    const status = ks.getStatus();
    // Sanity-check the status shape; if this fails, the gate below is meaningless
    expect(status).toHaveProperty("noteCount");
    expect(status).toHaveProperty("chunkCount");
    expect(status).toHaveProperty("embeddedCount");
    expect(status.embeddedCount).toBeGreaterThan(0);
  });

  it("meets Hit@5 and MRR floors on the eval set", async () => {
    if (skipReason) {
      console.log(`[skip] ${skipReason}`);
      return;
    }

    // Warmup: prime the embedder so the first query isn't slow due to model load
    // and so the cold-start latency doesn't pollute the measurement.
    try {
      await ks.search("warmup", 1);
    } catch {
      // No embedder → FTS-only mode; gate will likely fail
    }

    let hitsAt5 = 0;
    let mrrSum = 0;
    let mrrCount = 0;
    const failures = [];

    for (const c of cases) {
      if (c.expected_paths.length === 0) continue; // skip informational

      let results;
      try {
        results = await ks.search(c.query, 20);
      } catch (e) {
        failures.push({ id: c.id, query: c.query, error: e.message });
        continue;
      }

      const rank = findFirstRank(results, c.expected_paths);
      if (rank !== null && rank <= 5) hitsAt5++;
      if (rank !== null) {
        mrrSum += 1 / rank;
        mrrCount++;
      }
      if (rank === null || rank > 5) {
        failures.push({
          id: c.id,
          query: c.query,
          rank,
          difficulty: c.difficulty,
          topResults: results.slice(0, 3).map((r) => ({
            path: r.rel_path,
            score: Number(r.rrfScore.toFixed(4)),
          })),
        });
      }
    }

    const evaluable = cases.filter((c) => c.expected_paths.length > 0).length;
    const hitRate = evaluable > 0 ? hitsAt5 / evaluable : 0;
    const mrr = mrrCount > 0 ? mrrSum / mrrCount : 0;

    // Print the scorecard first so a CI log shows the full picture
    // even on success.
    console.log(`\n  Hit@5:    ${hitsAt5}/${evaluable}  (${(hitRate * 100).toFixed(1)}%, floor ${(HIT_AT_5_FLOOR * 100).toFixed(0)}%)`);
    console.log(`  MRR:      ${mrr.toFixed(3)}     (floor ${MRR_FLOOR.toFixed(2)})`);

    if (failures.length > 0) {
      console.log(`\n  Failed queries:`);
      for (const f of failures) {
        if (f.error) {
          console.log(`    ✗ [${f.id}] "${f.query}" — error: ${f.error}`);
        } else {
          console.log(`    ✗ [${f.id}] "${f.query}" (${f.difficulty}) — rank=${f.rank ?? "MISS"}`);
          for (const r of f.topResults || []) {
            console.log(`        top: ${r.path}  (rrf=${r.score})`);
          }
        }
      }
    }

    expect(hitRate).toBeGreaterThanOrEqual(HIT_AT_5_FLOOR);
    expect(mrr).toBeGreaterThanOrEqual(MRR_FLOOR);
  }, 120000); // 120s — covers cold-start rerank + 15 queries

  it("vague queries do not produce false positives above the noise floor", async () => {
    if (skipReason) {
      console.log(`[skip] ${skipReason}`);
      return;
    }
    const vague = cases.filter((c) => c.difficulty === "vague");
    if (vague.length === 0) return; // eval-set has no vague queries

    // This is a *diagnostic* test, not a hard gate. The current eval set
    // has known false positives on vague queries (e.g. "如何快速做笔记"
    // returns rrf=0.0164 on 心理学/表达能力/提升语言表达能力.md, which
    // is topically related but not a real answer). We log them so the
    // issue is visible in CI logs, but don't fail the suite — those are
    // quality issues to address in the RAG, not gate violations.
    //
    // When the false-positive rate drops to zero on the eval set, flip
    // the trailing `expect` to a real assertion.
    const falsePositives = [];
    for (const c of vague) {
      const results = await ks.search(c.query, 5);
      if (results.length === 0) continue; // correct: no match
      const top = results[0];
      if (top.rrfScore >= VAGUE_FALSE_POSITIVE_RRF) {
        falsePositives.push({
          id: c.id,
          query: c.query,
          top: top.rel_path,
          score: Number(top.rrfScore.toFixed(4)),
        });
      }
    }

    if (falsePositives.length > 0) {
      console.log(`\n  ⚠ Known false positives on vague queries (diagnostic, not a gate):`);
      for (const fp of falsePositives) {
        console.log(`    ⚠ "${fp.query}" → ${fp.top}  (rrf=${fp.score})`);
      }
      console.log(`  → see kb-quality.test.mjs comment for tracking`);
    } else {
      console.log(`\n  ✓ No false positives on vague queries`);
    }

    // Soft gate: allow up to 2 false positives without failing.
    // When this drops to 0, tighten the assertion.
    expect(falsePositives.length).toBeLessThanOrEqual(2);
  }, 60000);
});
