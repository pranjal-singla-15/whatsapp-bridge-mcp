import { createRequire } from 'node:module';

/** Single source of truth: package.json. */
export const VERSION: string = (
  createRequire(import.meta.url)('../package.json') as { version: string }
).version;
