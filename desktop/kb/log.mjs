/**
 * Centralized error counter + logger.
 *
 * Counters are exposed via getStatus() so operators can detect degraded
 * operation (silent FTS drift, embed failures, etc.) without grepping logs.
 *
 * Pure data + console.warn — no IO, no shared state with other modules.
 */

/** @type {{rewrites:number, reranks:number, fts:number, embed:number, fs:number, db:number, total:number}} */
let _errCounts = { rewrites: 0, reranks: 0, fts: 0, embed: 0, fs: 0, db: 0, total: 0 };

/**
 * Increment an error counter and log a single-line warning.
 * Centralizing this prevents the prior pattern of 33+ unlogged catches.
 * @param {"rewrites"|"reranks"|"fts"|"embed"|"fs"|"db"} bucket
 * @param {any} err
 */
export function _logError(bucket, err) {
  if (!_errCounts[bucket]) _errCounts[bucket] = 0;
  _errCounts[bucket]++;
  _errCounts.total++;
  const msg = err?.message || String(err);
  // Truncate to keep logs readable
  console.warn(`[kb] ${bucket} error: ${msg.slice(0, 200)}`);
}

/** Return a snapshot of the current error counts (for getStatus). */
export function getErrorCounts() {
  return { ..._errCounts };
}
