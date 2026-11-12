#!/usr/bin/env node
// Staged releases via npm dist-tags (npm itself is the state store; no extra infrastructure).
//   next        newest release, used only by the canary
//   latest      what users get (`npx whatsapp-bridge-mcp@latest`)
//   prev-stable the `latest` before the last promotion; rollback target
//
//   node scripts/dist-tags.mjs promote <canaryPassedAtISO>   promote next -> latest after soak
//   node scripts/dist-tags.mjs rollback                      latest -> prev-stable
//   node scripts/dist-tags.mjs show
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const SOAK_HOURS = Number(process.env.SOAK_HOURS ?? 6);
const pkg = JSON.parse(readFileSync('package.json', 'utf8')).name;
const npm = (...args) =>
  execFileSync('npm', args, { encoding: 'utf8', shell: process.platform === 'win32' }).trim();

function tags() {
  try {
    return JSON.parse(npm('view', pkg, 'dist-tags', '--json'));
  } catch {
    return {};
  }
}

const [cmd, arg] = process.argv.slice(2);
const t = tags();

if (cmd === 'show') {
  console.log(JSON.stringify(t, null, 2));
} else if (cmd === 'promote') {
  if (!t.next || t.next === t.latest) {
    console.log(`nothing to promote (next=${t.next}, latest=${t.latest})`);
    process.exit(0);
  }
  const published = new Date(JSON.parse(npm('view', pkg, 'time', '--json'))[t.next]);
  const canaryPassedAt = new Date(arg);
  const soakedHours = (Date.now() - published.getTime()) / 3_600_000;
  if (Number.isNaN(canaryPassedAt.getTime()) || canaryPassedAt <= published) {
    console.log(`not promoting ${t.next}: no passing canary since it was published`);
  } else if (soakedHours < SOAK_HOURS) {
    console.log(`not promoting ${t.next}: soaked ${soakedHours.toFixed(1)}h < ${SOAK_HOURS}h`);
  } else {
    if (t.latest) npm('dist-tag', 'add', `${pkg}@${t.latest}`, 'prev-stable');
    npm('dist-tag', 'add', `${pkg}@${t.next}`, 'latest');
    console.log(`promoted ${t.next} -> latest (prev-stable=${t.latest ?? 'none'})`);
  }
} else if (cmd === 'rollback') {
  if (!t['prev-stable'] || t['prev-stable'] === t.latest) {
    console.log('no rollback target');
    process.exit(0);
  }
  npm('dist-tag', 'add', `${pkg}@${t['prev-stable']}`, 'latest');
  console.log(`rolled back latest ${t.latest} -> ${t['prev-stable']}`);
} else {
  console.error('usage: dist-tags.mjs promote <iso> | rollback | show');
  process.exit(2);
}
