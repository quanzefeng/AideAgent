import { describe, it, expect, afterAll } from "vitest";
import { searchMeta, configureMetaSearch } from "../search-engine/index.ts";

// Regression: isSourceHealthy used to delete the health entry on every
// probe (Date.now() >= skipUntil(0) is always true), so consecutive
// failures never accumulated and the backoff never engaged. A dead
// source was retried forever, adding its full timeout to every search.
describe("source health backoff", () => {
  const realFetch = globalThis.fetch;
  afterAll(() => configureMetaSearch({ fetch: realFetch }));

  it("skips a source after 3 consecutive failures", async () => {
    configureMetaSearch({
      fetch: (async (url: any) => {
        if (String(url).includes("duckduckgo")) throw new Error("simulated ddg failure");
        return {
          ok: true,
          status: 200,
          text: async () => `<?xml version="1.0"?><rss version="2.0"><channel><item><title>t</title><link>https://e.com/${encodeURIComponent(String(url).slice(20, 40))}</link><description>d</description><pubDate>Wed, 15 Oct 2026 08:00:00 GMT</pubDate></item></channel></rss>`,
          json: async () => ({}),
        } as any;
      }) as typeof fetch,
    });

    const warnings: string[] = [];
    for (let i = 1; i <= 5; i++) {
      const r = await searchMeta(`health-regression-query-${i}`, 5);
      warnings.push(r._warnings || "");
    }

    for (let i = 0; i < 3; i++) {
      expect(warnings[i]).toContain("ddg");
    }
    expect(warnings[3]).not.toContain("ddg");
    expect(warnings[4]).not.toContain("ddg");
  });
});
