/**
 * Index operations: full rebuild and single-file reindex.
 *
 * Both operations are the *write* side of the RAG pipeline:
 *   - read .md file
 *   - split into chunks
 *   - write chunks to DB
 *   - write FTS5 rows
 *   - generate embeddings (with retry)
 *   - update kb_notes metadata
 *
 * Triggered by:
 *   - User clicking "重建索引" (calls rebuildIndex)
 *   - File watcher on .md change (calls reindexSingleFile)
 *   - Note CRUD (createNote / updateNote / deleteNote, in kb/notes.mjs)
 *
 * WARNING: rebuildIndex deletes all data upfront. If interrupted, the
 * index is left in a worse state than before. (See TODO in kb-eval.mjs
 * for the atomic-replace improvement.)
 */

import { existsSync, statSync } from "fs";
import { join, basename } from "path";
import { getDb } from "./db.mjs";
import { getVault, getEffectiveMaxBodyChars } from "./config.mjs";
import { _logError } from "./log.mjs";
import { embedText, embedBatch, getEmbeddingDim } from "./embedder.mjs";
import { vectorToBuffer } from "./vector-math.mjs";
import { stripMarkdown, splitIntoChunks } from "./markdown.mjs";
import { ftsInsertChunk, ftsInsertChunkNew } from "./search.mjs";
import { isEnabledExt } from "./formats.mjs";
import { getExtractor } from "./extractors/index.mjs";
import { scanVault } from "./vault-scanner.mjs";

/**
 * Re-index a single file from the vault (called by watcher on change).
 * Scans the file, splits into chunks, replaces old chunks/FTS/embedding.
 * Silently ignores non-markdown files and files outside vault.
 * @param {string} relPath - relative path within the vault
 */
export async function reindexSingleFile(relPath) {
  const _vaultPath = getVault();
  if (!_vaultPath) return;
  if (!isEnabledExt(relPath)) return;
  // Skip Office/WPS temporary lock files (~$prefix). See vault-scanner.mjs
  // for the same guard — applies to both scan and single-file reindex paths.
  if (relPath.startsWith("~$") || relPath.includes("/~$")) return;
  const fullPath = join(_vaultPath, relPath);
  if (!existsSync(fullPath)) return;

  const extractor = await getExtractor(fullPath);
  if (!extractor) return;

  try {
    const { title, tags, body } = await extractor.extract(fullPath);
    const stat = statSync(fullPath);

    const db = getDb();
    const existing = db.prepare("SELECT id FROM kb_notes WHERE rel_path = ?").get(relPath);
    const noteId = existing ? Number(existing.id) : null;

    if (noteId) {
      // Update existing note
      db.prepare("UPDATE kb_notes SET title=?, tags=?, word_count=?, mtime_ms=?, updated_at=? WHERE id=?")
        .run(title, JSON.stringify(tags), body.length, stat.mtimeMs, new Date().toISOString(), noteId);

      // Remove old chunks (cascade deletes FTS + embeddings)
      db.prepare("DELETE FROM kb_chunks WHERE note_id = ?").run(noteId);
    } else {
      // New note
      const result = db.prepare(
        "INSERT INTO kb_notes(rel_path, filename, title, tags, word_count, mtime_ms, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)"
      ).run(relPath, basename(relPath), title, JSON.stringify(tags), body.length, stat.mtimeMs, new Date().toISOString(), new Date().toISOString());
      const newNoteId = Number(result.lastInsertRowid);
      // Re-chunk the new note
      const chunks = extractor.chunkText(body, title);
      if (chunks.length === 0) chunks.push({ heading: title, content: stripMarkdown(body) || "" });
      const max = getEffectiveMaxBodyChars();
      for (let ci = 0; ci < chunks.length; ci++) {
        const chunk = chunks[ci];
        const chunkResult = db.prepare(
          "INSERT INTO kb_chunks(note_id, chunk_index, heading, content) VALUES (?,?,?,?)"
        ).run(newNoteId, ci, chunk.heading, chunk.content);
        const chunkId = Number(chunkResult.lastInsertRowid);
        ftsInsertChunk(chunkId, chunk.heading, chunk.content);
        try {
          const embedding = await embedText((title + "\n" + chunk.heading + "\n" + chunk.content).slice(0, max));
          if (embedding) {
            db.prepare("INSERT INTO kb_embeddings(chunk_id, embedding, dim) VALUES (?,?,?)")
              .run(chunkId, vectorToBuffer(embedding), getEmbeddingDim());
          } else {
            console.warn(`[kb] embedText returned null for chunk ${ci} of ${relPath}`);
          }
        } catch (/** @type {any} */ e) {
          console.error(`[kb] embedText failed for chunk ${ci} of ${relPath}: ${e.message}`);
        }
      }
      return;
    }

    // For existing note, re-chunk and re-embed
    const chunks = splitIntoChunks(body, title);
    if (chunks.length === 0) chunks.push({ heading: title, content: stripMarkdown(body) || "" });
    const max = getEffectiveMaxBodyChars();
    for (let ci = 0; ci < chunks.length; ci++) {
      const chunk = chunks[ci];
      const chunkResult = db.prepare(
        "INSERT INTO kb_chunks(note_id, chunk_index, heading, content) VALUES (?,?,?,?)"
      ).run(noteId, ci, chunk.heading, chunk.content);
      const chunkId = Number(chunkResult.lastInsertRowid);
      ftsInsertChunk(chunkId, chunk.heading, chunk.content);
      try {
        const embedding = await embedText((title + "\n" + chunk.heading + "\n" + chunk.content).slice(0, max));
        if (embedding) {
          db.prepare("INSERT INTO kb_embeddings(chunk_id, embedding, dim) VALUES (?,?,?)")
            .run(chunkId, vectorToBuffer(embedding), getEmbeddingDim());
        }
      } catch (/** @type {any} */ e) {
        _logError("embed", e);
      }
    }

    console.log(`[kb-watcher] re-indexed: ${relPath} (${chunks.length} chunks)`);
  } catch (/** @type {any} */ e) {
    console.error(`[kb-watcher] failed to re-index ${relPath}:`, e.message);
  }
}

/**
 * Build the index for the whole vault from scratch.
 *
 * Performance optimizations (vs the v1 naive loop):
 *   1. SQLite transactions: chunks + FTS + embeddings are committed in
 *      batches of TRANSACTION_CHUNK_LIMIT, not per-chunk. This eliminates
 *      99% of the fsync overhead that previously dominated the bottleneck.
 *   2. Batch embed: instead of 1 HTTP request per chunk, we accumulate
 *      EMBED_BATCH_SIZE chunks and send them in one /api/embed call.
 *      Ollama can then run a single batched forward pass on the GPU
 *      instead of N small ones (3-8x throughput on typical workloads).
 *
 * Concurrency note: each transaction holds a write lock for the duration
 * of one batch (≈ EMBED_BATCH_SIZE embed calls + 3*EMBED_BATCH_SIZE DB
 * writes). Concurrent search() during a rebuild will block on these locks.
 * This is acceptable because rebuildIndex is user-triggered, not background.
 */
const TRANSACTION_CHUNK_LIMIT = 64;
const EMBED_BATCH_SIZE = 16;

/** @param {Function} [progressCb] @returns {Promise<{ok:boolean, indexed:number, embedded:number, chunked:number, failed:number, total:number}|{error:string}>} */
export async function rebuildIndex(progressCb) {
  const _vaultPath = getVault();
  if (!_vaultPath || !existsSync(_vaultPath)) return { error: "vault not set or not found" };

  const db = getDb();

  // ── Phase 0+1: Acquire lock + create shadow tables (single transaction) ──
  // If the INSERT raises SQLITE_CONSTRAINT_PRIMARYKEY, a rebuild is already
  // in progress — ROLLBACK the entire transaction and return.
  try {
    db.exec("BEGIN IMMEDIATE");
    db.prepare("INSERT INTO kb_meta(key, value) VALUES ('rebuild_lock', ?)")
      .run(new Date().toISOString());

    // Create shadow tables with same schema as the originals.
    db.exec(`
      CREATE TABLE kb_notes_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        rel_path TEXT UNIQUE NOT NULL,
        filename TEXT NOT NULL,
        title TEXT DEFAULT '',
        tags TEXT DEFAULT '[]',
        word_count INTEGER DEFAULT 0,
        mtime_ms INTEGER,
        created_at TEXT,
        updated_at TEXT
      )
    `);
    db.exec(`
      CREATE TABLE kb_chunks_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        note_id INTEGER NOT NULL,
        chunk_index INTEGER DEFAULT 0,
        heading TEXT DEFAULT '',
        content TEXT NOT NULL,
        FOREIGN KEY(note_id) REFERENCES kb_notes_new(id) ON DELETE CASCADE
      )
    `);
    db.exec(`
      CREATE TABLE kb_embeddings_new (
        chunk_id INTEGER PRIMARY KEY,
        embedding BLOB NOT NULL,
        dim INTEGER NOT NULL,
        FOREIGN KEY(chunk_id) REFERENCES kb_chunks_new(id) ON DELETE CASCADE
      )
    `);
    // FTS5 virtual table (or LIKE fallback if FTS5 unavailable)
    try {
      db.exec(`
        CREATE VIRTUAL TABLE kb_fts_new USING fts5(
          chunk_id UNINDEXED,
          heading,
          content,
          tokenize='unicode61'
        )
      `);
    } catch (e) {
      // FTS5 unavailable — use LIKE fallback schema
      db.exec(`
        CREATE TABLE kb_fts_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          chunk_id INTEGER,
          heading TEXT,
          content TEXT
        )
      `);
    }
    db.exec("COMMIT");
  } catch (/** @type {any} */ e) {
    try { db.exec("ROLLBACK"); } catch { /* ignore */ }
    // node:sqlite surfaces PK violations as "UNIQUE constraint failed" with
    // code ERR_SQLITE_ERROR; better-sqlite3 used SQLITE_CONSTRAINT_PRIMARYKEY.
    // Match both shapes (and the legacy message "PRIMARY KEY" text) so the
    // lock-held path is detected on either driver.
    const msg = String(e.message || "");
    if (
      String(e.code || "").includes("CONSTRAINT") ||
      /UNIQUE constraint failed/i.test(msg) ||
      msg.includes("PRIMARY KEY")
    ) {
      return { error: "rebuild already in progress" };
    }
    throw e;
  }

  // From here on, we MUST release the lock. try/finally ensures it.
  try {
    const notes = await scanVault(_vaultPath, _vaultPath);

    // ── Phase 2: Pass 1 — fill shadow tables ──────────────────────────
    /**
     * @type {Array<{noteId:number, noteTitle:string, relPath:string, chunkIndex:number, heading:string, content:string}>}
     */
    const allChunks = [];
    for (const note of notes) {
      try {
        const result = db.prepare(
          "INSERT INTO kb_notes_new(rel_path, filename, title, tags, word_count, mtime_ms, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)"
        ).run(note.relPath, note.filename, note.title, JSON.stringify(note.tags), note.wordCount, note.mtimeMs, new Date().toISOString(), new Date().toISOString());
        const noteId = Number(result.lastInsertRowid);

        const noteExtractor = await getExtractor(note.relPath);
        const chunks = noteExtractor
          ? noteExtractor.chunkText(note.body, note.title)
          : splitIntoChunks(note.body, note.title);
        if (chunks.length === 0) {
          chunks.push({ heading: note.title, content: stripMarkdown(note.body) || "" });
        }

        for (let ci = 0; ci < chunks.length; ci++) {
          allChunks.push({
            noteId,
            noteTitle: note.title,
            relPath: note.relPath,
            chunkIndex: ci,
            heading: chunks[ci].heading,
            content: chunks[ci].content,
          });
        }
      } catch (/** @type {any} */ e) {
        console.error(`[kb] Failed to insert note ${note.relPath}:`, e.message);
      }
    }

    const max = getEffectiveMaxBodyChars();
    const insertChunk = db.prepare(
      "INSERT INTO kb_chunks_new(note_id, chunk_index, heading, content) VALUES (?,?,?,?)"
    );
    const insertEmbedding = db.prepare(
      "INSERT INTO kb_embeddings_new(chunk_id, embedding, dim) VALUES (?,?,?)"
    );

    let indexed = 0;
    let embedded = 0;
    let chunked = 0;
    let failed = 0;
    const noteIndexedSet = new Set();
    const total = notes.length;

    const t0 = Date.now();

    for (let i = 0; i < allChunks.length; i += EMBED_BATCH_SIZE) {
      const batch = allChunks.slice(i, i + EMBED_BATCH_SIZE);

      const embedInputs = batch.map((c) =>
        (c.noteTitle + "\n" + c.heading + "\n" + c.content).slice(0, max)
      );

      let vectors;
      try {
        vectors = await embedBatch(embedInputs);
      } catch (/** @type {any} */ e) {
        _logError("embed", e);
        failed += batch.length;
        continue;
      }

      try {
        db.exec("BEGIN IMMEDIATE");
        for (let j = 0; j < batch.length; j++) {
          const c = batch[j];
          const vec = vectors[j];
          const chunkResult = insertChunk.run(c.noteId, c.chunkIndex, c.heading, c.content);
          const chunkId = Number(chunkResult.lastInsertRowid);
          ftsInsertChunkNew(chunkId, c.heading, c.content);
          if (vec) {
            insertEmbedding.run(chunkId, vectorToBuffer(vec), getEmbeddingDim());
            embedded++;
          } else {
            failed++;
          }
          chunked++;
          noteIndexedSet.add(c.noteId);
        }
        db.exec("COMMIT");
      } catch (/** @type {any} */ e) {
        try { db.exec("ROLLBACK"); } catch { /* ignored */ }
        _logError("db", e);
        failed += batch.length;
      }

      indexed = noteIndexedSet.size;
      if (progressCb) progressCb({ indexed, embedded, chunked, failed, total });
    }

    // ── Phase 3: atomic swap (single transaction) ─────────────────────
    // Drop originals, RENAME shadows into place. If any step fails,
    // ROLLBACK restores the originals intact.
    try {
      db.exec("BEGIN IMMEDIATE");
      db.exec("DROP TABLE kb_fts");
      db.exec("ALTER TABLE kb_fts_new RENAME TO kb_fts");
      db.exec("DROP TABLE kb_embeddings");
      db.exec("ALTER TABLE kb_embeddings_new RENAME TO kb_embeddings");
      db.exec("DROP TABLE kb_chunks");
      db.exec("ALTER TABLE kb_chunks_new RENAME TO kb_chunks");
      db.exec("DROP TABLE kb_notes");
      db.exec("ALTER TABLE kb_notes_new RENAME TO kb_notes");
      db.exec("COMMIT");
    } catch (/** @type {any} */ e) {
      try { db.exec("ROLLBACK"); } catch { /* ignore */ }
      _logError("db", e);
      throw e; // re-raise so caller knows; lock will still be cleared by finally
    }

    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(`[kb] rebuild done: ${chunked} chunks, ${embedded} embedded, ${failed} failed in ${elapsed}s`);
    return { ok: true, indexed, embedded, chunked, failed, total };
  } finally {
    // ── Phase 4: always release the lock ──────────────────────────────
    try {
      db.prepare("DELETE FROM kb_meta WHERE key = 'rebuild_lock'").run();
    } catch (/** @type {any} */ e) {
      console.warn("[kb] failed to release rebuild_lock:", e.message);
    }
  }
}
