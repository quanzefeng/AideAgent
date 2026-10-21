// ── Agent Session — per-conversation mutable state ──────────
//
// Before this module existed, every piece of conversation state (history,
// abort controller, task store, todo list, plan mode, runtime, workspace,
// prompt cache) lived as a module-level singleton in state.ts. Two callers
// running at the same time — the desktop window and the WeChat bridge, or a
// future second window — would overwrite each other's state. The WeChat
// bridge worked around it by saving/restoring the globals around each call,
// which still clobbered a desktop query that was in flight.
//
// Now each conversation owns an AgentSession. `state.ts` keeps its historical
// getter/setter API but resolves them against the *current* session, which is
// either:
//   1. the session bound by AsyncLocalStorage for the running agent loop, or
//   2. the active (desktop) session when called from IPC / renderer code.
//
// AsyncLocalStorage is the key: `runInSession(session, () => agentLoop(...))`
// propagates the binding across every await inside the loop and every tool
// call, with no need to thread a `session` argument through 40 functions.

import { AsyncLocalStorage } from "node:async_hooks";
import type { OpencodeAcpClient } from "./opencode-acp-client.ts";

export type AgentRuntime = "aide" | "opencode";

export interface SessionUsage {
  /** Number of LLM requests that returned usage data. */
  requests: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** Latest request's prompt/output split — useful for context calibration. */
  lastPromptTokens: number;
  lastOutputTokens: number;
  lastRequestAt: number | null;
}

export interface AgentSession {
  /** Null until the first user turn assigns an id (or a session is loaded). */
  id: string | null;
  title: string;
  history: any[];
  abortCtrl: AbortController | null;
  taskStore: Map<string, any>;
  todoList: any[];
  planMode: boolean;
  /** Project root this conversation is bound to. */
  workspace: string;
  runtime: AgentRuntime;
  /**
   * False for bridge sessions (WeChat): no renderer is watching, so approval
   * prompts cannot be answered. Permission checks fail closed instead.
   */
  interactive: boolean;
  episodicSearched: boolean;
  surfacedMemories: Map<string, { turn: number; expiresAt: number }>;
  turnCounter: number;
  opencodeClient: OpencodeAcpClient | null;
  /** System-prompt cache is per session — two sessions may use different models. */
  sysPromptCache: string | null;
  sysPromptKey: string | null;
  contextBlockBaseCache: string | null;
  usage: SessionUsage;
  createdAt: number;
  updatedAt: number;
}

const sessions = new Map<string, AgentSession>();
const als = new AsyncLocalStorage<AgentSession>();

function emptyUsage(): SessionUsage {
  return {
    requests: 0, inputTokens: 0, outputTokens: 0,
    cacheReadTokens: 0, cacheWriteTokens: 0,
    lastPromptTokens: 0, lastOutputTokens: 0, lastRequestAt: null,
  };
}

export function genId() {
  return `ses_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

export function createAgentSession(opts: Partial<AgentSession> & { id?: string | null, workspace?: string } = {}): AgentSession {
  const now = Date.now();
  const session: AgentSession = {
    id: opts.id ?? null,
    title: opts.title ?? "新对话",
    history: opts.history ?? [],
    abortCtrl: opts.abortCtrl ?? null,
    taskStore: opts.taskStore ?? new Map(),
    todoList: opts.todoList ?? [],
    planMode: opts.planMode ?? false,
    workspace: opts.workspace ?? process.cwd(),
    runtime: opts.runtime ?? "aide",
    interactive: opts.interactive ?? true,
    episodicSearched: opts.episodicSearched ?? false,
    surfacedMemories: opts.surfacedMemories ?? new Map(),
    turnCounter: opts.turnCounter ?? 0,
    opencodeClient: opts.opencodeClient ?? null,
    sysPromptCache: opts.sysPromptCache ?? null,
    sysPromptKey: opts.sysPromptKey ?? null,
    contextBlockBaseCache: opts.contextBlockBaseCache ?? null,
    usage: opts.usage ?? emptyUsage(),
    createdAt: opts.createdAt ?? now,
    updatedAt: now,
  };
  if (session.id) sessions.set(session.id, session);
  return session;
}

export function getAgentSession(id: string): AgentSession | undefined {
  return sessions.get(id);
}

export function getOrCreateAgentSession(id: string, opts: Omit<Partial<AgentSession>, "id"> = {}): AgentSession {
  const existing = sessions.get(id);
  if (existing) return existing;
  return createAgentSession({ ...opts, id });
}

export function allAgentSessions(): AgentSession[] {
  return Array.from(sessions.values());
}

/** Bind an id to a session object, keeping the registry consistent. */
export function assignSessionId(session: AgentSession, id: string): AgentSession {
  if (session.id && session.id !== id) sessions.delete(session.id);
  session.id = id;
  session.updatedAt = Date.now();
  sessions.set(id, session);
  return session;
}

export function removeAgentSession(id: string): void {
  sessions.delete(id);
}

// ── Active (desktop) session ────────────────────────────────
// A draft session has id === null: it is the "new chat" state before the
// first prompt assigns an id. It is deliberately NOT in the registry.
let active: AgentSession = createAgentSession({ workspace: process.cwd() });

export function getActiveAgentSession(): AgentSession {
  return active;
}

export function setActiveAgentSession(session: AgentSession): void {
  active = session;
}

/**
 * Reset the desktop session to a fresh draft, preserving the workspace.
 * Used by `session:reset` (new chat) and `session:delete-all`.
 */
export function resetActiveAgentSession(opts: { workspace?: string } = {}): AgentSession {
  active = createAgentSession({ workspace: opts.workspace ?? active.workspace });
  return active;
}

/**
 * `session:load` semantics: activate the registered object when we already
 * have one (so its caches/usage survive), otherwise retarget the current
 * draft object to the loaded id.
 */
export function activateAgentSession(id: string): AgentSession {
  const existing = sessions.get(id);
  if (existing) { active = existing; return existing; }
  assignSessionId(active, id);
  return active;
}

export function currentAgentSession(): AgentSession {
  return als.getStore() ?? active;
}

export function isSessionBound(): boolean {
  return als.getStore() !== undefined;
}

export function runInAgentSession<T>(session: AgentSession, fn: () => T): T {
  return als.run(session, fn);
}

/** Reset conversation content but keep identity, workspace and runtime. */
export function clearAgentSession(session: AgentSession): void {
  session.history = [];
  session.abortCtrl = null;
  session.taskStore = new Map();
  session.todoList = [];
  session.episodicSearched = false;
  session.surfacedMemories = new Map();
  session.turnCounter = 0;
  session.sysPromptCache = null;
  session.sysPromptKey = null;
  session.contextBlockBaseCache = null;
  session.updatedAt = Date.now();
}

export function recordUsage(
  session: AgentSession,
  usage: {
    promptTokens?: number;
    outputTokens?: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
  },
): SessionUsage {
  const u = session.usage;
  u.requests += 1;
  u.inputTokens += usage.promptTokens || 0;
  u.outputTokens += usage.outputTokens || 0;
  u.cacheReadTokens += usage.cacheReadTokens || 0;
  u.cacheWriteTokens += usage.cacheWriteTokens || 0;
  u.lastPromptTokens = usage.promptTokens || 0;
  u.lastOutputTokens = usage.outputTokens || 0;
  u.lastRequestAt = Date.now();
  return u;
}
