#!/usr/bin/env node
/**
 * KB Evaluation Harness — measure search quality
 *
 * Usage:
 *   node test/kb-eval.mjs
 *   node test/kb-eval.mjs --top-k 10
 *   node test/kb-eval.mjs --set test/kb-eval-set.jsonl
 *   node test/kb-eval.mjs --output eval-result.json
 *
 * Test set schema (one JSON object per line in .jsonl):
 *   {
 *     "id": "unique-id",                  // required
 *     "query": "search query",            // required
 *     "expected_paths": ["rel/path.md"],  // required (can be [])
 *     "expected_tags": ["tag1"],          // optional
 *     "must_contain": "substring",        // optional, must appear in any result's content
 *     "must_contain_any": ["a", "b"],     // optional, at least one must appear
 *     "min_rank": 3,                      // optional, expected result must rank <= N
 *     "difficulty": "exact|conceptual|vague",  // optional, for breakdown
 *     "tags": ["group:x"],                // optional, for filtering or grouping
 *     "notes": "human notes"              // optional
 *   }
 *
 * Metrics:
 *   - Hit @K:    fraction of queries where any expected_path appears in top-K
 *   - Hit @10:   same, K=10
 *   - MRR:       Mean Reciprocal Rank of first expected_path match (1-based)
 *   - Coverage:  unique expected_paths that were found at least once
 *
 * If `expected_paths` is empty, the query is "informational" and counts toward
 * the total but does not contribute to hit/MRR (useful for the no-result demo).
 */

import { readFileSync, writeFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { homedir } from "os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

// ── CLI args ──────────────────────────────────────────────
function parseArgs(argv) {
  const args = { topK: 5, set: null, output: null, limit: 20, verbose: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--top-k" || a === "-k") args.topK = parseInt(argv[++i], 10) || 5;
    else if (a === "--set" || a === "-s") args.set = argv[++i];
    else if (a === "--output" || a === "-o") args.output = argv[++i];
    else if (a === "--limit" || a === "-l") args.limit = parseInt(argv[++i], 10) || 20;
    else if (a === "--verbose" || a === "-v") args.verbose = true;
    else if (a === "--help" || a === "-h") {
      console.log(`KB Evaluation Harness
Usage:
  node test/kb-eval.mjs [options]

Options:
  --top-k, -k <N>      Top-K for hit rate (default 5)
  --set, -s <path>     Test set JSONL path (default: test/kb-eval-set.jsonl)
  --output, -o <path>  Write detailed results to JSON
  --limit, -l <N>      Max results per query (default 20)
  --verbose, -v        Print top results for every query
  --help, -h           Show this help
`);
      process.exit(0);
    }
  }
  return args;
}

// ── Test set loader ──────────────────────────────────────
function loadTestSet(path) {
  if (!existsSync(path)) {
    throw new Error(`Test set not found: ${path}\n  Create one with one JSON object per line.`);
  }
  const text = readFileSync(path, "utf-8");
  const cases = [];
  let lineNo = 0;
  for (const raw of text.split(/\r?\n/)) {
    lineNo++;
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    try {
      const obj = JSON.parse(line);
      if (!obj.id || !obj.query) {
        console.warn(`[skip line ${lineNo}] missing id or query`);
        continue;
      }
      cases.push({
        id: String(obj.id),
        query: String(obj.query),
        expected_paths: Array.isArray(obj.expected_paths) ? obj.expected_paths.map(String) : [],
        expected_tags: Array.isArray(obj.expected_tags) ? obj.expected_tags.map(String) : null,
        must_contain: obj.must_contain ? String(obj.must_contain) : null,
        must_contain_any: Array.isArray(obj.must_contain_any) ? obj.must_contain_any.map(String) : null,
        min_rank: Number.isInteger(obj.min_rank) ? obj.min_rank : null,
        difficulty: obj.difficulty ? String(obj.difficulty) : "unknown",
        tags: Array.isArray(obj.tags) ? obj.tags : [],
        notes: obj.notes ? String(obj.notes) : "",
      });
    } catch (e) {
      console.warn(`[skip line ${lineNo}] JSON parse error: ${e.message}`);
    }
  }
  return cases;
}

// ── Eval runner ──────────────────────────────────────────
function findFirstRank(results, expectedPaths) {
  for (let i = 0; i < results.length; i++) {
    if (expectedPaths.includes(results[i].rel_path)) return i + 1;
  }
  return null;
}

function checkMustContain(results, mustContain, mustContainAny) {
  const allContent = results.map(r => `${r.heading || ""}\n${r.snippet || ""}`).join("\n");
  if (mustContain && !allContent.includes(mustContain)) return false;
  if (mustContainAny && !mustContainAny.some(s => allContent.includes(s))) return false;
  return true;
}

async function run({ topK, setPath, output, limit, verbose }) {
  // Lazy-import knowledge-store so any init errors show clear stack
  const ks = await import("../knowledge-store.mjs");
  const { search, getStatus } = ks;

  const status = getStatus();
  if (!status.vault) {
    console.error("✗ Knowledge base vault not configured.");
    console.error("  Open Settings → 知识库 → 选择 vault 目录 → 扫描.");
    process.exit(1);
  }
  if (status.noteCount === 0) {
    console.error("✗ Vault set but no notes indexed.");
    console.error(`  Vault: ${status.vault}`);
    console.error("  Run a scan (重建索引) and try again.");
    process.exit(1);
  }

  const cases = loadTestSet(setPath);
  if (cases.length === 0) {
    console.error("✗ Test set is empty.");
    process.exit(1);
  }

  console.log(`\n┌─ KB Evaluation ──────────────────────────────────────`);
  console.log(`│ Vault:   ${status.vault}`);
  console.log(`│ Notes:   ${status.noteCount} (chunks: ${status.chunkCount}, embedded: ${status.embeddedCount})`);
  console.log(`│ Provider: ${status.embeddingProvider} (maxBodyChars: ${status.effectiveMaxBodyChars})`);
  console.log(`│ Test set: ${setPath} (${cases.length} queries)`);
  console.log(`│ Top-K:   ${topK}   Limit: ${limit}`);
  console.log(`└─────────────────────────────────────────────────────\n`);

  // Warmup: prime the embedder so the first query isn't slow due to model load
  process.stdout.write("Warming up embedder…");
  try {
    await search("warmup", 1);
    process.stdout.write(" done\n\n");
  } catch {
    process.stdout.write(" (no embedder, FTS-only mode)\n\n");
  }

  // Per-case results
  const detailed = [];
  let hitsAtK = 0;
  let hitsAt10 = 0;
  let mrrSum = 0;
  let mrrCount = 0; // only count cases that had expected_paths
  const foundExpected = new Set();
  const byDifficulty = {};

  for (let i = 0; i < cases.length; i++) {
    const c = cases[i];
    const tag = `[${String(i + 1).padStart(2)}/${cases.length}]`;

    let results = [];
    let error = null;
    try {
      results = await search(c.query, limit);
    } catch (e) {
      error = e.message;
    }

    const rank = findFirstRank(results, c.expected_paths);
    const hasExpected = c.expected_paths.length > 0;
    const containOk = checkMustContain(results, c.must_contain, c.must_contain_any);

    let status_;
    if (error) status_ = "ERROR";
    else if (!hasExpected) status_ = "INFO";  // informational, no expected
    else if (rank !== null && rank <= topK && containOk) status_ = "PASS";
    else if (rank === null) status_ = "MISS";
    else if (rank > topK) status_ = "RANK";
    else status_ = "CONTENT";

    // Aggregate
    if (hasExpected) {
      if (rank !== null && rank <= topK && containOk) hitsAtK++;
      if (rank !== null && rank <= 10 && containOk) hitsAt10++;
      if (rank !== null) {
        mrrSum += 1 / rank;
        mrrCount++;
        foundExpected.add(c.expected_paths[rank - 1] || "");  // not exact, but useful
      }
      const bucket = byDifficulty[c.difficulty] || (byDifficulty[c.difficulty] = { total: 0, hit: 0 });
      bucket.total++;
      if (rank !== null && rank <= topK) bucket.hit++;
    }

    // Print
    const icon = { PASS: "✓", MISS: "✗", RANK: "↓", CONTENT: "⊘", INFO: "·", ERROR: "!" }[status_];
    const rankStr = rank !== null ? `#${rank}` : "  -";
    console.log(`${tag} ${icon} ${status_.padEnd(5)} ${rankStr}  "${c.query}"`);
    if (error) console.log(`        error: ${error}`);
    if (verbose && results.length > 0) {
      const show = results.slice(0, Math.max(topK, 3));
      for (const r of show) {
        const mark = c.expected_paths.includes(r.rel_path) ? "★" : " ";
        const snippet = (r.snippet || "").replace(/\s+/g, " ").slice(0, 80);
        console.log(`        ${mark} #${results.indexOf(r) + 1}  ${r.rel_path}  (rrf=${r.rrfScore.toFixed(4)})`);
        if (snippet) console.log(`           "${snippet}…"`);
      }
    } else if (rank !== null && rank > topK) {
      // Always show the actual rank when it misses @K
      const r = results[rank - 1];
      const snippet = (r.snippet || "").replace(/\s+/g, " ").slice(0, 80);
      console.log(`        ↳ found at #${rank}: ${r.rel_path}  "${snippet}…"`);
    }

    detailed.push({ ...c, status: status_, rank, containOk, resultCount: results.length, topResults: results.slice(0, 10).map(r => ({ rel_path: r.rel_path, title: r.title, rrfScore: r.rrfScore })) });
  }

  // ── Summary ─────────────────────────────────────────────
  const evalTotal = cases.filter(c => c.expected_paths.length > 0).length;
  const hitRateAtK = evalTotal > 0 ? hitsAtK / evalTotal : 0;
  const hitRateAt10 = evalTotal > 0 ? hitsAt10 / evalTotal : 0;
  const mrr = mrrCount > 0 ? mrrSum / mrrCount : 0;

  console.log(`\n┌─ Summary ────────────────────────────────────────────`);
  console.log(`│ Evaluable queries:  ${evalTotal} / ${cases.length}`);
  console.log(`│ Hit @${topK}:            ${hitsAtK} / ${evalTotal}  (${(hitRateAtK * 100).toFixed(1)}%)`);
  console.log(`│ Hit @10:           ${hitsAt10} / ${evalTotal}  (${(hitRateAt10 * 100).toFixed(1)}%)`);
  console.log(`│ MRR:               ${mrr.toFixed(3)}`);
  if (Object.keys(byDifficulty).length > 0) {
    console.log(`│`);
    console.log(`│ By difficulty:`);
    for (const [d, b] of Object.entries(byDifficulty).sort()) {
      const pct = b.total > 0 ? (b.hit / b.total * 100).toFixed(0) : "0";
      console.log(`│   ${d.padEnd(12)} ${b.hit}/${b.total}  (${pct}%)`);
    }
  }
  console.log(`└─────────────────────────────────────────────────────\n`);

  if (output) {
    const summary = {
      timestamp: new Date().toISOString(),
      vault: status.vault,
      noteCount: status.noteCount,
      chunkCount: status.chunkCount,
      embeddedCount: status.embeddedCount,
      embeddingProvider: status.embeddingProvider,
      testSet: setPath,
      totalQueries: cases.length,
      evaluableQueries: evalTotal,
      hitAtK: hitRateAtK,
      hitAt10: hitRateAt10,
      mrr,
      byDifficulty,
      results: detailed,
    };
    writeFileSync(output, JSON.stringify(summary, null, 2), "utf-8");
    console.log(`Detailed results written to: ${output}\n`);
  }
}

// ── Entry ────────────────────────────────────────────────
const args = parseArgs(process.argv.slice(2));
const setPath = args.set ? (args.set.startsWith("/") || args.set.includes(":\\") ? args.set : join(ROOT, args.set)) : join(ROOT, "test", "kb-eval-set.jsonl");

run({ topK: args.topK, setPath, output: args.output, limit: args.limit, verbose: args.verbose })
  .catch(e => {
    console.error("Fatal:", e.stack || e.message);
    process.exit(1);
  });
