import { searchMeta } from "./index.ts";

async function test(label: string, query: string, maxRes = 5) {
  console.log(`\n=== ${label} ===`);
  console.log(`Query: "${query}"`);
  console.time("time");
  const r = await searchMeta(query, maxRes);
  console.timeEnd("time");
  console.log(`Results: ${r.results.length}, Provider: ${r.provider}`);
  r.results.forEach((item, i) => {
    console.log(`  ${i + 1}. [${item.score?.toFixed(2)}] ${(item.title || "").slice(0, 60)}`);
    console.log(`     ${(item.url || "").slice(0, 80)}`);
    const c = (item.content || "").slice(0, 100);
    if (c) console.log(`     ${c}`);
  });
  if (r._warnings) console.log(`  WARN: ${r._warnings}`);
  return r;
}

async function main() {
  // Test 1: English tech query
  const r1 = await test("Test 1: English tech", "Node.js 2025");

  // Test 2: Cache hit
  console.log("\n--- Cache test (same query, expect instant) ---");
  console.time("cache");
  const r1c = await searchMeta("Node.js 2025", 5);
  console.timeEnd("cache");
  console.log(`Cache hit: ${r1c === r1 ? "YES" : "NO"}`);

  // Test 3: Chinese query
  await test("Test 3: Chinese query", "北京天气 2025年6月", 4);

  // Test 4: English tech 2
  await test("Test 4: English tech 2", "React Server Components", 4);

  // Test 5: Different cache key
  console.log("\n--- Different query (cache miss) ---");
  console.time("miss");
  await searchMeta("完全不存在的搜索词xxxxxxxx", 3);
  console.timeEnd("miss");

  console.log("\n=== ALL TESTS DONE ===");
}

main().catch((e) => console.error("FATAL:", e));
