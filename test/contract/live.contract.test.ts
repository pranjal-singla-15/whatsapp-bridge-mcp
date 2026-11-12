import { describe, it } from 'vitest';
import { transportFactoryFor } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';
import { createLogger } from '../../src/logger.js';
import { transportContract } from './transportContract.js';

/**
 * Runs the transport contract against a REAL WhatsApp session (test number only).
 * Enabled with CONTRACT_LIVE=1 plus:
 *   WA_BRIDGE_PROFILE, WA_BRIDGE_TRANSPORT, CONTRACT_CHAT_ID, CONTRACT_TEXT, CONTRACT_CONTACT
 */
const live = process.env.CONTRACT_LIVE === '1';

if (live) {
  transportContract(`live ${process.env.WA_BRIDGE_TRANSPORT ?? 'wwebjs'}`, async () => {
    const config = loadConfig();
    const factory = await transportFactoryFor(config.transport, config, createLogger('warn'));
    return {
      transport: factory(config.transport, { interactive: false }),
      knownChatId: process.env.CONTRACT_CHAT_ID ?? '',
      knownText: process.env.CONTRACT_TEXT ?? 'canary',
      knownContactQuery: process.env.CONTRACT_CONTACT ?? 'a',
      missingChatId: '1000000000000@c.us',
      allowSend: process.env.CONTRACT_ALLOW_SEND === '1',
    };
  });
} else {
  describe.skip('live transport contract (set CONTRACT_LIVE=1)', () => {
    it('skipped', () => undefined);
  });
}
