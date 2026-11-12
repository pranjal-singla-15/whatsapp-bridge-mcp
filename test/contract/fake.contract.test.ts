import { FakeTransport } from '../../src/transport/fake/FakeTransport.js';
import { seed } from '../helpers.js';
import { transportContract } from './transportContract.js';

transportContract('FakeTransport', async () => ({
  transport: new FakeTransport(seed()),
  knownChatId: '9111111111@c.us',
  knownText: 'lunch',
  knownContactQuery: 'ali',
  missingChatId: '000@c.us',
  allowSend: true,
}));
