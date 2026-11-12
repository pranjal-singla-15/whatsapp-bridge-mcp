#!/usr/bin/env node
// One-time GitHub repository configuration for the autonomous pipeline (idempotent).
import { execFileSync } from 'node:child_process';

const gh = (...args) => {
  try {
    return execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch (err) {
    return `(skipped: ${
      String(err.stderr ?? err.message)
        .trim()
        .split('\n')[0]
    })`;
  }
};
const repo = gh('repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner');

console.log('labels:', gh('label', 'create', 'auto-repair', '--color', '0E8A16', '--force'));
console.log('labels:', gh('label', 'create', 'canary-failure', '--color', 'B60205', '--force'));
// Workflows need write permission and must be allowed to open PRs (auto-repair).
console.log(
  'actions permissions:',
  gh(
    'api',
    '-X',
    'PUT',
    `repos/${repo}/actions/permissions/workflow`,
    '-f',
    'default_workflow_permissions=write',
    '-F',
    'can_approve_pull_request_reviews=true',
  ) || 'ok',
);
console.log(
  'merge settings:',
  gh('repo', 'edit', repo, '--enable-squash-merge', '--delete-branch-on-merge') || 'ok',
);
console.log(
  'variable CANARY_ENABLED:',
  gh('variable', 'set', 'CANARY_ENABLED', '--body', 'false') || 'ok (enabled by canary-bootstrap)',
);
console.log(
  `\nDone for ${repo}. Next: set ANTHROPIC_API_KEY and NPM_TOKEN secrets, then run scripts/canary-bootstrap.mjs.`,
);
