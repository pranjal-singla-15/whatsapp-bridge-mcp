# Changelog

All notable changes to this project are documented here. Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), versioning: [SemVer](https://semver.org/).

## [Unreleased]

## [0.1.0] - 2026-11-12

### Added

- MCP server with 9 tools: status, login (QR), list chats, read/search messages, search contacts, mark read, two-step send.
- Transports: whatsapp-web.js (primary), Baileys (fallback), fake (tests/demo) behind one interface with a shared contract test suite.
- Runtime self-healing: backoff reconnect, watchdog, per-feature circuit breakers, WhatsApp Web version rotation, session backup/restore, failover/failback, auto-revive after login.
- Send safety: read-only default, confirmation tokens, idempotent confirm, known-recipients-only, persisted rate limits, human-like pacing, delivery reconciliation.
- Autonomous maintenance: 6-hourly live canary, headless Claude Code auto-repair with protected-path guard, staged npm releases with automatic rollback, self-healing watchdog.
- Distribution: npm (`npx whatsapp-bridge-mcp`), Claude Code plugin + marketplace, Claude Desktop extension (`.mcpb`).
