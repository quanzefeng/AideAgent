/**
 * AideAgent Memory Store — Multi-file memory with frontmatter
 *
 * Dir: ~/.aideagent/memory/
 *   MEMORY.md                — index entrypoint (≤200 lines)
 *   user_profile.md          — one file per memory, YAML frontmatter
 *   ...
 */

import { join } from "path";
import { homedir } from "os";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, unlinkSync, statSync } from "fs";
import { DatabaseSync } from "node:sqlite";

const HOME = homedir();
const MEM_DIR = join(HOME, ".aideagent", "memory");
const OLD_DIR = join(HOME, ".aideagent", "memories");
const INDEX_PATH = join(MEM_DIR, "MEMORY.md");
const FTS_PATH = join(MEM_DIR, "memory-fts.db");

const MAX_INDEX_LINES = 200;
const MAX_INDEX_BYTES = 25000;
// Phase 3: hard cap on project-memory files. When appendProjectMemory() is
// about to create a NEW one and the count exceeds this, the oldest (by mtime)
// is deleted first. User / feedback / reference memories are not affected.
//
// P3方案1: 30 → 10. With 30, the LLM-side memory picker has to choose 8
// from 30 candidates every turn, leading to noisy context that interferes
// with the agent's reasoning ("answering about the wrong thing"). 10 keeps
// the working set small enough for selection to stay useful. User / feedback
// memories are NOT capped — those are higher-signal and always worth keeping.
const MAX_PROJECT_MEMORIES = 10;

if (!existsSync(MEM_DIR)) mkdirSync(MEM_DIR, { recursive: true });

// ── Memory age / staleness ────────────────────────────────────

/**
 * Days elapsed since mtimeMs. 0 = today, 1 = yesterday, etc.
 * Negative (future timestamps / clock skew) clamps to 0.
 * @param {number} mtimeMs
 * @returns {number}
 */
export function memoryAgeDays(mtimeMs) {
  if (!mtimeMs || mtimeMs <= 0) return 0;
  const diff = Date.now() - mtimeMs;
  return Math.max(0, Math.floor(diff / 86_400_000));
}

/**
 * Human-readable age string that triggers staleness reasoning in models.
 * "today" / "yesterday" / "N days ago"
 * @param {number} mtimeMs
 * @returns {string}
 */
export function memoryAge(mtimeMs) {
  const days = memoryAgeDays(mtimeMs);
  if (days === 0) return "today";
  if (days === 1) return "yesterday";
  return `${days} days ago`;
}

/**
 * Staleness caveat for memories older than 1 day.
 * Returns '' for fresh memories (<=1 day) to avoid noise.
 * @param {number} mtimeMs
 * @returns {string}
 */
export function memoryFreshnessNote(mtimeMs) {
  const days = memoryAgeDays(mtimeMs);
  if (days <= 1) return "";
  return `\n> ⚠️ This memory is ${days} days old. Memories are point-in-time observations — claims about code paths, file locations, or function names may be outdated. Verify against current code before acting.`;
}

// ── FTS5 ──────────────────────────────────────────────────────

/** @type {import("node:sqlite").DatabaseSync | null} */
let _ftsDb = null;
function getFtsDb() {
  if (_ftsDb) return _ftsDb;
  _ftsDb = new DatabaseSync(FTS_PATH);
  _ftsDb.exec("PRAGMA journal_mode=WAL");
  _ftsDb.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS mem_fts USING fts5(
    filename, name, description, type, body, tokenize='unicode61'
  )`);
  return _ftsDb;
}

/**
 * @param {string} filename
 */
function ftsDelete(filename) {
  try { getFtsDb().prepare("DELETE FROM mem_fts WHERE filename = ?").run(filename); } catch { /* ignored */ }
}

/**
 * @param {string} filename
 * @param {string} name
 * @param {string} description
 * @param {string} type
 * @param {string} body
 */
function ftsInsert(filename, name, description, type, body) {
  try {
    ftsDelete(filename);
    getFtsDb().prepare("INSERT INTO mem_fts(filename, name, description, type, body) VALUES (?,?,?,?,?)")
      .run(filename, name || "", description || "", type || "", body || "");
  } catch { /* ignored */ }
}

// ── Frontmatter ───────────────────────────────────────────────

/**
 * @param {string} text
 * @returns {{ name: string, description: string, type: string }}
 */
function parseFrontMatter(text) {
  const meta = { name: "", description: "", type: "project" };
  const match = text.match(/^---\s*\n([\s\S]*?)\n---/);
  if (!match) return meta;
  for (const line of match[1].split("\n")) {
    const kv = line.match(/^\s*(\w[\w-]*)\s*:\s*(.+)/);
    if (kv) {
      const val = kv[2].trim().replace(/^["']|["']$/g, "");
      if (kv[1] === "name") meta.name = val;
      else if (kv[1] === "description") meta.description = val;
      else if (kv[1] === "type") meta.type = val;
    }
  }
  return meta;
}

/**
 * @param {string} name
 * @param {string} description
 * @param {string} type
 * @returns {string}
 */
function makeFrontMatter(name, description, type) {
  return `---
name: ${name}
description: ${description}
type: ${type}
---

`;
}

// ── Index management ──────────────────────────────────────────

function readIndex() {
  try { return readFileSync(INDEX_PATH, "utf-8"); } catch { return ""; }
}

/**
 * @param {string} content
 */
function writeIndex(content) {
  try { writeFileSync(INDEX_PATH, content, "utf-8"); } catch { /* ignored */ }
}

/**
 * @param {string} filename
 * @param {string} name
 * @param {string} description
 */
function addToIndex(filename, name, description) {
  let idx = readIndex();
  // Remove existing entry for this file if present
  const lines = idx.split("\n").filter(l => !l.includes(`(${filename})`));
  const entry = `- [${name}](${filename}) — ${description}`;
  lines.push(entry);
  // Truncate if needed
  let result = lines.join("\n");
  if (lines.length > MAX_INDEX_LINES) {
    result = lines.slice(0, MAX_INDEX_LINES).join("\n") + `\n\n...(index truncated at ${MAX_INDEX_LINES} lines)`;
  }
  if (Buffer.byteLength(result, "utf-8") > MAX_INDEX_BYTES) {
    result = result.slice(0, MAX_INDEX_BYTES) + `\n...(index truncated at ${MAX_INDEX_BYTES} bytes)`;
  }
  writeIndex(result);
}

/**
 * @param {string} filename
 */
function removeFromIndex(filename) {
  let idx = readIndex();
  idx = idx.split("\n").filter(l => !l.includes(`(${filename})`)).join("\n");
  writeIndex(idx);
}

// ── CRUD ──────────────────────────────────────────────────────

/**
 * List all memory files (sorted newest-first, max 200).
 * Returns: [{ filename, name, description, type, mtimeMs }]
 */
export function listMemories() {
  const results = [];
  try {
    const entries = readdirSync(MEM_DIR);
    for (const entry of entries) {
      if (!entry.endsWith(".md") || entry === "MEMORY.md") continue;
      const filePath = join(MEM_DIR, entry);
      try {
        const text = readFileSync(filePath, "utf-8");
        const meta = parseFrontMatter(text);
        let mtimeMs = 0;
        try { mtimeMs = statSync(filePath).mtimeMs; } catch { /* ignored */ }
        if (!meta.name) meta.name = entry.replace(/\.md$/, "");
        results.push({
          filename: entry,
          name: meta.name,
          description: meta.description || "",
          type: meta.type || "project",
          body: text.replace(/^---[\s\S]*?\n---\n?/, "").trim(),
          mtimeMs,
        });
      } catch { /* ignored */ }
    }
  } catch { /* ignored */ }
  // Sort newest-first by modification time
  return results.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

/**
 * @param {string} filename
 * @returns {{ filename: string, name: string, description: string, type: string, body: string } | null}
 */
export function readMemory(filename) {
  const filePath = join(MEM_DIR, filename);
  try {
    const text = readFileSync(filePath, "utf-8");
    const meta = parseFrontMatter(text);
    return {
      filename,
      name: meta.name || filename.replace(/\.md$/, ""),
      description: meta.description || "",
      type: meta.type || "project",
      body: text.replace(/^---[\s\S]*?\n---\n?/, "").trim(),
    };
  } catch {
    return null;
  }
}

/**
 * @param {string} name
 * @param {string} [description]
 * @param {string} [type]
 * @param {string} [body]
 * @returns {{ ok: boolean, filename?: string, name?: string, error?: string }}
 */
export function createMemory(name, description, type, body) {
  if (!name) return { ok: false, error: "name is required" };
  // P1: reject empty bodies to prevent empty memory files
  if (!body || !String(body).trim()) {
    return { ok: false, error: "body is required (refusing to create empty memory)" };
  }
  const safeName = name.replace(/[^a-zA-Z0-9_\-一-鿿]/g, "_");
  const filename = safeName.endsWith(".md") ? safeName : safeName + ".md";
  const frontmatter = makeFrontMatter(name, description || "", type || "project");
  const content = frontmatter + (body || "");
  const filePath = join(MEM_DIR, filename);

  writeFileSync(filePath, content, "utf-8");
  addToIndex(filename, name, description || "");
  ftsInsert(filename, name, description || "", type || "project", body || "");
  return { ok: true, filename, name };
}

/**
 * @param {string} filename
 * @param {string} [body]
 * @param {string} [name]
 * @param {string} [description]
 * @param {string} [type]
 * @returns {{ ok: boolean, filename?: string, name?: string, error?: string }}
 */
export function updateMemory(filename, body, name, description, type) {
  const existing = readMemory(filename);
  if (!existing) return { ok: false, error: `Memory file not found: ${filename}` };

  const n = name || existing.name;
  const d = description || existing.description;
  const t = type || existing.type;
  const frontmatter = makeFrontMatter(n, d, t);
  const content = frontmatter + (body !== undefined ? body : existing.body);

  const filePath = join(MEM_DIR, filename);
  writeFileSync(filePath, content, "utf-8");
  addToIndex(filename, n, d);
  ftsInsert(filename, n, d, t, body !== undefined ? body : existing.body);
  return { ok: true, filename, name: n };
}

/**
 * Bulk-delete all memories of a given type. Used by the "purge" button in
 * the Settings → Memory panel. Always rebuilds the FTS index after.
 *
 * Safety: refuses to delete the `user` type (which holds user_profile.md).
 * Caller should pre-confirm in the UI; we still double-check here.
 *
 * @param {string} type  one of "project" | "feedback" | "reference"
 * @returns {{ ok: boolean, removed?: number, names?: string[], error?: string }}
 */
export function purgeByType(type) {
  if (!type || (type !== "project" && type !== "feedback" && type !== "reference")) {
    return { ok: false, error: `invalid type: ${type} (refusing to bulk-delete user memories)` };
  }
  const all = listMemories().filter(m => m.type === type);
  const removed = [];
  const failed = [];
  for (const m of all) {
    const r = deleteMemory(m.filename);
    if (r?.ok) removed.push(m.filename);
    else failed.push(m.filename);
  }
  // Rebuild FTS + index so the count badge + search reflect the purge
  try { rebuildIndex(); } catch { /* ignored */ }
  if (failed.length > 0) {
    return { ok: true, removed: removed.length, names: removed, failed };
  }
  return { ok: true, removed: removed.length, names: removed };
}

/**
 * @param {string} filename
 * @returns {{ ok: boolean, error?: string }}
 */
export function deleteMemory(filename) {
  const filePath = join(MEM_DIR, filename);
  try {
    unlinkSync(filePath);
    removeFromIndex(filename);
    ftsDelete(filename);
    return { ok: true };
  } catch (/** @type {any} */ e) {
    return { ok: false, error: e.message };
  }
}

// ── Search ────────────────────────────────────────────────────

/**
 * @param {string} query
 * @param {number} [limit]
 * @returns {Array<{ filename: string, name: string, description: string, type: string, snippet: string, rank: number }>}
 */
export function searchMemory(query, limit = 10) {
  const db = getFtsDb();
  try {
    const rows = db.prepare(
      "SELECT filename, name, description, type, snippet(mem_fts,4,'<mark>','</mark>','…',64) as snippet, rank FROM mem_fts WHERE mem_fts MATCH ? ORDER BY rank LIMIT ?"
    ).all(query, limit);
    return rows.map(/** @param {any} r */ (r) => ({
      filename: r.filename,
      name: r.name,
      description: r.description,
      type: r.type,
      snippet: r.snippet,
      rank: r.rank,
    }));
  } catch {
    // LIKE fallback for CJK
    return db.prepare(
      "SELECT filename, name, description, type, body FROM mem_fts WHERE body LIKE ? LIMIT ?"
    ).all("%" + query + "%", limit).map(/** @param {any} r */ (r) => ({
      filename: r.filename, name: r.name, description: r.description,
      type: r.type, snippet: (r.body || "").substring(0, 200), rank: 0,
    }));
  }
}

export function rebuildIndex() {
  const memories = listMemories();
  let idx = "";
  for (const m of memories) {
    const line = `- [${m.name}](${m.filename}) — ${m.description}`;
    if (Buffer.byteLength(idx + line, "utf-8") < MAX_INDEX_BYTES && idx.split("\n").length < MAX_INDEX_LINES) {
      idx += (idx ? "\n" : "") + line;
    }
  }
  writeIndex(idx);

  // Rebuild FTS
  try {
    const db = getFtsDb();
    db.exec("DELETE FROM mem_fts");
    for (const m of memories) {
      ftsInsert(m.filename, m.name, m.description, m.type, m.body);
    }
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)"); // compact WAL after bulk writes
  } catch { /* ignored */ }
  return { ok: true, count: memories.length };
}

// ── Migration from old format ─────────────────────────────────

export function migrateFromOldFormat() {
  const oldUserPath = join(OLD_DIR, "USER.md");
  const oldMemPath = join(OLD_DIR, "MEMORY.md");

  // Check if new dir has content
  if (readdirSync(MEM_DIR).filter(f => f.endsWith(".md") && f !== "MEMORY.md").length > 0) {
    return { migrated: false, reason: "new directory already has files" };
  }

  let migrated = 0;

  // Migrate USER.md
  if (existsSync(oldUserPath)) {
    try {
      const content = readFileSync(oldUserPath, "utf-8").trim();
      if (content) {
        createMemory("user_profile", "About the user — preferences, background, knowledge", "user", content);
        migrated++;
      }
    } catch { /* ignored */ }
  }

  // Migrate MEMORY.md — split by ## headings
  if (existsSync(oldMemPath)) {
    try {
      const content = readFileSync(oldMemPath, "utf-8").trim();
      if (content) {
        const sections = content.split(/^(?=## )/m).filter(Boolean);
        for (const section of sections) {
          const titleMatch = section.match(/^## (.+)/m);
          const title = titleMatch ? titleMatch[1].trim() : "memory";
          const body = section.replace(/^## .+\n?/, "").trim();
          if (body.length < 10) continue;
          const safeName = title.replace(/[^a-zA-Z0-9_\-一-鿿]/g, "_").toLowerCase().slice(0, 50);
          createMemory(safeName, title, "project", body);
          migrated++;
        }
      }
    } catch { /* ignored */ }
  }

  return { migrated, reason: migrated > 0 ? `migrated ${migrated} files` : "no old files found" };
}

// ── Legacy compat ─────────────────────────────────────────────

export function readUserMemory() {
  const m = readMemory("user_profile.md");
  return m ? m.body : "";
}

export function readProjectMemory() {
  const idx = readIndex();
  // Return index for context injection — the AI will see all memory headers
  return idx || "";
}

/**
 * @param {string} content
 * @returns {{ ok: boolean, filename?: string, name?: string, error?: string }}
 */
export function appendUserMemory(content) {
  // Convert to new format: create/update user_profile
  const existing = readMemory("user_profile.md");
  if (existing) {
    return updateMemory("user_profile.md", existing.body + "\n\n" + content);
  }
  return createMemory("user_profile", "About the user", "user", content);
}

/**
 * @param {string} content
 * @returns {{ ok: boolean, filename?: string, name?: string, error?: string, merged?: boolean }}
 */
/**
 * Tokenize text for memory dedup / merge matching.
 *
 * Why not just `text.split(/\s+/)`: Chinese (and other CJK) text has no
 * word boundaries, so `split(/\s+/)` returns ONE giant token per line. That
 * made `appendProjectMemory`'s 70%-overlap merge branch unreachable for
 * Chinese users — every append created a new file until the project-memory
 * cap kicked in and silently deleted the oldest ones. English text instead
 * got over-merged because `body.includes("code")` matched "codebase",
 * "encode", "decode", etc.
 *
 * Strategy:
 *   - ASCII words: matched as-is via `\w+` (length > 2). Exact Set lookup,
 *     so "code" no longer matches "codebase".
 *   - CJK: 2-grams (bigrams) — "代码审查" → {"代码","码审","审查"}.
 *     Bigrams capture enough semantic locality that two paragraphs about
 *     the same topic share many bigrams, but unrelated topics rarely do.
 *     Single chars are too noisy; trigrams require near-identical text.
 *
 * @param {string} text
 * @returns {string[]} array of tokens (may contain duplicates — caller decides dedup)
 */
export function tokenizeForMemory(text) {
  if (!text) return [];
  const s = String(text);
  const tokens = [];

  // ASCII words: identifiers, file names, English words. Keep length > 2
  // to avoid noise from "a", "an", "the", "to", etc.
  const asciiMatches = s.match(/[A-Za-z_][A-Za-z0-9_]{2,}/g);
  if (asciiMatches) tokens.push(...asciiMatches);

  // CJK bigrams. Run on every maximal CJK run in the text so mixed
  // content like "用 React 写前端" still extracts "用Re"... no — only
  // CJK-to-CJK pairs. ASCII boundaries naturally split runs.
  const cjkRuns = s.match(/[\u3400-\u9fff\uf900-\ufaff]+/g);
  if (cjkRuns) {
    for (const run of cjkRuns) {
      // Single-char run → emit the char itself so it can still match
      if (run.length === 1) { tokens.push(run); continue; }
      for (let i = 0; i < run.length - 1; i++) {
        tokens.push(run.slice(i, i + 2));
      }
      // Also include the last single char so trailing-character overlap
      // ("审查" + "查证" → shared "查") still registers.
      tokens.push(run.slice(-1));
    }
  }

  return tokens;
}

export function appendProjectMemory(content) {
  // P1: reject empty content
  if (!content || !String(content).trim()) {
    return { ok: false, error: "content is required (refusing to append empty memory)" };
  }
  const safeContent = String(content).trim();

  // P2: try to merge into an existing similar project memory first.
  // Scans the most recent 20 project memories; if any has >70% token overlap
  // AND ≥5 overlapping tokens AND length ratio within 2x, append a dated
  // update to that file instead of creating a new one.
  //
  // P3方案3(a): tightened from 50% to 70% — the old threshold let almost
  // any related memory merge, producing giant "kitchen sink" files where
  // unrelated decisions piled up. 70% + ≥5 tokens + length sanity keeps
  // merges topic-coherent.
  //
  // CJK fix: previously used `split(/\s+/)`, which produces ONE token per
  // line for Chinese (no spaces) → branch never fired for Chinese users,
  // so every append hit the project-memory cap and silently evicted older
  // memories. Now uses tokenizeForMemory() (CJK bigrams + ASCII words) and
  // Set-based exact matching instead of substring `includes()` (which
  // caused "code" to match "codebase" for English users).
  const allMemories = listMemories();
  const candidates = allMemories
    .filter(m => m.type === "project" && m.body && m.body.trim())
    .slice(0, 20);

  const newTokens = tokenizeForMemory(safeContent);
  if (newTokens.length > 0) {
    const newTokenSet = new Set(newTokens);
    for (const m of candidates) {
      const existingTokens = new Set(tokenizeForMemory(m.body));
      let overlapCount = 0;
      for (const t of newTokenSet) {
        if (existingTokens.has(t)) overlapCount++;
      }
      const ratio = overlapCount / newTokenSet.size;
      // Length sanity: don't merge a 50-char note into a 5000-char memory
      const lengthRatio = Math.max(safeContent.length, m.body.length) /
                          Math.min(safeContent.length, m.body.length);
      if (ratio >= 0.7 && overlapCount >= 5 && lengthRatio <= 2) {
        // Merge with date-stamped separator
        const today = new Date().toISOString().slice(0, 10);
        const merged = `${m.body}\n\n---\n\n[更新 ${today}]\n${safeContent}`;
        const result = updateMemory(m.filename, merged);
        return { ...result, merged: true };
      }
    }
  }

  // P3: cap project memories at MAX_PROJECT_MEMORIES. Drop the oldest one
  // (by mtime) to make room. Keeps the working set small enough for
  // per-turn context selection to stay useful.
  enforceProjectMemoryCap();

  // No similar memory found — create new
  const name = "memory_" + Date.now().toString(36);
  return createMemory(name, "Project memory", "project", safeContent);
}

/**
 * If there are more than MAX_PROJECT_MEMORIES project-type memory files,
 * delete the oldest ones (by mtime) until the count is within the cap.
 * User, feedback, and reference memories are NOT touched.
 * @returns {{ removed: number, names: string[] }}
 */
export function enforceProjectMemoryCap() {
  const all = listMemories();
  const projects = all
    .filter(m => m.type === "project")
    .sort((a, b) => (a.mtimeMs || 0) - (b.mtimeMs || 0));  // oldest first

  // P3方案3(d): soft reminder when project memory is getting crowded.
  // 80% of cap = "consider cleaning soon". Goes to console so devs/maintainers
  // notice, but does NOT spam logs on every append — only when crossing 80%.
  const SOFT_WARN_THRESHOLD = Math.floor(MAX_PROJECT_MEMORIES * 0.8);
  if (projects.length >= SOFT_WARN_THRESHOLD && projects.length < MAX_PROJECT_MEMORIES) {
    console.warn(`[memory-store] project memory getting crowded: ${projects.length}/${MAX_PROJECT_MEMORIES} (≥${SOFT_WARN_THRESHOLD}). Consider cleanup before Agent thinking degrades.`);
  }

  const overflow = projects.length - MAX_PROJECT_MEMORIES;
  if (overflow <= 0) return { removed: 0, names: [] };
  const toRemove = projects.slice(0, overflow);
  const removed = [];
  for (const m of toRemove) {
    const r = deleteMemory(m.filename);
    if (r?.ok) removed.push(m.filename);
  }
  if (removed.length > 0) {
    console.log(`[memory-store] cap reached: removed ${removed.length} oldest project memory(ies): ${removed.join(", ")}`);
  }
  return { removed: removed.length, names: removed };
}

/**
 * @param {string} content
 * @returns {{ ok: boolean, filename?: string, name?: string, error?: string }}
 */
export function writeUserMemory(content) {
  const existing = readMemory("user_profile.md");
  if (existing) {
    return updateMemory("user_profile.md", content);
  }
  return createMemory("user_profile", "About the user", "user", content);
}

/**
 * @param {string} content
 * @returns {{ ok: boolean }}
 */
export function writeProjectMemory(content) {
  // Legacy: write directly to index
  writeIndex(content);
  return { ok: true };
}

/**
 * @param {string} type
 * @param {string} text
 * @returns {boolean}
 */
export function checkDuplicate(type, text) {
  const memories = listMemories();
  const tokens = tokenizeForMemory(text);
  if (tokens.length === 0) return false;
  const tokenSet = new Set(tokens);
  for (const m of memories) {
    const existingTokens = new Set(tokenizeForMemory(m.body));
    let matchCount = 0;
    for (const t of tokenSet) {
      if (existingTokens.has(t)) matchCount++;
    }
    if (matchCount / tokenSet.size > 0.5) return true;
  }
  return false;
}

// ── Index on load (lazy) ──────────────────────────────────────
try { migrateFromOldFormat(); } catch { /* ignored */ }

// P1: clean up existing empty memory files (defensive one-shot at module load)
try {
  const before = listMemories().length;
  let removed = 0;
  for (const m of listMemories()) {
    if (!m.body || !m.body.trim()) {
      try { deleteMemory(m.filename); removed++; } catch { /* ignored */ }
    }
  }
  if (removed > 0) console.log(`[memory] Cleaned up ${removed} empty memory file(s) at startup`);
} catch { /* ignored */ }
