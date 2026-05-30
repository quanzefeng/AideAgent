/* ── Import modules ───────────────────────────────────── */
import './modules/font-settings.mjs';
import './modules/workspace.mjs';
import { initKnowledgeBase } from './modules/knowledge-base.mjs';
import { initMemoryPanel } from './modules/memory-panel.mjs';
import { loadAgentName, loadUserName, applyAgentName, applyUserName, initAgentNameUI, initUserAvatarUI, loadUserAvatarSrc } from './modules/agent-name.mjs';
import { sanitize, renderMarkdown, renderLatexInElement, autoResize, formatFileSize, scrollToBottom, setStatus, loadReasoningEnabled, saveReasoningEnabled } from './modules/helpers.mjs';
import { loadEnabledSkills } from './modules/skills-panel.mjs';

/* ── Configure marked.js ──────────────────────────────── */
marked.setOptions({
  breaks: true,
  gfm: true,
  highlight: function (code, lang) {
    if (lang && hljs.getLanguage(lang)) {
      try {
        return hljs.highlight(code, { language: lang, ignoreIllegals: true }).value;
      } catch {}
    }
    return hljs.highlightAuto(code).value;
  },
});

/* ── Constants ────────────────────────────────────────── */
const STORAGE_KEYS = {
  PROVIDER: "goodagent_provider",
  API_URL: "goodagent_api_url",
  MODEL: "goodagent_model",
  API_KEY: "goodagent_api_key",
  API_FORMAT: "goodagent_api_format",
  REASONING_ENABLED: "goodagent_reasoning_enabled",
};

const PROVIDER_PRESETS = {
  "":        { name: t("provider.custom"),     url: "",                              model: "",                                   models: [], format: "openai" },
  deepseek:  { name: t("provider.deepseek"),   url: "https://api.deepseek.com",      model: "deepseek-v4-flash",                  models: [{id:"deepseek-v4-flash",label:t("model.deepseek_v4_flash")},{id:"deepseek-v4-pro",label:t("model.deepseek_v4_pro")}], format: "openai" },
  glm:       { name: t("provider.glm"),        url: "https://open.bigmodel.cn/api/paas/v4", model: "GLM-4.7-Flash",                  models: [{id:"GLM-4.7-Flash",label:t("model.glm_4_7_flash")},{id:"GLM-4-Plus",label:t("model.glm_4_plus")},{id:"GLM-4-Air",label:t("model.glm_4_air")}], format: "openai" },
  qwen:      { name: t("provider.qwen"),       url: "https://dashscope.aliyuncs.com/compatible-mode/v1", model: "qwen-plus",          models: [{id:"qwen3.7-max",label:t("model.qwen3_7_max")},{id:"qwen-plus",label:t("model.qwen_plus")},{id:"qwen-turbo",label:t("model.qwen_turbo")}], format: "openai" },
  mimo:      { name: t("provider.mimo"),        url: "https://api.mimo.xiaomi.com/v1", model: "MiMo-7B-RL",         models: [{id:"MiMo-7B-RL",label:t("model.mimo_7b_rl")},{id:"MiMo-7B-SFT",label:t("model.mimo_7b_sft")}], format: "openai" },
  claude:    { name: t("provider.claude"),      url: "https://api.anthropic.com",     model: "claude-sonnet-4-20250514",            models: [{id:"claude-sonnet-4-20250514",label:t("model.claude_sonnet_4")},{id:"claude-opus-4-20250514",label:t("model.claude_opus_4")},{id:"claude-haiku-4.5-20250514",label:t("model.claude_haiku_4_5")}], format: "anthropic" },
  lmstudio:  { name: t("provider.lmstudio"),   url: "http://localhost:1234/v1",      model: "",                                   models: [], format: "openai" },
  ollama:    { name: t("provider.ollama"),      url: "http://localhost:11434/v1",     model: "",                                   models: [], format: "openai" },
};

/* ── State ────────────────────────────────────────────── */
const state = {
  sessionId: null,
  isStreaming: false,
  currentAssistantMsg: null,
  currentText: "",
  currentReasoning: "",
  _thinkBuffer: "",       // buffered partial think tag across chunks
  _permResolve: null,
  _toolCallCount: 0,
  _afterToolCall: false,  // true after a tool call completes, triggers new reasoning block
  _reasoningBlockText: "", // text of the current reasoning block
  attachedFiles: [],       // {name, size, type, dataUrl}
};

/* ── DOM refs ─────────────────────────────────────────── */
const $ = (s) => document.querySelector(s);
const configBanner = $("#config-banner");
const bannerSettingsBtn = $("#banner-settings-btn");
const app = $("#app");
const messageList = $("#message-list");
const promptInput = $("#prompt-input");
const sendBtn = $("#send-btn");
const stopBtn = $("#stop-btn");
const statusText = $("#status-text");
const infoModelName = $("#info-model-name");
const taskIndicator = $("#task-indicator");
const reasoningCheckbox = $("#reasoning-checkbox");
const planModeCheckbox = $("#plan-mode-checkbox");
const sessionDisplay = $("#session-display");
const cwdDisplay = $("#cwd-display");
const newChatBtn = $("#new-chat");
const permModal = $("#perm-modal");
const permCommand = $("#perm-command");
const permAllow = $("#perm-allow");
const permDeny = $("#perm-deny");
const settingsModal = $("#settings-modal");
const settingsBtn = $("#settings-btn");
const settingsCloseBtn = $("#settings-close-btn");
const settingsTabs = $("#settings-tabs");
const settingsProvider = $("#settings-provider");
const settingsUrl = $("#settings-url");
const settingsModel = $("#settings-model");
const settingsModelInput = $("#settings-model-input");
const settingsKey = $("#settings-key");
const settingsSaveBtn = $("#settings-save-btn");
const settingsStatus = $("#settings-status");
const avatarFileInput = $("#avatar-file-input");
const changeAvatarBtn = $("#change-avatar-btn");
const resetAvatarBtn = $("#reset-avatar-btn");
const settingsPreview = $("#settings-preview");
const sidebarAvatar = $("#sidebar-avatar");
const welcomeAvatar = $("#welcome-avatar");
const uploadBtn = $("#upload-btn");
const fileInput = $("#file-input");
const filePreviewArea = $("#file-preview-area");
const AVATAR_KEY = "goodagent_avatar";
const USER_AVATAR_KEY = "goodagent_user_avatar";
const FONT_KEY = "goodagent_font";
const USER_NAME_KEY = "goodagent_user_name";

/* ── Helpers (imported from modules/helpers.mjs) ── */

/* ── File upload ──────────────────────────────── */
const MAX_FILE_SIZE = 20 * 1024 * 1024; // 20 MB

function fileIconSvg(type, name) {
  // Images show a thumbnail
  if (type.startsWith("image/")) return ""; // handled in render
  // File type icons
  const ext = name.split(".").pop().toLowerCase();
  const icons = {
    pdf: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>',
    json: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><text x="9" y="18" font-size="10" fill="currentColor">{ }</text></svg>',
    js:   '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><text x="8" y="18" font-size="12" fill="currentColor">JS</text></svg>',
  };
  return icons[ext] || '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>';
}

function renderFilePreviews() {
  const files = state.attachedFiles;
  if (files.length === 0) {
    filePreviewArea.classList.add("hidden");
    filePreviewArea.innerHTML = "";
    return;
  }
  filePreviewArea.classList.remove("hidden");
  filePreviewArea.innerHTML = files.map((f, i) => {
    const isImg = f.type.startsWith("image/");
    const iconHtml = isImg
      ? `<img src="${f.dataUrl}" alt="" />`
      : fileIconSvg(f.type, f.name);
    return `<div class="file-chip">
      <span class="file-chip-icon">${iconHtml}</span>
      <span class="file-chip-name" title="${f.name.replace(/"/g, "&quot;")}">${f.name.replace(/</g, "&lt;")}</span>
      <span class="file-chip-size">${formatFileSize(f.size)}</span>
      <button class="file-chip-remove" data-index="${i}" data-i18n-title="file.remove" title="移除">✕</button>
    </div>`;
  }).join("");

  // Bind remove buttons
  filePreviewArea.querySelectorAll(".file-chip-remove").forEach(btn => {
    btn.addEventListener("click", () => {
      const idx = parseInt(btn.dataset.index, 10);
      state.attachedFiles.splice(idx, 1);
      renderFilePreviews();
      updateSendButton();
    });
  });
}

function updateSendButton() {
  sendBtn.disabled = !promptInput.value.trim() && state.attachedFiles.length === 0;
}

async function handleFileUpload(files) {
  if (!files || files.length === 0) return;
  for (const file of files) {
    if (file.size > MAX_FILE_SIZE) {
      addErrorMessage(t("file.too_large", { name: file.name }));
      continue;
    }
    try {
      const dataUrl = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = reject;
        reader.readAsDataURL(file);
      });
      state.attachedFiles.push({
        name: file.name,
        size: file.size,
        type: file.type,
        dataUrl,
      });
    } catch (e) {
      console.error("Failed to read file:", file.name, e);
    }
  }
  renderFilePreviews();
  updateSendButton();
}

// Upload button click → open file picker
uploadBtn.addEventListener("click", () => fileInput.click());

// File input change → handle selection
fileInput.addEventListener("change", () => {
  handleFileUpload(fileInput.files);
  fileInput.value = ""; // allow re-selecting same files
});


/* ── Update info bar (model name + reasoning state) ── */
function updateInfoBar() {
  if (!infoModelName) return;
  const cfg = loadApiConfig();
  // Show model name (or provider label if no model)
  const preset = cfg.provider ? PROVIDER_PRESETS[cfg.provider] : null;
  const label = preset?.name || cfg.apiUrl?.replace(/https?:\/\//, "").split("/")[0] || "";
  const model = cfg.model || "";
  infoModelName.textContent = model ? `${label} · ${model}` : label;
}

/* ── Reasoning toggle event ──────────────────────── */
if (reasoningCheckbox) {
  reasoningCheckbox.checked = loadReasoningEnabled();
  reasoningCheckbox.addEventListener("change", () => {
    saveReasoningEnabled(reasoningCheckbox.checked);
  });
  // Plan mode toggle
  planModeCheckbox.addEventListener("change", () => {
    window.goodAgent.setPlanMode(planModeCheckbox.checked);
  });
  // Load initial plan mode state
  window.goodAgent.getPlanMode().then(r => { planModeCheckbox.checked = r.planMode; }).catch(() => {});
}

/* ── Message DOM ──────────────────────────────────────── */
function addUserMessage(text) {
  const div = document.createElement("div");
  div.className = "message user";
  const userName = loadUserName();
  const userAvatarSrc = loadUserAvatarSrc();
  // Build DOM safely — avatar before name to match original layout
  const label = document.createElement("div");
  label.className = "message-label";
  if (userAvatarSrc) {
    const img = document.createElement("img");
    img.className = "avatar user-msg-avatar";
    img.src = userAvatarSrc;
    img.alt = "";
    label.appendChild(img);
  }
  label.appendChild(document.createTextNode(userName));
  const bubble = document.createElement("div");
  bubble.className = "message-bubble";
  bubble.innerHTML = `<p>${sanitize(text.replace(/</g, "&lt;").replace(/>/g, "&gt;"))}</p>`;
  div.appendChild(label);
  div.appendChild(bubble);
  messageList.appendChild(div);
  scrollToBottom();
  return div;
}

function addAssistantMessage() {
  const div = document.createElement("div");
  div.className = "message assistant streaming";
  const agentName = loadAgentName();
  const saved = localStorage.getItem(AVATAR_KEY);
  const avatarSrc = saved || DEFAULT_AVATAR;
  // Build DOM safely to prevent XSS from localStorage-tainted values
  const label = document.createElement("div");
  label.className = "message-label";
  const img = document.createElement("img");
  img.className = "avatar msg-avatar";
  img.src = avatarSrc;
  img.alt = "";
  label.appendChild(img);
  label.appendChild(document.createTextNode(agentName));
  const content = document.createElement("div");
  content.className = "message-content";
  content.innerHTML = '<div class="message-text"></div>';
  div.appendChild(label);
  div.appendChild(content);
  messageList.appendChild(div);
  scrollToBottom();
  return div;
}

function addErrorMessage(text) {
  const div = document.createElement("div");
  div.className = "message error";
  div.innerHTML = `
    <div class="message-label">${t("misc.error")}</div>
    <div class="message-bubble"><p>${sanitize(text.replace(/</g, "&lt;").replace(/>/g, "&gt;"))}</p></div>
  `;
  messageList.appendChild(div);
  scrollToBottom();
  return div;
}

/* ── Extract thinking / reasoning from content ──────── */
function extractThinkingBlocks(text) {
  const blocks = [];
  // Reattach buffered partial from previous chunk
  if (state._thinkBuffer) {
    text = state._thinkBuffer + text;
    state._thinkBuffer = "";
  }

  // ... — DeepSeek R1 / Qwen style
  // Split into tag vs non-tag segments (case-insensitive)
  const parts = [];
  let lastIdx = 0;
  const re = /<\/?think>/gi;
  let match;
  while ((match = re.exec(text)) !== null) {
    if (match.index > lastIdx) parts.push({ text: text.slice(lastIdx, match.index), tag: null });
    parts.push({ text: "", tag: match[0].toLowerCase() });
    lastIdx = match.index + match[0].length;
  }
  if (lastIdx < text.length) parts.push({ text: text.slice(lastIdx), tag: null });

  let clean = "", inside = false, pending = "";
  for (const p of parts) {
    if (p.tag === "<think>") {
      inside = true; pending = "";
    } else if (p.tag === "</think>") {
      inside = false;
      if (pending) blocks.push(pending);
      pending = "";
    } else if (inside) {
      pending += p.text;
    } else {
      clean += p.text;
    }
  }

  // Unclosed → buffer for next chunk
  if (inside) state._thinkBuffer = "<think>" + pending;

  return { cleanText: clean.trim(), thinkingText: blocks.join("\n\n").trim() };
}

function updateThinkingSection(msgEl, text) {
  if (!text) return;
  const section = getOrCreateThinkingSection(msgEl);
  if (!section) return;
  if (!section.hasAttribute("open")) section.setAttribute("open", "");
  const tc = section.querySelector(".thinking-content");

  // After a tool call, start a new reasoning block
  if (state._afterToolCall) {
    state._afterToolCall = false;
    state._reasoningBlockText = "";
  }

  state._reasoningBlockText = text;

  // Find or create the last reasoning div
  let el = null;
  const children = tc.children;
  for (let i = children.length - 1; i >= 0; i--) {
    if (children[i].classList.contains("thinking-reasoning")) {
      el = children[i];
      break;
    }
  }
  // If no reasoning div, or last child is a tool-entry, create new
  if (!el || (tc.lastElementChild && tc.lastElementChild.classList.contains("tool-entry"))) {
    el = document.createElement("div");
    el.className = "thinking-reasoning";
    tc.appendChild(el);
  }
  el.textContent = text;
}

function updateAssistantContent(msgEl, text) {
  const textEl = msgEl.querySelector(".message-text");
  if (!textEl) return;

  if (!text.trim()) {
    textEl.innerHTML = '<span class="thinking-indicator">' + t("status.thinking") + '</span>';
    return;
  }

  // Extract ... thinking blocks into the collapsible section
  const { cleanText, thinkingText } = extractThinkingBlocks(text);
  if (thinkingText) {
    // Merge with any reasoning_content already shown
    const fullThinking = state.currentReasoning
      ? state.currentReasoning + "\n\n" + thinkingText
      : thinkingText;
    updateThinkingSection(msgEl, fullThinking);
  }

  textEl.innerHTML = renderMarkdown(cleanText || text);

  // Re-highlight code blocks
  textEl.querySelectorAll("pre code").forEach((block) => {
    hljs.highlightElement(block);
  });

  // Render LaTeX via KaTeX (finds <span class="kp"> markers)
  renderLatexInElement(textEl);
}

function finishAssistantMessage(msgEl) {
  msgEl.classList.remove("streaming");
  // 思考过程折叠起来（移除 open 属性）
  const thinking = msgEl.querySelector(".thinking-collapsible");
  if (thinking) thinking.removeAttribute("open");

  // 添加复制/下载操作栏（避免重复添加）
  if (!msgEl.querySelector(".message-actions")) {
    const actions = document.createElement("div");
    actions.className = "message-actions";
    actions.innerHTML = `
      <button class="msg-action-btn" data-i18n-title="misc.copy_content" title="复制内容" data-action="copy">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
      </button>
      <button class="msg-action-btn" data-i18n-title="misc.download_markdown" title="下载为 Markdown" data-action="download">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
      </button>
    `;
    msgEl.querySelector(".message-content").after(actions);

    const textGetter = () => {
      const textEl = msgEl.querySelector(".message-text");
      return textEl ? textEl.textContent || "" : "";
    };

    actions.addEventListener("click", async (e) => {
      const btn = e.target.closest(".msg-action-btn");
      if (!btn) return;
      const text = textGetter();
      if (!text) return;

      if (btn.dataset.action === "copy") {
        try {
          await navigator.clipboard.writeText(text);
          const orig = btn.innerHTML;
          btn.innerHTML = `<span style="color:#22c55e">${t("misc.copied")}</span>`;
          setTimeout(() => { btn.innerHTML = orig; }, 2000);
        } catch { /* ignore */ }
      } else if (btn.dataset.action === "download") {
        btn.disabled = true;
        const orig = btn.innerHTML;
        btn.innerHTML = t("misc.saving");
        const result = await window.goodAgent.downloadMarkdown(text);
        if (result.success) {
          btn.innerHTML = `<span style="color:#22c55e">${t("misc.saved")}</span>`;
          setTimeout(() => { btn.innerHTML = orig; }, 2000);
        } else if (!result.canceled) {
          btn.innerHTML = `<span style="color:#ef4444">${t("misc.failed")}</span>`;
          setTimeout(() => { btn.innerHTML = orig; }, 2000);
        } else {
          btn.innerHTML = orig;
        }
        btn.disabled = false;
      }
    });
  }

  scrollToBottom();
}

/* ── Show welcome ─────────────────────────────────────── */
function showWelcome() {
  const agentName = loadAgentName();
  messageList.innerHTML = `
    <div class="welcome">
      <div class="welcome-icon">
        <img id="welcome-avatar" class="avatar avatar-welcome" src="avatar.jpg" alt="${agentName}" />
      </div>
      <h1>${agentName}</h1>
      <p class="description">${t("chat.welcome_desc", { name: agentName })}</p>
    </div>
  `;
  // Re-apply avatar after DOM replacement (DEFAULT_AVATAR fallback if none saved)
  const saved = localStorage.getItem(AVATAR_KEY);
  const src = saved || DEFAULT_AVATAR;
  const wa = document.getElementById("welcome-avatar");
  if (wa) wa.src = src;
  const sp = document.getElementById("settings-preview");
  if (sp) sp.src = src;
}

/* ── Settings Persistence ─────────────────────────────── */
function loadApiConfig() {
  const provider = localStorage.getItem(STORAGE_KEYS.PROVIDER) || "";
  const prefix = provider ? `goodagent_${provider}_` : "goodagent_";
  const apiKey = localStorage.getItem(provider ? `goodagent_api_key_${provider}` : "goodagent_api_key") || "";
  return {
    provider,
    apiUrl: localStorage.getItem(`${prefix}api_url`) || "",
    model: localStorage.getItem(`${prefix}model`) || "",
    apiKey,
    apiFormat: localStorage.getItem(STORAGE_KEYS.API_FORMAT) || "openai",
  };
}

function saveApiConfig(provider, apiUrl, model, apiKey, apiFormat) {
  const prefix = provider ? `goodagent_${provider}_` : "goodagent_";
  if (apiUrl) localStorage.setItem(`${prefix}api_url`, apiUrl);
  localStorage.setItem(STORAGE_KEYS.PROVIDER, provider);
  if (model) localStorage.setItem(`${prefix}model`, model);
  if (apiFormat) localStorage.setItem(STORAGE_KEYS.API_FORMAT, apiFormat);
  if (apiKey) localStorage.setItem(provider ? `goodagent_api_key_${provider}` : "goodagent_api_key", apiKey);
}

function clearApiConfig() {
  Object.values(STORAGE_KEYS).forEach(k => localStorage.removeItem(k));
}

function hasApiConfig() {
  const cfg = loadApiConfig();
  return !!cfg.apiUrl;
}

function updateConfigBanner() {
  if (hasApiConfig()) {
    configBanner.classList.add("hidden");
  } else {
    configBanner.classList.remove("hidden");
  }
}

function getCurrentModelValue() {
  if (settingsModelInput && settingsModelInput.style.display !== "none") {
    return settingsModelInput.value;
  }
  return settingsModel?.value || "";
}

function populateModelDropdown(preset, selectedModel) {
  if (!settingsModel) return;
  if (preset && preset.models && preset.models.length > 0) {
    // Has preset models — show <select>, hide <input>
    settingsModel.style.display = "";
    if (settingsModelInput) settingsModelInput.style.display = "none";
    settingsModel.innerHTML = "";
    preset.models.forEach(m => {
      const opt = document.createElement("option");
      opt.value = m.id;
      opt.textContent = m.label;
      if (m.id === selectedModel) opt.selected = true;
      settingsModel.appendChild(opt);
    });
    if (selectedModel && !preset.models.some(m => m.id === selectedModel)) {
      const customOpt = document.createElement("option");
      customOpt.value = selectedModel;
      customOpt.textContent = selectedModel + t("misc.custom_suffix");
      customOpt.selected = true;
      settingsModel.insertBefore(customOpt, settingsModel.firstChild);
    }
  } else {
    // No preset models — show <input> for manual entry, hide <select>
    settingsModel.style.display = "none";
    if (settingsModelInput) {
      settingsModelInput.style.display = "";
      settingsModelInput.value = selectedModel || "";
    }
  }
}

function fillSettingsForm() {
  _fillingForm = true;
  try {
    const cfg = loadApiConfig();
    if (settingsProvider) settingsProvider.value = cfg.provider;
    const preset = PROVIDER_PRESETS[cfg.provider];
    if (settingsUrl) settingsUrl.value = cfg.apiUrl || (preset?.url ?? "");
    if (settingsModel) {
      const selectedModel = cfg.model || preset?.model || "";
      populateModelDropdown(preset, selectedModel);
    }
    if (settingsKey) settingsKey.value = cfg.apiKey;
  } finally {
    _fillingForm = false;
  }
}

function onProviderChange() {
  const key = settingsProvider?.value || "";
  const preset = PROVIDER_PRESETS[key];
  const prefix = key ? `goodagent_${key}_` : "goodagent_";
  const savedUrl = localStorage.getItem(`${prefix}api_url`) || "";
  const savedModel = localStorage.getItem(`${prefix}model`) || "";
  if (preset && key) {
    settingsUrl.value = savedUrl || preset.url;
    populateModelDropdown(preset, savedModel || preset.model);
    if (preset.models.length === 0 && preset.url) {
      setTimeout(fetchModels, 300);
    }
  } else {
    settingsUrl.value = savedUrl;
    populateModelDropdown(null, savedModel);
  }
  const savedKey = localStorage.getItem(key ? `goodagent_api_key_${key}` : "goodagent_api_key") || "";
  if (settingsKey) settingsKey.value = savedKey;
}

function normalizeApiUrl(url) {
  url = url.trim();
  if (!url) return "";
  // Strip trailing slash
  url = url.replace(/\/+$/, "");
  // Already has chat completions path
  if (/\/chat\/completions$/.test(url)) return url;
  // If it ends with /v1 or similar version prefix, append chat/completions
  if (/\/v\d+$/.test(url)) return url + "/chat/completions";
  // If it looks like a base URL (just scheme + host), append /chat/completions
  try {
    const u = new URL(url);
    if (u.pathname === "/" || u.pathname === "") return url + "/chat/completions";
  } catch {}
  // Default: append /chat/completions
  return url + "/chat/completions";
}

function saveSettingsForm() {
  const provider = settingsProvider?.value || "";
  const rawUrl = (settingsUrl?.value || "").trim();
  const model = getCurrentModelValue().trim();
  const apiKey = (settingsKey?.value || "").trim();
  const preset = PROVIDER_PRESETS[provider];
  const apiFormat = preset?.format || "openai";

  if (!rawUrl) {
    if (settingsStatus) {
      settingsStatus.textContent = t("api.fill_url");
      settingsStatus.className = "settings-status error";
    }
    return;
  }

  const apiUrl = apiFormat === "anthropic" ? rawUrl.replace(/\/+$/, "") : normalizeApiUrl(rawUrl);

  // Show the normalized URL to user
  if (apiUrl !== rawUrl) {
    settingsUrl.value = apiUrl;
  }

  saveApiConfig(provider, apiUrl, model, apiKey, apiFormat);
  // Sync to WeChat bot config so WeChat uses updated API
  window.goodAgent.syncApiToWechat?.({ apiUrl, apiKey, model, apiFormat }).catch(() => {});
  updateConfigBanner();
  updateInfoBar();
  if (settingsStatus) {
    settingsStatus.textContent = t("api.saved", { name: preset?.name || provider || t("provider.custom") });
    settingsStatus.className = "settings-status success";
  }
  // Show connection status in sidebar
  const providerLabel = preset?.name || provider || apiUrl.replace(/https?:\/\//, "").split("/")[0];
  if (cwdDisplay) cwdDisplay.textContent = providerLabel;
  setTimeout(() => settingsStatus.className = "settings-status hidden", 3000);
}

/* ── Fetch Models ─────────────────────────────────────── */
async function fetchModels() {
  const btn = document.getElementById("settings-fetch-models-btn");
  if (!btn) return;
  btn.disabled = true;
  btn.classList.add("fetching");
  btn.textContent = t("api.fetching");

  const settingsStatus = document.getElementById("settings-status");
  const rawUrl = (document.getElementById("settings-url")?.value || "").trim();
  const apiKey = (document.getElementById("settings-key")?.value || "").trim();

  // Derive base URL for models endpoint
  let baseUrl = rawUrl
    .replace(/\/chat\/completions$/, "")
    .replace(/\/v1\/chat\/completions$/, "")
    .replace(/\/v1\/messages$/, "")
    .replace(/\/v1$/, "")
    .replace(/\/+$/, "");

  if (!baseUrl) {
    if (settingsStatus) {
      settingsStatus.textContent = t("api.fill_url");
      settingsStatus.className = "settings-status error";
    }
    btn.disabled = false;
    btn.classList.remove("fetching");
    btn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:middle;margin-right:4px;"><path d="M21 12a9 9 0 1 1-6.219-8.56"/><path d="M21 3v5h-5"/></svg> ' + t("api.fetch_models_btn");
    return;
  }

  // Try multiple endpoints, starting with /v1/models then /api/tags (Ollama)
  const endpoints = [
    baseUrl + "/v1/models",
    baseUrl + "/models",
    baseUrl + "/api/tags",
  ];

  let models = [];
  for (const url of endpoints) {
    try {
      const headers = {};
      if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;
      const res = await fetch(url, { headers, signal: AbortSignal.timeout(8000) });
      if (!res.ok) continue;
      const data = await res.json();
      // Try different response formats
      const list = data.data || data.models || [];
      if (Array.isArray(list) && list.length > 0) {
        models = list.map(m => ({
          id: m.id || m.name || "",
          label: m.id || m.name || "(unnamed)",
        })).filter(m => m.id);
        break;
      }
    } catch {}
  }

  if (models.length > 0) {
    // Populate the model dropdown with fetched models
    const select = document.getElementById("settings-model");
    if (select) {
      select.style.display = "";
      select.innerHTML = "";
      models.forEach(m => {
        const opt = document.createElement("option");
        opt.value = m.id;
        opt.textContent = m.label;
        select.appendChild(opt);
      });
      if (select.value === "" && models.length > 0) {
        select.value = models[0].id;
      }
    }
    if (settingsModelInput) settingsModelInput.style.display = "none";
    if (settingsStatus) {
      settingsStatus.textContent = t("api.fetch_success", { count: models.length });
      settingsStatus.className = "settings-status success";
    }
  } else {
    if (settingsStatus) {
      settingsStatus.textContent = t("api.fetch_empty");
      settingsStatus.className = "settings-status error";
    }
  }

  btn.disabled = false;
  btn.classList.remove("fetching");
  btn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:middle;margin-right:4px;"><path d="M21 12a9 9 0 1 1-6.219-8.56"/><path d="M21 3v5h-5"/></svg> ' + t("api.fetch_models_btn");
}

/* ── Query ────────────────────────────────────────────── */
async function submitQuery() {
  const text = promptInput.value.trim();
  const files = state.attachedFiles;
  if ((!text && files.length === 0) || state.isStreaming) return;

  const cfg = loadApiConfig();
  if (!cfg.apiUrl) {
    addErrorMessage(t("api.config_first"));
    return;
  }

  // Fallback: use currently selected model in settings dropdown if not yet persisted
  if (!cfg.model) {
    const fallbackModel = getCurrentModelValue();
    if (fallbackModel) cfg.model = fallbackModel.trim();
  }

  // Clear input and files
  promptInput.value = "";
  autoResize(promptInput);
  state.attachedFiles = [];
  renderFilePreviews();
  updateSendButton();

  state.isStreaming = true;
  state.currentText = "";
  state._toolCallCount = 0;
  state._afterToolCall = false;
  state._reasoningBlockText = "";

  // Hide welcome, show messages
  const welcome = messageList.querySelector(".welcome");
  if (welcome) welcome.style.display = "none";

  // Add user message (show text + file attachments)
  let userHtml = text ? `<p>${sanitize(text.replace(/</g, "&lt;").replace(/>/g, "&gt;"))}</p>` : "";
  if (files.length > 0) {
    const fileList = files.map(f => {
      const safeName = sanitize(f.name.replace(/</g, "&lt;").replace(/>/g, "&gt;"));
      if (f.type.startsWith("image/")) {
        // Build img via DOM API so data: URLs aren't stripped by DOMPurify
        const wrap = document.createElement("div");
        wrap.style.cssText = "margin:4px 0";
        const img = document.createElement("img");
        img.src = f.dataUrl; // safe — from local FileReader
        img.alt = f.name;
        img.style.cssText = "max-width:200px;max-height:150px;border-radius:6px;object-fit:cover;border:1px solid var(--border)";
        wrap.appendChild(img);
        return wrap.outerHTML;
      }
      return `<div style="display:flex;align-items:center;gap:6px;padding:4px 0;font-size:13px;color:var(--text-light);"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg> ${safeName}</div>`;
    }).join("");
    userHtml += `<div style="display:flex;flex-wrap:wrap;gap:4px;margin-top:${text ? 4 : 0}px">${fileList}</div>`;
  }
  const userDiv = addUserMessage("");
  const bubble = userDiv.querySelector(".message-bubble") || userDiv;
  bubble.innerHTML = userHtml;

  // Create assistant message
  state.currentAssistantMsg = addAssistantMessage();
  updateAssistantContent(state.currentAssistantMsg, "");

  // Toggle buttons
  sendBtn.classList.add("hidden");
  stopBtn.classList.remove("hidden");
  setStatus(t("status.thinking"));

  // Build file attachments for the API
  const apiFiles = files.map(f => ({
    name: f.name,
    type: f.type,
    dataUrl: f.dataUrl,
  }));

  // Submit
  try {
    const enabledSkills = loadEnabledSkills();
    const reasoning = loadReasoningEnabled();
    const agentName = loadAgentName();
    const kbEnabled = document.getElementById("kb-toggle")?.checked || false;
    const webSearchEnabled = document.getElementById("web-search-toggle")?.checked ?? true;
    await window.goodAgent.submitQuery(text, cfg.apiKey, cfg.apiUrl, cfg.model, cfg.apiFormat, apiFiles, enabledSkills, reasoning, agentName, kbEnabled, planModeCheckbox.checked, webSearchEnabled);
  } catch (err) {
    console.error("Query error:", err);
  }
}

function abortQuery() {
  window.goodAgent.abortQuery();
  if (state.currentAssistantMsg) {
    finishAssistantMessage(state.currentAssistantMsg);
  }
  stopQuery();
}

function stopQuery() {
  state.isStreaming = false;
  sendBtn.classList.remove("hidden");
  stopBtn.classList.add("hidden");
  sendBtn.disabled = false;
  setStatus(t("status.ready"));
}

function resetChat() {
  if (state.isStreaming) {
    window.goodAgent.abortQuery();
  }
  window.goodAgent.resetSession();
  state.sessionId = null;
  state.isStreaming = false;
  state.currentText = "";
  state.currentReasoning = "";
  state._thinkBuffer = "";
  state.currentAssistantMsg = null;
  state._toolCallCount = 0;
  state._afterToolCall = false;
  state._reasoningBlockText = "";
  state.attachedFiles = [];
  _loadedSessionId = null;
  // Clear task/todo state
  _taskCache.clear();
  _todoCache.length = 0;
  updateTaskIndicator(null, null, null, []);
  if (sessionDisplay) sessionDisplay.textContent = "—";
  sendBtn.classList.remove("hidden");
  stopBtn.classList.add("hidden");
  renderFilePreviews();
  updateSendButton();
  showWelcome();
  promptInput.value = "";
  setStatus(t("status.ready"));
  refreshSessionList();
}

/* ── Session List ──────────────────────────────────────────── */
let _loadedSessionId = null;

function refreshSessionList() {
  window.goodAgent.listSessions().then(sessions => {
    const container = document.getElementById("session-list");
    if (!container) return;
    if (!sessions || sessions.length === 0) {
      container.innerHTML = '<div class="session-list-empty">' + t("sidebar.empty") + '</div>';
      return;
    }
    container.innerHTML = sessions.map(s => `
      <div class="session-item ${_loadedSessionId === s.id ? "active" : ""}" data-session-id="${s.id}">
        <div class="session-item-title" title="${sanitize(s.title || t("sidebar.no_title"))}">${sanitize((s.title || t("sidebar.no_title")).slice(0, 28))}</div>
        <div class="session-item-actions">
          <button class="session-export" data-session-id="${s.id}" title="${t("sidebar.export")}">↓</button>
          <button class="session-delete" data-session-id="${s.id}" title="${t("sidebar.delete")}">×</button>
        </div>
      </div>
    `).join("");
  }).catch(() => {});
}

// Session search
document.getElementById("session-search-input")?.addEventListener("input", function () {
  const query = this.value.trim();
  if (!query) { refreshSessionList(); return; }
  window.goodAgent.searchSessions(query, 30).then(results => {
    const container = document.getElementById("session-list");
    if (!container) return;
    if (!results?.length) {
      container.innerHTML = '<div class="session-list-empty">' + t("sidebar.no_match") + '</div>';
      return;
    }
    container.innerHTML = results.map(r => `
      <div class="session-item" data-session-id="${r.sessionId}">
        <div class="session-item-title">${sanitize(r.snippet || r.sessionTitle)}</div>
        <span style="font-size:10px;color:var(--text-muted)">${sanitize(r.sessionTitle || "")}</span>
      </div>
    `).join("");
  }).catch(() => {});
});

function loadChat(sessionId) {
  if (state.isStreaming) {
    window.goodAgent.abortQuery();
  }
  window.goodAgent.loadSession(sessionId).then(data => {
    if (!data) return;
    _loadedSessionId = data.sessionId;
    state.sessionId = data.sessionId;
    state.isStreaming = false;
    state.currentText = "";
    state.currentReasoning = "";
    state.currentAssistantMsg = null;
    state._toolCallCount = 0;
    state._afterToolCall = false;
    state._reasoningBlockText = "";
    sendBtn.classList.remove("hidden");
    stopBtn.classList.add("hidden");
    sendBtn.disabled = false;
    promptInput.value = "";
    setStatus(t("status.ready"));

    // Rebuild message list from history
    messageList.innerHTML = "";
    const hist = data.history || [];
    for (const m of hist) {
      if (m.role === "user") {
        const el = addUserMessage(m.content);
        if (m.id) el.dataset.msgId = m.id;
      } else if (m.role === "assistant") {
        const el = addAssistantMessage();
        if (m.id) el.dataset.msgId = m.id;
        state.currentAssistantMsg = el;
        requestAnimationFrame(() => {
          // Restore reasoning_content from history
          if (m.reasoning_content) {
            state.currentReasoning = m.reasoning_content;
            updateThinkingSection(el, m.reasoning_content);
          }
          updateAssistantContent(el, m.content || "");
          finishAssistantMessage(el);
        });
      }
    }
    state.currentAssistantMsg = null;
    sessionDisplay.textContent = data.sessionId || "—";
    refreshSessionList();
  }).catch(() => {});
}

// Delegate click events on session-list (handles load, delete, export)
document.addEventListener("click", (e) => {
  const deleteBtn = e.target.closest(".session-delete");
  if (deleteBtn) {
    e.stopPropagation();
    const id = deleteBtn.dataset.sessionId;
    if (id && confirm(t("sidebar.delete_confirm"))) {
      window.goodAgent.deleteSession(id).then(() => {
        if (_loadedSessionId === id) _loadedSessionId = null;
        refreshSessionList();
      });
    }
    return;
  }

  const exportBtn = e.target.closest(".session-export");
  if (exportBtn) {
    e.stopPropagation();
    const id = exportBtn.dataset.sessionId;
    if (id) {
      window.goodAgent.exportSessionMarkdown(id).then(data => {
        if (data?.markdown) {
          const blob = new Blob([data.markdown], { type: "text/markdown;charset=utf-8" });
          const url = URL.createObjectURL(blob);
          const a = document.createElement("a");
          a.href = url; a.download = `${data.title || "session"}.md`;
          a.click();
          URL.revokeObjectURL(url);
        }
      });
    }
    return;
  }

  const editBtn = e.target.closest(".msg-edit-btn");
  if (editBtn) {
    e.stopPropagation();
    const msgEl = editBtn.closest(".message");
    const textEl = editBtn.closest(".message-bubble")?.querySelector("p");
    if (!msgEl || !textEl) return;
    const oldText = textEl.textContent || "";
    const input = document.createElement("textarea");
    input.value = oldText;
    input.className = "msg-edit-input";
    input.style.width = "100%"; input.style.minHeight = "60px";
    textEl.replaceWith(input);
    editBtn.textContent = "✓";
    editBtn.classList.add("saving");
    editBtn.onclick = async () => {
      const newText = input.value.trim();
      if (!newText || newText === oldText) { undoEdit(); return; }
      const msgId = msgEl.dataset.msgId;
      if (msgId) {
        await window.goodAgent.editMessage(parseInt(msgId), newText);
      }
      const p = document.createElement("p");
      p.textContent = newText;
      input.replaceWith(p);
      editBtn.textContent = "✎";
      editBtn.classList.remove("saving");
      editBtn.onclick = null;
    };
    function undoEdit() {
      const p = document.createElement("p");
      p.textContent = oldText;
      input.replaceWith(p);
      editBtn.textContent = "✎";
      editBtn.classList.remove("saving");
      editBtn.onclick = null;
    }
    return;
  }

  const item = e.target.closest(".session-item");
  if (item) {
    const id = item.dataset.sessionId;
    if (id) loadChat(id);
  }
});

/* ── Tool call display (collapsible inside assistant message) ─ */
function getOrCreateThinkingSection(msgEl) {
  const el = msgEl || state.currentAssistantMsg;
  if (!el) return null;
  let section = el.querySelector(".thinking-collapsible");
  if (!section) {
    const content = el.querySelector(".message-content");
    if (!content) return null;
    section = document.createElement("details");
    section.className = "thinking-collapsible";
    section.innerHTML = `<summary>${t("thinking.title")}</summary><div class="thinking-content"></div>`;
    content.insertBefore(section, content.firstChild);
  }
  return section;
}

function addToolCall(name, args) {
  state._toolCallCount++;
  state._afterToolCall = true;
  const section = getOrCreateThinkingSection();
  if (!section) return;

  const tc = section.querySelector(".thinking-content");
  const entry = document.createElement("div");
  entry.className = "tool-entry";
  entry.id = `tool-${state._toolCallCount}`;
  const argsStr = Object.entries(args || {})
    .map(([k, v]) => `<span class="tool-arg"><span class="tool-arg-key">${k}</span><span class="tool-arg-val">${sanitize(String(v).slice(0, 120))}</span></span>`)
    .join("");
  entry.innerHTML = `
    <div class="tool-entry-head">
      <span class="tool-entry-icon">🛠</span>
      <span class="tool-entry-name">${sanitize(name.toLowerCase())}</span>
      <span class="tool-entry-status">${t("mcp.running")}</span>
    </div>
    <div class="tool-entry-args">${argsStr || ""}</div>
    <div class="tool-entry-result"></div>
  `;
  tc.appendChild(entry);
  scrollToBottom();
  return entry;
}

function completeToolCall(name, result) {
  const el = document.getElementById(`tool-${state._toolCallCount}`);
  if (!el) return;
  const statusIcon = result?.error ? "❌" : "✅";
  const summary = result?.error
    ? `<span style="color:var(--danger);">${sanitize(String(result.error).slice(0, 200))}</span>`
    : `<span style="color:var(--success);">${t("thinking.done")}</span>`;
  el.querySelector(".tool-entry-status").textContent = `${statusIcon} ${t("thinking.done")}`;
  el.querySelector(".tool-entry-result").innerHTML = summary;
  el.classList.add("tool-done");
  scrollToBottom();
}

/* ── Task indicator ──────────────────────────────────── */
const _taskCache = new Map(); // taskId -> { subject, status }
const _todoCache = [];        // current todo list

function updateTaskIndicator(subject, taskId, newStatus, todos) {
  if (taskId && subject) _taskCache.set(taskId, { subject, status: "pending" });
  if (taskId && newStatus) {
    const cached = _taskCache.get(taskId);
    if (cached) cached.status = newStatus;
  }
  if (todos) { _todoCache.length = 0; _todoCache.push(...todos); }

  const active = Array.from(_taskCache.values()).filter(t => t.status !== "completed" && t.status !== "deleted");
  const todoActive = _todoCache.filter(t => t.status !== "completed");
  const total = active.length + todoActive.length;

  if (total === 0) {
    taskIndicator.classList.add("hidden");
    taskIndicator.classList.remove("has-active");
    taskIndicator.textContent = "";
  } else {
    taskIndicator.classList.remove("hidden");
    taskIndicator.classList.add("has-active");
    const parts = [];
    if (active.length > 0) parts.push(t("status.tasks", {count: active.length}));
    if (todoActive.length > 0) parts.push(t("status.todos", {count: todoActive.length}));
    taskIndicator.textContent = "📋 " + parts.join(" · ");
    taskIndicator.title = active.map(t => `${t.status === "in_progress" ? "🔄" : "⬜"} ${t.subject}`).join("\n");
  }
}

/* ── Ask Question dialog ────────────────────────────── */
let _askResolve = null;
const askModal = $("#ask-modal");
const askModalBody = $("#ask-modal-body");
const askSubmit = $("#ask-submit");

function showAskQuestion(data) {
  return new Promise(resolve => {
    _askResolve = resolve;
    const { questions } = data;
    askModalBody.innerHTML = questions.map((q, qi) => {
      const inputType = q.multiSelect ? "checkbox" : "radio";
      const name = `ask_q_${qi}`;
      return `<div style="margin-bottom:16px;">
        <div style="font-weight:600;margin-bottom:6px;font-size:14px;">${q.header ? `<span style="background:var(--bg-tertiary);padding:1px 6px;border-radius:3px;font-size:12px;margin-right:6px;">${q.header.replace(/</g,'&lt;')}</span>` : ""}${q.question.replace(/</g,'&lt;')}</div>
        ${q.options.map((o, oi) => `<label style="display:flex;align-items:flex-start;gap:8px;padding:8px 10px;margin:4px 0;border-radius:6px;cursor:pointer;background:var(--bg-secondary);">
          <input type="${inputType}" name="${name}" value="${oi}" style="margin-top:2px;flex-shrink:0;" />
          <div><div style="font-size:13px;font-weight:500;">${o.label.replace(/</g,'&lt;')}</div><div style="font-size:12px;color:var(--text-muted);">${o.description.replace(/</g,'&lt;')}</div></div>
        </label>`).join("")}
      </div>`;
    }).join("");
    askSubmit.onclick = () => {
      const answers = {};
      questions.forEach((q, qi) => {
        const checked = askModalBody.querySelectorAll(`input[name="ask_q_${qi}"]:checked`);
        if (checked.length > 0) {
          answers[q.question] = Array.from(checked).map(c => q.options[parseInt(c.value)].label).join(",");
        }
      });
      askModal.classList.remove("active");
      _askResolve = null;
      resolve(answers);
    };
    askModal.classList.add("active");
  });
}

/* ── Permission dialog ───────────────────────────────── */
function showPermission(evt) {
  return new Promise((resolve) => {
    state._permResolve = resolve;
    permCommand.textContent = evt.command;
    permModal.classList.add("active");

    const cleanup = () => { permModal.classList.remove("active"); };
    permAllow.onclick = () => { cleanup(); resolve(true); };
    permDeny.onclick = () => { cleanup(); resolve(false); };
  });
}

// Render permission request from main process
window.goodAgent.onPermissionRequest((data) => {
  if (state._permResolve) {
    // Already showing a permission dialog - auto-deny new one
    window.goodAgent.respondPermission(data.id, false);
    return;
  }
  showPermission(data).then((allow) => {
    window.goodAgent.respondPermission(data.id, allow);
    state._permResolve = null;
  });
});

// Render question from AskUserQuestion tool
window.goodAgent.onAskQuestion((data) => {
  if (_askResolve) {
    // Already showing a question dialog — auto-close old one
    _askResolve({});
    _askResolve = null;
    askModal.classList.remove("active");
  }
  showAskQuestion(data).then((answers) => {
    window.goodAgent.respondQuestion(data.id, answers);
  });
});

/* ── Safe event listener registration ──────────────── */
function onIpc(name, handler) {
  const fn = window.goodAgent[name];
  if (typeof fn === "function") fn(handler);
  else console.warn("[app] goodAgent." + name + " not available");
}

/* ── IPC event handlers ──────────────────────────────── */
function setupIPC() {
  onIpc("onStreamStart", () => {
    state.currentText = "";
    state.currentReasoning = "";
    state._thinkBuffer = "";
  });

  onIpc("onStreamChunk", (data) => {
    if (!state.currentAssistantMsg) return;

    if (!state.isStreaming) {
      state.isStreaming = true;
    }

    if (data.text) {
      state.currentText += data.text;

      // Batch render: update at most every ~50ms
      if (!state._renderTimer) {
        state._renderTimer = setTimeout(() => {
          updateAssistantContent(state.currentAssistantMsg, state.currentText);
          state._renderTimer = null;
          scrollToBottom();
        }, 50);
      }
    }

    if (data.done) {
      if (state._renderTimer) {
        clearTimeout(state._renderTimer);
        state._renderTimer = null;
      }
      if (data.is_result && data.text) {
        state.currentText = data.text;
      }
      updateAssistantContent(state.currentAssistantMsg, state.currentText);
      finishAssistantMessage(state.currentAssistantMsg);
      stopQuery();
    }
  });

  onIpc("onStreamReasoning", (data) => {
    if (!state.currentAssistantMsg) return;
    state.currentReasoning += data.text;
    const section = getOrCreateThinkingSection();
    if (!section) return;
    if (!section.hasAttribute("open")) section.setAttribute("open", "");
    const tc = section.querySelector(".thinking-content");

    // After a tool call, start a new reasoning block
    if (state._afterToolCall) {
      state._afterToolCall = false;
      state._reasoningBlockText = "";
    }

    state._reasoningBlockText += data.text;

    // Find or create the last reasoning div in thinking-content
    let reasoningEl = null;
    const children = tc.children;
    for (let i = children.length - 1; i >= 0; i--) {
      if (children[i].classList.contains("thinking-reasoning")) {
        reasoningEl = children[i];
        break;
      }
    }
    // If no reasoning div exists, or the last child is a tool-entry, create new
    if (!reasoningEl || (tc.lastElementChild && tc.lastElementChild.classList.contains("tool-entry"))) {
      reasoningEl = document.createElement("div");
      reasoningEl.className = "thinking-reasoning";
      tc.appendChild(reasoningEl);
    }
    reasoningEl.textContent = state._reasoningBlockText;
    scrollToBottom();
  });

  onIpc("onStreamDone", () => {
    if (state.currentAssistantMsg) {
      if (state.currentText) {
        updateAssistantContent(state.currentAssistantMsg, state.currentText);
      }
      finishAssistantMessage(state.currentAssistantMsg);
    }
    stopQuery();
  });

  onIpc("onStreamError", (data) => {
    if (state.currentAssistantMsg) {
      finishAssistantMessage(state.currentAssistantMsg);
    }
    stopQuery();
    addErrorMessage(data.message || t("misc.unknown_error"));
  });

  window.goodAgent.onToolStart((data) => {
    addToolCall(data.name, data.args);
  });

  window.goodAgent.onToolResult((data) => {
    completeToolCall(data.name, data.result);
    // Update task indicator for task management tools
    if (data.name === "TaskCreate" && data.result?.task) {
      updateTaskIndicator(data.result.task.subject, data.result.task.id, "pending");
    } else if (data.name === "TaskUpdate" && data.result?.success) {
      updateTaskIndicator(null, data.result.taskId, data.result.updatedFields?.includes("status") ? data.result.statusChange?.to : null);
    } else if (data.name === "TodoWrite" && data.result?.newTodos) {
      updateTaskIndicator(null, null, null, data.result.newTodos);
    }
  });

  // Sub-agent progress: show turn status in thinking section
  try {
    window.goodAgent.onSubagentProgress?.((data) => {
      if (data.done) return;
      // Find the running Agent tool entry and update its status
      const thinkingContent = state.currentAssistantMsg?.querySelector?.(".thinking-content");
      if (!thinkingContent) return;
      const entries = thinkingContent.querySelectorAll(".tool-entry");
      for (const entry of entries) {
        const nameEl = entry.querySelector(".tool-entry-name");
        if (nameEl && nameEl.textContent.includes("agent") && entry.querySelector(".tool-entry-status")?.textContent?.includes("running")) {
          const statusEl = entry.querySelector(".tool-entry-status");
          if (statusEl && data.description) {
            statusEl.textContent = `${data.description} (turn ${data.turn + 1})`;
          }
          break;
        }
      }
    });
  } catch (e) { /* preload may not be updated yet */ }

  try {
    window.goodAgent.onTaskClear?.(() => {
      _taskCache.clear();
      _todoCache.length = 0;
      updateTaskIndicator(null, null, null, []);
    });
  } catch (e) { /* preload may not be updated yet */ }

  window.goodAgent.onSessionUpdate((data) => {
    state.sessionId = data.sessionId;
    if (sessionDisplay) {
  if (sessionDisplay) sessionDisplay.textContent = data.sessionId || "—";
    }
    // If this is a new session (not from loadChat), reset loaded flag
    if (data.sessionId && _loadedSessionId && _loadedSessionId !== data.sessionId) {
      _loadedSessionId = data.sessionId;
    }
    // Refresh session list when a new session is created
    refreshSessionList();
  });

  window.goodAgent.onL0Budget((data) => {
    const el = document.getElementById("token-budget");
    if (!el) return;
    el.classList.remove("hidden");
    if (data.overHard) {
      el.textContent = `⚠️ ${data.estimatedTokens.toLocaleString()} tokens`;
      el.className = "token-budget danger";
      el.title = t("budget.over_hard", {limit: data.hardThreshold.toLocaleString()});
    } else if (data.overWarn) {
      el.textContent = `⚡ ${data.estimatedTokens.toLocaleString()} tokens`;
      el.className = "token-budget warn";
      el.title = t("budget.near_limit", {limit: data.hardThreshold.toLocaleString()});
    } else {
      // Only show when above 4000, otherwise hide
      if (data.estimatedTokens < 4000) {
        el.classList.add("hidden");
        el.textContent = "";
        return;
      }
      el.textContent = `${data.estimatedTokens.toLocaleString()} tokens`;
      el.className = "token-budget ok";
      el.title = t("budget.tooltip");
    }
  });

  // Context usage indicator
  try {
    window.goodAgent.onContextUsage?.((data) => {
      const el = document.getElementById("context-usage");
      if (!el) return;
      el.classList.remove("hidden", "ok", "warn", "danger");
      if (data.usagePct >= 90) {
        el.textContent = '⚠️ ' + t("context.label", {pct: data.usagePct});
        el.classList.add("danger");
      } else if (data.usagePct >= 80) {
        el.textContent = '⚡ ' + t("context.label", {pct: data.usagePct});
        el.classList.add("warn");
      } else if (data.totalTokens > 5000) {
        el.textContent = t("context.label", {pct: data.usagePct});
        el.classList.add("ok");
      } else {
        el.classList.add("hidden");
      }
      el.title = `${data.totalTokens.toLocaleString()} / ${data.windowSize.toLocaleString()} tokens`;
    });
  } catch (e) { /* preload may not be updated yet */ }
}

/* ── Avatar ──────────────────────────────────────────── */

// Default avatar data URL (embedded, handles WebP-as-JPG files safely)
const DEFAULT_AVATAR = /* abc.jpg compressed */ "data:image/jpeg;base64,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";

// Load saved avatar from localStorage, or use default.
// Re-query welcomeAvatar each time since showWelcome() destroys the old element.
function loadAvatar() {
  const saved = localStorage.getItem(AVATAR_KEY);
  const src = saved || DEFAULT_AVATAR;
  const imgs = [sidebarAvatar, settingsPreview, document.getElementById("welcome-avatar")].filter(Boolean);
  imgs.forEach((img) => { img.src = src; });
  // Update avatars in existing assistant messages too
  document.querySelectorAll(".msg-avatar").forEach((img) => { img.src = src; });
}

function saveAvatar(src) {
  try {
    localStorage.setItem(AVATAR_KEY, src);
    loadAvatar();
  } catch (e) {
    console.error("[avatar] save failed:", e.message);
    showToast(t("avatar.save_fail"), "error");
  }
}

function showToast(msg, type) {
  const existing = document.querySelector(".avatar-toast");
  if (existing) existing.remove();
  const toast = document.createElement("div");
  toast.className = `avatar-toast ${type || "info"}`;
  toast.textContent = msg;
  toast.style.cssText = "position:fixed;bottom:24px;left:50%;transform:translateX(-50%);padding:10px 20px;border-radius:8px;z-index:9999;font-size:14px;animation:fadeIn 0.3s;transition:opacity 0.3s";
  if (type === "error") toast.style.background = "rgba(208,49,45,0.9)";
  else toast.style.background = "rgba(46,160,67,0.9)";
  toast.style.color = "#fff";
  toast.style.backdropFilter = "blur(8px)";
  document.body.appendChild(toast);
  setTimeout(() => { toast.style.opacity = "0"; setTimeout(() => toast.remove(), 300); }, 3000);
}

function resetAvatar() {
  localStorage.removeItem(AVATAR_KEY);
  loadAvatar();
}

// Detect image format from magic bytes (not file extension)
function detectMimeFromHeader(header) {
  const bytes = new Uint8Array(header);
  if (bytes[0] === 0xFF && bytes[1] === 0xD8 && bytes[2] === 0xFF) return "image/jpeg";
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4E) return "image/png";
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return "image/gif";
  if (bytes[0] === 0x42 && bytes[1] === 0x4D) return "image/bmp";
  // WebP: RIFF + 4 bytes + WEBP
  if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
      bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return "image/webp";
  return null;
}

// File input → detect real format → compress → save
avatarFileInput.addEventListener("change", async () => {
  const file = avatarFileInput.files?.[0];
  if (!file) return;

  // Reject non-images at the MIME level
  if (!file.type.startsWith("image/")) {
    showToast(t("avatar.select_file"), "error");
    avatarFileInput.value = "";
    return;
  }

  // Detect real format from magic bytes (handles .jpg-is-actually-WebP files)
  let realType;
  try {
    const header = await file.slice(0, 12).arrayBuffer();
    realType = detectMimeFromHeader(header);
  } catch (e) {
    realType = file.type; // fallback to browser-reported type
  }
  // If we can't determine the format, use the browser-reported type
  const mimeType = realType || file.type;

  const MAX_PX = 200;
  const correctedBlob = new Blob([file], { type: mimeType });
  const blobUrl = URL.createObjectURL(correctedBlob);
  const img = new Image();

  img.onload = () => {
    let w = img.naturalWidth, h = img.naturalHeight;
    if (w > MAX_PX || h > MAX_PX) {
      const scale = MAX_PX / Math.max(w, h);
      w = Math.round(w * scale);
      h = Math.round(h * scale);
    }
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(img, 0, 0, w, h);
    const compressed = canvas.toDataURL("image/jpeg", 0.85);
    URL.revokeObjectURL(blobUrl);
    saveAvatar(compressed);
  };

  img.onerror = () => {
    URL.revokeObjectURL(blobUrl);
    console.error("[avatar] failed to decode:", file.name, "detected:", mimeType, "browser said:", file.type);
    showToast(t("avatar.decode_fail"), "error");
  };

  img.src = blobUrl;
  avatarFileInput.value = "";
});

changeAvatarBtn.addEventListener("click", () => {
  avatarFileInput.click();
});

resetAvatarBtn.addEventListener("click", resetAvatar);

/* ── Agent Name + User Name + User Avatar (imported from modules/agent-name.mjs) ── */

/* ── Font Settings (imported from modules/font-settings.mjs) ── */

/* ── Skills (imported from modules/skills-panel.mjs) ── */

/* ── MCP Servers ──────────────────────────────────────── */

async function loadMcpServers() {
  const listEl = document.getElementById("mcp-server-list");
  if (!listEl) return;
  try {
    const servers = await window.goodAgent.mcpList();
    if (!servers || servers.length === 0) {
      listEl.innerHTML = '<p class="hint" style="padding:24px 0;text-align:center;">' + t("mcp.empty") + '</p>';
      return;
    }
    listEl.innerHTML = servers.map(s => {
      const statusIcon = s.status === "running" ? "🟢" : s.status === "error" ? "🔴" : "🟡";
      const toolList = s.tools.length > 0
        ? s.tools.map(t => `<code style="font-size:12px;background:var(--bg-tertiary);padding:1px 6px;border-radius:4px;white-space:nowrap;">${sanitize(t.name)}</code>`).join(" ")
        : '<span class="hint" style="font-size:12px;">' + t("mcp.no_tools") + '</span>';
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
        <div class="mcp-server-tools">
          <span class="hint" style="font-size:12px;margin-right:6px;">${t("mcp.tools_label")}</span>
          ${toolList}
        </div>
      </div>`;
    }).join("");

    // Bind restart buttons
    listEl.querySelectorAll(".mcp-restart-btn").forEach(btn => {
      btn.addEventListener("click", async () => {
        const name = btn.dataset.name;
        btn.disabled = true;
        btn.textContent = t("mcp.restarting");
        const result = await window.goodAgent.mcpRestart(name);
        if (!result.success) {
          showMcpStatus(t("mcp.restart_fail", {name, error: result.error}), "error");
        }
        await loadMcpServers();
        btn.disabled = false;
        btn.textContent = t("mcp.restart");
      });
    });

    // Bind remove buttons
    listEl.querySelectorAll(".mcp-remove-btn").forEach(btn => {
      btn.addEventListener("click", async () => {
        const name = btn.dataset.name;
        if (!confirm(t("mcp.remove_confirm", {name}))) return;
        btn.disabled = true;
        const result = await window.goodAgent.mcpRemove(name);
        if (!result.success) {
          showMcpStatus(t("mcp.remove_fail", {name, error: result.error}), "error");
        }
        await loadMcpServers();
      });
    });
  } catch (err) {
    console.error("[mcp] load error:", err);
    if (listEl) listEl.innerHTML = '<div class="hint" style="padding:24px 0;text-align:center;color:var(--danger);">' + t("mcp.load_error") + '</div>';
  }
}

function showMcpStatus(msg, type = "info") {
  const el = document.getElementById("mcp-settings-status");
  if (!el) return;
  el.textContent = msg;
  el.className = `settings-status ${type === "info" ? "hidden" : ""}`;
  if (type !== "info") {
    el.classList.remove("hidden");
    setTimeout(() => { el.classList.add("hidden"); }, 5000);
  }
}

// Refresh button
document.getElementById("mcp-refresh-btn")?.addEventListener("click", loadMcpServers);

// Save all button
document.getElementById("mcp-save-all-btn")?.addEventListener("click", async () => {
  const btn = document.getElementById("mcp-save-all-btn");
  btn.disabled = true;
  btn.textContent = t("mcp.saving");
  const result = await window.goodAgent.mcpSaveAll();
  if (result.success) {
    showMcpStatus(t("mcp.config_saved"), "success");
  } else {
    showMcpStatus(t("mcp.save_fail", {error: result.error}), "error");
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
      document.getElementById("mcp-name-input")?.focus();
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
  const name = document.getElementById("mcp-name-input")?.value.trim();
  const command = document.getElementById("mcp-command-input")?.value.trim();
  const argsStr = document.getElementById("mcp-args-input")?.value.trim();
  const envStr = document.getElementById("mcp-env-input")?.value.trim();

  if (!name || !command) {
    document.getElementById("mcp-form-status").textContent = t("mcp.name_required");
    document.getElementById("mcp-form-status").classList.remove("hidden");
    return;
  }

  const args = argsStr ? argsStr.split(" ").filter(Boolean) : [];
  let env = {};
  if (envStr) {
    try { env = JSON.parse(envStr); } catch {
      document.getElementById("mcp-form-status").textContent = t("mcp.env_invalid");
      document.getElementById("mcp-form-status").classList.remove("hidden");
      return;
    }
  }

  const config = { command, args };
  if (Object.keys(env).length > 0) config.env = env;

  const saveBtn = document.getElementById("mcp-save-btn");
  saveBtn.disabled = true;
  saveBtn.textContent = t("mcp.starting");

  const result = await window.goodAgent.mcpAdd(name, config);
  if (result.success) {
    // Clear form
    document.getElementById("mcp-name-input").value = "";
    document.getElementById("mcp-command-input").value = "";
    document.getElementById("mcp-args-input").value = "";
    document.getElementById("mcp-env-input").value = "";
    document.getElementById("mcp-add-form").classList.add("hidden");
    document.getElementById("mcp-form-status").classList.add("hidden");
    await loadMcpServers();
  } else {
    document.getElementById("mcp-form-status").textContent = t("mcp.start_fail", {error: result.error});
    document.getElementById("mcp-form-status").classList.remove("hidden");
  }

  saveBtn.disabled = false;
  saveBtn.textContent = t("mcp.save_start");
});

// Load MCP servers + auto-detect when the MCP tab is opened
let _mcpTabLoaded = false;
document.querySelector('.settings-tab[data-tab="mcp"]')?.addEventListener("click", () => {
  if (_mcpTabLoaded) return;
  _mcpTabLoaded = true;
  const listEl = document.getElementById("mcp-server-list");
  if (listEl) loadMcpServers();
  detectLocalMcp();
});

// ── Quick Add SearXNG ──────────────────────────────────────
document.getElementById("mcp-searxng-add-btn")?.addEventListener("click", async () => {
  const url = document.getElementById("mcp-searxng-url")?.value.trim();
  if (!url) {
    showMcpStatus(t("mcp.searxng_url_required"), "error");
    return;
  }
  const btn = document.getElementById("mcp-searxng-add-btn");
  btn.disabled = true;
  btn.textContent = t("mcp.searxng_adding");
  try {
    const result = await window.goodAgent.mcpQuickAddSearxng(url);
    if (result.success) {
      showMcpStatus(t("mcp.searxng_added"), "success");
      document.getElementById("mcp-searxng-url").value = "";
      await loadMcpServers();
      // Refresh detect results in case they're showing
      await detectLocalMcp();
    } else {
      showMcpStatus(t("mcp.searxng_fail", {error: result.error}), "error");
    }
  } catch (e) {
    showMcpStatus(t("mcp.searxng_fail", {error: e.message}), "error");
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

// ── Detect Local MCP ────────────────────────────────────────
async function detectLocalMcp() {
  const resultsEl = document.getElementById("mcp-detect-results");
  if (!resultsEl) return;
  try {
    const servers = await window.goodAgent.mcpDetectLocal();
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
    resultsEl.querySelectorAll(".mcp-import-btn").forEach(btn => {
      btn.addEventListener("click", async () => {
        const name = btn.dataset.name;
        const command = btn.dataset.command;
        let args = [];
        try { args = JSON.parse(btn.dataset.args || "[]"); } catch {}
        let env = {};
        try { env = JSON.parse(btn.dataset.env || "{}"); } catch {}
        btn.disabled = true;
        btn.textContent = t("mcp.importing");
        const result = await window.goodAgent.mcpAdd(name, { command, args, env });
        if (result.success) {
          showMcpStatus(t("mcp.imported", {name}), "success");
          btn.textContent = t("mcp.import_done");
          await loadMcpServers();
        } else {
          showMcpStatus(t("mcp.import_fail", {name, error: result.error}), "error");
          btn.textContent = t("mcp.retry");
          btn.disabled = false;
        }
      });
    });

    // Bind remote connect buttons
    resultsEl.querySelectorAll(".mcp-remote-connect-btn").forEach(btn => {
      btn.addEventListener("click", async () => {
        const name = btn.dataset.name;
        const url = btn.dataset.url;
        const keyInput = btn.parentElement.querySelector(".mcp-remote-key");
        const apiKey = keyInput?.value?.trim() || "";
        btn.disabled = true;
        btn.textContent = t("mcp.connecting");
        const headers = apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
        const result = await window.goodAgent.mcpAddRemote(name, url, headers);
        if (result.success) {
          showMcpStatus(t("mcp.connected", {name}), "success");
          btn.textContent = t("mcp.connect_done");
          await loadMcpServers();
        } else {
          showMcpStatus(t("mcp.connect_fail", {name, error: result.error}), "error");
          btn.textContent = t("mcp.connect");
          btn.disabled = false;
        }
      });
    });
  } catch (e) {
    resultsEl.innerHTML = `<span style="color:var(--danger);font-size:12px;">${t("mcp.detect_fail", {error: sanitize(e.message)})}</span>`;
  }
}

document.getElementById("mcp-detect-btn")?.addEventListener("click", () => {
  const btn = document.getElementById("mcp-detect-btn");
  btn.disabled = true;
  btn.textContent = t("mcp.scanning");
  detectLocalMcp().finally(() => {
    btn.disabled = false;
    btn.textContent = t("mcp.scan");
  });
});

/* ── System Prompt Profile Management ─────────────────── */
let promptStore = null;
let currentProfileId = null;
let _promptDirty = false;

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

async function loadPromptStore() {
  try {
    promptStore = await window.goodAgent.listPromptProfiles();
    if (!promptStore || !promptStore.profiles) {
      promptStore = { activeProfile: "default", profiles: {} };
    }
    currentProfileId = promptStore.activeProfile || "default";
    // Ensure default profile exists
    if (!promptStore.profiles["default"]) {
      promptStore.profiles["default"] = {
        id: "default", name: t("prompt.default"), enabled: true,
        content: await window.goodAgent.getDefaultPrompt(),
      };
    }
    return promptStore;
  } catch (e) {
    console.error("[prompt] Failed to load profiles:", e);
    return null;
  }
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
  container.querySelectorAll(".prompt-profile-chip").forEach(btn => {
    btn.addEventListener("click", async () => {
      const id = btn.dataset.profileId;
      if (id === currentProfileId) return;
      if (_promptDirty) await saveCurrentProfile();
      currentProfileId = id;
      promptStore.activeProfile = id;
      await window.goodAgent.activatePromptProfile(id);
      renderProfileSelector();
      renderPromptEditor();
    });
  });
}

async function saveCurrentProfile() {
  const profile = getCurrentProfile();
  if (!profile) return;
  // Read name input
  const nameInput = document.getElementById("prompt-name-input");
  if (nameInput && nameInput.value.trim()) {
    profile.name = nameInput.value.trim();
  }
  await window.goodAgent.savePromptProfile(profile);
  _promptDirty = false;
  // Re-render selector to reflect any name change
  renderProfileSelector();
  showPromptStatus(t("prompt.saved"), "success");
}

function htmlEncode(str) {
  const div = document.createElement("div");
  div.appendChild(document.createTextNode(str));
  return div.innerHTML;
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
  const nameInput = document.getElementById("prompt-name-input");
  if (nameInput) {
    nameInput.addEventListener("input", () => { _promptDirty = true; });
  }

  // Content textarea
  const contentArea = document.getElementById("prompt-content-area");
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
      if (!p) return;
      if (nameInput && nameInput.value.trim()) p.name = nameInput.value.trim();
      p.enabled = true;
      for (const id of Object.keys(promptStore.profiles)) {
        if (id !== currentProfileId) promptStore.profiles[id].enabled = false;
      }
      for (const id of Object.keys(promptStore.profiles)) {
        await window.goodAgent.savePromptProfile(promptStore.profiles[id]);
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
      if (currentProfileId === "default") return;
      const p = getCurrentProfile();
      if (!p) return;
      if (!confirm(t("prompt.delete_confirm", {name: p.name}))) return;
      await window.goodAgent.deletePromptProfile(currentProfileId);
      delete promptStore.profiles[currentProfileId];
      currentProfileId = "default";
      promptStore.activeProfile = "default";
      await window.goodAgent.activatePromptProfile("default");
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

function showPromptStatus(msg, type) {
  const el = document.getElementById("prompt-settings-status");
  if (!el) return;
  el.textContent = msg;
  el.className = "settings-status";
  if (type) el.classList.add(`settings-status--${type}`);
  setTimeout(() => { if (el.textContent === msg) el.className = "settings-status hidden"; }, 3000);
}

// ── Prompt profile actions ──

async function addNewProfile() {
  const name = getNextProfileName();
  const id = "profile_" + Date.now();
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
  await window.goodAgent.savePromptProfile(newProfile);
  await window.goodAgent.activatePromptProfile(id);
  for (const pid of Object.keys(promptStore.profiles)) {
    if (pid !== id) await window.goodAgent.savePromptProfile(promptStore.profiles[pid]);
  }
  renderProfileSelector();
  renderPromptEditor();
}

// ── Prompt event bindings ──

document.getElementById("prompt-add-profile-btn")?.addEventListener("click", addNewProfile);

// Load prompt profiles when the prompt tab is opened
document.querySelector('.settings-tab[data-tab="prompt"]')?.addEventListener("click", async () => {
  const container = document.getElementById("prompt-sections");
  if (!container || container.children.length === 0) {
    await loadPromptStore();
    renderProfileSelector();
    renderPromptEditor();
  }
});

/* ── Settings tab switching ──────────────────────────── */
function switchSettingsTab(tabName) {
  document.querySelectorAll(".settings-tab").forEach(t => t.classList.remove("active"));
  document.querySelectorAll(".settings-panel").forEach(p => p.classList.remove("active"));
  const tab = document.querySelector(`.settings-tab[data-tab="${tabName}"]`);
  const panel = document.getElementById(`panel-${tabName}`);
  if (tab) tab.classList.add("active");
  if (panel) panel.classList.add("active");
}

document.querySelectorAll(".settings-tab").forEach(tab => {
  tab.addEventListener("click", () => {
    switchSettingsTab(tab.dataset.tab);
  });
});

/* ── Settings modal ─────────────────────────────────── */
settingsCloseBtn.addEventListener("click", () => {
  settingsModal.classList.remove("active");
});

// Close on overlay click
settingsModal.addEventListener("click", (e) => {
  if (e.target === settingsModal) settingsModal.classList.remove("active");
});

/* ── Event Listeners ──────────────────────────────────── */

// Provider dropdown change — auto-fill URL + model (skip during programmatic fill)
let _fillingForm = false;
settingsProvider?.addEventListener("change", () => { if (!_fillingForm) onProviderChange(); });

// Fetch models button
document.getElementById("settings-fetch-models-btn")?.addEventListener("click", fetchModels);

// Settings save
settingsSaveBtn?.addEventListener("click", saveSettingsForm);

// Delete all sessions
const deleteAllBtn = $("#delete-all-sessions-btn");
deleteAllBtn?.addEventListener("click", async () => {
  if (!confirm(t("sidebar.clear_confirm"))) return;
  try {
    const result = await window.goodAgent.deleteAllSessions();
    if (result && result.error) {
      showToast(t("sidebar.delete_fail", {error: result.error}));
      return;
    }
    currentSessionId = null;
    _loadedSessionId = null;
    messageList.innerHTML = "";
    showWelcome();
    refreshSessionList();
    showToast(t("sidebar.clear_done", { count: result?.deleted || 0 }));
  } catch (e) {
    console.error("deleteAllSessions error:", e);
    showToast(t("sidebar.delete_fail", {error: e.message}));
  }
});

// Settings modal: fill form when opened
settingsBtn?.addEventListener("click", () => {
  fillSettingsForm();
  settingsPreview.src = sidebarAvatar.src;
  settingsStatus.className = "settings-status hidden";
  switchSettingsTab("api"); // Always open to API config first
  settingsModal.classList.add("active");
});

// Banner settings button
bannerSettingsBtn?.addEventListener("click", () => {
  settingsBtn.click();
});

// Prompt input
promptInput.addEventListener("input", () => {
  autoResize(promptInput);
  updateSendButton();
});

promptInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    if (!sendBtn.disabled) submitQuery();
  }
});

sendBtn.addEventListener("click", submitQuery);
stopBtn.addEventListener("click", abortQuery);
newChatBtn.addEventListener("click", resetChat);

/* ── Init ──────────────────────────────────────────────── */
setupIPC();
loadAvatar();
initAgentNameUI();
applyAgentName(loadAgentName());
initUserAvatarUI();
applyUserName(loadUserName());
updateConfigBanner();

// Apply saved API config status
const cfg = loadApiConfig();
// Auto-sync to WeChat bot on startup
if (cfg.apiUrl && cfg.apiKey) {
  window.goodAgent.syncApiToWechat?.({ apiUrl: cfg.apiUrl, apiKey: cfg.apiKey, model: cfg.model, apiFormat: cfg.apiFormat || "openai" }).catch(() => {});
}
if (cfg.provider) {
  if (cwdDisplay) cwdDisplay.textContent = cfg.provider;
} else if (cfg.apiUrl) {
  if (cwdDisplay) cwdDisplay.textContent = cfg.apiUrl.replace(/https?:\/\//, "").split("/")[0];
} else {
  if (cwdDisplay) cwdDisplay.textContent = t("misc.unconfigured");
}
updateInfoBar();
if (hasApiConfig()) {
  promptInput.focus();
}

// Load saved session list
refreshSessionList();

/* ════════════════════════════════════════════════
   WeChat iLink QR Login + Bot
   ════════════════════════════════════════════════ */

let _wxPollTimer = null;

async function initWechatStatus() {
  try {
    const status = await window.goodAgent.wechatGetStatus();
    updateWechatUI(status);
  } catch (e) { console.warn("[wechat] status:", e.message); }
}

function updateWechatUI(status) {
  const badge = document.getElementById("wechat-status-badge");
  const loginBtn = document.getElementById("wechat-login-btn");
  const logoutBtn = document.getElementById("wechat-logout-btn");

  if (badge) {
    if (status.loggedIn) {
      badge.textContent = t("social.connected");
      badge.className = "wechat-badge connected";
    } else {
      badge.textContent = t("social.disconnected");
      badge.className = "wechat-badge disconnected";
    }
  }
  if (loginBtn) loginBtn.classList.toggle("hidden", status.loggedIn);
  if (logoutBtn) logoutBtn.classList.toggle("hidden", !status.loggedIn);
}

function showWxStatus(msg, type) {
  const el = document.getElementById("wechat-login-status");
  if (!el) return;
  el.textContent = msg;
  el.className = "wechat-login-status " + (type || "info");
  el.classList.remove("hidden");
}

function hideWxStatus() {
  const el = document.getElementById("wechat-login-status");
  if (el) el.classList.add("hidden");
}

// ── QR Overlay ───────────────────────────────────────────

document.getElementById("wechat-login-btn")?.addEventListener("click", async () => {
  const overlay = document.getElementById("wechat-qr-overlay");
  const qrImg = document.getElementById("wechat-qr-img");
  const loading = document.getElementById("wechat-qr-loading");
  const statusEl = document.getElementById("wechat-qr-status");
  if (overlay) overlay.classList.remove("hidden");
  if (loading) { loading.style.display = "block"; }
  if (qrImg) { qrImg.style.display = "none"; }
  if (statusEl) { statusEl.textContent = t("social.getting_qr"); statusEl.className = "wechat-qr-status"; }

  let qrcodeId = null;
  const MAX_REFRESH = 3;
  let refreshCount = 0;
  let stopped = false;

  // Close button
  document.getElementById("wechat-qr-close").onclick = () => {
    stopped = true; overlay.classList.add("hidden");
  };

  async function fetchQr() {
    try {
      if (loading) loading.style.display = "block";
      if (qrImg) qrImg.style.display = "none";
      if (statusEl) { statusEl.textContent = t("social.getting_qr"); statusEl.className = "wechat-qr-status"; }

      const result = await window.goodAgent.wechatGetQrcode();
      if (result.ok) {
        qrImg.src = result.qrcodeUrl;
        qrImg.style.display = "block";
        if (loading) loading.style.display = "none";
        qrcodeId = result.qrcodeId;
        if (statusEl) { statusEl.textContent = t("social.qr_scan"); statusEl.className = "wechat-qr-status"; }
        startPoll(qrcodeId);
      } else {
        if (statusEl) { statusEl.textContent = t("social.qr_error", {error: result.error || ""}); statusEl.className = "wechat-qr-status error"; }
      }
    } catch (err) {
      if (statusEl) { statusEl.textContent = t("social.qr_network"); statusEl.className = "wechat-qr-status error"; }
    }
  }

  async function startPoll(id) {
    while (!stopped) {
      try {
        const r = await window.goodAgent.wechatPollStatus(id);
        if (stopped) return;
        if (r.status === "scanned") {
          if (statusEl) { statusEl.textContent = t("social.qr_scanned"); statusEl.className = "wechat-qr-status"; }
        } else if (r.status === "confirmed") {
          if (statusEl) { statusEl.textContent = t("social.qr_success"); statusEl.className = "wechat-qr-status success"; }
          // Save credentials + start bot
          const cfg = loadApiConfig();
          await window.goodAgent.wechatLogin({
            botToken: r.botToken, botId: r.botId, userId: r.userId,
            apiKey: cfg.apiKey, apiUrl: cfg.apiUrl, model: cfg.model, apiFormat: cfg.apiFormat,
          });
          await initWechatStatus();
          setTimeout(() => { overlay.classList.add("hidden"); }, 1500);
          return;
        } else if (r.status === "expired") {
          refreshCount++;
          if (refreshCount >= MAX_REFRESH) {
            if (statusEl) { statusEl.textContent = t("social.qr_expired"); statusEl.className = "wechat-qr-status error"; }
            return;
          }
          await fetchQr(); return;
        }
        if (r.error && statusEl) { statusEl.textContent = r.error; }
      } catch {}
      await new Promise(r => setTimeout(r, 1000));
    }
  }

  await fetchQr();
});

// Logout
document.getElementById("wechat-logout-btn")?.addEventListener("click", async () => {
  await window.goodAgent.wechatLogout();
  await initWechatStatus();
  showWxStatus(t("social.logged_out"), "info");
});

// Bot status updates from main process
window.goodAgent.onWechatBotStatus?.((data) => {
  if (data.status === "connected") updateWechatUI({ loggedIn: true, status: "running" });
  else if (data.status === "disconnected") updateWechatUI({ loggedIn: false });
});

// Incoming message notifications
window.goodAgent.onWechatIncoming?.((data) => {
  showWxStatus(t("social.incoming", {text: data.text}), "info");
  setTimeout(hideWxStatus, 5000);
});

// Social tab click
document.querySelector('.settings-tab[data-tab="social"]')?.addEventListener("click", () => {
  initWechatStatus();
});

/* ── Memory Panel (imported from modules/memory-panel.mjs) ── */

/* ── Skills Panel (imported from modules/skills-panel.mjs) ── */

initWechatStatus();

/* ── Workspace (imported from modules/workspace.mjs) ── */

/* ── Knowledge Base (imported from modules/knowledge-base.mjs) ── */
initKnowledgeBase();
initMemoryPanel();

/* ── Language Switching ─────────────────────────────── */
(function initLanguage() {
  const langSelect = document.getElementById("lang-select");
  if (langSelect) {
    langSelect.value = getLang();
    langSelect.addEventListener("change", () => {
      setLang(langSelect.value);
      applyLang();
      // Re-render dynamic elements
      applyAgentName(loadAgentName());
      applyUserName(loadUserName());
      refreshSessionList();
      // Update welcome description
      const welcomeDesc = document.querySelector(".welcome .description");
      if (welcomeDesc) welcomeDesc.textContent = t("chat.welcome_desc", { name: loadAgentName() });
      // Update input placeholder
      const input = document.getElementById("prompt-input");
      if (input) input.placeholder = t("chat.input_placeholder", { name: loadAgentName() });
      // Re-render prompt profiles & editor (dynamically generated, not covered by applyLang)
      renderProfileSelector();
      renderPromptEditor();
      // Update KB clear status if visible
      const kbSt = document.getElementById("kb-status");
      if (kbSt && kbSt.textContent.match(/^(未配置|Not configured)$/)) kbSt.textContent = t("kb.unconfigured");
      // Update workspace
      updateWorkspaceDisplay();
    });
  }
  // Apply saved language on load
  if (typeof applyLang === "function") applyLang();
})();
