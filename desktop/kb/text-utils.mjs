/**
 * Text utilities for FTS5 tokenization and query sanitization.
 *
 * These functions are pure (no IO, no shared state) and are safe to call
 * from any context. They're used by both the indexing path (when storing
 * chunks) and the search path (when matching queries).
 *
 * Re-exported from knowledge-store.mjs for backward compatibility.
 */

// Space out CJK characters individually so FTS5 unicode61 tokenizes them as separate tokens.
// "故宫博物院" → "故 宫 博 物 院"
/** @param {string} text @returns {string} */
export function spaceCJK(text) {
  if (!text) return text;
  return text.replace(/([一-鿿㐀-䶿⺀-⻿])/g, "$1 ").trim();
}

/**
 * Sanitize a single token before it goes into an FTS5 MATCH expression.
 * FTS5 has many metacharacters (" * ( ) : ^ - + . ,) that can break the
 * parser or change query semantics in surprising ways. Strip all but
 * letters/digits/CJK/underscore/dash, then re-quote with double quotes.
 * @param {string} term
 * @returns {string} sanitized term safe to wrap in "..." for FTS5
 */
export function sanitizeFtsTerm(term) {
  if (!term) return "";
  // Keep letters, digits, CJK, underscore, dash. Strip everything else.
  return term.replace(/[^\w一-鿿㐀-䶿\-]/g, "");
}
