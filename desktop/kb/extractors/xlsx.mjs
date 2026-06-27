/**
 * XLSX extractor — uses SheetJS (xlsx) to parse Excel spreadsheets,
 * converts each row into a "key: value" sentence for RAG recall.
 *
 * XLSX is a ZIP of XML files (one per sheet). SheetJS handles the
 * unzipping + XML parsing + cell type conversion (numbers, dates,
 * formulas → text).
 *
 * Strategy:
 *   - Read all sheets with `sheet_to_json({ header: 1 })` (array-of-arrays)
 *   - First row of each sheet = header (column names)
 *   - Each subsequent row → "col1: val1, col2: val2, ..." sentence
 *   - Sheets separated by "\n\n" (natural chunk boundary)
 *   - Sheet name included as a heading prefix for context
 *
 * Merged cells: SheetJS returns null for the "continuation" cells of a
 * merge. We skip null values rather than trying to forward-fill, which
 * would be complex and error-prone for RAG purposes.
 */

import { basename } from "node:path";
import { readFileSync } from "node:fs";
// @ts-ignore — xlsx (SheetJS) has no bundled TypeScript declarations
import * as XLSX from "xlsx";
import { chunkByParagraph } from "./chunk-utils.mjs";

export const id = "xlsx";
export const extensions = [".xlsx"];
export const defaultEnabled = false;

/**
 * Convert a single sheet's array-of-arrays into "col: val" sentences.
 * @param {string} sheetName
 * @param {any[][]} rows - array-of-arrays from sheet_to_json({ header: 1 })
 * @returns {string}
 */
function sheetToSentences(sheetName, rows) {
  if (!rows || rows.length === 0) return "";

  // First non-empty row = header
  let headerIdx = 0;
  while (headerIdx < rows.length && (!rows[headerIdx] || rows[headerIdx].every((c) => c === null || c === undefined || String(c).trim() === ""))) {
    headerIdx++;
  }
  if (headerIdx >= rows.length) return "";

  const header = (rows[headerIdx] || []).map((c) => (c === null || c === undefined ? "" : String(c).trim()));
  const sentences = [];

  for (let i = headerIdx + 1; i < rows.length; i++) {
    const values = rows[i] || [];
    // Skip completely empty rows
    if (values.every((c) => c === null || c === undefined || String(c).trim() === "")) continue;

    const pairs = [];
    for (let j = 0; j < header.length && j < values.length; j++) {
      const col = header[j] || `col${j + 1}`;
      const val = values[j];
      if (val !== null && val !== undefined && String(val).trim() !== "") {
        pairs.push(`${col}: ${val}`);
      }
    }
    if (pairs.length > 0) {
      sentences.push(pairs.join(", "));
    }
  }

  if (sentences.length === 0) return "";
  // Prefix with sheet name for context
  return `[${sheetName}]\n${sentences.join("\n\n")}`;
}

/**
 * Extract title, tags, and body from a .xlsx file.
 *
 * XLSX has no frontmatter, so:
 *   - title = filename without extension
 *   - tags = []
 *   - body = all sheets concatenated, each as "col: val" sentences
 *
 * @param {string} filePath - Absolute path to the .xlsx file
 * @returns {Promise<{ title: string, tags: string[], body: string }>}
 */
export async function extract(filePath) {
  const filename = basename(filePath, ".xlsx");
  // SheetJS v3+ removed readFile; use read() with a Buffer instead.
  const buf = readFileSync(filePath);
  const workbook = XLSX.read(buf, { type: "buffer" });

  if (!workbook.SheetNames || workbook.SheetNames.length === 0) {
    return { title: filename, tags: [], body: "" };
  }

  const sheetTexts = [];
  for (const sheetName of workbook.SheetNames) {
    const sheet = workbook.Sheets[sheetName];
    if (!sheet) continue;
    // array-of-arrays mode: each row is an array of cell values
    const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: false, defval: null });
    const text = sheetToSentences(sheetName, rows);
    if (text) sheetTexts.push(text);
  }

  return {
    title: filename,
    tags: [],
    body: sheetTexts.join("\n\n"),
  };
}

/**
 * Chunk XLSX body by paragraph (each row is a paragraph).
 * @param {string} body
 * @param {string} title
 * @returns {Array<{heading:string, content:string}>}
 */
export function chunkText(body, title) {
  return chunkByParagraph(body, title);
}
