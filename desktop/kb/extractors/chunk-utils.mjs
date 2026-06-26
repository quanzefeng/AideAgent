/**
 * Generic chunking utilities for non-Markdown extractors.
 *
 * Markdown has heading-based chunking in kb/markdown.mjs (splitIntoChunks).
 * For plain text from .docx/.pptx/.csv etc., we use paragraph-based chunking
 * with a fixed-size fallback — same CHUNK_SIZE/CHUNK_OVERLAP as the Markdown
 * path so embedding quality is comparable.
 */

const CHUNK_SIZE = 500;
const CHUNK_OVERLAP = 100;

/**
 * Split text into chunks by paragraph boundaries, with fixed-size fallback.
 *
 * Strategy:
 *   1. Split by double-newline (paragraph boundaries)
 *   2. Accumulate paragraphs until ~CHUNK_SIZE, then emit a chunk
 *   3. If a single paragraph > CHUNK_SIZE * 2, slice it with overlap
 *   4. If no paragraph boundaries found, fall through to fixed-size sliding window
 *
 * @param {string} text - Raw text (already stripped of formatting)
 * @param {string} [fallbackTitle] - Used as heading for the first chunk
 * @returns {Array<{heading:string, content:string}>}
 */
export function chunkByParagraph(text, fallbackTitle = "") {
  const body = (text || "").trim();
  if (!body) return [];

  const paragraphs = body.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);

  // No paragraph boundaries → fixed-size sliding window
  if (paragraphs.length <= 1) {
    return chunkFixedSize(body, fallbackTitle);
  }

  /** @type {Array<{heading:string, content:string}>} */
  const chunks = [];
  let current = "";
  let isFirst = true;

  for (const para of paragraphs) {
    // Single paragraph too long → slice it
    if (para.length > CHUNK_SIZE * 2) {
      if (current.trim()) {
        chunks.push({ heading: isFirst ? fallbackTitle : "", content: current.trim() });
        current = "";
        isFirst = false;
      }
      const slices = chunkFixedSize(para, "");
      for (const s of slices) {
        chunks.push({ heading: "", content: s.content });
      }
      continue;
    }

    // Would adding this paragraph exceed CHUNK_SIZE?
    if (current.length + para.length + 2 > CHUNK_SIZE && current.trim()) {
      chunks.push({ heading: isFirst ? fallbackTitle : "", content: current.trim() });
      current = "";
      isFirst = false;
    }

    current = current ? current + "\n\n" + para : para;
  }

  // Emit remaining buffer
  if (current.trim()) {
    chunks.push({ heading: isFirst ? fallbackTitle : "", content: current.trim() });
  }

  return chunks.length > 0 ? chunks : chunkFixedSize(body, fallbackTitle);
}

/**
 * Fixed-size sliding window chunking (same params as Markdown fallback).
 * @param {string} text
 * @param {string} [fallbackTitle]
 * @returns {Array<{heading:string, content:string}>}
 */
function chunkFixedSize(text, fallbackTitle = "") {
  const clean = (text || "").trim();
  if (!clean) return [];
  /** @type {Array<{heading:string, content:string}>} */
  const chunks = [];
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
  return chunks;
}
