/**
 * Format registry: maps file extensions to extractor IDs.
 *
 * Single source of truth for "which file types can be indexed" — replaces
 * the 3 hardcoded `.md` checks that were scattered across vault-scanner.mjs
 * and indexer.mjs.
 *
 * To add a new format:
 *   1. Create kb/extractors/<format>.mjs with the standard interface
 *   2. Register it in kb/extractors/index.mjs
 *   3. Add its extensions here in EXTENSION_MAP
 *   4. Add a default-enabled flag in DEFAULT_ENABLED below
 */

import { extname } from "node:path";
import { getConfig } from "./config.mjs";

/**
 * Extension → extractor ID mapping.
 * Lowercase extensions with leading dot.
 * @type {Record<string, string>}
 */
const EXTENSION_MAP = {
  ".md":        "markdown",
  ".mdown":     "markdown",
  ".mkd":       "markdown",
  ".mkdn":      "markdown",
  ".markdown":  "markdown",
  ".docx":      "docx",
  ".pptx":      "pptx",
  ".csv":       "csv",
  ".xlsx":      "xlsx",
  ".pdf":       "pdf",
};

/**
 * Default enabled state per extractor ID.
 * Markdown is always enabled.
 * Office formats (docx, pptx) default ON per v1.27 design decision.
 * Data formats (csv, xlsx) and PDF default OFF until validated.
 * @type {Record<string, boolean>}
 */
export const DEFAULT_ENABLED = {
  markdown: true,
  docx: true,
  pptx: true,
  csv: false,
  xlsx: false,
  pdf: false,
};

/**
 * Get the extractor ID for a file path (based on extension).
 * Returns null for unsupported extensions.
 * @param {string} filepath
 * @returns {string|null}
 */
export function getExtractorId(filepath) {
  const ext = extname(filepath).toLowerCase();
  return EXTENSION_MAP[ext] || null;
}

/**
 * Check if a file's extension is supported (known in the registry).
 * Does NOT check if the format is enabled — use isEnabledExt for that.
 * @param {string} filepath
 * @returns {boolean}
 */
export function isSupportedExt(filepath) {
  return getExtractorId(filepath) !== null;
}

/**
 * Check if a file's extension is both supported AND enabled in the user's config.
 * Markdown is always enabled regardless of config.
 * @param {string} filepath
 * @returns {boolean}
 */
export function isEnabledExt(filepath) {
  const id = getExtractorId(filepath);
  if (!id) return false;
  if (id === "markdown") return true;
  const cfg = getConfig();
  /** @type {Record<string, boolean>} */
  const enabledFormats = cfg.enabledFormats || DEFAULT_ENABLED;
  return enabledFormats[id] ?? DEFAULT_ENABLED[id] ?? false;
}

/**
 * Get the list of currently-enabled extensions (for scanner filtering).
 * @returns {string[]} Array of lowercase extensions like [".md", ".docx", ...]
 */
export function getEnabledExtensions() {
  const cfg = getConfig();
  /** @type {Record<string, boolean>} */
  const enabledFormats = cfg.enabledFormats || DEFAULT_ENABLED;
  return Object.entries(EXTENSION_MAP)
    .filter(([_, id]) => {
      if (id === "markdown") return true;
      return enabledFormats[id] ?? DEFAULT_ENABLED[id] ?? false;
    })
    .map(([ext]) => ext);
}
