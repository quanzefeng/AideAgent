// Workspace UI: sidebar path display + click-to-pick + first-launch modal.
// On first launch (or when the persisted path was deleted/moved), the
// first-pick modal blocks the user until they either pick a project
// folder or explicitly skip (use the launch dir as a default).

function applyPath(path) {
  const el = document.getElementById("workspace-path");
  if (el) el.textContent = path || t("misc.not_set");
}

async function refreshWorkspace() {
  try {
    const ws = await window.goodAgent.workspaceGet();
    applyPath(ws);
  } catch {}
}

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
      const result = await window.goodAgent.workspacePick();
      if (result?.ok && result.workspace) {
        applyPath(result.workspace);
        close();
      }
      // If user cancelled the folder dialog, keep the modal open so
      // they can pick again or explicitly skip.
    } catch (e) {
      console.error("[workspace] pick failed:", e.message);
    }
  };

  skipBtn.onclick = () => {
    // User accepted the default (launch dir / install dir). Persist it
    // so the modal doesn't re-appear on the next launch.
    window.goodAgent.workspaceSet(currentDefault).then(() => {
      applyPath(currentDefault);
      close();
    }).catch(e => console.error("[workspace] set default failed:", e.message));
  };
}

export async function initWorkspace() {
  await refreshWorkspace();

  // First-launch detection: if no workspace has been persisted yet,
  // show the picker modal so the user lands in the right project
  // folder instead of the install dir.
  try {
    const { needs } = await window.goodAgent.workspaceNeedsFirstPick();
    if (needs) {
      const current = await window.goodAgent.workspaceGet();
      showFirstPickModal(current);
    }
  } catch (e) {
    console.error("[workspace] needs-first-pick check failed:", e.message);
  }
}

document.getElementById("workspace-bar")?.addEventListener("click", async () => {
  try {
    const result = await window.goodAgent.workspacePick();
    if (result?.ok && result.workspace) {
      applyPath(result.workspace);
    }
  } catch (e) {
    console.error("[workspace] pick failed:", e.message);
  }
});

initWorkspace();
