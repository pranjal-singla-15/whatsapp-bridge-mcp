import { createRequire } from 'node:module';
import { extname, basename, join } from 'node:path';
import makeWASocket, {
  Browsers,
  DisconnectReason,
  fetchLatestBaileysVersion,
  getContentType,
  useMultiFileAuthState,
  type WAMessage,
} from 'baileys';
import { pino } from 'pino';
import { errors } from '../../domain/errors.js';
import type {
  Chat,
  ChatId,
  ConnectionState,
  Contact,
  Message,
  MessageKind,
  QrEvent,
  SentMessage,
  TransportInfo,
} from '../../domain/types.js';
import type { Logger } from '../../logger.js';
import { Emitter } from '../../util/emitter.js';
import type { WhatsAppTransport } from '../transport.js';
import { BaileysStore } from './store.js';

type Socket = ReturnType<typeof makeWASocket>;

export interface BaileysOptions {
  sessionDir: string;
  allowQr: boolean;
  log: Logger;
}

/**
 * Baileys adapter (secondary / fallback transport). Talks the WhatsApp multi-device
 * protocol directly over a websocket — no browser. Ids are normalised to the same
 * `@c.us` form wwebjs uses so failover is transparent to callers.
 */
export class BaileysTransport implements WhatsAppTransport {
  readonly name = 'baileys';
  private sock: Socket | null = null;
  private current: ConnectionState = 'stopped';
  private readonly events = new Emitter<{ state: ConnectionState; qr: QrEvent }>();
  private readonly store: BaileysStore;
  private readonly raw = new Map<string, WAMessage>(); // for quoting / read receipts
  private protocolVersion: string | null = null;

  constructor(private readonly opts: BaileysOptions) {
    this.store = new BaileysStore(join(opts.sessionDir, 'store.json'));
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
    return {
      name: this.name,
      libraryVersion: libraryVersion(),
      remoteVersion: this.protocolVersion,
    };
  }

  async start(): Promise<void> {
    if (this.sock) throw new Error('baileys transport already started');
    this.setState('starting');
    const { state, saveCreds } = await useMultiFileAuthState(join(this.opts.sessionDir, 'auth'));
    const latest = await fetchLatestBaileysVersion().catch(() => null);
    this.protocolVersion = latest?.version.join('.') ?? null;

    // A freshly scanned QR requires one socket restart (code 515) as part of pairing.
    for (let restarts = 0; restarts < 3; restarts++) {
      const outcome = await this.connectOnce(state, saveCreds, latest?.version);
      if (outcome === 'open') {
        this.setState('connected');
        return;
      }
    }
    throw errors.transport('start', 'too many restarts during pairing');
  }

  private connectOnce(
    auth: Awaited<ReturnType<typeof useMultiFileAuthState>>['state'],
    saveCreds: () => Promise<void>,
    version: [number, number, number] | undefined,
  ): Promise<'open' | 'restart'> {
    const sock = makeWASocket({
      auth,
      ...(version ? { version } : {}),
      browser: Browsers.appropriate('Desktop'),
      logger: pino({ level: 'silent' }),
      markOnlineOnConnect: false, // do not suppress the user's phone notifications
      syncFullHistory: false,
    });
    this.sock = sock;
    sock.ev.on('creds.update', () => void saveCreds());
    this.bindStore(sock);

    return new Promise((resolve, reject) => {
      let opened = false;
      sock.ev.on('connection.update', (u) => {
        if (u.qr) {
          if (!this.opts.allowQr) {
            void sock.end(undefined);
            reject(errors.loggedOut());
            return;
          }
          this.setState('awaiting_qr');
          this.events.emit('qr', { qr: u.qr });
        }
        if (u.connection === 'open') {
          opened = true;
          resolve('open');
        }
        if (u.connection === 'close') {
          const code = (u.lastDisconnect?.error as { output?: { statusCode?: number } } | undefined)
            ?.output?.statusCode;
          this.sock = null;
          if (code === DisconnectReason.loggedOut) {
            this.setState('logged_out');
            if (!opened) reject(errors.loggedOut());
          } else if (!opened && code === DisconnectReason.restartRequired) {
            resolve('restart');
          } else if (!opened) {
            this.setState('failed');
            reject(errors.transport('start', `connection closed (${code ?? 'unknown'})`));
          } else {
            this.opts.log.warn('baileys connection closed', { code });
            this.setState('reconnecting');
          }
        }
      });
    });
  }

  async stop(): Promise<void> {
    const s = this.sock;
    this.sock = null;
    this.setState('stopped');
    if (s) await s.end(undefined).catch(() => undefined);
    try {
      this.store.flush();
    } catch {
      /* ignore */
    }
  }

  async logout(): Promise<void> {
    await this.sock?.logout().catch(() => undefined);
    this.sock = null;
    this.setState('logged_out');
  }

  async probe(): Promise<void> {
    const s = this.requireSock();
    const ws = s.ws as unknown as { isOpen?: boolean };
    if (ws.isOpen === false) throw errors.transport('probe', 'websocket is not open');
    if (!s.user) throw errors.transport('probe', 'no authenticated user');
  }

  async listChats(opts: { limit: number; includeArchived: boolean }): Promise<Chat[]> {
    this.requireSock();
    return [...this.store.chats.values()]
      .filter((c) => opts.includeArchived || !c.archived)
      .sort(
        (a, b) =>
          Number(b.pinned) - Number(a.pinned) || (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0),
      )
      .slice(0, opts.limit)
      .map((c) => ({ ...c }));
  }

  async getChat(chatId: ChatId): Promise<Chat> {
    this.requireSock();
    const c = this.store.chats.get(chatId);
    if (!c) throw errors.notFound(`Chat ${chatId}`);
    return { ...c };
  }

  async getMessages(chatId: ChatId, opts: { limit: number }): Promise<Message[]> {
    await this.getChat(chatId);
    return this.store.messagesFor(chatId).slice(-opts.limit);
  }

  async searchMessages(
    query: string,
    opts: { chatId?: ChatId; limit: number },
  ): Promise<Message[]> {
    this.requireSock();
    const q = query.toLowerCase();
    const pool = opts.chatId ? this.store.messagesFor(opts.chatId) : this.store.allMessages();
    return pool
      .filter((m) => m.text.toLowerCase().includes(q))
      .sort((a, b) => b.timestamp - a.timestamp)
      .slice(0, opts.limit);
  }

  async searchContacts(query: string, opts: { limit: number }): Promise<Contact[]> {
    this.requireSock();
    const q = query.toLowerCase();
    return [...this.store.contacts.values()]
      .filter((c) => !c.id.endsWith('@g.us'))
      .filter((c) => [c.name, c.pushName, c.phoneNumber].some((v) => v?.toLowerCase().includes(q)))
      .sort((a, b) => Number(b.isMyContact) - Number(a.isMyContact))
      .slice(0, opts.limit);
  }

  async resolvePhoneNumber(phone: string): Promise<ChatId | null> {
    const res = await this.requireSock().onWhatsApp(phone.replace(/\D/g, ''));
    const hit = res?.find((r) => r.exists);
    return hit ? toDomainJid(hit.jid) : null;
  }

  async sendText(
    chatId: ChatId,
    text: string,
    opts?: { quotedMessageId?: string },
  ): Promise<SentMessage> {
    const quoted = opts?.quotedMessageId ? this.raw.get(opts.quotedMessageId) : undefined;
    const m = await this.requireSock().sendMessage(
      toWireJid(chatId),
      { text },
      quoted ? { quoted } : {},
    );
    return this.sentResult(m, chatId);
  }

  async sendMedia(
    chatId: ChatId,
    filePath: string,
    opts?: { caption?: string },
  ): Promise<SentMessage> {
    const ext = extname(filePath).toLowerCase();
    const url = { url: filePath };
    const caption = opts?.caption;
    const content = ['.jpg', '.jpeg', '.png', '.webp'].includes(ext)
      ? { image: url, ...(caption ? { caption } : {}) }
      : ['.mp4', '.mov', '.3gp'].includes(ext)
        ? { video: url, ...(caption ? { caption } : {}) }
        : ['.mp3', '.ogg', '.m4a', '.opus', '.aac'].includes(ext)
          ? { audio: url, mimetype: ext === '.mp3' ? 'audio/mpeg' : 'audio/ogg' }
          : {
              document: url,
              fileName: basename(filePath),
              mimetype: 'application/octet-stream',
              ...(caption ? { caption } : {}),
            };
    const m = await this.requireSock().sendMessage(toWireJid(chatId), content);
    return this.sentResult(m, chatId);
  }

  async markRead(chatId: ChatId): Promise<void> {
    const chat = await this.getChat(chatId);
    const keys = this.store
      .messagesFor(chatId)
      .filter((m) => !m.fromMe)
      .slice(-Math.max(1, chat.unreadCount))
      .map((m) => this.raw.get(m.id)?.key)
      .filter((k): k is NonNullable<typeof k> => Boolean(k));
    if (keys.length) await this.requireSock().readMessages(keys);
    this.store.upsertChat({ id: chatId, unreadCount: 0 });
  }

  // ---------------------------------------------------------------- internals

  private bindStore(sock: Socket): void {
    sock.ev.on('messaging-history.set', ({ chats, contacts, messages }) => {
      for (const c of chats) this.ingestChat(c);
      for (const c of contacts) this.ingestContact(c);
      for (const m of messages) this.ingestMessage(m);
    });
    sock.ev.on('chats.upsert', (chats) => chats.forEach((c) => this.ingestChat(c)));
    sock.ev.on('chats.update', (chats) => chats.forEach((c) => c.id && this.ingestChat(c)));
    sock.ev.on('contacts.upsert', (cs) => cs.forEach((c) => this.ingestContact(c)));
    sock.ev.on('contacts.update', (cs) =>
      cs.forEach((c) => c.id && this.ingestContact(c as { id: string })),
    );
    sock.ev.on('messages.upsert', ({ messages }) => messages.forEach((m) => this.ingestMessage(m)));
  }

  private ingestChat(c: {
    id?: string | null;
    name?: string | null;
    unreadCount?: number | null;
    archived?: boolean | null;
    pinned?: number | null;
    muteEndTime?: unknown;
    conversationTimestamp?: unknown;
  }): void {
    if (!c.id || c.id === 'status@broadcast') return;
    const ts = toNumber(c.conversationTimestamp);
    this.store.upsertChat({
      id: toDomainJid(c.id),
      ...(c.name ? { name: c.name } : {}),
      ...(typeof c.unreadCount === 'number' ? { unreadCount: Math.max(0, c.unreadCount) } : {}),
      ...(typeof c.archived === 'boolean' ? { archived: c.archived } : {}),
      ...(c.pinned !== undefined ? { pinned: Boolean(c.pinned) } : {}),
      ...(c.muteEndTime !== undefined
        ? { muted: toNumber(c.muteEndTime) > Date.now() / 1000 }
        : {}),
      ...(ts ? { lastActivityAt: ts * 1000 } : {}),
    });
  }

  private ingestContact(c: {
    id: string;
    name?: string;
    notify?: string;
    phoneNumber?: string;
  }): void {
    const id = toDomainJid(c.id);
    this.store.upsertContact({
      id,
      ...(c.name ? { name: c.name, isMyContact: true } : {}),
      ...(c.notify ? { pushName: c.notify } : {}),
      ...(c.phoneNumber ? { phoneNumber: c.phoneNumber.split('@')[0] ?? null } : {}),
    });
  }

  private ingestMessage(m: WAMessage): void {
    const jid = m.key.remoteJid;
    if (!jid || jid === 'status@broadcast' || !m.message || !m.key.id) return;
    const content = m.message;
    const type = getContentType(content);
    const chatId = toDomainJid(jid);
    const text =
      content.conversation ??
      content.extendedTextMessage?.text ??
      content.imageMessage?.caption ??
      content.videoMessage?.caption ??
      content.documentMessage?.caption ??
      '';
    const msg: Message = {
      id: m.key.id,
      chatId,
      senderId: m.key.fromMe ? 'me' : toDomainJid(m.key.participant ?? jid),
      senderName: m.key.fromMe ? null : (m.pushName ?? null),
      fromMe: Boolean(m.key.fromMe),
      timestamp: toNumber(m.messageTimestamp) * 1000,
      kind: kindOf(type),
      text,
      hasMedia: ['image', 'video', 'audio', 'document', 'sticker'].includes(kindOf(type)),
      quotedMessageId: content.extendedTextMessage?.contextInfo?.stanzaId ?? null,
    };
    this.raw.set(msg.id, m);
    if (this.raw.size > 5000) this.raw.delete(this.raw.keys().next().value!);
    this.store.addMessage(msg);
  }

  private sentResult(m: WAMessage | undefined, chatId: ChatId): SentMessage {
    if (!m?.key.id) throw errors.transport('send', 'WhatsApp did not return a message id');
    this.ingestMessage(m);
    return { id: m.key.id, chatId, timestamp: toNumber(m.messageTimestamp) * 1000 || Date.now() };
  }

  private requireSock(): Socket {
    if (this.current === 'logged_out') throw errors.loggedOut();
    if (!this.sock || this.current !== 'connected') throw errors.notConnected(this.current);
    return this.sock;
  }

  private setState(s: ConnectionState): void {
    if (s === this.current) return;
    this.current = s;
    this.events.emit('state', s);
  }
}

/** Baileys uses `@s.whatsapp.net`; our domain uses the wwebjs-style `@c.us`. */
export function toDomainJid(jid: string): string {
  const bare = jid.replace(/:\d+(?=@)/, ''); // strip device suffix
  return bare.endsWith('@s.whatsapp.net') ? bare.replace('@s.whatsapp.net', '@c.us') : bare;
}

export function toWireJid(id: string): string {
  return id.endsWith('@c.us') ? id.replace('@c.us', '@s.whatsapp.net') : id;
}

function toNumber(v: unknown): number {
  if (typeof v === 'number') return v;
  if (typeof v === 'bigint') return Number(v);
  if (v && typeof v === 'object' && 'toNumber' in v && typeof v.toNumber === 'function') {
    return (v as { toNumber(): number }).toNumber();
  }
  if (typeof v === 'string') return Number(v) || 0;
  return 0;
}

function kindOf(type: string | undefined): MessageKind {
  switch (type) {
    case 'conversation':
    case 'extendedTextMessage':
      return 'text';
    case 'imageMessage':
      return 'image';
    case 'videoMessage':
      return 'video';
    case 'audioMessage':
      return 'audio';
    case 'documentMessage':
    case 'documentWithCaptionMessage':
      return 'document';
    case 'stickerMessage':
      return 'sticker';
    case 'locationMessage':
    case 'liveLocationMessage':
      return 'location';
    case 'contactMessage':
    case 'contactsArrayMessage':
      return 'contact';
    default:
      return 'other';
  }
}

function libraryVersion(): string {
  try {
    return (createRequire(import.meta.url)('baileys/package.json') as { version: string }).version;
  } catch {
    return 'unknown';
  }
}
