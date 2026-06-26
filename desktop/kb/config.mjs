/**
 * Knowledge-base configuration: vault path, embedder settings, query
 * rewriting, rerank, and chunk sizing.
 *
 * Owns the module-level state (_vaultPath, _config, _autoDetectedMaxBodyChars)
 * and the load/save roundtrip with ~/.aideagent/kb-config.json.
 *
 * Pure data + file IO. No DB, no scanning, no embedding.
 *
 * Re-exports of public API are added at the bottom of knowledge-store.mjs
 * for backward compatibility.
 */

import { existsSync, writeFileSync, readFileSync, mkdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";

const HOME = homedir();
export const DATA_DIR = join(HOME, ".aideagent");
export const DB_PATH = join(DATA_DIR, "knowledge.db");
export const CONFIG_PATH = join(DATA_DIR, "kb-config.json");

// Ensure ~/.aideagent exists for any first-run config/DB writes.
if (!existsSync(DATA_DIR)) {
  mkdirSync(DATA_DIR, { recursive: true });
}

// ── Module state ─────────────────────────────────────────

let _vaultPath = "";
/** @type {{embeddingProvider:string, ollamaEmbedModel:string, maxNotes:number, maxChars:number, maxBodyChars:number, queryRewriteModel?:string, queryRewriteEnabled?:boolean, rerankEnabled?:boolean, rerankModel?:string, rerankTopN?:number, enabledFormats?:Record<string,boolean>}} */
let _config = {
  embeddingProvider: "local",
  ollamaEmbedModel: "nomic-embed-text",
  maxNotes: 20,
  maxChars: 20000,
  maxBodyChars: 0,
  queryRewriteModel: "qwen3.5:9b",
  queryRewriteEnabled: true,
  rerankEnabled: true,
  rerankModel: "gemma4:e4b",
  rerankTopN: 15,
  // Per-format enable/disable. Markdown is always ON (enforced in formats.mjs).
  // Defaults match the v1.27 design decision: Office formats ON, data/PDF OFF.
  enabledFormats: {
    docx: true,
    pptx: true,
    csv: false,
    xlsx: false,
    pdf: false,
  },
};
// maxBodyChars: 0 = auto-detect from Ollama model context, >0 = user override
let _autoDetectedMaxBodyChars = 0;

// ── Persistence ──────────────────────────────────────────

export function loadConfig() {
  try {
    const raw = readFileSync(CONFIG_PATH, "utf-8");
    const cfg = JSON.parse(raw);
    _vaultPath = cfg.vaultPath || "";
    _config = { ..._config, ...cfg };
  } catch (/** @type {any} */ e) {
    // Missing/corrupt config file is normal on first run.
    _logError("fs", e);
  }
}

export function saveConfig() {
  try {
    writeFileSync(
      CONFIG_PATH,
      JSON.stringify({ ..._config, vaultPath: _vaultPath }, null, 2),
      "utf-8"
    );
  } catch (/** @type {any} */ e) {
    // Config write failure is non-fatal (settings won't persist this session).
    _logError("fs", e);
  }
}

// ── Public accessors / mutators ──────────────────────────

export function getVault() { return _vaultPath; }

export function getConfig() {
  return { ..._config, vaultPath: _vaultPath };
}

export function setVault(path) {
  if (path !== "" && (typeof path !== "string" || !existsSync(path))) {
    return { error: "path does not exist" };
  }
  _vaultPath = path || "";
  saveConfig();
  return { ok: true, vault: _vaultPath };
}

/** @param {{embeddingProvider?:string, ollamaEmbedModel?:string, maxNotes?:number, maxChars?:number, maxBodyChars?:number, queryRewriteModel?:string, queryRewriteEnabled?:boolean, rerankEnabled?:boolean, rerankModel?:string, rerankTopN?:number, enabledFormats?:Record<string,boolean>}} cfg */
export function setConfig(cfg) {
  if (cfg.embeddingProvider) _config.embeddingProvider = cfg.embeddingProvider;
  if (cfg.ollamaEmbedModel && cfg.ollamaEmbedModel !== _config.ollamaEmbedModel) {
    _config.ollamaEmbedModel = cfg.ollamaEmbedModel;
    // Note: setting _embedderReady is a side-effect on the embedder module.
    // We can't reset it from here without creating a cycle. The embedder
    // module handles its own re-init by comparing model name on each call.
  }
  if (cfg.maxNotes) _config.maxNotes = Math.max(1, Math.min(100, cfg.maxNotes));
  if (cfg.maxChars) _config.maxChars = Math.max(100, Math.min(50000, cfg.maxChars));
  if (cfg.maxBodyChars !== undefined) {
    _config.maxBodyChars = Math.max(0, Math.min(100000, parseInt(String(cfg.maxBodyChars)) || 0));
    // Setting maxBodyChars=0 means "auto-detect from Ollama model". If we
    // previously auto-detected a value, that's now stale (e.g. user switched
    // from a long-context model to a short-context one). Force re-detection.
    if (_config.maxBodyChars === 0) _autoDetectedMaxBodyChars = 0;
  }
  // Clear LLM result caches when the model changes — old outputs are invalid.
  // The actual cache clearing happens in kb/embedder.mjs and kb/search.mjs.
  if (cfg.queryRewriteModel && cfg.queryRewriteModel !== _config.queryRewriteModel) {
    _config.queryRewriteModel = cfg.queryRewriteModel;
  }
  if (cfg.rerankModel && cfg.rerankModel !== _config.rerankModel) {
    _config.rerankModel = cfg.rerankModel;
  }
  if (cfg.queryRewriteEnabled !== undefined) _config.queryRewriteEnabled = Boolean(cfg.queryRewriteEnabled);
  if (cfg.rerankEnabled !== undefined) _config.rerankEnabled = Boolean(cfg.rerankEnabled);
  if (cfg.rerankTopN !== undefined) _config.rerankTopN = Math.max(5, Math.min(50, parseInt(String(cfg.rerankTopN)) || 20));
  // Merge enabledFormats updates — only override keys that are explicitly set,
  // so a partial update (e.g. {docx: false}) doesn't wipe the other toggles.
  if (cfg.enabledFormats && typeof cfg.enabledFormats === "object") {
    _config.enabledFormats = { ..._config.enabledFormats, ...cfg.enabledFormats };
  }
  saveConfig();
  return { ok: true, config: _config };
}

export function getEffectiveMaxBodyChars() {
  if (_config.maxBodyChars > 0) return _config.maxBodyChars;
  if (_autoDetectedMaxBodyChars > 0) return _autoDetectedMaxBodyChars;
  return 1500; // safe fallback before any detection
}

// ── Internal hooks for embedder module ────────────────────

/** Set the auto-detected max body chars. Called by the embedder after probing Ollama. */
export function _setAutoDetectedMaxBodyChars(value) {
  _autoDetectedMaxBodyChars = value;
}

/** Get the current auto-detected max body chars (or 0 if not yet detected). */
export function getAutoDetectedMaxBodyChars() {
  return _autoDetectedMaxBodyChars;
}

// ── Error reporting ──────────────────────────────────────
// Lightweight stub so this module doesn't depend on the error-counters
// module (which would create a cycle). The counters module, when loaded,
// patches this function via _registerLogger.

let _logError = (bucket, err) => {
  // Fallback when error-counters module hasn't registered yet
  const msg = err?.message || String(err);
  console.warn(`[kb] ${bucket} error: ${msg.slice(0, 200)}`);
};

/** Allow other modules to inject a richer logger. */
export function _registerLogger(fn) {
  _logError = fn;
}

// Auto-load on import
loadConfig();
