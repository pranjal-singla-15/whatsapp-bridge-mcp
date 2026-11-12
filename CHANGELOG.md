# Changelog

All notable changes to this project are documented here. Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), versioning: [SemVer](https://semver.org/).

## [Unreleased]

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
