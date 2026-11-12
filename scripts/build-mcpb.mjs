#!/usr/bin/env node
// Builds the Claude Desktop extension (.mcpb): dist + production node_modules + manifest.
// Usage: node scripts/build-mcpb.mjs [out.mcpb]   (run `npm run build` first)
import { execSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const { version } = JSON.parse(readFileSync('package.json', 'utf8'));
const out = resolve(process.argv[2] ?? `whatsapp-bridge-mcp-${version}.mcpb`);
const stage = mkdtempSync(join(tmpdir(), 'wa-mcpb-'));
try {
  for (const f of [
    'dist',
    'package.json',
    'package-lock.json',
    'manifest.json',
    'README.md',
    'LICENSE',
  ]) {
    cpSync(f, join(stage, f), { recursive: true });
  }
  execSync('npm ci --omit=dev --ignore-scripts', {
    cwd: stage,
    stdio: 'inherit',
    env: { ...process.env, PUPPETEER_SKIP_DOWNLOAD: 'true' },
  });
  execSync(`npx -y @anthropic-ai/mcpb@2.1.2 validate manifest.json`, {
    cwd: stage,
    stdio: 'inherit',
  });
  execSync(`npx -y @anthropic-ai/mcpb@2.1.2 pack . "${out}"`, { cwd: stage, stdio: 'inherit' });
  console.log(`built ${out}`);
} finally {
  rmSync(stage, { recursive: true, force: true });
}
