/**
 * GoodAgent Memory Store — USER.md / MEMORY.md I/O
 * Simple markdown file read/write with dedup support.
 */

import { join } from "path";
import { homedir } from "os";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { DatabaseSync } from "node:sqlite";

const HOME = homedir();
const MEM_DIR = join(HOME, ".goodagent", "memories");
const USER_PATH = join(MEM_DIR, "USER.md");
const MEMORY_PATH = join(MEM_DIR, "MEMORY.md");
const FTS_DB = join(MEM_DIR, "memory-fts.db");

// ── Ensure dir ──
if (!existsSync(MEM_DIR)) mkdirSync(MEM_DIR, { recursive: true });

// ── Memory I/O ────────────────────────────────────────────────

export function readUserMemory() {
  try { return readFileSync(USER_PATH, "utf8"); } catch { return ""; }
}
export function writeUserMemory(content) {
  mkdirSync(MEM_DIR, { recursive: true });
  writeFileSync(USER_PATH, content, "utf8");
  return { ok: true };
}
export function appendUserMemory(content) {
  const existing = readUserMemory();
  writeUserMemory(existing ? existing + "\n\n" + content : content);
  return { ok: true };
}

export function readProjectMemory() {
  try { return readFileSync(MEMORY_PATH, "utf8"); } catch { return ""; }
}
export function writeProjectMemory(content) {
  mkdirSync(MEM_DIR, { recursive: true });
  writeFileSync(MEMORY_PATH, content, "utf8");
  return { ok: true };
}
export function appendProjectMemory(content) {
  const existing = readProjectMemory();
  writeProjectMemory(existing ? existing + "\n\n" + content : content);
  return { ok: true };
}

// ── Dedup check ───────────────────────────────────────────────

export function checkDuplicate(type, text) {
  const existing = type === "user" ? readUserMemory() : readProjectMemory();
  if (!existing) return false;
  // Simple similarity: check if >50% of the new content appears in existing
  const words = text.split(/\s+/).filter(w => w.length > 2);
  if (words.length === 0) return false;
  let matchCount = 0;
  for (const w of words) {
    if (existing.includes(w)) matchCount++;
  }
  return matchCount / words.length > 0.5;
}

// ── FTS5 search over memory files ─────────────────────────────

let _ftsDb = null;
function getFtsDb() {
  if (_ftsDb) return _ftsDb;
  _ftsDb = new DatabaseSync(FTS_DB);
  _ftsDb.exec("PRAGMA journal_mode=WAL");
  _ftsDb.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS mem_fts USING fts5(
      source, content, tokenize='unicode61'
    )
  `);
  return _ftsDb;
}

export function indexMemory(source, content) {
  const db = getFtsDb();
  db.prepare("DELETE FROM mem_fts WHERE source = ?").run(source);
  if (content) {
    db.prepare("INSERT INTO mem_fts(source, content) VALUES (?, ?)").run(source, content);
  }
}

export function searchMemory(query, limit = 10) {
  const db = getFtsDb();
  try {
    const rows = db.prepare(
      "SELECT source, snippet(mem_fts,1,'<mark>','</mark>','…',40) as snippet, rank FROM mem_fts WHERE mem_fts MATCH ? ORDER BY rank LIMIT ?"
    ).all(query, limit);
    return rows.map(r => ({ source: r.source, snippet: r.snippet, rank: r.rank }));
  } catch {
    // LIKE fallback for CJK
    return db.prepare(
      "SELECT source, content FROM mem_fts WHERE content LIKE ? LIMIT ?"
    ).all("%" + query + "%", limit).map(r => ({ source: r.source, snippet: (r.content||"").substring(0,200), rank: 0 }));
  }
}

// Index on load
indexMemory("USER.md", readUserMemory());
indexMemory("MEMORY.md", readProjectMemory());
