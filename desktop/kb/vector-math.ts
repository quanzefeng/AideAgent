/**
 * Vector math utilities for the knowledge base.
 *
 * Pure functions only — no IO, no shared state. Used by:
 *   - The indexer to store embeddings as BLOBs
 *   - The search path to compute cosine similarity
 *
 * Re-exported from knowledge-store.mjs for backward compatibility.
 */

export function vectorToBuffer(vec: Float32Array): Buffer {
  return Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength);
}

export function bufferToVector(buf: Buffer): Float32Array {
  return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
}

export function cosineSimilarity(a: Float32Array | number[], b: Float32Array | number[]): number {
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
