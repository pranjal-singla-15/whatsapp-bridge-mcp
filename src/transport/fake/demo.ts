import { FakeTransport } from './FakeTransport.js';

/** Demo data for `WA_BRIDGE_TRANSPORT=fake`: try every tool without a WhatsApp account. */
export function createDemoTransport(): FakeTransport {
  const now = Date.now();
  const min = 60_000;
  return new FakeTransport(
    {
      chats: [
        {
          id: '15550000001@c.us',
          name: 'Alice (demo)',
          isGroup: false,
          unreadCount: 2,
          lastActivityAt: now - 5 * min,
          archived: false,
          pinned: true,
          muted: false,
        },
        {
          id: '15550000002@c.us',
          name: 'Bob (demo)',
          isGroup: false,
          unreadCount: 0,
          lastActivityAt: now - 60 * min,
          archived: false,
          pinned: false,
          muted: false,
        },
        {
          id: '120363000000000001@g.us',
          name: 'Weekend Trip (demo)',
          isGroup: true,
          unreadCount: 5,
          lastActivityAt: now - 2 * min,
          archived: false,
          pinned: false,
          muted: true,
        },
      ],
      messages: [
        {
          id: 'd1',
          chatId: '15550000001@c.us',
          senderId: '15550000001@c.us',
          senderName: 'Alice',
          fromMe: false,
          timestamp: now - 10 * min,
          kind: 'text',
          text: 'Are we still on for lunch tomorrow?',
          hasMedia: false,
          quotedMessageId: null,
        },
        {
          id: 'd2',
          chatId: '15550000001@c.us',
          senderId: '15550000001@c.us',
          senderName: 'Alice',
          fromMe: false,
          timestamp: now - 5 * min,
          kind: 'text',
          text: 'I can do 1pm.',
          hasMedia: false,
          quotedMessageId: null,
        },
        {
          id: 'd3',
          chatId: '15550000002@c.us',
          senderId: 'me',
          senderName: null,
          fromMe: true,
          timestamp: now - 60 * min,
          kind: 'text',
          text: 'Sent you the report.',
          hasMedia: false,
          quotedMessageId: null,
        },
        {
          id: 'd4',
          chatId: '120363000000000001@g.us',
          senderId: '15550000002@c.us',
          senderName: 'Bob',
          fromMe: false,
          timestamp: now - 2 * min,
          kind: 'text',
          text: 'Booked the cabin for Saturday!',
          hasMedia: false,
          quotedMessageId: null,
        },
      ],
      contacts: [
        {
          id: '15550000001@c.us',
          name: 'Alice',
          pushName: 'Alice',
          phoneNumber: '15550000001',
          isMyContact: true,
          isBusiness: false,
        },
        {
          id: '15550000002@c.us',
          name: 'Bob',
          pushName: 'Bobby',
          phoneNumber: '15550000002',
          isMyContact: true,
          isBusiness: false,
        },
      ],
    },
    'fake-demo',
  );
}
