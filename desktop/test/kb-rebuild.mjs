#!/usr/bin/env node
/**
 * KB Index Rebuild — scan vault, re-chunk, re-embed, populate FTS + vectors
 *
 * Use this when the DB is in a broken state (e.g. partial rebuild, missing
 * embeddings after model change, or to apply new chunking logic).
 *
 * Usage: node test/kb-rebuild.mjs
 */
import { rebuildIndex, getStatus } from "../knowledge-store.mjs";

console.log("Pre-rebuild status:");
console.log(JSON.stringify(getStatus(), null, 2));

console.log("\nStarting full rebuild...\n");
const t0 = Date.now();
const result = await rebuildIndex((progress) => {
  const pct = progress.total > 0 ? Math.round(progress.indexed / progress.total * 100) : 0;
  process.stdout.write(`\r  ${pct}%  indexed=${progress.indexed}/${progress.total}  embedded=${progress.embedded}  chunks=${progress.chunked}  failed=${progress.failed}   `);
});
const dt = ((Date.now() - t0) / 1000).toFixed(1);
console.log("\n");

if (result.error) {
  console.error("Rebuild FAILED:", result.error);
  process.exit(1);
}

console.log("Rebuild complete in", dt, "seconds");
console.log(JSON.stringify(result, null, 2));

console.log("\nPost-rebuild status:");
console.log(JSON.stringify(getStatus(), null, 2));
