/**
 * DOCX extractor — uses mammoth to extract raw text from Word documents.
 *
 * mammoth converts .docx (OOXML) to plain text, stripping all formatting.
 * Tables and images are dropped (mammoth only handles text). This is the
 * right tradeoff for RAG — we want embeddable text, not layout.
 *
 * .doc (legacy Word binary) is NOT supported — mammoth doesn't handle it.
 * Users should "Save As .docx" in that case.
 */

import { basename } from "node:path";
import mammoth from "mammoth";
import { chunkByParagraph } from "./chunk-utils.ts";

export const id = "docx";
export const extensions = [".docx"];
export const defaultEnabled = true;

/**
 * Extract title, tags, and body from a .docx file.
 *
 * DOCX has no frontmatter concept, so:
 *   - title = filename without extension
 *   - tags = [] (no tag extraction from DOCX)
 *   - body = mammoth's raw text output
 *
 * @param {string} filePath - Absolute path to the .docx file
 * @returns {Promise<{ title: string, tags: string[], body: string }>}
 */
export async function extract(filePath: string): Promise<{ title: string, tags: string[], body: string }> {
  const result = await mammoth.extractRawText({ path: filePath });
  const text = (result.value || "").trim();
  const filename = basename(filePath, ".docx");
  return {
    title: filename,
    tags: [],
    body: text,
  };
}

export function chunkText(body: string, title: string): Array<{heading: string, content: string}> {
  return chunkByParagraph(body, title);
}
