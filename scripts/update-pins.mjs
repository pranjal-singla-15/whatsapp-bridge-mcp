#!/usr/bin/env node
// Records a WhatsApp Web build that just passed the canary as known-good (newest first, max 3).
// Usage: node scripts/update-pins.mjs <canary-report.json>
// Prints "changed" or "unchanged" so the workflow knows whether to commit.
import { readFileSync, writeFileSync } from 'node:fs';

const FILE = 'src/transport/wwebjs/pins.json';
const report = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const version = report.remoteVersion;

if (
  !report.ok ||
  report.transport !== 'wwebjs' ||
  !/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(version ?? '')
) {
  console.log('unchanged');
  process.exit(0);
}
const pins = JSON.parse(readFileSync(FILE, 'utf8'));
if (pins.versions[0] === version) {
  console.log('unchanged');
  process.exit(0);
}
pins.versions = [version, ...pins.versions.filter((v) => v !== version)].slice(0, 3);
writeFileSync(FILE, JSON.stringify(pins, null, 2) + '\n');
console.log('changed');
