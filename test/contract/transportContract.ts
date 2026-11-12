import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isBridgeError } from '../../src/domain/errors.js';
import type { WhatsAppTransport } from '../../src/transport/transport.js';

export interface ContractFixture {
  transport: WhatsAppTransport;
  /** A chat that exists and has at least one message. */
  knownChatId: string;
  /** A substring of some message text in knownChatId. */
  knownText: string;
  /** A substring of some contact's name. */
  knownContactQuery: string;
  /** A chat id that does not exist. */
  missingChatId: string;
  /** Run sending checks (only against test accounts!). */
  allowSend: boolean;
}

/**
 * Behavioural contract every WhatsAppTransport must satisfy. Run against the fake in
 * unit tests, and against real transports with a live test account (`CONTRACT_LIVE=1`).
 * This is what lets a repaired or alternative transport be swapped in safely.
 */
export function transportContract(name: string, makeFixture: () => Promise<ContractFixture>): void {
  describe(`WhatsAppTransport contract: ${name}`, () => {
    let fx: ContractFixture;

    beforeEach(async () => {
      fx = await makeFixture();
    });
    afterEach(async () => {
      await fx.transport.stop();
    });

    it('rejects calls with NOT_CONNECTED before start', async () => {
      const err = await fx.transport
        .listChats({ limit: 1, includeArchived: false })
        .catch((e: unknown) => e);
      expect(isBridgeError(err, 'NOT_CONNECTED')).toBe(true);
    });

    it('reaches connected state and emits state events', async () => {
      const states: string[] = [];
      fx.transport.on('state', (s) => states.push(s));
      await fx.transport.start();
      expect(fx.transport.state()).toBe('connected');
      expect(states).toContain('connected');
      await fx.transport.probe();
    });

    it('returns domain-shaped chats respecting limit', async () => {
      await fx.transport.start();
      const chats = await fx.transport.listChats({ limit: 2, includeArchived: true });
      expect(chats.length).toBeLessThanOrEqual(2);
      for (const c of chats) {
        expect(typeof c.id).toBe('string');
        expect(typeof c.name).toBe('string');
        expect(typeof c.isGroup).toBe('boolean');
        expect(typeof c.unreadCount).toBe('number');
      }
    });

    it('returns messages oldest-first with millisecond timestamps', async () => {
      await fx.transport.start();
      const msgs = await fx.transport.getMessages(fx.knownChatId, { limit: 10 });
      expect(msgs.length).toBeGreaterThan(0);
      for (let i = 1; i < msgs.length; i++) {
        expect(msgs[i]!.timestamp).toBeGreaterThanOrEqual(msgs[i - 1]!.timestamp);
      }
      expect(msgs[0]!.timestamp).toBeGreaterThan(0);
      expect(msgs.every((m) => m.chatId === fx.knownChatId)).toBe(true);
    });

    it('rejects unknown chats with NOT_FOUND', async () => {
      await fx.transport.start();
      const err = await fx.transport.getChat(fx.missingChatId).catch((e: unknown) => e);
      expect(isBridgeError(err, 'NOT_FOUND')).toBe(true);
    });

    it('finds messages and contacts', async () => {
      await fx.transport.start();
      const found = await fx.transport.searchMessages(fx.knownText, { limit: 5 });
      expect(found.some((m) => m.text.toLowerCase().includes(fx.knownText.toLowerCase()))).toBe(
        true,
      );
      const contacts = await fx.transport.searchContacts(fx.knownContactQuery, { limit: 5 });
      expect(contacts.length).toBeGreaterThan(0);
    });

    it('sends text and the message becomes readable', async () => {
      if (!fx.allowSend) return;
      await fx.transport.start();
      const text = `contract ${Date.now()}`;
      const sent = await fx.transport.sendText(fx.knownChatId, text);
      expect(sent.chatId).toBe(fx.knownChatId);
      const msgs = await fx.transport.getMessages(fx.knownChatId, { limit: 20 });
      expect(msgs.some((m) => m.fromMe && m.text === text)).toBe(true);
    });

    it('stops cleanly', async () => {
      await fx.transport.start();
      await fx.transport.stop();
      expect(fx.transport.state()).toBe('stopped');
    });
  });
}
