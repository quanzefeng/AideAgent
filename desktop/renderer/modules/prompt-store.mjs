// @ts-check — JSDoc-typed prompt profile manager.
// @ts-check — 带 JSDoc 类型注解的系统提示词多 profile 管理器。
/**
 * System Prompt Profile Management
 * --------------------------------------------------------------------------
 * 负责 settings → 提示词 tab 的多 profile 管理：
 *   - 从主进程加载/保存 profile 列表
 *   - 渲染左侧 profile chip 列表（点 chip 切换当前 profile）
 *   - 渲染右侧编辑器（name + content + enable/delete/save 按钮）
 *   - 新建/启用/删除 profile
 *
 * 状态全部封装在闭包内，外部只能通过返回的 4 个 API 操作。
 *
 * 元素约定（与 index.html 保持一致）：
 *   - #prompt-profile-selector — 左侧 chip 容器
 *   - #prompt-sections — 右侧编辑器容器
 *   - #prompt-name-input, #prompt-content-area, #prompt-enable-btn,
 *     #prompt-delete-btn, #prompt-save-btn — 编辑器内元素（动态生成）
 *   - #prompt-settings-status — 状态提示条
 */

import { sanitize } from './helpers.mjs';

/**
 * Factory that returns a small API for managing system-prompt profiles.
 * @param {{
 *   t: (key: string, vars?: Record<string, string | number>) => string,
 *   onConfirm: (message: string) => Promise<boolean>,
 * }} deps — injected translation helper and async confirm dialog.
 */
export function createPromptStore({ t, onConfirm }) {
  // ── Private state ──────────────────────────────────────
  /** @type {PromptStore | null} */
  let promptStore = null;
  /** @type {string | null} */
  let currentProfileId = null;
  let _promptDirty = false;

  // ── Helpers ────────────────────────────────────────────
  function getNextProfileName() {
    if (!promptStore) return t("prompt.created", {num: 1});
    const ids = Object.keys(promptStore.profiles);
    let max = 0;
    for (const id of ids) {
      const p = promptStore.profiles[id];
      const m = p.name && p.name.match(/(\d+)$/);
      if (m) {
        const n = parseInt(m[1], 10);
        if (n > max) max = n;
      }
    }
    return t("prompt.created", {num: max + 1});
  }

  function getCurrentProfile() {
    if (!promptStore || !promptStore.profiles) return null;
    return promptStore.profiles[currentProfileId] || null;
  }

  function renderProfileName(p, id) {
    // Default profile always uses t("prompt.default") dynamically
    if (id === "default") return sanitize(t("prompt.default"));
    // Check if name matches auto-generated pattern (e.g. "系统提示词1" / "System Prompt 1")
    const m = p.name && p.name.match(/^(系统提示词|System Prompt)\s*(\d+)$/i);
    if (m) return sanitize(t("prompt.created", {num: parseInt(m[2], 10)}));
    // Custom profile names displayed as-is
    return sanitize(p.name);
  }

  function htmlEncode(str) {
    const div = document.createElement("div");
    div.appendChild(document.createTextNode(str));
    return div.innerHTML;
  }

  function showPromptStatus(msg, type) {
    const el = document.getElementById("prompt-settings-status");
    if (!el) return;
    el.textContent = msg;
    el.className = "settings-status";
    if (type) el.classList.add(`settings-status--${type}`);
    setTimeout(() => { if (el.textContent === msg) el.className = "settings-status hidden"; }, 3000);
  }

  // ── Public API ─────────────────────────────────────────
  /** Load all prompt profiles from the main process and prime local state. */
  async function loadPromptStore() {
    try {
      promptStore = await window.aideagent.listPromptProfiles();
      if (!promptStore || !promptStore.profiles) {
        promptStore = { activeProfile: "default", profiles: {} };
      }
      currentProfileId = promptStore.activeProfile || "default";
      // Ensure default profile exists
      if (!promptStore.profiles["default"]) {
        promptStore.profiles["default"] = {
          id: "default", name: t("prompt.default"), enabled: true,
          content: await window.aideagent.getDefaultPrompt(),
        };
      }
      return promptStore;
    } catch (e) {
      console.error("[prompt] Failed to load profiles:", e);
      return null;
    }
  }

  function renderProfileSelector() {
    const container = document.getElementById("prompt-profile-selector");
    if (!container || !promptStore) return;
    const ids = Object.keys(promptStore.profiles);
    container.innerHTML = ids.map(id => {
      const p = promptStore.profiles[id];
      const active = id === currentProfileId ? " active" : "";
      return `<button class="prompt-profile-chip${active}" data-profile-id="${id}">
        ${renderProfileName(p, id)}
      </button>`;
    }).join("");

    // Bind click
    container.querySelectorAll(".prompt-profile-chip").forEach((node) => {
      const btn = /** @type {HTMLButtonElement} */ (node);
      btn.addEventListener("click", async () => {
        const id = btn.dataset.profileId;
        if (!id || id === currentProfileId) return;
        if (_promptDirty) await saveCurrentProfile();
        currentProfileId = id;
        if (promptStore) promptStore.activeProfile = id;
        await window.aideagent.activatePromptProfile(id);
        renderProfileSelector();
        renderPromptEditor();
      });
    });
  }

  async function saveCurrentProfile() {
    const profile = getCurrentProfile();
    if (!profile) return;
    // Read name input
    const nameInput = /** @type {HTMLInputElement | null} */ (document.getElementById("prompt-name-input"));
    if (nameInput && nameInput.value.trim()) {
      profile.name = nameInput.value.trim();
    }
    await window.aideagent.savePromptProfile(profile);
    _promptDirty = false;
    // Re-render selector to reflect any name change
    renderProfileSelector();
    showPromptStatus(t("prompt.saved"), "success");
  }

  function renderPromptEditor() {
    const container = document.getElementById("prompt-sections");
    const profile = getCurrentProfile();
    if (!container || !profile) {
      if (container) container.innerHTML = '<p class="hint" style="margin:24px 0;">' + t("prompt.empty_hint") + '</p>';
      return;
    }

    container.innerHTML = `
      <div class="prompt-editor-name">
        <label class="prompt-editor-name-label">${t("prompt.name")}</label>
        <input type="text" id="prompt-name-input" class="form-input prompt-name-input" value="${htmlEncode(profile.name)}" placeholder="${t("prompt.name")}" />
      </div>
      <div class="prompt-single-box">
        <textarea id="prompt-content-area" class="prompt-content-textarea" placeholder="${t("prompt.placeholder")}">${htmlEncode(profile.content || "")}</textarea>
      </div>
      <div class="prompt-editor-bottom">
        <button id="prompt-enable-btn" class="btn prompt-enable-btn ${profile.enabled ? "prompt-enable-btn--on" : "prompt-enable-btn--off"}">
          ${profile.enabled ? t("prompt.enabled") : t("prompt.enable")}
        </button>
        <div class="prompt-editor-right">
          <button id="prompt-delete-btn" class="btn prompt-delete-btn" ${currentProfileId === "default" ? "disabled" : ""}>${t("common.delete")}</button>
          <button id="prompt-save-btn" class="btn primary">${t("common.save")}</button>
        </div>
      </div>
    `;

    // ── Bind events ──

    // Name input
    const nameInput = /** @type {HTMLInputElement | null} */ (document.getElementById("prompt-name-input"));
    if (nameInput) {
      nameInput.addEventListener("input", () => { _promptDirty = true; });
    }

    // Content textarea
    const contentArea = /** @type {HTMLTextAreaElement | null} */ (document.getElementById("prompt-content-area"));
    if (contentArea) {
      contentArea.addEventListener("input", () => {
        const p = getCurrentProfile();
        if (p) p.content = contentArea.value;
        _promptDirty = true;
      });
    }

    // Enable button
    const enableBtn = document.getElementById("prompt-enable-btn");
    if (enableBtn) {
      enableBtn.addEventListener("click", async () => {
        const p = getCurrentProfile();
        if (!p || !promptStore) return;
        if (nameInput && nameInput.value.trim()) p.name = nameInput.value.trim();
        p.enabled = true;
        for (const id of Object.keys(promptStore.profiles)) {
          if (id !== currentProfileId) promptStore.profiles[id].enabled = false;
        }
        for (const id of Object.keys(promptStore.profiles)) {
          await window.aideagent.savePromptProfile(promptStore.profiles[id]);
        }
        _promptDirty = false;
        renderProfileSelector();
        renderPromptEditor();
        showPromptStatus(t("prompt.enabled_now"), "success");
      });
    }

    // Delete button
    const deleteBtn = document.getElementById("prompt-delete-btn");
    if (deleteBtn) {
      deleteBtn.addEventListener("click", async () => {
        if (currentProfileId === "default" || !promptStore) return;
        const p = getCurrentProfile();
        if (!p) return;
        if (!await onConfirm(t("prompt.delete_confirm", {name: p.name}))) return;
        await window.aideagent.deletePromptProfile(currentProfileId);
        delete promptStore.profiles[currentProfileId];
        currentProfileId = "default";
        promptStore.activeProfile = "default";
        await window.aideagent.activatePromptProfile("default");
        renderProfileSelector();
        renderPromptEditor();
        showPromptStatus(t("prompt.deleted", {name: p.name}), "success");
      });
    }

    // Save button
    const saveBtn = document.getElementById("prompt-save-btn");
    if (saveBtn) {
      saveBtn.addEventListener("click", async () => {
        const p = getCurrentProfile();
        if (p && nameInput && nameInput.value.trim()) p.name = nameInput.value.trim();
        await saveCurrentProfile();
      });
    }
  }

  /** Create a brand-new profile, disable siblings, activate it, and re-render. */
  async function addNewProfile() {
    const name = getNextProfileName();
    const id = "profile_" + Date.now();
    if (!promptStore) return;
    /** @type {PromptProfile} */
    const newProfile = {
      id,
      name,
      enabled: true,
      content: "",
    };
    promptStore.profiles[id] = newProfile;
    currentProfileId = id;
    promptStore.activeProfile = id;
    for (const pid of Object.keys(promptStore.profiles)) {
      if (pid !== id) promptStore.profiles[pid].enabled = false;
    }
    await window.aideagent.savePromptProfile(newProfile);
    await window.aideagent.activatePromptProfile(id);
    for (const pid of Object.keys(promptStore.profiles)) {
      if (pid !== id) await window.aideagent.savePromptProfile(promptStore.profiles[pid]);
    }
    renderProfileSelector();
    renderPromptEditor();
  }

  return { loadPromptStore, renderProfileSelector, renderPromptEditor, addNewProfile };
}
