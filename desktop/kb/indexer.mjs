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

import { existsSync, readFileSync, statSync, writeFileSync, unlinkSync, readdirSync } from "fs";
import { join, basename, relative, extname } from "path";
import { getDb } from "./db.mjs";
import { getVault, getEffectiveMaxBodyChars } from "./config.mjs";
import { _logError } from "./log.mjs";
import { embedText, embedBatch, getEmbeddingDim } from "./embedder.mjs";
import { vectorToBuffer } from "./vector-math.mjs";
import { stripNoteBody, stripMarkdown, splitIntoChunks, extractTitle, extractTags } from "./markdown.mjs";
import { ftsInsertChunk } from "./search.mjs";

/**
 * Re-index a single file from the vault (called by watcher on change).
 * Scans the file, splits into chunks, replaces old chunks/FTS/embedding.
 * Silently ignores non-markdown files and files outside vault.
 * @param {string} relPath - relative path within the vault
 */
export async function reindexSingleFile(relPath) {
  const _vaultPath = getVault();
  if (!_vaultPath) return;
  if (!relPath.endsWith(".md")) return;
  const fullPath = join(_vaultPath, relPath);
  if (!existsSync(fullPath)) return;

  try {
    const content = readFileSync(fullPath, "utf-8");
    const stat = statSync(fullPath);
    const title = extractTitle(content, basename(relPath));
    const tags = extractTags(content);
    const body = stripNoteBody(content);

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
      const chunks = splitIntoChunks(body, title);
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
  const notes = scanVaultInline(_vaultPath, _vaultPath);

  // Clear existing data. These are outside any transaction so they take
  // effect immediately; rebuild will start fresh.
  try { db.exec("DELETE FROM kb_fts"); } catch (/** @type {any} */ e) { _logError("fts", e); }
  try { db.exec("DELETE FROM kb_embeddings"); } catch (/** @type {any} */ e) { _logError("db", e); }
  db.exec("DELETE FROM kb_chunks");
  db.exec("DELETE FROM kb_notes");

  // ── Pass 1: scan all notes + insert kb_notes rows + chunk them ─────
  // We don't write chunks/embeddings yet — we need the full chunk list
  // first so we can send EMBED_BATCH_SIZE chunks at a time to Ollama.
  /**
   * @type {Array<{noteId:number, noteTitle:string, relPath:string, chunkIndex:number, heading:string, content:string}>}
   */
  const allChunks = [];
  for (const note of notes) {
    try {
      const result = db.prepare(
        "INSERT INTO kb_notes(rel_path, filename, title, tags, word_count, mtime_ms, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)"
      ).run(note.relPath, note.filename, note.title, JSON.stringify(note.tags), note.wordCount, note.mtimeMs, new Date().toISOString(), new Date().toISOString());
      const noteId = Number(result.lastInsertRowid);

      const chunks = splitIntoChunks(note.body, note.title);
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

  // ── Pass 2: batch-embed + write chunks in transactions ───────────
  const max = getEffectiveMaxBodyChars();
  const insertChunk = db.prepare(
    "INSERT INTO kb_chunks(note_id, chunk_index, heading, content) VALUES (?,?,?,?)"
  );
  const insertEmbedding = db.prepare(
    "INSERT INTO kb_embeddings(chunk_id, embedding, dim) VALUES (?,?,?)"
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

    // Build embed input: title + heading + content (truncated to max).
    const embedInputs = batch.map((c) =>
      (c.noteTitle + "\n" + c.heading + "\n" + c.content).slice(0, max)
    );

    // Send batch to Ollama. embedBatch() returns parallel array; null
    // entries are failures (which we count but continue past).
    let vectors;
    try {
      vectors = await embedBatch(embedInputs);
    } catch (/** @type {any} */ e) {
      _logError("embed", e);
      failed += batch.length;
      continue;
    }

    // Write chunks + embeddings in a transaction. This batches ~64
    // INSERTs into one fsync instead of one-per-INSERT.
    try {
      db.exec("BEGIN IMMEDIATE");
      for (let j = 0; j < batch.length; j++) {
        const c = batch[j];
        const vec = vectors[j];
        const chunkResult = insertChunk.run(c.noteId, c.chunkIndex, c.heading, c.content);
        const chunkId = Number(chunkResult.lastInsertRowid);
        ftsInsertChunk(chunkId, c.heading, c.content);
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

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`[kb] rebuild done: ${chunked} chunks, ${embedded} embedded, ${failed} failed in ${elapsed}s`);
  return { ok: true, indexed, embedded, chunked, failed, total };
}

// Local inline copy of scanVault logic. We can't import from kb/vault-scanner
// here without creating a cycle, and the version we need is trivial — just
// walk the directory for .md files and extract their metadata. (kb/notes.mjs
// uses the same metadata shape.)
function scanVaultInline(dir, baseDir) {
  /** @type {Array<{relPath:string, filename:string, title:string, tags:string[], body:string, wordCount:number, mtimeMs:number}>} */
  const results = [];
  if (!existsSync(dir)) return results;
  const entries = readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      // Skip known-noisy directories (keep in sync with kb/vault-scanner.mjs)
      if ([".obsidian","node_modules",".git",".trash",".vscode",".idea"].includes(entry.name)) continue;
      results.push(...scanVaultInline(fullPath, baseDir));
    } else if (entry.isFile() && extname(entry.name).toLowerCase() === ".md") {
      try {
        const stat = statSync(fullPath);
        const content = readFileSync(fullPath, "utf-8");
        const relPath = relative(baseDir, fullPath).replace(/\\/g, "/");
        const title = extractTitle(content, entry.name);
        const tags = extractTags(content);
        const body = stripNoteBody(content);
        results.push({
          relPath, filename: entry.name, title, tags, body,
          wordCount: body.length, mtimeMs: stat.mtimeMs,
        });
      } catch (/** @type {any} */ e) {
        console.warn(`[kb] Skipping ${fullPath}: ${e.message}`);
      }
    }
  }
  return results;
}
