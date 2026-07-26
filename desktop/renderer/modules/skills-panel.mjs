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

// ── Display name resolution (3-tier fallback) ──────────────────────────
//
// Why this lives in the renderer too (not just skills-store.mjs): the main
// process IPC bridge would add a round-trip on every render. The heuristic
// is a pure function with no I/O, so duplicating it here is cheap and lets
// the UI keep working even if the main process IPC is briefly unavailable.
// The main-process copy in skills-store.mjs is the source of truth for any
// non-renderer caller (e.g. curator, future CLI).

/**
 * Resolve a skill's Chinese display name with a 3-tier fallback that
 * ALWAYS returns a non-empty string:
 *   1. SKILL.md frontmatter `name_zh` (author-declared, zero dependency)
 *   2. Per-user cache from `~/.aideagent/skill-translations.json`
 *   3. Heuristic kebab→readable transformation
 * @param {{name: string, name_zh?: string}} skill
 * @param {Object<string, string>} [cache]  optional pre-loaded cache
 * @returns {{display: string, source: "skill_zh"|"cache"|"heuristic"}}
 */
function resolveDisplayName(skill, cache) {
  const name = (skill && skill.name) || "";
  const author_zh = typeof skill?.name_zh === "string" ? skill.name_zh.trim() : "";
  if (author_zh) return { display: author_zh, source: "skill_zh" };
  const cached = (cache || {})[name];
  if (typeof cached === "string" && cached.trim()) return { display: cached.trim(), source: "cache" };
  return { display: heuristicDisplayName(name), source: "heuristic" };
}

/** Heuristic kebab-case → readable Chinese-friendly name. Never returns "". */
function heuristicDisplayName(name) {
  if (!name) return "";
  if (name === "cli-anything") return "CLI 通用工具";
  if (name.startsWith("cli-anything-")) {
    const rest = name.slice("cli-anything-".length);
    return `${titleCaseRest(rest)} 命令行`;
  }
  return titleCaseRest(name);
}

/** Title-case a kebab token, preserving embedded acronyms. */
function titleCaseRest(s) {
  if (!s) return "";
  return s.split("-").filter(Boolean)
    .map((w) => /[A-Z]/.test(w) ? w : w[0].toUpperCase() + w.slice(1))
    .join(" ");
}

// ── Import skill into chat input (Stage 4) ──────────────────────

/**
 * Insert text at the current cursor position in #prompt-input,
 * preserving any selection / surrounding text. Triggers an `input` event
 * so auto-resize + char-counter pick up the change.
 * @param {string} text
 * @returns {boolean} true if inserted, false if input box not found
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
      updateToggleAllButton();
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
      const { display: zh, source: zhSource } = resolveDisplayName(s, translations);
      // Heuristic fallbacks always get the ⚠ marker so the user knows the
      // name is a placeholder and can fix it. Cache and author-declared
      // names are not flagged.
      const zhFlag = zhSource === "heuristic"
        ? `<span class="skill-card-zh-flag" title="自动生成的占位名 — 点击 ✎ 修正">⚠</span>`
        : "";
      return `<div class="skill-card">
        <div class="skill-card-info">
          <div class="skill-card-name">${sanitize(s.name)}</div>
          <div class="skill-card-name-zh" data-source="${zhSource}">
            <span class="skill-card-zh-text">${sanitize(zh)}</span>
            ${zhFlag}
            <button class="skill-card-zh-edit" data-skill="${sanitize(s.name)}" title="编辑中文名" aria-label="编辑中文名">✎</button>
          </div>
          <div class="skill-card-meta">
            <span class="skill-card-source">${s.source === "agents" ? "🤖 .agents" : "📦 .claude"}</span>
            ${s.version ? `<span class="skill-card-version">v${sanitize(s.version)}</span>` : ""}
            ${s.triggers && s.triggers.length > 0 ? `<span class="skill-card-triggers">${t("skills.triggers")} ${sanitize(s.triggers.slice(0, 3).join(", "))}</span>` : ""}
            ${s.allowedTools && s.allowedTools.length > 0 ? `<span class="skill-card-tools">${s.allowedTools.length} ${t("skills.tools_count")}</span>` : ""}
          </div>
        </div>
        <div class="skill-card-actions">
          <button class="skill-card-import" data-skill="${sanitize(s.name)}" title="${t("skills.import_btn_title") || "导入到输入框"}">
            ${t("skills.import_btn") || "📥 导入"}
          </button>
          <label class="skill-toggle">
            <input type="checkbox" class="skill-toggle-input" data-skill="${sanitize(s.name)}" ${isOn ? "checked" : ""} />
            <span class="skill-toggle-slider"></span>
          </label>
        </div>
      </div>`;
    }).join("");

    // Wire up the per-card "✎ edit Chinese name" buttons. Uses a delegated
    // listener so re-renders don't need to re-bind.
    listEl.querySelectorAll(".skill-card-zh-edit").forEach((node) => {
      const btn = /** @type {HTMLButtonElement} */ (node);
      btn.addEventListener("click", (ev) => {
        ev.stopPropagation();
        const name = btn.dataset.skill;
        if (!name) return;
        editSkillDisplayName(name, btn);
      });
    });

    // Wire up the per-card "导入到输入框" buttons (Stage 4).
    // Inserts the skill name (with a leading "/") at the chat input cursor
    // position. The agent's `skill` tool sees this reference and loads
    // the SKILL.md body itself — no need to dump the full markdown into
    // the chat. Format: "/<skill_name>" (matches Anthropic's slash-
    // command convention).
    listEl.querySelectorAll(".skill-card-import").forEach((node) => {
      const btn = /** @type {HTMLButtonElement} */ (node);
      btn.addEventListener("click", async (ev) => {
        ev.stopPropagation();
        const name = btn.dataset.skill;
        if (!name) return;
        btn.disabled = true;
        const original = btn.textContent;
        btn.textContent = t("skills.import_btn_loading") || "导入中...";
        try {
          const reference = `/${name}`;
          const ok = insertIntoPromptInput(reference);
          if (ok) {
            btn.textContent = t("skills.import_btn_done") || "✅ 已导入";
            setTimeout(() => { btn.textContent = original; }, 1500);
          }
        } catch (/** @type {any} */ e) {
          alert((t("skills.import_failed") || "导入失败：") + (e?.message || String(e)));
        } finally {
          btn.disabled = false;
        }
      });
    });

    listEl.querySelectorAll(".skill-toggle-input").forEach((node) => {
      const cb = /** @type {HTMLInputElement} */ (node);
      cb.addEventListener("change", () => {
        const name = cb.dataset.skill;
        if (!name) return;
        const en = loadEnabledSkills();
        if (cb.checked) { if (!en.includes(name)) en.push(name); }
        else { const idx = en.indexOf(name); if (idx >= 0) en.splice(idx, 1); }
        saveEnabledSkills(en);
        updateToggleAllButton();
      });
    });

    // Wire up the "toggle all" button (one-click enable / disable all visible skills).
    // Smart label: if any skill is OFF → label is "一键开启" (turn them all on);
    // if every skill is ON → label is "全部关闭" (turn them all off).
    const toggleAllBtn = document.getElementById("skills-toggle-all-btn");
    if (toggleAllBtn) {
      toggleAllBtn.onclick = () => {
        const allBoxes = Array.from(listEl.querySelectorAll(".skill-toggle-input"));
        if (allBoxes.length === 0) return;
        const allOn = allBoxes.every((cb) => /** @type {HTMLInputElement} */ (cb).checked);
        const target = !allOn; // if all on → turn all off; otherwise turn all on
        const enabled = loadEnabledSkills();
        for (const node of allBoxes) {
          const cb = /** @type {HTMLInputElement} */ (node);
          cb.checked = target;
          const name = cb.dataset.skill;
          if (!name) continue;
          if (target) { if (!enabled.includes(name)) enabled.push(name); }
          else { const idx = enabled.indexOf(name); if (idx >= 0) enabled.splice(idx, 1); }
        }
        saveEnabledSkills(enabled);
        updateToggleAllButton();
      };
    }
    updateToggleAllButton();

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
 * Inline editor for a single skill's Chinese display name. Replaces the
 * static text node with an <input> + ✓ save / ✗ cancel pair so the user
 * can type a new name. Why inline and not `window.prompt`? Electron 30+
 * removed `window.prompt` (returns null silently), so the only way to get
 * editable text in a renderer is to build the input yourself. This also
 * gives us free styling, keyboard shortcuts (Enter / Esc), and the option
 * to clear the cache by submitting an empty value.
 *
 * @param {string} name  skill name (kebab-case key in skill-translations.json)
 * @param {HTMLButtonElement} btn  the ✎ button that triggered the edit
 */
async function editSkillDisplayName(name, btn) {
  /** @type {any} */
  const api = window.aideagent;
  if (!api?.skillsTranslationSet) return;
  const card = btn.closest(".skill-card");
  const textEl = /** @type {HTMLElement | null} */ (card?.querySelector(".skill-card-zh-text"));
  const container = /** @type {HTMLElement | null} */ (card?.querySelector(".skill-card-name-zh"));
  if (!card || !textEl || !container) return;
  // Already editing this card? Just refocus the existing input.
  const existingInput = /** @type {HTMLInputElement | null} */ (container.querySelector(".skill-card-zh-input"));
  if (existingInput) { existingInput.focus(); existingInput.select(); return; }

  const current = textEl.textContent || "";

  // Build the editor widgets.
  const input = document.createElement("input");
  input.type = "text";
  input.className = "skill-card-zh-input";
  input.value = current;
  input.maxLength = 30;
  input.placeholder = "输入中文名（留空清除自定义）";
  input.spellcheck = false;

  const saveBtn = document.createElement("button");
  saveBtn.className = "skill-card-zh-save";
  saveBtn.type = "button";
  saveBtn.textContent = "✓";
  saveBtn.title = "保存 (Enter)";

  const cancelBtn = document.createElement("button");
  cancelBtn.className = "skill-card-zh-cancel";
  cancelBtn.type = "button";
  cancelBtn.textContent = "✗";
  cancelBtn.title = "取消 (Esc)";

  // Swap static text for the editor. The flag and the edit button get
  // hidden so only the input + ✓/✗ remain visible.
  textEl.replaceWith(input);
  container.appendChild(saveBtn);
  container.appendChild(cancelBtn);
  const flag = container.querySelector(".skill-card-zh-flag");
  if (flag) /** @type {HTMLElement} */ (flag).style.display = "none";
  btn.style.display = "none";

  input.focus();
  input.select();

  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    // Restore the original DOM nodes.
    if (input.parentNode) input.replaceWith(textEl);
    saveBtn.remove();
    cancelBtn.remove();
    if (flag) /** @type {HTMLElement} */ (flag).style.display = "";
    btn.style.display = "";
  };

  const save = async () => {
    if (cleaned) return;
    const trimmed = input.value.trim();
    // No-op when the user re-submitted the same non-heuristic value.
    const source = container.getAttribute("data-source");
    if (trimmed === current.trim() && source !== "heuristic") { cleanup(); return; }
    saveBtn.disabled = true; cancelBtn.disabled = true; input.disabled = true;
    try {
      const result = await api.skillsTranslationSet(name, trimmed);
      if (!result?.ok) {
        alert(`保存失败：${result?.error || "未知错误"}`);
        saveBtn.disabled = false; cancelBtn.disabled = false; input.disabled = false;
        input.focus();
        return;
      }
      // Main process broadcasts "skills:translations-updated" → re-render.
      // Don't cleanup here: the re-render replaces the whole card, so the
      // editor widgets go away naturally.
    } catch (e) {
      alert(`保存失败：${/** @type {Error} */ (e).message}`);
      saveBtn.disabled = false; cancelBtn.disabled = false; input.disabled = false;
      input.focus();
    }
  };

  const cancel = () => cleanup();

  saveBtn.addEventListener("click", save);
  cancelBtn.addEventListener("click", cancel);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); save(); }
    else if (e.key === "Escape") { e.preventDefault(); cancel(); }
  });
  // Save on blur (clicking elsewhere). Delay so a click on ✓/✗ lands first.
  input.addEventListener("blur", () => {
    if (cleaned) return;
    setTimeout(() => {
      if (!cleaned && document.contains(input)) save();
    }, 180);
  });
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

/**
 * Update the "toggle all" button label and icon based on the current state of
 * the visible skill toggles. Label: "一键开启" (turn all on) if any are off,
 * "全部关闭" (turn all off) if every one is on. The icon flips between a
 * check-all mark and an x-circle so the affordance reads clearly.
 */
function updateToggleAllButton() {
  const listEl = document.getElementById("local-skills-list");
  const label = document.getElementById("skills-toggle-all-label");
  const icon = document.getElementById("skills-toggle-all-icon");
  if (!listEl || !label) return;
  const boxes = Array.from(listEl.querySelectorAll(".skill-toggle-input"));
  if (boxes.length === 0) {
    label.textContent = t("skills.toggle_all_on");
    if (icon) icon.innerHTML = "<polyline points=\"20 6 9 17 4 12\"/>";
    return;
  }
  const allOn = boxes.every((cb) => /** @type {HTMLInputElement} */ (cb).checked);
  label.textContent = allOn ? t("skills.toggle_all_off") : t("skills.toggle_all_on");
  if (icon) {
    icon.innerHTML = allOn
      ? "<circle cx=\"12\" cy=\"12\" r=\"10\"/><line x1=\"15\" y1=\"9\" x2=\"9\" y2=\"15\"/><line x1=\"9\" y1=\"9\" x2=\"15\" y2=\"15\"/>"
      : "<polyline points=\"20 6 9 17 4 12\"/>";
  }
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
      html += '<div class="patterns-card"><div class="patterns-card-header"><span>' + t("agent_skills.patterns_title") + '</span><button class="btn btn-xs primary" id="auto-generate-all-btn" title="' + (t("agent_skills.generate_all_title") || "用 AI 一键提炼所有候选") + '">✨ ' + (t("agent_skills.generate_all") || "全部自动提炼") + '</button></div>';
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
          // Route through main process (skills:auto-generate) so the LLM
          // call gets the actual matching-session transcript as raw
          // material — the old in-renderer fetch only passed the bare
          // phrase, so the model had to guess what the task looked like.
          const cfg = loadApiConfig();
          /** @type {any} */
          const api = window.aideagent;
          const res = await api.skillsAutoGenerate?.(phrase, cfg);
          if (res?.saved) {
            btn.textContent = "✅ " + (t("agent_skills.generated_ok") || "已生成");
            await refreshSkillsList();
          } else if (res?.alreadyExisted) {
            btn.textContent = "⚠️ " + (t("agent_skills.already_exists") || "已存在");
          } else {
            throw new Error(res?.error || "unknown error");
          }
        } catch (e) { alert(t("agent_skills.generate_fail").replace("{error}", /** @type {Error} */ (e).message)); }
        btn.disabled = false; btn.textContent = t("agent_skills.generate");
      });
    });

    // Sweep-all button: walks every detected candidate phrase in one shot
    // and saves a SKILL.md for each. Per-result feedback in alert form so
    // the user knows which phrases succeeded / failed / already existed.
    const genAllBtn = /** @type {HTMLButtonElement | null} */ (document.getElementById("auto-generate-all-btn"));
    genAllBtn?.addEventListener("click", async () => {
      if (!genAllBtn) return;
      genAllBtn.disabled = true;
      const original = genAllBtn.textContent;
      genAllBtn.textContent = t("agent_skills.generating");
      try {
        const cfg = loadApiConfig();
        /** @type {any} */
        const api = window.aideagent;
        /** @type {any[]} */
        const results = await api.skillsAutoGenerateAll?.(cfg) || [];
        const saved = results.filter((/** @type {any} */ r) => r.saved).length;
        const existed = results.filter((/** @type {any} */ r) => r.alreadyExisted).length;
        const failed = results.length - saved - existed;
        const msg = (t("agent_skills.generate_all_summary") || "已生成 {saved} 个 / 已存在 {existed} 个 / 失败 {failed} 个")
          .replace("{saved}", String(saved))
          .replace("{existed}", String(existed))
          .replace("{failed}", String(failed));
        alert(msg);
        if (saved > 0) await refreshSkillsList();
      } catch (e) { alert(t("agent_skills.generate_fail").replace("{error}", /** @type {Error} */ (e).message)); }
      genAllBtn.disabled = false; genAllBtn.textContent = original;
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
