import { describe, it, expect } from "vitest";
import { extractThinkBlocks } from "../core/agent-loop.mjs";

describe("extractThinkBlocks", () => {
  it("returns empty for null/empty input", () => {
    expect(extractThinkBlocks("")).toEqual({ cleanText: "", thinkText: "" });
    expect(extractThinkBlocks(null)).toEqual({ cleanText: "", thinkText: "" });
    expect(extractThinkBlocks(undefined)).toEqual({ cleanText: "", thinkText: "" });
  });

  it("extracts a single <think> block", () => {
    const input = "<think>the user wants news</think>Here is the answer.";
    const { cleanText, thinkText } = extractThinkBlocks(input);
    expect(thinkText).toBe("the user wants news");
    expect(cleanText).toBe("Here is the answer.");
  });

  it("extracts multiple <think> blocks separated by newlines", () => {
    const input = "<think>first thought</think>\n\nbetween\n\n<think>second thought</think>end";
    const { cleanText, thinkText } = extractThinkBlocks(input);
    expect(thinkText).toBe("first thought\n\nsecond thought");
    expect(cleanText).toBe("between\n\nend");
  });

  it("matches the renderer's extractThinkingBlocks behavior for adjacent blocks", () => {
    // When <think> blocks are immediately adjacent (no whitespace between
    // the close-tag and the next open-tag), the renderer concatenates the
    // surrounding text. Our save helper mirrors that to stay consistent.
    const input = "<think>a</think>between<think>b</think>end";
    const { cleanText, thinkText } = extractThinkBlocks(input);
    expect(thinkText).toBe("a\n\nb");
    expect(cleanText).toBe("betweenend");
  });

  it("preserves multiline <think> content", () => {
    const input = "<think>line 1\nline 2\nline 3</think>\n\nactual answer";
    const { cleanText, thinkText } = extractThinkBlocks(input);
    expect(thinkText).toBe("line 1\nline 2\nline 3");
    expect(cleanText).toBe("actual answer");
  });

  it("is case-insensitive (DeepSeek uses <think> lowercase)", () => {
    const input = "<THINK>upper</THINK>rest";
    const { cleanText, thinkText } = extractThinkBlocks(input);
    expect(thinkText).toBe("upper");
    expect(cleanText).toBe("rest");
  });

  it("returns the original text as cleanText when there are no think blocks", () => {
    const input = "no think tags here";
    const { cleanText, thinkText } = extractThinkBlocks(input);
    expect(thinkText).toBe("");
    expect(cleanText).toBe("no think tags here");
  });

  it("ignores empty <think> blocks", () => {
    const input = "<think></think>actual";
    const { cleanText, thinkText } = extractThinkBlocks(input);
    expect(thinkText).toBe("");
    expect(cleanText).toBe("actual");
  });

  it("collapses 3+ consecutive newlines left by tag removal", () => {
    const input = "<think>thought</think>\n\n\n\nactual";
    const { cleanText } = extractThinkBlocks(input);
    // Should not have 4+ newlines after stripping the tag + surrounding whitespace
    expect(cleanText).not.toMatch(/\n{3,}/);
    expect(cleanText).toBe("actual");
  });

  it("does NOT match <thinking> (with ing suffix — different tag)", () => {
    // This is the actual bug fix scope: we only match <think>, not <thinking>.
    // If a model emits <thinking>, the save path doesn't strip it; the
    // renderer's regex also only matches <think> so this is consistent.
    const input = "<thinking>thought</thinking>actual";
    const { cleanText, thinkText } = extractThinkBlocks(input);
    expect(thinkText).toBe("");
    expect(cleanText).toBe("<thinking>thought</thinking>actual");
  });

  it("handles a MiniMax M3-style response (the bug we fixed)", () => {
    // This is the actual symptom: a response with no separate
    // reasoning_content but with <think> tags inside content.
    const input = "<think>The user asked about financial news. Let me search.</think>Here are the latest headlines:\n1. Market update\n2. Fed decision";
    const { cleanText, thinkText } = extractThinkBlocks(input);
    // What gets stored in reasoning_content:
    expect(thinkText).toBe("The user asked about financial news. Let me search.");
    // What gets stored in content (clean, no tags):
    expect(cleanText).toBe("Here are the latest headlines:\n1. Market update\n2. Fed decision");
    expect(cleanText).not.toContain("<think>");
  });

  it("is non-greedy so adjacent blocks don't merge", () => {
    const input = "<think>a</think>middle<think>b</think>";
    const { cleanText, thinkText } = extractThinkBlocks(input);
    expect(thinkText).toBe("a\n\nb");
    expect(cleanText).toBe("middle");
  });
});
