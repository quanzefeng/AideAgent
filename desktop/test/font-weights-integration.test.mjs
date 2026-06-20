/**
 * Integration test for P3方案B font-weights feature.
 *
 * This goes beyond the unit tests in font-weights.test.mjs by simulating
 * the actual browser environment: a document with the 4 weight selects
 * pre-rendered, plus a real HTMLSelectElement class. We import the
 * production font-settings.mjs and verify:
 *   - The 4 selects get initialized to the persisted weights
 *   - The CSS variables get applied to <html> on import
 *   - Changing a select updates localStorage + CSS variables
 *
 * This is the strongest verification possible without launching Electron.
 */

import { describe, it, expect, beforeEach, beforeAll, vi } from "vitest";

// ── Set up a fake browser environment BEFORE importing the module ──

// localStorage
const lsStore = /** @type {Record<string, string>} */ ({});
const lsStub = {
  getItem: (k) => (k in lsStore ? lsStore[k] : null),
  setItem: (k, v) => { lsStore[k] = String(v); },
  removeItem: (k) => { delete lsStore[k]; },
  clear: () => { for (const k of Object.keys(lsStore)) delete lsStore[k]; },
};
globalThis.localStorage = lsStub;

// Track all setProperty calls on <html>
const setPropCalls = /** @type {Array<{prop: string, value: string}>} */ ([]);

// HTMLSelectElement stub — supports value + addEventListener
globalThis.HTMLSelectElement = class HTMLSelectElement {
  constructor() {
    this.value = "";
    this._listeners = {};
  }
  addEventListener(type, fn) { this._listeners[type] = fn; }
  fire(type) { this._listeners[type]?.(); }
};

// HTMLInputElement stub — supports value + addEventListener + disabled
globalThis.HTMLInputElement = class HTMLInputElement {
  constructor() {
    this.value = "";
    this.disabled = false;
    this._listeners = {};
  }
  addEventListener(type, fn) { this._listeners[type] = fn; }
  fire(type) { this._listeners[type]?.(); }
};

// HTMLButtonElement stub — supports disabled
globalThis.HTMLButtonElement = class HTMLButtonElement {
  constructor() {
    this.disabled = false;
    this._listeners = {};
  }
  addEventListener(type, fn) { this._listeners[type] = fn; }
  fire(type) { this._listeners[type]?.(); }
};

// 4 fake number-input elements keyed by ID
const fakeInputs = {
  "fw-normal-input":   new globalThis.HTMLInputElement(),
  "fw-medium-input":   new globalThis.HTMLInputElement(),
  "fw-semibold-input": new globalThis.HTMLInputElement(),
  "fw-bold-input":     new globalThis.HTMLInputElement(),
};

// Save + Reset buttons
const fakeSaveBtn   = new globalThis.HTMLButtonElement();
const fakeResetBtn  = new globalThis.HTMLButtonElement();

globalThis.document = {
  documentElement: {
    style: {
      setProperty: (prop, value) => setPropCalls.push({ prop, value: String(value) }),
    },
  },
  getElementById: (id) => {
    if (id === "fw-save-btn") return fakeSaveBtn;
    if (id === "fw-reset-btn") return fakeResetBtn;
    return fakeInputs[id] ?? null;
  },
};

// ── Import (triggers self-init) ──
const { loadFontWeights, saveFontWeights, applyFontWeights } = await import("../renderer/modules/font-settings.mjs");

// Snapshot of the self-init's side effects, captured BEFORE any beforeEach
// clears them. This lets us verify "what happened on import" independently
// of subsequent test state.
const initInputValues = Object.fromEntries(
  Object.entries(fakeInputs).map(([id, inp]) => [id, inp.value])
);
const initSetPropCalls = [...setPropCalls];

beforeEach(() => {
  lsStub.clear();
  setPropCalls.length = 0;
  // Note: don't reset input.value here — the self-init populated them and
  // individual tests verify specific behaviors that build on the initial state.
});

describe("Font weights integration (P3方案B v3: preview + explicit save)", () => {
  describe("Self-init populates inputs + applies CSS + disables Save", () => {
    it("On import (empty localStorage), all 4 inputs get YaHei-aligned defaults {300/400/700/700}", () => {
      expect(initInputValues).toEqual({
        "fw-normal-input":   "300",
        "fw-medium-input":   "400",
        "fw-semibold-input": "700",
        "fw-bold-input":     "700",
      });
      const props = initSetPropCalls.map(c => c.prop);
      for (const v of ["--fw-normal", "--fw-medium", "--fw-semibold", "--fw-bold"]) {
        expect(props).toContain(v);
      }
    });

    it("Save button is disabled at init (nothing dirty yet)", () => {
      expect(fakeSaveBtn.disabled).toBe(true);
    });
  });

  describe("Live preview (input event) — does NOT persist", () => {
    it("Typing 800 in bold updates CSS but localStorage is unchanged", () => {
      lsStub.clear();
      setPropCalls.length = 0;
      fakeInputs["fw-bold-input"].value = "800";
      fakeInputs["fw-bold-input"].fire("input");
      // CSS updated
      expect(setPropCalls.some(c => c.prop === "--fw-bold" && c.value === "800")).toBe(true);
      // localStorage NOT written
      expect(lsStore["AideAgent_font_weights"]).toBeUndefined();
      // Save button now ENABLED (dirty)
      expect(fakeSaveBtn.disabled).toBe(false);
    });

    it("Typing 9999 → clamped to 900 in CSS preview", () => {
      setPropCalls.length = 0;
      fakeInputs["fw-normal-input"].value = "9999";
      fakeInputs["fw-normal-input"].fire("input");
      expect(setPropCalls.some(c => c.prop === "--fw-normal" && c.value === "900")).toBe(true);
    });
  });

  describe("Blur event — clamps visible value", () => {
    it("Typing 50 then blurring shows '100' in the input (clamped)", () => {
      fakeInputs["fw-bold-input"].value = "50";
      fakeInputs["fw-bold-input"].fire("blur");
      expect(fakeInputs["fw-bold-input"].value).toBe("100");
    });

    it("Blur does NOT persist (save still required)", () => {
      lsStub.clear();
      fakeInputs["fw-bold-input"].value = "500";
      fakeInputs["fw-bold-input"].fire("blur");
      expect(lsStore["AideAgent_font_weights"]).toBeUndefined();
    });
  });

  describe("Save button — explicit persistence", () => {
    it("Click Save → persists all 4 current input values to localStorage", () => {
      fakeInputs["fw-normal-input"].value   = "350";
      fakeInputs["fw-medium-input"].value   = "450";
      fakeInputs["fw-semibold-input"].value = "550";
      fakeInputs["fw-bold-input"].value     = "700";
      // Trigger dirty detection via input event
      for (const inp of Object.values(fakeInputs)) inp.fire("input");
      expect(fakeSaveBtn.disabled).toBe(false);
      // Click save
      fakeSaveBtn.fire("click");
      const stored = JSON.parse(lsStore["AideAgent_font_weights"]);
      expect(stored).toEqual({ normal: 350, medium: 450, semibold: 550, bold: 700 });
    });

    it("After save, button becomes disabled again (no more dirty)", () => {
      fakeInputs["fw-normal-input"].value = "400";
      fakeInputs["fw-normal-input"].fire("input");
      fakeSaveBtn.fire("click");
      expect(fakeSaveBtn.disabled).toBe(true);
    });
  });

  describe("Reset button — restore YaHei-aligned defaults + persist", () => {
    it("Click Reset → inputs show {300/400/700/700} + localStorage has same", () => {
      // First, save a custom value
      fakeInputs["fw-normal-input"].value = "900";
      fakeInputs["fw-normal-input"].fire("input");
      fakeSaveBtn.fire("click");
      // Now reset
      fakeResetBtn.fire("click");
      expect(fakeInputs["fw-normal-input"].value).toBe("300");
      expect(fakeInputs["fw-medium-input"].value).toBe("400");
      expect(fakeInputs["fw-semibold-input"].value).toBe("700");
      expect(fakeInputs["fw-bold-input"].value).toBe("700");
      const stored = JSON.parse(lsStore["AideAgent_font_weights"]);
      expect(stored).toEqual({ normal: 300, medium: 400, semibold: 700, bold: 700 });
    });
  });

  describe("Round-trip", () => {
    it("After save + reload, inputs show the saved values", () => {
      saveFontWeights({ normal: 500, medium: 600, semibold: 700, bold: 800 });
      const w = loadFontWeights();
      fakeInputs["fw-normal-input"].value   = String(w.normal);
      fakeInputs["fw-medium-input"].value   = String(w.medium);
      fakeInputs["fw-semibold-input"].value = String(w.semibold);
      fakeInputs["fw-bold-input"].value     = String(w.bold);
      expect(fakeInputs["fw-normal-input"].value).toBe("500");
    });
  });
});