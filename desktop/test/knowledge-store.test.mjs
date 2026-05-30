import { describe, it, expect } from "vitest";
import { getVault, getConfig, setConfig, getStatus } from "../knowledge-store.mjs";

describe("Knowledge Store", () => {
  it("getVault returns string", () => {
    expect(typeof getVault()).toBe("string");
  });

  it("getConfig returns object", () => {
    const cfg = getConfig();
    expect(cfg).toHaveProperty("embeddingProvider");
    expect(cfg).toHaveProperty("maxNotes");
    expect(cfg).toHaveProperty("maxChars");
  });

  it("setConfig clamps values", () => {
    setConfig({ maxNotes: 200 });
    const cfg = getConfig();
    expect(cfg.maxNotes).toBeLessThanOrEqual(100);
    setConfig({ maxNotes: 5 });
  });

  it("getStatus returns stats", () => {
    const status = getStatus();
    expect(status).toHaveProperty("noteCount");
    expect(status).toHaveProperty("embeddedCount");
    expect(typeof status.noteCount).toBe("number");
  });

  it("getConfig returns consistent shape", () => {
    const cfg = getConfig();
    expect(typeof cfg.embeddingProvider).toBe("string");
    expect(typeof cfg.maxNotes).toBe("number");
    expect(typeof cfg.maxChars).toBe("number");
  });
});
