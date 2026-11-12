import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { FeatureHealth } from '../src/core/featureHealth.js';
import { RateLimiter } from '../src/core/rateLimiter.js';
import { SessionVault } from '../src/core/sessionVault.js';
import { createLogger, redact } from '../src/logger.js';
import { toDomainJid, toWireJid } from '../src/transport/baileys/BaileysTransport.js';
import { VersionSelector } from '../src/transport/wwebjs/versionSelector.js';
import { backoffDelay } from '../src/util/time.js';
import { manualClock, silentLog } from './helpers.js';

const tmp = () => mkdtempSync(join(tmpdir(), 'wa-bridge-unit-'));

describe('config', () => {
  it('defaults to safe, read-only settings', () => {
    const c = loadConfig({ WA_BRIDGE_DATA_DIR: tmp() });
    expect(c.send).toMatchObject({
      enabled: false,
      requireConfirmation: true,
      allowUnknownRecipients: false,
    });
    expect(c.transport).toBe('wwebjs');
  });

  it('layers config file under environment variables', () => {
    const dir = tmp();
    writeFileSync(
      join(dir, 'config.json'),
      JSON.stringify({ send: { enabled: true, maxPerDay: 10 }, logLevel: 'debug' }),
    );
    const c = loadConfig({ WA_BRIDGE_DATA_DIR: dir, WA_BRIDGE_LOG_LEVEL: 'warn' });
    expect(c.send.enabled).toBe(true);
    expect(c.send.maxPerDay).toBe(10);
    expect(c.send.maxPerHour).toBe(40); // untouched default survives deep merge
    expect(c.logLevel).toBe('warn');
  });

  it('rejects invalid values with a readable message', () => {
    expect(() =>
      loadConfig({ WA_BRIDGE_DATA_DIR: tmp(), WA_BRIDGE_TRANSPORT: 'telegram' }),
    ).toThrow(/transport/);
    expect(() => loadConfig({ WA_BRIDGE_DATA_DIR: tmp(), WA_BRIDGE_PROFILE: '../etc' })).toThrow(
      /profile/,
    );
    expect(() =>
      loadConfig({ WA_BRIDGE_DATA_DIR: tmp(), WA_BRIDGE_FALLBACK_TRANSPORT: 'wwebjs' }),
    ).toThrow(/differ/);
  });
});

describe('logger', () => {
  it('redacts message content and phone numbers', () => {
    expect(redact({ text: 'secret', chatId: '919876543210@c.us' })).toEqual({
      text: '[redacted:6]',
      chatId: '919***',
    });
  });

  it('writes JSON lines and respects level', () => {
    const lines: string[] = [];
    const log = createLogger('warn', { a: 1 }, (l) => lines.push(l));
    log.info('hidden');
    log.warn('shown', { b: 2 });
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toMatchObject({ level: 'warn', msg: 'shown', a: 1, b: 2 });
  });
});

describe('FeatureHealth', () => {
  it('opens after threshold, half-opens after cooldown, closes on success', () => {
    const clock = manualClock();
    const h = new FeatureHealth(clock, 2, 1_000);
    h.failure('sendText', 'x');
    expect(h.check('sendText')).toBeNull();
    h.failure('sendText', 'x');
    expect(h.check('sendText')).toBe(1);
    clock.advance(1_000);
    expect(h.check('sendText')).toBeNull(); // half-open trial
    h.failure('sendText', 'x');
    expect(h.check('sendText')).not.toBeNull(); // re-opened immediately
    clock.advance(1_000);
    h.check('sendText');
    h.success('sendText');
    expect(h.snapshot().find((e) => e.capability === 'sendText')?.state).toBe('closed');
  });
});

describe('RateLimiter', () => {
  it('enforces sliding windows and persists across restarts', () => {
    const clock = manualClock();
    const file = join(tmp(), 'limits.json');
    const limits = { maxPerMinute: 2, maxPerHour: 3, maxPerDay: 10 };
    const a = new RateLimiter(limits, clock, file);
    a.consume();
    a.consume();
    expect(() => a.consume()).toThrow(/per minute/);
    clock.advance(61_000);
    const b = new RateLimiter(limits, clock, file); // "restart"
    b.consume();
    expect(() => b.consume()).toThrow(/per hour/);
    expect(b.usage().lastHour).toBe(3);
  });
});

describe('VersionSelector', () => {
  it('rotates away from a bad build and remembers the good one', () => {
    const file = join(tmp(), 'v.json');
    const v = new VersionSelector(['2.3000.2', '2.3000.1'], file);
    expect(v.current()).toBe('2.3000.2');
    v.markBad('2.3000.2');
    expect(v.current()).toBe('2.3000.1');
    v.markGood('2.3000.1');
    expect(new VersionSelector(['2.3000.2', '2.3000.1'], file).current()).toBe('2.3000.1');
  });

  it('falls back to the live build after all pins fail', () => {
    const v = new VersionSelector(['2.3000.1'], null);
    v.markBad('2.3000.1');
    expect(v.current()).toBeNull();
    v.markBad(null);
    expect(v.current()).toBe('2.3000.1');
  });
});

describe('SessionVault', () => {
  it('snapshots a healthy session and restores it', async () => {
    const dir = join(tmp(), 'session');
    mkdirSync(join(dir, 'Default', 'Cache'), { recursive: true });
    writeFileSync(join(dir, 'auth.json'), 'good');
    writeFileSync(join(dir, 'Default', 'Cache', 'big.bin'), 'cache');
    const vault = new SessionVault(dir, silentLog);
    await vault.snapshotIfHealthy();
    expect(await vault.hasBackup()).toBe(false); // not marked healthy yet
    await vault.markHealthy();
    await vault.snapshotIfHealthy();
    expect(existsSync(`${dir}.last-good/Default/Cache/big.bin`)).toBe(false); // caches skipped
    writeFileSync(join(dir, 'auth.json'), 'corrupted');
    expect(await vault.restore()).toBe(true);
    expect(readFileSync(join(dir, 'auth.json'), 'utf8')).toBe('good');
  });
});

describe('Baileys jid mapping', () => {
  it('normalises to and from the domain form', () => {
    expect(toDomainJid('911234567890:12@s.whatsapp.net')).toBe('911234567890@c.us');
    expect(toDomainJid('12036@g.us')).toBe('12036@g.us');
    expect(toWireJid('911234567890@c.us')).toBe('911234567890@s.whatsapp.net');
  });
});

describe('backoffDelay', () => {
  it('grows exponentially and is capped', () => {
    const mid = () => 0.5;
    expect(backoffDelay(0, { baseMs: 100, maxMs: 1_000 }, mid)).toBe(75);
    expect(backoffDelay(3, { baseMs: 100, maxMs: 1_000 }, mid)).toBe(600);
    expect(backoffDelay(10, { baseMs: 100, maxMs: 1_000 }, mid)).toBe(750);
  });
});
