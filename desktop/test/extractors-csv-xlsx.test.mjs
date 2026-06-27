/**
 * Unit tests for the CSV and XLSX extractors.
 *
 * CSV: uses inline text fixtures (no external files needed).
 * XLSX: generates a minimal .xlsx in-memory using SheetJS itself
 *       (writes a workbook to a Buffer, then extracts from a temp file).
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { existsSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as XLSX from "xlsx";
import { getExtractor } from "../kb/extractors/index.mjs";
import { chunkByParagraph } from "../kb/extractors/chunk-utils.mjs";

const FIXTURES_DIR = join(process.cwd(), "test", "fixtures-csv-xlsx");

// ── Fixture builders ─────────────────────────────────────────────

const CSV_PATH = join(FIXTURES_DIR, "sample.csv");
const CSV_QUOTED_PATH = join(FIXTURES_DIR, "quoted.csv");
const CSV_EMPTY_PATH = join(FIXTURES_DIR, "empty.csv");
const CSV_SINGLE_COL_PATH = join(FIXTURES_DIR, "single.csv");
const TSV_PATH = join(FIXTURES_DIR, "sample.tsv");
const XLSX_PATH = join(FIXTURES_DIR, "benchmark.xlsx");
const XLSX_EMPTY_PATH = join(FIXTURES_DIR, "empty.xlsx");

beforeAll(() => {
  mkdirSync(FIXTURES_DIR, { recursive: true });

  // Standard CSV with header
  writeFileSync(CSV_PATH, "name,score,category\nGLM-5.2,40.5,reasoning\nDeepSeek V4 Pro,37.7,reasoning\nClaude Sonnet 4,42.1,reasoning\n", "utf-8");

  // CSV with quoted fields containing commas
  writeFileSync(CSV_QUOTED_PATH, 'name,description\n"GLM-5.2, Zhipu","Top Chinese model"\n"DeepSeek, V4 Pro","Strong reasoning"\n', "utf-8");

  // Empty CSV
  writeFileSync(CSV_EMPTY_PATH, "", "utf-8");

  // Single-column CSV (no delimiter)
  writeFileSync(CSV_SINGLE_COL_PATH, "just some text\nline two\nline three\n", "utf-8");

  // TSV
  writeFileSync(TSV_PATH, "name\tscore\nGLM-5.2\t40.5\nDeepSeek V4 Pro\t37.7\n", "utf-8");

  // XLSX with 1 sheet, 3 data rows
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet([
    ["评测维度", "测试基准", "GLM-5.2", "DeepSeek V4 Pro", "胜者"],
    ["推理能力", "HLE", 40.5, 37.7, "GLM-5.2"],
    ["推理能力", "AIME 2026", 99.2, 94.6, "GLM-5.2"],
    ["编码能力", "SWE-Bench", 78.3, 75.1, "GLM-5.2"],
  ]);
  XLSX.utils.book_append_sheet(wb, ws, "核心跑分对比");
  const xlsxBuf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
  writeFileSync(XLSX_PATH, xlsxBuf);

  // Empty XLSX (1 sheet, no rows)
  const wbEmpty = XLSX.utils.book_new();
  const wsEmpty = XLSX.utils.aoa_to_sheet([[]]);
  XLSX.utils.book_append_sheet(wbEmpty, wsEmpty, "Empty");
  const xlsxEmptyBuf = XLSX.write(wbEmpty, { type: "buffer", bookType: "xlsx" });
  writeFileSync(XLSX_EMPTY_PATH, xlsxEmptyBuf);
});

afterAll(() => {
  if (existsSync(FIXTURES_DIR)) {
    rmSync(FIXTURES_DIR, { recursive: true, force: true });
  }
});

// ── CSV Tests ────────────────────────────────────────────────────

describe("CSV Extractor", () => {
  it("exports the correct interface", async () => {
    const ext = await getExtractor(CSV_PATH);
    expect(ext).not.toBeNull();
    expect(ext.id).toBe("csv");
    expect(ext.extensions).toContain(".csv");
    expect(ext.extensions).toContain(".tsv");
    expect(typeof ext.extract).toBe("function");
    expect(typeof ext.chunkText).toBe("function");
  });

  it("extracts rows as 'col: val' sentences", async () => {
    const ext = await getExtractor(CSV_PATH);
    const result = await ext.extract(CSV_PATH);
    expect(result.title).toBe("sample");
    expect(result.tags).toEqual([]);
    expect(result.body).toContain("name: GLM-5.2, score: 40.5, category: reasoning");
    expect(result.body).toContain("name: DeepSeek V4 Pro, score: 37.7, category: reasoning");
    expect(result.body).toContain("name: Claude Sonnet 4, score: 42.1, category: reasoning");
  });

  it("handles quoted fields with embedded commas", async () => {
    const ext = await getExtractor(CSV_QUOTED_PATH);
    const result = await ext.extract(CSV_QUOTED_PATH);
    // The comma inside quotes should NOT split the field
    expect(result.body).toContain("name: GLM-5.2, Zhipu");
    expect(result.body).toContain("description: Top Chinese model");
    expect(result.body).toContain("name: DeepSeek, V4 Pro");
  });

  it("handles empty CSV gracefully", async () => {
    const ext = await getExtractor(CSV_EMPTY_PATH);
    const result = await ext.extract(CSV_EMPTY_PATH);
    expect(result.title).toBe("empty");
    expect(result.body).toBe("");
  });

  it("handles single-column CSV (no delimiter) as plain text", async () => {
    const ext = await getExtractor(CSV_SINGLE_COL_PATH);
    const result = await ext.extract(CSV_SINGLE_COL_PATH);
    expect(result.body).toContain("just some text");
    expect(result.body).toContain("line two");
  });

  it("handles TSV files with tab delimiter", async () => {
    const ext = await getExtractor(TSV_PATH);
    const result = await ext.extract(TSV_PATH);
    expect(result.body).toContain("name: GLM-5.2, score: 40.5");
    expect(result.body).toContain("name: DeepSeek V4 Pro, score: 37.7");
  });

  it("chunks body by paragraph", async () => {
    const ext = await getExtractor(CSV_PATH);
    const { body, title } = await ext.extract(CSV_PATH);
    const chunks = ext.chunkText(body, title);
    expect(chunks.length).toBeGreaterThan(0);
    for (const chunk of chunks) {
      expect(typeof chunk.content).toBe("string");
      expect(chunk.content.length).toBeGreaterThan(0);
    }
  });
});

// ── XLSX Tests ───────────────────────────────────────────────────

describe("XLSX Extractor", () => {
  it("exports the correct interface", async () => {
    const ext = await getExtractor(XLSX_PATH);
    expect(ext).not.toBeNull();
    expect(ext.id).toBe("xlsx");
    expect(ext.extensions).toContain(".xlsx");
    expect(typeof ext.extract).toBe("function");
    expect(typeof ext.chunkText).toBe("function");
  });

  it("extracts rows as 'col: val' sentences with sheet name prefix", async () => {
    const ext = await getExtractor(XLSX_PATH);
    const result = await ext.extract(XLSX_PATH);
    expect(result.title).toBe("benchmark");
    expect(result.tags).toEqual([]);
    // Sheet name should appear as a prefix
    expect(result.body).toContain("[核心跑分对比]");
    // Row data should be in "col: val" format
    expect(result.body).toContain("评测维度: 推理能力");
    expect(result.body).toContain("测试基准: HLE");
    expect(result.body).toContain("GLM-5.2: 40.5");
    expect(result.body).toContain("DeepSeek V4 Pro: 37.7");
    expect(result.body).toContain("胜者: GLM-5.2");
  });

  it("extracts all data rows", async () => {
    const ext = await getExtractor(XLSX_PATH);
    const result = await ext.extract(XLSX_PATH);
    // 3 data rows → 3 "col: val" sentences. The body starts with a
    // [sheetName] prefix line, then rows separated by \n\n. The first
    // paragraph includes the sheet prefix + first data row.
    const sentences = result.body.split("\n\n").filter((s) => s.trim());
    // [sheetName]\nrow1 | row2 | row3 = 3 paragraphs (first includes prefix)
    expect(sentences.length).toBe(3);
    // Verify all 3 benchmark names appear
    expect(result.body).toContain("HLE");
    expect(result.body).toContain("AIME 2026");
    expect(result.body).toContain("SWE-Bench");
  });

  it("handles empty XLSX gracefully", async () => {
    const ext = await getExtractor(XLSX_EMPTY_PATH);
    const result = await ext.extract(XLSX_EMPTY_PATH);
    expect(result.title).toBe("empty");
    expect(result.body).toBe("");
  });

  it("chunks body by paragraph", async () => {
    const ext = await getExtractor(XLSX_PATH);
    const { body, title } = await ext.extract(XLSX_PATH);
    const chunks = ext.chunkText(body, title);
    expect(chunks.length).toBeGreaterThan(0);
    // First chunk should have the title as heading
    expect(chunks[0].heading).toBe("benchmark");
    for (const chunk of chunks) {
      expect(typeof chunk.content).toBe("string");
      expect(chunk.content.length).toBeGreaterThan(0);
    }
  });
});
