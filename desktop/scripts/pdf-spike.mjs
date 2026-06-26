#!/usr/bin/env node
// ── PDF Spike Script ───────────────────────────────────────────
//
// Standalone diagnostic tool: run PDF text extraction against real-world
// PDF files and report quality metrics. NOT wired into the main KB
// pipeline — this is a pre-implementation validation step to decide
// whether .pdf support is worth shipping in v1.28.
//
// Usage:
//   node scripts/pdf-spike.mjs <file-or-dir> [<file-or-dir> ...]
//   node scripts/pdf-spike.mjs ./my-pdfs/
//   node scripts/pdf-spike.mjs paper1.pdf paper2.pdf contract.pdf
//
// Output (per file):
//   - chars extracted
//   - first 200 chars (visual check for CJK garbling)
//   - detected language (CJK ratio)
//   - page count
//   - avg chars/page
//   - empty-page count (scanned PDF indicator)
//   - binary/undecodable ratio
//
// Exit code 0 = all files processed; check the report for quality.
// Exit code 1 = no files found / pdf-parse not installed.

import { existsSync, statSync, readdirSync } from "node:fs";
import { join, extname, basename } from "node:path";

// ── Collect PDF file paths from args ─────────────────────────────
/** @type {string[]} */
const files = [];
for (const arg of process.argv.slice(2)) {
  if (!existsSync(arg)) {
    console.warn(`[spike] skip (not found): ${arg}`);
    continue;
  }
  const st = statSync(arg);
  if (st.isDirectory()) {
    for (const entry of readdirSync(arg)) {
      if (extname(entry).toLowerCase() === ".pdf") {
        files.push(join(arg, entry));
      }
    }
  } else if (extname(arg).toLowerCase() === ".pdf") {
    files.push(arg);
  }
}

if (files.length === 0) {
  console.error("[spike] No PDF files found. Usage: node scripts/pdf-spike.mjs <file-or-dir> [...]");
  process.exit(1);
}

// ── Load pdf-parse (devDependency) ───────────────────────────────
let pdfParse;
try {
  // Dynamic import so the main app never loads this dep.
  const mod = await import("pdf-parse");
  pdfParse = mod.default || mod;
} catch {
  console.error("[spike] pdf-parse not installed. Run: npm install --save-dev pdf-parse");
  process.exit(1);
}

// ── Helpers ──────────────────────────────────────────────────────

/**
 * CJK character ratio — if >0.3, the doc is predominantly Chinese/Japanese/Korean.
 * @param {string} text
 * @returns {number}
 */
function cjkRatio(text) {
  if (!text) return 0;
  const cjk = (text.match(/[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/g) || []).length;
  return cjk / text.length;
}

/**
 * Count "binary-looking" chars: replacement chars (U+FFFD), control chars
 * (excluding \n\r\t), and non-printable codepoints. High ratio = garbled.
 * @param {string} text
 * @returns {number}
 */
function garbleRatio(text) {
  if (!text) return 0;
  const bad = (text.match(/[\uFFFD\x00-\x08\x0b\x0c\x0e-\x1f]/g) || []).length;
  return bad / text.length;
}

// ── Run spike per file ──────────────────────────────────────────

console.log(`\n${"=".repeat(70)}`);
console.log(`PDF Spike Report — ${files.length} file(s)`);
console.log(`${"=".repeat(70)}\n`);

const results = [];

for (const filePath of files) {
  const fname = basename(filePath);
  const stat = statSync(filePath);
  const sizeMB = (stat.size / 1024 / 1024).toFixed(2);

  console.log(`📄 ${fname} (${sizeMB} MB)`);

  try {
    const data = await pdfParse(filePath);
    const text = String(data.text || "");
    const numPages = data.numpages || 0;
    const chars = text.length;
    const avgPerPage = numPages > 0 ? Math.round(chars / numPages) : 0;
    const cjk = cjkRatio(text);
    const garble = garbleRatio(text);

    // Empty-page heuristic: split by form feed (\f) which pdf-parse uses
    // as page separator, count pages with < 10 chars.
    const pages = text.split("\f");
    const emptyPages = pages.filter((p) => p.trim().length < 10).length;

    const lang = cjk > 0.3 ? "CJK-dominant" : cjk > 0.05 ? "CJK-mixed" : "Latin/other";

    console.log(`   pages: ${numPages} | chars: ${chars} | avg/page: ${avgPerPage}`);
    console.log(`   lang: ${lang} (CJK ratio: ${(cjk * 100).toFixed(1)}%)`);
    console.log(`   garble ratio: ${(garble * 100).toFixed(2)}%${garble > 0.01 ? " ⚠️ HIGH" : ""}`);
    console.log(`   empty pages: ${emptyPages}/${numPages}${emptyPages > numPages * 0.5 ? " ⚠️ LIKELY SCANNED" : ""}`);
    console.log(`   first 200 chars:`);
    console.log(`   ${text.slice(0, 200).replace(/\n/g, " ⏎ ").trim()}`);
    console.log();

    results.push({
      file: fname,
      sizeMB: parseFloat(sizeMB),
      pages: numPages,
      chars,
      avgPerPage,
      cjkRatio: cjk,
      garbleRatio: garble,
      emptyPages,
      likelyScanned: emptyPages > numPages * 0.5,
      ok: chars > 100 && garble < 0.05 && !emptyPages > numPages * 0.5,
    });
  } catch (/** @type {any} */ e) {
    console.log(`   ❌ extraction failed: ${e.message}\n`);
    results.push({ file: fname, sizeMB: parseFloat(sizeMB), error: e.message, ok: false });
  }
}

// ── Summary ─────────────────────────────────────────────────────

console.log(`${"=".repeat(70)}`);
console.log("Summary");
console.log(`${"=".repeat(70)}\n`);

const ok = results.filter((r) => r.ok);
const scanned = results.filter((r) => r.likelyScanned);
const garbled = results.filter((r) => r.garbleRatio > 0.01);
const failed = results.filter((r) => r.error);

console.log(`✅ Usable (text extracted cleanly):     ${ok.length}/${results.length}`);
console.log(`⚠️  Likely scanned (empty pages >50%): ${scanned.length}/${results.length}`);
console.log(`⚠️  Garbled (replacement chars >1%):    ${garbled.length}/${results.length}`);
console.log(`❌ Failed (extraction error):           ${failed.length}/${results.length}`);

if (ok.length > 0) {
  const avgChars = Math.round(ok.reduce((s, r) => s + r.chars, 0) / ok.length);
  const avgPages = Math.round(ok.reduce((s, r) => s + r.pages, 0) / ok.length);
  console.log(`\nAmong usable files: avg ${avgPages} pages, avg ${avgChars} chars`);
  console.log(`Embedding model context: all-MiniLM-L6-v2 = 512 tokens ≈ 800 chars`);
  console.log(`→ avg file exceeds context by ${(avgChars / 800).toFixed(1)}x (needs chunking)`);
}

console.log(`\n${"=".repeat(70)}`);
if (ok.length >= results.length * 0.7) {
  console.log("🟢 VERDICT: PDF extraction looks viable. Proceed with v1.28 implementation.");
} else if (ok.length >= results.length * 0.4) {
  console.log("🟡 VERDICT: Mixed results. Some PDFs work, some don't.");
  console.log("   Consider: ship .pdf with a warning for scanned/garbled files.");
} else {
  console.log("🔴 VERDICT: PDF extraction quality is poor for this file set.");
  console.log("   Options: 1) try a different library (pdfjs-dist), 2) add OCR, 3) skip .pdf");
}
console.log(`${"=".repeat(70)}\n`);
