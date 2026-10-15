import { describe, it, expect } from "vitest";
import {
  parseRssItems,
  parseHttpDate,
  parseBingHtml,
  parseDdgHtml,
  parseGoogleNewsItems,
  scoreResults,
} from "../search-engine/index.ts";

// Real Bing RSS shape (format=rss), including the Chinese-localized
// pubDate variant that plain Date parsing chokes on.
const BING_RSS = `<?xml version="1.0" encoding="utf-8" ?><rss version="2.0"><channel><title>响应“GPT-5”</title>
<item><title>ChatGPT中文版、GPT-6 Sol、Claude 5.5</title><link>https://chatgpt-guides.com/</link>
<description>ChatGPT入口、ChatGPT中文版网页版怎么用好，含教程。</description>
<pubDate>日, 15 10月 2026 09:38:00 GMT</pubDate></item>
<item><title>ChartGPT</title><link>https://chartgpt.io/</link>
<description>Unlock the power of AI with ChartGPT.</description>
<pubDate>Thu, 15 Oct 2026 09:46:00 GMT</pubDate></item>
</channel></rss>`;

describe("parseRssItems", () => {
  it("extracts title/link/description/pubDate from Bing RSS", () => {
    const items = parseRssItems(BING_RSS);
    expect(items).toHaveLength(2);
    expect(items[0].title).toContain("ChatGPT");
    expect(items[0].link).toBe("https://chatgpt-guides.com/");
    expect(items[0].pubDate).toContain("10月");
  });

  it("handles CDATA and entity-encoded fields", () => {
    const xml = `<rss><channel><item><title><![CDATA[A &amp; B <b>x</b>]]></title>
<link>https://e.com/?a=1&amp;b=2</link><description>&lt;p&gt;hi&lt;/p&gt;</description>
<pubDate>Wed, 15 Oct 2026 08:00:00 GMT</pubDate></item></channel></rss>`;
    const items = parseRssItems(xml);
    expect(items[0].title).toBe("A & B <b>x</b>");
    expect(items[0].link).toBe("https://e.com/?a=1&b=2");
  });

  it("returns empty array for non-RSS input", () => {
    expect(parseRssItems("<html><body>homepage</body></html>")).toEqual([]);
  });
});

describe("parseHttpDate", () => {
  it("parses standard RFC-822 dates", () => {
    expect(parseHttpDate("Thu, 15 Oct 2026 09:46:00 GMT")).toBe("2026-10-15T09:46:00.000Z");
  });

  it("parses Bing's Chinese-localized pubDate", () => {
    expect(parseHttpDate("日, 15 10月 2026 09:38:00 GMT")).toBe("2026-10-15T09:38:00.000Z");
    expect(parseHttpDate("一, 05 1月 2026 00:00:00 GMT")).toBe("2026-01-05T00:00:00.000Z");
  });

  it("parses ISO strings and rejects garbage", () => {
    expect(parseHttpDate("2026-10-15T09:00:00Z")).toBe("2026-10-15T09:00:00.000Z");
    expect(parseHttpDate("not a date")).toBeNull();
    expect(parseHttpDate("")).toBeNull();
  });
});

describe("parseBingHtml (legacy fallback)", () => {
  it("extracts b_algo results", () => {
    const html = `<ul><li class="b_algo"><h2><a href="https://example.com/a">Title A</a></h2>
<div class="b_caption"><p>Snippet A</p></div></li></ul>`;
    const r = parseBingHtml(html, 5);
    expect(r).toHaveLength(1);
    expect(r[0].url).toBe("https://example.com/a");
    expect(r[0].title).toBe("Title A");
    expect(r[0].content).toBe("Snippet A");
  });
});

describe("parseDdgHtml", () => {
  it("unwraps /l/?uddg= redirect links and pairs snippets", () => {
    const html = `<div class="result"><h2 class="result__title">
<a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fpage&amp;rut=abc">Example Title</a></h2>
<a class="result__snippet" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fpage">Example snippet text</a></div>`;
    const r = parseDdgHtml(html, 5);
    expect(r).toHaveLength(1);
    expect(r[0].url).toBe("https://example.com/page");
    expect(r[0].title).toBe("Example Title");
    expect(r[0].content).toBe("Example snippet text");
  });

  it("keeps direct http links untouched", () => {
    const html = `<a class="result__a" href="https://direct.example.org/x">T</a>
<a class="result__snippet">S</a>`;
    const r = parseDdgHtml(html, 5);
    expect(r[0].url).toBe("https://direct.example.org/x");
  });
});

describe("parseGoogleNewsItems", () => {
  it("unwraps the publisher URL from the escaped description anchor", () => {
    const xml = `<rss><channel><item>
<title>OpenAI 发布新模型</title>
<link>https://news.google.com/rss/articles/CBMiXYZ</link>
<description>&lt;a href="https://www.sohu.com/a/123"&gt;OpenAI 发布新模型&lt;/a&gt;&amp;nbsp;&amp;nbsp;&lt;a href="https://news.google.com/rss/search?q=Sohu"&gt;Sohu&lt;/a&gt;</description>
<pubDate>Wed, 15 Oct 2026 08:00:00 GMT</pubDate></item></channel></rss>`;
    const r = parseGoogleNewsItems(xml, 5);
    expect(r).toHaveLength(1);
    expect(r[0].url).toBe("https://www.sohu.com/a/123");
    expect(r[0].date).toBe("2026-10-15T08:00:00.000Z");
    expect(r[0].content).toContain("OpenAI 发布新模型");
  });
});

describe("scoreResults (weighted RRF)", () => {
  it("assigns decreasing reciprocal-rank scores scaled by weight", () => {
    const rs = [{ title: "a", url: "https://a.com", content: "" },
                { title: "b", url: "https://b.com", content: "" }];
    const scored = scoreResults(rs, 1.0);
    expect(scored[0].score).toBeCloseTo(1 / 61, 6);
    expect(scored[1].score).toBeCloseTo(1 / 62, 6);
    const weighted = scoreResults(rs, 0.5);
    expect(weighted[0].score).toBeCloseTo(0.5 / 61, 6);
  });
});
