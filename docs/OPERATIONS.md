# Operations: the autonomous maintenance loop

No step needs a human. Two things can't be automated, and the system reports both as GitHub
issues: re-linking a logged-out test number, and dealing with a banned number.

```
             every 6h                          failure
 Canary ───────────────► live test on TEST number ───────► rollback? ─► Auto-repair agent
   │ success                                                             │
   ├─ refresh encrypted session                                           ├─ edits allowed paths only
   ├─ pin known-good WhatsApp Web build ─► Release (next)                 ├─ gates: guard, tests, smoke, live canary
   └─ promote next → latest after 6h soak                                 └─ merge ─► Release (next)
 Watchdog (every 6h): re-enable workflows, catch up missed canary, cancel stuck runs, keep repo active
 Canary re-enables Watchdog; an external Claude routine watches both.
```

## Workflows

| Workflow       | Trigger                | Purpose                                                                                                                        |
| -------------- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `ci.yml`       | push / PR              | Typecheck, lint, format, tests with coverage gates, build, stdio smoke test (Linux × Node 20/22). Guard on `auto-repair/*` PRs |
| `canary.yml`   | every 6h               | Live end-to-end test. Success: refresh session, record pins, promote. Failure: roll back or start repair                       |
| `repair.yml`   | canary failure, weekly | Headless Claude Code fixes or upgrades the transport. Merged only if every gate passes                                         |
| `release.yml`  | dispatch / human push  | Patch bump, npm publish under `next`, GitHub release with the `.mcpb`                                                          |
| `watchdog.yml` | every 6h               | Keeps the scheduler itself healthy                                                                                             |

### Why it can't duplicate or overlap

- Schedules live in the repo, not in any Claude Code session, so there is only ever one copy.
- Every workflow has a `concurrency` group, so only one canary, repair or release runs at a time.
- Repair is locked by any open `auto-repair` PR and capped at 4 attempts per 24h.

### Guardrails that replace human review

- `scripts/guard-protected-paths.mjs`: the agent may only change `src/transport/**`, exact
  versions of allow-listed dependencies, the lockfile and the changelog. It may add tests but
  never edit or delete existing ones. Safety logic, tools, config, workflows and scripts are off-limits.
- The agent runs without a push-capable token (`persist-credentials: false`). The pipeline
  commits and pushes only after the gates pass.
- Staged release: `next` → soak 6h plus a passing canary → `latest`. The previous `latest` is
  kept as `prev-stable`. If the canary fails and `prev-stable` still passes, `latest` rolls back.

## One-time setup

```bash
gh auth login
node scripts/setup-repo.mjs               # labels, Actions permissions
gh secret set ANTHROPIC_API_KEY           # dedicated key with a spend limit, for the repair agent
gh secret set NPM_TOKEN                   # npm automation token (publishing)
npm run build
node scripts/canary-bootstrap.mjs <TEST number, e.g. 919876543210>   # scan with the SPARE phone
gh workflow run canary.yml
```

Optional repo variable: `REPAIR_MODEL` (default `claude-opus-5-5`).

## Runbook

| Symptom                                    | Action                                                                 |
| ------------------------------------------ | ---------------------------------------------------------------------- |
| Issue "test number must be re-linked"      | Re-run `node scripts/canary-bootstrap.mjs <number>`                    |
| Issue "Canary failing" stays open for days | Read the repair run summaries. The agent explains what it couldn't fix |
| Need to stop all automation                | `gh variable set CANARY_ENABLED --body false`                          |
| Manual rollback                            | `NODE_AUTH_TOKEN=… node scripts/dist-tags.mjs rollback`                |
