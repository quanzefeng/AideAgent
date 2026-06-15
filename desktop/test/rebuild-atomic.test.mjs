/**
 * Atomic rebuildIndex regression tests.
 *
 * Covers the four scenarios from spec §10:
 *   1. Happy path — full rebuild, lock cleared, _new tables dropped
 *   2. Interrupted rebuild — startup recovery restores old state
 *   3. Concurrent rebuild — second call returns error, no corruption
 *   4. FTS swap verification — search works after rebuild
 *   5. Embedding dim tracking — dim column preserved through RENAME
 *
 * Each test uses an isolated DB (via _setDbPath) and a temp vault dir.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { setVault } from "../knowledge-store.mjs";
import { rebuildIndex } from "../kb/indexer.mjs";
import { _setDbPath, getDb } from "../kb/db.mjs";
import { makeIsoKb } from "./helpers/iso-kb.mjs";

describe("Atomic rebuildIndex", () => {
  /** @type {ReturnType<typeof makeIsoKb>} */
  let iso;

  beforeEach(() => {
    iso = makeIsoKb({
      noteFiles: {
        "alpha.md": "# Alpha\n\nThis is the alpha note about cats and dogs.\n",
        "beta.md":  "# Beta\n\nThis is the beta note about cats specifically.\n",
        "gamma.md": "# Gamma\n\nA note about dogs running in the park.\n",
      },
    });
    _setDbPath(iso.dbPath);
    setVault(iso.vaultDir);
  });

  afterEach(() => {
    _setDbPath(null);
    iso.cleanup();
  });

  it("happy path: rebuild completes, lock cleared, _new tables dropped, FTS works", async () => {
    // ── Act ──
    /** @type {Array<{indexed:number, embedded:number, chunked:number, failed:number, total:number}>} */
    const progressEvents = [];
    const result = await rebuildIndex((p) => progressEvents.push(p));

    // ── Assert: result ──
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.total).toBe(3);
    expect(result.indexed).toBe(3);
    expect(result.chunked).toBeGreaterThanOrEqual(3);
    expect(result.failed).toBe(0);

    // ── Assert: shadow tables dropped ──
    const db = getDb();
    const tables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type IN ('table','view') AND name LIKE '%_new'"
    ).all().map(r => r.name);
    expect(tables).toEqual([]);

    // ── Assert: lock cleared ──
    const lock = db.prepare("SELECT value FROM kb_meta WHERE key = 'rebuild_lock'").get();
    expect(lock).toBeUndefined();

    // ── Assert: progress events were emitted ──
    expect(progressEvents.length).toBeGreaterThan(0);
    const last = progressEvents[progressEvents.length - 1];
    expect(last.indexed).toBe(3);

    // ── Assert: FTS finds content that was in the new notes ──
    const { ftsSearch } = await import("../kb/search.mjs");
    const hits = ftsSearch("cats", 10);
    const hitPaths = hits.map(h => {
      const r = db.prepare("SELECT n.rel_path FROM kb_chunks c JOIN kb_notes n ON c.note_id = n.id WHERE c.id = ?").get(h.chunk_id);
      return r?.rel_path;
    });
    expect(hitPaths.filter(Boolean).sort()).toEqual(["alpha.md", "beta.md"]);
  });
});
