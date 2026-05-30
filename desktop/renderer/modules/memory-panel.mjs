let _memoryPanelLoaded = false;
let _memoryListCache = [];
let _memoryCurrentFile = null;

export async function loadMemoryPanel() {
  if (_memoryPanelLoaded) return;
  _memoryPanelLoaded = true;

  const TYPE_LABELS = { user: t("memory.label_user"), feedback: t("memory.label_feedback"), project: t("memory.label_project"), reference: t("memory.label_reference") };

  const listEl = document.getElementById("memory-list");
  const searchInput = document.getElementById("memory-search-input");
  const nameInput = document.getElementById("memory-edit-name");
  const descInput = document.getElementById("memory-edit-desc");
  const typeSelect = document.getElementById("memory-edit-type");
  const bodyTextarea = document.getElementById("memory-edit-body");
  const saveBtn = document.getElementById("memory-save-btn");
  const deleteBtn = document.getElementById("memory-delete-btn");
  const newBtn = document.getElementById("memory-new-btn");
  const statusEl = document.getElementById("memory-edit-status");

  async function refreshList(filter = "") {
    try {
      _memoryListCache = await window.goodAgent.memoryListAll();
    } catch {
      _memoryListCache = [];
    }
    const filtered = filter
      ? _memoryListCache.filter(m => m.name.includes(filter) || m.description.includes(filter) || m.filename.includes(filter))
      : _memoryListCache;

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

    listEl.querySelectorAll(".memory-list-item").forEach(el => {
      el.addEventListener("click", () => selectMemory(el.dataset.file));
    });
  }

  async function selectMemory(filename) {
    _memoryCurrentFile = filename;
    try {
      const m = await window.goodAgent.memoryReadOne(filename);
      if (m) {
        nameInput.value = m.name || "";
        descInput.value = m.description || "";
        typeSelect.value = m.type || "project";
        bodyTextarea.value = m.body || "";
        statusEl.textContent = "";
      }
    } catch {}
    await refreshList(searchInput?.value || "");
  }

  function newMemory() {
    _memoryCurrentFile = null;
    nameInput.value = "";
    descInput.value = "";
    typeSelect.value = "project";
    bodyTextarea.value = "";
    statusEl.textContent = "";
    refreshList(searchInput?.value || "");
  }

  saveBtn.addEventListener("click", async () => {
    const name = nameInput.value.trim();
    const desc = descInput.value.trim();
    const type = typeSelect.value;
    const body = bodyTextarea.value;
    if (!name) { statusEl.textContent = t("memory.name_required"); return; }

    statusEl.textContent = t("memory.saving");
    try {
      if (_memoryCurrentFile) {
        await window.goodAgent.memoryUpdate(_memoryCurrentFile, body, name, desc, type);
      } else {
        await window.goodAgent.memoryCreate(name, desc, type, body);
      }
      statusEl.textContent = t("memory.saved");
      setTimeout(() => { statusEl.textContent = ""; }, 2000);
      await refreshList(searchInput?.value || "");
      if (!_memoryCurrentFile) {
        const safe = name.replace(/[^a-zA-Z0-9_\-一-鿿]/g, "_");
        _memoryCurrentFile = safe + ".md";
      }
      await refreshList(searchInput?.value || "");
    } catch (e) {
      statusEl.textContent = t("memory.save_fail").replace("{error}", e.message);
    }
  });

  deleteBtn.addEventListener("click", async () => {
    if (!_memoryCurrentFile) return;
    if (!confirm(t("memory.delete_confirm").replace("{name}", _memoryCurrentFile))) return;
    try {
      await window.goodAgent.memoryDelete(_memoryCurrentFile);
      _memoryCurrentFile = null;
      nameInput.value = ""; descInput.value = ""; bodyTextarea.value = "";
      statusEl.textContent = t("memory.deleted");
      setTimeout(() => { statusEl.textContent = ""; }, 2000);
      await refreshList(searchInput?.value || "");
    } catch (e) {
      statusEl.textContent = t("memory.delete_fail").replace("{error}", e.message);
    }
  });

  newBtn.addEventListener("click", newMemory);

  searchInput.addEventListener("input", () => {
    refreshList(searchInput.value);
  });

  await refreshList();
}

export function initMemoryPanel() {
  document.querySelector('.settings-tab[data-tab="memory"]')?.addEventListener("click", loadMemoryPanel);
}
