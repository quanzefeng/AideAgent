// @ts-check — JSDoc-typed prompts settings panel (list + edit modal).
// Layout modeled after 豆包's "自定义技能": clean list rows, editing
// happens in a modal (not inline) to avoid the cramped two-pane layout.
let _promptsPanelLoaded = false;
/** @type {Array<{ id: string, title: string, body: string, created: string, updated: string, filename: string, mtimeMs: number }>} */
let _promptsListCache = [];
/** @type {string | null} — currently editing prompt's id, or null for "new" */
let _promptsEditingId = null;

export async function loadPromptsPanel() {
  if (_promptsPanelLoaded) return;
  _promptsPanelLoaded = true;

  const listEl = document.getElementById("prompts-list");
  const searchInput = /** @type {HTMLInputElement | null} */ (document.getElementById("prompts-search-input"));
  const newBtn = /** @type {HTMLButtonElement | null} */ (document.getElementById("prompts-new-btn"));

  // Modal elements
  const overlay = /** @type {HTMLElement | null} */ (document.getElementById("prompts-edit-overlay"));
  const modalTitle = document.getElementById("prompts-edit-title");
  const titleInput = /** @type {HTMLInputElement | null} */ (document.getElementById("prompts-edit-title-input"));
  const titleCounter = document.getElementById("prompts-edit-title-counter");
  const bodyTextarea = /** @type {HTMLTextAreaElement | null} */ (document.getElementById("prompts-edit-body-input"));
  const statusEl = document.getElementById("prompts-edit-status");
  const closeBtn = document.getElementById("prompts-edit-close");
  const cancelBtn = document.getElementById("prompts-edit-cancel");
  const saveBtn = document.getElementById("prompts-edit-save");

  /** @param {string} [filter] */
  async function refreshList(filter = "") {
    try {
      _promptsListCache = await window.aideagent.promptsList();
    } catch {
      _promptsListCache = [];
    }
    const filtered = filter
      ? _promptsListCache.filter(
          (p) =>
            (p.title || "").includes(filter) ||
            (p.body || "").includes(filter) ||
            (p.id || "").includes(filter)
        )
      : _promptsListCache;

    if (!listEl) return;
    listEl.innerHTML = filtered.length === 0
      ? `<div class="prompts-list-empty">
           ${t("prompts.empty")}
           <div class="prompts-list-empty-hint">${t("prompts.empty_hint_panel")}</div>
         </div>`
      : filtered
          .map((p) => {
            const titleHtml = (p.title || "").replace(/</g, "&lt;");
            return `<div class="prompts-row" data-id="${p.id}">
              <span class="prompts-row-drag" title="拖动排序"></span>
              <span class="prompts-row-heart" data-action="heart" title="收藏"></span>
              <span class="prompts-row-title" data-action="edit">${titleHtml}</span>
              <span class="prompts-row-actions">
                <button class="prompts-row-action" data-action="edit" title="编辑">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>
                </button>
                <button class="prompts-row-action danger" data-action="delete" title="删除">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>
                </button>
              </span>
            </div>`;
          })
          .join("");

    // Wire up row actions
    listEl.querySelectorAll(".prompts-row").forEach((node) => {
      const row = /** @type {HTMLElement} */ (node);
      const id = row.dataset.id;
      if (!id) return;
      row.querySelector('[data-action="edit"]')?.addEventListener("click", (e) => {
        e.stopPropagation();
        openEditModal(id);
      });
      row.querySelector('[data-action="delete"]')?.addEventListener("click", (e) => {
        e.stopPropagation();
        deletePromptById(id);
      });
    });
  }

  /** @param {string} id */
  async function openEditModal(id) {
    _promptsEditingId = id;
    if (statusEl) {
      statusEl.textContent = "";
      statusEl.className = "prompts-edit-status";
    }
    if (modalTitle) modalTitle.textContent = t("prompts.modal_title_edit");

    let prompt = null;
    try { prompt = await window.aideagent.promptsRead(id); } catch { /* ignored */ }
    if (!prompt) {
      // Prompt was deleted underneath us — just close.
      closeEditModal();
      return;
    }
    if (titleInput) titleInput.value = prompt.title || "";
    if (bodyTextarea) bodyTextarea.value = prompt.body || "";
    updateTitleCounter();
    if (overlay) overlay.classList.remove("hidden");
    setTimeout(() => titleInput?.focus(), 0);
  }

  function openNewModal() {
    _promptsEditingId = null;
    if (statusEl) {
      statusEl.textContent = "";
      statusEl.className = "prompts-edit-status";
    }
    if (modalTitle) modalTitle.textContent = t("prompts.modal_title_new");
    if (titleInput) titleInput.value = "";
    if (bodyTextarea) bodyTextarea.value = "";
    updateTitleCounter();
    if (overlay) overlay.classList.remove("hidden");
    setTimeout(() => titleInput?.focus(), 0);
  }

  function closeEditModal() {
    if (overlay) overlay.classList.add("hidden");
    _promptsEditingId = null;
  }

  function updateTitleCounter() {
    if (!titleInput || !titleCounter) return;
    const len = titleInput.value.length;
    titleCounter.textContent = `${len}/100`;
    titleCounter.style.color = len > 90 ? "#ef4444" : "";
  }

  async function saveFromModal() {
    const title = (titleInput?.value || "").trim();
    const body = bodyTextarea?.value || "";
    if (!title) {
      if (statusEl) {
        statusEl.textContent = t("prompts.title_required");
        statusEl.className = "prompts-edit-status error";
      }
      titleInput?.focus();
      return;
    }
    if (!body.trim()) {
      if (statusEl) {
        statusEl.textContent = t("prompts.body_required");
        statusEl.className = "prompts-edit-status error";
      }
      bodyTextarea?.focus();
      return;
    }

    if (statusEl) {
      statusEl.textContent = t("prompts.saving");
      statusEl.className = "prompts-edit-status";
    }
    if (saveBtn) saveBtn.disabled = true;

    try {
      let result;
      if (_promptsEditingId) {
        result = await window.aideagent.promptsUpdate(_promptsEditingId, { title, body });
      } else {
        result = await window.aideagent.promptsCreate({ title, body });
      }
      if (!result?.ok) {
        if (statusEl) {
          statusEl.textContent = t("prompts.save_fail").replace("{error}", result?.error || "unknown");
          statusEl.className = "prompts-edit-status error";
        }
        return;
      }
      // Success — close modal and refresh list
      closeEditModal();
      await refreshList(searchInput?.value || "");
    } catch (/** @type {any} */ e) {
      if (statusEl) {
        statusEl.textContent = t("prompts.save_fail").replace("{error}", e?.message || String(e));
        statusEl.className = "prompts-edit-status error";
      }
    } finally {
      if (saveBtn) saveBtn.disabled = false;
    }
  }

  /** @param {string} id */
  async function deletePromptById(id) {
    const current = _promptsListCache.find((p) => p.id === id);
    const name = current?.title || id;
    if (!confirm(t("prompts.delete_confirm").replace("{name}", name))) return;
    try {
      await window.aideagent.promptsDelete(id);
      await refreshList(searchInput?.value || "");
    } catch (/** @type {any} */ e) {
      alert(t("prompts.delete_fail").replace("{error}", e?.message || String(e)));
    }
  }

  // Wire up events
  newBtn?.addEventListener("click", openNewModal);
  searchInput?.addEventListener("input", () => refreshList(searchInput.value));
  closeBtn?.addEventListener("click", closeEditModal);
  cancelBtn?.addEventListener("click", closeEditModal);
  saveBtn?.addEventListener("click", saveFromModal);
  titleInput?.addEventListener("input", updateTitleCounter);

  // Close modal on Escape or backdrop click
  overlay?.addEventListener("click", (e) => {
    if (e.target === overlay) closeEditModal();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && overlay && !overlay.classList.contains("hidden")) {
      closeEditModal();
    }
  });

  await refreshList();
}

export function initPromptsPanel() {
  document.querySelector('.settings-tab[data-tab="prompts"]')?.addEventListener("click", loadPromptsPanel);
}