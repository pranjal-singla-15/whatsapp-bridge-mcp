#!/usr/bin/env node
// One-time setup of the CI canary (run locally, with the SPARE test number's phone at hand):
//   1. links the "canary" profile by QR code
//   2. encrypts the session and uploads it to the private `canary-session` release
//   3. stores the encryption key and canary settings as GitHub secrets/variables
//
// Usage: node scripts/canary-bootstrap.mjs <test-number-with-country-code>
// Requires: gh CLI logged in, project built (npm run build).
import { execFileSync, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

const phone = (process.argv[2] ?? '').replace(/\D/g, '');
if (phone.length < 8) {
  console.error(
    'usage: node scripts/canary-bootstrap.mjs <test number incl. country code, e.g. 919876543210>',
  );
  process.exit(2);
}
const gh = (...args) =>
  execFileSync('gh', args, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'inherit'] }).trim();
const dataDir = join(homedir(), '.whatsapp-bridge');
const profileDir = join(dataDir, 'profiles', 'canary');
const sessionDir = join(profileDir, 'wwebjs');

console.log('Step 1/3: link the TEST number (scan with the spare phone, NOT your main account)');
const login = spawnSync(process.execPath, ['dist/index.js', 'login', '--profile', 'canary'], {
  stdio: 'inherit',
});
if (login.status !== 0) process.exit(login.status ?? 1);
if (!existsSync(sessionDir)) throw new Error(`session not found at ${sessionDir}`);

console.log('Step 2/3: encrypt + upload session');
const key = randomBytes(32).toString('base64url');
const work = mkdtempSync(join(tmpdir(), 'wa-canary-'));
const bundle = join(work, 'canary-session.enc');
execFileSync(process.execPath, ['scripts/session-crypt.mjs', 'pack', sessionDir, bundle], {
  stdio: 'inherit',
  env: { ...process.env, CANARY_SESSION_KEY: key },
});
try {
  gh('release', 'view', 'canary-session');
} catch {
  gh(
    'release',
    'create',
    'canary-session',
    '--prerelease',
    '--title',
    'Canary session (encrypted, do not use)',
    '--notes',
    'Encrypted WhatsApp test-number session used by the canary workflow. Managed automatically.',
  );
}
gh('release', 'upload', 'canary-session', bundle, '--clobber');

console.log('Step 3/3: configure repository secrets/variables');
execFileSync('gh', ['secret', 'set', 'CANARY_SESSION_KEY'], {
  input: key,
  stdio: ['pipe', 'inherit', 'inherit'],
});
gh('variable', 'set', 'CANARY_TARGET', '--body', `${phone}@c.us`);
gh('variable', 'set', 'CANARY_ENABLED', '--body', 'true');
console.log('\nCanary bootstrapped. Trigger a first run with: gh workflow run canary.yml');
