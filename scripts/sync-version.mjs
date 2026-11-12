#!/usr/bin/env node
// Runs in the npm "version" lifecycle: keeps plugin and Desktop-extension manifests in step
// with package.json so all distribution channels report the same version.
import { readFileSync, writeFileSync } from 'node:fs';

const { version } = JSON.parse(readFileSync('package.json', 'utf8'));
for (const file of ['.claude-plugin/plugin.json', 'manifest.json']) {
  const json = JSON.parse(readFileSync(file, 'utf8'));
  json.version = version;
  writeFileSync(file, JSON.stringify(json, null, 2) + '\n');
}
console.log(`synced manifests to ${version}`);
