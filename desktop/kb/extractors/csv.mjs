/**
 * CSV extractor — reads CSV files as plain text, converts each row into
 * a "key: value" sentence representation for better RAG recall.
 *
 * CSV is structured data, not prose — raw "1,2,3,4" rows have zero
 * semantic signal for embeddings. Converting to "Column1: 1, Column2: 2"
 * gives the embedding model actual words to latch onto.
 *
 * Strategy:
 *   - Parse with a simple CSV splitter (handles quoted fields, commas
 *     inside quotes, and \r\n line endings)
 *   - First row = header (column names)
 *   - Each subsequent row → "col1: val1, col2: val2, ..." sentence
 *   - Chunk by paragraph (each row is a "paragraph")
 */

import { basename } from "node:path";
import { readFileSync } from "node:fs";
import { chunkByParagraph } from "./chunk-utils.mjs";

export const id = "csv";
export const extensions = [".csv", ".tsv"];
export const defaultEnabled = false;

/**
 * Parse a single CSV line, handling quoted fields with embedded commas
 * and escaped quotes (""). Returns array of field values.
 * @param {string} line
 * @returns {string[]}
 */
function parseCsvLine(line) {
  const fields = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        current += ch;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
      } else if (ch === ",") {
        fields.push(current.trim());
        current = "";
      } else {
        current += ch;
      }
    }
  }
  fields.push(current.trim());
  return fields;
}

/**
 * Extract title, tags, and body from a CSV file.
 *
 * CSV has no frontmatter, so:
 *   - title = filename without extension
 *   - tags = []
 *   - body = each data row as "col: val, col: val" sentence, \n\n between rows
 *
 * @param {string} filePath - Absolute path to the .csv file
 * @returns {Promise<{ title: string, tags: string[], body: string }>}
 */
export async function extract(filePath) {
  const content = readFileSync(filePath, "utf-8");
  const filename = basename(filePath);
  const ext = filename.lastIndexOf(".") >= 0 ? filename.slice(filename.lastIndexOf(".")) : "";
  const title = ext ? basename(filePath, ext) : filename;

  const lines = content.split(/\r?\n/).filter((l) => l.trim());
  if (lines.length === 0) {
    return { title, tags: [], body: "" };
  }

  // Detect delimiter: TSV uses tabs, CSV uses commas
  const delimiter = ext === ".tsv" ? "\t" : ",";
  const header = lines[0].includes(delimiter)
    ? (delimiter === "\t" ? lines[0].split("\t") : parseCsvLine(lines[0]))
    : [];

  // If no header (single-column or empty), just join all lines as text
  if (header.length === 0) {
    return { title, tags: [], body: lines.join("\n") };
  }

  // Convert each data row to "col1: val1, col2: val2, ..." sentence
  const sentences = [];
  for (let i = 1; i < lines.length; i++) {
    const values = delimiter === "\t" ? lines[i].split("\t") : parseCsvLine(lines[i]);
    const pairs = [];
    for (let j = 0; j < header.length && j < values.length; j++) {
      const col = header[j] || `col${j + 1}`;
      const val = values[j] || "";
      if (val) pairs.push(`${col}: ${val}`);
    }
    if (pairs.length > 0) {
      sentences.push(pairs.join(", "));
    }
  }

  return {
    title,
    tags: [],
    body: sentences.join("\n\n"),
  };
}

/**
 * Chunk CSV body by paragraph (each row is a paragraph).
 * @param {string} body
 * @param {string} title
 * @returns {Array<{heading:string, content:string}>}
 */
export function chunkText(body, title) {
  return chunkByParagraph(body, title);
}
