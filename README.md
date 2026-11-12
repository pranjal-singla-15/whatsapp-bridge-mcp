# WhatsApp Bridge MCP

Use WhatsApp from Claude (Claude Code, Claude Desktop) or any other MCP client: read and summarise
chats, search messages and contacts, and send messages with safety rules built in.

- **Personal account, linked like WhatsApp Web.** Scan a QR code once. Your phone does not need to stay online.
- **Safe by default.** Read-only until you enable sending. Every message needs your explicit
  confirmation. Unknown numbers are blocked, and there are rate limits and human-like pacing.
- **Self-healing.** Reconnects on its own and restarts a frozen browser. Restores a corrupted
  session from backup, rolls back a bad WhatsApp Web build, switches to a backup connection, and
  turns off only the feature that broke.
- **Maintained automatically.** A live test runs every 6 hours. A headless Claude Code agent repairs
  breakages, and fixes are released in stages with automatic rollback
  (see [docs/OPERATIONS.md](docs/OPERATIONS.md)).

> [!WARNING]
> This uses unofficial WhatsApp clients (whatsapp-web.js / Baileys), which is against WhatsApp's
> Terms of Service. Light personal use is low-risk, but **any account can be restricted or banned**,
> especially for bulk messaging or messaging people who don't have your number. Use at your own risk.
> Never use it for spam.

## Install

### Claude Code (plugin)

```text
/plugin marketplace add pranjal-singla-15/whatsapp-bridge-mcp
/plugin install whatsapp-bridge@whatsapp-bridge
```

### Claude Code (manual)

```bash
claude mcp add whatsapp -- npx -y whatsapp-bridge-mcp@latest
# Windows (native, not WSL):
claude mcp add whatsapp -- cmd /c npx -y whatsapp-bridge-mcp@latest
```

### Claude Desktop

Download `whatsapp-bridge.mcpb` from the [latest release](https://github.com/pranjal-singla-15/whatsapp-bridge-mcp/releases/latest)
and double-click it. Settings let you turn on sending.

### Any MCP client

```json
{ "mcpServers": { "whatsapp": { "command": "npx", "args": ["-y", "whatsapp-bridge-mcp@latest"] } } }
```

Requirements: Node.js 20 or newer, and Chrome, Edge or Chromium (found automatically).

## Link your account

Either ask Claude to "log in to WhatsApp" (the `whatsapp_login` tool shows a QR code), or run:

```bash
npx whatsapp-bridge-mcp login
```

Then on your phone go to **WhatsApp → Settings → Linked devices → Link a device** and scan.
`npx whatsapp-bridge-mcp doctor` checks your setup.

## Tools

| Tool                       | What it does                                                                         |
| -------------------------- | ------------------------------------------------------------------------------------ |
| `whatsapp_status`          | Connection, active transport, per-feature health, send usage, recent recovery events |
| `whatsapp_login`           | Returns a QR code to link the device                                                 |
| `whatsapp_list_chats`      | Chats, pinned first, then most recent. Options for unread only and archived          |
| `whatsapp_get_messages`    | Recent messages of a chat, found by name, number or id                               |
| `whatsapp_search_messages` | Full-text search across all chats or one chat                                        |
| `whatsapp_search_contacts` | Find contacts by name or number                                                      |
| `whatsapp_mark_read`       | Mark a chat as read                                                                  |
| `whatsapp_send_message`    | **Step 1:** prepare a text or file message and get a preview plus a token            |
| `whatsapp_confirm_send`    | **Step 2:** send it, only after you approve the preview. Never sends twice           |

Message contents are returned as untrusted data, so instructions hidden in a WhatsApp message
can't take over the assistant.

## Configuration

Settings come from `~/.whatsapp-bridge/config.json`, overridden by environment variables.

| Setting (config.json)                            | Env var                              | Default                                                            |
| ------------------------------------------------ | ------------------------------------ | ------------------------------------------------------------------ |
| `send.enabled`                                   | `WA_BRIDGE_SEND_ENABLED`             | `false` (read-only)                                                |
| `send.requireConfirmation`                       | `WA_BRIDGE_REQUIRE_CONFIRMATION`     | `true`                                                             |
| `send.allowUnknownRecipients`                    | `WA_BRIDGE_ALLOW_UNKNOWN_RECIPIENTS` | `false`                                                            |
| `send.maxPerMinute` / `maxPerHour` / `maxPerDay` | `WA_BRIDGE_MAX_PER_*`                | 5 / 40 / 150                                                       |
| `transport`                                      | `WA_BRIDGE_TRANSPORT`                | `wwebjs` (`baileys`, `fake` for a demo)                            |
| `fallbackTransport`                              | `WA_BRIDGE_FALLBACK_TRANSPORT`       | `none` (set `baileys` and log in with `--transport baileys`)       |
| `profile`                                        | `WA_BRIDGE_PROFILE`                  | `default` (separate accounts or sessions)                          |
| `browserPath`                                    | `WA_BRIDGE_BROWSER_PATH`             | auto-detect                                                        |
| `dataDir`                                        | `WA_BRIDGE_DATA_DIR`                 | `~/.whatsapp-bridge`                                               |
| `logLevel`                                       | `WA_BRIDGE_LOG_LEVEL`                | `info` (logs go to stderr, with message text and numbers redacted) |

Example: enable sending.

```json
{ "send": { "enabled": true } }
```

Try every tool without an account: `WA_BRIDGE_TRANSPORT=fake npx whatsapp-bridge-mcp`.

## Privacy

Everything runs on your machine. The session and data live only in `~/.whatsapp-bridge`.
There is no telemetry and no server. `npx whatsapp-bridge-mcp logout` unlinks the device and
deletes the local session.

## How it works

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the design and the self-healing layers, and
[docs/OPERATIONS.md](docs/OPERATIONS.md) for the autonomous CI pipeline.

## Development

```bash
npm ci
npm run check        # typecheck + lint + tests
npm run build && node scripts/smoke.mjs
npm run dev          # run from source
```

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

MIT
