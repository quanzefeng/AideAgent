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
 *   3. Add extensions to kb/formats.ts EXTENSION_MAP
 *   4. Add default-enabled to kb/formats.ts DEFAULT_ENABLED
 */

import { extname } from "node:path";
import * as markdownExtractor from "./markdown.ts";
import * as docxExtractor from "./docx.ts";
import * as pptxExtractor from "./pptx.ts";
import * as csvExtractor from "./csv.ts";
import * as xlsxExtractor from "./xlsx.ts";
import * as pdfExtractor from "./pdf.ts";

// ── Extractor interface ──────────────────────────────────────
interface Extractor {
  id: string;
  extensions: string[];
  defaultEnabled: boolean;
  extract: (filePath: string) => Promise<{ title: string, tags: string[], body: string }>;
  chunkText: (body: string, title: string) => Array<{ heading: string, content: string }>;
}

// ── Registry ─────────────────────────────────────────────────────
// All extractors are imported statically. For heavy deps (mammoth,
// pdf-parse), the import cost is ~150KB each — negligible compared
// to Electron's 200MB baseline. If this grows significantly, switch
// to dynamic import() with a cache.
// NOTE: pdf-parse is lazy-loaded inside pdf.mjs due to a known CJS
// import quirk (reads a test file on load). Keep the static import
// above for the registry, but pdf.mjs handles the heavy part lazily.
const EXTRACTORS: Record<string, Extractor> = {
  markdown: markdownExtractor,
  docx: docxExtractor,
  pptx: pptxExtractor,
  csv: csvExtractor,
  xlsx: xlsxExtractor,
  pdf: pdfExtractor,
};

export async function getExtractor(filepath: string): Promise<Extractor | null> {
  const ext = extname(filepath).toLowerCase();
  for (const exts of Object.values(EXTRACTORS)) {
    if (exts.extensions.includes(ext)) return exts;
  }
  return null;
}

export function getExtractorIdSync(filepath: string): string | null {
  const ext = extname(filepath).toLowerCase();
  for (const [id, mod] of Object.entries(EXTRACTORS)) {
    if (mod.extensions.includes(ext)) return id;
  }
  return null;
}

export function registerExtractor(extractor: Extractor) {
  if (!extractor.id || !extractor.extensions) {
    throw new Error("Extractor must have `id` and `extensions`");
  }
  EXTRACTORS[extractor.id] = extractor;
}
