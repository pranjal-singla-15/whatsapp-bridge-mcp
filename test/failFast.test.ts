import { describe, expect, it } from 'vitest';
import { Supervisor, type TransportSlot } from '../src/core/supervisor.js';
import { isBridgeError } from '../src/domain/errors.js';
import { FakeTransport } from '../src/transport/fake/FakeTransport.js';
import { systemClock } from '../src/util/time.js';
import { fastResilience, seed, silentLog, until } from './helpers.js';

const slot = (t: FakeTransport): TransportSlot => ({ name: t.name, create: () => t });
const sup = (t: FakeTransport, opts = {}) =>
  new Supervisor([slot(t)], { ...fastResilience, ...opts }, systemClock, silentLog, () => 0.5);
const list = (s: Supervisor) =>
  s.exec('listChats', (x) => x.listChats({ limit: 1, includeArchived: false }), {
    idempotent: true,
  });

describe('fail fast', () => {
  it('rejects immediately with the real cause while connecting keeps failing', async () => {
    const t = new FakeTransport(seed());
    t.failNext('start', new Error("Cannot read properties of null (reading 'Socket')"), Infinity);
    // long backoff + long grace: a slow implementation would hang here
    const s = sup(t, { reconnectBaseMs: 60_000, reconnectMaxMs: 60_000, connectGraceMs: 60_000 });
    s.start();
    await until(() => s.status().recentEvents.some((e) => e.event.includes('start failed')));
    const t0 = Date.now();
    const err = await list(s).catch((e: unknown) => e);
    expect(Date.now() - t0).toBeLessThan(500);
    expect(isBridgeError(err, 'NOT_CONNECTED')).toBe(true);
    expect((err as Error).message).toContain('Socket');
    await s.stop();
  });

  it('diagnoses a repeated code-level failure as a WhatsApp incompatibility', async () => {
    const t = new FakeTransport(seed());
    t.failNext('start', new Error('window.Store.Chat is not a function'), Infinity);
    const s = sup(t, { failoverAfter: 99 });
    s.start();
    await until(() => s.status().diagnosis !== null);
    expect(s.status().diagnosis).toMatch(/WhatsApp Web changed/);
    await s.stop();
  });

  it('does not call a transient network blip an incompatibility', async () => {
    const t = new FakeTransport(seed());
    t.failNext('start', new Error('net::ERR_INTERNET_DISCONNECTED'), 1);
    const s = sup(t);
    s.start();
    await s.waitUntilConnected(1_000);
    expect(s.status().diagnosis).toBeNull();
    await s.stop();
  });

  it('self-test flags a broken feature right after connecting', async () => {
    const t = new FakeTransport(seed());
    t.failNext('searchMessages', new Error('selector changed'), Infinity);
    const s = sup(t);
    s.start();
    await s.waitUntilConnected(1_000);
    await until(() => s.status().selfTest !== null);
    const st = s.status();
    expect(st.selfTest?.failed.map((f) => f.capability)).toEqual(['searchMessages']);
    expect(st.capabilities.find((c) => c.capability === 'searchMessages')?.state).toBe('open');
    expect(st.capabilities.find((c) => c.capability === 'listChats')?.state).toBe('closed');
    const err = await s
      .exec('searchMessages', (x) => x.searchMessages('a', { limit: 1 }), { idempotent: true })
      .catch((e: unknown) => e);
    expect(isBridgeError(err, 'CAPABILITY_UNAVAILABLE')).toBe(true);
    await s.stop();
  });

  it('self-test passes on a healthy transport', async () => {
    const s = sup(new FakeTransport(seed()));
    s.start();
    await s.waitUntilConnected(1_000);
    await until(() => s.status().selfTest !== null);
    expect(s.status().selfTest?.failed).toEqual([]);
    await s.stop();
  });
});
