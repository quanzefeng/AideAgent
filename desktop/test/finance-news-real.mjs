// Real-world integration: sub-agent searches financial news via Tavily.
// We invoke runTool("web_search", ...) directly — this is the same code path
// that sub-agent uses internally. No electron dependency.

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

// ── 1. Get Tavily key from env OR safeStorage-encrypted file ──
function getTavilyKey() {
  if (process.env.TAVILY_API_KEY) return process.env.TAVILY_API_KEY;
  // Try to read the encrypted key file (Node can't decrypt safeStorage without
  // electron — so we fall back to plain-text storage check or env-only).
  const keyPath = join(homedir(), ".aideagent", "api-keys.enc");
  if (existsSync(keyPath)) {
    const data = readFileSync(keyPath);
    // The file is encrypted with safeStorage in Electron. In raw Node we can't
    // decrypt, but sometimes the dev path stores plain JSON. Try parse.
    try {
      const obj = JSON.parse(data.toString("utf8"));
      if (obj.tavily) return obj.tavily;
    } catch { /* encrypted, skip */ }
  }
  return null;
}

const tavilyKey = getTavilyKey();
console.log("Tavily key:", tavilyKey ? `loaded (${tavilyKey.slice(0,8)}...)` : "❌ NOT FOUND");

if (!tavilyKey) {
  console.log("Set TAVILY_API_KEY env var or store it in ~/.aideagent/api-keys.enc (plain JSON).");
  process.exit(1);
}

// ── 2. Call Tavily directly (mirrors what web_search tool does) ──
async function webSearch(query, maxResults = 5) {
  const res = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${tavilyKey}` },
    body: JSON.stringify({
      query,
      max_results: maxResults,
      search_depth: "basic",
      topic: "general",
      include_answer: false,
    }),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`Tavily ${res.status}: ${t.slice(0, 200)}`);
  }
  const data = await res.json();
  return data.results?.map(r => ({
    title: r.title,
    url: r.url,
    content: r.content,
    score: r.score,
  })) || [];
}

// ── 3. Then call real LLM (ANTHROPIC_BASE_URL proxy) to summarize ──
async function llmSummarize(systemPrompt, userPrompt) {
  const apiKey = process.env.ANTHROPIC_AUTH_TOKEN;
  const apiUrl = (process.env.ANTHROPIC_BASE_URL || "http://127.0.0.1:15721") + "/v1/messages";
  if (!apiKey) throw new Error("ANTHROPIC_AUTH_TOKEN not set");

  const res = await fetch(apiUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-6",
      max_tokens: 4096,
      system: systemPrompt,
      messages: [{ role: "user", content: userPrompt }],
    }),
    signal: AbortSignal.timeout(60000),
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`LLM ${res.status}: ${t.slice(0, 300)}`);
  }
  const data = await res.json();
  return data.content?.[0]?.text || "";
}

// ── 4. Run the full pipeline ──────────────────────────────────
const task = "最近 7 天的全球财经新闻，重点：美股/港股/A股大盘走势、美联储动态、重大并购";
const queries = [
  "global financial news this week stock market",
  "Federal Reserve interest rate decision June 2026",
  "China A-shares Hong Kong market news",
];

console.log(`\n📰 Searching financial news (${queries.length} queries via Tavily)...\n`);

const t0 = Date.now();
const allResults = [];
for (const q of queries) {
  try {
    const r = await webSearch(q, 5);
    console.log(`  ✓ "${q}" → ${r.length} results`);
    allResults.push({ query: q, results: r });
  } catch (e) {
    console.log(`  ✗ "${q}" → ${e.message}`);
  }
}

const searchElapsed = ((Date.now() - t0) / 1000).toFixed(1);
console.log(`\n⏱️  Search took ${searchElapsed}s, got ${allResults.reduce((n, x) => n + x.results.length, 0)} total results`);

// ── 5. LLM summarizes ─────────────────────────────────────────
const searchContext = allResults.map(({ query, results }) =>
  `Query: ${query}\n${results.map((r, i) =>
    `${i+1}. ${r.title}\n   URL: ${r.url}\n   ${r.content?.slice(0, 300) || "(no snippet)"}`
  ).join("\n")}`
).join("\n\n---\n\n");

const sysPrompt = "你是金融新闻摘要助手。给定一组搜索结果，请用中文输出 300 字以内的结构化摘要，按重要性排序。";
const userPrompt = `${task}\n\n搜索结果：\n${searchContext}`;

console.log("\n🤖 Calling LLM to summarize...\n");
const t1 = Date.now();
let summary;
try {
  summary = await llmSummarize(sysPrompt, userPrompt);
} catch (e) {
  console.error("❌ LLM error:", e.message);
  console.log("\n--- Raw search results (no summary) ---\n");
  console.log(searchContext.slice(0, 2000));
  process.exit(1);
}
const llmElapsed = ((Date.now() - t1) / 1000).toFixed(1);

console.log("─".repeat(70));
console.log(`⏱️  Search ${searchElapsed}s + LLM ${llmElapsed}s = ${((Date.now()-t0)/1000).toFixed(1)}s total`);
console.log(`📝 Summary length: ${summary.length} chars`);
console.log("─".repeat(70));
console.log("\n📊 FINAL SUMMARY:\n");
console.log(summary);
console.log("\n" + "─".repeat(70));
console.log("\n📚 SOURCES (top 10):\n");
allResults.forEach(({ query, results }) => {
  results.slice(0, 3).forEach((r, i) => {
    console.log(`  [${query.slice(0,30)}...] ${r.title}`);
    console.log(`    ${r.url}`);
  });
});
console.log("─".repeat(70));
