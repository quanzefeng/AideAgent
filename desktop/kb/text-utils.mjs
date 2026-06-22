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

/**
 * Build a safe FTS5 MATCH expression from an arbitrary user query.
 *
 * This is the high-level sanitizer all FTS5 search paths should use.
 * It handles:
 *   1. Splitting the query into whitespace-separated terms
 *   2. Spacing out CJK runs (so unicode61 tokenizes per-character)
 *   3. Stripping FTS5 metacharacters from each term
 *   4. Wrapping each sanitized term in double quotes (literal phrase)
 *
 * Why quote each term: an unquoted `code*` would be parsed as a prefix
 * query by FTS5, which is rarely what the user wanted when typing a
 * literal search. Quoting forces exact-token match.
 *
 * Why split + quote (not quote the whole string): `"code test"` is a
 * single phrase requiring both words adjacent in that order. We usually
 * want each term to match independently, so we emit `"code" "test"`,
 * which FTS5 treats as an implicit AND of two phrase queries.
 *
 * FTS5 boolean operator keywords (OR, AND, NOT, NEAR) are dropped as
 * standalone tokens — a bare `OR` between terms would otherwise survive
 * sanitization (letters are kept) and be quoted into a literal phrase
 * that the document must also contain, silently turning the user's
 * OR intent into a stricter AND. Stripping them yields the same
 * implicit-AND behavior as any other pair of terms.
 *
 * @param {string} query  raw user input
 * @returns {string} a MATCH expression safe to bind as a SQL parameter,
 *   or `""` if every term was stripped to nothing (caller should treat
 *   empty as "no FTS match possible")
 *
 * @example
 *   sanitizeFtsQuery("hello world")     → '"hello" "world"'
 *   sanitizeFtsQuery("code*")           → '"code"'
 *   sanitizeFtsQuery("path(test)")      → '"pathtest"'
 *   sanitizeFtsQuery("故宫博物院")       → '"故 宫 博 物 院"'
 *   sanitizeFtsQuery("a:b OR c")        → '"ab" "c"'  (operator keyword dropped)
 *   sanitizeFtsQuery("***")             → ''
 */
// FTS5 treats these as boolean operators only when they appear as bare
// uppercase tokens between operands. After sanitizeFtsTerm they survive
// verbatim (they're all letters), so we drop them before quoting.
const FTS5_OPERATOR_KEYWORDS = new Set(["OR", "AND", "NOT", "NEAR"]);

export function sanitizeFtsQuery(query) {
  if (!query || typeof query !== "string") return "";
  const terms = query.split(/\s+/).filter(Boolean);
  const quoted = [];
  for (const term of terms) {
    // Order matters: sanitize FIRST (strips operators), THEN space CJK.
    // If we spaced first and sanitized second, sanitize would strip the
    // spaces we just added, collapsing "故 宫" back to "故宫".
    const sanitized = sanitizeFtsTerm(term);
    if (!sanitized) continue;
    // Drop standalone FTS5 boolean keywords (post-sanitize, so a term
    // like "OR" — all letters — is caught here, while "ORx" stays).
    if (FTS5_OPERATOR_KEYWORDS.has(sanitized)) continue;
    const spaced = spaceCJK(sanitized);
    if (!spaced) continue;
    quoted.push('"' + spaced + '"');
  }
  return quoted.join(" ");
}

