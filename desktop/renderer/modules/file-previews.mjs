/**
 * File previews (input + chip rendering + send-button gating)
 * --------------------------------------------------------------------------
 * 负责：
 *   - 用户点上传按钮 → 触发文件选择
 *   - 选择文件后读取 dataUrl 存到 state.attachedFiles
 *   - 在 #file-preview 区域渲染 chip 列表（含 remove 按钮）
 *   - 控制 sendBtn 的 disabled 状态（输入框非空 OR 有附件才可点）
 *
 * 通过依赖注入接收 DOM 引用和 state，避免与 app.js 形成循环依赖。
 *
 * 必须先调 init() 才能监听上传按钮和文件选择。
 */

/**
 * @param {{
 *   state: { attachedFiles: Array<{ name: string; size: number; type: string; dataUrl: string }> },
 *   filePreviewArea: HTMLElement,
 *   fileInput: HTMLInputElement,
 *   uploadBtn: HTMLElement,
 *   sendBtn: HTMLButtonElement,
 *   promptInput: HTMLInputElement,
 *   MAX_FILE_SIZE: number,
 *   onError: (msg: string) => void,
 *   formatFileSize: (bytes: number) => string,
 * }} _
 */
export function createFilePreviews({
  state,
  filePreviewArea,
  fileInput,
  uploadBtn,
  sendBtn,
  promptInput,
  MAX_FILE_SIZE,
  onError,           // (string) => void — 通常是 addErrorMessage(t(...))
  formatFileSize,    // (bytes) => string
}) {
  /**
   * @param {string} type
   * @param {string} name
   */
  function fileIconSvg(type, name) {
    // 图片在 render 处直接显示缩略图，不需要 icon
    if (type.startsWith("image/")) return "";
    const ext = (name.split(".").pop() ?? "").toLowerCase();
    /** @type {Record<string, string>} */
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
    filePreviewArea.innerHTML = files.map(/** @param {{ name: string; size: number; type: string; dataUrl: string }} f @param {number} i */ (f, i) => {
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
        const idx = parseInt(String((/** @type {HTMLElement} */ (btn)).dataset.index), 10);
        state.attachedFiles.splice(idx, 1);
        renderFilePreviews();
        updateSendButton();
      });
    });
  }

  function updateSendButton() {
    sendBtn.disabled = !promptInput.value.trim() && state.attachedFiles.length === 0;
  }

  /**
   * @param {FileList | null} files
   */
  async function handleFileUpload(files) {
    if (!files || files.length === 0) return;
    for (const file of files) {
      if (file.size > MAX_FILE_SIZE) {
        onError("file.too_large: " + file.name);
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

  function init() {
    uploadBtn.addEventListener("click", () => fileInput.click());
    fileInput.addEventListener("change", () => {
      handleFileUpload(fileInput.files);
      fileInput.value = ""; // allow re-selecting same files
    });
  }

  return { renderFilePreviews, updateSendButton, handleFileUpload, init };
}
