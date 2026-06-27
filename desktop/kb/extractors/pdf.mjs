/**
 * PDF extractor — uses pdf-parse v1 to extract text from PDF files.
 *
 * pdf-parse v1 is CJS and has a known quirk: its index.js reads a test
 * file on import. We work around this by ensuring the test data dir exists
 * before the first dynamic import.
 *
 * Limitations:
 *   - Scanned PDFs (image-only) return empty or near-empty text.
 *     Future: add OCR fallback via tesseract.js.
 *   - Complex table layouts may lose column alignment.
 *     Acceptable for RAG — we want embeddable text, not pixel-perfect layout.
 */

import { basename } from "node:path";
import { existsSync, mkdirSync } from "node:fs";
import { chunkByParagraph } from "./chunk-utils.mjs";

export const id = "pdf";
export const extensions = [".pdf"];
export const defaultEnabled = false;

// ── Lazy-load pdf-parse (CJS via ESM dynamic import) ──────────────
/** @type {((buffer: Buffer) => Promise<{text: string, numpages: number}>) | null} */
let _pdfParse = null;

async function getPdfParse() {
  if (_pdfParse) return _pdfParse;

  // pdf-parse v1 reads test/data/05-versions-space.pdf on import.
  // Ensure it exists to prevent ENOENT. The file content doesn't matter.
  const testDataDir = new URL("../../test/data/", import.meta.url).pathname
    .replace(/^\/([A-Z]:)/, "$1"); // fix /C:/... on Windows
  if (!existsSync(testDataDir)) {
    mkdirSync(testDataDir, { recursive: true });
  }
  const testFile = testDataDir + "05-versions-space.pdf";
  if (!existsSync(testFile)) {
    // Write a minimal valid PDF (1 page, empty) so pdf-parse doesn't crash.
    // This is a known pdf-parse v1 requirement — not our test data.
    const { writeFileSync } = await import("node:fs");
    writeFileSync(testFile, Buffer.from(
      "%PDF-1.0\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n" +
      "2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n" +
      "3 0 obj<</Type/Page/MediaBox[0 0 3 3]/Parent 2 0 R>>endobj\n" +
      "xref\n0 4\n0000000000 65535 f \n0000000009 00000 n \n0000000058 00000 n \n0000000115 00000 n \n" +
      "trailer<</Size 4/Root 1 0 R>>\nstartxref\n190\n%%EOF"
    ));
  }

  const mod = await import("pdf-parse");
  _pdfParse = mod.default || mod;
  return _pdfParse;
}

/**
 * Extract title, tags, and body from a .pdf file.
 *
 * PDF has no frontmatter concept, so:
 *   - title = filename without extension
 *   - tags = [] (no tag extraction from PDF)
 *   - body = pdf-parse text output (all pages joined)
 *
 * @param {string} filePath - Absolute path to the .pdf file
 * @returns {Promise<{ title: string, tags: string[], body: string }>}
 */
export async function extract(filePath) {
  const pdfParse = await getPdfParse();
  if (!pdfParse) throw new Error("pdf-parse failed to load");
  const { readFileSync } = await import("node:fs");
  const buffer = readFileSync(filePath);
  const data = await pdfParse(buffer);
  const text = (data.text || "").trim();
  const filename = basename(filePath, ".pdf");
  return {
    title: filename,
    tags: [],
    body: text,
  };
}

/**
 * Chunk PDF body by paragraph boundaries.
 * pdf-parse outputs text with \f (form-feed) as page separator and
 * \n\n between paragraphs — both align with chunkByParagraph's strategy.
 * @param {string} body
 * @param {string} title
 * @returns {Array<{heading:string, content:string}>}
 */
export function chunkText(body, title) {
  return chunkByParagraph(body, title);
}
