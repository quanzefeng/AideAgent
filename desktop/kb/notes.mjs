/**
 * Note CRUD operations.
 *
 * Each write operation (create/update/delete) also keeps the chunk-level
 * FTS and embedding tables in sync, and writes the .md file to disk.
 *
 * All path validation flows through isSafeVaultPath (kb/vault-scanner.mjs)
 * to defend against traversal/symlink escapes.
 *
 * Read operations (listNotes, getNote) are read-only and never modify state.
 */

import { existsSync, mkdirSync, writeFileSync, unlinkSync, readFileSync, statSync } from "fs";
import { join, dirname, basename, extname } from "path";
import { getDb } from "./db.mjs";
import { getVault, getEffectiveMaxBodyChars } from "./config.mjs";
import { isSafeVaultPath } from "./vault-scanner.mjs";
import { _logError } from "./log.mjs";
import { embedText, getEmbeddingDim } from "./embedder.mjs";
import { vectorToBuffer } from "./vector-math.mjs";
import { stripNoteBody, stripMarkdown, splitIntoChunks, extractTitle, extractTags } from "./markdown.mjs";
import { ftsInsertChunk } from "./search.mjs";

/**
 * KB-indexed binary formats — these are ZIP/PDF containers, not raw text.
 * getNote() must NOT readFileSync() them as utf-8 (silently corrupts bytes).
 * Instead, return the chunks array (already extracted during indexing).
 * Text formats (.md/.csv/.tsv) keep the raw-read path.
 */
const BINARY_KB_FORMATS = new Set([".pdf", ".docx", ".pptx", ".xlsx"]);

export function listNotes(offset = 0, limit = 50) {
  const db = getDb();
  try {
    const total = Number(db.prepare("SELECT COUNT(*) as count FROM kb_notes").get()?.count ?? 0);
    const notes = db.prepare("SELECT * FROM kb_notes ORDER BY mtime_ms DESC LIMIT ? OFFSET ?").all(limit, offset);
    return {
      total,
      notes: notes.map(/** @param {any} n */ n => ({
        id: n.id,
        rel_path: n.rel_path,
        filename: n.filename,
        title: n.title,
        tags: JSON.parse(String(n.tags || "[]")),
        word_count: Number(n.word_count),
        mtime_ms: Number(n.mtime_ms),
      })),
    };
  } catch (/** @type {any} */ e) {
    // listNotes is read-only; on DB error, return empty list and log.
    _logError("db", e);
    return { total: 0, notes: [] };
  }
}

/** @param {string} relPath @returns {object|null} */
export function getNote(relPath) {
  const db = getDb();
  try {
    const note = db.prepare("SELECT * FROM kb_notes WHERE rel_path = ?").get(relPath);
    if (!note) return null;

    const ext = extname(relPath).toLowerCase();
    const isBinary = BINARY_KB_FORMATS.has(ext);

    /** @type {any} */
    const result = {
      ...note,
      tags: JSON.parse(String(note.tags || "[]")),
    };

    if (isBinary) {
      // Binary formats — never read raw bytes (PDF/DOCX/PPTX/XLSX are
      // binary containers; utf-8 decoding corrupts them).
      // Return extracted chunks from the KB index instead.
      const chunks = db.prepare(
        "SELECT chunk_index, heading, content FROM kb_chunks WHERE note_id = ? ORDER BY chunk_index"
      ).all(note.id);
      result.chunks = chunks;
      result.content = null; // explicit null — signals "not raw text"
      result.format = ext.slice(1); // "pdf", "docx", etc.
    } else {
      // Text formats — read raw file (current behavior)
      const fullPath = join(getVault(), relPath);
      result.content = readFileSync(fullPath, "utf-8");
    }

    return result;
  } catch (/** @type {any} */ e) {
    // getNote is read-only; on missing file or DB error, return null and log.
    _logError("db", e);
    return null;
  }
}

/** @param {string} relPath @param {string} content @param {string[]} [tags] @returns {Promise<{ok:boolean, relPath:string, title:string}|{error:string}>} */
export async function createNote(relPath, content, tags = []) {
  if (!getVault()) return { error: "vault not set" };
  if (!isSafeVaultPath(relPath)) return { error: "invalid path" };
  const fullPath = join(getVault(), relPath);

  try {
    // Ensure directory exists
    const dir = dirname(fullPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

    // Write file
    writeFileSync(fullPath, content, "utf-8");

    // Index the new note
    const stat = statSync(fullPath);
    const title = extractTitle(content, basename(relPath));
    const noteTags = tags.length > 0 ? tags : extractTags(content);
    const body = stripNoteBody(content);

    const db = getDb();
    const noteResult = db.prepare(
      "INSERT INTO kb_notes(rel_path, filename, title, tags, word_count, mtime_ms, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)"
    ).run(relPath, basename(relPath), title, JSON.stringify(noteTags), body.length, stat.mtimeMs, new Date().toISOString(), new Date().toISOString());
    const noteId = Number(noteResult.lastInsertRowid);

    // Split into chunks and index each
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

    return { ok: true, relPath, title };
  } catch (/** @type {any} */ e) { return { error: e.message }; }
}

/** @param {string} relPath @param {string} content @returns {Promise<{ok:boolean, relPath:string, title:string}|{error:string}>} */
export async function updateNote(relPath, content) {
  if (!getVault()) return { error: "vault not set" };
  if (!isSafeVaultPath(relPath)) return { error: "invalid path" };
  const fullPath = join(getVault(), relPath);

  try {
    writeFileSync(fullPath, content, "utf-8");

    const stat = statSync(fullPath);
    const title = extractTitle(content, basename(relPath));
    /** @type {string[]} */
    const tags = extractTags(content);
    const body = stripNoteBody(content);

    const db = getDb();
    db.prepare(
      "UPDATE kb_notes SET title=?, tags=?, word_count=?, mtime_ms=?, updated_at=? WHERE rel_path=?"
    ).run(title, JSON.stringify(tags), body.length, stat.mtimeMs, new Date().toISOString(), relPath);

    // Remove old chunks, then re-chunk
    const noteRow = db.prepare("SELECT id FROM kb_notes WHERE rel_path = ?").get(relPath);
    const noteId = noteRow ? Number(noteRow.id) : null;
    if (noteId) {
      // Delete old chunks (cascade deletes FTS + embeddings)
      db.prepare("DELETE FROM kb_chunks WHERE note_id = ?").run(noteId);

      // Split into new chunks
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
    }

    return { ok: true, relPath, title };
  } catch (/** @type {any} */ e) { return { error: e.message }; }
}

/** @param {string} relPath @returns {{ok:boolean, relPath:string}|{error:string}} */
export function deleteNote(relPath) {
  if (!getVault()) return { error: "vault not set" };
  if (!isSafeVaultPath(relPath)) return { error: "invalid path" };
  const fullPath = join(getVault(), relPath);

  try {
    // Delete file
    if (existsSync(fullPath)) unlinkSync(fullPath);

    // Delete from DB (cascade: CASCADE deletes chunks → embeddings → auto-handles FK)
    const db = getDb();
    // Delete chunks explicitly (cascades triggers FTS cleanup)
    const noteRow = db.prepare("SELECT id FROM kb_notes WHERE rel_path = ?").get(relPath);
    if (noteRow) {
      db.prepare("DELETE FROM kb_chunks WHERE note_id = ?").run(Number(noteRow.id));
    }
    db.prepare("DELETE FROM kb_notes WHERE rel_path = ?").run(relPath);

    return { ok: true, relPath };
  } catch (/** @type {any} */ e) { return { error: e.message }; }
}
