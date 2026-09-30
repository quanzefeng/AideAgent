import { searchBaidu, searchSogou, searchDuckDuckGo, searchBing, searchGitHub } from "./index.ts";

async function debug() {
  // Test Baidu debug
  console.log("=== Baidu Debug ===");
  try {
    const r = await searchBaidu("Node.js", 3);
    console.log(`Results: ${r.length}`);
    r.forEach((x, i) => {
      console.log(`  ${i + 1}. title="${(x.title || "").slice(0, 60)}"`);
      console.log(`     url="${(x.url || "").slice(0, 80)}"`);
    });
  } catch (e: any) {
    console.log("Baidu error:", e.message);
  }

  // Test Sogou debug
  console.log("\n=== Sogou Debug ===");
  try {
    const r = await searchSogou("Node.js", 3);
    console.log(`Results: ${r.length}`);
    r.forEach((x, i) => {
      console.log(`  ${i + 1}. title="${(x.title || "").slice(0, 60)}"`);
      console.log(`     url="${(x.url || "").slice(0, 80)}"`);
    });
  } catch (e: any) {
    console.log("Sogou error:", e.message);
  }

  // Test DDG debug
  console.log("\n=== DDG Debug ===");
  try {
    const r = await searchDuckDuckGo("Node.js", 3);
    console.log(`Results: ${r.length}`);
    r.forEach((x, i) => {
      console.log(`  ${i + 1}. title="${(x.title || "").slice(0, 60)}"`);
    });
  } catch (e: any) {
    console.log("DDG error:", e.message);
  }

  console.log("\n=== Bing Debug ===");
  try {
    const r = await searchBing("Node.js", 3);
    console.log(`Results: ${r.length}`);
    r.forEach((x, i) => {
      console.log(`  ${i + 1}. title="${(x.title || "").slice(0, 60)}"`);
    });
  } catch (e: any) {
    console.log("Bing error:", e.message);
  }
}

debug().catch((e) => console.error("FATAL:", e));
