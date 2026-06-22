/**
 * Tests for P3方案B font-weights feature.
 *
 * Three concerns covered:
 *   1. Defaults match the pre-feature hard-coded values (no visual change
 *      on first install — regression guard).
 *   2. loadFontWeights validates against FW_ALLOWED (corrupt localStorage
 *      is silently sanitized, never throws).
 *   3. applyFontWeights injects CSS custom properties on <html> in the
 *      correct format.
 *
 * localStorage and document are stubbed so the module's self-init runs in
 * Node without DOM. We import the named exports directly and exercise them.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

// ── Stub localStorage + document for Node environment ──
const lsStore = /** @type {Record<string, string>} */ ({});
const lsStub = {
  getItem: (k) => (k in lsStore ? lsStore[k] : null),
  setItem: (k, v) => { lsStore[k] = String(v); },
  removeItem: (k) => { delete lsStore[k]; },
  clear: () => { for (const k of Object.keys(lsStore)) delete lsStore[k]; },
};
globalThis.localStorage = lsStub;

// Stub HTMLSelectElement + HTMLInputElement + HTMLButtonElement so the
// module's self-init `instanceof` checks succeed. The 4 inputs + 2 buttons
// don't exist in the stubbed document, so the loops will skip them all
// (getElementById returns null → not instanceof → continue).
globalThis.HTMLSelectElement = class HTMLSelectElement {};
globalThis.HTMLInputElement = class HTMLInputElement {};
globalThis.HTMLButtonElement = class HTMLButtonElement {};

// document.documentElement.style.setProperty stub — track every setProperty call
const setPropCalls = /** @type {Array<{prop: string, value: string}>} */ ([]);
const styleStub = {
  setProperty: (/** @type {string} */ prop, /** @type {string} */ value) => {
    setPropCalls.push({ prop, value });
  },
};
globalThis.document = {
  documentElement: { style: styleStub },
  getElementById: () => null, // not needed for pure-function tests
};

// ── Import after stubs (the module self-initializes on import) ──
const { applyFontWeights, loadFontWeights, saveFontWeights, clampWeight } = await import("../renderer/modules/font-settings.mjs");

// Constants from the module — derive defaults by reading with empty storage.
// We can't import the internal FW_DEFAULTS constants because they aren't
// exported; instead we verify them through observable behavior.
// P3方案C: defaults match what Microsoft YaHei actually ships — 400 (Regular),
// 700 (Bold). Semibold and bold default to the same value (700) because YaHei
// has no distinct "semibold" weight. normal and medium both default to 400
// because YaHei has no distinct Light weight on most Windows installs.
const FW_DEFAULTS = { normal: 400, medium: 400, semibold: 700, bold: 700 };

beforeEach(() => {
  lsStub.clear();
  setPropCalls.length = 0;
});

describe("Font weights (P3方案B)", () => {
  describe("Defaults (P3方案C: match YaHei reality)", () => {
    it("loadFontWeights() returns {normal:400, medium:400, semibold:700, bold:700}", () => {
      expect(loadFontWeights()).toEqual({ normal: 400, medium: 400, semibold: 700, bold: 700 });
    });
  });

  describe("clampWeight (v2 logic: clamp to [100,900], fallback to default)", () => {
    it("passes through values in range", () => {
      expect(clampWeight("normal", 250)).toBe(250);
      expect(clampWeight("bold", 750)).toBe(750);
    });

    it("clamps values below 100 to 100", () => {
      expect(clampWeight("normal", 50)).toBe(100);
      expect(clampWeight("normal", 0)).toBe(100);
      expect(clampWeight("normal", -100)).toBe(100);
    });

    it("clamps values above 900 to 900", () => {
      expect(clampWeight("bold", 9999)).toBe(900);
      expect(clampWeight("bold", 1500)).toBe(900);
    });

    it("rounds non-integer values to nearest integer", () => {
      expect(clampWeight("normal", 333.7)).toBe(334);
      expect(clampWeight("normal", 333.4)).toBe(333);
    });

    it("falls back to per-key default for non-numeric values", () => {
      expect(clampWeight("normal",   null)).toBe(400);
      expect(clampWeight("medium",   undefined)).toBe(400);
      expect(clampWeight("semibold", NaN)).toBe(700);
      expect(clampWeight("bold",     Infinity)).toBe(700);   // Number.isFinite → default
      expect(clampWeight("bold",     "abc")).toBe(700);
    });
  });

  describe("loadFontWeights (with clamping)", () => {
    it("returns defaults when localStorage is empty", () => {
      expect(loadFontWeights()).toEqual(FW_DEFAULTS);
    });

    it("returns defaults when localStorage has invalid JSON", () => {
      lsStore["AideAgent_font_weights"] = "{not json";
      expect(loadFontWeights()).toEqual(FW_DEFAULTS);
    });

    it("clamps out-of-range stored values", () => {
      lsStore["AideAgent_font_weights"] = JSON.stringify({
        normal: 50,      // → 100
        medium: 600,     // → 600 (in range)
        semibold: 9999,  // → 900
        bold: 100,       // → 100
      });
      const w = loadFontWeights();
      expect(w.normal).toBe(100);
      expect(w.medium).toBe(600);
      expect(w.semibold).toBe(900);
      expect(w.bold).toBe(100);
    });

    it("falls back to defaults for non-numeric stored values", () => {
      lsStore["AideAgent_font_weights"] = JSON.stringify({
        normal: "abc",
        medium: 400,
        semibold: null,
        bold: { x: 1 },
      });
      const w = loadFontWeights();
      expect(w.normal).toBe(400);     // default
      expect(w.medium).toBe(400);     // valid
      expect(w.semibold).toBe(700);   // default (null → default)
      expect(w.bold).toBe(700);        // default (object → default)
    });

    it("preserves the FW_DEFAULTS shape regardless of stored keys", () => {
      lsStore["AideAgent_font_weights"] = JSON.stringify({
        normal: 400,
        unknownKey: 999,
        bold: 700,
      });
      const w = loadFontWeights();
      expect(Object.keys(w).sort()).toEqual(Object.keys(FW_DEFAULTS).sort());
    });
  });

  describe("applyFontWeights", () => {
    it("sets each weight as a CSS custom property on <html>", () => {
      applyFontWeights({ normal: 250, medium: 500, semibold: 700, bold: 850 });
      const byProp = Object.fromEntries(setPropCalls.map(c => [c.prop, c.value]));
      expect(byProp["--fw-normal"]).toBe("250");
      expect(byProp["--fw-medium"]).toBe("500");
      expect(byProp["--fw-semibold"]).toBe("700");
      expect(byProp["--fw-bold"]).toBe("850");
    });

    it("is a no-op when given null", () => {
      applyFontWeights(null);
      expect(setPropCalls).toEqual([]);
    });

    it("ignores unknown keys (doesn't pollute CSS)", () => {
      applyFontWeights({ normal: 400, bogus: 999 });
      const props = setPropCalls.map(c => c.prop);
      expect(props).toContain("--fw-normal");
      expect(props).not.toContain("--fw-bogus");
    });
  });

  describe("saveFontWeights", () => {
    it("persists JSON-serialized weights to localStorage", () => {
      saveFontWeights({ normal: 400, medium: 400, semibold: 700, bold: 700 });
      const stored = JSON.parse(lsStore["AideAgent_font_weights"]);
      expect(stored).toEqual({ normal: 400, medium: 400, semibold: 700, bold: 700 });
    });
  });

  describe("Round-trip: save → load returns same values", () => {
    it("preserves all four weights (in-range)", () => {
      const input = { normal: 350, medium: 550, semibold: 750, bold: 850 };
      saveFontWeights(input);
      expect(loadFontWeights()).toEqual(input);
    });

    it("clamps out-of-range values on round-trip", () => {
      saveFontWeights({ normal: 50, medium: 200, semibold: 1500, bold: 700 });
      expect(loadFontWeights()).toEqual({ normal: 100, medium: 200, semibold: 900, bold: 700 });
    });
  });
});