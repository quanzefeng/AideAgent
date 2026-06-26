/**
 * Extractor registry and dispatch.
 *
 * Each extractor module exports:
 *   - id:             unique string identifier ("markdown", "docx", ...)
 *   - extensions:     array of lowercase extensions [".md", ".mdown", ...]
 *   - defaultEnabled: boolean
 *   - extract(filePath):  async → { title, tags, body }
 *   - chunkText(body, title): → Array<{ heading, content }>
 *
 * To add a new format:
 *   1. Create extractors/<format>.mjs with the above interface
 *   2. Import it here and add to EXTRACTORS
 *   3. Add extensions to kb/formats.mjs EXTENSION_MAP
 *   4. Add default-enabled to kb/formats.mjs DEFAULT_ENABLED
 */

import { extname } from "node:path";
import * as markdownExtractor from "./markdown.mjs";
import * as docxExtractor from "./docx.mjs";
import * as pptxExtractor from "./pptx.mjs";

// ── Extractor interface (JSDoc) ──────────────────────────────────
/**
 * @typedef {Object} Extractor
 * @property {string} id
 * @property {string[]} extensions
 * @property {boolean} defaultEnabled
 * @property {(filePath: string) => Promise<{title: string, tags: string[], body: string}>} extract
 * @property {(body: string, title: string) => Array<{heading: string, content: string}>} chunkText
 */

// ── Registry ─────────────────────────────────────────────────────
// All extractors are imported statically. For heavy deps (mammoth,
// pdf-parse), the import cost is ~150KB each — negligible compared
// to Electron's 200MB baseline. If this grows significantly, switch
// to dynamic import() with a cache.
/** @type {Record<string, Extractor>} */
const EXTRACTORS = {
  markdown: markdownExtractor,
  docx: docxExtractor,
  pptx: pptxExtractor,
  // csv, xlsx, pdf will be added in later phases.
};

/**
 * Get the extractor for a file path.
 * Returns null for unsupported extensions.
 * @param {string} filepath
 * @returns {Promise<object|null>}
 */
export async function getExtractor(filepath) {
  const ext = extname(filepath).toLowerCase();
  for (const exts of Object.values(EXTRACTORS)) {
    if (exts.extensions.includes(ext)) return exts;
  }
  return null;
}

/**
 * Get the extractor ID for a file path (sync, for quick checks).
 * @param {string} filepath
 * @returns {string|null}
 */
export function getExtractorIdSync(filepath) {
  const ext = extname(filepath).toLowerCase();
  for (const [id, mod] of Object.entries(EXTRACTORS)) {
    if (mod.extensions.includes(ext)) return id;
  }
  return null;
}

/**
 * Register a new extractor at runtime.
 * Used by later phases to add docx/pptx/csv/xlsx/pdf without
 * modifying this file's imports.
 * @param {Extractor} extractor
 */
export function registerExtractor(extractor) {
  if (!extractor.id || !extractor.extensions) {
    throw new Error("Extractor must have `id` and `extensions`");
  }
  EXTRACTORS[extractor.id] = extractor;
}
