// @ts-check — JSDoc-typed prompts import modal (Stage 3).
//
// Opened from the input menu's "常用提示词" item. Shows a searchable list
// of saved prompts, with a preview pane and an import button. Importing
// inserts the prompt body at the cursor position in the chat input box,
// preserving any text the user has already typed.
let _modalLoaded = false;
/** @type {Array<{ id: string, title: string, body: string, created: string, updated: string, filename: string, mtimeMs: number }>} */
let _listCache = [];
/** @type {string | null} — currently selected prompt id in the modal */
let _selectedId = null;

/**
 * Insert text at the current cursor position in #prompt-input, preserving
 * any selection / surrounding text. Triggers an `input` event so auto-resize
 * picks up the change.
 * @param {string} text
 */
function insertIntoPromptInput(text) {
  const textarea = /** @type {HTMLTextAreaElement | null} */ (document.getElementById("prompt-input"));
  if (!textarea) return false;

  const start = textarea.selectionStart ?? textarea.value.length;
  const end = textarea.selectionEnd ?? textarea.value.length;
  const before = textarea.value.substring(0, start);
  const after = textarea.value.substring(end);

  textarea.value = before + text + after;

  // Move cursor to end of inserted text
  const newCursorPos = start + text.length;
  textarea.setSelectionRange(newCursorPos, newCursorPos);

  // Trigger auto-resize + char counter updates in app.js
  textarea.dispatchEvent(new Event("input", { bubbles: true }));
  textarea.focus();

  return true;
}

/** Render the prompt list, filtered by the current search input value. */
function renderList() {
  const listEl = document.getElementById("prompts-import-list");
  const searchInput = /** @type {HTMLInputElement | null} */ (document.getElementById("prompts-import-search"));
  if (!listEl) return;

  const filter = (searchInput?.value || "").trim().toLowerCase();
  const filtered = filter
    ? _listCache.filter(
        (p) =>
          (p.title || "").toLowerCase().includes(filter) ||
          (p.body || "").toLowerCase().includes(filter)
      )
    : _listCache;

  if (filtered.length === 0) {
    listEl.innerHTML = `<div class="prompts-import-empty">${t("prompts.import_empty")}</div>`;
    return;
  }

  listEl.innerHTML = filtered
    .map((p) => {
      const titleHtml = (p.title || "").replace(/</g, "&lt;");
      return `<div class="prompts-import-item${_selectedId === p.id ? " active" : ""}" data-id="${p.id}">
        <span class="prompts-row-drag"></span>
        <span class="prompts-row-title">${titleHtml}</span>
      </div>`;
    })
    .join("");

  listEl.querySelectorAll(".prompts-import-item").forEach((node) => {
    const el = /** @type {HTMLElement} */ (node);
    el.addEventListener("click", () => selectPrompt(/** @type {string} */ (el.dataset.id)));
  });
}

/** @param {string} id */
function selectPrompt(id) {
  const p = _listCache.find((x) => x.id === id);
  if (!p) return;
  _selectedId = id;

  // Highlight in list
  const listEl = document.getElementById("prompts-import-list");
  listEl?.querySelectorAll(".prompts-import-item").forEach((el) => {
    el.classList.toggle("active", /** @type {HTMLElement} */ (el).dataset.id === id);
  });

  // Update preview
  const previewTitle = document.getElementById("prompts-import-preview-title");
  const previewBody = /** @type {HTMLTextAreaElement | null} */ (document.getElementById("prompts-import-preview-body"));
  const previewEmpty = document.getElementById("prompts-import-preview-empty");
  const importBtn = /** @type {HTMLButtonElement | null} */ (document.getElementById("prompts-import-confirm"));

  if (previewTitle) previewTitle.textContent = p.title || "(untitled)";
  if (previewBody) previewBody.value = p.body || "";
  if (previewEmpty) previewEmpty.style.display = "none";
  if (importBtn) importBtn.disabled = false;
}

/** One-time wiring of modal-level events (close, ESC, import, search). */
function ensureModalLoaded() {
  if (_modalLoaded) return;
  _modalLoaded = true;

  const overlay = /** @type {HTMLElement | null} */ (document.getElementById("prompts-import-overlay"));
  const importBtn = /** @type {HTMLButtonElement | null} */ (document.getElementById("prompts-import-confirm"));
  const closeBtn = /** @type {HTMLButtonElement | null} */ (document.getElementById("prompts-import-close"));
  const searchInput = /** @type {HTMLInputElement | null} */ (document.getElementById("prompts-import-search"));
  const statusEl = document.getElementById("prompts-import-status");

  if (!overlay || !importBtn || !closeBtn) return;

  function closeModal() {
    overlay?.classList.add("hidden");
    _selectedId = null;
  }

  function importSelected() {
    if (!_selectedId) return;
    const p = _listCache.find((x) => x.id === _selectedId);
    if (!p) return;
    const ok = insertIntoPromptInput(p.body || "");
    if (!ok) {
      if (statusEl) {
        statusEl.textContent = t("prompts.import_failed");
        statusEl.className = "prompts-import-status error";
      }
      return;
    }
    closeModal();
  }

  closeBtn.addEventListener("click", closeModal);
  importBtn.addEventListener("click", importSelected);
  searchInput?.addEventListener("input", () => {
    _selectedId = null;
    renderList();
  });

  // Backdrop click closes
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) closeModal();
  });

  // ESC closes
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && overlay && !overlay.classList.contains("hidden")) {
      closeModal();
    }
  });
}

/**
 * Public entry point. Called from app.js when the user picks "常用提示词"
 * from the input-menu popover. Opens the modal fresh each time so the list
 * always reflects the latest prompts on disk.
 */
export async function openPromptsImportModal() {
  ensureModalLoaded();

  const overlay = document.getElementById("prompts-import-overlay");
  const previewTitle = document.getElementById("prompts-import-preview-title");
  const previewBody = /** @type {HTMLTextAreaElement | null} */ (document.getElementById("prompts-import-preview-body"));
  const previewEmpty = document.getElementById("prompts-import-preview-empty");
  const importBtn = /** @type {HTMLButtonElement | null} */ (document.getElementById("prompts-import-confirm"));
  const statusEl = document.getElementById("prompts-import-status");
  const searchInput = /** @type {HTMLInputElement | null} */ (document.getElementById("prompts-import-search"));

  if (!overlay || !importBtn) return;

  // Reset state for fresh open
  _selectedId = null;
  if (searchInput) searchInput.value = "";
  if (previewTitle) previewTitle.textContent = "";
  if (previewBody) previewBody.value = "";
  if (previewEmpty) previewEmpty.style.display = "";
  importBtn.disabled = true;
  if (statusEl) {
    statusEl.textContent = "";
    statusEl.className = "prompts-import-status";
  }

  // Load list, then show
  try {
    _listCache = await window.aideagent.promptsList();
  } catch {
    _listCache = [];
  }

  renderList();
  overlay.classList.remove("hidden");
}