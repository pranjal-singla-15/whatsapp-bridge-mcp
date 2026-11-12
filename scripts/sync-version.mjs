#!/usr/bin/env node
// Runs in the npm "version" lifecycle: keeps plugin and Desktop-extension manifests in step
// with package.json so all distribution channels report the same version.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const { version } = JSON.parse(readFileSync('package.json', 'utf8'));
const FILES = ['.claude-plugin/plugin.json', 'manifest.json'];
for (const file of FILES) {
  const json = JSON.parse(readFileSync(file, 'utf8'));
  json.version = version;
  writeFileSync(file, JSON.stringify(json, null, 2) + '\n');
}
// Keep bot-written files in the repo's formatting so CI's format check stays green.
execFileSync('npx', ['prettier', '--write', ...FILES], {
  stdio: 'ignore',
  shell: process.platform === 'win32',
});
console.log(`synced manifests to ${version}`);
