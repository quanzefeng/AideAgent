/**
 * Hybrid RAG search: FTS5 + vector embeddings + query rewriting + LLM rerank.
 *
 * Architecture:
 *   1. Query rewriting: 3-5 semantic variants via small local chat model
 *   2. FTS5 + vector search per variant
 *   3. RRF (Reciprocal Rank Fusion) to combine
 *   4. "I don't know" gate (no results if neither list has confident matches)
 *   5. Optional LLM rerank of top-N
 *
 * FTS5 query strings are sanitized via sanitizeFtsTerm() to prevent
 * injection of FTS5 operators.
 *
 * Thresholds (VECTOR_SIMILARITY_FLOOR, VECTOR_CONFIDENT_SIM, MIN_TOP_RRF_SCORE)
 * are derived empirically from the user's vault stats and documented inline.
 */

import { getDb, hasFts5 } from "./db.mjs";
import { getVault, getConfig } from "./config.mjs";
import { embedText } from "./embedder.mjs";
import { bufferToVector, cosineSimilarity } from "./vector-math.mjs";
import { spaceCJK, sanitizeFtsTerm } from "./text-utils.mjs";
import { _logError } from "./log.mjs";

// ── FTS Operations ────────────────────────────────────────

/** Delete all FTS entries for chunks belonging to a specific note (by rel_path). */
export function ftsDeleteByRelPath(relPath) {
  try {
    const db = getDb();
    // Get chunk IDs for this note, then delete them from FTS
    const noteRows = db.prepare("SELECT id FROM kb_notes WHERE rel_path = ?").all(relPath);
    if (noteRows.length === 0) return;
    const noteId = Number(noteRows[0].id);
    const chunks = db.prepare("SELECT id FROM kb_chunks WHERE note_id = ?").all(noteId);
    const stmt = db.prepare("DELETE FROM kb_fts WHERE chunk_id = ?");
    for (const ch of chunks) {
      try { stmt.run(Number(ch.id)); }
      catch (/** @type {any} */ e) { _logError("fts", e); }
    }
  } catch (/** @type {any} */ e) {
    // FTS5 delete failures leak ghost rows; surfaced via getStatus().
    _logError("fts", e);
  }
}

/** Delete a single chunk from FTS by chunk_id. */
export function ftsDeleteChunk(chunkId) {
  try { getDb().prepare("DELETE FROM kb_fts WHERE chunk_id = ?").run(chunkId); }
  catch (/** @type {any} */ e) { _logError("fts", e); }
}

/** Insert a chunk into FTS. */
export function ftsInsertChunk(chunkId, heading, content) {
  try {
    const spacedHeading = spaceCJK(heading || "");
    getDb().prepare("INSERT INTO kb_fts(chunk_id, heading, content) VALUES (?,?,?)")
      .run(chunkId, spacedHeading, spaceCJK(content || ""));
  } catch (/** @type {any} */ e) {
    console.error("[kb] ftsInsertChunk error:", e.message);
  }
}

/**
 * Insert a chunk into the shadow FTS table (kb_fts_new).
 * Used exclusively by rebuildIndex's Phase 1 (shadow table writes).
 * The shadow table has the same schema as kb_fts but is renamed during
 * the atomic swap; until then it coexists with kb_fts.
 */
export function ftsInsertChunkNew(chunkId, heading, content) {
  try {
    const spacedHeading = spaceCJK(heading || "");
    getDb().prepare("INSERT INTO kb_fts_new(chunk_id, heading, content) VALUES (?,?,?)")
      .run(chunkId, spacedHeading, spaceCJK(content || ""));
  } catch (/** @type {any} */ e) {
    console.error("[kb] ftsInsertChunkNew error:", e.message);
  }
}

/** @param {string} query @param {number} limit @returns {any[]} */
export function ftsSearch(query, limit) {
  const db = getDb();
  if (hasFts5()) {
    try {
      const terms = query.split(/\s+/).filter(Boolean);
      // Sanitize each term FIRST (strip FTS5 metacharacters like " * ( ) etc.),
      // THEN space out CJK characters. The order matters: if we spaced first
      // and sanitized second, the sanitizer would strip the spaces we just
      // added (its regex rejects everything that isn't \w / CJK / dash, and
      // space is none of those), collapsing the spaced query back to a single
      // token that never matches the per-character FTS5 index. (P0 fix —
      // empirically all 5 CJK tests returned 0 hits before this change.)
      const spacedTerms = terms
        .map(t => spaceCJK(sanitizeFtsTerm(t)))
        .filter(t => t.length > 0)
        .map(t => '"' + t + '"');
      if (spacedTerms.length === 0) return [];
      const matchExpr = spacedTerms.join(" ");
      return db.prepare(
        'SELECT rowid, chunk_id, heading, snippet(kb_fts, 2, \'<mark>\', \'</mark>\', \'…\', 256) as snippet FROM kb_fts WHERE kb_fts MATCH ? ORDER BY rank LIMIT ?'
      ).all(matchExpr, limit);
    } catch (/** @type {any} */ e) {
      _logError("fts", e);
      return [];
    }
  }
  // LIKE fallback
  try {
    return db.prepare(
      "SELECT id as rowid, chunk_id, heading, content as snippet FROM kb_fts WHERE heading LIKE ? OR content LIKE ? LIMIT ?"
    ).all("%" + query + "%", "%" + query + "%", limit);
  } catch (/** @type {any} */ e) {
    _logError("fts", e);
    return [];
  }
}

// ── Query Rewriting (LRU cache + Ollama chat model) ───────
// Turns "本地大模型" into ["本地大模型", "本地运行的大语言模型", "Ollama 本地模型", ...]
// Helps both FTS keyword matching AND vector similarity for short/conceptual queries.
const REWRITE_CACHE_MAX = 256;
const rewriteCache = new Map(); // query → variants[]
let _rewriteEverSucceeded = false;
/** @type {Map<string, Promise<string[]>>} */
let _rewriteInFlight = new Map(); // Map<query, Promise> for per-key concurrent-call coalescing

const REWRITE_PROMPT = `You are a search query rewriter for a personal Obsidian knowledge base.
Given a user's search query, output 3-5 alternative phrasings that would find the same information.
Rules:
- SHORT alternatives (3-15 words each)
- Mix synonyms, related concepts, and natural Chinese/English variations
- Output ONLY the alternatives, one per line, no numbering, no explanation

Query: {query}

Alternatives:`;

// ── LLM Reranking (LRU cache + Ollama chat model) ─────────
// Takes top-N RRF candidates and asks the LLM to pick the most relevant top-K.
// Last-mile precision boost that can fix cases where embedding models are
// overconfident on the wrong chunks (e.g. "本地大模型" → 数据宝地址 0.611).
const RERANK_CACHE_MAX = 128;
const rerankCache = new Map(); // "query|chunk_id1,chunk_id2,..." → indices[]
let _rerankEverSucceeded = false; // Tracks first-call cold start for adaptive timeout
/** @type {Map<string, Promise<any[]|null>>} */
let _rerankInFlight = new Map(); // Map<cacheKey, Promise> for per-key concurrent-call coalescing

const RERANK_PROMPT = `You are a relevance judge for a personal Obsidian knowledge base search.
Given a search query and a list of candidate results, output the indices (1-based) of the most relevant results IN ORDER OF RELEVANCE, comma-separated, no spaces, no other text.
Include only results that are actually relevant to the query. If a result is not relevant, OMIT its index.

Query: {query}

Candidates:
{candidates}

Most relevant indices (comma-separated):`;

// ── Hybrid Search ─────────────────────────────────────────

// "I don't know" thresholds — empirically derived from your vault stats.
// VECTOR_SIMILARITY_FLOOR: with N=1345 chunks of 384-dim normalized vectors,
//   E[max random similarity] ≈ √(2·ln(N)/N) ≈ 0.08. Anything below 0.25 is
//   almost certainly noise from a query that has no semantic match in the vault.
// VECTOR_CONFIDENT_SIM: when FTS has no keyword matches, the query has no
//   lexical anchor. MiniLM-L6 is overconfident on short Chinese queries
//   (e.g. "本地大模型" → 数据宝地址 0.611, a non-match), so we require
//   >0.55 to be sure the match is real. This filters pure noise like
//   "asdfghjkl" (0.504), 焦虑 (0.424), 小说 (0.498).
// MIN_TOP_RRF_SCORE: even with FTS hit, a top RRF < 0.012 means rank ≥ 84 in a
//   single list — effectively random. Return [] rather than force-answer.
const VECTOR_SIMILARITY_FLOOR = 0.25;
const VECTOR_CONFIDENT_SIM = 0.55;
const MIN_TOP_RRF_SCORE = 0.012;

/**
 * Expand a query into 3-5 semantic variants using a small local chat model.
 * Falls back to [query] if rewrite is disabled, model unavailable, or times out.
 * @param {string} query
 * @returns {Promise<string[]>}
 */
async function rewriteQuery(query) {
  const cfg = getConfig();
  if (cfg.queryRewriteEnabled === false) return [query];
  const cacheKey = query.toLowerCase().trim();
  if (rewriteCache.has(cacheKey)) return rewriteCache.get(cacheKey);
  // Coalesce concurrent calls PER KEY — if a rewrite for the same query is
  // already in flight, share its promise. Previously a single shared promise
  // caused query B to silently get query A's variant set (cross-query leakage).
  const existing = _rewriteInFlight.get(cacheKey);
  if (existing) return existing;

  const promise = (async () => {
    const model = cfg.queryRewriteModel || "qwen3.5:9b";
    // First call may need to load the model into RAM (cold start). Adaptive timeout.
    const isFirstCall = rewriteCache.size === 0 && !_rewriteEverSucceeded;
    const timeoutMs = isFirstCall ? 30000 : 3000;
    try {
      const res = await fetch("http://localhost:11434/api/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model,
          prompt: REWRITE_PROMPT.replace("{query}", query),
          stream: false,
          options: { temperature: 0.3, num_predict: 200, num_ctx: 512 },
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) return [query];
      const data = await res.json();
      const variants = String(data.response || "")
        .split("\n")
        .map((s) => s.trim().replace(/^[\d\-\.\)\*]+\s*/, ""))
        .filter((s) => s.length >= 2 && s.length <= 100 && s.toLowerCase() !== cacheKey)
        .slice(0, 5);
      const result = variants.length > 0 ? [query, ...variants] : [query];
      // LRU cache (evict oldest when full)
      if (rewriteCache.size >= REWRITE_CACHE_MAX) {
        const firstKey = rewriteCache.keys().next().value;
        rewriteCache.delete(firstKey);
      }
      rewriteCache.set(cacheKey, result);
      _rewriteEverSucceeded = true;
      return result;
    } catch (/** @type {any} */ e) {
      _logError("rewrites", e);
      return [query]; // Quietly fall back to original query
    } finally {
      _rewriteInFlight.delete(cacheKey); // Release per-key in-flight slot
    }
  })();
  _rewriteInFlight.set(cacheKey, promise);
  return promise;
}

/** @param {string} query @param {number} [limit] @returns {Promise<Array<{id:number, rel_path:string, title:string, tags:string[], snippet:string, heading:string, rrfScore:number}>>} */
export async function search(query, limit = 5) {
  if (!getVault()) return [];
  if (!query || !query.trim()) return [];

  const db = getDb();
  const searchLimit = limit * 3; // Over-fetch for RRF

  // 0. Query rewriting: get semantic variants (original + expansions).
  // Falls back to [query] if rewrite disabled, model unavailable, or times out.
  const variants = await rewriteQuery(query);

  // Pre-load all chunk vectors ONCE (avoid re-scanning for each variant).
  // Guard against runaway memory: a 384-dim Float32 vector is 1.5KB raw +
  // ~100B JS overhead. At 50K chunks this is ~75MB per concurrent search call.
  const allEmbeddings = db.prepare("SELECT chunk_id, embedding FROM kb_embeddings").all();
  if (allEmbeddings.length > 50000) {
    console.warn(
      `[kb] Large vector index (${allEmbeddings.length} chunks). ` +
      `Consider sqlite-vec extension or a smaller chunk size. ` +
      `Latency and memory will degrade linearly with chunk count.`
    );
  }
  /** @type {Array<{id:number, vec:Float32Array}>} */
  const allChunkVectors = allEmbeddings.map((r) => ({
    id: r.chunk_id,
    vec: bufferToVector(r.embedding),
  }));

  // 1+2. For each variant, run FTS + vector search in parallel.
  /** @type {Array<{ftsIds:Array<{id:number, rank:number, ftsResult:any}>, vecIds:Array<{id:number, rank:number}>, ftsResults:any[], topSim:number}>} */
  const variantResults = await Promise.all(variants.map(async (variant) => {
    const fts = ftsSearch(variant, searchLimit);
    const ftsIds = fts
      .map((r, i) => ({ id: Number(r.chunk_id), rank: i, ftsResult: r }))
      .filter((x) => x.id > 0);

    /** @type {Array<{id:number, rank:number}>} */
    let vecIds = [];
    let topSim = 0;
    try {
      const qe = await embedText(variant);
      if (qe) {
        const scored = allChunkVectors
          .map((c) => ({ id: c.id, sim: cosineSimilarity(qe, c.vec) }))
          .filter((r) => r.sim > VECTOR_SIMILARITY_FLOOR)
          .sort((a, b) => b.sim - a.sim);
        topSim = scored.length > 0 ? scored[0].sim : 0;
        vecIds = scored.slice(0, searchLimit).map((r, i) => ({ id: r.id, rank: i }));
      }
    } catch (/** @type {any} */ e) {
      console.error(`[kb] embedText failed for variant "${variant.slice(0, 50)}": ${e.message}`);
    }

    return { ftsIds, vecIds, ftsResults: fts, topSim };
  }));

  // 3. Aggregate RRF scores across all variants using MAX-per-variant.
  // For each variant, compute its (FTS + vector) RRF sum. For each chunk, keep
  // the best RRF score across all variants. This way a chunk that's a perfect
  // match for ONE variant (but noise for the others) still gets a high score.
  // The previous sum/Normalize approach was silently dropping such chunks.
  /** @type {Map<number, {score:number, ftsResult:any}>} */
  const chunkScores = new Map();
  let totalFtsHits = 0;
  // Only use the ORIGINAL query's vector sim for the "I don't know" gate —
  // a garbage rewritten variant's accidental high similarity should NOT
  // bypass the gate. (Bug fix: previously used max across all variants.)
  const originalTopVectorSim = variantResults[0]?.topSim || 0;
  for (const vr of variantResults) {
    totalFtsHits += vr.ftsIds.length;
    // Per-variant RRF: sum within this variant's FTS+vector lists
    /** @type {Map<number, number>} */
    const variantScores = new Map();
    for (const { id, rank, ftsResult } of vr.ftsIds) {
      variantScores.set(id, (variantScores.get(id) || 0) + 1 / (60 + rank + 1));
      // Capture the first FTS result we see (used for snippet later)
      if (!chunkScores.has(id) || !chunkScores.get(id).ftsResult) {
        if (ftsResult) {
          const cur = chunkScores.get(id) || { score: 0, ftsResult: null };
          cur.ftsResult = ftsResult;
          chunkScores.set(id, cur);
        }
      }
    }
    for (const { id, rank } of vr.vecIds) {
      variantScores.set(id, (variantScores.get(id) || 0) + 1 / (60 + rank + 1));
    }
    // For each chunk in this variant, take max with previous best
    for (const [id, vScore] of variantScores) {
      const cur = chunkScores.get(id) || { score: 0, ftsResult: null };
      if (vScore > cur.score) cur.score = vScore;
      chunkScores.set(id, cur);
    }
  }
  // Max possible score ≈ single-list top rank (1/61 ≈ 0.0164), so MIN_TOP_RRF_SCORE (0.012) still works.
  const fusedChunks = [...chunkScores.entries()]
    .map(([id, { score, ftsResult }]) => ({ id, score, ftsResult }))
    .sort((a, b) => b.score - a.score);

  // 3.1 "I don't know" gate — early bail.
  // Uses ORIGINAL query's vector sim only (not max across variants) to avoid
  // a garbage rewritten variant's accidental high similarity from bypassing
  // the gate.
  if (totalFtsHits === 0 && originalTopVectorSim < VECTOR_CONFIDENT_SIM) {
    return [];
  }
  if (!fusedChunks.length || fusedChunks[0].score < MIN_TOP_RRF_SCORE) {
    return [];
  }

  // 4. Aggregate chunks by parent note — for each note, keep only its best chunk
  /** @type {Map<number, {noteId:number, chunkId:number, score:number, heading:string, snippet:string}>} */
  const bestPerNote = new Map();
  const chunkToNote = new Map();

  // Batched lookup: single query for all chunk IDs instead of N+1.
  // If fusedChunks is large (50-150), this is a 100x+ speedup.
  if (fusedChunks.length > 0) {
    try {
      const ids = fusedChunks.map((c) => c.id);
      const placeholders = ids.map(() => "?").join(",");
      const rows = db.prepare(
        `SELECT id, note_id, heading, content FROM kb_chunks WHERE id IN (${placeholders})`
      ).all(...ids);
      for (const row of rows) {
        chunkToNote.set(Number(row.id), {
          noteId: Number(row.note_id),
          heading: String(row.heading),
          content: String(row.content),
        });
      }
    } catch (/** @type {any} */ e) {
      console.error(`[kb] batched chunk lookup failed: ${e.message}`);
    }
  }

  for (const { id: chunkId, score, ftsResult } of fusedChunks) {
    const mapping = chunkToNote.get(chunkId);
    if (!mapping) continue;
    const { noteId, heading, content } = mapping;

    // Use the FTS snippet if any variant contributed an FTS hit; else fall
    // back to first 300 chars of the chunk content.
    const snippet = ftsResult?.snippet || content.slice(0, 300);

    if (!bestPerNote.has(noteId) || score > bestPerNote.get(noteId).score) {
      bestPerNote.set(noteId, { noteId, chunkId, score, heading, snippet });
    }
  }

  // 5. Sort notes by their best chunk's score, return top-K
  // 5. Aggregate chunks by parent note (best per note) — hydrate full results.
  // Take top `rerankTopN` (independent of `limit`) so LLM rerank has a buffer
  // to swap in better candidates. e.g. limit=5 + rerankTopN=30 → fetch 30, rerank, return 5.
  const rerankTopN = getConfig().rerankTopN || 30;
  const sortedNotes = [...bestPerNote.entries()]
    .sort((a, b) => b[1].score - a[1].score)
    .slice(0, rerankTopN);

  /** @type {Array<{id:number, rel_path:string, title:string, tags:string[], snippet:string, heading:string, rrfScore:number}>} */
  const candidates = [];
  for (const [noteId, best] of sortedNotes) {
    try {
      const note = db.prepare("SELECT * FROM kb_notes WHERE id = ?").get(noteId);
      if (!note) continue;
      candidates.push({
        id: Number(note.id),
        rel_path: String(note.rel_path),
        title: String(note.title),
        tags: JSON.parse(String(note.tags || "[]")),
        snippet: best.snippet,
        heading: best.heading,
        rrfScore: best.score,
      });
    } catch (/** @type {any} */ e) {
      // Per-candidate hydration failure: skip this candidate and continue
      // with the rest. If this fires often, the index may be corrupt.
      _logError("db", e);
    }
  }

  // 6. Optional LLM rerank — reorders candidates by semantic relevance.
  // Falls back gracefully to RRF order if model is unavailable / times out.
  if (candidates.length > limit) {
    const reranked = await rerankResults(query, candidates, limit);
    if (reranked && reranked.length > 0) return reranked;
  }
  return candidates.slice(0, limit);
}

/**
 * Use a small local chat model to rerank top-N candidates by relevance to the query.
 * Cache key: query + ordered list of candidate ids (so the same query against
 * the same index state returns the same rerank without an LLM call).
 * @param {string} query
 * @param {Array<{id:number, rel_path:string, title:string, snippet:string}>} candidates
 * @param {number} limit
 * @returns {Promise<Array<any>|null>} Reranked top-`limit`, or null on failure
 */
async function rerankResults(query, candidates, limit) {
  const cfg = getConfig();
  if (cfg.rerankEnabled === false) return null;

  // Cache: identical query + identical candidate set → reuse previous order
  const cacheKey = query.toLowerCase().trim() + "|" + candidates.map((c) => c.id).join(",");
  if (rerankCache.has(cacheKey)) {
    const cachedIndices = rerankCache.get(cacheKey);
    return cachedIndices.map((i) => candidates[i]).filter(Boolean).slice(0, limit);
  }
  // Coalesce concurrent calls PER KEY — share promise for identical query+set.
  // Previously a single shared promise leaked the first in-flight's result to
  // every concurrent call (cross-query contamination).
  const existing = _rerankInFlight.get(cacheKey);
  if (existing) return existing;

  const promise = (async () => {
    const model = cfg.rerankModel || "gemma4:e4b";
    // Build the candidates block: title + truncated snippet. Keep snippets small
    // (150 chars) so 15 candidates fit comfortably in a 4K-token context.
    const items = candidates
      .map((c, i) => `[${i + 1}] ${c.title}\n${(c.snippet || "").slice(0, 150).replace(/\s+/g, " ")}`)
      .join("\n\n");
    const prompt = RERANK_PROMPT
      .replace("{query}", query)
      .replace("{candidates}", items);

    // First call may need to load the model into RAM (10-30s on cold start).
    // Adaptive timeout: 30s for the first call, 8s for warm ones.
    const isFirstCall = rerankCache.size === 0 && !_rerankEverSucceeded;
    const timeoutMs = isFirstCall ? 30000 : 8000;

    try {
      const res = await fetch("http://localhost:11434/api/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model,
          prompt,
          stream: false,
          options: { temperature: 0.0, num_predict: 200, num_ctx: 4096 },
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) return null;
      const data = await res.json();
      const text = String(data.response || "");
      // Parse "3,1,5,2" → [3, 1, 5, 2]; tolerate "3 1 5 2" or "3,1,5,2,"
      const parsed = text
        .match(/\d+/g)
        ?.map((s) => parseInt(s, 10) - 1)
        .filter((i) => i >= 0 && i < candidates.length) || [];
      // Dedup while preserving order
      const seen = new Set();
      const unique = [];
      for (const i of parsed) {
        if (!seen.has(i)) {
          seen.add(i);
          unique.push(i);
        }
      }
      if (unique.length === 0) return null;
      // LRU cache (evict oldest)
      if (rerankCache.size >= RERANK_CACHE_MAX) {
        const firstKey = rerankCache.keys().next().value;
        rerankCache.delete(firstKey);
      }
      rerankCache.set(cacheKey, unique);
      _rerankEverSucceeded = true;
      return unique.slice(0, limit).map((i) => candidates[i]);
    } catch (/** @type {any} */ e) {
      _logError("reranks", e);
      return null; // Quietly fall back to RRF order
    } finally {
      _rerankInFlight.delete(cacheKey); // Release per-key in-flight slot
    }
  })();
  _rerankInFlight.set(cacheKey, promise);
  return promise;
}
