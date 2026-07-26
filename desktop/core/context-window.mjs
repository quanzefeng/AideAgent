// ── Dynamic Context Window Resolution ───────────────────────
//
// CONTEXT_WINDOW used to be a fixed 256K (state.mjs). This module re-resolves
// it from the active model on every query:submit, with this priority:
//
//   1. Manual override (user typed a value into API config)
//   2. Local server probe — the SERVED context, not the model's native max
//      (LM Studio /api/v0/models → loaded_context_length,
//       llama.cpp /props → n_ctx,
//       Ollama /api/ps → /api/show model_info)
//   3. Cloud probe — GET {apiUrl}/models, context_length-style fields
//      (OpenRouter / Together / OpenCode Go / …)
//   4. Name regex table (known cloud models, offline fallback)
//   5. DEFAULT_CONTEXT_WINDOW (256K, the old fixed behavior)
//
// Why served-first for local: a user who loads a model in LM Studio with the
// 64K slider gets context-length errors at 64K even though the model natively
// supports 256K. `loaded_context_length` reflects that GUI setting exactly.
// Native-only values (max_context_length, Ollama model_info) overstate what
// the server actually allows, so they are capped at the old fixed window.

import { DEFAULT_CONTEXT_WINDOW, setContextWindow } from "./state.mjs";

/** Native-only probe results never exceed the old fixed window for local servers. */
const LOCAL_NATIVE_CAP = DEFAULT_CONTEXT_WINDOW;
const LOCAL_PROBE_TIMEOUT_MS = 1500;
const CLOUD_PROBE_TIMEOUT_MS = 3000;
const LOCAL_CACHE_TTL_MS = 60_000;   // localhost probes are ~1ms; short TTL notices model reloads
const CLOUD_CACHE_TTL_MS = 3_600_000; // 1h — saves a network round-trip per message

// ── Name table (known cloud models, 2026-07 snapshot) ───────
// Order matters: first match wins, so keep specific versions before family
// prefixes. Probe results override these when the provider reports a value.
/** @type {Array<[RegExp, number]>} */
const NAME_RULES = [
  [/gemini-3\.5-pro/i,                          2_000_000],
  [/gpt-5\.6/i,                                 1_500_000],
  [/gpt-5\.5/i,                                 1_050_000],
  [/deepseek-v4/i,                              1_000_000],
  [/claude-opus-4-8|opus-4\.8/i,                1_000_000],
  [/qwen3\.5-plus/i,                            1_000_000],
  [/minimax-m3/i,                               1_000_000],
  [/kimi-k3/i,                                  1_000_000],
  [/glm-5\.2/i,                                 1_000_000],
  [/gemini-3|gemini-2\.5-pro/i,                 1_000_000],
  [/kimi-k2/i,                                    262_144],
  [/minimax-m2/i,                                 204_800], // sources disagree (200K/262K/1M); conservative, probe corrects
  [/claude-(sonnet|opus|haiku)-4|claude-3/i,      200_000],
  [/glm-5\.1/i,                                   200_000],
  [/deepseek-v3|gpt-4o|gpt-4\.1|glm-4/i,          131_072],
  // Cloud Qwen chat models only ("qwen-plus", "qwen3-max", …). A bare /qwen/
  // would swallow local Ollama names like "qwen3.5:9b" — those must fall
  // through to the local probe instead of inheriting a cloud window size.
  [/qwen[.\d]*-(plus|turbo|max)/i,                131_072],
];

/**
 * Synchronous best-guess from the model name. Returns null for unknown names
 * (local / fine-tuned / brand-new models) — caller falls back or probes.
 * @param {string} [model]
 * @returns {number|null}
 */
export function resolveByName(model) {
  if (!model) return null;
  for (const [rx, window] of NAME_RULES) {
    if (rx.test(model)) return window;
  }
  return null;
}

// ── URL helpers ─────────────────────────────────────────────

/** @param {string} [apiUrl] @returns {boolean} */
export function isLocalUrl(apiUrl) {
  return !!apiUrl && /^(https?:\/\/)?(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/i.test(apiUrl);
}

/**
 * Strip transport suffixes to the server root:
 *   "http://localhost:1234/v1/chat/completions" → "http://localhost:1234"
 *   "http://localhost:1234/v1"                  → "http://localhost:1234"
 * @param {string} apiUrl
 * @returns {string}
 */
function serverRoot(apiUrl) {
  return apiUrl.replace(/\/+$/, "").replace(/\/v1\/chat\/completions$/i, "").replace(/\/v1$/i, "");
}

/**
 * The OpenAI-compatible root (keeps /v1):
 *   "http://host/v1/chat/completions" → "http://host/v1"
 * @param {string} apiUrl
 * @returns {string}
 */
function openAiRoot(apiUrl) {
  return apiUrl.replace(/\/+$/, "").replace(/\/chat\/completions$/i, "");
}

// ── Probe cache ─────────────────────────────────────────────

/** @type {Map<string, { value: number, ts: number, ttl: number, authoritative: boolean }>} */
const _probeCache = new Map();

/**
 * @param {string} key
 * @returns {{ value: number, fresh: boolean, authoritative: boolean } | null}
 */
function cacheGet(key) {
  const hit = _probeCache.get(key);
  if (!hit) return null;
  return { value: hit.value, fresh: Date.now() - hit.ts < hit.ttl, authoritative: hit.authoritative };
}

/**
 * @param {string} key
 * @param {number} value
 * @param {number} ttl
 * @param {boolean} authoritative true for SERVED values (loaded_context_length,
 *   n_ctx), false for native-only caps that may overstate the served window.
 */
function cacheSet(key, value, ttl, authoritative) {
  _probeCache.set(key, { value, ts: Date.now(), ttl, authoritative });
  // Bound the map: probes are keyed per (server, model); a long-lived app
  // could accumulate hundreds of entries at most, but prune anyway.
  if (_probeCache.size > 256) {
    const oldest = _probeCache.keys().next();
    if (!oldest.done) _probeCache.delete(oldest.value);
  }
}

/** Test hook: clear cached probe results. */
export function _clearProbeCache() { _probeCache.clear(); }

// ── Local probes (served value first) ───────────────────────

/**
 * LM Studio native API. `loaded_context_length` is the GUI load-time setting
 * (exactly what the server enforces); `max_context_length` is only the
 * model's native ceiling. If the requested model isn't found but exactly one
 * model is currently loaded, use that one — name typos shouldn't defeat us.
 * @param {string} root server root (no /v1)
 * @param {string} [model]
 * @returns {Promise<{ value: number, authoritative: boolean } | null>}
 */
async function probeLmStudio(root, model) {
  try {
    const res = await fetch(`${root}/api/v0/models`, { signal: AbortSignal.timeout(LOCAL_PROBE_TIMEOUT_MS) });
    if (!res.ok) return null;
    const data = await res.json();
    /** @type {Array<{ id?: string, max_context_length?: number, loaded_context_length?: number|null }>} */
    const models = Array.isArray(data) ? data : (data.data || []);
    const lc = (model || "").toLowerCase();
    let entry = models.find(m => (m.id || "").toLowerCase() === lc);
    if (!entry) {
      const loaded = models.filter(m => Number.isFinite(m.loaded_context_length) && (m.loaded_context_length || 0) > 0);
      if (loaded.length === 1) entry = loaded[0];
    }
    if (!entry) return null;
    if (Number.isFinite(entry.loaded_context_length) && (entry.loaded_context_length || 0) > 0) {
      return { value: /** @type {number} */ (entry.loaded_context_length), authoritative: true };
    }
    if (Number.isFinite(entry.max_context_length) && (entry.max_context_length || 0) > 0) {
      return { value: Math.min(/** @type {number} */ (entry.max_context_length), LOCAL_NATIVE_CAP), authoritative: false };
    }
    return null;
  } catch { return null; }
}

/**
 * llama.cpp server: /props reports the actual -c / --ctx-size the server was
 * started with. Fully authoritative.
 * @param {string} root
 * @returns {Promise<{ value: number, authoritative: boolean } | null>}
 */
async function probeLlamaCpp(root) {
  try {
    const res = await fetch(`${root}/props`, { signal: AbortSignal.timeout(LOCAL_PROBE_TIMEOUT_MS) });
    if (!res.ok) return null;
    const data = await res.json();
    const nCtx = data?.default_generation_settings?.n_ctx;
    if (Number.isFinite(nCtx) && nCtx > 0) return { value: nCtx, authoritative: true };
    return null;
  } catch { return null; }
}

/**
 * Ollama. /api/ps lists running models and newer versions report the served
 * context_length directly. Otherwise fall back to /api/show model_info
 * (architecture-native keys like "llama.context_length") — but that is the
 * model's ceiling, NOT the served num_ctx (which Ollama defaults much lower
 * and doesn't expose), so native results are capped.
 * @param {string} root
 * @param {string} [model]
 * @returns {Promise<{ value: number, authoritative: boolean } | null>}
 */
async function probeOllama(root, model) {
  if (!model) return null;
  try {
    const ps = await fetch(`${root}/api/ps`, { signal: AbortSignal.timeout(LOCAL_PROBE_TIMEOUT_MS) });
    if (ps.ok) {
      const data = await ps.json();
      /** @type {Array<{ name?: string, model?: string, context_length?: number }>} */
      const running = data.models || [];
      const lc = model.toLowerCase();
      const hit = running.find(m => ((m.name || m.model || "").toLowerCase() === lc) && Number.isFinite(m.context_length) && (m.context_length || 0) > 0);
      if (hit) return { value: /** @type {number} */ (hit.context_length), authoritative: true };
    }
  } catch { /* not Ollama or nothing running — try /api/show */ }
  try {
    const res = await fetch(`${root}/api/show`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: model }),
      signal: AbortSignal.timeout(LOCAL_PROBE_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const info = data.model_info || {};
    for (const key of Object.keys(info)) {
      if (key.endsWith(".context_length") && Number.isFinite(info[key]) && info[key] > 0) {
        return { value: Math.min(info[key], LOCAL_NATIVE_CAP), authoritative: false };
      }
    }
    return null;
  } catch { return null; }
}

/**
 * Try the local probes in turn; first hit wins. All are localhost requests
 * (~1ms when the service is up, instant ECONNREFUSED when not).
 * @param {string} apiUrl
 * @param {string} [model]
 * @returns {Promise<{ value: number, authoritative: boolean } | null>}
 */
async function probeLocal(apiUrl, model) {
  const root = serverRoot(apiUrl);
  return (await probeLmStudio(root, model))
      || (await probeLlamaCpp(root))
      || (await probeOllama(root, model));
}

// ── Cloud probe ─────────────────────────────────────────────

/**
 * OpenAI-compatible GET {apiUrl}/models. OpenRouter / Together / OpenCode Go
 * and many proxies include a per-model context size under one of these field
 * names. Anthropic's /v1/models carries no context info — skipped by caller.
 * @param {string} apiUrl
 * @param {string} apiKey
 * @param {string} [model]
 * @returns {Promise<number|null>}
 */
async function probeCloudModels(apiUrl, apiKey, model) {
  if (!model) return null;
  try {
    /** @type {Record<string, string>} */
    const headers = {};
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
    const res = await fetch(`${openAiRoot(apiUrl)}/models`, { headers, signal: AbortSignal.timeout(CLOUD_PROBE_TIMEOUT_MS) });
    if (!res.ok) return null;
    const data = await res.json();
    /** @type {Array<{ id?: string, context_length?: number, max_context_length?: number, context_window?: number }>} */
    const models = data.data || [];
    const lc = model.toLowerCase();
    const entry = models.find(m => (m.id || "").toLowerCase() === lc);
    if (!entry) return null;
    const value = entry.context_length || entry.max_context_length || entry.context_window;
    return Number.isFinite(value) && (value || 0) > 0 ? /** @type {number} */ (value) : null;
  } catch { return null; }
}

// ── Orchestrator ────────────────────────────────────────────

/** @type {number|null} */
let _override = null;

/**
 * Current manual override (null = automatic resolution).
 * @returns {number|null}
 */
export function getContextWindowOverride() { return _override; }

/**
 * Re-resolve CONTEXT_WINDOW for a newly submitted query. Synchronously
 * applies the best known value (override > cached probe > name table >
 * default), then fires a background probe that refines it when the server
 * answers. Fire-and-forget — never blocks the agent loop on a dead server.
 *
 * @param {object} cfg
 * @param {string} [cfg.model]
 * @param {string} [cfg.apiUrl]
 * @param {string} [cfg.apiKey]
 * @param {string} [cfg.apiFormat] "anthropic" skips the cloud probe (no context info in their /v1/models)
 * @param {number|string} [cfg.contextWindowOverride] undefined = keep existing
 *   override (WeChat sync path sends no field); ""/0/null = clear; >=4096 = set.
 */
export function updateContextWindowForModel({ model, apiUrl, apiKey, apiFormat, contextWindowOverride } = {}) {
  if (contextWindowOverride !== undefined) {
    const n = Number(contextWindowOverride);
    _override = Number.isFinite(n) && n >= 4096 ? Math.floor(n) : null;
  }
  if (_override) {
    setContextWindow(_override);
    return;
  }

  const local = isLocalUrl(apiUrl || "");
  const cacheKey = `${serverRoot(apiUrl || "")}|${model || ""}`;
  const cached = apiUrl ? cacheGet(cacheKey) : null;

  // Synchronous best value: fresh cache > name table > stale cache > default.
  const byName = resolveByName(model);
  const syncValue = (cached?.fresh ? cached.value : null) ?? byName ?? cached?.value ?? DEFAULT_CONTEXT_WINDOW;
  setContextWindow(syncValue);

  if (!apiUrl) return;
  if (cached?.fresh) return; // cache warm — skip the network entirely

  // Background refinement. Probe errors are expected (server down, endpoint
  // doesn't exist) and already swallowed inside each probe.
  const probe = local
    ? probeLocal(apiUrl, model).then(hit => {
        if (!hit) return null;
        cacheSet(cacheKey, hit.value, LOCAL_CACHE_TTL_MS, hit.authoritative);
        return hit.value;
      })
    : (apiFormat === "anthropic"
        ? Promise.resolve(null)
        : probeCloudModels(apiUrl, apiKey || "", model).then(value => {
            if (value == null) return null;
            cacheSet(cacheKey, value, CLOUD_CACHE_TTL_MS, true);
            return value;
          }));

  probe.then(value => {
    if (value == null) return;
    // A manual override may have arrived while the probe was in flight.
    if (_override) return;
    setContextWindow(value);
  }).catch(() => { /* probes must never break the agent loop */ });
}
