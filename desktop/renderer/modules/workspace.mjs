// @ts-check — JSDoc-typed workspace bar / first-launch modal module.
// @ts-check — 带 JSDoc 类型注解的工作区栏 / 首次启动模态框模块。
// Workspace UI: sidebar path display + click-to-pick + first-launch modal.
// On first launch (or when the persisted path was deleted/moved), the
// first-pick modal blocks the user until they either pick a project
// folder or explicitly skip (use the launch dir as a default).

/**
 * @param {string} path
 */
function applyPath(path) {
  const el = document.getElementById("workspace-path");
  if (el) el.textContent = path || t("misc.not_set");
}

async function refreshWorkspace() {
  try {
    const ws = await window.aideagent.workspaceGet();
    applyPath(ws);
  } catch {}
}

/**
 * @param {string} currentDefault
 */
function showFirstPickModal(currentDefault) {
  const modal = document.getElementById("workspace-first-pick-modal");
  const currentEl = document.getElementById("workspace-first-pick-current");
  const chooseBtn = document.getElementById("workspace-first-pick-choose");
  const skipBtn = document.getElementById("workspace-first-pick-skip");
  if (!modal || !currentEl || !chooseBtn || !skipBtn) return;

  currentEl.textContent = currentDefault || "";
  modal.classList.add("active");

  const close = () => modal.classList.remove("active");

  chooseBtn.onclick = async () => {
    try {
      const result = await window.aideagent.workspacePick();
      if (result?.ok && result.workspace) {
        applyPath(result.workspace);
        close();
      }
      // If user cancelled the folder dialog, keep the modal open so
      // they can pick again or explicitly skip.
    } catch (/** @type {any} */ e) {
      console.error("[workspace] pick failed:", e.message);
    }
  };

  skipBtn.onclick = () => {
    // User accepted the default (launch dir / install dir). Persist it
    // so the modal doesn't re-appear on the next launch.
    window.aideagent.workspaceSet(currentDefault).then(() => {
      applyPath(currentDefault);
      close();
    }).catch((/** @type {any} */ e) => console.error("[workspace] set default failed:", e.message));
  };
}

export async function initWorkspace() {
  await refreshWorkspace();

  // First-launch detection: if no workspace has been persisted yet,
  // show the picker modal so the user lands in the right project
  // folder instead of the install dir.
  try {
    const { needs } = await window.aideagent.workspaceNeedsFirstPick();
    if (needs) {
      const current = await window.aideagent.workspaceGet();
      showFirstPickModal(current);
    }
  } catch (/** @type {any} */ e) {
    console.error("[workspace] needs-first-pick check failed:", e.message);
  }
}

document.getElementById("workspace-bar")?.addEventListener("click", async () => {
  try {
    const result = await window.aideagent.workspacePick();
    if (result?.ok && result.workspace) {
      applyPath(result.workspace);
    }
  } catch (/** @type {any} */ e) {
    console.error("[workspace] pick failed:", e.message);
  }
});

initWorkspace();
