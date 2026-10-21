// @ts-check — API configuration profiles (metadata only, never secrets).
//
// A profile is the unit users create/duplicate/delete: provider preset, URL,
// model, protocol and context window. API keys stay in the main-process
// encrypted store keyed by profile.id, so the profile JSON in localStorage is
// safe to export/back up.
//
// Legacy compatibility: before profiles existed the app stored ONE config per
// provider (`AideAgent_deepseek_api_url`, etc.) plus a global custom slot
// (`AideAgent_api_url`) and the active provider in `AideAgent_provider`.
// `ensureApiProfileStore` migrates those keys once, reusing the legacy provider
// id as profile.id so the existing encrypted key is found without copying it.

export const API_PROFILE_STORE_KEY = "AideAgent_api_profiles";
export const LEGACY_PROVIDER_KEY = "AideAgent_provider";

export type ApiProfileFormat = "openai" | "anthropic" | "responses";

export interface ApiProfile {
  id: string;
  name: string;
  /** Provider preset id. "" means custom endpoint. */
  provider: string;
  /** Preset id for built-in providers, user-defined slug for custom APIs. */
  providerId: string;
  apiUrl: string;
  model: string;
  apiFormat: ApiProfileFormat;
  contextWindow: string;
  createdAt: number;
  updatedAt: number;
}

export interface ApiProfileStore {
  version: 1;
  activeId: string | null;
  profiles: ApiProfile[];
}

export interface ApiProfileStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export type ProfileLabelFor = (provider: string) => string;

const CUSTOM_KEYSTORE_ID = "_custom";
const VALID_FORMATS = new Set<string>(["openai", "anthropic", "responses"]);

function defaultStorage(): ApiProfileStorage | null {
  try {
    return typeof localStorage !== "undefined" ? localStorage : null;
  } catch {
    return null;
  }
}

function normalizeFormat(value: unknown): ApiProfileFormat {
  return typeof value === "string" && VALID_FORMATS.has(value)
    ? (value as ApiProfileFormat)
    : "openai";
}

/** Normalize a user-entered provider slug. */
export function normalizeProviderId(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

/** Custom provider ids must start with a lowercase letter. */
export function isValidProviderId(value: string): boolean {
  return /^[a-z][a-z0-9_-]*$/.test(value);
}

function normalizeProfile(raw: any): ApiProfile | null {
  if (!raw || typeof raw !== "object") return null;
  const id = typeof raw.id === "string" ? raw.id.trim() : "";
  if (!id) return null;
  const provider = typeof raw.provider === "string" ? raw.provider : "";
  // Older stores predate providerId. Built-ins fall back to the preset id;
  // custom profiles fall back to their stable (already unique) profile id.
  const providerId = normalizeProviderId(raw.providerId)
    || provider
    || (id === CUSTOM_KEYSTORE_ID ? "custom" : (isValidProviderId(id) ? id : "custom"));
  const now = Date.now();
  return {
    id,
    name: typeof raw.name === "string" ? raw.name : "",
    provider,
    providerId,
    apiUrl: typeof raw.apiUrl === "string" ? raw.apiUrl : "",
    model: typeof raw.model === "string" ? raw.model : "",
    apiFormat: normalizeFormat(raw.apiFormat),
    contextWindow: typeof raw.contextWindow === "string" ? raw.contextWindow : "",
    createdAt: Number.isFinite(raw.createdAt) ? raw.createdAt : now,
    updatedAt: Number.isFinite(raw.updatedAt) ? raw.updatedAt : now,
  };
}

/** Parse a stored profile blob. Returns null when absent/corrupt. */
export function parseApiProfileStore(raw: string | null): ApiProfileStore | null {
  if (!raw) return null;
  try {
    const data = JSON.parse(raw);
    if (!data || typeof data !== "object" || !Array.isArray(data.profiles)) return null;
    const seen = new Set<string>();
    const profiles: ApiProfile[] = [];
    for (const item of data.profiles) {
      const profile = normalizeProfile(item);
      if (!profile || seen.has(profile.id)) continue;
      seen.add(profile.id);
      profiles.push(profile);
    }
    let activeId = typeof data.activeId === "string" ? data.activeId : null;
    if (!activeId || !profiles.some((p) => p.id === activeId)) {
      activeId = profiles[0]?.id ?? null;
    }
    return { version: 1, activeId, profiles };
  } catch {
    return null;
  }
}

/** Read profiles without migrating. Safe for early boot / session snapshots. */
export function loadApiProfileStore(storage: ApiProfileStorage | null = defaultStorage()): ApiProfileStore {
  if (!storage) return emptyApiProfileStore();
  try {
    return parseApiProfileStore(storage.getItem(API_PROFILE_STORE_KEY)) || emptyApiProfileStore();
  } catch {
    return emptyApiProfileStore();
  }
}

export function emptyApiProfileStore(): ApiProfileStore {
  return { version: 1, activeId: null, profiles: [] };
}

/** Persist the whole store. Returns false if localStorage is unavailable/full. */
export function saveApiProfileStore(
  store: ApiProfileStore,
  storage: ApiProfileStorage | null = defaultStorage(),
): boolean {
  if (!storage) return false;
  try {
    storage.setItem(API_PROFILE_STORE_KEY, JSON.stringify({ ...store, version: 1 }));
    return true;
  } catch {
    return false;
  }
}

function legacyPrefix(provider: string): string {
  return provider ? `AideAgent_${provider}_` : "AideAgent_";
}

function legacyProfileName(provider: string, labelFor?: ProfileLabelFor): string {
  const label = labelFor ? String(labelFor(provider) || "").trim() : "";
  return label || provider || "Custom";
}

/** "GLM（智谱）" / "GLM (Zhipu)" / "llama.cpp（本地）" → base name. */
function providerLabelBase(label: unknown): string {
  return String(label || "")
    .replace(/[（(].*$/, "")
    .trim()
    .toLowerCase();
}

/**
 * The old single-slot editor auto-filled the profile name from the initially
 * selected provider but did not update it when the provider changed. That is
 * how a profile called "llama.cpp" ended up pointing at DeepSeek. Repair only
 * exact provider-name matches, so user-written names like "DeepSeek 主账号"
 * are never touched.
 */
function repairAutoProfileNames(
  profiles: ApiProfile[],
  providers: string[],
  labelFor?: ProfileLabelFor,
): boolean {
  if (!labelFor) return false;
  const providerSet = new Set(providers.filter(Boolean));
  const knownBases = new Set<string>();
  for (const provider of providerSet) {
    const base = providerLabelBase(labelFor(provider));
    if (base) knownBases.add(base);
  }

  let changed = false;
  const now = Date.now();
  for (const profile of profiles) {
    if (!profile.provider || !providerSet.has(profile.provider)) continue;
    const currentBase = providerLabelBase(labelFor(profile.provider));
    const nameBase = providerLabelBase(profile.name);
    if (!currentBase || !nameBase || nameBase === currentBase) continue;
    if (!knownBases.has(nameBase)) continue;
    profile.name = labelFor(profile.provider);
    profile.updatedAt = now;
    changed = true;
  }
  return changed;
}

/**
 * Convert pre-profile localStorage keys into profile records. No writes here.
 * IDs deliberately reuse the legacy keystore ids (provider or `_custom`) so
 * existing encrypted keys keep working.
 */
export function migrateLegacyApiProfiles(
  storage: ApiProfileStorage,
  providers: string[],
  labelFor?: ProfileLabelFor,
): ApiProfileStore {
  const candidates = Array.from(new Set(["", ...(providers || [])]));
  const profiles: ApiProfile[] = [];
  const now = Date.now();

  for (const provider of candidates) {
    const prefix = legacyPrefix(provider);
    const apiUrl = storage.getItem(`${prefix}api_url`) || "";
    const model = storage.getItem(`${prefix}model`) || "";
    const contextWindow = storage.getItem(`${prefix}context_window`) || "";
    // `api_format` alone is not a usable config — only migrate real endpoints.
    if (!apiUrl && !model && !contextWindow) continue;

    let apiFormat = storage.getItem(`${prefix}api_format`) || "";
    if (!apiFormat) apiFormat = storage.getItem("AideAgent_api_format") || "openai";

    profiles.push({
      id: provider || CUSTOM_KEYSTORE_ID,
      name: legacyProfileName(provider, labelFor),
      provider,
      providerId: provider || "custom",
      apiUrl,
      model,
      apiFormat: normalizeFormat(apiFormat),
      contextWindow,
      createdAt: now,
      updatedAt: now,
    });
  }

  const legacyActive = storage.getItem(LEGACY_PROVIDER_KEY) || "";
  const activeId = profiles.some((p) => p.provider === legacyActive)
    ? profiles.find((p) => p.provider === legacyActive)?.id ?? null
    : profiles[0]?.id ?? null;

  return { version: 1, activeId, profiles };
}

/**
 * Load profiles, migrating legacy config on first run.
 *
 * An existing store — including an empty one the user created by deleting all
 * profiles — always wins. That prevents deleted legacy configs from coming
 * back on the next launch. When there is nothing to migrate we don't write an
 * empty store either, so later legacy writes (e.g. portable config restore)
 * can still be imported.
 */
export function ensureApiProfileStore(opts: {
  storage?: ApiProfileStorage | null;
  providers?: string[];
  labelFor?: ProfileLabelFor;
} = {}): ApiProfileStore {
  const storage = opts.storage === undefined ? defaultStorage() : opts.storage;
  if (!storage) return emptyApiProfileStore();

  const raw = storage.getItem(API_PROFILE_STORE_KEY);
  if (raw !== null) {
    const parsed = parseApiProfileStore(raw);
    if (parsed) {
      let needsSave = repairAutoProfileNames(parsed.profiles, opts.providers || [], opts.labelFor);
      const needsActiveFix =
        parsed.profiles.length > 0 &&
        (!parsed.activeId || !parsed.profiles.some((p) => p.id === parsed.activeId));
      if (needsActiveFix) {
        parsed.activeId = parsed.profiles[0]?.id ?? null;
        needsSave = true;
      }
      if (needsSave) saveApiProfileStore(parsed, storage);
      return parsed;
    }
    // Corrupt store: drop it so migration can try the legacy keys below.
    try { storage.removeItem(API_PROFILE_STORE_KEY); } catch { /* ignore */ }
  }

  const migrated = migrateLegacyApiProfiles(storage, opts.providers || [], opts.labelFor);
  if (migrated.profiles.length > 0) saveApiProfileStore(migrated, storage);
  return migrated;
}

function makeProfileId(): string {
  const rand = Math.random().toString(36).slice(2, 10);
  return `prof_${Date.now().toString(36)}_${rand}`;
}

export function createApiProfile(
  input: Partial<ApiProfile> = {},
  labelFor?: ProfileLabelFor,
): ApiProfile {
  const provider = typeof input.provider === "string" ? input.provider : "";
  const now = Date.now();
  const name = typeof input.name === "string" ? input.name.trim() : "";
  const id = typeof input.id === "string" && input.id.trim() ? input.id.trim() : makeProfileId();
  const providerId = normalizeProviderId(input.providerId)
    || provider
    || (id === CUSTOM_KEYSTORE_ID ? "custom" : (isValidProviderId(id) ? id : "custom"));
  return {
    id,
    name: name || legacyProfileName(provider, labelFor),
    provider,
    providerId,
    apiUrl: typeof input.apiUrl === "string" ? input.apiUrl : "",
    model: typeof input.model === "string" ? input.model : "",
    apiFormat: normalizeFormat(input.apiFormat),
    contextWindow: typeof input.contextWindow === "string" ? input.contextWindow : "",
    createdAt: Number.isFinite(input.createdAt) ? Number(input.createdAt) : now,
    updatedAt: Number.isFinite(input.updatedAt) ? Number(input.updatedAt) : now,
  };
}

/** Insert or replace by id, preserving list order. */
export function upsertApiProfile(store: ApiProfileStore, profile: ApiProfile): ApiProfileStore {
  const idx = store.profiles.findIndex((p) => p.id === profile.id);
  if (idx >= 0) store.profiles[idx] = profile;
  else store.profiles.push(profile);
  if (!store.activeId) store.activeId = profile.id;
  return store;
}

/** Remove a profile and return it; selects the first remaining profile. */
export function removeApiProfile(store: ApiProfileStore, id: string): ApiProfile | null {
  const idx = store.profiles.findIndex((p) => p.id === id);
  if (idx < 0) return null;
  const [removed] = store.profiles.splice(idx, 1);
  if (store.activeId === id) store.activeId = store.profiles[0]?.id ?? null;
  return removed || null;
}

/** Switch active profile. Returns false if the id is unknown. */
export function setActiveApiProfile(store: ApiProfileStore, id: string): boolean {
  if (!store.profiles.some((p) => p.id === id)) return false;
  store.activeId = id;
  return true;
}

export function getActiveApiProfile(store: ApiProfileStore): ApiProfile | null {
  if (!store.activeId) return null;
  return store.profiles.find((p) => p.id === store.activeId) || null;
}

export function getApiProfile(store: ApiProfileStore, id: string | null): ApiProfile | null {
  if (!id) return null;
  return store.profiles.find((p) => p.id === id) || null;
}

/** The keystore id for a profile. New profiles use their own id. */
export function profileKeyId(profile: ApiProfile): string {
  return profile.id;
}

/** Legacy keystore ids are only relevant for profiles migrated from old keys. */
export function legacyKeyStorageId(profile: ApiProfile): string {
  return profile.provider || CUSTOM_KEYSTORE_ID;
}
