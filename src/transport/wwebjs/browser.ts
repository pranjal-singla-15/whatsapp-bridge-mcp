import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

/**
 * Picks a Chromium-based browser for whatsapp-web.js, in order of preference:
 *  1. explicitly configured path
 *  2. the Chrome build bundled with puppeteer (the version wwebjs is tested against)
 *  3. an installed Chrome / Edge / Chromium
 * Returns undefined to let puppeteer use its own default.
 */
export function findBrowser(configured: string | null): string | undefined {
  if (configured) {
    if (!existsSync(configured))
      throw new Error(`Configured browserPath does not exist: ${configured}`);
    return configured;
  }
  const bundled = puppeteerBundled();
  if (bundled) return bundled;
  return systemCandidates().find((p) => existsSync(p));
}

function puppeteerBundled(): string | undefined {
  try {
    // puppeteer is a dependency of whatsapp-web.js; resolve it from there.
    const req = createRequire(createRequire(import.meta.url).resolve('whatsapp-web.js'));
    const puppeteer = req('puppeteer') as { executablePath(): string };
    const p = puppeteer.executablePath();
    return existsSync(p) ? p : undefined;
  } catch {
    return undefined;
  }
}

function systemCandidates(): string[] {
  const env = process.env;
  switch (process.platform) {
    case 'win32': {
      const roots = [env.PROGRAMFILES, env['PROGRAMFILES(X86)'], env.LOCALAPPDATA].filter(
        (r): r is string => Boolean(r),
      );
      return roots.flatMap((r) => [
        join(r, 'Google', 'Chrome', 'Application', 'chrome.exe'),
        join(r, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
        join(r, 'Chromium', 'Application', 'chrome.exe'),
      ]);
    }
    case 'darwin':
      return [
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
        '/Applications/Chromium.app/Contents/MacOS/Chromium',
      ];
    default:
      return [
        '/usr/bin/google-chrome',
        '/usr/bin/google-chrome-stable',
        '/usr/bin/chromium',
        '/usr/bin/chromium-browser',
        '/snap/bin/chromium',
        '/usr/bin/microsoft-edge',
      ];
  }
}
