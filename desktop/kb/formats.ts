/**
 * Format registry: maps file extensions to extractor IDs.
 *
 * Single source of truth for "which file types can be indexed" — replaces
 * the 3 hardcoded `.md` checks that were scattered across vault-scanner.mjs
 * and indexer.mjs.
 *
 * To add a new format:
 *   1. Create kb/extractors/<format>.mjs with the standard interface
 *   2. Register it in kb/extractors/index.ts
 *   3. Add its extensions here in EXTENSION_MAP
 *   4. Add a default-enabled flag in DEFAULT_ENABLED below
 */

import { extname } from "node:path";
import { getConfig } from "./config.ts";

const EXTENSION_MAP: Record<string, string> = {
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

export const DEFAULT_ENABLED: Record<string, boolean> = {
  markdown: true,
  docx: true,
  pptx: true,
  csv: false,
  xlsx: false,
  pdf: false,
};

export function getExtractorId(filepath: string): string | null {
  const ext = extname(filepath).toLowerCase();
  return EXTENSION_MAP[ext] || null;
}

export function isSupportedExt(filepath: string): boolean {
  return getExtractorId(filepath) !== null;
}

export function isEnabledExt(filepath: string): boolean {
  const id = getExtractorId(filepath);
  if (!id) return false;
  if (id === "markdown") return true;
  const cfg = getConfig();
  const enabledFormats = cfg.enabledFormats || DEFAULT_ENABLED;
  return enabledFormats[id] ?? DEFAULT_ENABLED[id] ?? false;
}

export function getEnabledExtensions(): string[] {
  const cfg = getConfig();
  const enabledFormats = cfg.enabledFormats || DEFAULT_ENABLED;
  return Object.entries(EXTENSION_MAP)
    .filter(([_, id]) => {
      if (id === "markdown") return true;
      return enabledFormats[id] ?? DEFAULT_ENABLED[id] ?? false;
    })
    .map(([ext]) => ext);
}
