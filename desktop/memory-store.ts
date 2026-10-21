/**
 * AideAgent Memory Store — Multi-file memory with frontmatter
 *
 * Dir: ~/.aideagent/memory/
 *   MEMORY.md                — index entrypoint (≤200 lines)
 *   user_profile.md          — one file per memory, YAML frontmatter
 *   ...
 *
 * `user` / `feedback` files are global. `project` / `reference` files carry a
 * stable `workspace: <hash>` frontmatter field and are filtered by the current
 * workspace at every read, search, prompt-injection, and purge boundary.
 */

import { join, resolve } from "path";
import { homedir } from "os";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, unlinkSync, statSync, utimesSync, renameSync } from "fs";
import { DatabaseSync } from "node:sqlite";

const HOME = homedir();
// Tests set AIDEAGENT_MEMORY_DIR so they never touch the user's real memory.
const MEM_DIR = process.env.AIDEAGENT_MEMORY_DIR
  ? resolve(process.env.AIDEAGENT_MEMORY_DIR)
  : join(HOME, ".aideagent", "memory");
const OLD_DIR = process.env.AIDEAGENT_MEMORY_DIR
  ? join(MEM_DIR, "..", "memories")
  : join(HOME, ".aideagent", "memories");
const INDEX_PATH = join(MEM_DIR, "MEMORY.md");
const FTS_PATH = join(MEM_DIR, "memory-fts.db");
const ARCHIVE_DIR = join(MEM_DIR, "archive");

const MAX_INDEX_LINES = 200;
const MAX_INDEX_BYTES = 25000;

// User preferences live in one small "core memory" file. Keep it bounded and
// newest-first so the 800-char injection slice never hides the latest rule.
const USER_PROFILE_MAX_CHARS = 2400;
const USER_PROFILE_HEADER = "## 用户偏好（最新优先，冲突时以最新为准）";

/**
 * Scope selector for memory reads/writes.
 *
 * `user` and `feedback` are global (shared across projects).
 * `project` and `reference` are scoped to one workspace.
 *
 * Callers in the app must pass `{ workspace: getWorkspace() }`. Calls without
 * a workspace keep the old "see everything" behavior for tests / migrations.
 */
export interface MemoryScope {
  workspace?: string | null;
  /** Explicitly include every workspace (UI admin/debug/test only). */
  includeAll?: boolean;
}

export interface MemoryWriteOptions extends MemoryScope {
  title?: string;
  summary?: string;
  /** project (default) or reference. */
  type?: "project" | "reference";
}

export interface MemoryFile {
  filename: string;
  name: string;
  description: string;
  type: string;
  body: string;
  mtimeMs: number;
  mtime?: number;
  /** "global" for user/feedback; a workspace hash for project/reference. */
  workspace?: string;
}

/** Stable, path-safe id for a workspace. */
export function memoryWorkspaceId(workspace?: string | null): string {
  if (!workspace) return "";
  const normalized = process.platform === "win32"
    ? resolve(workspace).toLowerCase()
    : resolve(workspace);
  return createHash("sha1").update(normalized).digest("hex").slice(0, 12);
}

function isGlobalMemoryType(type: string): boolean {
  return type === "user" || type === "feedback";
}

function inScope(mem: { type: string; workspace?: string }, opts?: MemoryScope): boolean {
  if (!opts?.workspace || opts.includeAll) return true;
  if (isGlobalMemoryType(mem.type)) return true;
  return !!mem.workspace && mem.workspace === memoryWorkspaceId(opts.workspace);
}

function normalizedWorkspaceFor(type: string, opts?: MemoryScope): string {
  if (isGlobalMemoryType(type)) return "global";
  return opts?.workspace ? memoryWorkspaceId(opts.workspace) : "";
}

function firstLine(text: string, max = 160): string {
  const line = String(text || "").split(/\r?\n/).map(s => s.trim()).find(Boolean) || "";
  return line.length > max ? line.slice(0, max) + "…" : line;
}

function safeTitle(title: string | undefined, fallback: string): string {
  const raw = (title || "").trim();
  return raw || fallback;
}
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
export function memoryAgeDays(mtimeMs: number): number {
  if (!mtimeMs || mtimeMs <= 0) return 0;
  const diff = Date.now() - mtimeMs;
  return Math.max(0, Math.floor(diff / 86_400_000));
}

export function memoryAge(mtimeMs: number): string {
  const days = memoryAgeDays(mtimeMs);
  if (days === 0) return "today";
  if (days === 1) return "yesterday";
  return `${days} days ago`;
}

export function memoryFreshnessNote(mtimeMs: number): string {
  const days = memoryAgeDays(mtimeMs);
  if (days <= 1) return "";
  return `\n> ⚠️ This memory is ${days} days old. Memories are point-in-time observations — claims about code paths, file locations, or function names may be outdated. Verify against current code before acting.`;
}

// ── FTS5 ──────────────────────────────────────────────────────

let _ftsDb: import("node:sqlite").DatabaseSync | null = null;
function getFtsDb() {
  if (_ftsDb) return _ftsDb;
  _ftsDb = new DatabaseSync(FTS_PATH);
  _ftsDb.exec("PRAGMA journal_mode=WAL");
  _ftsDb.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS mem_fts USING fts5(
    filename, name, description, type, body, tokenize='unicode61'
  )`);
  return _ftsDb;
}

export function closeFtsDb() {
  if (!_ftsDb) return;
  try { _ftsDb.close(); } catch { /* ignore — already closed or invalid */ }
  _ftsDb = null;
}

function ftsDelete(filename: string) {
  try { getFtsDb().prepare("DELETE FROM mem_fts WHERE filename = ?").run(filename); } catch { /* ignored */ }
}

function ftsInsert(filename: string, name: string, description: string, type: string, body: string) {
  try {
    ftsDelete(filename);
    getFtsDb().prepare("INSERT INTO mem_fts(filename, name, description, type, body) VALUES (?,?,?,?,?)")
      .run(filename, name || "", description || "", type || "", body || "");
  } catch { /* ignored */ }
}

// ── Frontmatter ───────────────────────────────────────────────

function parseFrontMatter(text: string): { name: string, description: string, type: string, workspace: string } {
  const meta = { name: "", description: "", type: "project", workspace: "" };
  const match = text.match(/^---\s*\n([\s\S]*?)\n---/);
  if (!match) return meta;
  for (const line of match[1].split("\n")) {
    const kv = line.match(/^\s*(\w[\w-]*)\s*:\s*(.+)/);
    if (kv) {
      const val = kv[2].trim().replace(/^["']|["']$/g, "");
      if (kv[1] === "name") meta.name = val;
      else if (kv[1] === "description") meta.description = val;
      else if (kv[1] === "type") meta.type = val;
      else if (kv[1] === "workspace") meta.workspace = val;
    }
  }
  return meta;
}

function makeFrontMatter(name: string, description: string, type: string, workspace?: string): string {
  return `---
name: ${name}
description: ${description}
type: ${type}
${workspace ? `workspace: ${workspace}\n` : ""}---

`;
}

// ── Index management ──────────────────────────────────────────

function readIndex() {
  try { return readFileSync(INDEX_PATH, "utf-8"); } catch { return ""; }
}

/**
 * @param {string} content
 */
function writeIndex(content: string) {
  try { writeFileSync(INDEX_PATH, content, "utf-8"); } catch { /* ignored */ }
}

function addToIndex(filename: string, name: string, description: string) {
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

function removeFromIndex(filename: string) {
  let idx = readIndex();
  idx = idx.split("\n").filter(l => !l.includes(`(${filename})`)).join("\n");
  writeIndex(idx);
}

// ── CRUD ──────────────────────────────────────────────────────

/**
 * One-time migration for old (pre-scope) project/reference files: assign them
 * to the first workspace that opens the memory store. user/feedback are
 * global and do not need a workspace.
 *
 * This avoids the worst failure mode — an unscoped project memory leaking into
 * every other project — without deleting old data.
 */
const _legacyAdopted = new Set<string>();

function adoptLegacyProjectMemories(workspaceId: string): void {
  if (!workspaceId || _legacyAdopted.has(workspaceId)) return;
  _legacyAdopted.add(workspaceId);
  let entries: string[];
  try { entries = readdirSync(MEM_DIR); } catch { return; }
  for (const entry of entries) {
    if (!entry.endsWith(".md") || entry === "MEMORY.md") continue;
    const filePath = join(MEM_DIR, entry);
    try {
      const text = readFileSync(filePath, "utf-8");
      const meta = parseFrontMatter(text);
      if (isGlobalMemoryType(meta.type) || meta.workspace) continue;
      const body = text.replace(/^---[\s\S]*?\n---\n?/, "").trim();
      const before = statSync(filePath);
      writeFileSync(
        filePath,
        makeFrontMatter(meta.name || entry.replace(/\.md$/, ""), meta.description || "", meta.type || "project", workspaceId) + body,
        "utf-8",
      );
      // Keep age/selection ordering stable across the one-time migration.
      try { utimesSync(filePath, before.atime, before.mtime); } catch { /* ignored */ }
    } catch { /* ignored — a malformed file must not block the rest */ }
  }
}

/**
 * @param opts Omit for admin/test "all workspaces" behavior. App callers should
 *             pass `{ workspace: getWorkspace() }`.
 */
export function listMemories(opts?: MemoryScope): MemoryFile[] {
  if (opts?.workspace && !opts.includeAll) {
    adoptLegacyProjectMemories(memoryWorkspaceId(opts.workspace));
  }
  const results: MemoryFile[] = [];
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
        const mem: MemoryFile = {
          filename: entry,
          name: meta.name,
          description: meta.description || "",
          type: meta.type || "project",
          body: text.replace(/^---[\s\S]*?\n---\n?/, "").trim(),
          mtimeMs,
          workspace: meta.workspace || (isGlobalMemoryType(meta.type) ? "global" : ""),
        };
        if (inScope(mem, opts)) results.push(mem);
      } catch { /* ignored */ }
    }
  } catch { /* ignored */ }
  // Sort newest-first by modification time
  return results.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

export function readMemory(filename: string, opts?: MemoryScope): { filename: string, name: string, description: string, type: string, body: string, workspace?: string } | null {
  // Tool arguments are model-controlled. Never allow ../ or an absolute path
  // to turn read_memory into an arbitrary file reader.
  if (!filename || filename === "MEMORY.md" || !filename.endsWith(".md") ||
      /[/\\\0]/.test(filename) || filename === "." || filename === "..") {
    return null;
  }
  if (opts?.workspace && !opts.includeAll) {
    adoptLegacyProjectMemories(memoryWorkspaceId(opts.workspace));
  }
  const filePath = join(MEM_DIR, filename);
  try {
    const text = readFileSync(filePath, "utf-8");
    const meta = parseFrontMatter(text);
    const type = meta.type || "project";
    const workspace = meta.workspace || (isGlobalMemoryType(type) ? "global" : "");
    if (!inScope({ type, workspace }, opts)) return null;
    return {
      filename,
      name: meta.name || filename.replace(/\.md$/, ""),
      description: meta.description || "",
      type,
      body: text.replace(/^---[\s\S]*?\n---\n?/, "").trim(),
      workspace,
    };
  } catch {
    return null;
  }
}

/** Avoid silently overwriting a memory when the UI reuses a name. */
function uniqueFilename(base: string): string {
  const safe = base.replace(/[^a-zA-Z0-9_\-一-鿿]/g, "_") || "memory";
  const stem = safe.endsWith(".md") ? safe.slice(0, -3) : safe;
  let filename = `${stem}.md`;
  let n = 2;
  while (existsSync(join(MEM_DIR, filename))) {
    filename = `${stem}-${n}.md`;
    n++;
  }
  return filename;
}

export function createMemory(
  name: string,
  description?: string,
  type?: string,
  body?: string,
  opts?: MemoryScope,
): { ok: boolean, filename?: string, name?: string, error?: string } {
  if (!name) return { ok: false, error: "name is required" };
  // P1: reject empty bodies to prevent empty memory files
  if (!body || !String(body).trim()) {
    return { ok: false, error: "body is required (refusing to create empty memory)" };
  }
  const memType = type || "project";
  const workspace = normalizedWorkspaceFor(memType, opts);
  const filename = uniqueFilename(name);
  const frontmatter = makeFrontMatter(name, description || "", memType, workspace);
  const content = frontmatter + (body || "");
  const filePath = join(MEM_DIR, filename);

  writeFileSync(filePath, content, "utf-8");
  addToIndex(filename, name, description || "");
  ftsInsert(filename, name, description || "", memType, body || "");
  return { ok: true, filename, name };
}

export function updateMemory(
  filename: string,
  body?: string,
  name?: string,
  description?: string,
  type?: string,
  opts?: MemoryScope,
): { ok: boolean, filename?: string, name?: string, error?: string } {
  const existing = readMemory(filename, opts);
  if (!existing) return { ok: false, error: `Memory file not found in this workspace: ${filename}` };

  const n = name || existing.name;
  const d = description !== undefined ? description : existing.description;
  const t = type || existing.type;
  const workspace = normalizedWorkspaceFor(t, opts) || existing.workspace || "";
  const frontmatter = makeFrontMatter(n, d, t, workspace);
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
export function purgeByType(type: string, opts?: MemoryScope): { ok: boolean, removed?: number, names?: string[], failed?: string[], error?: string } {
  if (!type || (type !== "project" && type !== "feedback" && type !== "reference")) {
    return { ok: false, error: `invalid type: ${type} (refusing to bulk-delete user memories)` };
  }
  const all = listMemories(opts).filter(m => m.type === type);
  const removed = [];
  const failed = [];
  for (const m of all) {
    const r = deleteMemory(m.filename, opts);
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

export function deleteMemory(filename: string, opts?: MemoryScope): { ok: boolean, error?: string } {
  if (!readMemory(filename, opts)) {
    return { ok: false, error: `Memory file not found in this workspace: ${filename}` };
  }
  const filePath = join(MEM_DIR, filename);
  try {
    unlinkSync(filePath);
    removeFromIndex(filename);
    ftsDelete(filename);
    return { ok: true };
  } catch (e: any) {
    return { ok: false, error: e.message };
  }
}

/**
 * Move an evicted memory out of the active pool instead of deleting it.
 * Cap enforcement is lossy by design until now; archiving keeps the old note
 * recoverable without injecting it into every future prompt.
 */
export function archiveMemory(filename: string, opts?: MemoryScope): { ok: boolean, archivedTo?: string, error?: string } {
  if (!readMemory(filename, opts)) {
    return { ok: false, error: `Memory file not found in this workspace: ${filename}` };
  }
  try {
    mkdirSync(ARCHIVE_DIR, { recursive: true });
    const archivedTo = join(ARCHIVE_DIR, `${Date.now().toString(36)}-${filename}`);
    renameSync(join(MEM_DIR, filename), archivedTo);
    removeFromIndex(filename);
    ftsDelete(filename);
    return { ok: true, archivedTo };
  } catch (e: any) {
    return { ok: false, error: e.message };
  }
}

// ── Search ────────────────────────────────────────────────────

export function searchMemory(query: string, limit = 10, opts?: MemoryScope): Array<{ filename: string, name: string, description: string, type: string, snippet: string, rank: number }> {
  const db = getFtsDb();
  const visible = opts?.workspace && !opts.includeAll
    ? new Set(listMemories(opts).map(m => m.filename))
    : null;
  const dbLimit = visible ? Math.max(limit * 4, limit) : limit;
  try {
    const rows = db.prepare(
      "SELECT filename, name, description, type, snippet(mem_fts,4,'<mark>','</mark>','…',64) as snippet, rank FROM mem_fts WHERE mem_fts MATCH ? ORDER BY rank LIMIT ?"
    ).all(query, dbLimit).map((r: any) => ({
      filename: r.filename,
      name: r.name,
      description: r.description,
      type: r.type,
      snippet: r.snippet,
      rank: r.rank,
    }));
    return (visible ? rows.filter((r: any) => visible.has(r.filename)) : rows).slice(0, limit);
  } catch {
    // LIKE fallback for CJK
    const rows = db.prepare(
      "SELECT filename, name, description, type, body FROM mem_fts WHERE body LIKE ? LIMIT ?"
    ).all("%" + query + "%", dbLimit).map((r: any) => ({
      filename: r.filename, name: r.name, description: r.description,
      type: r.type, snippet: String(r.body || "").substring(0, 200), rank: 0,
    }));
    return (visible ? rows.filter((r: any) => visible.has(r.filename)) : rows).slice(0, limit);
  }
}

export function getMemoryIndex(opts?: MemoryScope): string {
  const memories = listMemories(opts);
  const lines: string[] = [];
  for (const m of memories) {
    const line = `- [${m.name}](${m.filename}) — ${m.description}`;
    if (Buffer.byteLength(lines.join("\n") + line, "utf-8") >= MAX_INDEX_BYTES) break;
    if (lines.length >= MAX_INDEX_LINES) break;
    lines.push(line);
  }
  return lines.join("\n");
}

export function rebuildIndex() {
  const memories = listMemories();
  const idx = getMemoryIndex({ includeAll: true });
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

export function readProjectMemory(opts?: MemoryScope) {
  // Build a scoped index instead of returning the global MEMORY.md file:
  // project/reference entries from other workspaces must never be injected.
  return getMemoryIndex(opts);
}

function localDate(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * Append a user preference to the bounded core profile.
 *
 * Newest-first is deliberate: `renderMemories()` injects the first ~800 chars,
 * so an append-at-end file would gradually hide the newest preferences.
 */
export function appendUserMemory(content: string): { ok: boolean, filename?: string, name?: string, error?: string, duplicate?: boolean } {
  const text = String(content || "").trim();
  if (!text) return { ok: false, error: "content is required" };

  const existing = readMemory("user_profile.md");
  const oldBody = existing?.body || "";
  // Short preferences ("use tabs") have one meaningful token, so the
  // token-overlap heuristic would treat any two of them as duplicates. Only
  // use it when there is enough signal; exact containment still catches the
  // common repeat case.
  const enoughSignal = tokenizeForMemory(text).length >= 3;
  if (oldBody.includes(text) || (oldBody && enoughSignal && checkDuplicate("user", text))) {
    return { ok: true, filename: "user_profile.md", name: "user_profile", duplicate: true };
  }

  const entry = `- ${localDate()}: ${text.replace(/\r?\n/g, "\n  ")}`;
  const oldContent = oldBody
    .replace(USER_PROFILE_HEADER, "")
    .replace(/^##\s+用户偏好[^\n]*\n?/, "")
    .trim();
  let body = `${USER_PROFILE_HEADER}\n${entry}`;
  if (oldContent) body += `\n${oldContent}`;

  if (body.length > USER_PROFILE_MAX_CHARS) {
    body = body.slice(0, USER_PROFILE_MAX_CHARS).replace(/\s+\S*$/, "") +
      "\n…(更早的偏好已省略)";
  }

  const description = "About the user — latest preferences, background, knowledge";
  if (existing) {
    return updateMemory("user_profile.md", body, "user_profile", description, "user");
  }
  return createMemory("user_profile", description, "user", body, { workspace: "global" });
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
export function tokenizeForMemory(text: string): string[] {
  if (!text) return [];
  const s = String(text);
  const tokens: string[] = [];

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

/**
 * Find a topic-coherent memory to merge into. 70% token overlap, ≥5 shared
 * tokens, and a length ratio within 2x keep "kitchen sink" files from forming.
 */
function findMergeCandidate(candidates: MemoryFile[], content: string): MemoryFile | null {
  const newTokens = tokenizeForMemory(content);
  if (newTokens.length === 0) return null;
  const newTokenSet = new Set(newTokens);
  for (const m of candidates) {
    const existingTokens = new Set(tokenizeForMemory(m.body));
    let overlapCount = 0;
    for (const t of newTokenSet) {
      if (existingTokens.has(t)) overlapCount++;
    }
    const ratio = overlapCount / newTokenSet.size;
    const lengthRatio = Math.max(content.length, m.body.length) /
                        Math.min(content.length, m.body.length);
    if (ratio >= 0.7 && overlapCount >= 5 && lengthRatio <= 2) return m;
  }
  return null;
}

/**
 * Append a project/reference memory, scoped to `opts.workspace`.
 *
 * The old unscoped version wrote every note into one global pool, so a memory
 * from project A could be injected while working in project B. Passing
 * `workspace` keeps project/reference data local; user/feedback stay global.
 */
export function appendProjectMemory(content: string, opts?: MemoryWriteOptions) {
  // P1: reject empty content
  if (!content || !String(content).trim()) {
    return { ok: false, error: "content is required (refusing to append empty memory)" };
  }
  const safeContent = String(content).trim();
  const memType = opts?.type === "reference" ? "reference" : "project";
  const scope: MemoryScope = { workspace: opts?.workspace, includeAll: opts?.includeAll };

  const candidates = listMemories(scope)
    .filter(m => m.type === memType && m.body && m.body.trim())
    .slice(0, 20);
  const mergeTarget = findMergeCandidate(candidates, safeContent);
  if (mergeTarget) {
    const today = localDate();
    const merged = `${mergeTarget.body}\n\n---\n\n[更新 ${today}]\n${safeContent}`;
    const name = opts?.title ? safeTitle(opts.title, mergeTarget.name).slice(0, 80) : mergeTarget.name;
    const summary = opts?.summary?.trim() || mergeTarget.description;
    const result = updateMemory(mergeTarget.filename, merged, name, summary, memType, scope);
    return { ...result, merged: true };
  }

  // Cap only project notes; reference pointers are long-lived and cheap.
  if (memType === "project") enforceProjectMemoryCap(scope);

  const fallbackName = (memType === "reference" ? "reference_" : "memory_") + Date.now().toString(36);
  const name = safeTitle(opts?.title, fallbackName).slice(0, 80);
  const summary = opts?.summary?.trim() || firstLine(safeContent);
  return createMemory(name, summary, memType, safeContent, scope);
}

/** Feedback is global (a correction should apply in every project). */
export function appendFeedbackMemory(
  content: string,
  opts?: { title?: string; summary?: string; workspace?: string | null },
) {
  if (!content || !String(content).trim()) {
    return { ok: false, error: "content is required (refusing to append empty memory)" };
  }
  const safeContent = String(content).trim();
  const candidates = listMemories({ workspace: opts?.workspace })
    .filter(m => m.type === "feedback" && m.body && m.body.trim())
    .slice(0, 20);
  const mergeTarget = findMergeCandidate(candidates, safeContent);
  if (mergeTarget) {
    const merged = `${mergeTarget.body}\n\n---\n\n[更新 ${localDate()}]\n${safeContent}`;
    const name = opts?.title ? safeTitle(opts.title, mergeTarget.name).slice(0, 80) : mergeTarget.name;
    const result = updateMemory(
      mergeTarget.filename, merged, name,
      opts?.summary?.trim() || mergeTarget.description, "feedback",
      { workspace: opts?.workspace },
    );
    return { ...result, merged: true };
  }

  const fallbackName = "feedback_" + Date.now().toString(36);
  return createMemory(
    safeTitle(opts?.title, fallbackName).slice(0, 80),
    opts?.summary?.trim() || firstLine(safeContent),
    "feedback",
    safeContent,
    { workspace: opts?.workspace },
  );
}

/**
 * If there are more than MAX_PROJECT_MEMORIES project-type memory files in the
 * current scope, delete the oldest ones (by mtime) until the count is within
 * the cap. User, feedback, and reference memories are NOT touched.
 * @returns {{ removed: number, names: string[] }}
 */
export function enforceProjectMemoryCap(opts?: MemoryScope) {
  const all = listMemories(opts);
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
    const r = archiveMemory(m.filename, opts);
    if (r?.ok) removed.push(m.filename);
  }
  if (removed.length > 0) {
    console.log(`[memory-store] cap reached: archived ${removed.length} oldest project memory(ies): ${removed.join(", ")}`);
  }
  return { removed: removed.length, names: removed };
}

export function writeUserMemory(content: string): { ok: boolean, filename?: string, name?: string, error?: string } {
  const existing = readMemory("user_profile.md");
  if (existing) {
    return updateMemory("user_profile.md", content, undefined, undefined, "user", { workspace: "global" });
  }
  return createMemory("user_profile", "About the user", "user", content, { workspace: "global" });
}

export function writeProjectMemory(content: string): { ok: boolean } {
  // Legacy: write directly to index. The prompt now builds a scoped index via
  // getMemoryIndex(), so this only affects admin/debug views.
  writeIndex(content);
  return { ok: true };
}

export function checkDuplicate(
  type: string,
  text: string,
  opts?: MemoryScope & { excludeFilename?: string },
): boolean {
  const memories = listMemories(opts).filter(m =>
    m.type === type && m.filename !== opts?.excludeFilename,
  );
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
