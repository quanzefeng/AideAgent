import { describe, it, expect } from "vitest";
import { looksLikeSecret, parseMemoryExtraction } from "../core/memory-extraction.ts";

describe("memory extraction parser", () => {
  it("parses the structured JSON format", () => {
    const items = parseMemoryExtraction(JSON.stringify({
      memories: [
        { type: "user", title: "Language", summary: "Prefers Chinese", content: "Always answer in Chinese" },
        { type: "feedback", title: "Tests", summary: "Focused tests", content: "Do not run the full suite for tiny edits" },
        { type: "project", title: "Storage", summary: "SQLite FTS5", content: "Use SQLite FTS5 for local search" },
        { type: "reference", title: "Docs", summary: "API docs", content: "API docs live at https://example.com/docs" },
      ],
    }));
    expect(items).toHaveLength(4);
    expect(items[0]).toMatchObject({ type: "user", title: "Language", summary: "Prefers Chinese" });
    expect(items[1].type).toBe("feedback");
    expect(items[2].type).toBe("project");
    expect(items[3].type).toBe("reference");
  });

  it("accepts a bare array and a markdown fence", () => {
    const items = parseMemoryExtraction("```json\n[{\"type\":\"feedback\",\"title\":\"No full suite\",\"content\":\"Use focused tests\"}]\n```");
    expect(items).toHaveLength(1);
    expect(items[0].type).toBe("feedback");
    expect(items[0].title).toBe("No full suite");
    expect(items[0].summary).toBe("Use focused tests");
  });

  it("maps legacy line format", () => {
    const items = parseMemoryExtraction([
      "PREFERENCE: answer in Chinese",
      "FEEDBACK: do not run all tests",
      "DECISION: use SQLite",
      "KNOWLEDGE: FTS5 supports unicode61",
      "REFERENCE: docs at example.com",
    ].join("\n"));
    expect(items.map(i => i.type)).toEqual(["user", "feedback", "project", "project", "reference"]);
  });

  it("returns empty for NONE / empty / no memories", () => {
    expect(parseMemoryExtraction("NONE")).toEqual([]);
    expect(parseMemoryExtraction("")).toEqual([]);
    expect(parseMemoryExtraction("{\"memories\":[]}")).toEqual([]);
  });

  it("drops obvious secrets", () => {
    const items = parseMemoryExtraction(JSON.stringify({
      memories: [
        { type: "reference", title: "API key", content: "api_key: sk-abcdefghijklmnopqrstuvwxyz123456" },
        { type: "reference", title: "Env var", content: "Use OPENAI_API_KEY from the environment" },
      ],
    }));
    expect(items).toHaveLength(1);
    expect(items[0].content).toContain("OPENAI_API_KEY");
    expect(looksLikeSecret("password = supersecretvalue123")).toBe(true);
    expect(looksLikeSecret("store the password in the OS keychain")).toBe(false);
    expect(looksLikeSecret("api_key: OPENAI_API_KEY")).toBe(false);
  });
});
