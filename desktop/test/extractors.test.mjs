/**
 * Unit tests for the DOCX and PPTX extractors.
 *
 * Sample .docx and .pptx files are generated programmatically using adm-zip
 * in beforeAll — no binary fixtures needed. Each sample is a minimal but
 * valid OOXML ZIP that mammoth / adm-zip can parse.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { existsSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import AdmZip from "adm-zip";
import { getExtractor } from "../kb/extractors/index.mjs";
import { chunkByParagraph } from "../kb/extractors/chunk-utils.mjs";

const FIXTURES_DIR = join(process.cwd(), "test", "fixtures-extractors");

// ── Minimal OOXML templates ──────────────────────────────────────

const CONTENT_TYPES_DOCX = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`;

const CONTENT_TYPES_PPTX = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>
  <Override PartName="/ppt/slides/slide1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>
  <Override PartName="/ppt/slides/slide2.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>
</Types>`;

const RELS_DOCX = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`;

const RELS_PPTX = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/>
</Relationships>`;

/**
 * Build a minimal .docx with N paragraphs of text.
 * @param {string[]} paragraphs
 * @returns {Buffer}
 */
function buildDocx(paragraphs) {
  const zip = new AdmZip();
  zip.addFile("[Content_Types].xml", Buffer.from(CONTENT_TYPES_DOCX, "utf-8"));
  zip.addFile("_rels/.rels", Buffer.from(RELS_DOCX, "utf-8"));
  const body = paragraphs
    .map(
      (p) =>
        `<w:p><w:r><w:t xml:space="preserve">${p}</w:t></w:r></w:p>`
    )
    .join("");
  const docXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>${body}</w:body>
</w:document>`;
  zip.addFile("word/document.xml", Buffer.from(docXml, "utf-8"));
  return zip.toBuffer();
}

/**
 * Build a minimal .pptx with N slides, each containing the given text lines.
 * @param {Array<{ title: string, lines: string[] }>} slides
 * @returns {Buffer}
 */
function buildPptx(slides) {
  const zip = new AdmZip();
  zip.addFile("[Content_Types].xml", Buffer.from(CONTENT_TYPES_PPTX, "utf-8"));
  zip.addFile("_rels/.rels", Buffer.from(RELS_PPTX, "utf-8"));

  const presentationXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
  <p:sldIdLst>
    <p:sldId id="1" r:id="rId1"/>
    <p:sldId id="2" r:id="rId2"/>
  </p:sldIdLst>
</p:presentation>`;
  zip.addFile("ppt/presentation.xml", Buffer.from(presentationXml, "utf-8"));

  for (let i = 0; i < slides.length; i++) {
    const slide = slides[i];
    const paragraphs = [
      `<a:p><a:r><a:t>${slide.title}</a:t></a:r></a:p>`,
      ...slide.lines.map(
        (line) => `<a:p><a:r><a:t>${line}</a:t></a:r></a:p>`
      ),
    ].join("");
    const slideXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
  <p:cSld><p:spTree><p:sp><p:txBody>${paragraphs}</p:txBody></p:sp></p:spTree></p:cSld>
</p:sld>`;
    zip.addFile(`ppt/slides/slide${i + 1}.xml`, Buffer.from(slideXml, "utf-8"));
  }
  return zip.toBuffer();
}

// ── Test setup ──────────────────────────────────────────────────

const DOCX_PATH = join(FIXTURES_DIR, "sample.docx");
const PPTX_PATH = join(FIXTURES_DIR, "sample.pptx");
const EMPTY_DOCX_PATH = join(FIXTURES_DIR, "empty.docx");
const XML_ENTITIES_PPTX_PATH = join(FIXTURES_DIR, "entities.pptx");

beforeAll(() => {
  mkdirSync(FIXTURES_DIR, { recursive: true });

  // Sample DOCX with 3 paragraphs
  const docxBuf = buildDocx([
    "This is the first paragraph of the test document. It contains enough text to be meaningful for extraction testing.",
    "This is the second paragraph. It has different content about machine learning and neural networks.",
    "The third paragraph discusses natural language processing and embeddings for search applications.",
  ]);
  require("fs").writeFileSync(DOCX_PATH, docxBuf);

  // Sample PPTX with 2 slides
  const pptxBuf = buildPptx([
    {
      title: "Introduction to RAG",
      lines: ["Retrieval Augmented Generation", "Combines search with LLM generation", "Reduces hallucinations"],
    },
    {
      title: "Embedding Models",
      lines: ["all-MiniLM-L6-v2 produces 384-dim vectors", "Cosine similarity for semantic matching", "FTS5 for keyword matching"],
    },
  ]);
  require("fs").writeFileSync(PPTX_PATH, pptxBuf);

  // Empty DOCX (no paragraphs)
  const emptyBuf = buildDocx([]);
  require("fs").writeFileSync(EMPTY_DOCX_PATH, emptyBuf);

  // PPTX with XML entities in text
  const entitiesBuf = buildPptx([
    {
      title: "XML Entities Test",
      lines: ["Less than: &lt;tag&gt;", "Ampersand: Tom &amp; Jerry", "Quotes: &quot;hello&quot; &apos;world&apos;"],
    },
  ]);
  require("fs").writeFileSync(XML_ENTITIES_PPTX_PATH, entitiesBuf);
});

afterAll(() => {
  if (existsSync(FIXTURES_DIR)) {
    rmSync(FIXTURES_DIR, { recursive: true, force: true });
  }
});

// ── Tests ────────────────────────────────────────────────────────

describe("DOCX Extractor", () => {
  it("exports the correct interface", async () => {
    const ext = await getExtractor(DOCX_PATH);
    expect(ext).not.toBeNull();
    expect(ext.id).toBe("docx");
    expect(ext.extensions).toContain(".docx");
    expect(ext.defaultEnabled).toBe(true);
    expect(typeof ext.extract).toBe("function");
    expect(typeof ext.chunkText).toBe("function");
  });

  it("extracts text from a .docx file", async () => {
    const ext = await getExtractor(DOCX_PATH);
    const result = await ext.extract(DOCX_PATH);
    expect(result.title).toBe("sample");
    expect(result.tags).toEqual([]);
    expect(result.body).toContain("first paragraph");
    expect(result.body).toContain("machine learning");
    expect(result.body).toContain("natural language processing");
  });

  it("handles empty .docx files gracefully", async () => {
    const ext = await getExtractor(EMPTY_DOCX_PATH);
    const result = await ext.extract(EMPTY_DOCX_PATH);
    expect(result.title).toBe("empty");
    expect(result.body).toBe("");
  });

  it("chunks body by paragraph boundaries", async () => {
    const ext = await getExtractor(DOCX_PATH);
    const { body, title } = await ext.extract(DOCX_PATH);
    const chunks = ext.chunkText(body, title);
    expect(chunks.length).toBeGreaterThan(0);
    // Each chunk should have heading and content
    for (const chunk of chunks) {
      expect(typeof chunk.heading).toBe("string");
      expect(typeof chunk.content).toBe("string");
      expect(chunk.content.length).toBeGreaterThan(0);
    }
  });
});

describe("PPTX Extractor", () => {
  it("exports the correct interface", async () => {
    const ext = await getExtractor(PPTX_PATH);
    expect(ext).not.toBeNull();
    expect(ext.id).toBe("pptx");
    expect(ext.extensions).toContain(".pptx");
    expect(ext.defaultEnabled).toBe(true);
    expect(typeof ext.extract).toBe("function");
    expect(typeof ext.chunkText).toBe("function");
  });

  it("extracts text from all slides", async () => {
    const ext = await getExtractor(PPTX_PATH);
    const result = await ext.extract(PPTX_PATH);
    expect(result.title).toBe("sample");
    expect(result.tags).toEqual([]);
    // Slide 1 content
    expect(result.body).toContain("Retrieval Augmented Generation");
    expect(result.body).toContain("Reduces hallucinations");
    // Slide 2 content
    expect(result.body).toContain("all-MiniLM-L6-v2 produces 384-dim vectors");
    expect(result.body).toContain("FTS5 for keyword matching");
  });

  it("decodes XML entities in slide text", async () => {
    const ext = await getExtractor(XML_ENTITIES_PPTX_PATH);
    const result = await ext.extract(XML_ENTITIES_PPTX_PATH);
    expect(result.body).toContain("<tag>");
    expect(result.body).toContain("Tom & Jerry");
    expect(result.body).toContain('"hello" \'world\'');
    // Should NOT contain raw entity strings
    expect(result.body).not.toContain("&lt;");
    expect(result.body).not.toContain("&amp;");
    expect(result.body).not.toContain("&quot;");
  });

  it("chunks body with slide boundaries as paragraph breaks", async () => {
    const ext = await getExtractor(PPTX_PATH);
    const { body, title } = await ext.extract(PPTX_PATH);
    const chunks = ext.chunkText(body, title);
    expect(chunks.length).toBeGreaterThan(0);
    // The body has \n\n between slides, so chunkByParagraph should split there
    for (const chunk of chunks) {
      expect(typeof chunk.content).toBe("string");
      expect(chunk.content.length).toBeGreaterThan(0);
    }
  });
});

describe("chunkByParagraph (chunk-utils)", () => {
  it("returns empty array for empty input", () => {
    expect(chunkByParagraph("")).toEqual([]);
    expect(chunkByParagraph("   ")).toEqual([]);
  });

  it("splits by double-newline boundaries", () => {
    // Use paragraphs long enough to exceed CHUNK_SIZE (500) when accumulated,
    // so the function actually splits into multiple chunks.
    const longPara = "A".repeat(300);
    const text = `${longPara} one.\n\n${longPara} two.\n\n${longPara} three.`;
    const chunks = chunkByParagraph(text, "Test Title");
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    // First chunk should have the title as heading
    expect(chunks[0].heading).toBe("Test Title");
  });

  it("falls back to fixed-size for single-paragraph text", () => {
    const longText = "A".repeat(1200);
    const chunks = chunkByParagraph(longText, "Long");
    expect(chunks.length).toBeGreaterThan(1);
    // Each chunk should be ≤ ~600 chars (500 + overlap)
    for (const chunk of chunks) {
      expect(chunk.content.length).toBeLessThanOrEqual(600);
    }
  });

  it("handles very long paragraphs by slicing", () => {
    const text = "Short intro.\n\n" + "B".repeat(1500);
    const chunks = chunkByParagraph(text, "Mixed");
    expect(chunks.length).toBeGreaterThan(1);
  });
});
