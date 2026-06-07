// @ts-check — JSDoc-typed memory panel loader.
// @ts-check — 带 JSDoc 类型注解的持久记忆面板加载器。
let _memoryPanelLoaded = false;
/** @type {Array<{filename: string; name: string; description: string; type: string; body: string}>} */
let _memoryListCache = [];
/** @type {string | null} */
let _memoryCurrentFile = null;

export async function loadMemoryPanel() {
  if (_memoryPanelLoaded) return;
  _memoryPanelLoaded = true;

  const TYPE_LABELS = { user: t("memory.label_user"), feedback: t("memory.label_feedback"), project: t("memory.label_project"), reference: t("memory.label_reference") };

  const listEl = document.getElementById("memory-list");
  const searchInput = /** @type {HTMLInputElement | null} */ (document.getElementById("memory-search-input"));
  const nameInput = /** @type {HTMLInputElement | null} */ (document.getElementById("memory-edit-name"));
  const descInput = /** @type {HTMLInputElement | null} */ (document.getElementById("memory-edit-desc"));
  const typeSelect = /** @type {HTMLSelectElement | null} */ (document.getElementById("memory-edit-type"));
  const bodyTextarea = /** @type {HTMLTextAreaElement | null} */ (document.getElementById("memory-edit-body"));
  const saveBtn = /** @type {HTMLButtonElement | null} */ (document.getElementById("memory-save-btn"));
  const deleteBtn = /** @type {HTMLButtonElement | null} */ (document.getElementById("memory-delete-btn"));
  const newBtn = /** @type {HTMLButtonElement | null} */ (document.getElementById("memory-new-btn"));
  const statusEl = document.getElementById("memory-edit-status");

  /**
   * @param {string} [filter]
   */
  async function refreshList(filter = "") {
    try {
      _memoryListCache = await window.aideagent.memoryListAll();
    } catch {
      _memoryListCache = [];
    }
    const filtered = filter
      ? _memoryListCache.filter(m => m.name.includes(filter) || m.description.includes(filter) || m.filename.includes(filter))
      : _memoryListCache;

    if (!listEl) return;
    listEl.innerHTML = filtered.length === 0
      ? `<div class="memory-list-empty">${t("memory.empty")}</div><div class="memory-list-empty-hint">${t("memory.auto_hint")}</div>`
      : filtered.map(m => {
        const badge = `<span class="memory-type-badge ${m.type}">${TYPE_LABELS[m.type] || m.type}</span>`;
        const activeClass = _memoryCurrentFile === m.filename ? " active" : "";
        return `<div class="memory-list-item${activeClass}" data-file="${m.filename}">
          <div class="memory-list-item-name">${badge}<span>${m.name.replace(/</g,'&lt;')}</span></div>
          <div class="memory-list-item-desc">${m.description.replace(/</g,'&lt;') || t("memory.no_desc")}</div>
        </div>`;
      }).join("");

    listEl.querySelectorAll(".memory-list-item").forEach((node) => {
      const el = /** @type {HTMLElement} */ (node);
      el.addEventListener("click", () => {
        const f = el.dataset.file;
        if (f) selectMemory(f);
      });
    });
  }

  /**
   * @param {string} filename
   */
  async function selectMemory(filename) {
    _memoryCurrentFile = filename;
    try {
      const m = await window.aideagent.memoryReadOne(filename);
      if (m) {
        if (nameInput) nameInput.value = m.name || "";
        if (descInput) descInput.value = m.description || "";
        if (typeSelect) typeSelect.value = m.type || "project";
        if (bodyTextarea) bodyTextarea.value = m.body || "";
        if (statusEl) statusEl.textContent = "";
      }
    } catch {}
    await refreshList(searchInput?.value || "");
  }

  function newMemory() {
    _memoryCurrentFile = null;
    if (nameInput) nameInput.value = "";
    if (descInput) descInput.value = "";
    if (typeSelect) typeSelect.value = "project";
    if (bodyTextarea) bodyTextarea.value = "";
    if (statusEl) statusEl.textContent = "";
    refreshList(searchInput?.value || "");
  }

  saveBtn?.addEventListener("click", async () => {
    const name = nameInput?.value.trim() || "";
    const desc = descInput?.value.trim() || "";
    const type = typeSelect?.value || "project";
    const body = bodyTextarea?.value || "";
    if (!name) { if (statusEl) statusEl.textContent = t("memory.name_required"); return; }

    if (statusEl) statusEl.textContent = t("memory.saving");
    try {
      if (_memoryCurrentFile) {
        await window.aideagent.memoryUpdate(_memoryCurrentFile, body, name, desc, type);
      } else {
        await window.aideagent.memoryCreate(name, desc, type, body);
      }
      if (statusEl) {
        statusEl.textContent = t("memory.saved");
        setTimeout(() => { if (statusEl) statusEl.textContent = ""; }, 2000);
      }
      await refreshList(searchInput?.value || "");
      if (!_memoryCurrentFile) {
        const safe = name.replace(/[^a-zA-Z0-9_\-一-鿿]/g, "_");
        _memoryCurrentFile = safe + ".md";
      }
      await refreshList(searchInput?.value || "");
    } catch (e) {
      if (statusEl) statusEl.textContent = t("memory.save_fail").replace("{error}", /** @type {Error} */ (e).message);
    }
  });

  deleteBtn?.addEventListener("click", async () => {
    if (!_memoryCurrentFile) return;
    if (!confirm(t("memory.delete_confirm").replace("{name}", _memoryCurrentFile))) return;
    try {
      await window.aideagent.memoryDelete(_memoryCurrentFile);
      _memoryCurrentFile = null;
      if (nameInput) nameInput.value = "";
      if (descInput) descInput.value = "";
      if (bodyTextarea) bodyTextarea.value = "";
      if (statusEl) {
        statusEl.textContent = t("memory.deleted");
        setTimeout(() => { if (statusEl) statusEl.textContent = ""; }, 2000);
      }
      await refreshList(searchInput?.value || "");
    } catch (e) {
      if (statusEl) statusEl.textContent = t("memory.delete_fail").replace("{error}", /** @type {Error} */ (e).message);
    }
  });

  newBtn?.addEventListener("click", newMemory);

  searchInput?.addEventListener("input", () => {
    refreshList(searchInput.value);
  });

  await refreshList();
}

export function initMemoryPanel() {
  document.querySelector('.settings-tab[data-tab="memory"]')?.addEventListener("click", loadMemoryPanel);
}
