/**
 * Embedding provider: local MiniLM-L6 or Ollama.
 *
 * Owns the singleton embedder state and exposes `embedText()` for callers
 * (search, reindex, createNote, etc.). Also auto-detects embedding
 * dimension and Ollama model context length, writing them back to the
 * config module.
 *
 * Re-exported from knowledge-store.mjs for backward compatibility.
 */

import { existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "node:url";
import { getConfig, _setAutoDetectedMaxBodyChars } from "./config.mjs";
import { _logError } from "./log.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));

let _embeddingDim = 384; // Auto-detected at runtime from the actual embedding model
/** @type {any} */
let _embedder = null;
let _embedderReady = false;

// Dynamic import with timeout — prevents hanging if native modules can't load
// (e.g. onnxruntime-node inside an Electron asar archive)
/** @param {string} moduleSpecifier @param {number} [timeoutMs] @returns {Promise<any>} */
async function importWithTimeout(moduleSpecifier, timeoutMs = 15000) {
  const result = await Promise.race([
    import(moduleSpecifier),
    new Promise((_, reject) => setTimeout(() => reject(new Error(`Import timed out after ${timeoutMs}ms`)), timeoutMs)),
  ]);
  return result;
}

async function getEmbedder() {
  if (_embedderReady) return _embedder;

  const provider = getConfig().embeddingProvider || "local";

  // Build provider try-order: configured provider first, then fallbacks
  // IMPORTANT: If user explicitly chose "ollama", do NOT fall back to "local"
  // (local can hang in packaged asar builds due to onnxruntime-node native module loading)
  const providers = provider === "ollama"
    ? ["ollama"]
    : [provider, "ollama", "local"].filter((v, i, a) => a.indexOf(v) === i);

  for (const p of providers) {
    if (p === "local") {
      // [PACKAGING-FIX] — isElectron declared OUTSIDE try so finally can access it
      const isElectron = process.release?.name === "electron";
      if (isElectron) {
        console.log("[kb] Electron detected, release.name before patch:", process.release.name);
        try { Object.defineProperty(process.release, "name", { value: "node", configurable: true }); } catch (/** @type {any} */ e) {
          console.log("[kb] Failed to patch process.release.name:", e.message);
        }
        console.log("[kb] release.name after patch:", process.release.name);
      }
      try {

        console.log("[kb] Attempting to import @huggingface/transformers...");
        const { pipeline } = await importWithTimeout("@huggingface/transformers", 15000);
        console.log("[kb] Import succeeded");
        const localPath = getLocalModelPath();
        _embedder = localPath
          ? await pipeline("feature-extraction", localPath, { local_files_only: true })
          : await pipeline("feature-extraction", "Xenova/all-MiniLM-L6-v2");
        _embedderReady = true;
        console.log("[kb] Using local MiniLM-L6 embedder" + (localPath ? " (bundled)" : " (downloaded)"));
        return _embedder;
      } catch (/** @type {any} */ e) {
        console.log("[kb] Local embedder unavailable:", e.message);
      } finally {
        // Restore original release name to avoid side effects
        if (isElectron) {
          try { Object.defineProperty(process.release, "name", { value: "electron", configurable: true }); } catch (/** @type {any} */ e) { _logError("fs", e); }
        }
      }
    }

    if (p === "ollama") {
      try {
        const ollamaModel = getConfig().ollamaEmbedModel || "nomic-embed-text";

        // Probe 1: detect native dimension (no dimensions param)
        const probe1 = await fetch("http://localhost:11434/api/embed", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ model: ollamaModel, input: "test", options: { num_gpu: 99 } }),
          signal: AbortSignal.timeout(5000),
        });
        if (!probe1.ok) throw new Error("Ollama probe1 failed");
        const p1data = await probe1.json();
        const p1vec = p1data.embeddings?.[0];
        if (!p1vec) throw new Error("Ollama returned no embedding");

        const nativeDim = p1vec.length;

        // Probe 2: if native > 384, test whether model supports MRL (dimensions param)
        if (nativeDim > 384) {
          try {
            const probe2 = await fetch("http://localhost:11434/api/embed", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ model: ollamaModel, input: "test", dimensions: 384, options: { num_gpu: 99 } }),
              signal: AbortSignal.timeout(5000),
            });
            if (probe2.ok) {
              const p2data = await probe2.json();
              const p2vec = p2data.embeddings?.[0];
              _embeddingDim = (p2vec && p2vec.length === 384) ? 384 : nativeDim;
            } else {
              _embeddingDim = nativeDim;
            }
          } catch {
            _embeddingDim = nativeDim;
          }
        }

        console.log(`[kb] Embedding dim: ${_embeddingDim} (native: ${nativeDim})${_embeddingDim < nativeDim ? ' via MRL' : _embeddingDim === 384 ? '' : ' (native >384, full dim stored)'}`);

        _embedder = { type: "ollama", model: ollamaModel };
        _embedderReady = true;
        console.log("[kb] Using Ollama embedder:", ollamaModel);
        // Auto-detect model context length (only if user hasn't overridden)
        if (getConfig().maxBodyChars === 0) {
          const ctx = await detectModelContext(ollamaModel);
          // 85% of context to leave tokenization headroom; assumes ~1.2 tok/char
          const auto = Math.floor(ctx * 0.85);
          _setAutoDetectedMaxBodyChars(auto);
          console.log(`[kb] Auto-detected max body chars: ${auto} (model context: ${ctx})`);
        }
        return _embedder;
      } catch (/** @type {any} */ e) {
        // Probe failure is expected (Ollama may not be running) and the
        // outer loop will try the next provider. Logged at debug level.
        _logError("embed", e);
      }
    }

  }

  console.log("[kb] No embedder available, vector search disabled");
  return null;
}

function getLocalModelPath() {
  // In packaged app, extraResources land in process.resourcesPath
  const prodPath = join(process.resourcesPath || "", "models", "all-MiniLM-L6-v2");
  if (existsSync(join(prodPath, "config.json"))) return prodPath;

  // In dev, models are stored relative to this file: desktop/models/
  const devPath = join(__dirname, "..", "models", "all-MiniLM-L6-v2");
  if (existsSync(join(devPath, "config.json"))) return devPath;

  return null;
}

// Query Ollama /api/show for the model's actual context length
// Different model architectures use different keys: bert.context_length, qwen2.context_length, llama.context_length
/** @param {string} modelName @returns {Promise<number>} */
async function detectModelContext(modelName) {
  try {
    const res = await fetch("http://localhost:11434/api/show", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: modelName }),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return 2048;
    const data = await res.json();
    return data.model_info?.["bert.context_length"]
        || data.model_info?.["nomic-bert.context_length"]
        || data.model_info?.["qwen2.context_length"]
        || data.model_info?.["qwen3.context_length"]
        || data.model_info?.["llama.context_length"]
        || 2048;
  } catch { return 2048; }
}

/** @param {string} text @returns {Promise<Float32Array|null>} */
export async function embedText(text) {
  const embedder = await getEmbedder();
  if (!embedder) return null;

  try {
    if (embedder.type === "ollama") {
      const res = await fetch("http://localhost:11434/api/embed", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(_embeddingDim === 384
          ? { model: _embedder.model, input: text, dimensions: 384, options: { num_gpu: 99 } }
          : { model: _embedder.model, input: text, options: { num_gpu: 99 } }),
        signal: AbortSignal.timeout(30000),
      });
      if (!res.ok) return null;
      const data = await res.json();
      const vec = data.embeddings?.[0];
      if (!vec) return null;
      const result = new Float32Array(_embeddingDim);
      for (let i = 0; i < Math.min(vec.length, _embeddingDim); i++) result[i] = vec[i];
      return result;
    }

    // Local HuggingFace transformer
    const output = await embedder(text, { pooling: "mean", normalize: true });
    const vec = output.data;
    // Auto-detect dimension on first local HF call
    if (vec.length !== _embeddingDim) {
      _embeddingDim = vec.length;
      console.log(`[kb] Local embedder dim: ${_embeddingDim}`);
    }
    const result = new Float32Array(_embeddingDim);
    for (let i = 0; i < Math.min(vec.length, _embeddingDim); i++) result[i] = vec[i];
    return result;
  } catch (/** @type {any} */ e) {
    console.error("[kb] Embed failed:", e.message);
    return null;
  }
}

/** Whether the embedder is initialized and ready. */
export function isEmbedderReady() {
  return _embedderReady;
}

/** Get the current embedding dimension (auto-detected at first call). */
export function getEmbeddingDim() {
  return _embeddingDim;
}
