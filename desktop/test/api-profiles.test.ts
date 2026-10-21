// @ts-check
// Tests for renderer/modules/api-profiles.ts — profile CRUD + legacy migration.

import { describe, it, expect } from "vitest";
import {
  API_PROFILE_STORE_KEY,
  createApiProfile,
  emptyApiProfileStore,
  ensureApiProfileStore,
  getActiveApiProfile,
  isValidProviderId,
  migrateLegacyApiProfiles,
  normalizeProviderId,
  parseApiProfileStore,
  removeApiProfile,
  saveApiProfileStore,
  setActiveApiProfile,
  upsertApiProfile,
} from "../renderer/modules/api-profiles.ts";

class MemoryStorage {
  private map = new Map<string, string>();
  getItem(key: string): string | null {
    return this.map.has(key) ? this.map.get(key)! : null;
  }
  setItem(key: string, value: string): void {
    this.map.set(key, String(value));
  }
  removeItem(key: string): void {
    this.map.delete(key);
  }
}

const labels = (provider: string) =>
  provider === "" ? "自定义" : provider === "deepseek" ? "DeepSeek" : provider;

describe("API profiles — legacy migration", () => {
  it("migrates the old custom slot and preserves the legacy keystore id", () => {
    const storage = new MemoryStorage();
    storage.setItem("AideAgent_provider", "");
    storage.setItem("AideAgent_api_url", "https://example.test/v1/chat/completions");
    storage.setItem("AideAgent_model", "custom-model");
    storage.setItem("AideAgent_api_format", "anthropic");
    storage.setItem("AideAgent_context_window", "65536");

    const store = ensureApiProfileStore({
      storage,
      providers: ["", "deepseek"],
      labelFor: labels,
    });

    expect(store.profiles).toHaveLength(1);
    expect(store.activeId).toBe("_custom");
    expect(store.profiles[0]).toMatchObject({
      id: "_custom",
      name: "自定义",
      provider: "",
      providerId: "custom",
      apiUrl: "https://example.test/v1/chat/completions",
      model: "custom-model",
      apiFormat: "anthropic",
      contextWindow: "65536",
    });
    expect(storage.getItem(API_PROFILE_STORE_KEY)).toContain("_custom");
  });

  it("migrates every legacy provider slot and honors the active provider", () => {
    const storage = new MemoryStorage();
    storage.setItem("AideAgent_provider", "glm");
    storage.setItem("AideAgent_deepseek_api_url", "https://api.deepseek.com");
    storage.setItem("AideAgent_deepseek_model", "deepseek-v4-flash");
    storage.setItem("AideAgent_deepseek_api_format", "openai");
    storage.setItem("AideAgent_glm_api_url", "https://open.bigmodel.cn/api/paas/v4");
    storage.setItem("AideAgent_glm_model", "GLM-4.7-Flash");
    storage.setItem("AideAgent_glm_api_format", "openai");

    const store = ensureApiProfileStore({
      storage,
      providers: ["", "deepseek", "glm"],
      labelFor: labels,
    });

    expect(store.profiles.map((p) => p.id).sort()).toEqual(["deepseek", "glm"]);
    expect(store.activeId).toBe("glm");
    expect(store.profiles.find((p) => p.id === "glm")?.name).toBe("glm");
  });

  it("does not write an empty store when there is nothing to migrate", () => {
    const storage = new MemoryStorage();
    const store = ensureApiProfileStore({ storage, providers: [""], labelFor: labels });
    expect(store.profiles).toHaveLength(0);
    expect(storage.getItem(API_PROFILE_STORE_KEY)).toBeNull();
  });

  it("an existing empty store wins and never resurrects deleted legacy configs", () => {
    const storage = new MemoryStorage();
    saveApiProfileStore(emptyApiProfileStore(), storage);
    storage.setItem("AideAgent_provider", "deepseek");
    storage.setItem("AideAgent_deepseek_api_url", "https://api.deepseek.com");

    const store = ensureApiProfileStore({ storage, providers: ["", "deepseek"], labelFor: labels });
    expect(store.profiles).toHaveLength(0);
    expect(store.activeId).toBeNull();
  });

  it("normalizes an invalid active id to the first profile", () => {
    const storage = new MemoryStorage();
    storage.setItem(API_PROFILE_STORE_KEY, JSON.stringify({
      version: 1,
      activeId: "missing",
      profiles: [
        { id: "a", name: "A", provider: "", apiUrl: "https://a", model: "", apiFormat: "openai", contextWindow: "" },
        { id: "b", name: "B", provider: "", apiUrl: "https://b", model: "", apiFormat: "openai", contextWindow: "" },
      ],
    }));

    const store = ensureApiProfileStore({ storage, providers: [""], labelFor: labels });
    expect(store.activeId).toBe("a");
    // Older store entries did not have providerId; custom profiles fall back
    // to their unique profile id.
    expect(store.profiles[0].providerId).toBe("a");
  });

  it("repairs an auto-generated name left on the wrong provider", () => {
    const storage = new MemoryStorage();
    storage.setItem(API_PROFILE_STORE_KEY, JSON.stringify({
      version: 1,
      activeId: "prof_old",
      profiles: [
        { id: "prof_old", name: "llama.cpp（本地）", provider: "deepseek", apiUrl: "https://api.deepseek.com", model: "", apiFormat: "openai", contextWindow: "" },
        { id: "prof_named", name: "DeepSeek 主账号", provider: "deepseek", apiUrl: "https://api.deepseek.com", model: "", apiFormat: "openai", contextWindow: "" },
      ],
    }));

    const store = ensureApiProfileStore({
      storage,
      providers: ["", "deepseek", "glm", "llamacpp"],
      labelFor: (provider) => provider === ""
        ? "自定义"
        : provider === "deepseek"
          ? "DeepSeek"
          : provider === "glm"
            ? "GLM (Zhipu)"
            : "llama.cpp (Local)",
    });

    expect(store.profiles[0].name).toBe("DeepSeek");
    expect(store.profiles[1].name).toBe("DeepSeek 主账号");
    const raw = JSON.parse(storage.getItem(API_PROFILE_STORE_KEY) || "{}");
    expect(raw.profiles[0].name).toBe("DeepSeek");
  });

  it("falls back to legacy keys when the stored JSON is corrupt", () => {
    const storage = new MemoryStorage();
    storage.setItem(API_PROFILE_STORE_KEY, "{not-json");
    storage.setItem("AideAgent_provider", "deepseek");
    storage.setItem("AideAgent_deepseek_api_url", "https://api.deepseek.com");
    storage.setItem("AideAgent_deepseek_model", "deepseek-v4-flash");

    const store = ensureApiProfileStore({ storage, providers: ["", "deepseek"], labelFor: labels });
    expect(store.profiles).toHaveLength(1);
    expect(store.profiles[0].id).toBe("deepseek");
    expect(store.activeId).toBe("deepseek");
  });

  it("does not create a custom profile from a stray global format alone", () => {
    const storage = new MemoryStorage();
    storage.setItem("AideAgent_api_format", "anthropic");

    const store = migrateLegacyApiProfiles(storage, [""], labels);
    expect(store.profiles).toHaveLength(0);
  });
});

describe("API profiles — CRUD", () => {
  it("creates a profile with a stable id and fallback name", () => {
    const profile = createApiProfile({ provider: "deepseek" }, labels);
    expect(profile.id).toMatch(/^prof_/);
    expect(profile.name).toBe("DeepSeek");
    expect(profile.providerId).toBe("deepseek");
    expect(profile.apiFormat).toBe("openai");
  });

  it("normalizes and validates custom provider ids", () => {
    expect(normalizeProviderId("  Acme-Gateway  ")).toBe("acme-gateway");
    expect(isValidProviderId("acme-gateway")).toBe(true);
    expect(isValidProviderId("acme_gateway2")).toBe(true);
    expect(isValidProviderId("2acme")).toBe(false);
    expect(isValidProviderId("Acme")).toBe(false);
    expect(isValidProviderId("acme gateway")).toBe(false);

    const custom = createApiProfile({
      id: "prof_custom",
      name: "My Gateway",
      provider: "",
      providerId: " Acme-Gateway ",
      apiUrl: "https://gateway.test/v1/chat/completions",
    });
    expect(custom.providerId).toBe("acme-gateway");

    const generated = createApiProfile({ provider: "" });
    expect(generated.providerId).toBe(generated.id);
    expect(isValidProviderId(generated.providerId)).toBe(true);
    expect(createApiProfile({ id: "_custom", provider: "" }).providerId).toBe("custom");
  });

  it("upserts, switches active, and removes profiles", () => {
    const store = emptyApiProfileStore();
    const a = createApiProfile({ id: "a", name: "A", provider: "", apiUrl: "https://a" });
    const b = createApiProfile({ id: "b", name: "B", provider: "deepseek", apiUrl: "https://b" });

    upsertApiProfile(store, a);
    upsertApiProfile(store, b);
    expect(store.activeId).toBe("a");
    expect(getActiveApiProfile(store)?.name).toBe("A");

    expect(setActiveApiProfile(store, "b")).toBe(true);
    expect(store.activeId).toBe("b");
    expect(setActiveApiProfile(store, "missing")).toBe(false);

    upsertApiProfile(store, { ...a, name: "A2" });
    expect(store.profiles.filter((p) => p.id === "a")).toHaveLength(1);
    expect(store.profiles.find((p) => p.id === "a")?.name).toBe("A2");

    const removed = removeApiProfile(store, "b");
    expect(removed?.id).toBe("b");
    expect(store.activeId).toBe("a");
    expect(removeApiProfile(store, "b")).toBeNull();
  });

  it("removing the last profile clears the active selection", () => {
    const store = emptyApiProfileStore();
    upsertApiProfile(store, createApiProfile({ id: "only", name: "Only", provider: "", apiUrl: "https://x" }));
    removeApiProfile(store, "only");
    expect(store.profiles).toHaveLength(0);
    expect(store.activeId).toBeNull();
    expect(getActiveApiProfile(store)).toBeNull();
  });

  it("round-trips through storage without API keys", () => {
    const storage = new MemoryStorage();
    const store = emptyApiProfileStore();
    upsertApiProfile(store, createApiProfile({
      id: "prof_test",
      name: "Test",
      provider: "deepseek",
      apiUrl: "https://api.deepseek.com",
      model: "deepseek-v4-flash",
      apiFormat: "openai",
      contextWindow: "65536",
    }));

    expect(saveApiProfileStore(store, storage)).toBe(true);
    const raw = storage.getItem(API_PROFILE_STORE_KEY) || "";
    expect(raw).not.toContain("apiKey");
    expect(raw).not.toContain("sk-");

    const parsed = parseApiProfileStore(raw);
    expect(parsed?.activeId).toBe("prof_test");
    expect(parsed?.profiles[0].model).toBe("deepseek-v4-flash");
  });

  it("rejects malformed stores", () => {
    expect(parseApiProfileStore(null)).toBeNull();
    expect(parseApiProfileStore("[]")).toBeNull();
    expect(parseApiProfileStore(JSON.stringify({ profiles: "nope" }))).toBeNull();
  });
});
