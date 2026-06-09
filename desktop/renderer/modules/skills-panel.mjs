// @ts-check — JSDoc-typed skills panel (L3 + L2 + skill editor).
// @ts-check — 带 JSDoc 类型注解的技能面板（L3 + L2 + 技能编辑器）。
import { sanitize } from './helpers.mjs';

/**
 * Read saved API config (provider, URL, key, model, format) from localStorage.
 * @returns {{ provider: string, apiUrl: string, apiKey: string, model: string, apiFormat: string }}
 */
function loadApiConfig() {
  return {
    provider: localStorage.getItem("AideAgent_provider") || "",
    apiUrl: localStorage.getItem("AideAgent_api_url") || "",
    apiKey: localStorage.getItem("AideAgent_api_key") || "",
    model: localStorage.getItem("AideAgent_model") || "",
    apiFormat: localStorage.getItem("AideAgent_api_format") || "openai",
  };
}

const SKILLS_KEY = "AideAgent_enabled_skills";
let _skillsPanelLoaded = false;

// ── L3 Skills (scanned from .agents/.claude) ──

/** Scan the local .agents/.claude folders for L3 skills and render the toggle list. */
export async function loadAndRenderSkills() {
  const listEl = document.getElementById("local-skills-list");
  const countEl = document.getElementById("skills-count");
  if (!listEl) return;
  try {
    listEl.innerHTML = `<div class="skills-loading">${t("skills.scanning")}</div>`;
    const skills = await window.aideagent.listSkills();
    if (!skills || skills.length === 0) {
      listEl.innerHTML = `<div class="skills-empty">${t("skills.empty")}</div>`;
      if (countEl) countEl.textContent = t("skills.count").replace("{count}", "0");
      return;
    }
    if (countEl) countEl.textContent = t("skills.count").replace("{count}", String(skills.length));

    const enabled = loadEnabledSkills();
    // Fetch Chinese translations (per-user cache; empty on first run). The
    // preload bridge is `.cjs` so TS does not see the new methods.
    /** @type {any} */
    const api = window.aideagent;
    const transResult = await api.skillsTranslationsGet?.() || { translations: {} };
    const translations = transResult.translations || {};

    listEl.innerHTML = skills.map(s => {
      const isOn = enabled.includes(s.name);
      const zh = translations[s.name] || "";
      return `<div class="skill-card">
        <div class="skill-card-info">
          <div class="skill-card-name">${sanitize(s.name)}</div>
          ${zh ? `<div class="skill-card-name-zh">${sanitize(zh)}</div>` : ""}
          <div class="skill-card-meta">
            <span class="skill-card-source">${s.source === "agents" ? "🤖 .agents" : "📦 .claude"}</span>
            ${s.version ? `<span class="skill-card-version">v${sanitize(s.version)}</span>` : ""}
            ${s.triggers && s.triggers.length > 0 ? `<span class="skill-card-triggers">${t("skills.triggers")} ${sanitize(s.triggers.slice(0, 3).join(", "))}</span>` : ""}
            ${s.allowedTools && s.allowedTools.length > 0 ? `<span class="skill-card-tools">${s.allowedTools.length} ${t("skills.tools_count")}</span>` : ""}
          </div>
        </div>
        <label class="skill-toggle">
          <input type="checkbox" class="skill-toggle-input" data-skill="${sanitize(s.name)}" ${isOn ? "checked" : ""} />
          <span class="skill-toggle-slider"></span>
        </label>
      </div>`;
    }).join("");

    listEl.querySelectorAll(".skill-toggle-input").forEach((node) => {
      const cb = /** @type {HTMLInputElement} */ (node);
      cb.addEventListener("change", () => {
        const name = cb.dataset.skill;
        if (!name) return;
        const en = loadEnabledSkills();
        if (cb.checked) { if (!en.includes(name)) en.push(name); }
        else { const idx = en.indexOf(name); if (idx >= 0) en.splice(idx, 1); }
        saveEnabledSkills(en);
      });
    });

    // Phase 2: incrementally translate any un-translated skills in the background.
    triggerIncrementalTranslation(skills);
  } catch (err) {
    console.error("[skills] load error:", err);
    listEl.innerHTML = `<div class="skills-empty" style="color:var(--danger);">${t("skills.load_error")}</div>`;
  }
}

/**
 * Fire-and-forget: ask main to translate any skills that don't have a Chinese
 * label yet. The API key is read from the encrypted main-process store
 * (api-keys.enc) since localStorage only ever holds the unencrypted fields
 * (provider, url, model). The IPC handler falls back to getLastApiConfig()
 * if the caller does not pass apiKey. On success, the IPC event
 * `skills:translations-updated` triggers a re-render.
 * @param {Array<{name: string}>} skills
 */
async function triggerIncrementalTranslation(skills) {
  /** @type {any} */
  const api = window.aideagent;
  if (!api?.skillsTranslationsMissing) return;
  try {
    const missResult = await api.skillsTranslationsMissing();
    if (!missResult?.ok || !Array.isArray(missResult.missing) || missResult.missing.length === 0) return;
    // If the user has the API configured, send the url+model+provider along
    // so the main process doesn't need to read localStorage (it can't, anyway).
    // The key itself is fetched from the encrypted store by the IPC handler
    // if not supplied.
    const cfg = loadApiConfig();
    if (!cfg.provider || !cfg.apiUrl) return;
    const apiKey = await api.loadApiKey?.(cfg.provider);
    if (!apiKey) return;
    api.skillsTranslationsEnsure({ ...cfg, apiKey }).then((/** @type {any} */ r) => {
      if (r?.ok && r.translated > 0) {
        console.log(`[skills] auto-translated ${r.translated} skill name(s) (errors=${r.errors})`);
      } else if (r?.skipped) {
        console.debug("[skills] translation skipped:", r.skipped);
      }
    }).catch((/** @type {any} */ e) => {
      console.warn("[skills] translation ensure failed:", e);
    });
  } catch { /* silent */ }
}

/**
 * @returns {string[]} L3 skill names the user has enabled in this session.
 */
export function loadEnabledSkills() {
  try { return JSON.parse(localStorage.getItem(SKILLS_KEY) || "[]"); } catch { return []; }
}

/**
 * Persist the user's enabled L3 skill names.
 * @param {string[]} skills
 */
function saveEnabledSkills(skills) {
  try { localStorage.setItem(SKILLS_KEY, JSON.stringify(skills)); } catch {}
}

// ── L2 Skills Panel (managed in SQLite) ──

/** Fetch curator status (last run, archive threshold) and render the status line. */
async function loadCuratorConfig() {
  try {
    const status = await window.aideagent.skillsCuratorStatus();
    const el = /** @type {HTMLInputElement | null} */ (document.getElementById("curator-days-input"));
    const line = document.getElementById("curator-status-line");
    if (el) el.value = String(status.archiveAfterDays ?? 30);
    if (line) {
      const locale = typeof getLang === "function" ? (getLang() === "en" ? "en-US" : "zh-CN") : "zh-CN";
      const lastRun = status.lastRun ? new Date(status.lastRun).toLocaleString(locale) : t("agent_skills.never_run");
      line.textContent = `${status.activeSkills} ${t("agent_skills.active")}, ${status.archivedSkills} ${t("agent_skills.archived")} | ${t("agent_skills.last_run")} ${lastRun}`;
    }
  } catch {}
}

/** First-time loader for the L2 skills panel: bind create form + render list. */
export async function loadSkillsPanel() {
  if (_skillsPanelLoaded) return;
  _skillsPanelLoaded = true;

  const createBtn = document.getElementById("skill-create-btn");
  const createForm = document.getElementById("skill-create-form");
  if (createBtn && createForm) {
    createBtn.onclick = () => { createForm.classList.remove("hidden"); createBtn.style.display = "none"; };
    document.getElementById("sk-cancel")?.addEventListener("click", () => { createForm.classList.add("hidden"); createBtn.style.display = ""; });
    document.getElementById("sk-save")?.addEventListener("click", async () => {
      const name = /** @type {HTMLInputElement | null} */ (document.getElementById("sk-name"))?.value?.trim() || "";
      const desc = /** @type {HTMLInputElement | null} */ (document.getElementById("sk-desc"))?.value?.trim() || "";
      const steps = /** @type {HTMLTextAreaElement | null} */ (document.getElementById("sk-steps"))?.value?.trim() || "";
      if (!name || !desc) return;
      try {
        await window.aideagent.skillsSaveSkill(name, { name, description: desc, triggers: [name], version: "1.0.0", status: "active", created_at: new Date().toISOString() }, "## Steps\n" + (steps || "1. ") + "\n\n## Notes\n- 手动创建");
        createForm.style.display = "none"; createBtn.style.display = "";
        _skillsPanelLoaded = false; await loadSkillsPanel();
      } catch (e) { alert(t("skill_editor.save_fail").replace("{error}", /** @type {Error} */ (e).message)); }
    });
  }

  // Phase 2 listener: when main process detects repeated-task patterns after
  // a session ends, surface a small toast so the user knows to consider
  // creating a skill. Click → opens settings → skills panel.
  if (!window.__aideagentSkillListenerAttached) {
    window.__aideagentSkillListenerAttached = true;
    window.aideagent?.onPatternsDetected?.((/** @type {any} */ _event, /** @type {any} */ payload) => {
      const list = payload?.suggestions || [];
      if (!list.length) return;
      showSkillSuggestionToast(list);
    });
  }

  // Phase 2 listener: when the main process finishes a background translation
  // batch, re-render the skill list to surface the newly-translated Chinese
  // names without a page reload.
  if (!window.__aideagentTranslationListenerAttached) {
    window.__aideagentTranslationListenerAttached = true;
    /** @type {any} */
    const _api = window.aideagent;
    _api?.onTranslationsUpdated?.((/** @type {any} */ _event, /** @type {any} */ payload) => {
      const n = payload?.count || 0;
      if (n > 0 && _skillsPanelLoaded) {
        loadAndRenderSkills().catch((e) => console.warn("[skills] re-render after translation failed:", e));
      }
    });
  }

  await refreshSkillsList();
}

// ── Skill suggestion toast (Phase 2) ─────────────────────────────────────

/**
 * Show a small floating toast notifying the user that the agent detected
 * repeated-task patterns from recent sessions. Click to open skills panel.
 * @param {Array<{phrase: string, count: number, examples: string[]}>} suggestions
 */
function showSkillSuggestionToast(suggestions) {
  // Avoid stacking: replace any existing toast.
  const existing = document.getElementById("skill-suggestion-toast");
  if (existing) existing.remove();

  const top = suggestions[0];
  const text = suggestions.length === 1
    ? `💡 检测到重复模式 "${top.phrase}"（出现 ${top.count} 次），可提炼为技能`
    : `💡 检测到 ${suggestions.length} 个重复任务模式，可提炼为技能`;

  const toast = document.createElement("div");
  toast.id = "skill-suggestion-toast";
  toast.textContent = text;
  toast.style.cssText = [
    "position:fixed", "right:24px", "bottom:24px", "z-index:9999",
    "max-width:360px", "padding:12px 16px", "border-radius:8px",
    "background:#1f2937", "color:#f3f4f6", "box-shadow:0 6px 20px rgba(0,0,0,.35)",
    "font-size:13px", "line-height:1.4", "cursor:pointer",
    "border:1px solid #374151", "transition:opacity .25s",
  ].join(";");
  toast.title = "点击打开技能面板";
  toast.onclick = () => {
    toast.remove();
    // Open settings panel and switch to skills tab
    document.getElementById("settings-btn")?.click();
    setTimeout(() => {
      document.querySelectorAll(".settings-tab").forEach((el) => {
        if (el instanceof HTMLElement && /技能|skills/i.test(el.textContent || "")) el.click();
      });
    }, 200);
  };
  document.body.appendChild(toast);
  // Auto-dismiss after 12s
  setTimeout(() => { if (toast.parentNode) toast.remove(); }, 12000);
}

/** Refresh the L2 skills list, patterns card, and curator info bar. */
export async function refreshSkillsList() {
  const container = document.getElementById("agent-skills-list");
  if (!container) return;
  try {
    const list = await window.aideagent.skillsListAll();
    const patterns = await window.aideagent.skillsDetectPatterns();
    const curator = await window.aideagent.skillsCuratorStatus();

    let html = '';
    if (curator) {
      const lastRunText = curator.lastRun && curator.lastRun !== "never" ? new Date(curator.lastRun).toLocaleString("zh-CN") : t("agent_skills.never_run");
      html += '<div class="curator-info-bar">' +
        '<div class="curator-info-stats">' +
          '<span>' + t("agent_skills.active") + ' <b>' + curator.activeSkills + '</b></span>' +
          '<span class="curator-info-sep">·</span>' +
          '<span>' + t("agent_skills.archived") + ' ' + curator.archivedSkills + '</span>' +
          '<span class="curator-info-sep">·</span>' +
          '<span>' + t("agent_skills.last_run") + ' ' + lastRunText + '</span>' +
          (curator.pendingMerges?.length ? '<span class="curator-info-warn">⚠ ' + curator.pendingMerges.length + ' ' + t("agent_skills.mergeable") + '</span>' : '') +
        '</div>' +
        '<button class="btn btn-xs" id="curator-run-btn">' + t("agent_skills.run_curator") + '</button>' +
      '</div>';
    }

    if (patterns?.length) {
      html += '<div class="patterns-card"><div class="patterns-card-header">' + t("agent_skills.patterns_title") + '</div>';
      for (const p of patterns) {
        html += '<div class="patterns-item"><span><b>' + sanitize(p.phrase) + '</b> — ' + t("agent_skills.occurred") + ' ' + p.count + ' ' + t("agent_skills.times") + '</span><button class="btn btn-xs primary generate-skill-btn" data-phrase="' + sanitize(p.phrase) + '">' + t("agent_skills.generate") + '</button></div>';
      }
      html += '</div>';
    }

    if (!list?.length && !patterns?.length) {
      html += '<div class="skill-card skill-card-empty">' + t("agent_skills.empty") + '</div>';
    } else {
      html += (list || []).map(s => {
        const isActive = s.status === "active";
        return `<div class="skill-card"><div class="skill-card-header"><div class="skill-card-name"><label class="skill-toggle"><input type="checkbox" class="skill-toggle-input" data-skill="${sanitize(s.name)}" ${isActive ? 'checked' : ''} /><span class="skill-toggle-slider"></span></label><span>${sanitize(s.name)}</span></div><div class="skill-card-actions"><button class="btn btn-xs skill-delete-btn" data-skill="${sanitize(s.name)}" style="color:#ef4444;">${t("agent_skills.delete")}</button></div></div><div class="skill-card-desc">${sanitize(s.description || "")}</div></div>`;
      }).join("");
    }
    container.innerHTML = html;

    const countEl = document.getElementById("agent-skills-count");
    if (countEl) countEl.textContent = t("skills.count").replace("{count}", String((list || []).length));

    const curatorRunBtn = /** @type {HTMLButtonElement | null} */ (document.getElementById("curator-run-btn"));
    curatorRunBtn?.addEventListener("click", async () => {
      if (!curatorRunBtn) return;
      curatorRunBtn.disabled = true; curatorRunBtn.textContent = t("thinking.running");
      try {
        const result = await window.aideagent.skillsCuratorRun();
        alert(t("agent_skills.curator_done").replace("{archived}", String(result.archived)).replace("{dupes}", String(result.dupes)));
        await refreshSkillsList();
      } catch (e) { alert(t("agent_skills.curator_fail").replace("{error}", /** @type {Error} */ (e).message)); }
      curatorRunBtn.disabled = false; curatorRunBtn.textContent = t("agent_skills.run_curator");
    });

    container.querySelectorAll(".generate-skill-btn").forEach((node) => {
      const btn = /** @type {HTMLButtonElement} */ (node);
      btn.addEventListener("click", async () => {
        const phrase = btn.dataset.phrase;
        if (!phrase) return;
        btn.disabled = true; btn.textContent = t("agent_skills.generating");
        try {
          const cfg = loadApiConfig();
          let url = (cfg.apiUrl || "").replace(/\/+$/, "");
          if (!url.includes("/chat/completions")) { if (!url.endsWith("/v1")) url += "/v1"; url += "/chat/completions"; }
          const res = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json", "Authorization": "Bearer " + (cfg.apiKey || "") },
            body: JSON.stringify({
              model: cfg.model || "deepseek-chat",
              messages: [
                { role: "system", content: "You are a skill generator. Output ONLY valid markdown with YAML frontmatter." },
                { role: "user", content: "Create a reusable skill for: " + phrase + ". This is a repeated pattern in conversations." }
              ],
              max_tokens: 2048,
            }),
            signal: AbortSignal.timeout(30000),
          });
          if (!res.ok) throw new Error("API " + res.status);
          const data = await res.json();
          const skillText = data.choices?.[0]?.message?.content || "";
          const nameMatch = skillText.match(/name:\s*(\S+)/);
          const descMatch = skillText.match(/description:\s*"([^"]+)"/);
          const name = nameMatch?.[1] || phrase.replace(/\s+/g, "-").toLowerCase().slice(0, 30);
          await window.aideagent.skillsSaveSkill(name, { name, description: (descMatch?.[1] || phrase), triggers: [phrase], version: "1.0.0", status: "active", created_at: new Date().toISOString() }, skillText);
          await refreshSkillsList();
        } catch (e) { alert(t("agent_skills.generate_fail").replace("{error}", /** @type {Error} */ (e).message)); }
        btn.disabled = false; btn.textContent = t("agent_skills.generate");
      });
    });

    container.querySelectorAll(".skill-toggle-input").forEach((node) => {
      const toggle = /** @type {HTMLInputElement} */ (node);
      toggle.addEventListener("change", async () => {
        try { await window.aideagent.skillsSetStatus(toggle.dataset.skill || "", toggle.checked ? "active" : "archived"); } catch {}
      });
    });

    container.querySelectorAll(".skill-delete-btn").forEach((node) => {
      const btn = /** @type {HTMLButtonElement} */ (node);
      btn.addEventListener("click", async () => {
        const skillName = btn.dataset.skill;
        if (!skillName) return;
        if (!confirm(t("agent_skills.delete_confirm").replace("{name}", skillName))) return;
        await window.aideagent.skillsDelete(skillName);
        await refreshSkillsList();
      });
    });
  } catch (err) {
    console.error("[skills-panel] load error:", err);
  }
}

// ── Skill Editor Modal ──

/**
 * Populate the editor modal with an existing skill's metadata + body.
 * @param {string} name
 */
async function openSkillEditor(name) {
  const overlay = document.getElementById("skill-editor-overlay");
  const titleEl = document.getElementById("skill-editor-title");
  const nameEl = /** @type {HTMLInputElement | null} */ (document.getElementById("skill-editor-name"));
  const descEl = /** @type {HTMLInputElement | null} */ (document.getElementById("skill-editor-desc"));
  const triggersEl = /** @type {HTMLInputElement | null} */ (document.getElementById("skill-editor-triggers"));
  const bodyEl = /** @type {HTMLTextAreaElement | null} */ (document.getElementById("skill-editor-body"));
  const statusEl = document.getElementById("skill-editor-status");
  if (!overlay || !nameEl) return;

  try {
    if (statusEl) {
      statusEl.className = "settings-status";
      statusEl.textContent = t("agent_skills.loading");
      statusEl.classList.remove("hidden");
    }
    let skill = await window.aideagent.skillsLoadOne(name);
    if (!skill) skill = await window.aideagent.loadSkill(name);
    if (!skill) throw new Error(t("skill_editor.not_found"));
    if (titleEl) titleEl.textContent = `${t("skill_editor.title")}: ${skill.name || name}`;
    nameEl.value = skill.name || name;
    if (descEl) descEl.value = skill.description || "";
    if (triggersEl) triggersEl.value = (skill.triggers || []).join(", ");
    if (bodyEl) bodyEl.value = skill.body || "";
    overlay.dataset.editName = name;
    overlay.dataset.editSource = skill.source || "local";
    overlay.classList.remove("hidden");
    if (statusEl) statusEl.classList.add("hidden");
  } catch (err) {
    if (statusEl) {
      statusEl.textContent = t("skill_editor.load_fail").replace("{error}", /** @type {Error} */ (err).message);
      statusEl.className = "settings-status error";
      statusEl.classList.remove("hidden");
    }
  }
}

/**
 * Download a skill as a `.skill.json` file.
 * @param {string} name
 */
async function exportSkillAsJson(name) {
  try {
    let skill = await window.aideagent.skillsLoadOne(name);
    if (!skill) skill = await window.aideagent.loadSkill(name);
    if (!skill) throw new Error(t("skill_editor.not_found"));
    const json = JSON.stringify({ name: skill.name, description: skill.description, triggers: skill.triggers || [], body: skill.body || "" }, null, 2);
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = `${skill.name || name}.skill.json`; a.click();
    URL.revokeObjectURL(url);
  } catch (err) { alert(t("skill_editor.export_fail").replace("{error}", /** @type {Error} */ (err).message)); }
}

// ── Init (self-registering event listeners) ──

document.getElementById("skills-refresh-btn")?.addEventListener("click", loadAndRenderSkills);

document.querySelector('.settings-tab[data-tab="skills"]')?.addEventListener("click", () => {
  const listEl = document.getElementById("local-skills-list");
  if (listEl && (listEl.children.length === 0 || listEl.querySelector(".skills-empty, .skills-loading"))) loadAndRenderSkills();
});

document.querySelector('.settings-tab[data-tab="agent-skills"]')?.addEventListener("click", async () => {
  await loadSkillsPanel();
  loadCuratorConfig();
});

document.getElementById("curator-save-btn")?.addEventListener("click", async () => {
  const input = /** @type {HTMLInputElement | null} */ (document.getElementById("curator-days-input"));
  if (!input) return;
  const days = parseInt(input.value, 10);
  if (isNaN(days) || days < 1) { alert(t("kb.days_range")); return; }
  try {
    await window.aideagent.skillsCuratorConfig({ archiveAfterDays: days });
    loadCuratorConfig();
    const line = document.getElementById("curator-status-line");
    if (line) line.textContent += " ✅ " + t("misc.saved");
  } catch (e) { alert(t("skill_editor.save_fail").replace("{error}", /** @type {Error} */ (e).message)); }
});

document.addEventListener("click", async (e) => {
  const target = /** @type {HTMLElement} */ (/** @type {EventTarget} */ (e.target));
  const editBtn = target.closest(".skill-edit-btn");
  if (editBtn instanceof HTMLElement && editBtn.dataset.skill) { await openSkillEditor(editBtn.dataset.skill); return; }
  const exportBtn = target.closest(".skill-export-btn");
  if (exportBtn instanceof HTMLElement && exportBtn.dataset.skill) { await exportSkillAsJson(exportBtn.dataset.skill); return; }
}, false);

document.getElementById("skill-editor-close")?.addEventListener("click", () => document.getElementById("skill-editor-overlay")?.classList.add("hidden"));
document.getElementById("skill-editor-cancel")?.addEventListener("click", () => document.getElementById("skill-editor-overlay")?.classList.add("hidden"));
document.getElementById("skill-editor-overlay")?.addEventListener("click", (e) => {
  const ev = /** @type {MouseEvent} */ (e);
  if (ev.target === ev.currentTarget && ev.currentTarget instanceof HTMLElement) ev.currentTarget.classList.add("hidden");
});

document.getElementById("skill-editor-save")?.addEventListener("click", async () => {
  const overlay = document.getElementById("skill-editor-overlay");
  const nameEl = /** @type {HTMLInputElement | null} */ (document.getElementById("skill-editor-name"));
  const descEl = /** @type {HTMLInputElement | null} */ (document.getElementById("skill-editor-desc"));
  const triggersEl = /** @type {HTMLInputElement | null} */ (document.getElementById("skill-editor-triggers"));
  const bodyEl = /** @type {HTMLTextAreaElement | null} */ (document.getElementById("skill-editor-body"));
  const statusEl = document.getElementById("skill-editor-status");
  if (!overlay || !nameEl) return;
  const saveBtn = /** @type {HTMLButtonElement | null} */ (document.getElementById("skill-editor-save"));
  if (!saveBtn) return;
  const origText = saveBtn.textContent;
  saveBtn.disabled = true; saveBtn.textContent = t("misc.saving");
  try {
    const origName = overlay.dataset.editName;
    const name = nameEl.value.trim();
    if (!name) throw new Error(t("skill_editor.name_required"));
    const triggers = (triggersEl?.value || "").split(",").map(s => s.trim()).filter(Boolean);
    const meta = { name, description: descEl?.value.trim() || "", triggers, ...(origName !== name ? { _origin: origName } : {}) };
    await window.aideagent.skillsSaveSkill(name, meta, bodyEl?.value || "");
    overlay.classList.add("hidden");
    refreshSkillsList();
  } catch (err) {
    if (statusEl) {
      statusEl.textContent = t("skill_editor.save_fail").replace("{error}", /** @type {Error} */ (err).message);
      statusEl.className = "settings-status error";
      statusEl.classList.remove("hidden");
    }
  } finally { saveBtn.disabled = false; saveBtn.textContent = origText; }
});

document.getElementById("agent-skills-import-btn")?.addEventListener("click", () => {
  const input = document.createElement("input");
  input.type = "file"; input.accept = ".json";
  input.onchange = async () => {
    const file = input.files?.[0];
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      if (!data.body && !data.steps) throw new Error(t("skill_editor.invalid_file"));
      const meta = { name: data.name || file.name.replace(/\.[^.]+$/, ""), description: data.description || "", triggers: data.triggers || [] };
      const body = data.body || (Array.isArray(data.steps) ? data.steps.map((/** @type {any} */ s, /** @type {number} */ i) => `${i + 1}. ${s}`).join("\n") : "");
      await window.aideagent.skillsSaveSkill(meta.name, meta, body);
      refreshSkillsList();
    } catch (err) { alert(t("skill_editor.import_fail").replace("{error}", /** @type {Error} */ (err).message)); }
  };
  input.click();
});

document.getElementById("agent-skills-refresh-btn")?.addEventListener("click", () => { _skillsPanelLoaded = false; loadSkillsPanel(); });

document.addEventListener("click", function(e) {
  const target = /** @type {HTMLElement} */ (/** @type {EventTarget} */ (e.target));
  const btn = target.closest("#skill-create-btn");
  if (!btn || !(btn instanceof HTMLElement)) return;
  const form = document.getElementById("skill-create-form");
  if (form) { form.classList.remove("hidden"); btn.style.display = "none"; }
}, true);
