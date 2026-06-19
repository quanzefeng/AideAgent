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

  /** @type {Record<string, string>} */
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
  const purgeBtn = /** @type {HTMLButtonElement | null} */ (document.getElementById("memory-purge-project-btn"));

  /**
   * Update the count chips at the top of the memory panel.
   * Highlights the project chip in red when count exceeds 10.
   * @param {Array<{filename:string;name:string;description:string;type:string;body:string}>} memories
   */
  function refreshStats(memories) {
    const counts = { project: 0, feedback: 0, user: 0, reference: 0 };
    for (const m of memories) {
      if (counts[m.type] !== undefined) counts[m.type]++;
    }
    for (const [type, n] of Object.entries(counts)) {
      const el = document.getElementById(`memory-stat-${type}`);
      if (el) {
        el.textContent = String(n);
        const chip = el.closest(".memory-stat-chip");
        if (chip) {
          chip.classList.toggle("memory-stat-overflow", type === "project" && n > 10);
        }
      }
    }
    // Disable the purge button only when there's literally nothing to purge.
// Bug fix: was `counts.project <= 3` — that disabled the button when
// count was 1, 2, or 3 (i.e. when the user had exactly the memories
// they wanted to clear!). Now it's `<= 0` so the button works for any
// positive count. The "below comfort threshold" reasoning was backwards.
    if (purgeBtn) {
      const tooFew = counts.project <= 0;
      purgeBtn.disabled = tooFew;
      purgeBtn.title = tooFew
        ? t("memory.purge_disabled_hint").replace("{cap}", "1")
        : t("memory.purge_btn_title");
    }
  }

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
    // Update the count chips regardless of search filter (we want totals, not filtered)
    refreshStats(_memoryListCache);
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

  // Purge button — bulk-delete all project-type memories with double confirmation
  purgeBtn?.addEventListener("click", async () => {
    if (!_memoryListCache) return;
    const projects = _memoryListCache.filter(m => m.type === "project");
    if (projects.length === 0) return;

    // Build confirmation message listing every file that will be deleted
    const namesPreview = projects.length <= 12
      ? projects.map(m => `  • ${m.name}`).join("\n")
      : projects.slice(0, 10).map(m => `  • ${m.name}`).join("\n") + `\n  ... and ${projects.length - 10} more`;
    const confirmMsg = t("memory.purge_confirm_body")
      .replace("{count}", String(projects.length))
      .replace("{names}", namesPreview);
    const ok = confirm(confirmMsg);
    if (!ok) return;

    try {
      purgeBtn.disabled = true;
      const result = await window.aideagent.memoryPurgeByType("project");
      if (result?.ok) {
        if (statusEl) {
          statusEl.textContent = t("memory.purge_done").replace("{count}", String(result.removed || projects.length));
          setTimeout(() => { if (statusEl) statusEl.textContent = ""; }, 3000);
        }
      } else {
        if (statusEl) {
          statusEl.textContent = t("memory.purge_fail").replace("{error}", result?.error || "unknown");
          setTimeout(() => { if (statusEl) statusEl.textContent = ""; }, 3000);
        }
      }
      _memoryCurrentFile = null;
      await refreshList(searchInput?.value || "");
    } catch (/** @type {any} */ e) {
      if (statusEl) {
        statusEl.textContent = t("memory.purge_fail").replace("{error}", e?.message || String(e));
        setTimeout(() => { if (statusEl) statusEl.textContent = ""; }, 3000);
      }
    }
  });

  searchInput?.addEventListener("input", () => {
    refreshList(searchInput.value);
  });

  await refreshList();
}

export function initMemoryPanel() {
  document.querySelector('.settings-tab[data-tab="memory"]')?.addEventListener("click", loadMemoryPanel);
}
