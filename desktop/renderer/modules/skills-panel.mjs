import { sanitize } from './helpers.mjs';

function loadApiConfig() {
  return {
    provider: localStorage.getItem("goodagent_provider") || "",
    apiUrl: localStorage.getItem("goodagent_api_url") || "",
    apiKey: localStorage.getItem("goodagent_api_key") || "",
    model: localStorage.getItem("goodagent_model") || "",
    apiFormat: localStorage.getItem("goodagent_api_format") || "openai",
  };
}

const SKILLS_KEY = "goodagent_enabled_skills";
let _skillsPanelLoaded = false;

// ── L3 Skills (scanned from .agents/.claude) ──

export async function loadAndRenderSkills() {
  const listEl = document.getElementById("local-skills-list");
  const countEl = document.getElementById("skills-count");
  if (!listEl) return;
  try {
    listEl.innerHTML = `<div class="skills-loading">${t("skills.scanning")}</div>`;
    const skills = await window.goodAgent.listSkills();
    if (!skills || skills.length === 0) {
      listEl.innerHTML = `<div class="skills-empty">${t("skills.empty")}</div>`;
      if (countEl) countEl.textContent = t("skills.count").replace("{count}", 0);
      return;
    }
    if (countEl) countEl.textContent = t("skills.count").replace("{count}", skills.length);

    const enabled = loadEnabledSkills();

    listEl.innerHTML = skills.map(s => {
      const isOn = enabled.includes(s.name);
      return `<div class="skill-card">
        <div class="skill-card-info">
          <div class="skill-card-name">${sanitize(s.name)}</div>
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

    listEl.querySelectorAll(".skill-toggle-input").forEach(cb => {
      cb.addEventListener("change", () => {
        const name = cb.dataset.skill;
        const en = loadEnabledSkills();
        if (cb.checked) { if (!en.includes(name)) en.push(name); }
        else { const idx = en.indexOf(name); if (idx >= 0) en.splice(idx, 1); }
        saveEnabledSkills(en);
      });
    });
  } catch (err) {
    console.error("[skills] load error:", err);
    listEl.innerHTML = `<div class="skills-empty" style="color:var(--danger);">${t("skills.load_error")}</div>`;
  }
}

export function loadEnabledSkills() {
  try { return JSON.parse(localStorage.getItem(SKILLS_KEY) || "[]"); } catch { return []; }
}

function saveEnabledSkills(skills) {
  try { localStorage.setItem(SKILLS_KEY, JSON.stringify(skills)); } catch {}
}

// ── L2 Skills Panel (managed in SQLite) ──

async function loadCuratorConfig() {
  try {
    const status = await window.goodAgent.skillsCuratorStatus();
    const el = document.getElementById("curator-days-input");
    const line = document.getElementById("curator-status-line");
    if (el) el.value = status.archiveAfterDays ?? 30;
    if (line) {
      const locale = typeof getLang === "function" ? (getLang() === "en" ? "en-US" : "zh-CN") : "zh-CN";
      const lastRun = status.lastRun ? new Date(status.lastRun).toLocaleString(locale) : t("agent_skills.never_run");
      line.textContent = `${status.activeSkills} ${t("agent_skills.active")}, ${status.archivedSkills} ${t("agent_skills.archived")} | ${t("agent_skills.last_run")} ${lastRun}`;
    }
  } catch {}
}

export async function loadSkillsPanel() {
  if (_skillsPanelLoaded) return;
  _skillsPanelLoaded = true;

  const createBtn = document.getElementById("skill-create-btn");
  const createForm = document.getElementById("skill-create-form");
  if (createBtn && createForm) {
    createBtn.onclick = () => { createForm.classList.remove("hidden"); createBtn.style.display = "none"; };
    document.getElementById("sk-cancel").onclick = () => { createForm.classList.add("hidden"); createBtn.style.display = ""; };
    document.getElementById("sk-save").onclick = async () => {
      const name = document.getElementById("sk-name")?.value?.trim();
      const desc = document.getElementById("sk-desc")?.value?.trim();
      const steps = document.getElementById("sk-steps")?.value?.trim();
      if (!name || !desc) return;
      try {
        await window.goodAgent.skillsSaveSkill(name, { name, description: desc, triggers: [name], version: "1.0.0", status: "active", created_at: new Date().toISOString() }, "## Steps\n" + (steps || "1. ") + "\n\n## Notes\n- 手动创建");
        createForm.style.display = "none"; createBtn.style.display = "";
        _skillsPanelLoaded = false; await loadSkillsPanel();
      } catch (e) { alert(t("skill_editor.save_fail").replace("{error}", e.message)); }
    };
  }

  await refreshSkillsList();
}

export async function refreshSkillsList() {
  const container = document.getElementById("agent-skills-list");
  if (!container) return;
  try {
    const list = await window.goodAgent.skillsListAll();
    const patterns = await window.goodAgent.skillsDetectPatterns();
    const curator = await window.goodAgent.skillsCuratorStatus();

    let html = '';
    if (curator) {
      const lastRunText = curator.lastRun !== "never" ? new Date(curator.lastRun).toLocaleString("zh-CN") : t("agent_skills.never_run");
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
        return `<div class="skill-card"><div class="skill-card-header"><div class="skill-card-name"><label class="skill-toggle"><input type="checkbox" class="skill-toggle-input" data-skill="${sanitize(s.name)}" ${isActive ? 'checked' : ''} /><span class="skill-toggle-slider"></span></label><span>${sanitize(s.name)}</span></div><div class="skill-card-actions"><button class="btn btn-xs skill-delete-btn" data-skill="${s.name}" style="color:#ef4444;">${t("agent_skills.delete")}</button></div></div><div class="skill-card-desc">${sanitize(s.description)}</div></div>`;
      }).join("");
    }
    container.innerHTML = html;

    const countEl = document.getElementById("agent-skills-count");
    if (countEl) countEl.textContent = t("skills.count").replace("{count}", (list || []).length);

    document.getElementById("curator-run-btn")?.addEventListener("click", async () => {
      const btn = document.getElementById("curator-run-btn");
      btn.disabled = true; btn.textContent = t("thinking.running");
      try {
        const result = await window.goodAgent.skillsCuratorRun();
        alert(t("agent_skills.curator_done").replace("{archived}", result.archived).replace("{dupes}", result.dupes));
        await refreshSkillsList();
      } catch (e) { alert(t("agent_skills.curator_fail").replace("{error}", e.message)); }
      btn.disabled = false; btn.textContent = t("agent_skills.run_curator");
    });

    container.querySelectorAll(".generate-skill-btn").forEach(btn => {
      btn.addEventListener("click", async () => {
        const phrase = btn.dataset.phrase;
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
          await window.goodAgent.skillsSaveSkill(name, { name, description: (descMatch?.[1] || phrase), triggers: [phrase], version: "1.0.0", status: "active", created_at: new Date().toISOString() }, skillText);
          await refreshSkillsList();
        } catch (e) { alert(t("agent_skills.generate_fail").replace("{error}", e.message)); }
        btn.disabled = false; btn.textContent = t("agent_skills.generate");
      });
    });

    container.querySelectorAll(".skill-toggle-input").forEach(toggle => {
      toggle.addEventListener("change", async () => {
        try { await window.goodAgent.skillsSetStatus(toggle.dataset.skill, toggle.checked ? "active" : "archived"); } catch {}
      });
    });

    container.querySelectorAll(".skill-delete-btn").forEach(btn => {
      btn.addEventListener("click", async () => {
        if (!confirm(t("agent_skills.delete_confirm").replace("{name}", btn.dataset.skill))) return;
        await window.goodAgent.skillsDelete(btn.dataset.skill);
        await refreshSkillsList();
      });
    });
  } catch (err) {
    console.error("[skills-panel] load error:", err);
  }
}

// ── Skill Editor Modal ──

async function openSkillEditor(name) {
  const overlay = document.getElementById("skill-editor-overlay");
  const titleEl = document.getElementById("skill-editor-title");
  const nameEl = document.getElementById("skill-editor-name");
  const descEl = document.getElementById("skill-editor-desc");
  const triggersEl = document.getElementById("skill-editor-triggers");
  const bodyEl = document.getElementById("skill-editor-body");
  const statusEl = document.getElementById("skill-editor-status");
  if (!overlay || !nameEl) return;

  try {
    statusEl.className = "settings-status";
    statusEl.textContent = t("agent_skills.loading");
    statusEl.classList.remove("hidden");
    let skill = await window.goodAgent.skillsLoadOne(name);
    if (!skill) skill = await window.goodAgent.loadSkill(name);
    if (!skill) throw new Error(t("skill_editor.not_found"));
    titleEl.textContent = `${t("skill_editor.title")}: ${skill.name || name}`;
    nameEl.value = skill.name || name;
    descEl.value = skill.description || "";
    triggersEl.value = (skill.triggers || []).join(", ");
    bodyEl.value = skill.body || "";
    overlay.dataset.editName = name;
    overlay.dataset.editSource = skill.source || "local";
    overlay.classList.remove("hidden");
    statusEl.classList.add("hidden");
  } catch (err) {
    statusEl.textContent = t("skill_editor.load_fail").replace("{error}", err.message);
    statusEl.className = "settings-status error";
    statusEl.classList.remove("hidden");
  }
}

async function exportSkillAsJson(name) {
  try {
    let skill = await window.goodAgent.skillsLoadOne(name);
    if (!skill) skill = await window.goodAgent.loadSkill(name);
    if (!skill) throw new Error(t("skill_editor.not_found"));
    const json = JSON.stringify({ name: skill.name, description: skill.description, triggers: skill.triggers || [], body: skill.body || "" }, null, 2);
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = `${skill.name || name}.skill.json`; a.click();
    URL.revokeObjectURL(url);
  } catch (err) { alert(t("skill_editor.export_fail").replace("{error}", err.message)); }
}

// ── Init (self-registering event listeners) ──

document.getElementById("skills-refresh-btn")?.addEventListener("click", loadAndRenderSkills);

document.querySelector('.settings-tab[data-tab="skills"]')?.addEventListener("click", () => {
  const listEl = document.getElementById("local-skills-list");
  if (listEl && (listEl.children.length === 0 || listEl.querySelector(".skills-empty, .skills-loading"))) loadAndRenderSkills();
});

document.querySelector('.settings-tab[data-tab="agent-skills"]')?.addEventListener("click", () => loadCuratorConfig());

document.getElementById("curator-save-btn")?.addEventListener("click", async () => {
  const input = document.getElementById("curator-days-input");
  if (!input) return;
  const days = parseInt(input.value, 10);
  if (isNaN(days) || days < 1) { alert(t("kb.days_range")); return; }
  try {
    await window.goodAgent.skillsCuratorConfig({ archiveAfterDays: days });
    loadCuratorConfig();
    const line = document.getElementById("curator-status-line");
    if (line) line.textContent += " ✅ " + t("misc.saved");
  } catch (e) { alert(t("skill_editor.save_fail").replace("{error}", e.message)); }
});

document.addEventListener("click", async (e) => {
  const editBtn = e.target.closest(".skill-edit-btn");
  if (editBtn) { await openSkillEditor(editBtn.dataset.skill); return; }
  const exportBtn = e.target.closest(".skill-export-btn");
  if (exportBtn) { await exportSkillAsJson(exportBtn.dataset.skill); return; }
}, false);

document.getElementById("skill-editor-close")?.addEventListener("click", () => document.getElementById("skill-editor-overlay")?.classList.add("hidden"));
document.getElementById("skill-editor-cancel")?.addEventListener("click", () => document.getElementById("skill-editor-overlay")?.classList.add("hidden"));
document.getElementById("skill-editor-overlay")?.addEventListener("click", (e) => { if (e.target === e.currentTarget) e.currentTarget.classList.add("hidden"); });

document.getElementById("skill-editor-save")?.addEventListener("click", async () => {
  const overlay = document.getElementById("skill-editor-overlay");
  const nameEl = document.getElementById("skill-editor-name");
  const descEl = document.getElementById("skill-editor-desc");
  const triggersEl = document.getElementById("skill-editor-triggers");
  const bodyEl = document.getElementById("skill-editor-body");
  const statusEl = document.getElementById("skill-editor-status");
  if (!overlay || !nameEl) return;
  const saveBtn = document.getElementById("skill-editor-save");
  const origText = saveBtn.textContent;
  saveBtn.disabled = true; saveBtn.textContent = t("misc.saving");
  try {
    const origName = overlay.dataset.editName;
    const name = nameEl.value.trim();
    if (!name) throw new Error(t("skill_editor.name_required"));
    const triggers = triggersEl.value.split(",").map(s => s.trim()).filter(Boolean);
    const meta = { name, description: descEl.value.trim(), triggers, ...(origName !== name ? { _origin: origName } : {}) };
    await window.goodAgent.skillsSaveSkill(name, meta, bodyEl.value);
    overlay.classList.add("hidden");
    if (typeof refreshSkillsList === "function") refreshSkillsList();
  } catch (err) {
    statusEl.textContent = t("skill_editor.save_fail").replace("{error}", err.message);
    statusEl.className = "settings-status error";
    statusEl.classList.remove("hidden");
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
      const body = data.body || (Array.isArray(data.steps) ? data.steps.map((s, i) => `${i + 1}. ${s}`).join("\n") : "");
      await window.goodAgent.skillsSaveSkill(meta.name, meta, body);
      if (typeof refreshSkillsList === "function") refreshSkillsList();
    } catch (err) { alert(t("skill_editor.import_fail").replace("{error}", err.message)); }
  };
  input.click();
});

document.getElementById("agent-skills-refresh-btn")?.addEventListener("click", () => { _skillsPanelLoaded = false; loadSkillsPanel(); });

document.addEventListener("click", function(e) {
  const btn = e.target.closest("#skill-create-btn");
  if (!btn) return;
  const form = document.getElementById("skill-create-form");
  if (form) { form.classList.remove("hidden"); btn.style.display = "none"; }
}, true);
