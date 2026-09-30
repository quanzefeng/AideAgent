import { describe, it, expect } from "vitest";
import { isStreamDropError } from "../core/format-adapters.ts";

describe("isStreamDropError", () => {
  it("classifies undici mid-stream termination", () => {
    expect(isStreamDropError(new TypeError("terminated"))).toBe(true);
    expect(isStreamDropError(new Error("terminated"))).toBe(true);
  });

  it("classifies raw socket drops by code", () => {
    expect(isStreamDropError(Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }))).toBe(true);
    expect(isStreamDropError(Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }))).toBe(true);
    expect(isStreamDropError(new Error("fetch failed", { cause: { code: "UND_ERR_SOCKET" } }))).toBe(true);
    expect(isStreamDropError(new Error("other side closed"))).toBe(true);
  });

  it("does NOT classify client timeout / user abort as a drop", () => {
    const timeoutErr = Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });
    const abortErr = Object.assign(new Error("This operation was aborted"), { name: "AbortError" });
    expect(isStreamDropError(timeoutErr)).toBe(false);
    expect(isStreamDropError(abortErr)).toBe(false);
    expect(isStreamDropError(new Error("API 429 (Too Many Requests)"))).toBe(false);
    expect(isStreamDropError(new Error("Request timed out"))).toBe(false);
  });
});
