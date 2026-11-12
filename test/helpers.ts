import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp, type App } from '../src/app.js';
import { defaultConfig, type Config } from '../src/config.js';
import type { SupervisorOptions } from '../src/core/supervisor.js';
import type { Chat, Contact, Message } from '../src/domain/types.js';
import { createLogger } from '../src/logger.js';
import { FakeTransport, type FakeSeed } from '../src/transport/fake/FakeTransport.js';
import type { Clock } from '../src/util/time.js';

export const silentLog = createLogger('silent');

/** Manually advanced clock; sleep() resolves immediately but advances time. */
export function manualClock(start = 1_700_000_000_000): Clock & { advance(ms: number): void } {
  let t = start;
  return {
    now: () => t,
    sleep: async (ms) => {
      t += ms;
    },
    advance: (ms) => {
      t += ms;
    },
  };
}

export const fastResilience: SupervisorOptions = {
  opTimeoutMs: 2_000,
  startTimeoutMs: 2_000,
  probeIntervalMs: 60_000,
  reconnectBaseMs: 5,
  reconnectMaxMs: 20,
  failoverAfter: 2,
  breakerThreshold: 3,
  breakerCooldownMs: 60_000,
};

export function chat(id: string, name: string, extra: Partial<Chat> = {}): Chat {
  return {
    id,
    name,
    isGroup: id.endsWith('@g.us'),
    unreadCount: 0,
    lastActivityAt: 1_000,
    archived: false,
    pinned: false,
    muted: false,
    ...extra,
  };
}

export function msg(
  id: string,
  chatId: string,
  text: string,
  extra: Partial<Message> = {},
): Message {
  return {
    id,
    chatId,
    senderId: chatId,
    senderName: 'Someone',
    fromMe: false,
    timestamp: 1_000,
    kind: 'text',
    text,
    hasMedia: false,
    quotedMessageId: null,
    ...extra,
  };
}

export function contact(id: string, name: string, extra: Partial<Contact> = {}): Contact {
  return {
    id,
    name,
    pushName: name,
    phoneNumber: id.split('@')[0] ?? null,
    isMyContact: true,
    isBusiness: false,
    ...extra,
  };
}

export function seed(): FakeSeed {
  return {
    chats: [
      chat('9111111111@c.us', 'Alice', { unreadCount: 2, lastActivityAt: 3_000 }),
      chat('9222222222@c.us', 'Bob', { lastActivityAt: 2_000 }),
      chat('9333333333@c.us', 'Bobby Tables', { lastActivityAt: 1_000, archived: true }),
      chat('999@g.us', 'Family', { pinned: true, lastActivityAt: 500 }),
    ],
    messages: [
      msg('m1', '9111111111@c.us', 'lunch tomorrow?', { timestamp: 2_000 }),
      msg('m2', '9111111111@c.us', 'I can do 1pm', { timestamp: 3_000 }),
      msg('m3', '9222222222@c.us', 'see the report', { timestamp: 2_000 }),
    ],
    contacts: [
      contact('9111111111@c.us', 'Alice'),
      contact('9222222222@c.us', 'Bob'),
      contact('9444444444@c.us', 'Stranger', { isMyContact: false }),
      contact('9555555555@c.us', 'Saved But Never Chatted'),
    ],
  };
}

export async function fakeApp(
  overrides: { send?: Partial<Config['send']>; clock?: Clock; transports?: FakeTransport[] } = {},
): Promise<App & { transports: FakeTransport[] }> {
  const base = defaultConfig();
  const config: Config = {
    ...base,
    dataDir: mkdtempSync(join(tmpdir(), 'wa-bridge-test-')),
    transport: 'fake',
    resilience: { ...base.resilience, ...fastResilience },
    send: { ...base.send, enabled: true, minDelayMs: 0, maxDelayMs: 0, ...overrides.send },
  };
  const transports = overrides.transports ?? [new FakeTransport(seed())];
  let i = 0;
  const app = await createApp(config, {
    log: silentLog,
    ...(overrides.clock ? { clock: overrides.clock } : {}),
    transportFactory: () => transports[Math.min(i++, transports.length - 1)]!,
  });
  return { ...app, transports };
}

export async function until(cond: () => boolean, timeoutMs = 2_000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('condition not met in time');
    await new Promise((r) => setTimeout(r, 5));
  }
}
