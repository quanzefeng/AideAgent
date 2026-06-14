/**
 * Reciprocal Rank Fusion (RRF) for combining FTS and vector search results.
 *
 * RRF is a parameter-free rank-aggregation method. For each result list, it
 * assigns 1/(k + rank) to each item, then sums across lists. This is more
 * robust than score-based fusion because it doesn't require the constituent
 * scorers to be calibrated against each other.
 *
 * Pure function — no IO, no shared state.
 *
 * Re-exported from knowledge-store.mjs for backward compatibility.
 */

/** @param {Array<Array<{id:number, rank?:number}>>} resultLists @param {number} [k] @returns {Array<{id:number, score:number}>} */
export function reciprocalRankFusion(resultLists, k = 60) {
  const scores = new Map();
  for (const results of resultLists) {
    results.forEach((doc, index) => {
      const rank = index + 1;
      const rrfScore = 1 / (k + rank);
      const id = typeof doc === "object" ? doc.id : doc;
      scores.set(id, (scores.get(id) || 0) + rrfScore);
    });
  }
  return [...scores.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([id, score]) => ({ id, score }));
}
