// @ts-check — JSDoc-typed knowledge base panel loader.
// @ts-check — 带 JSDoc 类型注解的知识库面板加载器。
let _kbPanelLoaded = false;

/** @param {unknown} s @returns {string} */
function escapeHtml(s) {
  if (!s || typeof s !== "string") return "";
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export async function loadKnowledgeBasePanel() {
  if (_kbPanelLoaded) return;
  _kbPanelLoaded = true;

  const vaultPath = /** @type {HTMLInputElement | null} */ (document.getElementById("kb-vault-path"));
  const embeddingSelect = /** @type {HTMLSelectElement | null} */ (document.getElementById("kb-embedding-provider"));
  const statusEl = document.getElementById("kb-status");
  const scanBtn = /** @type {HTMLButtonElement | null} */ (document.getElementById("kb-scan-btn"));
  const testSearchBtn = document.getElementById("kb-test-search-btn");
  const testArea = document.getElementById("kb-test-area");
  const testQuery = /** @type {HTMLInputElement | null} */ (document.getElementById("kb-test-query"));
  const testResults = document.getElementById("kb-test-results");
  const maxNotes = /** @type {HTMLInputElement | null} */ (document.getElementById("kb-max-notes"));
  const maxChars = /** @type {HTMLInputElement | null} */ (document.getElementById("kb-max-chars"));
  const maxBodyChars = /** @type {HTMLInputElement | null} */ (document.getElementById("kb-max-body-chars"));
  const maxBodyCharsSaveBtn = /** @type {HTMLButtonElement | null} */ (document.getElementById("kb-max-body-chars-save-btn"));
  const autoDetectedSpan = document.getElementById("kb-auto-detected-chars");
  const pickBtn = /** @type {HTMLButtonElement | null} */ (document.getElementById("kb-pick-vault-btn"));
  const ollamaModelRow = document.getElementById("kb-ollama-model-row");
  const ollamaModelSelect = /** @type {HTMLSelectElement | null} */ (document.getElementById("kb-ollama-model"));

  /**
   * @param {string} [selectedModel]
   */
  async function fetchOllamaModels(selectedModel) {
    if (!ollamaModelSelect) return;
    ollamaModelSelect.replaceChildren();
    const opt = document.createElement("option");
    opt.value = ""; opt.textContent = "检测中…";
    ollamaModelSelect.appendChild(opt);
    try {
      const models = await window.aideagent.kbOllamaModels();
      ollamaModelSelect.replaceChildren();
      const list = models.length > 0 ? models : ["nomic-embed-text"];
      for (const m of list) {
        const o = document.createElement("option");
        o.value = m; o.textContent = m;
        ollamaModelSelect.appendChild(o);
      }
    } catch {
      ollamaModelSelect.replaceChildren();
      const o = document.createElement("option");
      o.value = "nomic-embed-text"; o.textContent = "nomic-embed-text";
      ollamaModelSelect.appendChild(o);
    }
    if (selectedModel) ollamaModelSelect.value = selectedModel;
  }

  try {
    const vault = await window.aideagent.kbGetVault();
    if (vaultPath) vaultPath.value = vault || "";
    const cfg = await window.aideagent.kbConfig();
    if (embeddingSelect) embeddingSelect.value = cfg.embeddingProvider || "local";
    const savedModel = cfg.ollamaEmbedModel || "nomic-embed-text";
    if (cfg.embeddingProvider === "ollama") {
      if (ollamaModelRow) ollamaModelRow.style.display = "block";
      await fetchOllamaModels(savedModel);
    } else if (ollamaModelRow) {
      ollamaModelRow.style.display = "none";
    }
    if (maxNotes) maxNotes.value = String(cfg.maxNotes || 5);
    if (maxChars) maxChars.value = String(cfg.maxChars || 500);
    if (maxBodyChars) maxBodyChars.value = String(cfg.maxBodyChars || 0);
    const status = await window.aideagent.kbStatus();
    if (autoDetectedSpan) {
      // Show auto-detected value as a hint next to the input
      if (status.autoDetectedMaxBodyChars > 0) {
        autoDetectedSpan.textContent = t("kb.auto_chars").replace("{n}", String(status.autoDetectedMaxBodyChars));
      }
    }
    if (statusEl) {
      statusEl.textContent = status.noteCount > 0
        ? t("kb.indexed").replace("{count}", String(status.noteCount)).replace("{embedded}", String(status.embeddedCount))
        : t("kb.not_indexed");
    }
  } catch {}

  pickBtn?.addEventListener("click", async () => {
    try {
      const result = await window.aideagent.kbPickVault();
      if (result?.canceled) return;
      if (result?.ok && result.vault && vaultPath) {
        vaultPath.value = result.vault;
        scanBtn?.click();
      } else if (result?.error && statusEl) {
        statusEl.textContent = t("kb.error").replace("{error}", result.error);
      }
    } catch (e) {
      console.error("[kb] pick vault error:", e);
      if (statusEl) statusEl.textContent = t("kb.pick_fail").replace("{error}", /** @type {Error} */ (e).message);
    }
  });

  embeddingSelect?.addEventListener("change", async () => {
    const isOllama = embeddingSelect.value === "ollama";
    if (ollamaModelRow) ollamaModelRow.style.display = isOllama ? "block" : "none";
    if (isOllama) await fetchOllamaModels();
    await window.aideagent.kbSetConfig({ embeddingProvider: embeddingSelect.value });
  });
  ollamaModelSelect?.addEventListener("change", async () => {
    await window.aideagent.kbSetConfig({ ollamaEmbedModel: ollamaModelSelect.value || "nomic-embed-text" });
  });
  maxNotes?.addEventListener("change", async () => {
    await window.aideagent.kbSetConfig({ maxNotes: parseInt(maxNotes.value) || 5 });
  });
  maxChars?.addEventListener("change", async () => {
    await window.aideagent.kbSetConfig({ maxChars: parseInt(maxChars.value) || 500 });
  });
  maxBodyCharsSaveBtn?.addEventListener("click", async () => {
    const val = parseInt(maxBodyChars.value) || 0;
    await window.aideagent.kbSetConfig({ maxBodyChars: val });
    // Brief visual feedback
    const orig = maxBodyCharsSaveBtn.textContent;
    maxBodyCharsSaveBtn.textContent = "✓";
    setTimeout(() => { maxBodyCharsSaveBtn.textContent = t("common.save"); }, 1500);
  });

  scanBtn?.addEventListener("click", async () => {
    if (!vaultPath?.value) { if (statusEl) statusEl.textContent = t("kb.select_vault"); return; }
    scanBtn.disabled = true;
    scanBtn.textContent = t("kb.indexing");
    if (statusEl) statusEl.textContent = t("kb.scanning");
    try {
      const result = await window.aideagent.kbScan();
      if (result.error && statusEl) {
        statusEl.textContent = t("kb.error").replace("{error}", result.error);
      } else if (statusEl) {
        statusEl.textContent = t("kb.index_success").replace("{count}", String(result.indexed)).replace("{embedded}", String(result.embedded));
      }
    } catch (e) {
      if (statusEl) statusEl.textContent = t("kb.error").replace("{error}", /** @type {Error} */ (e).message);
    }
    scanBtn.disabled = false;
    scanBtn.textContent = t("kb.scan_btn");
  });

  testSearchBtn?.addEventListener("click", () => {
    if (!testArea) return;
    testArea.style.display = testArea.style.display === "none" ? "block" : "none";
    if (testArea.style.display === "block") testQuery?.focus();
  });

  testQuery?.addEventListener("keydown", async (e) => {
    if (e.key === "Enter") {
      const query = testQuery.value.trim();
      if (!query || !testResults) return;
      testResults.textContent = ""; // clear
      const statusDiv = document.createElement("div");
      statusDiv.style.cssText = "color:var(--text-muted);font-size:12px;";
      statusDiv.textContent = t("kb.searching");
      testResults.appendChild(statusDiv);
      try {
        const results = await window.aideagent.kbSearch(query, 5);
        testResults.replaceChildren();
        if (results.length === 0) {
          const noDiv = document.createElement("div");
          noDiv.style.cssText = "color:var(--text-muted);font-size:12px;";
          noDiv.textContent = t("kb.no_results");
          testResults.appendChild(noDiv);
          return;
        }
        for (const r of results) {
          const item = document.createElement("div");
          item.className = "kb-result-item";

          const titleDiv = document.createElement("div");
          titleDiv.className = "kb-result-title";
          titleDiv.textContent = r.title || r.rel_path;
          item.appendChild(titleDiv);

          const pathDiv = document.createElement("div");
          pathDiv.className = "kb-result-path";
          pathDiv.textContent = r.rel_path;
          item.appendChild(pathDiv);

          const snippetDiv = document.createElement("div");
          snippetDiv.className = "kb-result-snippet";
          snippetDiv.textContent = r.snippet || "";
          item.appendChild(snippetDiv);

          testResults.appendChild(item);
        }
      } catch (e) {
        testResults.replaceChildren();
        const errDiv = document.createElement("div");
        errDiv.style.cssText = "color:var(--danger);font-size:12px;";
        errDiv.textContent = /** @type {Error} */ (e).message;
        testResults.appendChild(errDiv);
      }
    }
  });
}

export function initKnowledgeBase() {
  document.querySelector('.settings-tab[data-tab="knowledge-base"]')
    ?.addEventListener("click", loadKnowledgeBasePanel);

  document.getElementById("kb-pick-vault-btn")?.addEventListener("click", async () => {
    try {
      const result = await window.aideagent.kbPickVault();
      if (result?.canceled) return;
      if (result?.ok && result.vault) {
        const vp = /** @type {HTMLInputElement | null} */ (document.getElementById("kb-vault-path"));
        if (vp) vp.value = result.vault;
        document.getElementById("kb-scan-btn")?.click();
      }
    } catch (e) {
      console.error("[kb] pick vault fallback error:", e);
    }
  });

  document.getElementById("kb-clear-vault-btn")?.addEventListener("click", async () => {
    try {
      await window.aideagent.kbSetVault("");
      const vp = /** @type {HTMLInputElement | null} */ (document.getElementById("kb-vault-path"));
      if (vp) vp.value = "";
      const st = document.getElementById("kb-status");
      if (st) st.textContent = t("kb.unconfigured");
    } catch (e) {
      console.error("[kb] clear vault error:", e);
    }
  });

  const _kbToggle = /** @type {HTMLInputElement | null} */ (document.getElementById("kb-toggle"));
  if (_kbToggle) {
    _kbToggle.checked = localStorage.getItem("AideAgent_kb_enabled") === "true";
    _kbToggle.addEventListener("change", () => {
      localStorage.setItem("AideAgent_kb_enabled", String(_kbToggle.checked));
    });
  }

  const _webSearchToggle = /** @type {HTMLInputElement | null} */ (document.getElementById("web-search-toggle"));
  if (_webSearchToggle) {
    const saved = localStorage.getItem("AideAgent_web_search_enabled");
    _webSearchToggle.checked = saved === null ? true : saved === "true";
    _webSearchToggle.addEventListener("change", () => {
      localStorage.setItem("AideAgent_web_search_enabled", String(_webSearchToggle.checked));
    });
  }
}
