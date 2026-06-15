/**
 * SQLite database initialization for the knowledge base.
 *
 * Owns the singleton DB connection and the schema/migrations:
 *   - kb_notes     (note-level metadata)
 *   - kb_chunks    (chunk-level content, joined to notes)
 *   - kb_fts       (FTS5 virtual table over chunk_id, heading, content)
 *   - kb_embeddings (BLOB embedding per chunk, with dim tracking)
 *
 * Schema migration safety:
 *   - On startup, PRAGMA table_info() checks each table's columns. If an
 *     old note-level schema is detected (e.g. kb_fts without chunk_id), the
 *     table is dropped and recreated with the current schema.
 *   - The dim column on kb_embeddings records the embedding dimensionality
 *     at write time, so a future dim change (model switch) doesn't silently
 *     mix incompatible vectors.
 *
 * Pure schema + connection management. No scanning, no embedding, no search.
 */

import { DatabaseSync } from "node:sqlite";
import { DB_PATH } from "./config.mjs";

/** @type {DatabaseSync | null} */
let _db = null;
let _hasFts5 = false;

/**
 * Schema DDL for the four user tables. Exported so indexer.mjs can build
 * shadow tables (kb_*_new) with the exact same shape.
 *
 * Note: kb_fts uses FTS5 when available; the LIKE fallback is handled
 * separately in getDb().
 */
export const SCHEMA_DDL = {
  notes: `
    CREATE TABLE IF NOT EXISTS kb_notes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      rel_path TEXT UNIQUE NOT NULL,
      filename TEXT NOT NULL,
      title TEXT DEFAULT '',
      tags TEXT DEFAULT '[]',
      word_count INTEGER DEFAULT 0,
      mtime_ms INTEGER,
      created_at TEXT,
      updated_at TEXT
    )`,
  chunks: `
    CREATE TABLE IF NOT EXISTS kb_chunks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      note_id INTEGER NOT NULL,
      chunk_index INTEGER DEFAULT 0,
      heading TEXT DEFAULT '',
      content TEXT NOT NULL,
      FOREIGN KEY(note_id) REFERENCES kb_notes(id) ON DELETE CASCADE
    )`,
  embeddings: `
    CREATE TABLE IF NOT EXISTS kb_embeddings (
      chunk_id INTEGER PRIMARY KEY,
      embedding BLOB NOT NULL,
      dim INTEGER NOT NULL,
      FOREIGN KEY(chunk_id) REFERENCES kb_chunks(id) ON DELETE CASCADE
    )`,
  fts5: `
    CREATE VIRTUAL TABLE IF NOT EXISTS kb_fts USING fts5(
      chunk_id UNINDEXED,
      heading,
      content,
      tokenize='unicode61'
    )`,
  ftsFallback: `
    CREATE TABLE IF NOT EXISTS kb_fts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chunk_id INTEGER,
      heading TEXT,
      content TEXT
    )`,
};

/**
 * Internal-state lookup table. Currently used for rebuild_lock; designed
 * to be extensible (last_rebuild_at, embedding_model_version, etc.).
 */
export const META_DDL = `
  CREATE TABLE IF NOT EXISTS kb_meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )
`;

/**
 * Get (or create) the singleton DB connection.
 * Lazy-initialized so first-time users don't pay the cost until they
 * actually need the DB.
 */
export function getDb() {
  if (_db) return _db;
  _db = new DatabaseSync(DB_PATH);
  _db.exec("PRAGMA journal_mode=WAL");
  _db.exec("PRAGMA foreign_keys=ON");
  // Wait up to 5s for write locks held by other processes (e.g. second
  // AideAgent instance) instead of failing immediately with SQLITE_BUSY.
  _db.exec("PRAGMA busy_timeout=5000");

  // ── Startup recovery: drop stale shadow tables if a previous
  //    rebuild was interrupted. Safe to run on every getDb() call.
  //    Must run AFTER kb_meta exists (so we can query the lock row).
  _db.exec(META_DDL);
  try {
    const lock = _db.prepare("SELECT value FROM kb_meta WHERE key = 'rebuild_lock'").get();
    if (lock) {
      _db.exec("DROP TABLE IF EXISTS kb_fts_new");
      _db.exec("DROP TABLE IF EXISTS kb_embeddings_new");
      _db.exec("DROP TABLE IF EXISTS kb_chunks_new");
      _db.exec("DROP TABLE IF EXISTS kb_notes_new");
      _db.prepare("DELETE FROM kb_meta WHERE key = 'rebuild_lock'").run();
      console.warn("[kb] cleaned up stale shadow tables from interrupted rebuild");
    }
  } catch (e) {
    // Defensive: in case kb_meta doesn't exist yet on first run.
    console.warn("[kb] startup recovery check skipped:", e.message);
  }

  // ── User tables (notes, chunks, embeddings) ─────────────
  _db.exec(SCHEMA_DDL.notes);
  _db.exec(SCHEMA_DDL.chunks);

  // ── FTS5 with LIKE fallback ─────────────────────────────
  try {
    _db.exec(SCHEMA_DDL.fts5);
    // Verify the table actually has chunk_id column (schema migration check)
    const cols = _db.prepare("PRAGMA table_info(kb_fts)").all();
    const hasChunkId = cols.some(c => String(c.name) === "chunk_id");
    if (!hasChunkId) {
      _db.exec("DROP TABLE IF EXISTS kb_fts");
      _db.exec(SCHEMA_DDL.fts5);
    }
    _hasFts5 = true;
    console.log("[kb] FTS5 available (chunk-level)");
  } catch (e) {
    console.log("[kb] FTS5 not available, using LIKE search:", e.message);
    _hasFts5 = false;
    try {
      _db.exec(SCHEMA_DDL.ftsFallback);
    } catch (e2) {
      _logError("db", e2);
    }
  }

  // Chunk-level embeddings: check column structure first to avoid dropping
  // data on each startup
  {
    const embCols = _db.prepare("PRAGMA table_info(kb_embeddings)").all();
    const hasChunkId = embCols.some(c => String(c.name) === "chunk_id");
    if (!hasChunkId) {
      // Old note-level schema — drop and recreate
      _db.exec("DROP TABLE IF EXISTS kb_embeddings");
    }
  }
  _db.exec(SCHEMA_DDL.embeddings);

  return _db;
}

/** Whether the current DB has FTS5 (vs the LIKE fallback). */
export function hasFts5() {
  return _hasFts5;
}

// ── Error reporting (registered by main module) ───────────

let _logError = (bucket, err) => {
  const msg = err?.message || String(err);
  console.warn(`[kb] ${bucket} error: ${msg.slice(0, 200)}`);
};

export function _registerLogger(fn) {
  _logError = fn;
}
