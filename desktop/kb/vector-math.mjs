/**
 * Vector math utilities for the knowledge base.
 *
 * Pure functions only — no IO, no shared state. Used by:
 *   - The indexer to store embeddings as BLOBs
 *   - The search path to compute cosine similarity
 *
 * Re-exported from knowledge-store.mjs for backward compatibility.
 */

/** @param {Float32Array} vec @returns {Buffer} */
export function vectorToBuffer(vec) {
  return Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength);
}

/** @param {Buffer} buf @returns {Float32Array} */
export function bufferToVector(buf) {
  return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
}

/** @param {Float32Array|number[]} a @param {Float32Array|number[]} b @returns {number} */
export function cosineSimilarity(a, b) {
  if (a.length !== b.length) {
    console.warn(`[kb] Dimension mismatch in similarity: ${a.length} vs ${b.length}. Rebuild index.`);
    return 0;
  }
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}
