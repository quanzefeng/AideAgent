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
  "":        { name: "自定义",             url: "",                              model: "",                                   models: [], format: "openai" },
  deepseek:  { name: "DeepSeek",          url: "https://api.deepseek.com",      model: "deepseek-v4-flash",                  models: [{id:"deepseek-v4-flash",label:"DeepSeek-V4-Flash（快速，默认）"},{id:"deepseek-v4-pro",label:"DeepSeek-V4-Pro（旗舰，强大）"}], format: "openai" },
  glm:       { name: "GLM (智谱)",        url: "https://open.bigmodel.cn/api/paas/v4", model: "GLM-4.7-Flash",                  models: [{id:"GLM-4.7-Flash",label:"GLM-4.7-Flash（免费，推荐）"},{id:"GLM-4-Plus",label:"GLM-4-Plus（旗舰）"},{id:"GLM-4-Air",label:"GLM-4-Air（轻量经济）"}], format: "openai" },
  qwen:      { name: "Qwen (通义千问)",   url: "https://dashscope.aliyuncs.com/compatible-mode/v1", model: "qwen-plus",          models: [{id:"qwen3.7-max",label:"Qwen3.7-Max（最新旗舰）"},{id:"qwen-plus",label:"Qwen-Plus（均衡，默认）"},{id:"qwen-turbo",label:"Qwen-Turbo（快速经济）"}], format: "openai" },
  claude:    { name: "Claude (Anthropic)", url: "https://api.anthropic.com",     model: "claude-sonnet-4-20250514",            models: [{id:"claude-sonnet-4-20250514",label:"Claude Sonnet 4.6（均衡，推荐）"},{id:"claude-opus-4-20250514",label:"Claude Opus 4.6（旗舰）"},{id:"claude-haiku-4.5-20250514",label:"Claude Haiku 4.5（快速）"}], format: "anthropic" },
  lmstudio:  { name: "LM Studio（本地）", url: "http://localhost:1234/v1",      model: "",                                   models: [], format: "openai" },
  ollama:    { name: "Ollama（本地）",     url: "http://localhost:11434/v1",     model: "",                                   models: [], format: "openai" },
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
const USER_NAME_KEY = "goodagent_user_name";

/* ── Helpers ──────────────────────────────────────────── */
function sanitize(html) {
  return DOMPurify.sanitize(html, {
    ALLOWED_TAGS: [
      "p", "br", "b", "i", "em", "strong", "a", "ul", "ol", "li",
      "h1", "h2", "h3", "h4", "h5", "h6",
      "code", "pre", "blockquote", "hr", "table", "thead", "tbody",
      "tr", "th", "td", "span", "div", "img", "hr", "del", "input",
    ],
    ALLOWED_ATTR: ["href", "target", "class", "id", "src", "alt", "type", "checked", "disabled", "data-m"],
    ALLOWED_URI_REGEXP: /^(?:(?:https?|mailto):|[^a-z]|[a-z+.-]+(?:[^a-z+.-]|$))/i,
  });
}

function renderMarkdown(text) {
  // Replace LaTeX delimiters with HTML marker spans that survive marked + DOMPurify
  // Order matters: $$ must come before $, and \( / \[ before their closing pairs
  text = text.replace(/\$\$([\s\S]+?)\$\$/g, '<span class="kp" data-m="d">$1</span>');
  text = text.replace(/\\\(/g, '<span class="kp" data-m="i">');
  text = text.replace(/\\\)/g, '</span>');
  text = text.replace(/\\\[/g, '<span class="kp" data-m="d">');
  text = text.replace(/\\\]/g, '</span>');
  // Inline $…$ — only replace if content looks like math, not currency
  text = text.replace(/(?<!\$)\$(?!\$)([^$\n]+?)\$(?!\$)/g, (m, inner) => {
    const t = inner.trim();
    if (/^\d+[.,]?\d*%?$/.test(t)) return m;        // skip currency / plain numbers
    if (/[\\{}_^]/.test(t)) return `<span class="kp" data-m="i">${t}</span>`;
    if (/[a-zA-Z]/.test(t) && /[=+\-*/^()\[\]<>]/.test(t)) return `<span class="kp" data-m="i">${t}</span>`;
    return m;
  });
  let html = marked.parse(text);
  html = sanitize(html);
  return html;
}

function renderLatexInElement(el) {
  if (typeof katex !== "undefined" && typeof katex.render === "function") {
    el.querySelectorAll("span.kp").forEach((span) => {
      const tex = span.textContent;
      const displayMode = span.dataset.m === "d";
      try {
        katex.render(tex, span, { displayMode, throwOnError: true });
      } catch (_e) {
        // KaTeX 渲染失败（如流式输出不完整公式）→ 回退显示原始 LaTeX 源码
        span.outerHTML = displayMode
          ? `<div class="katex-raw">\\[${tex.replace(/</g, "&lt;")}\\]</div>`
          : `<span class="katex-raw">\\(${tex.replace(/</g, "&lt;")}\\)</span>`;
      }
    });
  }
}

function autoResize(textarea) {
  textarea.style.height = "auto";
  textarea.style.height = Math.min(textarea.scrollHeight, 200) + "px";
}

/* ── File upload ──────────────────────────────── */
const MAX_FILE_SIZE = 20 * 1024 * 1024; // 20 MB

function formatFileSize(bytes) {
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
  return (bytes / (1024 * 1024)).toFixed(1) + " MB";
}

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
      <button class="file-chip-remove" data-index="${i}" title="移除">✕</button>
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
      addErrorMessage(`文件 "${file.name}" 超过 20MB 限制，已跳过`);
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

function setStatus(text) {
  if (statusText) statusText.textContent = text;
}

/* ── Reasoning toggle ────────────────────────────── */
function loadReasoningEnabled() {
  const val = localStorage.getItem(STORAGE_KEYS.REASONING_ENABLED);
  return val !== null ? val === "true" : true; // default true
}

function saveReasoningEnabled(enabled) {
  localStorage.setItem(STORAGE_KEYS.REASONING_ENABLED, enabled);
}

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
}

function scrollToBottom() {
  messageList.scrollTop = messageList.scrollHeight;
}

/* ── Message DOM ──────────────────────────────────────── */
function addUserMessage(text) {
  const div = document.createElement("div");
  div.className = "message user";
  const userName = loadUserName();
  const userAvatarSrc = loadUserAvatarSrc();
  const avatarHtml = userAvatarSrc ? `<img class="avatar user-msg-avatar" src="${userAvatarSrc}" alt="" />` : "";
  div.innerHTML = `
    <div class="message-label">${userName}${avatarHtml}</div>
    <div class="message-bubble"><p>${sanitize(text.replace(/</g, "&lt;").replace(/>/g, "&gt;"))}</p></div>
  `;
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
  div.innerHTML = `
    <div class="message-label">
      <img class="avatar msg-avatar" src="${avatarSrc}" alt="" />
      ${agentName}
    </div>
    <div class="message-content">
      <div class="message-text"></div>
    </div>
  `;
  messageList.appendChild(div);
  scrollToBottom();
  return div;
}

function addErrorMessage(text) {
  const div = document.createElement("div");
  div.className = "message error";
  div.innerHTML = `
    <div class="message-label">错误</div>
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
  const section = getOrCreateThinkingSection();
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
    textEl.innerHTML = '<span class="thinking-indicator">思考中...</span>';
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
      <button class="msg-action-btn" title="复制内容" data-action="copy">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
      </button>
      <button class="msg-action-btn" title="下载为 Markdown" data-action="download">
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
          btn.innerHTML = '<span style="color:#22c55e">已复制</span>';
          setTimeout(() => { btn.innerHTML = orig; }, 2000);
        } catch { /* ignore */ }
      } else if (btn.dataset.action === "download") {
        btn.disabled = true;
        const orig = btn.innerHTML;
        btn.innerHTML = "保存中...";
        const result = await window.goodAgent.downloadMarkdown(text);
        if (result.success) {
          btn.innerHTML = '<span style="color:#22c55e">已保存</span>';
          setTimeout(() => { btn.innerHTML = orig; }, 2000);
        } else if (!result.canceled) {
          btn.innerHTML = '<span style="color:#ef4444">失败</span>';
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
      <p class="description">任何事都可以找 ${agentName}</p>
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
  const apiKey = localStorage.getItem(provider ? `goodagent_api_key_${provider}` : "goodagent_api_key") || "";
  return {
    provider,
    apiUrl: localStorage.getItem(STORAGE_KEYS.API_URL) || "",
    model: localStorage.getItem(STORAGE_KEYS.MODEL) || "",
    apiKey,
    apiFormat: localStorage.getItem(STORAGE_KEYS.API_FORMAT) || "openai",
  };
}

function saveApiConfig(provider, apiUrl, model, apiKey, apiFormat) {
  if (apiUrl) localStorage.setItem(STORAGE_KEYS.API_URL, apiUrl);
  localStorage.setItem(STORAGE_KEYS.PROVIDER, provider);
  if (model) localStorage.setItem(STORAGE_KEYS.MODEL, model);
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
      customOpt.textContent = selectedModel + "（自定义）";
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
  const cfg = loadApiConfig();
  if (settingsProvider) settingsProvider.value = cfg.provider;
  // If provider has a preset, use its URL; otherwise use saved raw values
  const preset = PROVIDER_PRESETS[cfg.provider];
  if (settingsUrl) settingsUrl.value = preset && cfg.provider ? preset.url : cfg.apiUrl;
  // Populate model dropdown with preset models, selecting the saved model
  if (settingsModel) {
    const selectedModel = preset && cfg.provider ? (preset.model || cfg.model) : cfg.model;
    populateModelDropdown(preset, selectedModel);
  }
  if (settingsKey) settingsKey.value = cfg.apiKey;
}

function onProviderChange() {
  const key = settingsProvider?.value || "";
  const preset = PROVIDER_PRESETS[key];
  if (preset && key) {
    settingsUrl.value = preset.url;
    populateModelDropdown(preset, preset.model);
    if (preset.models.length === 0 && preset.url) {
      setTimeout(fetchModels, 300);
    }
  } else {
    populateModelDropdown(null, "");
  }
  // Load provider-specific API key
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
      settingsStatus.textContent = "请填写 API URL";
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
    settingsStatus.textContent = `✅ 已保存 — ${preset?.name || provider || "自定义"} API`;
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
  btn.textContent = "获取中...";

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
      settingsStatus.textContent = "请先填写 API URL";
      settingsStatus.className = "settings-status error";
    }
    btn.disabled = false;
    btn.classList.remove("fetching");
    btn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:middle;margin-right:4px;"><path d="M21 12a9 9 0 1 1-6.219-8.56"/><path d="M21 3v5h-5"/></svg> 获取模型';
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
      settingsStatus.textContent = `✅ 获取到 ${models.length} 个模型`;
      settingsStatus.className = "settings-status success";
    }
  } else {
    if (settingsStatus) {
      settingsStatus.textContent = "未获取到模型，请检查 API URL 是否正确";
      settingsStatus.className = "settings-status error";
    }
  }

  btn.disabled = false;
  btn.classList.remove("fetching");
  btn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:middle;margin-right:4px;"><path d="M21 12a9 9 0 1 1-6.219-8.56"/><path d="M21 3v5h-5"/></svg> 获取模型';
}

/* ── Query ────────────────────────────────────────────── */
async function submitQuery() {
  const text = promptInput.value.trim();
  const files = state.attachedFiles;
  if ((!text && files.length === 0) || state.isStreaming) return;

  const cfg = loadApiConfig();
  if (!cfg.apiUrl) {
    addErrorMessage("请先在设置中配置 API URL");
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
      if (f.type.startsWith("image/")) {
        return `<div style="margin:4px 0"><img src="${f.dataUrl}" alt="${f.name}" style="max-width:200px;max-height:150px;border-radius:6px;object-fit:cover;border:1px solid var(--border);" /></div>`;
      }
      return `<div style="display:flex;align-items:center;gap:6px;padding:4px 0;font-size:13px;color:var(--text-light);"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg> ${f.name}</div>`;
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
  setStatus("思考中...");

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
    await window.goodAgent.submitQuery(text, cfg.apiKey, cfg.apiUrl, cfg.model, cfg.apiFormat, apiFiles, enabledSkills, reasoning, agentName);
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
  setStatus("就绪");
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
  setStatus("就绪");
  refreshSessionList();
}

/* ── Session List ──────────────────────────────────────────── */
let _loadedSessionId = null;

function refreshSessionList() {
  window.goodAgent.listSessions().then(sessions => {
    const container = document.getElementById("session-list");
    if (!container) return;
    if (!sessions || sessions.length === 0) {
      container.innerHTML = '<div class="session-list-empty">暂无历史会话</div>';
      return;
    }
    container.innerHTML = sessions.map(s => `
      <div class="session-item ${_loadedSessionId === s.id ? "active" : ""}" data-session-id="${s.id}">
        <div class="session-item-title" title="${sanitize(s.title || "(无标题)")}">${sanitize((s.title || "(无标题)").slice(0, 28))}</div>
        <div class="session-item-actions">
          <button class="session-export" data-session-id="${s.id}" title="导出为 Markdown">↓</button>
          <button class="session-delete" data-session-id="${s.id}" title="删除此会话">×</button>
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
      container.innerHTML = '<div class="session-list-empty">未找到匹配</div>';
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
    state.currentAssistantMsg = null;
    state._toolCallCount = 0;
    state._afterToolCall = false;
    state._reasoningBlockText = "";
    sendBtn.classList.remove("hidden");
    stopBtn.classList.add("hidden");
    sendBtn.disabled = false;
    promptInput.value = "";
    setStatus("就绪");

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
    if (id && confirm("确定删除此会话？")) {
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
function getOrCreateThinkingSection() {
  const msgEl = state.currentAssistantMsg;
  if (!msgEl) return null;
  let section = msgEl.querySelector(".thinking-collapsible");
  if (!section) {
    const content = msgEl.querySelector(".message-content");
    if (!content) return null;
    section = document.createElement("details");
    section.className = "thinking-collapsible";
    section.innerHTML = `<summary>🧠 推理过程</summary><div class="thinking-content"></div>`;
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
      <span class="tool-entry-status">运行中...</span>
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
    : `<span style="color:var(--success);">完成</span>`;
  el.querySelector(".tool-entry-status").textContent = `${statusIcon} 完成`;
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
    if (active.length > 0) parts.push(`${active.length} 个任务`);
    if (todoActive.length > 0) parts.push(`${todoActive.length} 个 todo`);
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
    addErrorMessage(data.message || "发生了未知错误");
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
      el.title = `超过硬限制 ${data.hardThreshold.toLocaleString()}，将被截断`;
    } else if (data.overWarn) {
      el.textContent = `⚡ ${data.estimatedTokens.toLocaleString()} tokens`;
      el.className = "token-budget warn";
      el.title = `接近限制 ${data.hardThreshold.toLocaleString()}`;
    } else {
      // Only show when above 4000, otherwise hide
      if (data.estimatedTokens < 4000) {
        el.classList.add("hidden");
        el.textContent = "";
        return;
      }
      el.textContent = `${data.estimatedTokens.toLocaleString()} tokens`;
      el.className = "token-budget ok";
      el.title = "系统提示词的估算 token 数（含记忆/任务/技能等上下文）";
    }
  });
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
    showToast("头像保存失败：图片过大，请选择较小的图片", "error");
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
    showToast("请选择图片文件", "error");
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
    showToast(`图片解码失败："${file.name}"（${mimeType}），请换一张图`, "error");
  };

  img.src = blobUrl;
  avatarFileInput.value = "";
});

changeAvatarBtn.addEventListener("click", () => {
  avatarFileInput.click();
});

resetAvatarBtn.addEventListener("click", resetAvatar);

/* ── Agent Name ──────────────────────────────────────── */
const AGENT_NAME_KEY = "goodagent_name";

function loadAgentName() {
  return localStorage.getItem(AGENT_NAME_KEY) || "GoodAgent";
}

function saveAgentName(name) {
  if (!name || !name.trim()) return;
  name = name.trim();
  localStorage.setItem(AGENT_NAME_KEY, name);
  applyAgentName(name);
  showToast(`名称已改为 "${name}"`, "info");
}

function applyAgentName(name) {
  // Sidebar brand
  const brand = document.getElementById("sidebar-brand");
  if (brand) brand.textContent = name;

  // Page title
  document.title = name;

  // Input placeholder
  const input = document.getElementById("prompt-input");
  if (input) input.placeholder = `向 ${name} 提问...`;

  // Welcome page (if visible)
  const welcomeTitle = document.querySelector(".welcome h1");
  if (welcomeTitle) welcomeTitle.textContent = name;
  const welcomeDesc = document.querySelector(".welcome .description");
  if (welcomeDesc) welcomeDesc.innerHTML = `任何事都可以找 ${name}`;
  const welcomeAvatar = document.getElementById("welcome-avatar");
  if (welcomeAvatar) welcomeAvatar.alt = name;

  // Existing assistant message labels (preserve avatar img)
  document.querySelectorAll(".message.assistant .message-label").forEach(el => {
    const img = el.querySelector(".msg-avatar");
    const imgSrc = img ? img.src : "";
    el.innerHTML = imgSrc
      ? `<img class="avatar msg-avatar" src="${imgSrc}" alt="" />${name}`
      : name;
  });
}

// Name input save
const agentNameInput = document.getElementById("agent-name-input");
const saveAgentNameBtn = document.getElementById("save-agent-name-btn");

function initAgentNameUI() {
  const saved = loadAgentName();
  if (agentNameInput) agentNameInput.value = saved;
}

if (saveAgentNameBtn && agentNameInput) {
  saveAgentNameBtn.addEventListener("click", () => {
    saveAgentName(agentNameInput.value);
  });
  agentNameInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") saveAgentName(agentNameInput.value);
  });
}

/* ── User Name ──────────────────────────────────────── */
function loadUserName() {
  return localStorage.getItem(USER_NAME_KEY) || "你";
}

function saveUserName(name) {
  if (!name || !name.trim()) return;
  name = name.trim();
  localStorage.setItem(USER_NAME_KEY, name);
  applyUserName(name);
  const input = document.getElementById("user-name-input");
  if (input) input.value = name;
  showToast(`你的名称已改为 "${name}"`, "info");
}

function applyUserName(name) {
  // Update existing user message labels
  document.querySelectorAll(".message.user .message-label").forEach(el => {
    const img = el.querySelector(".user-msg-avatar");
    const imgSrc = img ? img.src : "";
    if (imgSrc) {
      el.innerHTML = `${name}<img class="avatar user-msg-avatar" src="${imgSrc}" alt="" />`;
    } else {
      el.textContent = name;
    }
  });
}

const userNameInput = document.getElementById("user-name-input");
const saveUserNameBtn = document.getElementById("save-user-name-btn");
if (saveUserNameBtn && userNameInput) {
  saveUserNameBtn.addEventListener("click", () => saveUserName(userNameInput.value));
  userNameInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") saveUserName(userNameInput.value);
  });
}

/* ── User Avatar ─────────────────────────────────────── */
const userAvatarFileInput = document.getElementById("user-avatar-file-input");
const changeUserAvatarBtn = document.getElementById("change-user-avatar-btn");
const resetUserAvatarBtn = document.getElementById("reset-user-avatar-btn");

function loadUserAvatarSrc() {
  return localStorage.getItem(USER_AVATAR_KEY) || "";
}

function loadUserAvatar() {
  const src = loadUserAvatarSrc();
  const preview = document.getElementById("user-settings-preview");
  if (preview) preview.src = src || "avatar.jpg";
  // Inject or update avatar in all existing user message labels
  document.querySelectorAll(".message.user .message-label").forEach(el => {
    const existing = el.querySelector(".user-msg-avatar");
    if (src) {
      if (existing) {
        existing.src = src;
      } else {
        const img = document.createElement("img");
        img.className = "avatar user-msg-avatar";
        img.src = src;
        img.alt = "";
        el.appendChild(img);
      }
    } else {
      if (existing) existing.remove();
    }
  });
}

function saveUserAvatar(src) {
  try {
    localStorage.setItem(USER_AVATAR_KEY, src);
    loadUserAvatar();
  } catch (e) {
    console.error("[user avatar] save failed:", e.message);
    showToast("头像保存失败：图片过大，请选择较小的图片", "error");
  }
}

function resetUserAvatar() {
  localStorage.removeItem(USER_AVATAR_KEY);
  loadUserAvatar();
}

function initUserAvatarUI() {
  const src = loadUserAvatarSrc();
  const preview = document.getElementById("user-settings-preview");
  if (preview) preview.src = src || "avatar.jpg";
  const input = document.getElementById("user-name-input");
  if (input) input.value = loadUserName();
}

// User avatar file upload
userAvatarFileInput.addEventListener("change", async () => {
  const file = userAvatarFileInput.files?.[0];
  if (!file) return;
  if (!file.type.startsWith("image/")) {
    showToast("请选择图片文件", "error");
    userAvatarFileInput.value = "";
    return;
  }
  let realType;
  try {
    const header = await file.slice(0, 12).arrayBuffer();
    realType = detectMimeFromHeader(header);
  } catch (e) {
    realType = file.type;
  }
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
    saveUserAvatar(compressed);
  };
  img.onerror = () => {
    URL.revokeObjectURL(blobUrl);
    showToast(`图片解码失败，请换一张图`, "error");
  };
  img.src = blobUrl;
  userAvatarFileInput.value = "";
});

if (changeUserAvatarBtn) {
  changeUserAvatarBtn.addEventListener("click", () => userAvatarFileInput.click());
}
if (resetUserAvatarBtn) {
  resetUserAvatarBtn.addEventListener("click", resetUserAvatar);
}

/* ── Skills ──────────────────────────────────────────── */
const SKILLS_KEY = "goodagent_enabled_skills";

async function loadAndRenderSkills() {
  const listEl = document.getElementById("local-skills-list");
  const countEl = document.getElementById("skills-count");
  if (!listEl) return;
  try {
    listEl.innerHTML = '<div class="skills-loading">正在扫描 L3 本地技能...</div>';
    const skills = await window.goodAgent.listSkills();
    if (!skills || skills.length === 0) {
      listEl.innerHTML = '<div class="skills-empty">未找到本地技能。<br/>技能存放在 <code>.agents/</code> 或 <code>.claude/skills/</code> 目录下。</div>';
      if (countEl) countEl.textContent = "0 个技能";
      return;
    }
    if (countEl) countEl.textContent = `${skills.length} 个技能`;

    const enabled = loadEnabledSkills();

    listEl.innerHTML = skills.map(s => {
      const isOn = enabled.includes(s.name);
      return `<div class="skill-card">
        <div class="skill-card-info">
          <div class="skill-card-name">${sanitize(s.name)}</div>
          <div class="skill-card-meta">
            <span class="skill-card-source">${s.source === "agents" ? "🤖 .agents" : "📦 .claude"}</span>
            ${s.version ? `<span class="skill-card-version">v${sanitize(s.version)}</span>` : ""}
            ${s.triggers && s.triggers.length > 0 ? `<span class="skill-card-triggers">触发: ${sanitize(s.triggers.slice(0, 3).join(", "))}</span>` : ""}
            ${s.allowedTools && s.allowedTools.length > 0 ? `<span class="skill-card-tools">${s.allowedTools.length} 个工具</span>` : ""}
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
        if (cb.checked) {
          if (!en.includes(name)) en.push(name);
        } else {
          const idx = en.indexOf(name);
          if (idx >= 0) en.splice(idx, 1);
        }
        saveEnabledSkills(en);
      });
    });
  } catch (err) {
    console.error("[skills] load error:", err);
    listEl.innerHTML = '<div class="skills-empty" style="color:var(--danger);">加载本地技能失败</div>';
  }
}

function loadEnabledSkills() {
  try {
    const raw = localStorage.getItem(SKILLS_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch { return []; }
}

function saveEnabledSkills(skills) {
  try { localStorage.setItem(SKILLS_KEY, JSON.stringify(skills)); } catch {}
}

document.getElementById("skills-refresh-btn")?.addEventListener("click", loadAndRenderSkills);

// Load L3 skills when the "技能" tab is opened
document.querySelector('.settings-tab[data-tab="skills"]')?.addEventListener("click", () => {
  const listEl = document.getElementById("local-skills-list");
  if (listEl && (listEl.children.length === 0 || listEl.querySelector(".skills-empty, .skills-loading"))) {
    loadAndRenderSkills();
  }
});

// Load curator config when "Agent技能" tab is opened
document.querySelector('.settings-tab[data-tab="agent-skills"]')?.addEventListener("click", () => {
  loadCuratorConfig();
});

// ── Curator config ─────────────────────────────────────────
async function loadCuratorConfig() {
  try {
    const status = await window.goodAgent.skillsCuratorStatus();
    const el = document.getElementById("curator-days-input");
    const line = document.getElementById("curator-status-line");
    if (el) el.value = status.archiveAfterDays ?? 30;
    if (line) {
      const lastRun = status.lastRun ? new Date(status.lastRun).toLocaleString("zh-CN") : "从未";
      line.textContent = `状态: ${status.activeSkills} 活跃, ${status.archivedSkills} 已存档 | 上次运行: ${lastRun}`;
    }
  } catch {}
}

document.getElementById("curator-save-btn")?.addEventListener("click", async () => {
  const input = document.getElementById("curator-days-input");
  if (!input) return;
  const days = parseInt(input.value, 10);
  if (isNaN(days) || days < 1) { alert("请输入 1-365 之间的天数"); return; }
  try {
    await window.goodAgent.skillsCuratorConfig({ archiveAfterDays: days });
    loadCuratorConfig();
    const line = document.getElementById("curator-status-line");
    if (line) line.textContent += " ✅ 已保存";
  } catch (e) {
    alert("保存失败: " + e.message);
  }
});

// ── Skill Editor Modal ──────────────────────────────────────
// Use event delegation for dynamically created edit/export buttons
document.addEventListener("click", async (e) => {
  // Edit button
  const editBtn = e.target.closest(".skill-edit-btn");
  if (editBtn) {
    const name = editBtn.dataset.skill;
    await openSkillEditor(name);
    return;
  }
  // Export button
  const exportBtn = e.target.closest(".skill-export-btn");
  if (exportBtn) {
    const name = exportBtn.dataset.skill;
    await exportSkillAsJson(name);
    return;
  }
});

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
    statusEl.textContent = "加载中...";
    statusEl.classList.remove("hidden");

    // Try L2 managed store first, fall back to L3 scanned skills
    let skill = await window.goodAgent.skillsLoadOne(name);
    if (!skill) {
      skill = await window.goodAgent.loadSkill(name);
    }
    if (!skill) { throw new Error("技能不存在"); }

    titleEl.textContent = `编辑技能 — ${skill.name || name}`;
    nameEl.value = skill.name || name;
    descEl.value = skill.description || "";
    triggersEl.value = (skill.triggers || []).join(", ");
    bodyEl.value = skill.body || "";
    overlay.dataset.editName = name;
    overlay.dataset.editSource = skill.source || "local"; // track where it came from
    overlay.classList.remove("hidden");

    statusEl.classList.add("hidden");
  } catch (err) {
    statusEl.textContent = "加载失败: " + err.message;
    statusEl.className = "settings-status error";
    statusEl.classList.remove("hidden");
  }
}

document.getElementById("skill-editor-close")?.addEventListener("click", () => {
  document.getElementById("skill-editor-overlay")?.classList.add("hidden");
});
document.getElementById("skill-editor-cancel")?.addEventListener("click", () => {
  document.getElementById("skill-editor-overlay")?.classList.add("hidden");
});
// Close on overlay click
document.getElementById("skill-editor-overlay")?.addEventListener("click", (e) => {
  if (e.target === e.currentTarget) e.currentTarget.classList.add("hidden");
});

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
  saveBtn.disabled = true; saveBtn.textContent = "保存中...";

  try {
    const origName = overlay.dataset.editName;
    const name = nameEl.value.trim();
    if (!name) throw new Error("名称不能为空");

    const triggers = triggersEl.value.split(",").map(s => s.trim()).filter(Boolean);
    const meta = {
      name,
      description: descEl.value.trim(),
      triggers,
      // Preserve original name in meta if changed (for rename)
      ...(origName !== name ? { _origin: origName } : {}),
    };
    const body = bodyEl.value;

    await window.goodAgent.skillsSaveSkill(name, meta, body);
    overlay.classList.add("hidden");
    // Refresh the agent-skills list (L2), since editor saves to L2
    if (typeof refreshSkillsList === "function") refreshSkillsList();
  } catch (err) {
    statusEl.textContent = "保存失败: " + err.message;
    statusEl.className = "settings-status error";
    statusEl.classList.remove("hidden");
  } finally {
    saveBtn.disabled = false; saveBtn.textContent = origText;
  }
});

// ── Skill Export/Import ────────────────────────────────────
async function exportSkillAsJson(name) {
  try {
    let skill = await window.goodAgent.skillsLoadOne(name);
    if (!skill) {
      skill = await window.goodAgent.loadSkill(name);
    }
    if (!skill) throw new Error("技能不存在");
    const json = JSON.stringify({ name: skill.name, description: skill.description, triggers: skill.triggers || [], body: skill.body || "" }, null, 2);
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${skill.name || name}.skill.json`;
    a.click();
    URL.revokeObjectURL(url);
  } catch (err) {
    alert("导出失败: " + err.message);
  }
}

document.getElementById("agent-skills-import-btn")?.addEventListener("click", () => {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = ".json";
  input.onchange = async () => {
    const file = input.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      const data = JSON.parse(text);
      if (!data.body && !data.steps) throw new Error("无效的技能文件: 缺少 body 或 steps");
      const meta = { name: data.name || file.name.replace(/\.[^.]+$/, ""), description: data.description || "", triggers: data.triggers || [] };
      const body = data.body || (Array.isArray(data.steps) ? data.steps.map((s, i) => `${i + 1}. ${s}`).join("\n") : "");
      await window.goodAgent.skillsSaveSkill(meta.name, meta, body);
      if (typeof refreshSkillsList === "function") refreshSkillsList();
    } catch (err) {
      alert("导入失败: " + err.message);
    }
  };
  input.click();
});

// Agent skills refresh
document.getElementById("agent-skills-refresh-btn")?.addEventListener("click", () => {
  _skillsPanelLoaded = false;
  loadSkillsPanel();
});

/* ── MCP Servers ──────────────────────────────────────── */

async function loadMcpServers() {
  const listEl = document.getElementById("mcp-server-list");
  if (!listEl) return;
  try {
    const servers = await window.goodAgent.mcpList();
    if (!servers || servers.length === 0) {
      listEl.innerHTML = '<p class="hint" style="padding:24px 0;text-align:center;">没有配置 MCP 服务器。点击"添加服务器"开始。</p>';
      return;
    }
    listEl.innerHTML = servers.map(s => {
      const statusIcon = s.status === "running" ? "🟢" : s.status === "error" ? "🔴" : "🟡";
      const toolList = s.tools.length > 0
        ? s.tools.map(t => `<code style="font-size:12px;background:var(--bg-tertiary);padding:1px 6px;border-radius:4px;white-space:nowrap;">${sanitize(t.name)}</code>`).join(" ")
        : '<span class="hint" style="font-size:12px;">(无工具)</span>';
      const errMsg = s.error ? `<div class="mcp-server-error">${sanitize(s.error)}</div>` : "";
      return `<div class="mcp-server-card">
        <div class="mcp-server-header">
          <div class="mcp-server-name">
            <span class="mcp-server-status-dot" style="color:${s.status === "running" ? "#22c55e" : s.status === "error" ? "#ef4444" : "#eab308"}">●</span>
            <strong>${sanitize(s.name)}</strong>
            <span class="mcp-server-status-label">${statusIcon} ${s.status === "running" ? "运行中" : s.status === "error" ? "错误" : "启动中..."}</span>
          </div>
          <div class="mcp-server-actions">
            <button class="btn mcp-restart-btn" data-name="${sanitize(s.name)}" style="font-size:12px;padding:4px 10px;" ${s.status === "starting" ? "disabled" : ""}>
              ${s.status === "running" ? "重启" : s.status === "error" ? "重试" : "重启"}
            </button>
            <button class="btn mcp-remove-btn" data-name="${sanitize(s.name)}" style="font-size:12px;padding:4px 10px;color:var(--danger);border-color:rgba(208,49,45,0.3);">移除</button>
          </div>
        </div>
        ${errMsg}
        <div class="mcp-server-tools">
          <span class="hint" style="font-size:12px;margin-right:6px;">工具:</span>
          ${toolList}
        </div>
      </div>`;
    }).join("");

    // Bind restart buttons
    listEl.querySelectorAll(".mcp-restart-btn").forEach(btn => {
      btn.addEventListener("click", async () => {
        const name = btn.dataset.name;
        btn.disabled = true;
        btn.textContent = "重启中...";
        const result = await window.goodAgent.mcpRestart(name);
        if (!result.success) {
          showMcpStatus(`重启 "${name}" 失败: ${result.error}`, "error");
        }
        await loadMcpServers();
        btn.disabled = false;
        btn.textContent = "重启";
      });
    });

    // Bind remove buttons
    listEl.querySelectorAll(".mcp-remove-btn").forEach(btn => {
      btn.addEventListener("click", async () => {
        const name = btn.dataset.name;
        if (!confirm(`确定移除 MCP 服务器 "${name}"？`)) return;
        btn.disabled = true;
        const result = await window.goodAgent.mcpRemove(name);
        if (!result.success) {
          showMcpStatus(`移除 "${name}" 失败: ${result.error}`, "error");
        }
        await loadMcpServers();
      });
    });
  } catch (err) {
    console.error("[mcp] load error:", err);
    if (listEl) listEl.innerHTML = '<div class="hint" style="padding:24px 0;text-align:center;color:var(--danger);">加载 MCP 服务器失败</div>';
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
  btn.textContent = "保存中...";
  const result = await window.goodAgent.mcpSaveAll();
  if (result.success) {
    showMcpStatus("✅ MCP 配置已保存", "success");
  } else {
    showMcpStatus(`保存失败: ${result.error}`, "error");
  }
  btn.disabled = false;
  btn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:middle;margin-right:4px;"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></svg> 保存配置';
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
    document.getElementById("mcp-form-status").textContent = "名称和命令不能为空";
    document.getElementById("mcp-form-status").classList.remove("hidden");
    return;
  }

  const args = argsStr ? argsStr.split(" ").filter(Boolean) : [];
  let env = {};
  if (envStr) {
    try { env = JSON.parse(envStr); } catch {
      document.getElementById("mcp-form-status").textContent = "环境变量格式错误，请输入有效 JSON";
      document.getElementById("mcp-form-status").classList.remove("hidden");
      return;
    }
  }

  const config = { command, args };
  if (Object.keys(env).length > 0) config.env = env;

  const saveBtn = document.getElementById("mcp-save-btn");
  saveBtn.disabled = true;
  saveBtn.textContent = "启动中...";

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
    document.getElementById("mcp-form-status").textContent = `启动失败: ${result.error}`;
    document.getElementById("mcp-form-status").classList.remove("hidden");
  }

  saveBtn.disabled = false;
  saveBtn.textContent = "保存并启动";
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
    showMcpStatus("请填写 SearXNG URL", "error");
    return;
  }
  const btn = document.getElementById("mcp-searxng-add-btn");
  btn.disabled = true;
  btn.textContent = "添加中...";
  try {
    const result = await window.goodAgent.mcpQuickAddSearxng(url);
    if (result.success) {
      showMcpStatus("✅ SearXNG 已添加并启动", "success");
      document.getElementById("mcp-searxng-url").value = "";
      await loadMcpServers();
      // Refresh detect results in case they're showing
      await detectLocalMcp();
    } else {
      showMcpStatus(`添加失败: ${result.error}`, "error");
    }
  } catch (e) {
    showMcpStatus(`添加失败: ${e.message}`, "error");
  }
  btn.disabled = false;
  btn.textContent = "添加";
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
      resultsEl.innerHTML = '<span style="color:var(--text-light);">未找到本地 MCP 配置。已扫描 Claude Code CLI (~/.claude/)、OpenCode 等位置。</span>';
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
          const note = s.disabled ? ' <span style="color:var(--text-light);font-size:11px;">(已禁用)</span>' : "";
          return `<div style="display:flex;align-items:center;justify-content:space-between;padding:4px 0;border-bottom:1px solid var(--border);">
            <div style="flex:1;min-width:0;">
              <strong style="font-size:13px;">${sanitize(s.serverName)}</strong>${note}
              <div style="font-size:11px;color:var(--text-light);">${label}</div>
            </div>
            <button class="btn mcp-import-btn" style="font-size:11px;padding:2px 8px;" data-name="${sanitize(s.serverName)}" data-command="${sanitize(s.command)}" data-args='${sanitize(JSON.stringify(s.args))}' data-env='${sanitize(JSON.stringify(s.env))}'>导入</button>
          </div>`;
        }
        // ── Remote (HTTP) MCP ──
        const url = s.url || "";
        const note = s.disabled ? ' <span style="color:var(--text-light);font-size:11px;">(已禁用)</span>' : "";
        return `<div style="padding:4px 0;border-bottom:1px solid var(--border);">
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:4px;">
            <strong style="font-size:13px;">${sanitize(s.serverName)}</strong>${note}
          </div>
          <div style="font-size:11px;color:var(--text-light);margin-bottom:4px;"><code style="word-break:break-all;">${sanitize(url)}</code></div>
          <div style="display:flex;align-items:center;gap:6px;">
            <input type="password" class="form-input mcp-remote-key" style="flex:1;font-size:12px;padding:4px 8px;" placeholder="API Key (Bearer token)" />
            <button class="btn mcp-remote-connect-btn" style="font-size:11px;padding:4px 10px;white-space:nowrap;" data-name="${sanitize(s.serverName)}" data-url="${sanitize(url)}">连接</button>
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
        btn.textContent = "导入中...";
        const result = await window.goodAgent.mcpAdd(name, { command, args, env });
        if (result.success) {
          showMcpStatus(`✅ "${name}" 已导入`, "success");
          btn.textContent = "✅ 已导入";
          await loadMcpServers();
        } else {
          showMcpStatus(`导入 "${name}" 失败: ${result.error}`, "error");
          btn.textContent = "重试";
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
        btn.textContent = "连接中...";
        const headers = apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
        const result = await window.goodAgent.mcpAddRemote(name, url, headers);
        if (result.success) {
          showMcpStatus(`✅ "${name}" 已连接`, "success");
          btn.textContent = "✅ 已连接";
          await loadMcpServers();
        } else {
          showMcpStatus(`连接 "${name}" 失败: ${result.error}`, "error");
          btn.textContent = "连接";
          btn.disabled = false;
        }
      });
    });
  } catch (e) {
    resultsEl.innerHTML = `<span style="color:var(--danger);font-size:12px;">检测失败: ${sanitize(e.message)}</span>`;
  }
}

document.getElementById("mcp-detect-btn")?.addEventListener("click", () => {
  const btn = document.getElementById("mcp-detect-btn");
  btn.disabled = true;
  btn.textContent = "扫描中...";
  detectLocalMcp().finally(() => {
    btn.disabled = false;
    btn.textContent = "扫描";
  });
});

/* ── System Prompt Profile Management ─────────────────── */
const SECTION_LABELS = {
  identity:      { label: "身份定义",      hint: "定义 AI 的角色、名称和核心定位" },
  workflow:      { label: "核心工作流",    hint: "定义 AI 处理任务的通用工作流程" },
  tools:         { label: "工具使用协议",  hint: "定义 AI 使用工具的约束和偏好" },
  behavior:      { label: "行为规范",      hint: "定义 AI 的行为准则和禁忌" },
  communication: { label: "沟通风格",      hint: "定义 AI 的语言风格、语气和格式" },
  skills:        { label: "技能系统",      hint: "定义 AI 如何发现和使用技能" },
  safety:        { label: "安全边界",      hint: "定义 AI 的安全约束和权限范围" },
  runtime:       { label: "运行时上下文",  hint: "定义 AI 的工作目录、环境等信息" },
  examples:      { label: "示例",          hint: "提供交互示例格式供 AI 参考" },
};

let promptStore = null;
let currentProfileId = null;
let _promptDirty = false;

function getNextProfileName() {
  if (!promptStore) return "系统提示词1";
  const ids = Object.keys(promptStore.profiles);
  let max = 0;
  for (const id of ids) {
    const p = promptStore.profiles[id];
    const m = p.name && p.name.match(/^系统提示词(\d+)$/);
    if (m) {
      const n = parseInt(m[1], 10);
      if (n > max) max = n;
    }
  }
  return "系统提示词" + (max + 1);
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
        id: "default", name: "默认", enabled: true,
        sections: {
          identity: {
            enabled: true,
            content: "You are GoodAgent, an expert coding assistant running on Windows with direct access to the user's computer. Your name is GoodAgent, NOT Claude and NOT DeepSeek \u2014 you are a desktop AI coding agent called GoodAgent.",
          },
          workflow: {
            enabled: true,
            content: "1. First explore the project with `dir` or `Get-ChildItem`.\n2. Understand the user's request clearly before taking action.\n3. Plan your approach, then use the available tools to execute it.\n4. Show relevant code when explaining changes.\n5. Iterate based on user feedback to refine the result.",
          },
          tools: {
            enabled: true,
            content: "**Available tools:**\n- `bash` \u2014 Run PowerShell commands (dir, git, npm, etc.)\n- `file_read` \u2014 Read file contents\n- `file_write` \u2014 Create or overwrite files\n- `file_edit` \u2014 Replace exact text in files\n- `grep` \u2014 Regex search in files\n- `glob` \u2014 Find files by name pattern\n- `web_fetch` \u2014 Fetch and extract content from any URL\n- `web_search` \u2014 Search the internet for current information\n- `skill` \u2014 Load a user-installed skill (SKILL.md workflow)\n\nUSE THE TOOLS. Don't just suggest \u2014 actually run commands, read files, make changes.",
          },
          behavior: {
            enabled: true,
            content: "1. USE THE TOOLS. Don't just suggest \u2014 actually run commands, read files, make changes.\n2. First explore the project with `dir` or `Get-ChildItem`.\n3. When you need current information, news, or docs \u2014 use `web_search` and `web_fetch`.\n4. Show relevant code when explaining.\n5. Use `file_edit` or `file_write` for code changes.\n6. Keep responses concise with Markdown formatting.\n7. Always respond in the same language the user uses (if they write in Chinese, answer in Chinese; if English, answer in English).",
          },
          communication: {
            enabled: false,
            content: "Keep responses concise with Markdown formatting. Always respond in the same language the user uses. Show relevant code when explaining your changes.",
          },
          skills: {
            enabled: true,
            content: "If the user's request matches a skill's purpose, load it via the `skill` tool and follow its instructions.",
          },
          safety: {
            enabled: true,
            content: "(No additional safety constraints configured. Edit this section to add security rules.)",
          },
          runtime: {
            enabled: true,
            content: "You are running on Windows as a desktop AI coding agent.",
          },
          examples: {
            enabled: false,
            content: "",
          },
        },
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

function renderProfileSelector() {
  const container = document.getElementById("prompt-profile-selector");
  if (!container || !promptStore) return;
  const ids = Object.keys(promptStore.profiles);
  container.innerHTML = ids.map(id => {
    const p = promptStore.profiles[id];
    const active = id === currentProfileId ? " active" : "";
    return `<button class="prompt-profile-chip${active}" data-profile-id="${id}">
      ${sanitize(p.name)}
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
  showPromptStatus("已保存", "success");
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
    if (container) container.innerHTML = '<p class="hint" style="margin:24px 0;">点击上方「新建」创建系统提示词配置</p>';
    return;
  }

  // Build sections HTML
  const sectionsHtml = Object.entries(SECTION_LABELS).map(([key, meta]) => {
    const sec = profile.sections[key];
    const isEnabled = sec && sec.enabled !== false;
    const content = sec ? sec.content : "";
    return `<div class="prompt-section ${isEnabled ? "" : "prompt-section-disabled"}">
      <div class="prompt-section-header" data-section="${key}">
        <div class="prompt-section-title-group">
          <label class="prompt-section-toggle" onclick="event.stopPropagation()">
            <input type="checkbox" class="prompt-section-cb" data-section="${key}" ${isEnabled ? "checked" : ""} />
            <span class="toggle-slider toggle-slider-sm"></span>
          </label>
          <span class="prompt-section-title">${meta.label}</span>
        </div>
        <div class="prompt-section-actions">
          <span class="prompt-section-hint">${meta.hint}</span>
          <svg class="prompt-section-chevron" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 15 12 9 18 15"/></svg>
        </div>
      </div>
      <div class="prompt-section-body">
        <textarea class="prompt-section-textarea" data-section="${key}" placeholder="输入 ${meta.label} 内容... 该内容将被注入到系统提示词的对应章节。">${htmlEncode(content)}</textarea>
      </div>
    </div>`;
  }).join("");

  // Build full editor: name input + sections + bottom bar
  container.innerHTML = `
    <div class="prompt-editor-name">
      <label class="prompt-editor-name-label">配置名称</label>
      <input type="text" id="prompt-name-input" class="form-input prompt-name-input" value="${htmlEncode(profile.name)}" placeholder="配置名称" />
    </div>
    ${sectionsHtml}
    <div class="prompt-editor-bottom">
      <button id="prompt-enable-btn" class="btn prompt-enable-btn ${profile.enabled ? "prompt-enable-btn--on" : "prompt-enable-btn--off"}">
        ${profile.enabled ? "已启用" : "启用"}
      </button>
      <div class="prompt-editor-right">
        <button id="prompt-delete-btn" class="btn prompt-delete-btn" ${currentProfileId === "default" ? "disabled" : ""}>删除</button>
        <button id="prompt-save-btn" class="btn primary">保存</button>
      </div>
    </div>
  `;

  // ── Bind events ──

  // Name input
  const nameInput = document.getElementById("prompt-name-input");
  if (nameInput) {
    nameInput.addEventListener("input", () => {
      _promptDirty = true;
    });
  }

  // Enable button
  const enableBtn = document.getElementById("prompt-enable-btn");
  if (enableBtn) {
    enableBtn.addEventListener("click", async () => {
      const p = getCurrentProfile();
      if (!p) return;
      // Save current name first
      if (nameInput && nameInput.value.trim()) {
        p.name = nameInput.value.trim();
      }
      // Enable this profile, disable all others
      p.enabled = true;
      for (const id of Object.keys(promptStore.profiles)) {
        if (id !== currentProfileId) {
          promptStore.profiles[id].enabled = false;
        }
      }
      // Persist all profiles
      for (const id of Object.keys(promptStore.profiles)) {
        await window.goodAgent.savePromptProfile(promptStore.profiles[id]);
      }
      _promptDirty = false;
      renderProfileSelector();
      renderPromptEditor();
      showPromptStatus("已启用当前配置", "success");
    });
  }

  // Delete button
  const deleteBtn = document.getElementById("prompt-delete-btn");
  if (deleteBtn) {
    deleteBtn.addEventListener("click", async () => {
      if (currentProfileId === "default") return;
      const p = getCurrentProfile();
      if (!p) return;
      if (!confirm(`确定要删除配置「${p.name}」吗？`)) return;
      await window.goodAgent.deletePromptProfile(currentProfileId);
      delete promptStore.profiles[currentProfileId];
      // If deleted was the enabled one, nothing is enabled anymore
      currentProfileId = "default";
      promptStore.activeProfile = "default";
      await window.goodAgent.activatePromptProfile("default");
      renderProfileSelector();
      renderPromptEditor();
      showPromptStatus(`配置「${p.name}」已删除`, "success");
    });
  }

  // Save button
  const saveBtn = document.getElementById("prompt-save-btn");
  if (saveBtn) {
    saveBtn.addEventListener("click", async () => {
      const p = getCurrentProfile();
      if (p && nameInput && nameInput.value.trim()) {
        p.name = nameInput.value.trim();
      }
      await saveCurrentProfile();
    });
  }

  // Section header toggle (collapse)
  container.querySelectorAll(".prompt-section-header").forEach(hdr => {
    hdr.addEventListener("click", () => {
      const section = hdr.closest(".prompt-section");
      section.classList.toggle("prompt-section-collapsed");
    });
  });

  // Section enable checkboxes
  container.querySelectorAll(".prompt-section-cb").forEach(cb => {
    cb.addEventListener("change", () => {
      const p = getCurrentProfile();
      if (!p) return;
      const key = cb.dataset.section;
      if (p.sections[key]) {
        p.sections[key].enabled = cb.checked;
      }
      const section = cb.closest(".prompt-section");
      section.classList.toggle("prompt-section-disabled", !cb.checked);
      _promptDirty = true;
    });
  });

  // Section textareas
  container.querySelectorAll(".prompt-section-textarea").forEach(ta => {
    ta.addEventListener("input", () => {
      const p = getCurrentProfile();
      if (!p) return;
      const key = ta.dataset.section;
      if (p.sections[key]) {
        p.sections[key].content = ta.value;
      }
      _promptDirty = true;
    });
  });
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
  // Auto-name: 系统提示词1, 系统提示词2, ...
  const name = getNextProfileName();
  const id = "profile_" + Date.now();
  const newProfile = {
    id,
    name,
    enabled: true,
    sections: Object.fromEntries(
      Object.keys(SECTION_LABELS).map(k => [k, { enabled: true, content: "" }])
    ),
  };
  promptStore.profiles[id] = newProfile;
  currentProfileId = id;
  promptStore.activeProfile = id;
  // Disable all other profiles to maintain single-enabled invariant
  for (const pid of Object.keys(promptStore.profiles)) {
    if (pid !== id) {
      promptStore.profiles[pid].enabled = false;
    }
  }
  // Persist all changed profiles
  await window.goodAgent.savePromptProfile(newProfile);
  await window.goodAgent.activatePromptProfile(id);
  // Persist disabled states of other profiles
  for (const pid of Object.keys(promptStore.profiles)) {
    if (pid !== id) {
      await window.goodAgent.savePromptProfile(promptStore.profiles[pid]);
    }
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

// Provider dropdown change — auto-fill URL + model
settingsProvider?.addEventListener("change", onProviderChange);

// Fetch models button
document.getElementById("settings-fetch-models-btn")?.addEventListener("click", fetchModels);

// Settings save
settingsSaveBtn?.addEventListener("click", saveSettingsForm);

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
  if (cwdDisplay) cwdDisplay.textContent = "未配置";
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
      badge.textContent = "已连接";
      badge.className = "wechat-badge connected";
    } else {
      badge.textContent = "未连接";
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
  if (statusEl) { statusEl.textContent = "获取二维码..."; statusEl.className = "wechat-qr-status"; }

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
      if (statusEl) { statusEl.textContent = "获取二维码..."; statusEl.className = "wechat-qr-status"; }

      const result = await window.goodAgent.wechatGetQrcode();
      if (result.ok) {
        qrImg.src = result.qrcodeUrl;
        qrImg.style.display = "block";
        if (loading) loading.style.display = "none";
        qrcodeId = result.qrcodeId;
        if (statusEl) { statusEl.textContent = "请使用微信扫描二维码"; statusEl.className = "wechat-qr-status"; }
        startPoll(qrcodeId);
      } else {
        if (statusEl) { statusEl.textContent = "获取失败: " + (result.error || ""); statusEl.className = "wechat-qr-status error"; }
      }
    } catch (err) {
      if (statusEl) { statusEl.textContent = "网络错误"; statusEl.className = "wechat-qr-status error"; }
    }
  }

  async function startPoll(id) {
    while (!stopped) {
      try {
        const r = await window.goodAgent.wechatPollStatus(id);
        if (stopped) return;
        if (r.status === "scanned") {
          if (statusEl) { statusEl.textContent = "已扫码，请在手机上确认..."; statusEl.className = "wechat-qr-status"; }
        } else if (r.status === "confirmed") {
          if (statusEl) { statusEl.textContent = "登录成功！"; statusEl.className = "wechat-qr-status success"; }
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
            if (statusEl) { statusEl.textContent = "二维码已过期，请重新打开"; statusEl.className = "wechat-qr-status error"; }
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
  showWxStatus("已退出登录", "info");
});

// Bot status updates from main process
window.goodAgent.onWechatBotStatus?.((data) => {
  if (data.status === "connected") updateWechatUI({ loggedIn: true, status: "running" });
  else if (data.status === "disconnected") updateWechatUI({ loggedIn: false });
});

// Incoming message notifications
window.goodAgent.onWechatIncoming?.((data) => {
  showWxStatus(`收到消息: ${data.text}`, "info");
  setTimeout(hideWxStatus, 5000);
});

// Social tab click
document.querySelector('.settings-tab[data-tab="social"]')?.addEventListener("click", () => {
  initWechatStatus();
});

/* ════════════════════════════════════════════════
   Memory Panel (multi-file with frontmatter)
   ════════════════════════════════════════════════ */

let _memoryPanelLoaded = false;
let _memoryListCache = [];
let _memoryCurrentFile = null;

const TYPE_LABELS = { user: "👤 用户", feedback: "💬 反馈", project: "📋 项目", reference: "🔗 参考" };

async function loadMemoryPanel() {
  if (_memoryPanelLoaded) return;
  _memoryPanelLoaded = true;

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

  // Refresh list
  async function refreshList(filter = "") {
    try {
      _memoryListCache = await window.goodAgent.memoryListAll();
    } catch (e) {
      // Fallback: use legacy read functions
      _memoryListCache = [];
    }
    const filtered = filter
      ? _memoryListCache.filter(m => m.name.includes(filter) || m.description.includes(filter) || m.filename.includes(filter))
      : _memoryListCache;

    listEl.innerHTML = filtered.length === 0
      ? '<div class="memory-list-empty">暂无记忆</div><div class="memory-list-empty-hint">Agent 会在对话中自动创建</div>'
      : filtered.map(m => {
        const badge = `<span class="memory-type-badge ${m.type}">${TYPE_LABELS[m.type] || m.type}</span>`;
        const activeClass = _memoryCurrentFile === m.filename ? " active" : "";
        return `<div class="memory-list-item${activeClass}" data-file="${m.filename}">
          <div class="memory-list-item-name">${badge}<span>${m.name.replace(/</g,'&lt;')}</span></div>
          <div class="memory-list-item-desc">${m.description.replace(/</g,'&lt;') || "(无描述)"}</div>
        </div>`;
      }).join("");

    // Bind clicks
    listEl.querySelectorAll(".memory-list-item").forEach(el => {
      el.addEventListener("click", () => selectMemory(el.dataset.file));
    });
  }

  // Select a memory
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
    } catch (e) {
      // Fallback: try legacy
    }
    await refreshList(searchInput?.value || "");
  }

  // New memory
  function newMemory() {
    _memoryCurrentFile = null;
    nameInput.value = "";
    descInput.value = "";
    typeSelect.value = "project";
    bodyTextarea.value = "";
    statusEl.textContent = "";
    refreshList(searchInput?.value || "");
  }

  // Save
  saveBtn.addEventListener("click", async () => {
    const name = nameInput.value.trim();
    const desc = descInput.value.trim();
    const type = typeSelect.value;
    const body = bodyTextarea.value;
    if (!name) { statusEl.textContent = "❌ 名称不能为空"; return; }

    statusEl.textContent = "保存中...";
    try {
      if (_memoryCurrentFile) {
        await window.goodAgent.memoryUpdate(_memoryCurrentFile, body, name, desc, type);
      } else {
        await window.goodAgent.memoryCreate(name, desc, type, body);
      }
      statusEl.textContent = "✅ 已保存";
      setTimeout(() => { statusEl.textContent = ""; }, 2000);
      await refreshList(searchInput?.value || "");
      // Select the newly created/updated item
      if (!_memoryCurrentFile) {
        const safe = name.replace(/[^a-zA-Z0-9_\-一-鿿]/g, "_");
        _memoryCurrentFile = safe + ".md";
      }
      await refreshList(searchInput?.value || "");
    } catch (e) {
      statusEl.textContent = "❌ 保存失败: " + e.message;
    }
  });

  // Delete
  deleteBtn.addEventListener("click", async () => {
    if (!_memoryCurrentFile) return;
    if (!confirm(`删除记忆 "${_memoryCurrentFile}"？此操作不可撤销。`)) return;
    try {
      await window.goodAgent.memoryDelete(_memoryCurrentFile);
      _memoryCurrentFile = null;
      nameInput.value = ""; descInput.value = ""; bodyTextarea.value = "";
      statusEl.textContent = "✅ 已删除";
      setTimeout(() => { statusEl.textContent = ""; }, 2000);
      await refreshList(searchInput?.value || "");
    } catch (e) {
      statusEl.textContent = "❌ 删除失败: " + e.message;
    }
  });

  // New button
  newBtn.addEventListener("click", newMemory);

  // Search
  searchInput.addEventListener("input", () => {
    refreshList(searchInput.value);
  });

  // Initial load
  await refreshList();
}

document.querySelector('.settings-tab[data-tab="memory"]')?.addEventListener("click", loadMemoryPanel);

/* ════════════════════════════════════════════════
   Skills Panel
   ════════════════════════════════════════════════ */

let _skillsPanelLoaded = false;

async function loadSkillsPanel() {
  if (_skillsPanelLoaded) return;
  _skillsPanelLoaded = true;
  
  // Wire manual create
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
      } catch (e) { alert("保存失败: " + e.message); }
    };
  }

  await refreshSkillsList();
}

// Keep the delegated handler for the create button (capture phase)
document.addEventListener("click", function(e) {
  const btn = e.target.closest("#skill-create-btn");
  if (!btn) return;
  const form = document.getElementById("skill-create-form");
  if (form) { form.classList.remove("hidden"); btn.style.display = "none"; }
}, true);

async function refreshSkillsList() {
  const container = document.getElementById("agent-skills-list");
  if (!container) return;
  try {
    const list = await window.goodAgent.skillsListAll();
    const patterns = await window.goodAgent.skillsDetectPatterns();
    const curator = await window.goodAgent.skillsCuratorStatus();

    let html = '';

    // Curator status bar
    if (curator) {
      const lastRunText = curator.lastRun !== "never" ? new Date(curator.lastRun).toLocaleString("zh-CN") : "未运行";
      html += '<div class="curator-info-bar">' +
        '<div class="curator-info-stats">' +
          '<span>活跃 <b>' + curator.activeSkills + '</b> 个</span>' +
          '<span class="curator-info-sep">·</span>' +
          '<span>归档 ' + curator.archivedSkills + '</span>' +
          '<span class="curator-info-sep">·</span>' +
          '<span>上次: ' + lastRunText + '</span>' +
          (curator.pendingMerges?.length ? '<span class="curator-info-warn">⚠ ' + curator.pendingMerges.length + ' 对可合并</span>' : '') +
        '</div>' +
        '<button class="btn btn-xs" id="curator-run-btn">立即整理</button>' +
      '</div>';
    }

    // Show detected patterns
    if (patterns?.length) {
      html += '<div class="patterns-card">' +
        '<div class="patterns-card-header">🔍 检测到重复操作模式</div>';
      for (const p of patterns) {
        html += '<div class="patterns-item">' +
          '<span><b>' + sanitize(p.phrase) + '</b> — 出现 ' + p.count + ' 次</span>' +
          '<button class="btn btn-xs primary generate-skill-btn" data-phrase="' + sanitize(p.phrase) + '">生成技能</button>' +
        '</div>';
      }
      html += '</div>';
    }

    if (!list?.length && !patterns?.length) {
      html += '<div class="skill-card skill-card-empty">暂无技能。Agent 会在发现重复操作模式时自动生成，或在对话中说「创建技能」。</div>';
    } else {
      html += (list || []).map(s => `
        <div class="skill-card">
          <div class="skill-card-header">
            <div class="skill-card-name">
              <span>${sanitize(s.name)}</span>
              <span class="skill-status-badge ${s.status}">${s.status === "active" ? "已激活" : "已归档"}</span>
            </div>
            <div class="skill-card-actions">
              <button class="btn btn-xs skill-edit-btn" data-skill="${sanitize(s.name)}">编辑</button>
              <button class="btn btn-xs skill-export-btn" data-skill="${sanitize(s.name)}">导出</button>
              ${s.status === "active"
                ? '<button class="btn btn-xs skill-archive-btn" data-skill="' + s.name + '">停用</button>'
                : '<button class="btn btn-xs skill-activate-btn" data-skill="' + s.name + '">启用</button>'}
              <button class="btn btn-xs skill-delete-btn" data-skill="${s.name}" style="color:#ef4444;">删除</button>
            </div>
          </div>
          <div class="skill-card-desc">${sanitize(s.description)}</div>
          <div class="skill-card-meta">
            <span>使用 <b>${s.usage_count}</b> 次</span>
            <span>成功率 <b>${Math.round((s.success_rate||1)*100)}%</b></span>
            ${s.triggers?.length ? '<span>触发: ' + sanitize(s.triggers.slice(0, 3).join(", ")) + '</span>' : ''}
          </div>
        </div>
      `).join("");
    }
    container.innerHTML = html;

    // Update count
    const countEl = document.getElementById("agent-skills-count");
    if (countEl) countEl.textContent = `${(list || []).length} 个技能`;

    // Wire up curator run
    document.getElementById("curator-run-btn")?.addEventListener("click", async () => {
      const btn = document.getElementById("curator-run-btn");
      btn.disabled = true; btn.textContent = "运行中...";
      try {
        const result = await window.goodAgent.skillsCuratorRun();
        alert(`Curator 完成: 归档 ${result.archived} 个，发现 ${result.dupes} 对可合并技能`);
        await refreshSkillsList();
      } catch (e) { alert("Curator 失败: " + e.message); }
      btn.disabled = false; btn.textContent = "运行 Curator";
    });

    // Wire up generate buttons
    container.querySelectorAll(".generate-skill-btn").forEach(btn => {
      btn.addEventListener("click", async () => {
        const phrase = btn.dataset.phrase;
        btn.disabled = true; btn.textContent = "生成中...";
        try {
          const cfg = loadApiConfig();
          const res = await fetch((cfg.apiUrl || "").replace(/\/+$/, "") + "/chat/completions", {
            method: "POST",
            headers: { "Content-Type": "application/json", "Authorization": "Bearer " + (cfg.apiKey || "") },
            body: JSON.stringify({
              model: cfg.model || "deepseek-chat",
              messages: [{
                role: "system",
                content: "You are a skill generator. Output ONLY valid markdown with YAML frontmatter. Format:\n---\nname: lowercase-name\ndescription: \"desc\"\ntriggers: [word1, word2]\nversion: 1.0.0\nstatus: active\n---\n\n## Steps\n1. ...\n\n## Notes\n- ..."
              }, {
                role: "user",
                content: "Create a reusable skill for: " + phrase + ". This is a repeated pattern in conversations."
              }],
              max_tokens: 2048,
            }),
            signal: AbortSignal.timeout(30000),
          });
          if (!res.ok) throw new Error("API " + res.status);
          const data = await res.json();
          const skillText = data.choices?.[0]?.message?.content || "";

          // Parse and save
          const nameMatch = skillText.match(/name:\s*(\S+)/);
          const descMatch = skillText.match(/description:\s*"([^"]+)"/);
          const name = nameMatch?.[1] || phrase.replace(/\s+/g, "-").toLowerCase().slice(0, 30);

          await window.goodAgent.skillsSaveSkill(name, {
            name, description: (descMatch?.[1] || phrase), triggers: [phrase], version: "1.0.0", status: "active", created_at: new Date().toISOString()
          }, skillText);
          await refreshSkillsList();
        } catch (e) { alert("生成失败: " + e.message); }
        btn.disabled = false; btn.textContent = "生成技能";
      });
    });

    // Wire up buttons
    container.querySelectorAll(".skill-archive-btn").forEach(btn => {
      btn.addEventListener("click", async () => {
        await window.goodAgent.skillsSetStatus(btn.dataset.skill, "archived");
        await refreshSkillsList();
      });
    });
    container.querySelectorAll(".skill-activate-btn").forEach(btn => {
      btn.addEventListener("click", async () => {
        await window.goodAgent.skillsSetStatus(btn.dataset.skill, "active");
        await refreshSkillsList();
      });
    });
    container.querySelectorAll(".skill-delete-btn").forEach(btn => {
      btn.addEventListener("click", async () => {
        if (!confirm("删除技能 " + btn.dataset.skill + "？")) return;
        await window.goodAgent.skillsDelete(btn.dataset.skill);
        await refreshSkillsList();
      });
    });
  } catch (e) { console.warn("[skills]", e.message); }
}

document.querySelector('.settings-tab[data-tab="agent-skills"]')?.addEventListener("click", loadSkillsPanel);

initWechatStatus();

/* ── Workspace ────────────────────────────────────────── */
async function initWorkspace() {
  try {
    const ws = await window.goodAgent.workspaceGet();
    const el = document.getElementById("workspace-path");
    if (el) el.textContent = ws || "未设置";
  } catch {}
}

document.getElementById("workspace-bar")?.addEventListener("click", async () => {
  try {
    const result = await window.goodAgent.workspacePick();
    if (result?.ok && result.workspace) {
      const el = document.getElementById("workspace-path");
      if (el) el.textContent = result.workspace;
    }
  } catch {}
});

initWorkspace();
