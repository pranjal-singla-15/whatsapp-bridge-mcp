# Architecture

## Layers (ports & adapters)

```
MCP client (Claude)
   │  stdio, JSON-RPC
src/mcp/server.ts          MCP adapter: schemas, formatting, error mapping. No business logic.
   │
src/core/service.ts        Application service: recipient resolution, send policy,
   │                       two-step confirmation, idempotency, delivery reconciliation.
   │                       RateLimiter (persisted sliding windows).
src/core/supervisor.ts     Runtime self-healing: lifecycle, backoff, watchdog, failover/failback,
   │                       per-capability circuit breakers (FeatureHealth), timeouts.
   │                       SessionVault (last-known-good session backup).
src/transport/transport.ts THE seam: WhatsAppTransport interface + domain types (src/domain).
   ├─ wwebjs/   primary: genuine WhatsApp Web in headless Chrome (whatsapp-web.js)
   ├─ baileys/  fallback: multi-device websocket protocol (Baileys) + persistent store
   └─ fake/     deterministic in-memory transport for tests and demo mode
src/app.ts                 Composition root: the only place concrete classes are chosen.
```

Rules:

- Library-specific code never leaves `src/transport/<name>/`. Everything above it sees only
  domain types (`Chat`, `Message`, `Contact`), so a broken or replaced library touches one folder.
- Every transport must pass the shared behavioural contract (`test/contract/transportContract.ts`).
  The fake runs it in CI, and real transports run it against a test account (`CONTRACT_LIVE=1`).
- stdout is reserved for MCP. All logging is structured JSON on stderr, with message text and
  phone numbers redacted (the `no-console` lint rule enforces this).

## Self-healing at runtime

| Failure                                      | Mechanism                                                                                                                      | Where                                 |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------- |
| Connection drop / WhatsApp restart           | exponential backoff with jitter, unlimited retries                                                                             | `Supervisor.connectLoop`              |
| Browser hangs / page crash                   | watchdog probe every 60s; two failures rebuild the transport                                                                   | `Supervisor.tick`                     |
| Hung call                                    | per-operation timeout                                                                                                          | `Supervisor.exec`                     |
| A WhatsApp change breaks one feature         | per-capability circuit breaker with half-open trials; other features keep working                                              | `FeatureHealth`                       |
| Bad WhatsApp Web build                       | rotate through pinned known-good builds, then live; remember the last good one                                                 | `VersionSelector`                     |
| Corrupted session                            | last-known-good copy kept for **manual** recovery only (auto-restore rolled back encryption state and got the device unlinked) | `SessionVault`                        |
| Primary transport broken                     | fail over to Baileys, retry the primary after 30 min                                                                           | `Supervisor.pickSlot` / `tick`        |
| Logged out elsewhere, then re-linked via CLI | while logged out, re-check every 30s                                                                                           | `Supervisor.revive`                   |
| Send errored but may have been delivered     | look for the message in the chat before allowing a retry                                                                       | `WhatsAppService.reconcileFailedSend` |

Failures that need a human (logged out, account banned) are reported clearly by `whatsapp_status`
and in tool errors. The supervisor does not loop on them.

## Safety model for sending

1. Off by default (`send.enabled=false`).
2. Two-step: `whatsapp_send_message` returns a preview plus a single-use token that expires
   after 5 minutes. `whatsapp_confirm_send` sends it. Confirming twice returns the first result.
3. Recipients must have chat history with you or be saved contacts. Cold messaging is the top
   ban trigger.
4. Rate limits per minute, hour and day, persisted to disk so restarts can't reset them.
5. A random 1.2–3.5s pause before each send.
6. Inbound message text is wrapped in `<untrusted_messages>` to defend against prompt injection.
