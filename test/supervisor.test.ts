import { describe, expect, it } from 'vitest';
import { errors, isBridgeError } from '../src/domain/errors.js';
import { Supervisor, type TransportSlot } from '../src/core/supervisor.js';
import { FakeTransport } from '../src/transport/fake/FakeTransport.js';
import { systemClock } from '../src/util/time.js';
import { fastResilience, manualClock, seed, silentLog, until } from './helpers.js';

function sup(slots: TransportSlot[], opts = {}) {
  return new Supervisor(slots, { ...fastResilience, ...opts }, systemClock, silentLog, () => 0.5);
}
const slot = (t: FakeTransport, name = t.name): TransportSlot => ({ name, create: () => t });

describe('Supervisor', () => {
  it('connects and runs operations', async () => {
    const t = new FakeTransport(seed());
    const s = sup([slot(t)]);
    s.start();
    await s.waitUntilConnected(1_000);
    expect(s.status().state).toBe('running');
    const chats = await s.exec(
      'listChats',
      (x) => x.listChats({ limit: 5, includeArchived: false }),
      { idempotent: true },
    );
    expect(chats.length).toBeGreaterThan(0);
    await s.stop();
  });

  it('retries start with backoff until it succeeds', async () => {
    const t = new FakeTransport(seed());
    t.failNext('start', new Error('chrome crashed'), 1);
    const s = sup([slot(t)], { failoverAfter: 99 });
    s.start();
    await s.waitUntilConnected(1_000);
    expect(t.calls.filter((c) => c.method === 'start')).toHaveLength(2);
    expect(s.status().recentEvents.some((e) => e.event.includes('start failed'))).toBe(true);
    await s.stop();
  });

  it('fails over to the secondary transport after repeated failures', async () => {
    const primary = new FakeTransport(seed(), 'primary');
    primary.failNext('start', new Error('WhatsApp Web changed'), Infinity);
    const backup = new FakeTransport(seed(), 'backup');
    const s = sup([slot(primary), slot(backup)]);
    s.start();
    await s.waitUntilConnected(1_000);
    expect(s.status()).toMatchObject({ activeTransport: 'backup', usingFallback: true });
    await s.stop();
  });

  it('skips a logged-out primary and uses the fallback', async () => {
    const primary = new FakeTransport(seed(), 'primary');
    primary.failNext('start', errors.loggedOut(), Infinity);
    const backup = new FakeTransport(seed(), 'backup');
    const s = sup([slot(primary), slot(backup)]);
    s.start();
    await s.waitUntilConnected(1_000);
    expect(s.status().activeTransport).toBe('backup');
    await s.stop();
  });

  it('enters logged_out (no busy loop) when every transport is logged out', async () => {
    const t = new FakeTransport(seed());
    t.failNext('start', errors.loggedOut(), Infinity);
    const s = sup([slot(t)]);
    s.start();
    await until(() => s.status().state === 'logged_out');
    const err = await s
      .exec('listChats', (x) => x.listChats({ limit: 1, includeArchived: false }), {
        idempotent: true,
      })
      .catch((e: unknown) => e);
    expect(isBridgeError(err, 'LOGGED_OUT')).toBe(true);
    expect(t.calls.filter((c) => c.method === 'start').length).toBe(1);
    await s.stop();
  });

  it('recovers automatically after an unexpected disconnect', async () => {
    const t = new FakeTransport(seed());
    const s = sup([slot(t)]);
    s.start();
    await s.waitUntilConnected(1_000);
    t.simulateDisconnect('failed');
    await until(() => s.status().state === 'running' && s.status().reconnects === 1);
    await s.stop();
  });

  it('transparently serves a call issued during a quick reconnect', async () => {
    const t = new FakeTransport(seed());
    const s = sup([slot(t)]);
    s.start();
    await s.waitUntilConnected(1_000);
    t.simulateDisconnect('failed');
    const chats = await s.exec(
      'listChats',
      (x) => x.listChats({ limit: 1, includeArchived: false }),
      { idempotent: true },
    );
    expect(chats).toHaveLength(1);
    await s.stop();
  });

  it('retries idempotent operations once, never sends', async () => {
    const t = new FakeTransport(seed());
    const s = sup([slot(t)]);
    s.start();
    await s.waitUntilConnected(1_000);
    t.failNext('listChats', new Error('flaky'), 1);
    await expect(
      s.exec('listChats', (x) => x.listChats({ limit: 1, includeArchived: false }), {
        idempotent: true,
      }),
    ).resolves.toHaveLength(1);
    t.failNext('sendText', new Error('flaky'), 1);
    await expect(
      s.exec('sendText', (x) => x.sendText('9111111111@c.us', 'hi'), { idempotent: false }),
    ).rejects.toThrow();
    expect(t.sent()).toHaveLength(0);
    await s.stop();
  });

  it('opens a per-capability breaker without affecting other features', async () => {
    const t = new FakeTransport(seed());
    const s = sup([slot(t)], { breakerThreshold: 2 });
    s.start();
    await s.waitUntilConnected(1_000);
    t.failNext('searchMessages', new Error('selector changed'), Infinity);
    const search = () =>
      s.exec('searchMessages', (x) => x.searchMessages('a', { limit: 1 }), { idempotent: true });
    await search().catch(() => undefined); // 2 failures (with retry) -> open
    const err = await search().catch((e: unknown) => e);
    expect(isBridgeError(err, 'CAPABILITY_UNAVAILABLE')).toBe(true);
    // listing still works
    await expect(
      s.exec('listChats', (x) => x.listChats({ limit: 1, includeArchived: false }), {
        idempotent: true,
      }),
    ).resolves.toHaveLength(1);
    expect(s.status().capabilities.find((c) => c.capability === 'searchMessages')?.state).toBe(
      'open',
    );
    await s.stop();
  });

  it('does not penalise features for caller errors (NOT_FOUND)', async () => {
    const t = new FakeTransport(seed());
    const s = sup([slot(t)], { breakerThreshold: 1 });
    s.start();
    await s.waitUntilConnected(1_000);
    await s
      .exec('getMessages', (x) => x.getMessages('nope@c.us', { limit: 1 }), { idempotent: true })
      .catch(() => undefined);
    expect(s.status().capabilities.find((c) => c.capability === 'getMessages')?.state).toBe(
      'closed',
    );
    await s.stop();
  });

  it('times out hung operations', async () => {
    const t = new FakeTransport(seed());
    const s = sup([slot(t)], { opTimeoutMs: 30 });
    s.start();
    await s.waitUntilConnected(1_000);
    const err = await s
      .exec('listChats', () => new Promise<never>(() => undefined), { idempotent: false })
      .catch((e: unknown) => e);
    expect(isBridgeError(err, 'TIMEOUT')).toBe(true);
    await s.stop();
  });

  it('interactive login surfaces the QR code and connects after the scan', async () => {
    const t = new FakeTransport(seed());
    t.requireLogin = true;
    const s = sup([slot(t)]);
    const qr = await s.beginInteractiveLogin(1_000);
    expect(qr).toBe('FAKE-QR-PAYLOAD');
    t.completeLogin();
    await s.waitUntilConnected(1_000);
    await s.stop();
  });

  it('revives after an external login while logged out', async () => {
    const t = new FakeTransport(seed());
    t.failNext('start', errors.loggedOut(), 1);
    const clock = manualClock();
    const s = new Supervisor([slot(t)], fastResilience, clock, silentLog);
    s.start();
    await until(() => s.status().state === 'logged_out');
    clock.advance(31_000);
    await s
      .exec('listChats', (x) => x.listChats({ limit: 1, includeArchived: false }), {
        idempotent: true,
      })
      .catch(() => undefined);
    await until(() => s.status().state === 'running');
    await s.stop();
  });
});
