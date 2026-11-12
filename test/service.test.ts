import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { BridgeError, isBridgeError } from '../src/domain/errors.js';
import { FakeTransport } from '../src/transport/fake/FakeTransport.js';
import { fakeApp, manualClock, seed } from './helpers.js';

async function connected(opts: Parameters<typeof fakeApp>[0] = {}) {
  const app = await fakeApp(opts);
  app.supervisor.start();
  await app.supervisor.waitUntilConnected(1_000);
  return app;
}

const code = (p: Promise<unknown>) =>
  p.then(
    () => 'ok',
    (e: unknown) => (isBridgeError(e) ? e.code : String(e)),
  );

describe('reads', () => {
  it('lists chats pinned-first, hides archived, filters unread', async () => {
    const { service, supervisor } = await connected();
    const all = await service.listChats({ limit: 10, includeArchived: false, unreadOnly: false });
    expect(all.map((c) => c.name)).toEqual(['Family', 'Alice', 'Bob']);
    const unread = await service.listChats({ limit: 10, includeArchived: false, unreadOnly: true });
    expect(unread.map((c) => c.name)).toEqual(['Alice']);
    await supervisor.stop();
  });

  it('reads messages by name, id or phone number', async () => {
    const { service, supervisor } = await connected();
    expect((await service.getMessages('alice', 10)).messages).toHaveLength(2);
    expect((await service.getMessages('9111111111@c.us', 10)).chat.name).toBe('Alice');
    expect((await service.getMessages('+9111111111', 10)).chat.chatId).toBe('9111111111@c.us');
    await supervisor.stop();
  });

  it('rejects ambiguous names with the candidate list', async () => {
    const { service, supervisor } = await connected();
    const err = await service.resolveRecipient('bob').catch((e: unknown) => e);
    // exact match "Bob" wins over "Bobby Tables"
    expect(err).toMatchObject({ chatId: '9222222222@c.us' });
    const amb = await service.resolveRecipient('b').catch((e: unknown) => e as BridgeError);
    expect(isBridgeError(amb, 'INVALID_INPUT')).toBe(true);
    expect((amb as BridgeError).message).toContain('Bobby Tables');
    await supervisor.stop();
  });

  it('reports NOT_FOUND for unknown recipients', async () => {
    const { service, supervisor } = await connected();
    expect(await code(service.resolveRecipient('nobody-like-this'))).toBe('NOT_FOUND');
    await supervisor.stop();
  });

  it('rejects empty queries', async () => {
    const { service, supervisor } = await connected();
    expect(await code(service.searchMessages('  ', { limit: 5 }))).toBe('INVALID_INPUT');
    expect(await code(service.searchContacts('', 5))).toBe('INVALID_INPUT');
    await supervisor.stop();
  });
});

describe('send safety', () => {
  it('is blocked entirely when sending is disabled', async () => {
    const { service, supervisor } = await connected({ send: { enabled: false } });
    expect(await code(service.prepareSend({ to: 'Alice', text: 'hi' }))).toBe('SEND_DISABLED');
    await supervisor.stop();
  });

  it('requires confirmation and sends only after confirm', async () => {
    const { service, supervisor, transports } = await connected();
    const prep = await service.prepareSend({ to: 'Alice', text: 'hello' });
    expect(prep.status).toBe('pending_confirmation');
    expect(transports[0]!.sent()).toHaveLength(0);
    if (prep.status !== 'pending_confirmation') throw new Error('unreachable');
    expect(prep.preview).toMatchObject({ to: 'Alice', chatId: '9111111111@c.us', text: 'hello' });

    const done = await service.confirmSend(prep.confirmationToken);
    expect(done.status).toBe('sent');
    expect(transports[0]!.sent().map((m) => m.text)).toEqual(['hello']);
    await supervisor.stop();
  });

  it('never sends twice for the same token (idempotent confirm)', async () => {
    const { service, supervisor, transports } = await connected();
    const prep = await service.prepareSend({ to: 'Alice', text: 'once' });
    if (prep.status !== 'pending_confirmation') throw new Error('unreachable');
    const a = await service.confirmSend(prep.confirmationToken);
    const b = await service.confirmSend(prep.confirmationToken);
    expect(a).toEqual(b);
    expect(transports[0]!.sent()).toHaveLength(1);
    await supervisor.stop();
  });

  it('rejects unknown and expired tokens', async () => {
    const clock = manualClock();
    const { service, supervisor } = await connected({ clock });
    expect(await code(service.confirmSend('00000000-0000-4000-8000-000000000000'))).toBe(
      'CONFIRMATION_INVALID',
    );
    const prep = await service.prepareSend({ to: 'Alice', text: 'late' });
    if (prep.status !== 'pending_confirmation') throw new Error('unreachable');
    clock.advance(301_000);
    expect(await code(service.confirmSend(prep.confirmationToken))).toBe('CONFIRMATION_INVALID');
    await supervisor.stop();
  });

  it('blocks cold messaging to numbers you never chatted with', async () => {
    const { service, supervisor } = await connected();
    expect(await code(service.prepareSend({ to: '9444444444@c.us', text: 'hi' }))).toBe(
      'RECIPIENT_NOT_ALLOWED',
    );
    expect(await code(service.prepareSend({ to: '+9444444444', text: 'hi' }))).toBe(
      'RECIPIENT_NOT_ALLOWED',
    );
    // a saved contact without history is allowed
    expect((await service.prepareSend({ to: '+9555555555', text: 'hi' })).status).toBe(
      'pending_confirmation',
    );
    await supervisor.stop();
  });

  it('allows unknown recipients only when explicitly configured', async () => {
    const { service, supervisor } = await connected({ send: { allowUnknownRecipients: true } });
    expect((await service.prepareSend({ to: '9444444444@c.us', text: 'hi' })).status).toBe(
      'pending_confirmation',
    );
    await supervisor.stop();
  });

  it('enforces rate limits', async () => {
    const { service, supervisor } = await connected({
      send: { requireConfirmation: false, maxPerMinute: 2 },
    });
    await service.prepareSend({ to: 'Alice', text: '1' });
    await service.prepareSend({ to: 'Alice', text: '2' });
    expect(await code(service.prepareSend({ to: 'Alice', text: '3' }))).toBe('RATE_LIMITED');
    await supervisor.stop();
  });

  it('validates content', async () => {
    const { service, supervisor } = await connected({ send: { maxTextLength: 5 } });
    expect(await code(service.prepareSend({ to: 'Alice' }))).toBe('INVALID_INPUT');
    expect(await code(service.prepareSend({ to: 'Alice', text: 'too long text' }))).toBe(
      'INVALID_INPUT',
    );
    expect(await code(service.prepareSend({ to: 'Alice', filePath: 'relative.txt' }))).toBe(
      'INVALID_INPUT',
    );
    expect(
      await code(service.prepareSend({ to: 'Alice', filePath: join(tmpdir(), 'missing-xyz.bin') })),
    ).toBe('INVALID_INPUT');
    await supervisor.stop();
  });

  it('sends files', async () => {
    const file = join(tmpdir(), `wa-bridge-test-${Date.now()}.txt`);
    writeFileSync(file, 'x');
    const { service, supervisor, transports } = await connected({
      send: { requireConfirmation: false },
    });
    const res = await service.prepareSend({ to: 'Alice', filePath: file, text: 'cap' });
    expect(res.status).toBe('sent');
    expect(transports[0]!.calls.some((c) => c.method === 'sendMedia')).toBe(true);
    await supervisor.stop();
  });
});

describe('send failure reconciliation (no duplicates)', () => {
  it('reports success when a timed-out send was actually delivered', async () => {
    const t = new FakeTransport(seed());
    const { service, supervisor } = await connected({
      transports: [t],
      send: { requireConfirmation: false },
    });
    // Simulate: WhatsApp delivered the message but the call errored.
    const original = t.sendText.bind(t);
    t.sendText = async (chatId, text, o) => {
      await original(chatId, text, o);
      throw new BridgeError('TIMEOUT', 'simulated timeout', { retryable: true });
    };
    const res = await service.prepareSend({ to: 'Alice', text: 'maybe' });
    expect(res).toMatchObject({ status: 'sent', verifiedAfterError: true });
    expect(t.sent()).toHaveLength(1);
    await supervisor.stop();
  });

  it('allows a safe retry when the message is verifiably not in the chat', async () => {
    const t = new FakeTransport(seed());
    const { service, supervisor } = await connected({ transports: [t] });
    const prep = await service.prepareSend({ to: 'Alice', text: 'retry me' });
    if (prep.status !== 'pending_confirmation') throw new Error('unreachable');
    t.failNext('sendText', new Error('socket hang up'));
    const err = (await service
      .confirmSend(prep.confirmationToken)
      .catch((e: unknown) => e)) as BridgeError;
    expect(err.message).toContain('safe to retry');
    const ok = await service.confirmSend(prep.confirmationToken);
    expect(ok.status).toBe('sent');
    expect(t.sent()).toHaveLength(1);
    await supervisor.stop();
  });

  it('blocks re-confirmation when delivery cannot be verified', async () => {
    const t = new FakeTransport(seed());
    const { service, supervisor } = await connected({ transports: [t] });
    const prep = await service.prepareSend({ to: 'Alice', text: 'unknown fate' });
    if (prep.status !== 'pending_confirmation') throw new Error('unreachable');
    t.failNext('sendText', new Error('boom'));
    t.failNext('getMessages', new Error('also boom'), 2);
    const err = (await service
      .confirmSend(prep.confirmationToken)
      .catch((e: unknown) => e)) as BridgeError;
    expect(err.message).toContain('could not be verified');
    expect(await code(service.confirmSend(prep.confirmationToken))).toBe('CONFIRMATION_INVALID');
    await supervisor.stop();
  });
});
