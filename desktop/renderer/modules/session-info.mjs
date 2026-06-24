// @ts-check — Renderer-side session info snapshot.
//
// Builds a complete snapshot of every user-visible setting stored in
// localStorage, then pushes it to the main process via IPC. The main
// process holds the latest snapshot in `core/session-info.mjs` and
// returns it (merged with file-based config) when the AI calls
// `get_session_info`.
//
// We install a setItem hook so ANY localStorage change to an
// `AideAgent_*` key triggers a fresh push. This is dramatically simpler
// than wiring push into every individual setter (saveApiConfig,
// applyTheme, setLanguage, etc.) and stays correct as new settings are
// added — as long as they're prefixed `AideAgent_`, the hook handles it.

/**
 * Read every AideAgent_* key from localStorage and return a structured
 * snapshot. Pure function — no side effects, no IPC.
 * @returns {object} snapshot
 */
export function getSessionInfoSnapshot() {
  const provider = localStorage.getItem("AideAgent_provider") || "";
  const prefix = provider ? `AideAgent_${provider}_` : "AideAgent_";
  const model = localStorage.getItem(`${prefix}model`) || "";
  const apiUrl = localStorage.getItem(`${prefix}api_url`) || "";
  const apiFormat = localStorage.getItem("AideAgent_api_format") || "openai";
  const runtime = localStorage.getItem("AideAgent_runtime") || "aide";

  let themePreset = null;
  let themeAccent = null;
  try {
    const raw = localStorage.getItem("AideAgent_theme");
    if (raw) {
      const theme = JSON.parse(raw);
      themePreset = theme.preset || null;
      themeAccent = theme.accent || null;
    }
  } catch { /* corrupt JSON — ignore */ }

  let fontWeights = null;
  try {
    const raw = localStorage.getItem("AideAgent_font_weights");
    if (raw) fontWeights = JSON.parse(raw);
  } catch { /* corrupt JSON — ignore */ }

  return {
    runtime,
    api: { provider, model, apiUrl, apiFormat },
    appearance: {
      lang: localStorage.getItem("AideAgent_lang") || "zh",
      theme_preset: themePreset,
      theme_accent: themeAccent,
      font: localStorage.getItem("AideAgent_font") || null,
      font_weights: fontWeights,
    },
    identity: {
      agent_name: localStorage.getItem("AideAgent_name") || "AideAgent",
      user_name: localStorage.getItem("AideAgent_user_name") || null,
      has_user_avatar: !!localStorage.getItem("AideAgent_user_avatar"),
    },
    toggles: {
      reasoning_enabled: localStorage.getItem("AideAgent_reasoning_enabled") === "true",
      search_provider: localStorage.getItem("AideAgent_search_provider") || null,
    },
  };
}

/**
 * Push the current snapshot to the main process. No-op if the IPC
 * bridge isn't available (e.g. during early init before preload is
 * attached, or in tests).
 */
export function pushSessionInfo() {
  if (typeof window === "undefined") return;
  if (!window.aideagent || typeof window.aideagent.sessionInfoUpdate !== "function") return;
  try {
    window.aideagent.sessionInfoUpdate(getSessionInfoSnapshot());
  } catch (e) {
    // Don't crash the renderer if IPC is temporarily unavailable.
    console.warn("[session-info] push failed:", e?.message || e);
  }
}

/**
 * Wrap `localStorage.setItem` so any write to an `AideAgent_*` key
 * triggers a fresh `pushSessionInfo()`. Idempotent — safe to call
 * multiple times (re-wrapping is a no-op).
 *
 * Strategy: keep a reference to the original setItem and call it
 * first, then push. The push is microtask-deferred so synchronous
 * bulk writes (e.g. saveApiConfig writing 3 keys back-to-back) result
 * in only ONE push, not three.
 */
export function installLocalStorageHook() {
  if (typeof window === "undefined") return;
  if (window.__aideagentSessionInfoHookInstalled) return;
  window.__aideagentSessionInfoHookInstalled = true;

  const storage = window.localStorage;
  if (!storage) return;

  const origSetItem = storage.setItem.bind(storage);
  let pendingPush = false;
  let pushScheduled = false;

  const schedulePush = () => {
    if (pendingPush) return;
    pendingPush = true;
    if (pushScheduled) return;
    pushScheduled = true;
    // Microtask: collapse multiple synchronous setItem calls into one
    // push at the end of the current task.
    queueMicrotask(() => {
      pushScheduled = false;
      if (!pendingPush) return;
      pendingPush = false;
      pushSessionInfo();
    });
  };

  storage.setItem = function patchedSetItem(key, value) {
    origSetItem(key, value);
    if (typeof key === "string" && key.startsWith("AideAgent_")) {
      schedulePush();
    }
  };
}