/**
 * Markdown extractor — wraps the existing kb/markdown.mjs functions
 * into the standard extractor interface.
 *
 * This is a thin adapter: all the real logic (frontmatter parsing,
 * heading-based chunking, tag extraction) lives in kb/markdown.mjs.
 * Keeping it as a separate file means the extractor interface is
 * uniform across all formats.
 */

import { readFileSync } from "node:fs";
import { basename } from "node:path";
import {
  extractTitle,
  extractTags,
  stripNoteBody,
  splitIntoChunks,
} from "../markdown.mjs";

export const id = "markdown";
export const extensions = [".md", ".mdown", ".mkd", ".mkdn", ".markdown"];
export const defaultEnabled = true;

/**
 * Extract title, tags, and body from a Markdown file.
 * @param {string} filePath - Absolute path to the .md file
 * @returns {Promise<{ title: string, tags: string[], body: string }>}
 */
export async function extract(filePath) {
  const content = readFileSync(filePath, "utf-8");
  const filename = basename(filePath);
  const title = extractTitle(content, filename);
  const tags = extractTags(content);
  const body = stripNoteBody(content);
  return { title, tags, body };
}

/**
 * Chunk a Markdown body into semantic chunks (heading-based).
 * Delegates to splitIntoChunks in kb/markdown.mjs.
 * @param {string} body
 * @param {string} title
 * @returns {Array<{heading:string, content:string}>}
 */
export function chunkText(body, title) {
  return splitIntoChunks(body, title);
}
