// Permissions settings panel: four global modes, persisted to
// ~/.aideagent/permissions.json. The mode is applied immediately because the
// main process caches the config; no restart is required.
import { switchSettingsTab } from "./settings-tabs.ts";

type PermissionMode = "auto" | "ask" | "readonly" | "full";

interface PermissionRule {
  tool: string;
  action: "allow" | "ask" | "deny";
  pattern?: string;
}

interface PermissionConfig {
  mode: PermissionMode;
  rules: PermissionRule[];
  allowUnattendedFullAccess?: boolean;
}

let currentConfig: PermissionConfig = { mode: "auto", rules: [] };
let confirmFull: (message: string) => Promise<boolean> = async (message) => window.confirm(message);
let statusTimer: ReturnType<typeof setTimeout> | null = null;

function normalizeMode(value: any): PermissionMode {
  return value === "ask" || value === "readonly" || value === "full" ? value : "auto";
}

function normalizeConfig(raw: any): PermissionConfig {
  return {
    mode: normalizeMode(raw?.mode),
    rules: Array.isArray(raw?.rules) ? raw.rules : [],
    ...(raw?.allowUnattendedFullAccess === true ? { allowUnattendedFullAccess: true } : {}),
  };
}

function modeLabel(mode: PermissionMode): string {
  return t(`permissions.mode_${mode}`);
}

function selectedMode(): PermissionMode {
  const checked = document.querySelector<HTMLInputElement>('input[name="permission-mode"]:checked');
  return normalizeMode(checked?.value);
}

function setStatus(message: string, kind: "success" | "error"): void {
  const status = document.getElementById("permissions-status");
  if (!status) return;
  status.textContent = message;
  status.className = `settings-status ${kind}`;
  if (statusTimer) clearTimeout(statusTimer);
  statusTimer = setTimeout(() => {
    status.classList.add("hidden");
    statusTimer = null;
  }, 3000);
}

function applyConfigToForm(cfg: PermissionConfig): void {
  document.querySelectorAll<HTMLInputElement>('input[name="permission-mode"]').forEach((input) => {
    input.checked = input.value === cfg.mode;
  });
  const unattended = document.getElementById("permission-allow-unattended") as HTMLInputElement | null;
  if (unattended) unattended.checked = cfg.allowUnattendedFullAccess === true;
  syncFullState();
}

function syncFullState(): void {
  const isFull = selectedMode() === "full";
  const warning = document.getElementById("permission-full-warning");
  const unattended = document.getElementById("permission-allow-unattended") as HTMLInputElement | null;
  if (warning) warning.classList.toggle("hidden", !isFull);
  if (unattended) unattended.disabled = !isFull;
}

function updateIndicator(mode: PermissionMode): void {
  const indicator = document.getElementById("permission-mode-indicator");
  const label = document.getElementById("permission-mode-indicator-label");
  if (label) label.textContent = modeLabel(mode);
  if (indicator) {
    indicator.dataset.mode = mode;
    indicator.setAttribute("aria-label", modeLabel(mode));
  }
}

async function refreshPermissionIndicator(): Promise<void> {
  try {
    const cfg = normalizeConfig(await window.aideagent.getPermissions());
    currentConfig = cfg;
    updateIndicator(cfg.mode);
  } catch {
    // The bridge may not be ready during early boot. The settings panel will
    // retry when opened.
  }
}

export async function loadPermissionsPanel(): Promise<void> {
  try {
    const cfg = normalizeConfig(await window.aideagent.getPermissions());
    currentConfig = cfg;
    applyConfigToForm(cfg);
    updateIndicator(cfg.mode);
    const status = document.getElementById("permissions-status");
    status?.classList.add("hidden");
  } catch (e: any) {
    setStatus(t("permissions.load_failed", { error: e?.message || String(e) }), "error");
  }
}

async function savePermissions(): Promise<void> {
  const mode = selectedMode();
  if (mode === "full" && currentConfig.mode !== "full") {
    const ok = await confirmFull(t("permissions.confirm_full"));
    if (!ok) return;
  }

  const unattended = document.getElementById("permission-allow-unattended") as HTMLInputElement | null;
  const cfg: PermissionConfig = {
    mode,
    rules: currentConfig.rules,
    // Never leave an unattended full-access opt-in behind when the user
    // switches back to a safer mode.
    allowUnattendedFullAccess: mode === "full" && unattended?.checked === true,
  };
  const saveBtn = document.getElementById("permissions-save-btn") as HTMLButtonElement | null;
  if (saveBtn) saveBtn.disabled = true;
  try {
    const result = await window.aideagent.setPermissions(cfg);
    if (!result?.ok) throw new Error(result?.error || "unknown error");
    currentConfig = normalizeConfig(result.config || cfg);
    applyConfigToForm(currentConfig);
    updateIndicator(currentConfig.mode);
    setStatus(t("permissions.saved"), "success");
  } catch (e: any) {
    setStatus(t("permissions.save_failed", { error: e?.message || String(e) }), "error");
  } finally {
    if (saveBtn) saveBtn.disabled = false;
  }
}

function openPermissionsSettings(): void {
  const modal = document.getElementById("settings-modal");
  if (!modal?.classList.contains("active")) {
    document.getElementById("settings-btn")?.click();
  }
  switchSettingsTab("permissions");
  void loadPermissionsPanel();
}

export function initPermissionsSettings(confirmFn?: (message: string) => Promise<boolean>): void {
  if (confirmFn) confirmFull = confirmFn;

  document.querySelector('.settings-tab[data-tab="permissions"]')
    ?.addEventListener("click", () => { void loadPermissionsPanel(); });
  document.querySelectorAll<HTMLInputElement>('input[name="permission-mode"]')
    .forEach((input) => input.addEventListener("change", syncFullState));
  document.getElementById("permissions-save-btn")
    ?.addEventListener("click", () => { void savePermissions(); });
  document.getElementById("permission-mode-indicator")
    ?.addEventListener("click", openPermissionsSettings);

  // applyLang() rewrites data-i18n nodes; the indicator label is dynamic, so
  // refresh it after a language switch.
  document.getElementById("lang-select")?.addEventListener("change", () => {
    setTimeout(() => updateIndicator(currentConfig.mode), 0);
  });

  void refreshPermissionIndicator();
}
