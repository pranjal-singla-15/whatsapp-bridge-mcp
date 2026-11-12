#!/usr/bin/env node
// Packs + encrypts (or decrypts + unpacks) a WhatsApp session directory for CI.
// AES-256-GCM with a scrypt-derived key; the passphrase comes from CANARY_SESSION_KEY.
//
//   node scripts/session-crypt.mjs pack   <sessionDir> <out.enc>
//   node scripts/session-crypt.mjs unpack <in.enc>     <sessionDir>
import { execFileSync } from 'node:child_process';
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const MAGIC = Buffer.from('WABS1');
// GNU tar (e.g. from Git Bash) treats "C:" as a remote host; use Windows' bundled bsdtar there.
const TAR =
  process.platform === 'win32'
    ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe')
    : 'tar';
const EXCLUDES = [
  'Cache',
  'Code Cache',
  'GPUCache',
  'CacheStorage',
  'Crashpad',
  'DawnCache',
  'GrShaderCache',
  'ShaderCache',
];

function key(salt) {
  const pass = process.env.CANARY_SESSION_KEY;
  if (!pass || pass.length < 24) throw new Error('CANARY_SESSION_KEY must be set (>= 24 chars)');
  return scryptSync(pass, salt, 32, { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
}

const [cmd, a, b] = process.argv.slice(2);
const work = mkdtempSync(join(tmpdir(), 'wa-session-'));
const tarFile = join(work, 'session.tar.gz');
try {
  if (cmd === 'pack') {
    const excludes = EXCLUDES.flatMap((e) => ['--exclude', e]);
    execFileSync(TAR, ['-czf', tarFile, ...excludes, '-C', resolve(a), '.'], { stdio: 'inherit' });
    const salt = randomBytes(16);
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key(salt), iv);
    const body = Buffer.concat([cipher.update(readFileSync(tarFile)), cipher.final()]);
    writeFileSync(b, Buffer.concat([MAGIC, salt, iv, cipher.getAuthTag(), body]));
    console.log(`packed ${a} -> ${b} (${(body.length / 1e6).toFixed(1)} MB)`);
  } else if (cmd === 'unpack') {
    const buf = readFileSync(a);
    if (!buf.subarray(0, 5).equals(MAGIC)) throw new Error('not a session bundle');
    const salt = buf.subarray(5, 21);
    const iv = buf.subarray(21, 33);
    const tag = buf.subarray(33, 49);
    const decipher = createDecipheriv('aes-256-gcm', key(salt), iv);
    decipher.setAuthTag(tag);
    writeFileSync(tarFile, Buffer.concat([decipher.update(buf.subarray(49)), decipher.final()]));
    mkdirSync(b, { recursive: true });
    execFileSync(TAR, ['-xzf', tarFile, '-C', resolve(b)], { stdio: 'inherit' });
    console.log(`unpacked -> ${b}`);
  } else {
    console.error('usage: session-crypt.mjs pack <dir> <out> | unpack <in> <dir>');
    process.exit(2);
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}
