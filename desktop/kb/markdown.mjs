/**
 * Markdown parsing for the knowledge base.
 *
 * Pure functions only — no IO, no shared state, no external dependencies
 * beyond node:path's basename for filename handling.
 * Used both at index time (splitIntoChunks for chunking) and at search
 * time (heading-based filtering).
 *
 * Re-exported from knowledge-store.mjs for backward compatibility.
 */

import { basename } from "node:path";

// ── Chunking configuration ──────────────────────────────
const CHUNK_SIZE = 500;   // chars per chunk (fixed-size fallback)
const CHUNK_OVERLAP = 100; // overlap between consecutive fixed-size chunks

/**
 * Strip Markdown formatting for clean embedding text.
 * Removes headings markers, bold/italic, wikilinks, code markers, strikethrough.
 * Collapses multiple newlines.
 * @param {string} text
 * @returns {string}
 */
export function stripMarkdown(text) {
  return text
    .replace(/#{1,6}\s+/g, "")
    .replace(/\*{1,3}_ {1,3}/g, "")
    // [[note]] → "note", [[note|display text]] → "display text"
    // The display text is the user-facing semantic content; the note path
    // is for link resolution and shouldn't dominate embedding/keyword signals.
    .replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_, target, display) => display || target)
    .replace(/[*_`~]/g, "")
    .replace(/\n{2,}/g, "\n")
    .trim();
}

/**
 * Strip a full note's raw content to its embeddable body.
 * Handles frontmatter, headings, wikilinks, formatting, and whitespace — the
 * SAME logic for ALL paths (rebuild, watcher, create, update). Previously the
 * watcher path skipped wikilinks/formatting, producing different chunk content
 * from the rebuild path. This is the single source of truth.
 * @param {string} content
 * @returns {string}
 */
export function stripNoteBody(content) {
  return content
    .replace(/^---\s*\n[\s\S]*?\n---\s*\n?/, "")
    .replace(/#{1,6}\s+/g, "")
    // [[note]] → "note", [[note|display text]] → "display text"
    .replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_, target, display) => display || target)
    .replace(/[*_`~]/g, "")
    .replace(/\n{2,}/g, "\n")
    .trim();
}

/**
 * Split note body into semantic chunks.
 *
 * Strategy (tiered):
 *   1. Heading-based — split on `##` (or higher) headings.
 *      Each section becomes a chunk tagged with its heading for context.
 *   2. Single-heading — if the note has only one `#` (title) or no headings,
 *      or all sections have very short content, fall through to fixed-size.
 *   3. Fixed-size — CHUNK_SIZE chars with CHUNK_OVERLAP.
 *
 * @param {string} rawBody - Full note body with frontmatter already stripped
 * @param {string} [fallbackTitle] - Note title used when no heading is found
 * @returns {Array<{heading:string, content:string}>}
 */
export function splitIntoChunks(rawBody, fallbackTitle = "") {
  /** @type {Array<{heading:string, content:string}>} */
  const chunks = [];
  const body = (rawBody || "").trim();
  if (!body) return chunks;

  // ── Attempt 1: heading-based split ──────────────────────────
  // Match ## or higher (level 2-6). We skip # (level 1) because
  // that's usually the document title, not a section divider.
  // Note: capture group 1 is the hashes (## or ###...), group 2 is the
  // heading text. With {2,6} the hash group IS captured.
  const headingMatches = [...body.matchAll(/^(#{2,6})\s+(.+)$/gm)];

  if (headingMatches.length >= 2) {
    // Capture content BEFORE the first heading as a lead chunk. Previously
    // this was silently dropped — intro/lead content was invisible to
    // search. Now it gets indexed under the note title (≥20 chars guard
    // skips trivial frontmatter leftovers).
    const firstHeadingStart = headingMatches[0].index;
    const lead = body.slice(0, firstHeadingStart).trim();
    if (lead && lead.length >= 20) {
      chunks.push({ heading: fallbackTitle || "", content: stripMarkdown(lead) });
    }

    for (let i = 0; i < headingMatches.length; i++) {
      const start = headingMatches[i].index;
      const end = i + 1 < headingMatches.length ? headingMatches[i + 1].index : body.length;
      const rawSection = body.slice(start, end).trim();
      if (rawSection) {
        chunks.push({
          heading: headingMatches[i][2].trim(),
          content: stripMarkdown(rawSection),
        });
      }
    }
  }

  // ── Attempt 2: single # heading ────────────────────────────
  if (chunks.length === 0) {
    // BUGFIX: with #{1}, V8 may optimize away the capture group for the
    // single-hash, leaving only group 1 = heading text. Using [1] works
    // for both cases (the {1}-quantified hash is not captured, and the
    // text is the first group).
    const h1Matches = [...body.matchAll(/^#\s+(.+)$/gm)];
    if (h1Matches.length >= 2) {
      // Same lead-capture fix as Attempt 1
      const firstH1Start = h1Matches[0].index;
      const lead = body.slice(0, firstH1Start).trim();
      if (lead && lead.length >= 20) {
        chunks.push({ heading: fallbackTitle || "", content: stripMarkdown(lead) });
      }

      for (let i = 0; i < h1Matches.length; i++) {
        const start = h1Matches[i].index;
        const end = i + 1 < h1Matches.length ? h1Matches[i + 1].index : body.length;
        const rawSection = body.slice(start, end).trim();
        if (rawSection) {
          chunks.push({
            heading: h1Matches[i][1].trim(),
            content: stripMarkdown(rawSection),
          });
        }
      }
    }
  }

  // ── Fallback: fixed-size with overlap ──────────────────────
  if (chunks.length === 0) {
    const clean = stripMarkdown(body);
    let start = 0;
    while (start < clean.length) {
      const end = Math.min(start + CHUNK_SIZE, clean.length);
      const piece = clean.slice(start, end).trim();
      if (piece) {
        chunks.push({ heading: start === 0 ? fallbackTitle : "", content: piece });
      }
      if (end >= clean.length) break;
      start = end - CHUNK_OVERLAP;
    }
  }

  return chunks;
}

// ── Frontmatter Parser ────────────────────────────────────

/** @param {string} text @returns {{title:string, tags:string[], aliases:string[]}} */
export function parseFrontMatter(text) {
  /** @type {{title:string, tags:string[], aliases:string[]}} */
  const meta = { title: "", tags: [], aliases: [] };
  const match = text.match(/^---\s*\n([\s\S]*?)\n---/);
  if (!match) return meta;
  for (const line of match[1].split("\n")) {
    const kv = line.match(/^\s*(\w[\w-]*)\s*:\s*(.+)/);
    if (kv) {
      const key = kv[1];
      let val = kv[2].trim().replace(/^["']|["']$/g, "");
      if (key === "title" || key === "name") meta.title = val;
      else if (key === "tags") {
        // Handle both [tag1, tag2] and "tag1, tag2" formats
        if (val.startsWith("[")) {
          meta.tags = val.slice(1, -1).split(",").map(t => t.trim().replace(/^["']|["']$/g, ""));
        } else {
          meta.tags = val.split(",").map(t => t.trim());
        }
      }
      else if (key === "aliases") {
        if (val.startsWith("[")) {
          meta.aliases = val.slice(1, -1).split(",").map(t => t.trim().replace(/^["']|["']$/g, ""));
        } else {
          meta.aliases = [val];
        }
      }
    }
  }
  return meta;
}

/** @param {string} text @param {string} filename @returns {string} */
export function extractTitle(text, filename) {
  // Try frontmatter title first
  const fm = parseFrontMatter(text);
  if (fm.title) return fm.title;
  // Try first H1 heading
  const h1 = text.match(/^#\s+(.+)$/m);
  if (h1) return h1[1].trim();
  // Fallback to filename
  return basename(filename, ".md");
}

/** @param {string} text @returns {string[]} */
export function extractTags(text) {
  const fm = parseFrontMatter(text);
  /** @type {Set<string>} */
  const tags = new Set(fm.tags);
  // Also extract inline #tags
  const inlineTags = text.matchAll(/(?<=^|\s)#([a-zA-Z一-鿿][\w一-鿿-]*)/gm);
  for (const m of inlineTags) tags.add(m[1]);
  return [...tags];
}
