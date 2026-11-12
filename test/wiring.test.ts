import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it } from 'vitest';
import { createApp, transportFactoryFor } from '../src/app.js';
import { defaultConfig, type Config } from '../src/config.js';
import { Supervisor } from '../src/core/supervisor.js';
import { errors } from '../src/domain/errors.js';
import { createMcpServer } from '../src/mcp/server.js';
import { FakeTransport } from '../src/transport/fake/FakeTransport.js';
import { systemClock } from '../src/util/time.js';
import { fakeApp, fastResilience, seed, silentLog, until } from './helpers.js';

function cfg(over: Partial<Config> = {}): Config {
  return {
    ...defaultConfig(),
    dataDir: mkdtempSync(join(tmpdir(), 'wa-bridge-wiring-')),
    logLevel: 'silent',
    ...over,
  };
}

describe('composition root', () => {
  it('runs the built-in demo transport end to end', async () => {
    const app = await createApp(cfg({ transport: 'fake' }));
    app.supervisor.start();
    await app.supervisor.waitUntilConnected(1_000);
    const chats = await app.service.listChats({
      limit: 5,
      includeArchived: false,
      unreadOnly: false,
    });
    expect(chats[0]?.name).toBe('Alice (demo)');
    await app.supervisor.stop();
  });

  it('constructs real transports lazily without connecting', async () => {
    const c = cfg();
    for (const name of ['wwebjs', 'baileys'] as const) {
      const factory = await transportFactoryFor(name, c, silentLog);
      const t = factory(name, { interactive: false });
      expect(t.name).toBe(name);
      expect(t.state()).toBe('stopped');
      expect(t.info().libraryVersion).toBeTruthy();
      await expect(t.listChats({ limit: 1, includeArchived: false })).rejects.toMatchObject({
        code: 'NOT_CONNECTED',
      });
    }
  }, 30_000); // first import of puppeteer/Baileys is slow

  it('wires a fallback slot with session vaults', async () => {
    const app = await createApp(cfg({ transport: 'wwebjs', fallbackTransport: 'baileys' }));
    expect(app.supervisor.status().state).toBe('idle');
  });
});

describe('supervisor watchdog & lifecycle', () => {
  it('rebuilds a wedged transport after two failed probes', async () => {
    const t = new FakeTransport(seed());
    const s = new Supervisor(
      [{ name: 'fake', create: () => t }],
      { ...fastResilience, probeIntervalMs: 10 },
      systemClock,
      silentLog,
    );
    s.start();
    await s.waitUntilConnected(1_000);
    t.failNext('probe', new Error('page crashed'), 2);
    await until(() => s.status().reconnects >= 1);
    expect(s.status().recentEvents.some((e) => e.event.includes('watchdog'))).toBe(true);
    await s.stop();
  });

  it('fails back to the primary after the failback window', async () => {
    const primary = new FakeTransport(seed(), 'primary');
    primary.failNext('start', new Error('down'), 2);
    const backup = new FakeTransport(seed(), 'backup');
    const s = new Supervisor(
      [
        { name: 'primary', create: () => primary },
        { name: 'backup', create: () => backup },
      ],
      { ...fastResilience, probeIntervalMs: 10, failbackAfterMs: 20 },
      systemClock,
      silentLog,
    );
    s.start();
    await until(() => s.status().activeTransport === 'backup');
    await until(() => s.status().activeTransport === 'primary' && s.status().state === 'running');
    await s.stop();
  });

  it('handles a logout reported by the transport while running', async () => {
    const t = new FakeTransport(seed());
    const s = new Supervisor(
      [{ name: 'fake', create: () => t }],
      fastResilience,
      systemClock,
      silentLog,
    );
    s.start();
    await s.waitUntilConnected(1_000);
    t.failNext('start', errors.loggedOut(), Infinity);
    t.simulateDisconnect('logged_out');
    await until(() => s.status().state === 'logged_out');
    await s.stop();
  });

  it('logout unlinks the device', async () => {
    const t = new FakeTransport(seed());
    const s = new Supervisor(
      [{ name: 'fake', create: () => t }],
      fastResilience,
      systemClock,
      silentLog,
    );
    s.start();
    await s.waitUntilConnected(1_000);
    await s.logout();
    expect(t.calls.some((c) => c.method === 'logout')).toBe(true);
    expect(s.status().state).toBe('stopped');
  });
});

describe('MCP read tools', () => {
  async function client(transport = new FakeTransport(seed())) {
    const app = await fakeApp({ transports: [transport] });
    const server = createMcpServer(app);
    const [a, b] = InMemoryTransport.createLinkedPair();
    const c = new Client({ name: 't', version: '0' });
    await Promise.all([server.connect(a), c.connect(b)]);
    const call = async (name: string, args: Record<string, unknown> = {}) => {
      const r = await c.callTool({ name, arguments: args });
      return {
        isError: Boolean(r.isError),
        text: (r.content as { text: string }[])[0]?.text ?? '',
      };
    };
    return { app, call, close: () => app.supervisor.stop() };
  }

  it('lists chats, searches, and marks read', async () => {
    const { app, call, close } = await client();
    app.supervisor.start();
    await app.supervisor.waitUntilConnected(1_000);
    expect((await call('whatsapp_list_chats', { limit: 2 })).text).toContain('Family');
    expect(
      (await call('whatsapp_search_messages', { query: 'lunch', chat: 'Alice' })).text,
    ).toContain('lunch tomorrow?');
    expect((await call('whatsapp_search_messages', { query: 'zzz' })).text).toBe('(no messages)');
    expect((await call('whatsapp_search_contacts', { query: 'bob' })).text).toContain('Bob');
    expect((await call('whatsapp_mark_read', { chat: 'Alice' })).text).toBe(
      'Marked Alice as read.',
    );
    expect((await call('whatsapp_login')).text).toContain('Already connected');
    await close();
  });

  it('returns a scannable QR code from whatsapp_login', async () => {
    const t = new FakeTransport(seed());
    t.requireLogin = true;
    const { call, close } = await client(t);
    const r = await call('whatsapp_login');
    expect(r.isError).toBe(false);
    expect(r.text).toContain('Linked devices');
    expect(r.text.split('\n').length).toBeGreaterThan(10); // rendered QR
    await close();
  });

  it('maps unexpected errors to isError results', async () => {
    const t = new FakeTransport(seed());
    const { app, call, close } = await client(t);
    app.supervisor.start();
    await app.supervisor.waitUntilConnected(1_000);
    t.failNext('getMessages', new Error('weird'), Infinity);
    const r = await call('whatsapp_get_messages', { chat: 'Alice' });
    expect(r.isError).toBe(true);
    await close();
  });
});
