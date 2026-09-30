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

export function reciprocalRankFusion(resultLists: Array<Array<{ id: number, rank?: number }>>, k = 60): Array<{ id: number, score: number }> {
  const scores = new Map<number, number>();
  for (const results of resultLists) {
    results.forEach((doc: { id: number, rank?: number }, index: number) => {
      const rank = index + 1;
      const rrfScore = 1 / (k + rank);
      const id = typeof doc === "object" ? doc.id : (doc as number);
      scores.set(id, (scores.get(id) || 0) + rrfScore);
    });
  }
  return [...scores.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([id, score]) => ({ id, score }));
}
