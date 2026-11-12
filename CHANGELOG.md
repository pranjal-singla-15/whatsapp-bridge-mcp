# Changelog

All notable changes to this project are documented here. Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), versioning: [SemVer](https://semver.org/).

## [Unreleased]

### Added

- Fail fast: while connecting keeps failing, calls are rejected immediately with the real cause instead of waiting for a timeout.
- Failure classification: a repeated code-level start error is reported in `whatsapp_status` as a likely WhatsApp Web incompatibility (`diagnosis`) instead of being retried silently.
- Post-connect self-test: read-only probes of chats, messages, contacts and search run right after every connect. Broken features are switched off immediately and listed in `whatsapp_status` (`selfTest`).

## [0.1.3] - 2026-11-12

### Fixed

- wwebjs: intermittent startup crash "Cannot read properties of null (reading 'Socket')" on WhatsApp Web 2.3000.10542xxxxx; the client now waits for the socket model before injecting.
- Never auto-restore the session backup: rolling back WhatsApp's encryption state got the device unlinked. The backup is kept for manual recovery only.
- Saved contacts addressed by id (`<number>@c.us`) were rejected as unknown recipients when the chat lives under a LID id.

## [0.1.2] - 2026-11-12

### Fixed

- wwebjs: sending threw after delivering and message ids were `undefined`. WhatsApp Web renamed `MsgKey#_serialized`; a feature-detected compatibility shim restores it, and ids are rebuilt from their parts on the Node side.
- wwebjs: contact search returned each person twice (phone-number and LID contact).

## [0.1.1] - 2026-11-12

### Fixed

- wwebjs: listing chats, reading messages and marking read failed on current WhatsApp Web builds (whatsapp-web.js 1.34.7 builds the chat's last message with an empty IndexedDB key). Chats are now read with a minimal in-page serialiser.
- wwebjs: contact search filters inside the page (about 40s down to about 3s for 4k contacts).
- Calls made while the server is still starting now wait up to 45s (`resilience.connectGraceMs`) instead of failing.

## [0.1.0] - 2026-11-12

### Added

- MCP server with 9 tools: status, login (QR), list chats, read/search messages, search contacts, mark read, two-step send.
- Transports: whatsapp-web.js (primary), Baileys (fallback), fake (tests/demo) behind one interface with a shared contract test suite.
- Runtime self-healing: backoff reconnect, watchdog, per-feature circuit breakers, WhatsApp Web version rotation, session backup/restore, failover/failback, auto-revive after login.
- Send safety: read-only default, confirmation tokens, idempotent confirm, known-recipients-only, persisted rate limits, human-like pacing, delivery reconciliation.
- Autonomous maintenance: 6-hourly live canary, headless Claude Code auto-repair with protected-path guard, staged npm releases with automatic rollback, self-healing watchdog.
- Distribution: npm (`npx whatsapp-bridge-mcp`), Claude Code plugin + marketplace, Claude Desktop extension (`.mcpb`).
