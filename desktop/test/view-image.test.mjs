/**
 * Tests for the view_image tool — P3方案A.
 *
 * The tool reads an image file as binary, base64-encodes it, and returns a
 * structured { type: "image", media_type, data, ... } payload that the
 * agent-loop converts into an image_url content block for the next LLM call.
 *
 * NOTE: We invoke runTool() directly with a mock tool-call object, mimicking
 * what agent-loop does after the LLM emits a tool_call. We do NOT touch the
 * network — view_image is pure local I/O.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { writeFileSync, mkdirSync, rmSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runTool } from "../core/tool-executor.mjs";

const TEST_DIR = join(tmpdir(), `aideagent-view-image-${Date.now()}`);

// ── Test fixtures ──────────────────────────────────────────────
// 1x1 transparent PNG (smallest valid PNG, 67 bytes)
const PNG_1X1 = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, // PNG signature
  0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52, // IHDR length + type
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, // 1x1
  0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
  0x89, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x44, 0x41, // IDAT
  0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00,
  0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00,
  0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, // IEND
  0x42, 0x60, 0x82,
]);

// Minimal JPEG (1x1 white). Hex source: tiny-jpeg library baseline
const JPEG_1X1 = Buffer.from([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01,
  0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0xff, 0xdb, 0x00, 0x43,
  0x00, 0x08, 0x06, 0x06, 0x07, 0x06, 0x05, 0x08, 0x07, 0x07, 0x07, 0x09,
  0x09, 0x08, 0x0a, 0x0c, 0x14, 0x0d, 0x0c, 0x0b, 0x0b, 0x0c, 0x19, 0x12,
  0x13, 0x0f, 0x14, 0x1d, 0x1a, 0x1f, 0x1e, 0x1d, 0x1a, 0x1c, 0x1c, 0x20,
  0x24, 0x2e, 0x27, 0x20, 0x22, 0x2c, 0x23, 0x1c, 0x1c, 0x28, 0x37, 0x29,
  0x2c, 0x30, 0x31, 0x34, 0x34, 0x34, 0x1f, 0x27, 0x39, 0x3d, 0x38, 0x32,
  0x3c, 0x2e, 0x33, 0x34, 0x32, 0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0x01,
  0x00, 0x01, 0x01, 0x01, 0x11, 0x00, 0xff, 0xc4, 0x00, 0x1f, 0x00, 0x00,
  0x01, 0x05, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x00, 0x00, 0x00, 0x00,
  0x00, 0x00, 0x00, 0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08,
  0x09, 0x0a, 0x0b, 0xff, 0xc4, 0x00, 0xb5, 0x10, 0x00, 0x02, 0x01, 0x03,
  0x03, 0x02, 0x04, 0x03, 0x05, 0x05, 0x04, 0x04, 0x00, 0x00, 0x01, 0x7d,
  0x01, 0x02, 0x03, 0x00, 0x04, 0x11, 0x05, 0x12, 0x21, 0x31, 0x41, 0x06,
  0x13, 0x51, 0x61, 0x07, 0x22, 0x71, 0x14, 0x32, 0x81, 0x91, 0xa1, 0x08,
  0x23, 0x42, 0xb1, 0xc1, 0x15, 0x52, 0xd1, 0xf0, 0x24, 0x33, 0x62, 0x72,
  0x82, 0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00, 0xfb,
  0xd0, 0xff, 0xd9,
]);

describe("view_image tool (P3方案A)", () => {
  beforeAll(() => {
    mkdirSync(TEST_DIR, { recursive: true });
    writeFileSync(join(TEST_DIR, "test.png"), PNG_1X1);
    writeFileSync(join(TEST_DIR, "test.jpg"), JPEG_1X1);
    writeFileSync(join(TEST_DIR, "test.jpeg"), JPEG_1X1);
    writeFileSync(join(TEST_DIR, "test.txt"), "this is a text file, not an image");
  });

  afterAll(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });
  });

  function callViewImage(args) {
    return runTool({
      id: "test_tc_id",
      type: "function",
      function: {
        name: "view_image",
        arguments: JSON.stringify(args),
      },
    });
  }

  it("reads a valid PNG and returns image payload", async () => {
    const path = join(TEST_DIR, "test.png");
    const result = await callViewImage({ path });

    expect(result.type).toBe("image");
    expect(result.media_type).toBe("image/png");
    expect(typeof result.data).toBe("string");
    expect(result.data.length).toBeGreaterThan(0);
    // Verify the base64 decodes back to the original PNG bytes
    const decoded = Buffer.from(result.data, "base64");
    expect(decoded.length).toBe(PNG_1X1.length);
    expect(decoded.equals(PNG_1X1)).toBe(true);
    expect(result.size).toBe(PNG_1X1.length);
    expect(result.description).toContain(path);
  });

  it("reads a valid JPG and sets media_type to image/jpeg", async () => {
    const result = await callViewImage({ path: join(TEST_DIR, "test.jpg") });
    expect(result.type).toBe("image");
    expect(result.media_type).toBe("image/jpeg");
    expect(Buffer.from(result.data, "base64").equals(JPEG_1X1)).toBe(true);
  });

  it("treats .jpeg same as .jpg", async () => {
    const result = await callViewImage({ path: join(TEST_DIR, "test.jpeg") });
    expect(result.media_type).toBe("image/jpeg");
  });

  it("rejects unsupported extensions with a clear error", async () => {
    const result = await callViewImage({ path: join(TEST_DIR, "test.txt") });
    expect(result.error).toBeTruthy();
    expect(result.error).toMatch(/Unsupported image format/i);
    expect(result.error).toContain(".txt");
  });

  it("rejects missing files", async () => {
    const result = await callViewImage({ path: join(TEST_DIR, "does-not-exist.png") });
    expect(result.error).toBeTruthy();
    // fs.readFile rejects with ENOENT
    expect(result.error).toMatch(/ENOENT|no such file/i);
  });

  it("rejects when path arg is missing", async () => {
    const result = await callViewImage({});
    expect(result.error).toMatch(/path is required/i);
  });

  it("rejects when path arg is not a string", async () => {
    const result = await callViewImage({ path: 12345 });
    expect(result.error).toMatch(/path is required/i);
  });

  it("rejects images larger than 10MB", async () => {
    // Create a fake "11MB image" file. Extension check happens first so we
    // use .png even though the bytes are not a real PNG; we never get to
    // the decode step because the size check comes after ext.
    const bigPath = join(TEST_DIR, "huge.png");
    writeFileSync(bigPath, Buffer.alloc(11 * 1024 * 1024, 0));
    const result = await callViewImage({ path: bigPath });
    expect(result.error).toMatch(/too large/i);
    expect(result.error).toContain("10MB");
  });

  it("accepts images just under the 10MB limit (warns but doesn't reject)", async () => {
    // 9MB — above soft warn (5MB), below hard reject (10MB). Should succeed.
    // We silence the warn during the test to keep output clean.
    const origWarn = console.warn;
    const warns = [];
    console.warn = (...args) => warns.push(args.join(" "));
    try {
      const okPath = join(TEST_DIR, "almost-huge.png");
      writeFileSync(okPath, Buffer.alloc(9 * 1024 * 1024, 0));
      const result = await callViewImage({ path: okPath });
      expect(result.type).toBe("image");
      expect(result.media_type).toBe("image/png");
      expect(result.data.length).toBeGreaterThan(0);
      // Soft warn should have fired
      expect(warns.some(w => /Large image/i.test(w) && /9/.test(w))).toBe(true);
    } finally {
      console.warn = origWarn;
    }
  });

  it("accepts small images without warning (under 5MB threshold)", async () => {
    const origWarn = console.warn;
    const warns = [];
    console.warn = (...args) => warns.push(args.join(" "));
    try {
      // 1MB — under soft warn
      const smallPath = join(TEST_DIR, "small.png");
      writeFileSync(smallPath, Buffer.alloc(1 * 1024 * 1024, 0));
      const result = await callViewImage({ path: smallPath });
      expect(result.type).toBe("image");
      expect(warns.some(w => /Large image/i.test(w))).toBe(false);
    } finally {
      console.warn = origWarn;
    }
  });

  it("path with no extension → unsupported error", async () => {
    const noExt = join(TEST_DIR, "noext");
    writeFileSync(noExt, Buffer.from("raw bytes"));
    const result = await callViewImage({ path: noExt });
    expect(result.error).toMatch(/Unsupported image format/i);
  });
});