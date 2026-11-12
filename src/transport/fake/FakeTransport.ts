import { errors } from '../../domain/errors.js';
import type {
  Chat,
  ChatId,
  ConnectionState,
  Contact,
  Message,
  QrEvent,
  SentMessage,
  TransportInfo,
} from '../../domain/types.js';
import { Emitter } from '../../util/emitter.js';
import type { WhatsAppTransport } from '../transport.js';

type Method = Exclude<keyof WhatsAppTransport, 'name' | 'on' | 'state' | 'info'>;

export interface FakeSeed {
  chats?: Chat[];
  messages?: Message[];
  contacts?: Contact[];
}

/**
 * Deterministic in-memory transport. Used for unit tests, contract tests, and as a demo
 * transport (`WA_BRIDGE_TRANSPORT=fake`). Supports fault injection so resilience logic
 * can be tested without a real WhatsApp account.
 */
export class FakeTransport implements WhatsAppTransport {
  readonly name: string;
  private current: ConnectionState = 'stopped';
  private readonly events = new Emitter<{ state: ConnectionState; qr: QrEvent }>();
  private readonly chats = new Map<ChatId, Chat>();
  private readonly messages: Message[] = [];
  private readonly contacts: Contact[] = [];
  private readonly faults = new Map<Method, { error: Error; remaining: number }>();
  private seq = 0;
  readonly calls: { method: Method; args: unknown[] }[] = [];
  /** When true, start() emits a QR and waits for completeLogin(). */
  requireLogin = false;
  private pendingLogin: (() => void) | null = null;

  constructor(seed: FakeSeed = {}, name = 'fake') {
    this.name = name;
    for (const c of seed.chats ?? []) this.chats.set(c.id, c);
    this.messages.push(...(seed.messages ?? []));
    this.contacts.push(...(seed.contacts ?? []));
  }

  /** Make the next `times` calls of `method` fail with `error` (Infinity = until cleared). */
  failNext(method: Method, error: Error, times = 1): void {
    this.faults.set(method, { error, remaining: times });
  }

  clearFaults(): void {
    this.faults.clear();
  }

  /** Simulate an unexpected disconnect from WhatsApp's side. */
  simulateDisconnect(to: ConnectionState = 'reconnecting'): void {
    this.setState(to);
  }

  completeLogin(): void {
    this.pendingLogin?.();
  }

  /** Simulate an incoming message. */
  receive(msg: Omit<Message, 'id'> & { id?: string }): Message {
    const full: Message = { ...msg, id: msg.id ?? `in-${++this.seq}` };
    this.messages.push(full);
    return full;
  }

  on(event: 'state', listener: (state: ConnectionState) => void): () => void;
  on(event: 'qr', listener: (e: QrEvent) => void): () => void;
  on(
    event: 'state' | 'qr',
    listener: ((s: ConnectionState) => void) | ((e: QrEvent) => void),
  ): () => void {
    return this.events.on(event, listener as never);
  }

  state(): ConnectionState {
    return this.current;
  }

  info(): TransportInfo {
    return { name: this.name, libraryVersion: 'fake-1.0.0', remoteVersion: null };
  }

  async start(): Promise<void> {
    this.enter('start', []);
    this.setState('starting');
    if (this.requireLogin) {
      this.setState('awaiting_qr');
      this.events.emit('qr', { qr: 'FAKE-QR-PAYLOAD' });
      await new Promise<void>((resolve) => (this.pendingLogin = resolve));
      this.requireLogin = false;
    }
    this.setState('connected');
  }

  async stop(): Promise<void> {
    this.enter('stop', []);
    this.setState('stopped');
  }

  async logout(): Promise<void> {
    this.enter('logout', []);
    this.setState('logged_out');
  }

  async probe(): Promise<void> {
    this.enter('probe', []);
    this.assertConnected();
  }

  async listChats(opts: { limit: number; includeArchived: boolean }): Promise<Chat[]> {
    this.enter('listChats', [opts]);
    this.assertConnected();
    return [...this.chats.values()]
      .filter((c) => opts.includeArchived || !c.archived)
      .sort(
        (a, b) =>
          Number(b.pinned) - Number(a.pinned) || (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0),
      )
      .slice(0, opts.limit)
      .map((c) => ({ ...c }));
  }

  async getChat(chatId: ChatId): Promise<Chat> {
    this.enter('getChat', [chatId]);
    this.assertConnected();
    const chat = this.chats.get(chatId);
    if (!chat) throw errors.notFound(`Chat ${chatId}`);
    return { ...chat };
  }

  async getMessages(chatId: ChatId, opts: { limit: number }): Promise<Message[]> {
    this.enter('getMessages', [chatId, opts]);
    this.assertConnected();
    if (!this.chats.has(chatId)) throw errors.notFound(`Chat ${chatId}`);
    return this.messages
      .filter((m) => m.chatId === chatId)
      .sort((a, b) => a.timestamp - b.timestamp)
      .slice(-opts.limit)
      .map((m) => ({ ...m }));
  }

  async searchMessages(
    query: string,
    opts: { chatId?: ChatId; limit: number },
  ): Promise<Message[]> {
    this.enter('searchMessages', [query, opts]);
    this.assertConnected();
    const q = query.toLowerCase();
    return this.messages
      .filter((m) => (!opts.chatId || m.chatId === opts.chatId) && m.text.toLowerCase().includes(q))
      .sort((a, b) => b.timestamp - a.timestamp)
      .slice(0, opts.limit)
      .map((m) => ({ ...m }));
  }

  async searchContacts(query: string, opts: { limit: number }): Promise<Contact[]> {
    this.enter('searchContacts', [query, opts]);
    this.assertConnected();
    const q = query.toLowerCase();
    return this.contacts
      .filter((c) => [c.name, c.pushName, c.phoneNumber].some((v) => v?.toLowerCase().includes(q)))
      .slice(0, opts.limit)
      .map((c) => ({ ...c }));
  }

  async resolvePhoneNumber(phone: string): Promise<ChatId | null> {
    this.enter('resolvePhoneNumber', [phone]);
    this.assertConnected();
    const digits = phone.replace(/\D/g, '');
    const hit = this.contacts.find((c) => c.phoneNumber?.replace(/\D/g, '') === digits);
    return hit ? hit.id : null;
  }

  async sendText(
    chatId: ChatId,
    text: string,
    opts?: { quotedMessageId?: string },
  ): Promise<SentMessage> {
    this.enter('sendText', [chatId, text, opts]);
    this.assertConnected();
    return this.recordOutgoing(chatId, text, 'text', opts?.quotedMessageId ?? null);
  }

  async sendMedia(
    chatId: ChatId,
    filePath: string,
    opts?: { caption?: string },
  ): Promise<SentMessage> {
    this.enter('sendMedia', [chatId, filePath, opts]);
    this.assertConnected();
    return this.recordOutgoing(chatId, opts?.caption ?? '', 'document', null);
  }

  async markRead(chatId: ChatId): Promise<void> {
    this.enter('markRead', [chatId]);
    this.assertConnected();
    const chat = this.chats.get(chatId);
    if (!chat) throw errors.notFound(`Chat ${chatId}`);
    chat.unreadCount = 0;
  }

  /** Messages sent through this transport (test helper). */
  sent(): Message[] {
    return this.messages.filter((m) => m.fromMe);
  }

  private recordOutgoing(
    chatId: ChatId,
    text: string,
    kind: Message['kind'],
    quoted: string | null,
  ) {
    if (!this.chats.has(chatId)) {
      this.chats.set(chatId, {
        id: chatId,
        name: chatId,
        isGroup: chatId.endsWith('@g.us'),
        unreadCount: 0,
        lastActivityAt: null,
        archived: false,
        pinned: false,
        muted: false,
      });
    }
    const msg: Message = {
      id: `out-${++this.seq}`,
      chatId,
      senderId: 'me',
      senderName: null,
      fromMe: true,
      timestamp: Date.now(),
      kind,
      text,
      hasMedia: kind !== 'text',
      quotedMessageId: quoted,
    };
    this.messages.push(msg);
    return { id: msg.id, chatId, timestamp: msg.timestamp };
  }

  private enter(method: Method, args: unknown[]): void {
    this.calls.push({ method, args });
    const fault = this.faults.get(method);
    if (fault && fault.remaining > 0) {
      fault.remaining -= 1;
      if (fault.remaining <= 0) this.faults.delete(method);
      throw fault.error;
    }
  }

  private assertConnected(): void {
    if (this.current === 'logged_out') throw errors.loggedOut();
    if (this.current !== 'connected') throw errors.notConnected(this.current);
  }

  private setState(s: ConnectionState): void {
    if (s === this.current) return;
    this.current = s;
    this.events.emit('state', s);
  }
}
