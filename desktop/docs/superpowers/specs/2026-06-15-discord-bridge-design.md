# Discord Bot Integration — Design Spec

**Date:** 2026-06-15
**Status:** Draft (pending user approval)
**Author:** Claude (brainstorming session)
**Scope:** Add Discord bot as a third social channel, alongside WeChat

## 1. Problem

AideAgent Desktop currently supports WeChat as its only social channel
(`core/wechat-bridge.mjs`, ~250 lines). This excludes:

- **Overseas users** — WeChat requires a Chinese phone number and is
  unusable outside China for most people.
- **Developer/technical users globally** — Discord is the default for
  open-source, AI, and indie-hacker communities.
- **Self-hosters and small teams** — many already have a Discord server
  for their project and want the bot integrated.

The user has confirmed they want Discord added and that they're OK with
the recommended MVP scope (single bot token, @mention single-turn, OAuth
"add to your server").

## 2. Goal

Add a Discord bot channel with the same UX as WeChat:

- User authorizes AideAgent's official Discord bot into their server
  via OAuth.
- User types `@AideAgent <question>` in any channel the bot has access to.
- Bot replies with the agent's answer, chunked for Discord's 2000-char
  limit.
- Bot status (connected / disconnected / error) is visible in the
  desktop app's settings UI.

## 3. Non-goals (explicit YAGNI)

These are deferred to a future iteration, NOT built in this MVP:

- Slash commands (`/aide ...`) — @mention is sufficient for MVP.
- Multi-turn thread / context preservation across messages — MVP is
  single-turn (one @mention → one answer, fresh context each time).
- Rich embeds / buttons / modals — MVP is plain text.
- Per-user OAuth tokens (multi-tenant) — MVP uses one shared bot token.
- Voice channel support.
- Discord ↔ desktop session sync — Discord runs in isolated agent
  context, identical to WeChat.
- Slash command auto-registration / `application.commands` API.
- Custom bot avatar / username / presence status.

## 4. Design

### 4.1 Architecture

```
┌─────────────────────────────────────────────────┐
│  User's Discord server (any server)              │
│  ↓ @AideAgent message                            │
│  Discord Gateway (WebSocket)                     │
└──────────────────┬──────────────────────────────┘
                   │ events
                   ▼
┌─────────────────────────────────────────────────┐
│  core/discord-bridge.mjs (Electron main)        │
│  ─ discord.js Client (Gateway Intents:          │
│    GUILDS, GUILD_MESSAGES, MESSAGE_CONTENT)     │
│  ─ messageCreate handler                         │
│  ─ Typing indicator (refresh every 5s)          │
│  ─ Reply chunking (2000 char/msg limit)          │
└──────────────────┬──────────────────────────────┘
                   │ agentLoop(prompt)
                   ▼
┌─────────────────────────────────────────────────┐
│  Reuse core/agent-loop.mjs (same as WeChat)     │
│  ─ Isolated history / sessionId / abortCtrl      │
│  ─ Restored after reply completes                │
└─────────────────────────────────────────────────┘
                   │
                   ▼
┌─────────────────────────────────────────────────┐
│  IPC notifications to renderer:                 │
│  discord:bot-status / discord:incoming           │
└─────────────────────────────────────────────────┘
```

### 4.2 User setup flow

1. User opens AideAgent Desktop → Settings → Discord tab.
2. Sees "Add AideAgent to your Discord server" button.
3. Clicks → opens Discord OAuth2 URL:
   `https://discord.com/oauth2/authorize?client_id=<CLIENT_ID>&scope=bot&permissions=274877906944`
   (permissions=274877906944 = SEND_MESSAGES + READ_MESSAGE_HISTORY +
   EMBED_LINKS + ATTACH_FILES + READ_MESSAGES)
4. User selects target server, confirms.
5. Discord redirects back to AideAgent via deep link
   `aideagent://discord-auth?code=...`.
6. Main process does **not** exchange the OAuth code for a token
   (because we use a single shared bot token, not per-user OAuth —
   see §4.4). The redirect back to the desktop app is purely a UX
   signal: the user completed authorization, and the bot has joined
   their server. The desktop app then connects to the gateway using
   the already-stored bot token from settings.
7. UI shows bot as connected, with channel list.

**Simplification for MVP:** The OAuth flow exists to let users add the
bot to their own servers. We do NOT exchange the OAuth code for a
user-scoped token. The bot token is a single shared token that the
AideAgent maintainer (user) provides in the settings panel.

### 4.3 Config storage

Stored at `~/.aideagent/config/discord.json`:

```json
{
  "botToken": "MTAxMjM0NTY3ODkw...",
  "clientId": "1234567890123456789",
  "apiKey": "sk-...",
  "apiUrl": "https://api.deepseek.com/v1",
  "model": "deepseek-chat",
  "apiFormat": "openai",
  "allowUserIds": [],
  "allowChannelIds": []
}
```

- `botToken` — Discord bot token (single shared token).
- `clientId` — Discord application ID, used to construct invite URLs.
- `apiKey` / `apiUrl` / `model` / `apiFormat` — LLM config (same shape
  as WeChat config).
- `allowUserIds` — empty array means allow any user; otherwise whitelist.
- `allowChannelIds` — empty array means allow any channel the bot can
  see; otherwise whitelist.

Loaded on startup. If absent or invalid, Discord features are disabled
in the UI but the app continues to function normally.

### 4.4 Bot token source (MVP simplification)

The Discord bot is an application the maintainer must create manually:

1. Go to https://discord.com/developers/applications
2. New Application → name "AideAgent"
3. Bot tab → Add Bot → Copy token
4. OAuth2 tab → copy Client ID
5. Paste both into AideAgent's Discord settings panel

This is documented in the settings UI's help text. The bot must have
the **Message Content Intent** enabled in the Discord developer portal
(required since 2022 for bots to read message content).

**Why not per-user OAuth?** Per-user OAuth would require a registered
Discord application, dynamic bot creation per user, token refresh
handling, rate-limit isolation, abuse mitigation, and per-user billing.
That's a 2-3 month project. MVP uses one shared token — same trade-off
as the user's own WeChat bot.

### 4.5 Message handling

```js
client.on('messageCreate', async (msg) => {
  // Filter: ignore bots, DMs unless allowed, non-mentions
  if (msg.author.bot) return;
  if (!msg.mentions.has(client.user)) return;
  if (msg.channel.isDMBased() && !config.allowDMs) return;
  if (!isAllowedUser(msg.author.id)) return;
  if (!isAllowedChannel(msg.channel.id)) return;

  // Strip the @mention, get the actual prompt
  const text = msg.content.replace(/<@!?\d+>/g, '').trim();
  if (!text) return;

  // Typing indicator refresh (Discord expires typing after 10s)
  const typingInterval = setInterval(
    () => msg.channel.sendTyping().catch(() => {}),
    5000
  );
  await msg.channel.sendTyping();

  try {
    const reply = await generateDiscordReply(text);
    await sendChunked(msg.channel, reply);
  } catch (e) {
    await msg.reply(`[error] ${e.message}`).catch(() => {});
  } finally {
    clearInterval(typingInterval);
  }
});
```

### 4.6 Reply chunking

Discord has a 2000-char hard limit per message. Splitting strategy:

1. Try to split on `\n\n` (paragraph break) — prefer that.
2. Fall back to splitting on `\n` (line break).
3. Fall back to splitting on `. ` (sentence).
4. Last resort: hard cut at 2000 chars.

Each chunk is sent as a separate message in the same channel. The bot
does NOT reply-in-thread or use embeds — just sends plain text messages
in the channel where it was mentioned.

If the reply is empty (agent returned no text), send `"(no response)"`.

### 4.7 Typing indicator

Discord typing expires after 10 seconds. For long agent loops (multi-
minute tasks), the typing indicator would stop. We refresh every 5
seconds while the agent is running. When the loop ends (success or
error), `clearInterval` stops the refresh.

### 4.8 Isolation from desktop session

Identical to WeChat's pattern (`core/wechat-bridge.mjs:170-193`):

```js
async function generateDiscordReply(prompt) {
  const cfg = loadDiscordConfig();
  const lastApi = getLastApiConfig();
  const apiKey = cfg.apiKey || lastApi.apiKey;
  const apiUrl = cfg.apiUrl || lastApi.apiUrl;
  const model = cfg.model || lastApi.model || "deepseek-chat";
  const apiFormat = cfg.apiFormat || lastApi.apiFormat || "openai";

  if (!apiKey || !apiUrl) {
    return "请先在桌面端发送一条消息激活 API，或配置 Discord 设置";
  }

  // Save desktop state
  const savedHistory = [...getHistory()];
  const savedSessionId = getSessionId();
  const savedAbortCtrl = getAbortCtrl();

  // Isolated state for Discord
  setAbortCtrl(new AbortController());
  setSessionId(null);
  setHistory([]);

  const { agentLoop, resetPromptCache } = await import("./agent-loop.mjs");
  try {
    const result = await agentLoop(
      prompt, apiKey, apiUrl, model, apiFormat,
      [], [], false, "", undefined, false, true, true
    );
    return result.text || "";
  } catch (err) {
    console.error("[discord] agentLoop error:", err.message);
    return `[出错: ${err.message}]`;
  } finally {
    // Restore desktop state
    setHistory(savedHistory);
    setSessionId(savedSessionId);
    setAbortCtrl(savedAbortCtrl);
    resetPromptCache();
  }
}
```

### 4.9 Connection lifecycle

| Event | Behavior |
|---|---|
| Settings: token entered → Save | Save config, instantiate discord.js Client, login |
| Client ready | Send `discord:bot-status { status: "connected" }` to renderer |
| Client error / disconnect | Send `discord:bot-status { status: "error", error }` to renderer, auto-reconnect (discord.js handles by default) |
| Settings: Logout button | Destroy client, clear config file |
| Electron quit | Destroy client, cleanup listeners |
| Invalid token (401) | Send `discord:bot-status { status: "invalid_token" }`, do not retry |

### 4.10 IPC surface

| Channel | Direction | Args | Returns |
|---|---|---|---|
| `discord:login` | renderer → main | `{ botToken, clientId, apiKey, apiUrl, model, apiFormat, allowUserIds, allowChannelIds }` | `{ ok: true }` or `{ ok: false, error }` |
| `discord:logout` | renderer → main | (none) | `{ ok: true }` |
| `discord:get-status` | renderer → main | (none) | `{ connected: boolean, username?: string, guildCount?: number, allowUserIds, allowChannelIds }` |
| `discord:get-invite-url` | renderer → main | (none) | `{ url: string }` (constructed from clientId) |
| `discord:bot-status` | main → renderer (push) | `{ status: "connected"\|"disconnected"\|"error"\|"invalid_token", error? }` | — |
| `discord:incoming` | main → renderer (push) | `{ userId, username, text, channelId, guildId }` | — |

### 4.11 Renderer UI

A new "Discord" tab in the existing settings panel:

- **Token field** (password input) + **Client ID field**
- **"Add to your Discord server" button** (opens invite URL in browser)
- **API config** (reuses existing API config UI)
- **Allowlist**: user IDs (textarea, one per line) + channel IDs (textarea, one per line)
- **Status indicator**: connected (green dot + username + guild count) / disconnected (gray) / error (red + message)
- **Logout button**

Renderer is read-only for incoming messages — they're shown in a log
section for debugging only ("Discord: @user asked: '...'") but no
history is kept client-side.

## 5. Dependencies

Add to `package.json` dependencies:

```json
"discord.js": "^14.16.0"
```

`discord.js` is the standard Node.js Discord library. v14 is the
current major version with native ESM support (matches this project's
`"type": "module"`). No native bindings, so no `asarUnpack` changes
needed.

## 6. Error handling matrix

| Failure | Behavior |
|---|---|
| Empty bot token | Settings save is rejected, no client instantiated |
| Invalid bot token (401) | `discord:bot-status { status: "invalid_token" }`, client destroyed |
| Discord API rate limit | discord.js auto-handles with exponential backoff |
| Network disconnect | discord.js auto-reconnects; renderer notified |
| `agentLoop` throws | User sees `[error] xxx`; bot stays connected |
| User not in allowlist | Message silently ignored (not even a typing indicator) |
| Channel not in allowlist | Same — silent ignore |
| Empty prompt after stripping @mention | Silent ignore |
| Reply exceeds 2000 chars | Split into multiple messages |
| Discord gateway timeout (>10s typing) | Typing interval refreshes every 5s |
| Multiple simultaneous messages from same user | Each gets its own agentLoop call, no queuing |
| Electron quits during active reply | Discord client destroyed; partial reply may be sent |

## 7. Files changed

| File | Action | Lines |
|---|---|---|
| `core/discord-bridge.mjs` | Create | +220 |
| `core/state.mjs` | Modify (add discord state getters/setters) | +25 |
| `core/ipc-handlers.mjs` | Modify (add 4 IPC handlers) | +40 |
| `preload.cjs` | Modify (expose discord API) | +25 |
| `renderer/app.js` | Modify (Discord settings tab + status) | +200 |
| `renderer/index.html` | Modify (Discord tab markup) | +40 |
| `renderer/styles.css` | Modify (Discord status indicator styles) | +30 |
| `package.json` | Modify (add discord.js dep) | +1 |
| `test/discord-bridge.test.mjs` | Create (mock discord.js) | +200 |
| `docs/superpowers/specs/2026-06-15-discord-bridge-design.md` | Create (this file) | (spec) |
| **Total** | | **~780 lines** |

## 8. Tests

`test/discord-bridge.test.mjs` (new file, ~5 cases):

1. **Config load/save roundtrip** — `loadDiscordConfig`/`saveDiscordConfig`
   writes and reads back the same shape.
2. **`isAllowedUser` / `isAllowedChannel`** — empty arrays = allow all;
   non-empty = whitelist match; user-id mismatch = denied.
3. **Reply chunking** — short reply (under 2000 chars) is sent as one
   message; long reply is split on `\n\n` first; very-long reply falls
   back to hard cut at 2000.
4. **Mention extraction** — `@AideAgent hello world` → `"hello world"`;
   `@bot @AideAgent foo` → `"foo"`; `AideAgent hello` (no @) → not
   processed.
5. **IPC handler shape** — `discord:login` validates required fields,
   rejects empty token; `discord:get-status` returns expected shape.

Tests mock `discord.js` Client entirely — no real Discord API calls.
The `agentLoop` is mocked the same way WeChat tests presumably mock it.

## 9. Migration

There is no migration. New code, new files, new IPC channels. Existing
WeChat users see no change. Existing sessions, knowledge base, settings
all unaffected.

The `discord.js` dependency is installed via `npm install`. The first
run after update prompts the user to install if they want the feature
(optional, not required).

## 10. Documentation

The settings panel includes inline help text for the bot token / client
ID fields, with a link to https://discord.com/developers/applications.

A README addition (not in scope of this spec) is recommended but
deferred.

## 11. Open questions

None — all architectural decisions (single shared bot token, @mention
single-turn, OAuth for add-to-server, no slash commands, no thread)
were confirmed during brainstorming.
