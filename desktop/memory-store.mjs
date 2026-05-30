/**
 * GoodAgent Memory Store — Multi-file memory with frontmatter
 *
 * Dir: ~/.goodagent/memory/
 *   MEMORY.md                — index entrypoint (≤200 lines)
 *   user_profile.md          — one file per memory, YAML frontmatter
 *   ...
 */

import { join } from "path";
import { homedir } from "os";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, unlinkSync, statSync } from "fs";
import { DatabaseSync } from "node:sqlite";

const HOME = homedir();
const MEM_DIR = join(HOME, ".goodagent", "memory");
const OLD_DIR = join(HOME, ".goodagent", "memories");
const INDEX_PATH = join(MEM_DIR, "MEMORY.md");
const FTS_PATH = join(MEM_DIR, "memory-fts.db");

const MAX_INDEX_LINES = 200;
const MAX_INDEX_BYTES = 25000;

if (!existsSync(MEM_DIR)) mkdirSync(MEM_DIR, { recursive: true });

// ── Memory age / staleness ────────────────────────────────────

/**
 * Days elapsed since mtimeMs. 0 = today, 1 = yesterday, etc.
 * Negative (future timestamps / clock skew) clamps to 0.
 */
export function memoryAgeDays(mtimeMs) {
  if (!mtimeMs || mtimeMs <= 0) return 0;
  const diff = Date.now() - mtimeMs;
  return Math.max(0, Math.floor(diff / 86_400_000));
}

/**
 * Human-readable age string that triggers staleness reasoning in models.
 * "today" / "yesterday" / "N days ago"
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
 */
export function memoryFreshnessNote(mtimeMs) {
  const days = memoryAgeDays(mtimeMs);
  if (days <= 1) return "";
  return `\n> ⚠️ This memory is ${days} days old. Memories are point-in-time observations — claims about code paths, file locations, or function names may be outdated. Verify against current code before acting.`;
}

// ── FTS5 ──────────────────────────────────────────────────────

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

function ftsDelete(filename) {
  try { getFtsDb().prepare("DELETE FROM mem_fts WHERE filename = ?").run(filename); } catch { /* ignored */ }
}

function ftsInsert(filename, name, description, type, body) {
  try {
    ftsDelete(filename);
    getFtsDb().prepare("INSERT INTO mem_fts(filename, name, description, type, body) VALUES (?,?,?,?,?)")
      .run(filename, name || "", description || "", type || "", body || "");
  } catch { /* ignored */ }
}

// ── Frontmatter ───────────────────────────────────────────────

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

function writeIndex(content) {
  try { writeFileSync(INDEX_PATH, content, "utf-8"); } catch { /* ignored */ }
}

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

export function createMemory(name, description, type, body) {
  if (!name) return { error: "name is required" };
  const safeName = name.replace(/[^a-zA-Z0-9_\-一-鿿]/g, "_");
  const filename = safeName.endsWith(".md") ? safeName : safeName + ".md";
  const frontmatter = makeFrontMatter(name, description, type || "project");
  const content = frontmatter + (body || "");
  const filePath = join(MEM_DIR, filename);

  writeFileSync(filePath, content, "utf-8");
  addToIndex(filename, name, description || "");
  ftsInsert(filename, name, description || "", type || "project", body || "");
  return { ok: true, filename, name };
}

export function updateMemory(filename, body, name, description, type) {
  const existing = readMemory(filename);
  if (!existing) return { error: `Memory file not found: ${filename}` };

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

export function deleteMemory(filename) {
  const filePath = join(MEM_DIR, filename);
  try {
    unlinkSync(filePath);
    removeFromIndex(filename);
    ftsDelete(filename);
    return { ok: true };
  } catch (e) {
    return { error: e.message };
  }
}

// ── Search ────────────────────────────────────────────────────

export function searchMemory(query, limit = 10) {
  const db = getFtsDb();
  try {
    const rows = db.prepare(
      "SELECT filename, name, description, type, snippet(mem_fts,4,'<mark>','</mark>','…',64) as snippet, rank FROM mem_fts WHERE mem_fts MATCH ? ORDER BY rank LIMIT ?"
    ).all(query, limit);
    return rows.map(r => ({
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
    ).all("%" + query + "%", limit).map(r => ({
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

export function appendUserMemory(content) {
  // Convert to new format: create/update user_profile
  const existing = readMemory("user_profile.md");
  if (existing) {
    return updateMemory("user_profile.md", existing.body + "\n\n" + content);
  }
  return createMemory("user_profile", "About the user", "user", content);
}

export function appendProjectMemory(content) {
  // Create a new memory entry for each append call
  const name = "memory_" + Date.now().toString(36);
  return createMemory(name, "Project memory", "project", content);
}

export function writeUserMemory(content) {
  const existing = readMemory("user_profile.md");
  if (existing) {
    return updateMemory("user_profile.md", content);
  }
  return createMemory("user_profile", "About the user", "user", content);
}

export function writeProjectMemory(content) {
  // Legacy: write directly to index
  writeIndex(content);
  return { ok: true };
}

export function checkDuplicate(type, text) {
  const memories = listMemories();
  const words = text.split(/\s+/).filter(w => w.length > 2);
  if (words.length === 0) return false;
  for (const m of memories) {
    let matchCount = 0;
    for (const w of words) {
      if (m.body.includes(w)) matchCount++;
    }
    if (matchCount / words.length > 0.5) return true;
  }
  return false;
}

// ── Index on load (lazy) ──────────────────────────────────────
try { migrateFromOldFormat(); } catch { /* ignored */ }
