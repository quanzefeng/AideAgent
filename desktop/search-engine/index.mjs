// ── Zero-Dependency Meta-Search Engine ──────────────────────────
// Aggregates multiple free search sources with caching, health
// tracking, intelligent dedup, and score normalization.
//
// Sources: Bing / GitHub API
// All fire in parallel; failures are collected silently.
// Results are deduplicated by URL + title similarity and sorted.

// ── In-memory Cache ─────────────────────────────────────────────
const cache = new Map();
const CACHE_TTL = 60_000;

/**
 * @typedef {Object} SearchResult
 * @property {string} title
 * @property {string} url
 * @property {string} content
 * @property {number} [score]
 */

/**
 * @typedef {Object} SearchMetaResult
 * @property {string} query
 * @property {string} provider
 * @property {SearchResult[]} results
 * @property {string|undefined} _warnings
 */

/** @param {string} key @returns {*} */
function cacheGet(key) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiry) { cache.delete(key); return null; }
  return entry.data;
}

/** @param {string} key @param {*} data @param {number} [ttl] */
function cacheSet(key, data, ttl = CACHE_TTL) {
  cache.set(key, { data, expiry: Date.now() + ttl });
}

// ── Source Health Tracking ──────────────────────────────────────
// Skip a source after MAX_FAILURES consecutive failures, back off
// for BACKOFF_MS, then try again.
const sourceHealth = new Map();
const MAX_FAILURES = 3;
const BACKOFF_MS = 120_000;

/** @param {string} name @returns {boolean} */
function isSourceHealthy(name) {
  const h = sourceHealth.get(name);
  if (!h) return true;
  if (h.failures >= MAX_FAILURES && Date.now() < h.skipUntil) return false;
  if (Date.now() >= h.skipUntil) { sourceHealth.delete(name); return true; }
  return true;
}

/** @param {string} name */
function recordFailure(name) {
  const h = sourceHealth.get(name) || { failures: 0, skipUntil: 0 };
  h.failures++;
  if (h.failures >= MAX_FAILURES) h.skipUntil = Date.now() + BACKOFF_MS;
  sourceHealth.set(name, h);
}

/** @param {string} name */
function recordSuccess(name) {
  sourceHealth.delete(name);
}

// ── Helpers ─────────────────────────────────────────────────────
/** @param {string} text @returns {string} */
function stripHtml(text) {
  return text
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (/** @type {string} */ _, /** @type {string} */ c) => String.fromCharCode(Number(c)))
    .replace(/\s+/g, " ")
    .trim();
}

/** @param {string} raw @returns {string} */
function normalizeUrl(raw) {
  try {
    const u = new URL(raw);
    u.hash = "";
    // Strip common tracking params
    for (const p of ["utm_source","utm_medium","utm_campaign","utm_term",
      "utm_content","ref","source","fbclid","gclid"]) {
      u.searchParams.delete(p);
    }
    return (u.hostname + u.pathname).replace(/\/+$/, "").toLowerCase();
  } catch {
    return raw.toLowerCase().replace(/^https?:\/\//, "").replace(/\/$/, "");
  }
}

// Simple character-level title similarity (0-1).
/** @param {string} a @param {string} b @returns {number} */
function titleSimilarity(a, b) {
  const na = a.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]/g, "");
  const nb = b.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]/g, "");
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  if (na.includes(nb) || nb.includes(na)) return 0.85;
  const maxLen = Math.max(na.length, nb.length);
  if (maxLen < 5) return na === nb ? 1 : 0;
  let matches = 0;
  for (let i = 0; i < Math.min(na.length, nb.length); i++) {
    if (na[i] === nb[i]) matches++;
  }
  return matches / maxLen;
}

/** @param {SearchResult[]} results @returns {SearchResult[]} */
function deduplicate(results) {
  // Pass 1: URL dedup (fast)
  const urlSeen = new Set();
  const urlDeduped = [];
  for (const r of results) {
    const key = normalizeUrl(r.url);
    if (urlSeen.has(key)) continue;
    urlSeen.add(key);
    urlDeduped.push(r);
  }
  // Pass 2: title similarity dedup
  const final = [];
  outer: for (const r of urlDeduped) {
    for (const existing of final) {
      if (titleSimilarity(r.title, existing.title) > 0.8) {
        if ((r.score || 0) > (existing.score || 0)) {
          existing.score = r.score;
          existing.url = r.url;
          if (r.content && r.content.length > (existing.content || "").length) {
            existing.content = r.content;
          }
        }
        continue outer;
      }
    }
    final.push(r);
  }
  return final;
}

// Assign position-based scores then multiply by source weight.
/**
 * @param {SearchResult[]} results
 * @param {number} weight
 * @returns {SearchResult[]}
 */
function scoreResults(results, weight) {
  return results.map((r, i) => ({
    ...r,
    score: weight * Math.max(0, 1 - i * 0.12),
  }));
}

// ── Bing ─────────────────────────────────────────────────────────
// [search-mode]
// MAXIMIZE SEARCH EFFORT. Launch multiple background agents IN PARALLEL:
// - explore agents (codebase patterns, file structures, ast-grep)
// - librarian agents (remote repos, official docs, GitHub examples)
// Plus direct tools: Grep, ripgrep (rg), ast-grep (sg)
// NEVER stop at first result - be exhaustive.
//
// Uses public Bing search page. Intended for personal, low-frequency use.
// For production or high-volume usage, replace with Bing Search API:
// https://www.microsoft.com/en-us/bing/apis/bing-web-search-api
/** @param {string} query @param {number} maxResults @returns {Promise<SearchResult[]>} */
async function searchBing(query, maxResults) {
  const hasChinese = /[\u4e00-\u9fff]/.test(query);
  const host = hasChinese ? "cn.bing.com" : "www.bing.com";
  const cc = hasChinese ? "cn" : "us";
  const lang = hasChinese ? "zh-cn" : "en-us";
  const url = `https://${host}/search?q=${encodeURIComponent(query)}&count=${maxResults}&setlang=${lang}&cc=${cc}`;
  const res = await fetch(url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      "Accept-Language": hasChinese ? "zh-CN,zh;q=0.9" : "en-US,en;q=0.9",
    },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`Bing HTTP ${res.status}`);
  const html = await res.text();
  if (/captcha|unusual traffic|verify your identity/i.test(html)) {
    throw new Error("Bing captcha challenge");
  }

  const results = [];
  // Primary: b_algo. Fallback: b_caption, b_vlist, b_ans, card.
  const patterns = [
    /<li[^>]*class="b_algo"[^>]*>([\s\S]*?)<\/li>/gi,
    /<div[^>]*class="b_caption"[^>]*>([\s\S]*?)<\/div>/gi,
    /<div[^>]*class="b_vlist"[^>]*>([\s\S]*?)<\/div>/gi,
  ];

  for (const re of patterns) {
    let m;
    while ((m = re.exec(html)) !== null && results.length < maxResults) {
      const item = m[1];
      const urlMatch = /<a[^>]*href="(https?:\/\/[^"]+)"[^>]*>/i.exec(item);
      if (!urlMatch) continue;
      const titleMatch = /<[Aa][^>]*>([\s\S]*?)<\/[Aa]>/i.exec(item);
      const snippetMatch = /<p[^>]*>([\s\S]*?)<\/p>/i.exec(item);
      results.push({
        title: titleMatch ? stripHtml(titleMatch[1]).slice(0, 300) : "",
        url: urlMatch[1],
        content: snippetMatch ? stripHtml(snippetMatch[1]).slice(0, 600) : "",
      });
    }
  }
  return results;
}

// ── GitHub API ──────────────────────────────────────────────────
/** @param {string} query @param {number} maxResults @returns {Promise<SearchResult[]>} */
async function searchGitHub(query, maxResults) {
  const perPage = Math.min(maxResults, 5);
  const url = `https://api.github.com/search/repositories?q=${encodeURIComponent(query)}&per_page=${perPage}&sort=stars`;
  const res = await fetch(url, {
    headers: { Accept: "application/vnd.github.v3+json", "User-Agent": "AideAgent" },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`GitHub HTTP ${res.status}`);
  const data = await res.json();
  return (data.items || []).slice(0, maxResults).map((/** @type {*} */ r) => ({
    title: r.full_name,
    url: r.html_url,
    content: `${r.description || ""}  ⭐${r.stargazers_count} 🍴${r.forks_count}`,
  }));
}

// ── Baidu (mobile) ──────────────────────────────────────────────
/** @param {string} query @param {number} maxResults @returns {Promise<SearchResult[]>} */
async function searchBaidu(query, maxResults) {
  const url = `https://m.baidu.com/s?word=${encodeURIComponent(query)}&tn=98050039_dg`;
  const res = await fetch(url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      "Accept-Language": "zh-CN,zh;q=0.9",
    },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`Baidu HTTP ${res.status}`);
  const html = await res.text();
  if (/captcha|验证码|安全验证|antispider/i.test(html)) {
    throw new Error("Baidu captcha challenge");
  }
  // Mobile Baidu renders results via JS in SPA shell —
  // the raw HTML has no result content.  Return empty so
  // callers treat it as "no results" without error noise.
  return [];
}

// ── Source weights for score normalization ─────────────────────
const SOURCE_WEIGHTS = {
  bing:   1.0,
  github: 0.6,
};

// ── Public Entry Point ──────────────────────────────────────────
/** @param {string} query @param {number} [maxResults] @returns {Promise<SearchMetaResult>} */
export async function searchMeta(query, maxResults = 5) {
  const maxRes = Math.min(maxResults, 10);
  const cacheKey = `${query}|${maxRes}`;
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  const allResults = [];
  const errors = [];

  const sources = [
    { name: "bing",   fn: () => searchBing(query, maxRes),             weight: SOURCE_WEIGHTS.bing },
    { name: "github", fn: () => searchGitHub(query, Math.min(maxRes, 3)), weight: SOURCE_WEIGHTS.github },
  ];

  // Filter out unhealthy sources
  const active = sources.filter(s => isSourceHealthy(s.name));

  const settled = await Promise.allSettled(active.map(s => s.fn()));

  for (let i = 0; i < active.length; i++) {
    const s = active[i];
    const r = settled[i];
    if (r.status === "fulfilled") {
      const scored = scoreResults(r.value, s.weight);
      allResults.push(...scored);
      recordSuccess(s.name);
    } else {
      errors.push(`${s.name}: ${r.reason?.message || String(r.reason)}`);
      recordFailure(s.name);
    }
  }

  // Deduplicate and sort
  const deduped = deduplicate(allResults);
  deduped.sort((a, b) => (b.score || 0) - (a.score || 0));

  const result = {
    query,
    provider: "metasearch",
    results: deduped.slice(0, maxRes),
    _warnings:
      errors.length > 0
        ? `Some sources unavailable: ${errors.join("; ")}`
        : undefined,
  };

  cacheSet(cacheKey, result);
  return result;
}
