#!/usr/bin/env node
// Enforces what the autonomous repair agent is allowed to change. Replaces human review
// for bot-authored changes. Usage: node scripts/guard-protected-paths.mjs <baseRef>
//
// Allowed:
//   - src/transport/**              (the WhatsApp-specific adapters)
//   - package.json                  (ONLY versions of the allow-listed dependencies)
//   - package-lock.json
//   - CHANGELOG.md
//   - test/**                       (ADDING new files only; existing tests are locked)
// Everything else (safety rules, MCP tools, config defaults, workflows, scripts, tests) is protected.
import { execFileSync } from 'node:child_process';

const base = process.argv[2] ?? 'origin/main';
const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();

const ALLOWED = [/^src\/transport\//, /^package-lock\.json$/, /^CHANGELOG\.md$/, /^package\.json$/];
const BUMPABLE_DEPS = new Set([
  'whatsapp-web.js',
  'baileys',
  '@modelcontextprotocol/sdk',
  'puppeteer',
]);

const violations = [];
const changes = git('diff', '--name-status', '--no-renames', `${base}...HEAD`)
  .split('\n')
  .filter(Boolean)
  .map((l) => {
    const [status, path] = l.split('\t');
    return { status, path };
  });

for (const { status, path } of changes) {
  if (path.startsWith('test/')) {
    if (status !== 'A')
      violations.push(`${path}: existing tests may not be modified or deleted (${status})`);
    continue;
  }
  if (!ALLOWED.some((re) => re.test(path))) violations.push(`${path}: protected path (${status})`);
}

if (changes.some((c) => c.path === 'package.json')) {
  const before = JSON.parse(git('show', `${base}:package.json`));
  const after = JSON.parse(git('show', 'HEAD:package.json'));
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (key === 'dependencies') continue;
    if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) {
      violations.push(`package.json: field "${key}" may not be changed`);
    }
  }
  const depsBefore = before.dependencies ?? {};
  const depsAfter = after.dependencies ?? {};
  for (const dep of new Set([...Object.keys(depsBefore), ...Object.keys(depsAfter)])) {
    if (depsBefore[dep] === depsAfter[dep]) continue;
    if (!(dep in depsBefore) || !(dep in depsAfter))
      violations.push(`package.json: dependency "${dep}" added/removed`);
    else if (!BUMPABLE_DEPS.has(dep))
      violations.push(`package.json: dependency "${dep}" may not be changed`);
    else if (!/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(depsAfter[dep])) {
      violations.push(`package.json: "${dep}" must be pinned to an exact version`);
    }
  }
}

if (violations.length) {
  console.error('Protected-path guard FAILED:\n - ' + violations.join('\n - '));
  process.exit(1);
}
console.log(`Protected-path guard OK (${changes.length} changed file(s)).`);
