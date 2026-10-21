// Keep the memory tests away from ~/.aideagent/memory. This must run before
// any test file imports memory-store.ts (vitest `setupFiles` does).
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

if (!process.env.AIDEAGENT_MEMORY_DIR) {
  process.env.AIDEAGENT_MEMORY_DIR = mkdtempSync(join(tmpdir(), "aideagent-memory-test-"));
}
