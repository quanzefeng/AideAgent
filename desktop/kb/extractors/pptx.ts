/**
 * PPTX extractor — parses PowerPoint OOXML to extract text from slides.
 *
 * PPTX is a ZIP containing ppt/slides/slideN.xml files. Each slide XML
 * has text in <a:t> elements (text runs) within <a:p> elements (paragraphs).
 *
 * Strategy:
 *   - Open ZIP with adm-zip
 *   - Find all slide entries (ppt/slides/slide1.xml, slide2.xml, ...)
 *   - For each slide, extract all <a:t> text, join into paragraphs
 *   - Body = all slides concatenated with \n\n (natural chunk boundary)
 *   - chunkByParagraph then splits at slide boundaries automatically
 *
 * .ppt (legacy PowerPoint binary) is NOT supported.
 */

import { basename } from "node:path";
// @ts-ignore — adm-zip has no TypeScript declarations
import AdmZip from "adm-zip";
import { chunkByParagraph } from "./chunk-utils.ts";

export const id = "pptx";
export const extensions = [".pptx"];
export const defaultEnabled = true;

/**
 * Decode the 5 standard XML entities. PPTX text runs may contain any of these.
 * @param {string} s
 * @returns {string}
 */
function decodeXmlEntities(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function extractSlideText(xml: string): string {
  const paragraphs: string[] = [];
  // Match <a:p>...</a:p> blocks (non-greedy, handles attributes on <a:p>)
  const pMatches = xml.match(/<a:p\b[^>]*>[\s\S]*?<\/a:p>/g) || [];
  for (const pXml of pMatches) {
    // Extract text from all <a:t> elements within this paragraph
    const tMatches = pXml.match(/<a:t\b[^>]*>([\s\S]*?)<\/a:t>/g) || [];
    const text = tMatches
      .map((t: string) => {
        // Strip the opening tag and closing tag, decode entities
        const inner = t.replace(/<a:t\b[^>]*>/, "").replace(/<\/a:t>/, "");
        return decodeXmlEntities(inner);
      })
      .join("")
      .trim();
    if (text) paragraphs.push(text);
  }
  return paragraphs.join("\n").trim();
}

/**
 * Extract title, tags, and body from a .pptx file.
 *
 * PPTX has no frontmatter concept, so:
 *   - title = filename without extension
 *   - tags = []
 *   - body = all slide text concatenated with \n\n between slides
 *
 * @param {string} filePath - Absolute path to the .pptx file
 * @returns {Promise<{ title: string, tags: string[], body: string }>}
 */
export async function extract(filePath: string): Promise<{ title: string, tags: string[], body: string }> {
  const zip = new AdmZip(filePath);
  const filename = basename(filePath, ".pptx");

  // Find all slide entries: ppt/slides/slide1.xml, slide2.xml, ...
  const slideEntries = zip.getEntries()
    .filter((e: any) => /^ppt\/slides\/slide\d+\.xml$/i.test(e.entryName))
    .sort((a: any, b: any) => {
      const na = parseInt(a.entryName.match(/slide(\d+)/)?.[1] || "0", 10);
      const nb = parseInt(b.entryName.match(/slide(\d+)/)?.[1] || "0", 10);
      return na - nb;
    });

  if (slideEntries.length === 0) {
    return { title: filename, tags: [], body: "" };
  }

  // Extract text from each slide, join with \n\n (natural paragraph boundary)
  const slideTexts: string[] = [];
  for (const entry of slideEntries) {
    const xml = entry.getData().toString("utf-8");
    const text = extractSlideText(xml);
    if (text) slideTexts.push(text);
  }

  return {
    title: filename,
    tags: [],
    body: slideTexts.join("\n\n"),
  };
}

export function chunkText(body: string, title: string): Array<{heading: string, content: string}> {
  return chunkByParagraph(body, title);
}
