// @ts-check — Runtime selector: AideAgent vs OpenCode.
//
// Owns:
//   - the two runtime cards on the welcome screen
//   - swapping the bottom input box between #input-wrapper (aide) and
//     #input-wrapper-opencode (opencode)
//   - detecting the local opencode CLI and reflecting status on its card
//   - persisting the active runtime (localStorage for now; session-level
//     binding is wired through query:submit and sessionDb.saveSession)
//
// This module is UI shell + detection only. The actual OpenCode/Acp client
// is a separate concern (main process). When runtime === "opencode" we still
// route through the existing query:submit IPC; the main process decides how
// to run it. For the skeleton, opencode selection is accepted but the query
// path falls back to the AideAgent agentLoop until the ACP client lands.

/** @typedef {"aide" | "opencode"} Runtime */

const RUNTIME_KEY = "AideAgent_runtime";
const OPENCODE_DOCS_URL = "https://opencode.ai/docs";

/** @returns {Runtime} */
export function loadRuntime() {
  const v = localStorage.getItem(RUNTIME_KEY);
  return v === "opencode" ? "opencode" : "aide";
}

/** @param {Runtime} rt */
export function saveRuntime(rt) {
  localStorage.setItem(RUNTIME_KEY, rt);
}

/**
 * Module-level single source of truth for the active runtime.
 *
 * DOM (input wrapper visibility, card `.active` class) and localStorage are
 * reflections of this variable, not the other way around. `getCurrentRuntime`
 * previously read DOM class state, which silently diverged from localStorage
 * during the install-guide flow (DOM=opencode while localStorage=aide after
 * a detection-driven fallback). Reading from a closure variable eliminates
 * the split.
 */
/** @type {Runtime} */
let _currentRuntime = loadRuntime();

/** @returns {Runtime} current active runtime */
export function getCurrentRuntime() {
  return _currentRuntime;
}

/** @returns {{ installed: boolean, path: string|null, version: string|null, available: boolean } | null} */
let _opencodeStatus = null;

// Set when the user clicks the opencode card BEFORE initial detection
// resolves. We can't decide if opencode is "available" yet, so we remember
// the intent and honor it as soon as detection completes (if available).
// Without this, a fast click during the ~hundreds-of-ms detection window
// would falsely trigger the install-guide popup.
let _pendingOpencodeRequest = false;
// Snapshot of the runtime the user actually wants at click time. Compared
// against _currentRuntime in the post-detection callback so intervening
// clicks (e.g. rapid aide → opencode → aide → opencode during detection)
// don't make us act on stale intent.
let _pendingRuntimeIntent = /** @type {Runtime} */ ("aide");

/**
 * Reflect detection status into the OpenCode card badge + disabled state.
 * @param {{ installed: boolean, path: string|null, version: string|null, available: boolean, reason?: string } | null} st
 */
function applyOpencodeStatus(st) {
  _opencodeStatus = st;
  const badge = document.getElementById("opencode-status-badge");
  const card = document.querySelector('.runtime-choice[data-runtime="opencode"]');
  if (!badge || !card) return;

  badge.classList.remove("ok", "missing", "detecting");
  if (!st || !st.installed) {
    badge.classList.add("missing");
    badge.textContent = t("runtime.not_installed");
    card.setAttribute("data-available", "false");
  } else if (!st.available) {
    badge.classList.add("missing");
    badge.textContent = t("runtime.version_bad");
    card.setAttribute("data-available", "false");
  } else {
    badge.classList.add("ok");
    // Use a `v` prefix for the version (universal across zh/en) instead of
    // a CJK middle dot which looks out of place in English UIs.
    badge.textContent = st.version ? `${t("runtime.detected")} v${st.version}` : t("runtime.detected");
    card.setAttribute("data-available", "true");
  }
}

async function detectOpencode() {
  const badge = document.getElementById("opencode-status-badge");
  if (badge) {
    badge.classList.remove("ok", "missing");
    badge.classList.add("detecting");
    badge.textContent = t("runtime.detecting");
  }
  try {
    // @ts-expect-error — exposed via preload as window.aideagent.detectOpencode
    const st = await window.aideagent.detectOpencode();
    applyOpencodeStatus(st);
  } catch (/** @type {any} */ e) {
    console.error("[runtime] detectOpencode failed:", e.message);
    applyOpencodeStatus({ installed: false, path: null, version: null, available: false });
  }
}

/**
 * Show the install-guide modal when the user picks OpenCode but it's not
 * available. Uses a dedicated #opencode-install-modal (not the ask/confirm
 * modals) so the AskUserQuestion flow stays unaffected.
 *
 * When the detector returns `triedPaths`, we surface them in a collapsible
 * "搜索路径" section so users can see exactly where we looked — useful when
 * they have opencode installed but the binary isn't where we expect it.
 */
function showOpencodeInstallGuide() {
  const modal = document.getElementById("opencode-install-modal");
  const docsBtn = document.getElementById("opencode-install-docs");
  const redetectBtn = document.getElementById("opencode-install-redetect");
  if (!modal || !docsBtn || !redetectBtn) return;

  // Populate the "searched paths" debug list (idempotent — runs every time the
  // modal opens, replaces any previous content).
  const debugList = document.getElementById("opencode-install-tried-paths");
  if (debugList) {
    const paths = (_opencodeStatus && /** @type {any} */ (_opencodeStatus).triedPaths) || [];
    if (paths.length === 0) {
      debugList.textContent = t("runtime.opencode.no_paths_searched");
    } else {
      // Plain <pre> keeps path strings readable; user can copy to clipboard.
      debugList.textContent = paths.join("\n");
    }
  }

  modal.classList.add("active");

  const cleanup = () => {
    modal.classList.remove("active");
    docsBtn.removeEventListener("click", onDocs);
    redetectBtn.removeEventListener("click", onRedetect);
  };
  const onDocs = () => {
    // @ts-expect-error — shell.openExternal is exposed via preload
    if (window.aideagent?.openExternal) window.aideagent.openExternal(OPENCODE_DOCS_URL);
    cleanup();
  };
  const onRedetect = async () => {
    cleanup();
    await detectOpencode();
    // After re-detection, if opencode is now available, honor the user's
    // earlier click (stored in _pendingOpencodeRequest) and actually switch.
    if (_pendingOpencodeRequest && _opencodeStatus?.available) {
      _pendingOpencodeRequest = false;
      _applyRuntimeSwitch("opencode");
    }
  };
  docsBtn.addEventListener("click", onDocs);
  redetectBtn.addEventListener("click", onRedetect);
}

/**
 * Switch which input box is visible at the bottom of the chat area.
 * @param {Runtime} rt
 */
function switchInputBox(rt) {
  const aide = document.getElementById("input-wrapper");
  const oc = document.getElementById("input-wrapper-opencode");
  if (aide) aide.classList.toggle("hidden", rt !== "aide");
  if (oc) oc.classList.toggle("hidden", rt !== "opencode");
  // Mirror the current model name into the opencode info bar so the user can
  // see which model is in use even when the opencode input wrapper is shown.
  // Falls back to the hardcoded "OpenCode" placeholder if no model is set.
  if (rt === "opencode") {
    const modelEl = document.getElementById("opencode-model-name");
    if (modelEl) {
      const cfg = loadApiConfig();
      modelEl.textContent = cfg.model || "OpenCode";
    }
  }
}

/**
 * Read the current API config (model + provider) from localStorage. The
 * opencode info bar mirrors the model field so users see what's actually
 * being called when runtime=opencode.
 */
function loadApiConfig() {
  try {
    return {
      provider: localStorage.getItem("AideAgent_provider") || "",
      model: localStorage.getItem("AideAgent_model") || "",
      apiUrl: localStorage.getItem("AideAgent_api_url") || "",
    };
  } catch { return { provider: "", model: "", apiUrl: "" }; }
}

/**
 * Set the active runtime. Called by card click or by session restore.
 * @param {Runtime} rt
 * @param {boolean} [persist=true]
 * @param {boolean} [allowUnavailable=false] when true (session restore), skip
 *   the install-guide popup and force the switch even if opencode isn't
 *   detected — the user already had an opencode session, don't nag them.
 */
/**
 * Apply the runtime switch visually (card + input box + persistence).
 * No availability check — call this only after you've verified the runtime
 * is selectable (or that allowUnavailable is set).
 * @param {Runtime} rt
 * @param {boolean} [persist=true]
 */
function _applyRuntimeSwitch(rt, persist = true) {
  _currentRuntime = rt;
  setActiveCard(rt);
  switchInputBox(rt);
  if (persist) saveRuntime(rt);
  // Trigger the model picker refresh whenever the user lands on OpenCode.
  // refreshOpencodeModels is defined in app.js and is idempotent — safe to
  // call on every switch (including aide→opencode and opencode→aide).
  if (rt === "opencode" && typeof window.__refreshOpencodeModels === "function") {
    window.__refreshOpencodeModels();
  }
}

/**
 * Set the active runtime. Called by card click or by session restore.
 * @param {Runtime} rt
 * @param {boolean} [persist=true]
 * @param {boolean} [allowUnavailable=false] when true (session restore), skip
 *   the install-guide popup and force the switch even if opencode isn't
 *   detected — the user already had an opencode session, don't nag them.
 */
export function setRuntime(rt, persist = true, allowUnavailable = false) {
  if (rt !== "opencode") {
    _pendingOpencodeRequest = false;
    _applyRuntimeSwitch(rt, persist);
    return;
  }

  // opencode requested. Three cases:
  if (allowUnavailable) {
    // Session restore — honor the persisted runtime regardless of detection.
    _pendingOpencodeRequest = false;
    _applyRuntimeSwitch(rt, persist);
    return;
  }

  if (_opencodeStatus && _opencodeStatus.available) {
    // Detected + usable — switch immediately.
    _pendingOpencodeRequest = false;
    _applyRuntimeSwitch(rt, persist);
    return;
  }

  if (_opencodeStatus && !_opencodeStatus.available) {
    // Detected + confirmed unavailable — show the install guide, but ONLY if
    // the user is actually requesting opencode (not just sitting on it from a
    // session restore). A stale `_pendingOpencodeRequest=true` from a prior
    // click shouldn't gate the current request, but it shouldn't override
    // either — defer to the current intent (`rt`).
    if (rt === "opencode") {
      showOpencodeInstallGuide();
      setActiveCard("aide");
      switchInputBox("aide");
      if (persist) saveRuntime("aide");
    }
    return;
  }

  // Detection hasn't completed yet (`_opencodeStatus === null`). Don't
  // bounce the user back to aide — remember the click, switch the visuals
  // to opencode optimistically, and let `detectOpencode().then(...)` in
  // initRuntimeSelector (or the re-detect button) finalize the decision.
  // Snapshot the user's click intent (the runtime they want NOW) so the
  // post-detection callback can compare against the *current* state instead
  // of a flag that may have been flipped by intervening clicks.
  _pendingOpencodeRequest = true;
  _pendingRuntimeIntent = rt;
  _applyRuntimeSwitch(rt, persist);
}

/** @param {Runtime} rt */
function setActiveCard(rt) {
  document.querySelectorAll(".runtime-choice").forEach((el) => {
    const match = el.getAttribute("data-runtime") === rt;
    el.classList.toggle("active", match);
    el.setAttribute("aria-selected", match ? "true" : "false");
  });
}

/**
 * Wire up card clicks and re-apply visual state from the current cached
 * values. Cheap and idempotent — safe to call every time the welcome
 * screen is rebuilt (showWelcome replaces messageList.innerHTML, which
 * destroys the previously-bound card elements + listeners + badge).
 *
 * Does NOT trigger a fresh opencode detection — that should only happen
 * once at app init (or via the install-guide "Re-detect" button). We
 * re-apply the cached `_opencodeStatus` to the new badge element instead.
 */
export function rebindRuntimeCards() {
  const cards = document.querySelectorAll(".runtime-choice");
  cards.forEach((card) => {
    card.addEventListener("click", () => {
      const rt = /** @type {Runtime} */ (card.getAttribute("data-runtime") || "aide");
      setRuntime(rt);
    });
  });
  setActiveCard(_currentRuntime);
  switchInputBox(_currentRuntime);
  if (_opencodeStatus) applyOpencodeStatus(_opencodeStatus);
}

/**
 * Wire up card clicks + run initial detection. Called once at app init.
 * On subsequent showWelcome() calls (new conversation, session switch,
 * etc.) call rebindRuntimeCards() instead — it re-binds without paying
 * the cost of another `opencode --version` subprocess.
 */
export function initRuntimeSelector() {
  rebindRuntimeCards();

  // Kick off detection (async, non-blocking). Only at app init.
  detectOpencode().then(() => {
    // Two cases to handle after the first detection completes:
    // 1) User clicked opencode while detection was in flight AND their last
    //    intent is still opencode — finalize: if available, keep opencode;
    //    if not, revert + guide. Comparing _currentRuntime (the latest
    //    module-level state) against _pendingRuntimeIntent protects against
    //    rapid intervening clicks that would otherwise let a stale request
    //    hijack the decision.
    if (_pendingOpencodeRequest && _currentRuntime === _pendingRuntimeIntent) {
      _pendingOpencodeRequest = false;
      if (!(_opencodeStatus && _opencodeStatus.available)) {
        setActiveCard("aide");
        switchInputBox("aide");
        saveRuntime("aide");
        showOpencodeInstallGuide();
      }
      return;
    }
    // Reset pending state regardless — detection has now resolved.
    _pendingOpencodeRequest = false;
    // 2) App restored a saved=opencode session on startup but the CLI is
    //    not actually installed — fall back to aide AND tell the user, so
    //    they're not confused about why their input wrapper switched.
    if (loadRuntime() === "opencode" && (!_opencodeStatus || !_opencodeStatus.available)) {
      setActiveCard("aide");
      switchInputBox("aide");
      saveRuntime("aide");
      showRuntimeFallbackToast(_opencodeStatus?.reason);
    }
  });
}

/**
 * Transient toast shown when we silently fall back from opencode to aide on
 * startup. Distinct from the install-guide modal — that's for an *active*
 * click that we can interrupt; this is for a restore-then-detect-fail that
 * the user didn't trigger explicitly.
 * @param {string|undefined} reason
 */
function showRuntimeFallbackToast(reason) {
  const message = reason === "version_unreadable"
    ? t("runtime.opencode.fallback_version_bad")
    : t("runtime.opencode.fallback_not_installed");
  const toast = document.createElement("div");
  toast.className = "runtime-fallback-toast";
  toast.setAttribute("role", "status");
  toast.setAttribute("aria-live", "polite");
  toast.textContent = message;
  // Inline styles to keep this self-contained — no CSS file edit needed.
  toast.style.cssText = `
    position: fixed; top: 16px; right: 16px; z-index: 9999;
    max-width: 360px;
    background: var(--bg-secondary, #1a1a1f);
    border: 1px solid var(--border, #333);
    border-left: 3px solid #ffaa00;
    border-radius: 8px;
    padding: 10px 14px;
    font-size: 13px;
    color: var(--text-primary, #eee);
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
    opacity: 0;
    transition: opacity 0.2s ease-out;
  `;
  document.body.appendChild(toast);
  // Fade in next frame so the transition fires.
  requestAnimationFrame(() => { toast.style.opacity = "1"; });
  setTimeout(() => {
    toast.style.opacity = "0";
    setTimeout(() => toast.remove(), 250);
  }, 6000);
}
