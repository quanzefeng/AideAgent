// @ts-check — JSDoc-typed MCP settings panel (extracted Step 6, typed Step 7).
// @ts-check — 带 JSDoc 类型注解的 MCP 设置面板（Step 6 提取，Step 7 加类型）。
//
// MCP settings panel — extracted from renderer/app.js (Step 6).
// Encapsulates all MCP-related rendering, form interactions, and IPC calls:
//   - Server list (loadServers) with restart/remove buttons
//   - Built-in servers (loadBuiltins) with toggle switches
//   - Status toasts (showStatus)
//   - Add form (open/cancel/save) with validation
//   - Quick-add SearXNG
//   - Local MCP detection (Claude Code, OpenCode, etc.) with import buttons
//   - Refresh + Save-all + Detect buttons
//   - Lazy-load when the MCP tab is first opened
//
// External dependencies are injected via the factory: t (i18n), getLang
// (current language), sanitize (HTML escape), onConfirm (show confirm modal).

/**
 * Create the MCP settings panel.
 * @param {{
 *   t: (key: string, vars?: Record<string, string|number>) => string,
 *   getLang: () => "zh" | "en",
 *   sanitize: (s: string) => string,
 *   onConfirm: (message: string) => Promise<boolean>,
 * }} deps
 */
export function createMcpPanel({ t, getLang, sanitize, onConfirm }) {
  // ── Lazy-load guard for the MCP tab ──
  let _mcpTabLoaded = false;

  /**
   * @param {string} msg
   * @param {"info"|"success"|"error"} [type]
   */
  function showStatus(msg, type = "info") {
    const el = document.getElementById("mcp-settings-status");
    if (!el) return;
    el.textContent = msg;
    el.className = `settings-status ${type === "info" ? "hidden" : ""}`;
    if (type !== "info") {
      el.classList.remove("hidden");
      setTimeout(() => { el.classList.add("hidden"); }, 5000);
    }
  }

  async function loadServers() {
    const listEl = document.getElementById("mcp-server-list");
    if (!listEl) return;
    try {
      const servers = await window.aideagent.mcpList();
      if (!servers || servers.length === 0) {
        listEl.innerHTML = '<p class="hint" style="padding:24px 0;text-align:center;">' + t("mcp.empty") + '</p>';
        return;
      }
      listEl.innerHTML = servers.map(s => {
        const statusIcon = s.status === "running" ? "🟢" : s.status === "error" ? "🔴" : "🟡";
        const errMsg = s.error ? `<div class="mcp-server-error">${sanitize(s.error)}</div>` : "";
        return `<div class="mcp-server-card">
          <div class="mcp-server-header">
            <div class="mcp-server-name">
              <span class="mcp-server-status-dot" style="color:${s.status === "running" ? "#22c55e" : s.status === "error" ? "#ef4444" : "#eab308"}">●</span>
              <strong>${sanitize(s.name)}</strong>
              <span class="mcp-server-status-label">${statusIcon} ${s.status === "running" ? t("mcp.running") : s.status === "error" ? t("mcp.error") : t("mcp.starting")}</span>
            </div>
            <div class="mcp-server-actions">
              <button class="btn mcp-restart-btn" data-name="${sanitize(s.name)}" style="font-size:12px;padding:4px 10px;" ${s.status === "starting" ? "disabled" : ""}>
                ${s.status === "running" ? t("mcp.restart") : s.status === "error" ? t("mcp.retry") : t("mcp.restart")}
              </button>
              <button class="btn mcp-remove-btn" data-name="${sanitize(s.name)}" style="font-size:12px;padding:4px 10px;color:var(--danger);border-color:rgba(208,49,45,0.3);">${t("mcp.remove")}</button>
            </div>
          </div>
          ${errMsg}
        </div>`;
      }).join("");

      // Bind restart buttons
      listEl.querySelectorAll(".mcp-restart-btn").forEach((node) => {
        const btn = /** @type {HTMLButtonElement} */ (node);
        btn.addEventListener("click", async () => {
          const name = btn.dataset.name;
          if (!name) return;
          btn.disabled = true;
          btn.textContent = t("mcp.restarting");
          const result = await window.aideagent.mcpRestart(name);
          if (!result.success) {
            showStatus(t("mcp.restart_fail", {name, error: result.error}), "error");
          }
          await loadServers();
          btn.disabled = false;
          btn.textContent = t("mcp.restart");
        });
      });

      // Bind remove buttons
      listEl.querySelectorAll(".mcp-remove-btn").forEach((node) => {
        const btn = /** @type {HTMLButtonElement} */ (node);
        btn.addEventListener("click", async () => {
          const name = btn.dataset.name;
          if (!name) return;
          if (!await onConfirm(t("mcp.remove_confirm", {name}))) return;
          btn.disabled = true;
          const result = await window.aideagent.mcpRemove(name);
          if (!result.success) {
            showStatus(t("mcp.remove_fail", {name, error: result.error}), "error");
          }
          await loadServers();
        });
      });
    } catch (err) {
      console.error("[mcp] load error:", err);
      if (listEl) listEl.innerHTML = '<div class="hint" style="padding:24px 0;text-align:center;color:var(--danger);">' + t("mcp.load_error") + '</div>';
    }
  }

  async function loadBuiltins() {
    const listEl = document.getElementById("mcp-builtins-list");
    if (!listEl) return;
    try {
      const builtins = await window.aideagent.mcpBuiltins();
      if (!builtins || builtins.length === 0) {
        listEl.innerHTML = "";
        return;
      }
      const lang = getLang();
      listEl.innerHTML = builtins.map(b => {
        const label = lang === "zh" ? b.label : (b.labelEn || b.label);
        const desc = lang === "zh" ? b.description : (b.descriptionEn || b.description);
        const statusColor = b.running ? "#22c55e" : b.status === "error" ? "#ef4444" : "#6b7280";
        const statusText = b.running ? t("mcp.running") : b.status === "error" ? t("mcp.error") : t("mcp.builtin_disable");
        const errMsg = b.error ? `<div style="font-size:11px;color:var(--danger);margin-top:4px;">${sanitize(b.error)}</div>` : "";
        return `<div class="mcp-builtin-item" style="display:flex;align-items:center;justify-content:space-between;padding:8px 10px;background:var(--bg-primary);border-radius:6px;border:1px solid var(--border);">
          <div style="flex:1;min-width:0;">
            <div style="display:flex;align-items:center;gap:6px;">
              <span style="font-size:13px;font-weight:500;">${sanitize(label)}</span>
              <span style="font-size:11px;color:${statusColor};">● ${statusText}</span>
            </div>
            <div style="font-size:11px;color:var(--text-light);margin-top:2px;">${sanitize(desc)}</div>
            ${errMsg}
          </div>
          <label class="builtin-toggle" style="position:relative;display:inline-block;width:36px;height:20px;flex-shrink:0;margin-left:10px;cursor:pointer;">
            <input type="checkbox" class="builtin-toggle-input" data-name="${sanitize(b.name)}" ${b.enabled ? "checked" : ""} style="opacity:0;width:0;height:0;position:absolute;">
            <span class="builtin-toggle-slider" style="position:absolute;inset:0;background-color:${b.enabled ? "#22c55e" : "#4b5563"};border-radius:10px;transition:0.3s;"></span>
            <span class="builtin-toggle-knob" style="position:absolute;height:16px;width:16px;left:2px;bottom:2px;background-color:white;border-radius:50%;transition:0.3s;transform:${b.enabled ? "translateX(16px)" : "translateX(0)"};"></span>
          </label>
        </div>`;
      }).join("");

      // Bind toggle events
      listEl.querySelectorAll(".builtin-toggle-input").forEach((node) => {
        const input = /** @type {HTMLInputElement} */ (node);
        input.addEventListener("change", async () => {
          const name = input.dataset.name;
          if (!name) return;
          const enabled = input.checked;
          // Optimistic UI update — disable toggle during operation
          input.disabled = true;
          const result = await window.aideagent.mcpToggleBuiltin(name, enabled);
          if (result.success) {
            await loadBuiltins();
            await loadServers(); // Refresh server list too (shows tools)
          } else {
            input.checked = !enabled; // Revert
            showStatus(t("mcp.start_fail", { error: result.error }), "error");
            await loadBuiltins();
          }
        });
      });
    } catch (err) {
      console.error("[mcp] builtins load error:", err);
    }
  }

  async function detectLocal() {
    const resultsEl = document.getElementById("mcp-detect-results");
    if (!resultsEl) return;
    try {
      const servers = await window.aideagent.mcpDetectLocal();
      if (!servers || servers.length === 0) {
        resultsEl.innerHTML = '<span style="color:var(--text-light);">' + t("mcp.detect_empty") + '</span>';
        return;
      }
      // Group by source
      const bySource = {};
      for (const s of servers) {
        if (!bySource[s.source]) bySource[s.source] = [];
        bySource[s.source].push(s);
      }
      const html = Object.entries(bySource).map(([source, items]) => {
        const itemsHtml = items.map(s => {
          if (s.kind === "stdio") {
            const label = `<code>${sanitize(s.command)} ${sanitize(s.args.join(" "))}</code>`;
            const note = s.disabled ? ' <span style="color:var(--text-light);font-size:11px;">' + t("mcp.disabled") + '</span>' : "";
            return `<div style="display:flex;align-items:center;justify-content:space-between;padding:4px 0;border-bottom:1px solid var(--border);">
              <div style="flex:1;min-width:0;">
                <strong style="font-size:13px;">${sanitize(s.serverName)}</strong>${note}
                <div style="font-size:11px;color:var(--text-light);">${label}</div>
              </div>
               <button class="btn mcp-import-btn" style="font-size:11px;padding:2px 8px;" data-name="${sanitize(s.serverName)}" data-command="${sanitize(s.command)}" data-args='${sanitize(JSON.stringify(s.args))}' data-env='${sanitize(JSON.stringify(s.env))}'>${t("mcp.import_btn")}</button>
            </div>`;
          }
          // ── Remote (HTTP) MCP ──
          const url = s.url || "";
          const note = s.disabled ? ' <span style="color:var(--text-light);font-size:11px;">' + t("mcp.disabled") + '</span>' : "";
          return `<div style="padding:4px 0;border-bottom:1px solid var(--border);">
            <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:4px;">
              <strong style="font-size:13px;">${sanitize(s.serverName)}</strong>${note}
            </div>
            <div style="font-size:11px;color:var(--text-light);margin-bottom:4px;"><code style="word-break:break-all;">${sanitize(url)}</code></div>
            <div style="display:flex;align-items:center;gap:6px;">
              <input type="password" class="form-input mcp-remote-key" style="flex:1;font-size:12px;padding:4px 8px;" placeholder="API Key (Bearer token)" />
              <button class="btn mcp-remote-connect-btn" style="font-size:11px;padding:4px 10px;white-space:nowrap;" data-name="${sanitize(s.serverName)}" data-url="${sanitize(url)}">${t("mcp.connect")}</button>
            </div>
          </div>`;
        }).join("");
        return `<div style="margin-bottom:6px;">
          <div style="font-size:12px;font-weight:600;color:var(--text-light);margin-bottom:2px;">📁 ${sanitize(source)}</div>
          ${itemsHtml}
        </div>`;
      }).join("");
      resultsEl.innerHTML = html;

      // Bind stdio import buttons
      resultsEl.querySelectorAll(".mcp-import-btn").forEach((node) => {
        const btn = /** @type {HTMLButtonElement} */ (node);
        btn.addEventListener("click", async () => {
          const name = btn.dataset.name;
          const command = btn.dataset.command;
          if (!name || !command) return;
          let args = [];
          try { args = JSON.parse(btn.dataset.args || "[]"); } catch {}
          let env = {};
          try { env = JSON.parse(btn.dataset.env || "{}"); } catch {}
          btn.disabled = true;
          btn.textContent = t("mcp.importing");
          const result = await window.aideagent.mcpAdd(name, { command, args, env });
          if (result.success) {
            showStatus(t("mcp.imported", {name}), "success");
            btn.textContent = t("mcp.import_done");
            await loadServers();
          } else {
            showStatus(t("mcp.import_fail", {name, error: result.error}), "error");
            btn.textContent = t("mcp.retry");
            btn.disabled = false;
          }
        });
      });

      // Bind remote connect buttons
      resultsEl.querySelectorAll(".mcp-remote-connect-btn").forEach((node) => {
        const btn = /** @type {HTMLButtonElement} */ (node);
        btn.addEventListener("click", async () => {
          const name = btn.dataset.name;
          const url = btn.dataset.url;
          if (!name || !url) return;
          const keyInput = /** @type {HTMLInputElement | null} */ (btn.parentElement?.querySelector(".mcp-remote-key"));
          const apiKey = keyInput?.value?.trim() || "";
          btn.disabled = true;
          btn.textContent = t("mcp.connecting");
          const headers = apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
          const result = await window.aideagent.mcpAddRemote(name, url, headers);
          if (result.success) {
            showStatus(t("mcp.connected", {name}), "success");
            btn.textContent = t("mcp.connect_done");
            await loadServers();
          } else {
            showStatus(t("mcp.connect_fail", {name, error: result.error}), "error");
            btn.textContent = t("mcp.connect");
            btn.disabled = false;
          }
        });
      });
    } catch (e) {
      resultsEl.innerHTML = `<span style="color:var(--danger);font-size:12px;">${t("mcp.detect_fail", {error: sanitize(e.message)})}</span>`;
    }
  }

  function init() {
    // Refresh button
    document.getElementById("mcp-refresh-btn")?.addEventListener("click", () => {
      loadServers();
      loadBuiltins();
    });

    // Save all button
    document.getElementById("mcp-save-all-btn")?.addEventListener("click", async () => {
      const btn = /** @type {HTMLButtonElement | null} */ (document.getElementById("mcp-save-all-btn"));
      if (!btn) return;
      btn.disabled = true;
      btn.textContent = t("mcp.saving");
      const result = await window.aideagent.mcpSaveAll();
      if (result.success) {
        showStatus(t("mcp.config_saved"), "success");
      } else {
        showStatus(t("mcp.save_fail", {error: result.error}), "error");
      }
      btn.disabled = false;
      btn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:middle;margin-right:4px;"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></svg> ' + t("mcp.save_config");
    });

    // Add form toggle
    document.getElementById("mcp-add-btn")?.addEventListener("click", () => {
      const form = document.getElementById("mcp-add-form");
      if (form) {
        form.classList.toggle("hidden");
        if (!form.classList.contains("hidden")) {
          /** @type {HTMLInputElement | null} */ (document.getElementById("mcp-name-input"))?.focus();
        }
      }
    });

    document.getElementById("mcp-cancel-btn")?.addEventListener("click", () => {
      const form = document.getElementById("mcp-add-form");
      if (form) form.classList.add("hidden");
      document.getElementById("mcp-form-status")?.classList.add("hidden");
    });

    // Save new server
    document.getElementById("mcp-save-btn")?.addEventListener("click", async () => {
      const name = /** @type {HTMLInputElement | null} */ (document.getElementById("mcp-name-input"))?.value.trim();
      const command = /** @type {HTMLInputElement | null} */ (document.getElementById("mcp-command-input"))?.value.trim();
      const argsStr = /** @type {HTMLInputElement | null} */ (document.getElementById("mcp-args-input"))?.value.trim();
      const envStr = /** @type {HTMLInputElement | null} */ (document.getElementById("mcp-env-input"))?.value.trim();
      const formStatus = document.getElementById("mcp-form-status");

      if (!name || !command) {
        if (formStatus) {
          formStatus.textContent = t("mcp.name_required");
          formStatus.classList.remove("hidden");
        }
        return;
      }

      const args = argsStr ? argsStr.split(" ").filter(Boolean) : [];
      /** @type {Record<string, string>} */
      let env = {};
      if (envStr) {
        try { env = JSON.parse(envStr); } catch {
          if (formStatus) {
            formStatus.textContent = t("mcp.env_invalid");
            formStatus.classList.remove("hidden");
          }
          return;
        }
      }

      const config = { command, args };
      if (Object.keys(env).length > 0) config.env = env;

      const saveBtn = /** @type {HTMLButtonElement | null} */ (document.getElementById("mcp-save-btn"));
      if (!saveBtn) return;
      saveBtn.disabled = true;
      saveBtn.textContent = t("mcp.starting");

      const result = await window.aideagent.mcpAdd(name, config);
      if (result.success) {
        // Clear form
        /** @type {HTMLInputElement} */ (document.getElementById("mcp-name-input") || document.createElement("input")).value = "";
        /** @type {HTMLInputElement} */ (document.getElementById("mcp-command-input") || document.createElement("input")).value = "";
        /** @type {HTMLInputElement} */ (document.getElementById("mcp-args-input") || document.createElement("input")).value = "";
        /** @type {HTMLInputElement} */ (document.getElementById("mcp-env-input") || document.createElement("input")).value = "";
        document.getElementById("mcp-add-form")?.classList.add("hidden");
        formStatus?.classList.add("hidden");
        await loadServers();
      } else if (formStatus) {
        formStatus.textContent = t("mcp.start_fail", {error: result.error});
        formStatus.classList.remove("hidden");
      }

      saveBtn.disabled = false;
      saveBtn.textContent = t("mcp.save_start");
    });

    // Load MCP servers + builtins + auto-detect when the MCP tab is opened
    document.querySelector('.settings-tab[data-tab="mcp"]')?.addEventListener("click", () => {
      if (_mcpTabLoaded) return;
      _mcpTabLoaded = true;
      const listEl = document.getElementById("mcp-server-list");
      if (listEl) loadServers();
      loadBuiltins();
      detectLocal();
    });

    // ── Quick Add SearXNG ──
    document.getElementById("mcp-searxng-add-btn")?.addEventListener("click", async () => {
      const urlInput = /** @type {HTMLInputElement | null} */ (document.getElementById("mcp-searxng-url"));
      const url = urlInput?.value.trim();
      if (!url) {
        showStatus(t("mcp.searxng_url_required"), "error");
        return;
      }
      const btn = /** @type {HTMLButtonElement | null} */ (document.getElementById("mcp-searxng-add-btn"));
      if (!btn) return;
      btn.disabled = true;
      btn.textContent = t("mcp.searxng_adding");
      try {
        const result = await window.aideagent.mcpQuickAddSearxng(url);
        if (result.success) {
          showStatus(t("mcp.searxng_added"), "success");
          if (urlInput) urlInput.value = "";
          await loadServers();
          // Refresh detect results in case they're showing
          await detectLocal();
        } else {
          showStatus(t("mcp.searxng_fail", {error: result.error}), "error");
        }
      } catch (e) {
        showStatus(t("mcp.searxng_fail", {error: e.message}), "error");
      }
      btn.disabled = false;
      btn.textContent = t("mcp.add");
    });

    // Enter key to submit SearXNG URL
    document.getElementById("mcp-searxng-url")?.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        document.getElementById("mcp-searxng-add-btn")?.click();
      }
    });

    // ── Detect Local MCP ──
    document.getElementById("mcp-detect-btn")?.addEventListener("click", () => {
      const btn = /** @type {HTMLButtonElement | null} */ (document.getElementById("mcp-detect-btn"));
      if (!btn) return;
      btn.disabled = true;
      btn.textContent = t("mcp.scanning");
      detectLocal().finally(() => {
        btn.disabled = false;
        btn.textContent = t("mcp.scan");
      });
    });
  }

  return { init };
}
