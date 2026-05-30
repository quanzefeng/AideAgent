export async function initWorkspace() {
  try {
    const ws = await window.goodAgent.workspaceGet();
    const el = document.getElementById("workspace-path");
    if (el) el.textContent = ws || t("misc.not_set");
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
