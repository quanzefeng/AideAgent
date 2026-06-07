/**
 * Global declarations for renderer-side libraries loaded via <script> tags
 * in index.html (CDN) and translations.js (local).
 *
 * These are intentionally typed as `any` / loose signatures — the goal is
 * to silence "Cannot find name" errors so JSDoc on local code can take over.
 * For tighter types, use the actual lib type packages (@types/marked, etc.)
 * or add per-call JSDoc.
 */

// ---------- CDN libraries (index.html L813-817) ----------

declare global {
  /** marked.js — markdown parser. Loaded from CDN as global `marked`. */
  const marked: {
    parse(markdown: string, options?: object): string;
    setOptions(options: object): void;
    use(extension: unknown): void;
  };

  /** highlight.js — syntax highlighter. Loaded from CDN as global `hljs`. */
  const hljs: {
    highlight(code: string, options?: { language?: string }): { value: string };
    highlightAll(): void;
    highlightElement(element: Element): void;
    highlightAuto(code: string): { value: string; language: string };
    registerLanguage(name: string, language: unknown): void;
  };

  /** KaTeX — math rendering. Loaded from CDN as global `katex`. */
  const katex: {
    render(expression: string, element: HTMLElement, options?: object): void;
    renderToString(expression: string, options?: object): string;
  };

  /** DOMPurify — HTML sanitizer. Loaded from CDN as global `DOMPurify`. */
  const DOMPurify: {
    sanitize(dirty: string, options?: object): string;
    addHook(hookName: string, hookFn: (...args: any[]) => any): void;
  };

  // ---------- Local i18n (translations.js L989-1006) ----------

  function getLang(): "zh" | "en";
  function setLang(lang: "zh" | "en"): void;
  function applyLang(): void;

  /**
   * Translation lookup. `key` is a dot-separated path like "settings.appearance".
   * `vars` is an object whose values substitute `{name}` placeholders in the
   * resolved string. Falls back to the key itself if not found.
   */
  function t(key: string, vars?: Record<string, string | number>): string;

  // ---------- app.js internal (only when the splitter exports them) ----------

  function updateWorkspaceDisplay(): void;

  // ---------- shared types used across modules ----------

  /** A single system-prompt profile managed by the prompt store. */
  interface PromptProfile {
    id: string;
    name: string;
    enabled: boolean;
    content: string;
  }

  /** Whole prompt-profile store: which profile is active plus a map of profiles. */
  interface PromptStore {
    activeProfile: string;
    profiles: Record<string, PromptProfile>;
  }

  // ---------- preload bridge (preload.cjs exposes window.aideagent) ----------

  interface Window {
    aideagent: {
      // Workspace
      workspaceGet(): Promise<string>;
      workspaceSet(path: string): Promise<{ ok: boolean }>;
      workspacePick(): Promise<{ ok: boolean; workspace?: string }>;
      workspaceNeedsFirstPick(): Promise<{ needs: boolean }>;

      // MCP (loose — full set lives in mcp.mjs JSDoc)
      mcpList(): Promise<any[]>;
      mcpAdd(name: string, config: any): Promise<{ success: boolean; error?: string }>;
      mcpRemove(name: string): Promise<{ success: boolean; error?: string }>;
      mcpRestart(name: string): Promise<{ success: boolean; error?: string }>;
      mcpBuiltins(): Promise<any[]>;
      mcpToggleBuiltin(name: string, enabled: boolean): Promise<{ success: boolean; error?: string }>;
      mcpSaveAll(): Promise<{ success: boolean; error?: string }>;
      mcpQuickAddSearxng(url: string): Promise<{ success: boolean; error?: string }>;
      mcpDetectLocal(): Promise<any[]>;
      mcpAddRemote(name: string, url: string, headers: Record<string, string>): Promise<{ success: boolean; error?: string }>;

      // Knowledge base
      kbGetVault(): Promise<string>;
      kbSetVault(path: string): Promise<void>;
      kbPickVault(): Promise<{ canceled?: boolean; ok?: boolean; vault?: string; error?: string }>;
      kbConfig(): Promise<{ embeddingProvider: string; ollamaEmbedModel: string; maxNotes: number; maxChars: number; maxBodyChars: number }>;
      kbSetConfig(cfg: Partial<{ embeddingProvider: string; ollamaEmbedModel: string; maxNotes: number; maxChars: number; maxBodyChars: number }>): Promise<void>;
      kbStatus(): Promise<{ noteCount: number; embeddedCount: number; autoDetectedMaxBodyChars: number }>;
      kbScan(): Promise<{ indexed: number; embedded: number; error?: string }>;
      kbSearch(query: string, limit: number): Promise<Array<{ title?: string; rel_path: string; snippet?: string }>>;
      kbOllamaModels(): Promise<string[]>;

      // Sessions (used in app.js)
      sessionsList(): Promise<any[]>;
      sessionGet(id: string): Promise<any>;
      sessionCreate(opts?: any): Promise<any>;
      sessionDelete(id: string): Promise<{ success: boolean; error?: string }>;
      sessionRename(id: string, title: string): Promise<void>;
      sessionSearch(query: string): Promise<any[]>;
      sessionDeleteAll(): Promise<{ success: boolean; count: number; error?: string }>;

      // Memory
      memoryList(opts?: any): Promise<any[]>;
      memoryListAll(): Promise<Array<{ filename: string; name: string; description: string; type: string; body: string }>>;
      memoryAdd(content: string, type: string): Promise<void>;
      memoryDelete(filename: string): Promise<{ success: boolean; error?: string }>;
      memoryUpdate(filename: string, content: string, name: string, description: string, type: string): Promise<{ success: boolean; error?: string }>;
      memoryRead(filename: string): Promise<string>;
      memoryReadOne(filename: string): Promise<{ filename: string; name: string; description: string; type: string; body: string } | null>;
      memoryCreate(name: string, description: string, type: string, body: string): Promise<{ success: boolean; error?: string }>;

      // Skills
      listSkills(): Promise<Array<{ name: string; source?: string; version?: string; triggers?: string[]; allowedTools?: string[]; body?: string }>>;
      loadSkill(name: string): Promise<any | null>;
      skillsListAll(): Promise<Array<{ name: string; status: string; description: string; body?: string }>>;
      skillsLoadOne(name: string): Promise<{ name: string; status?: string; description?: string; body?: string; triggers?: string[]; source?: string } | null>;
      skillsSaveSkill(name: string, meta: any, body: string): Promise<{ success: boolean; error?: string }>;
      skillsSetStatus(name: string, status: string): Promise<void>;
      skillsDelete(name: string): Promise<{ success: boolean; error?: string }>;
      skillsDetectPatterns(): Promise<Array<{ phrase: string; count: number }>>;
      skillsCuratorStatus(): Promise<{ activeSkills: number; archivedSkills: number; lastRun?: string; archiveAfterDays?: number; pendingMerges?: any[] }>;
      skillsCuratorConfig(cfg: { archiveAfterDays: number }): Promise<{ success: boolean; error?: string }>;
      skillsCuratorRun(): Promise<{ archived: number; dupes: number }>;

      // Prompts
      listPromptProfiles(): Promise<PromptStore | null>;
      getDefaultPrompt(): Promise<string>;
      savePromptProfile(profile: PromptProfile): Promise<{ success: boolean; error?: string }>;
      deletePromptProfile(id: string): Promise<{ success: boolean; error?: string }>;
      activatePromptProfile(id: string): Promise<void>;

      // App-level
      appGetApiConfig(): Promise<any>;
      appSaveApiConfig(cfg: any): Promise<{ success: boolean; error?: string }>;
      appGetAvatarConfig(): Promise<any>;
      appSaveAvatarConfig(cfg: any): Promise<void>;
      appSetReasoningEnabled(enabled: boolean): Promise<void>;
      appGetReasoningEnabled(): Promise<boolean>;
      appGetTavilyKey(): Promise<string>;
      appSetTavilyKey(key: string): Promise<{ success: boolean; error?: string }>;
      appClearTavilyKey(): Promise<{ success: boolean; error?: string }>;
      appGetWechatConfig(): Promise<any>;
      appSetWechatConfig(cfg: any): Promise<{ success: boolean; error?: string }>;
      appStartWechatLogin(): Promise<{ success: boolean; error?: string }>;
      appStopWechat(): Promise<{ success: boolean; error?: string }>;
      appGetWechatStatus(): Promise<{ loggedIn: boolean; qrCodeUrl?: string }>;

      // WeChat iLink QR + bot
      wechatGetStatus(): Promise<{ loggedIn: boolean; status?: string }>;
      wechatGetQrcode(): Promise<{ ok: boolean; qrcodeUrl?: string; qrcodeId?: string; error?: string }>;
      wechatPollStatus(id: string): Promise<{ status?: string; botToken?: string; botId?: string; userId?: string; error?: string }>;
      wechatLogin(cfg: { botToken: string; botId: string; userId: string; apiKey: string; apiUrl: string; model: string; apiFormat: string }): Promise<void>;
      wechatLogout(): Promise<void>;
      onWechatBotStatus(handler: (data: { status: string }) => void): void;
      onWechatIncoming(handler: (data: { text: string }) => void): void;
      syncApiToWechat(cfg: { apiUrl: string; apiKey: string; model: string; apiFormat: string }): Promise<void>;
      appGetUpdateStatus(): Promise<any>;
      appCheckUpdate(): Promise<{ success: boolean; error?: string }>;
      appDownloadUpdate(): Promise<{ success: boolean; error?: string }>;
      appInstallUpdate(): Promise<void>;

      // Chat
      chatSend(content: string, opts?: any): Promise<{ sessionId: string; messageId: string }>;
      chatCancel(messageId: string): Promise<{ success: boolean }>;
      chatConfirmAction(actionId: string, choice: string): Promise<void>;

      // Sub-agent & tasks
      agentLaunch(opts: any): Promise<{ success: boolean; agentId?: string; error?: string }>;
      taskList(): Promise<any[]>;
      taskUpdate(id: string, status: string): Promise<void>;

      // Misc
      settingsReset(): Promise<void>;
      exportDiagnostics(): Promise<{ success: boolean; path?: string; error?: string }>;
    };
  }
}

export {};
