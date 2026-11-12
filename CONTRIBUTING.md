# Contributing

1. `npm ci`, then `npm run check` (typecheck + lint + tests) must pass. Coverage thresholds are enforced.
2. Keep library-specific code inside `src/transport/<name>/`. Everything else uses domain types only (see `docs/ARCHITECTURE.md`).
3. New transport behaviour belongs in the shared contract suite (`test/contract/transportContract.ts`).
4. Never write to stdout from server code (it carries the MCP protocol). Use the logger.
5. Use [Conventional Commits](https://www.conventionalcommits.org/) (`feat:`, `fix:`, `chore:` …) and add a line under `## [Unreleased]` in `CHANGELOG.md`.
6. Never test against your personal WhatsApp account. Use a spare number (`--profile test`).
