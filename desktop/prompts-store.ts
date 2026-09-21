/**
 * AideAgent Prompts Store — User-defined reusable prompts (Stage 2).
 *
 * Dir: ~/.aideagent/prompts/
 *   <uuid>.md       — one prompt per file, YAML frontmatter + body
 *
 * Each prompt has:
 *   - id:      UUID v4 (used as filename, stable across renames)
 *   - title:   user-facing label (renameable)
 *   - created: ISO timestamp
 *   - updated: ISO timestamp
 *
 * Body is plain text (markdown allowed). Capped at MAX_BODY_BYTES to keep
 * the textarea render cheap and the IPC payload small.
 *
 * Concurrency: single-process Electron app, no file lock needed.
 * Atomicity: writeFileSync is atomic on POSIX for files <PIPE_BUF; for our
 * small prompt files (typically <4 KB) this is safe. For Windows we
 * accept the small race window — only one renderer ever writes, and
 * "last write wins" is acceptable for this UX.
 */
import { join } from "path";
import { homedir } from "os";
import { randomUUID } from "crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
  statSync,
} from "fs";

const HOME = homedir();
const PROMPTS_DIR = join(HOME, ".aideagent", "prompts");

/** Max body size. Keeps textarea + IPC snappy. 16 KB ≈ 4000 Chinese chars. */
export const MAX_BODY_BYTES = 16 * 1024;

/** Max title length. Mirrors typical input field constraints. */
export const MAX_TITLE_LENGTH = 100;

if (!existsSync(PROMPTS_DIR)) {
  try { mkdirSync(PROMPTS_DIR, { recursive: true }); } catch { /* ignored */ }
}

// ── Frontmatter ──────────────────────────────────────────────

/**
 * Parse a YAML-ish frontmatter block. We handle four simple scalar fields
 * and use JSON-style quoting for `title` (via JSON.parse) so that quotes,
 * colons, and other YAML-special characters round-trip safely.
 *
 * @param {string} text
 * @returns {{ id: string, title: string, created: string, updated: string }}
 */
function parseFrontMatter(text) {
  const meta = { id: "", title: "", created: "", updated: "" };
  const match = text.match(/^---\s*\n([\s\S]*?)\n---/);
  if (!match) return meta;
  for (const line of match[1].split("\n")) {
    const kv = line.match(/^\s*(\w[\w-]*)\s*:\s*(.*)$/);
    if (!kv) continue;
    const key = kv[1];
    let val = kv[2];

    // Try JSON.parse for quoted values — this is how we round-trip
    // titles that contain quotes, colons, or other YAML-special chars.
    if (val.startsWith('"') && val.endsWith('"')) {
      try { val = JSON.parse(val); } catch { val = val.slice(1, -1); }
    } else {
      val = val.trim();
    }

    if (key === "id") meta.id = val;
    else if (key === "title") meta.title = val;
    else if (key === "created") meta.created = val;
    else if (key === "updated") meta.updated = val;
  }
  return meta;
}

/**
 * @param {string} id
 * @param {string} title
 * @param {string} created
 * @param {string} updated
 * @returns {string}
 */
function makeFrontMatter(id, title, created, updated) {
  // JSON.stringify handles all escaping (quotes, backslashes, control chars)
  // and produces a valid YAML double-quoted scalar.
  return `---
id: ${id}
title: ${JSON.stringify(title)}
created: ${created}
updated: ${updated}
---

`;
}

/**
 * Strip frontmatter from raw file content, return the body.
 * The regex consumes the blank line that separates frontmatter from body.
 * A single trailing newline is trimmed for cleanliness.
 * @param {string} text
 */
function stripFrontMatter(text) {
  return text.replace(/^---[\s\S]*?\n---\n+/, "").replace(/\n$/, "");
}

// ── Validation helpers ───────────────────────────────────────

/**
 * Validate a user-supplied prompt. Returns null on success, error message on fail.
 * @param {{ title?: string, body?: string }} input
 * @returns {string | null}
 */
function validateInput({ title, body }) {
  if (title === undefined && body === undefined) {
    return "title or body is required";
  }
  if (title !== undefined) {
    if (typeof title !== "string" || !title.trim()) {
      return "title is required (refusing empty)";
    }
    if (title.length > MAX_TITLE_LENGTH) {
      return `title too long (max ${MAX_TITLE_LENGTH} chars)`;
    }
  }
  if (body !== undefined) {
    if (typeof body !== "string" || !body) {
      return "body is required (refusing empty)";
    }
    if (Buffer.byteLength(body, "utf-8") > MAX_BODY_BYTES) {
      return `body too large (max ${MAX_BODY_BYTES} bytes)`;
    }
  }
  return null;
}

// ── CRUD ──────────────────────────────────────────────────────

/**
 * List all prompts (sorted newest-first by mtime).
 * @returns {Array<{ id: string, title: string, body: string, created: string, updated: string, filename: string, mtimeMs: number }>}
 */
export function listPrompts() {
  const results = [];
  try {
    const entries = readdirSync(PROMPTS_DIR);
    for (const entry of entries) {
      if (!entry.endsWith(".md")) continue;
      const filePath = join(PROMPTS_DIR, entry);
      try {
        const text = readFileSync(filePath, "utf-8");
        const meta = parseFrontMatter(text);
        if (!meta.id) meta.id = entry.replace(/\.md$/, "");
        if (!meta.title) meta.title = "(untitled)";
        let mtimeMs = 0;
        try { mtimeMs = statSync(filePath).mtimeMs; } catch { /* ignored */ }
        results.push({
          id: meta.id,
          title: meta.title,
          body: stripFrontMatter(text),
          created: meta.created,
          updated: meta.updated,
          filename: entry,
          mtimeMs,
        });
      } catch { /* ignored */ }
    }
  } catch { /* ignored */ }
  return results.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

/**
 * Read a single prompt by id.
 * @param {string} id
 * @returns {{ id: string, title: string, body: string, created: string, updated: string, filename: string } | null}
 */
export function readPrompt(id) {
  if (!id) return null;
  const filename = id.endsWith(".md") ? id : id + ".md";
  const filePath = join(PROMPTS_DIR, filename);
  try {
    const text = readFileSync(filePath, "utf-8");
    const meta = parseFrontMatter(text);
    return {
      id: meta.id || id,
      title: meta.title || "(untitled)",
      body: stripFrontMatter(text),
      created: meta.created,
      updated: meta.updated,
      filename,
    };
  } catch {
    return null;
  }
}

/**
 * Create a new prompt. Auto-generates id and timestamps.
 * @param {{ title: string, body: string }} input
 * @returns {{ ok: boolean, id?: string, title?: string, filename?: string, error?: string }}
 */
export function createPrompt({ title, body }) {
  const validationErr = validateInput({ title, body });
  if (validationErr) return { ok: false, error: validationErr };

  const id = randomUUID();
  const now = new Date().toISOString();
  const filename = id + ".md";
  const filePath = join(PROMPTS_DIR, filename);
  const content = makeFrontMatter(id, title.trim(), now, now) + body;

  try {
    writeFileSync(filePath, content, "utf-8");
    return { ok: true, id, title: title.trim(), filename };
  } catch (/** @type {any} */ e) {
    return { ok: false, error: `write failed: ${e.message}` };
  }
}

/**
 * Update an existing prompt (title and/or body).
 * @param {string} id
 * @param {{ title?: string, body?: string }} input
 * @returns {{ ok: boolean, id?: string, title?: string, error?: string }}
 */
export function updatePrompt(id, { title, body }) {
  if (!id) return { ok: false, error: "id is required" };

  const existing = readPrompt(id);
  if (!existing) return { ok: false, error: `prompt not found: ${id}` };

  // Merge — only fields that were provided get updated
  const nextTitle = title !== undefined ? title : existing.title;
  const nextBody = body !== undefined ? body : existing.body;

  const validationErr = validateInput({ title: nextTitle, body: nextBody });
  if (validationErr) return { ok: false, error: validationErr };

  const now = new Date().toISOString();
  const filePath = join(PROMPTS_DIR, existing.filename);
  const content = makeFrontMatter(existing.id, nextTitle.trim(), existing.created, now) + nextBody;

  try {
    writeFileSync(filePath, content, "utf-8");
    return { ok: true, id: existing.id, title: nextTitle.trim() };
  } catch (/** @type {any} */ e) {
    return { ok: false, error: `write failed: ${e.message}` };
  }
}

/**
 * Delete a prompt by id.
 * @param {string} id
 * @returns {{ ok: boolean, id?: string, error?: string }}
 */
export function deletePrompt(id) {
  if (!id) return { ok: false, error: "id is required" };
  const filename = id.endsWith(".md") ? id : id + ".md";
  const filePath = join(PROMPTS_DIR, filename);
  try {
    unlinkSync(filePath);
    return { ok: true, id };
  } catch (/** @type {any} */ e) {
    if (e.code === "ENOENT") return { ok: false, error: `prompt not found: ${id}` };
    return { ok: false, error: `delete failed: ${e.message}` };
  }
}

/**
 * Get the prompts directory path (useful for the UI / tests).
 * @returns {string}
 */
export function getPromptsDir() {
  return PROMPTS_DIR;
}