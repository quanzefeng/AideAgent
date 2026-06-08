// @ts-check — JSDoc-typed agent/user name & avatar module.
// @ts-check — 带 JSDoc 类型注解的 Agent / 用户名称 & 头像模块。
const AGENT_NAME_KEY = "AideAgent_name";
const USER_NAME_KEY = "AideAgent_user_name";
const USER_AVATAR_KEY = "AideAgent_user_avatar";

/** @returns {string} */
export function loadAgentName() {
  return localStorage.getItem(AGENT_NAME_KEY) || "AideAgent";
}

/** @param {string} name */
export function saveAgentName(name) {
  if (!name || !name.trim()) return;
  name = name.trim();
  localStorage.setItem(AGENT_NAME_KEY, name);
  applyAgentName(name);
  showToast(t("avatar.name_changed").replace("{name}", name), "info");
}

/** @param {string} name */
export function applyAgentName(name) {
  const brand = document.getElementById("sidebar-brand");
  if (brand) brand.textContent = name;
  document.title = name;
  const input = /** @type {HTMLInputElement | null} */ (document.getElementById("prompt-input"));
  if (input) input.placeholder = t("chat.input_placeholder").replace("{name}", name);
  const welcomeTitle = document.querySelector(".welcome h1");
  if (welcomeTitle) welcomeTitle.textContent = name;
  const welcomeDesc = document.querySelector(".welcome .description");
  if (welcomeDesc) welcomeDesc.textContent = t("chat.welcome_desc").replace("{name}", name);
  const welcomeAvatar = /** @type {HTMLImageElement | null} */ (document.getElementById("welcome-avatar"));
  if (welcomeAvatar) welcomeAvatar.alt = name;
  document.querySelectorAll(".message.assistant .message-label").forEach((node) => {
    const el = /** @type {HTMLElement} */ (node);
    const img = el.querySelector(".msg-avatar");
    el.textContent = "";
    if (img) el.appendChild(img);
    el.appendChild(document.createTextNode(name));
  });
}

export function initAgentNameUI() {
  const saved = loadAgentName();
  const input = /** @type {HTMLInputElement | null} */ (document.getElementById("agent-name-input"));
  if (input) input.value = saved;
  const saveBtn = document.getElementById("save-agent-name-btn");
  if (saveBtn && input) {
    saveBtn.addEventListener("click", () => saveAgentName(input.value));
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") saveAgentName(input.value); });
  }
}

/** @returns {string} */
export function loadUserName() {
  return localStorage.getItem(USER_NAME_KEY) || t("avatar.user_default");
}

/** @param {string} name */
export function saveUserName(name) {
  if (!name || !name.trim()) return;
  name = name.trim();
  localStorage.setItem(USER_NAME_KEY, name);
  applyUserName(name);
  const input = /** @type {HTMLInputElement | null} */ (document.getElementById("user-name-input"));
  if (input) input.value = name;
  showToast(t("avatar.name_changed").replace("{name}", name), "info");
}

/** @param {string} name */
export function applyUserName(name) {
  document.querySelectorAll(".message.user .message-label").forEach((node) => {
    const el = /** @type {HTMLElement} */ (node);
    const img = el.querySelector(".user-msg-avatar");
    el.textContent = "";
    if (img) el.appendChild(img);
    el.appendChild(document.createTextNode(name));
  });
}

/** @returns {string} */
export function loadUserAvatarSrc() {
  return localStorage.getItem(USER_AVATAR_KEY) || "";
}

export function loadUserAvatar() {
  const src = loadUserAvatarSrc();
  const preview = /** @type {HTMLImageElement | null} */ (document.getElementById("user-settings-preview"));
  if (preview) preview.src = src || "avatar.jpg";
  document.querySelectorAll(".message.user .message-label").forEach((node) => {
    const el = /** @type {HTMLElement} */ (node);
    const existing = el.querySelector(".user-msg-avatar");
    if (src) {
      if (existing) { /** @type {HTMLImageElement} */ (existing).src = src; }
      else {
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

/** @param {string} src */
function saveUserAvatar(src) {
  try {
    localStorage.setItem(USER_AVATAR_KEY, src);
    loadUserAvatar();
  } catch (/** @type {any} */ e) {
    console.error("[user avatar] save failed:", e.message);
    showToast(t("avatar.save_fail"), "error");
  }
}

function resetUserAvatar() {
  localStorage.removeItem(USER_AVATAR_KEY);
  loadUserAvatar();
}

export function initUserAvatarUI() {
  const src = loadUserAvatarSrc();
  const preview = /** @type {HTMLImageElement | null} */ (document.getElementById("user-settings-preview"));
  if (preview) preview.src = src || "avatar.jpg";
  const input = /** @type {HTMLInputElement | null} */ (document.getElementById("user-name-input"));
  if (input) input.value = loadUserName();
  const saveBtn = document.getElementById("save-user-name-btn");
  if (saveBtn && input) {
    saveBtn.addEventListener("click", () => saveUserName(input.value));
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") saveUserName(input.value); });
  }
  const fileInput = /** @type {HTMLInputElement | null} */ (document.getElementById("user-avatar-file-input"));
  const changeBtn = document.getElementById("change-user-avatar-btn");
  const resetBtn = document.getElementById("reset-user-avatar-btn");
  if (fileInput) {
    fileInput.addEventListener("change", async () => {
      const file = fileInput.files?.[0];
      if (!file) return;
      if (!file.type.startsWith("image/")) {
        showToast(t("avatar.select_file"), "error");
        fileInput.value = "";
        return;
      }
      /** @type {string | null} */
      let realType;
      try {
        const header = await file.slice(0, 12).arrayBuffer();
        realType = detectMimeFromHeader(header);
      } catch { realType = file.type; }
      const mimeType = realType || file.type;
      const MAX_PX = 200;
      const correctedBlob = new Blob([file], { type: mimeType });
      const blobUrl = URL.createObjectURL(correctedBlob);
      const img = new Image();
      img.onload = () => {
        let w = img.naturalWidth, h = img.naturalHeight;
        if (w > MAX_PX || h > MAX_PX) {
          const scale = MAX_PX / Math.max(w, h);
          w = Math.round(w * scale); h = Math.round(h * scale);
        }
        const canvas = document.createElement("canvas");
        canvas.width = w; canvas.height = h;
        const ctx = canvas.getContext("2d");
        if (ctx) ctx.drawImage(img, 0, 0, w, h);
        const compressed = canvas.toDataURL("image/jpeg", 0.85);
        URL.revokeObjectURL(blobUrl);
        saveUserAvatar(compressed);
      };
      img.onerror = () => { URL.revokeObjectURL(blobUrl); showToast(t("avatar.decode_fail"), "error"); };
      img.src = blobUrl;
      fileInput.value = "";
    });
  }
  if (changeBtn && fileInput) changeBtn.addEventListener("click", () => fileInput.click());
  if (resetBtn) resetBtn.addEventListener("click", resetUserAvatar);
}

/** @param {ArrayBuffer} header @returns {string | null} */
function detectMimeFromHeader(header) {
  const bytes = new Uint8Array(header);
  if (bytes[0] === 0xFF && bytes[1] === 0xD8 && bytes[2] === 0xFF) return "image/jpeg";
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4E) return "image/png";
  if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46) return "image/webp";
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return "image/gif";
  return null;
}

/** @param {string} msg @param {"info"|"error"} [type] */
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
