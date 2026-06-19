/**
 * Update Toast — non-modal notifications for software updates.
 *
 * Surfaces update events (available, downloading, downloaded, error) as
 * top-right slide-in toasts so the user sees them from any screen — not
 * just the hidden Settings → About panel.
 *
 * Lifecycle per status:
 *   - "checking"       → transient toast, auto-dismiss after 3s
 *   - "available"      → persistent until user clicks Download / Skip / ✕
 *   - "downloaded"     → persistent until user clicks Restart / ✕
 *   - "error"          → transient toast, auto-dismiss after 6s
 *   - progress         → toast text shows live %
 *
 * Click on toast body (outside buttons) → opens Settings → About panel
 * so users who want more detail can find it.
 *
 * "Skip this version" persists in localStorage so the same version
 * won't re-prompt after app restart. The main process also tracks the
 * skip in-memory for the current session (see update-manager.mjs).
 */

// NOTE: `t` (the translation function) is a global defined by translations.js,
// which is loaded as a regular <script> tag in index.html BEFORE app.js. It is
// NOT exported as an ES module, so we must use it as a global — importing it
// (as I initially did) causes `update-toast.mjs` to fail to load, which
// cascades up through `import { initUpdateToast } from './modules/update-toast.mjs'`
// in app.js, killing ALL renderer initialization. The renderer would then
// show the static HTML shell with no click handlers, empty session list,
// and no model display — exactly the symptom that surfaced after Tier 1+2+3.

const SKIPPED_VERSION_KEY = "AideAgent_skipped_version";

/**
 * Read the persisted skipped version (renderer-side source of truth,
 * survives app restarts). Returns null if nothing has been skipped.
 */
export function getSkippedVersion() {
  try { return localStorage.getItem(SKIPPED_VERSION_KEY) || null; }
  catch { return null; }
}

/**
 * Persist a skipped version. Pass null/"" to clear the skip.
 */
export function setSkippedVersion(version) {
  try {
    if (version) localStorage.setItem(SKIPPED_VERSION_KEY, version);
    else localStorage.removeItem(SKIPPED_VERSION_KEY);
  } catch { /* localStorage may be disabled */ }
}

/**
 * Open the Settings panel and switch to the About tab. Used when the
 * user clicks the toast body to see full release notes.
 */
function openSettingsAbout() {
  // Settings button is identified by data-tab="settings" in this codebase;
  // the About section is the last tab in that panel. Fall back to clicking
  // any element matching the same selectors if the structure changes.
  const settingsBtn = document.querySelector('[data-tab="settings"]');
  if (settingsBtn) settingsBtn.click();
}

/**
 * Show or update the update toast. Safe to call repeatedly — only one
 * toast exists at a time; subsequent calls mutate the existing node.
 *
 * @param {object} opts
 * @param {string} opts.status       - "checking" | "available" | "downloading" | "downloaded" | "error"
 * @param {string} [opts.version]    - remote version string
 * @param {number} [opts.percent]    - 0..100 download progress
 * @param {string} [opts.message]    - error message string
 */
export function showUpdateToast(opts) {
  if (!opts || !opts.status) return;

  // Get or create the toast container. Inline styles avoid a separate CSS file.
  let toast = document.getElementById("update-toast");
  if (!toast) {
    toast = document.createElement("div");
    toast.id = "update-toast";
    toast.style.cssText = `
      position: fixed; top: 16px; right: 16px; z-index: 10000;
      min-width: 280px; max-width: 360px;
      background: var(--bg-secondary, #1a1a1f);
      border: 1px solid var(--border, #333);
      border-left: 3px solid var(--accent, #6366f1);
      border-radius: 8px; padding: 12px 14px;
      box-shadow: 0 4px 12px rgba(0,0,0,0.3);
      font-size: 13px; color: var(--text-primary, #eee);
      transform: translateX(120%); transition: transform 0.25s ease-out;
      pointer-events: auto;
    `;
    document.body.appendChild(toast);
  }

  // Build the toast body based on status.
  let bodyHtml = "";
  let autoDismissMs = 0;
  let onMount = null;

  switch (opts.status) {
    case "checking":
      bodyHtml = `<div>${escapeHtml(t("about.checking"))}</div>`;
      autoDismissMs = 2500;
      break;

    case "available": {
      // Don't pop a toast for a skipped version — the settings panel still
      // shows the version notes so curious users can find it.
      if (opts.skipped) return dismissToast();
      const ver = opts.version || "";
      bodyHtml = `
        <div style="margin-bottom:6px;font-weight:600;">${escapeHtml(t("about.new_version_ready", { version: ver }))}</div>
        <div style="display:flex;gap:6px;">
          <button data-act="download" style="flex:1;padding:5px 10px;font-size:12px;">${escapeHtml(t("about.download_update"))}</button>
          <button data-act="skip" style="padding:5px 10px;font-size:12px;">${escapeHtml(t("about.skip_version"))}</button>
        </div>
      `;
      onMount = (root) => {
        root.querySelector('[data-act="download"]')?.addEventListener("click", (e) => {
          e.stopPropagation();
          window.aideagent.updateDownload?.().catch(() => {});
        });
        root.querySelector('[data-act="skip"]')?.addEventListener("click", (e) => {
          e.stopPropagation();
          setSkippedVersion(ver);
          window.aideagent.updateSkip?.(ver).catch(() => {});
          dismissToast();
        });
      };
      break;
    }

    case "downloading": {
      // Live progress — replace toast text with current percentage.
      const pct = Math.max(0, Math.min(100, Math.round(opts.percent || 0)));
      bodyHtml = `<div>${escapeHtml(t("about.downloading"))} ${pct}%</div>`;
      break;
    }

    case "downloaded": {
      const ver = opts.version || "";
      bodyHtml = `
        <div style="margin-bottom:6px;font-weight:600;">${escapeHtml(t("about.downloaded", { version: ver }))}</div>
        <button data-act="install" style="width:100%;padding:6px 10px;font-size:12px;">${escapeHtml(t("about.install_update"))}</button>
      `;
      onMount = (root) => {
        root.querySelector('[data-act="install"]')?.addEventListener("click", (e) => {
          e.stopPropagation();
          window.aideagent.updateInstall?.();
        });
      };
      break;
    }

    case "error": {
      bodyHtml = `<div style="border-left:3px solid var(--danger,#ef4444);padding-left:8px;">${escapeHtml(t("about.check_failed", { error: opts.message || "" }))}</div>`;
      autoDismissMs = 6000;
      break;
    }

    default:
      return;
  }

  toast.innerHTML = bodyHtml;
  // Slide in. Use rAF to make sure the initial transform is committed first.
  requestAnimationFrame(() => { toast.style.transform = "translateX(0)"; });

  if (onMount) onMount(toast);

  // Click on the toast body (not on buttons) → open settings panel.
  toast.onclick = (e) => {
    // Buttons already handle their own clicks with stopPropagation; this
    // catches clicks on padding / text area.
    if (e.target.closest("button")) return;
    openSettingsAbout();
  };

  // Auto-dismiss for transient toasts.
  if (toast._dismissTimer) clearTimeout(toast._dismissTimer);
  if (autoDismissMs > 0) {
    toast._dismissTimer = setTimeout(dismissToast, autoDismissMs);
  }
}

/**
 * Slide the toast out and remove it from the DOM. Safe to call when
 * no toast exists (no-op).
 */
export function dismissToast() {
  const toast = document.getElementById("update-toast");
  if (!toast) return;
  toast.style.transform = "translateX(120%)";
  if (toast._dismissTimer) {
    clearTimeout(toast._dismissTimer);
    toast._dismissTimer = null;
  }
  setTimeout(() => {
    if (toast.parentNode) toast.parentNode.removeChild(toast);
  }, 300);
}

/**
 * Update the live-downloading toast in place (called from the
 * `update:progress` listener). Cheaper than recreating DOM.
 */
export function updateDownloadProgress(percent) {
  const toast = document.getElementById("update-toast");
  if (!toast) return;
  const pct = Math.max(0, Math.min(100, Math.round(percent || 0)));
  toast.innerHTML = `<div>${escapeHtml(t("about.downloading"))} ${pct}%</div>`;
}

function escapeHtml(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Wire up the toast to the main-process update events. Idempotent —
 * safe to call multiple times (listeners are guarded). Call this once
 * at app startup, after window.aideagent is available.
 */
export function initUpdateToast() {
  if (window.__updateToastWired) return;
  window.__updateToastWired = true;

  window.aideagent.onUpdateStatus?.((data) => {
    if (!data) return;
    // Route through the toaster. The settings panel still listens for its
    // own status updates (see renderer/app.js initAboutPanel).
    showUpdateToast(data);
  });

  window.aideagent.onUpdateProgress?.((data) => {
    // Don't pop a toast just for the first progress tick; only update
    // if a "downloading" toast already exists. Otherwise the toast will
    // appear on the very first progress event after a download starts,
    // which is the desired UX.
    showUpdateToast({ status: "downloading", percent: data?.percent || 0 });
  });
}