import { createRequire } from 'node:module';
import wwebjs from 'whatsapp-web.js';
import type {
  Chat as WChat,
  Client as WClient,
  Contact as WContact,
  Message as WMessage,
} from 'whatsapp-web.js';
import { BridgeError, describe, errors } from '../../domain/errors.js';
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
import { findBrowser } from './browser.js';
import type { VersionSelector, WebVersion } from './versionSelector.js';

const { Client, LocalAuth, MessageMedia } = wwebjs;

const REMOTE_VERSION_URL =
  'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/{version}.html';

/** WhatsApp states meaning the account itself is blocked; retrying will not help. */
const BLOCKED_STATES = new Set(['TOS_BLOCK', 'SMB_TOS_BLOCK', 'PROXYBLOCK']);

export interface WwebjsOptions {
  sessionDir: string;
  /** If false, needing a QR scan is treated as "logged out" instead of waiting for a scan. */
  allowQr: boolean;
  headful: boolean;
  browserPath: string | null;
  versions: VersionSelector;
  log: Logger;
}

/**
 * whatsapp-web.js adapter: drives the genuine WhatsApp Web client in a headless browser.
 * All library-specific knowledge lives in this file; everything returned is a domain object.
 */
export class WwebjsTransport implements WhatsAppTransport {
  readonly name = 'wwebjs';
  private client: WClient | null = null;
  private current: ConnectionState = 'stopped';
  private readonly events = new Emitter<{ state: ConnectionState; qr: QrEvent }>();
  private webVersion: WebVersion = null;
  private remoteVersion: string | null = null;

  constructor(private readonly opts: WwebjsOptions) {}

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
    return { name: this.name, libraryVersion: libraryVersion(), remoteVersion: this.remoteVersion };
  }

  async start(): Promise<void> {
    if (this.client) throw new Error('wwebjs transport already started');
    this.setState('starting');
    this.webVersion = this.opts.versions.current();
    const log = this.opts.log.child({ webVersion: this.webVersion ?? 'live' });

    const client = new Client({
      authStrategy: new LocalAuth({ dataPath: this.opts.sessionDir }),
      ...(this.webVersion
        ? {
            webVersion: this.webVersion,
            webVersionCache: { type: 'remote', remotePath: REMOTE_VERSION_URL, strict: false },
          }
        : { webVersionCache: { type: 'none' } }),
      takeoverOnConflict: false,
      puppeteer: {
        headless: !this.opts.headful,
        executablePath: findBrowser(this.opts.browserPath),
        args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--no-first-run'],
      },
    });
    this.client = client;

    try {
      await new Promise<void>((resolve, reject) => {
        let settled = false;
        const fail = (err: Error) => {
          if (!settled) {
            settled = true;
            reject(err);
          }
        };
        client.on('qr', (qr: string) => {
          if (!this.opts.allowQr) {
            fail(errors.loggedOut());
            return;
          }
          this.setState('awaiting_qr');
          this.events.emit('qr', { qr });
        });
        client.on('auth_failure', (msg: string) => {
          log.warn('auth failure', { reason: msg });
          this.setState('logged_out');
          fail(errors.loggedOut());
        });
        client.on('ready', () => {
          if (settled) return;
          settled = true;
          resolve();
        });
        client.on('disconnected', (reason: unknown) => {
          const r = String(reason);
          log.warn('disconnected', { reason: r });
          const loggedOut = /LOGOUT|UNPAIRED/i.test(r);
          this.setState(loggedOut ? 'logged_out' : 'reconnecting');
          fail(loggedOut ? errors.loggedOut() : errors.transport('start', `disconnected: ${r}`));
        });
        client.on('change_state', (s: unknown) => {
          const st = String(s);
          log.info('state changed', { state: st });
          if (BLOCKED_STATES.has(st)) {
            log.error('WhatsApp reports this account as BLOCKED/BANNED', { state: st });
            this.setState('failed');
          } else if (st === 'CONFLICT') {
            // WhatsApp Web was opened elsewhere for this device slot.
            this.setState('reconnecting');
          } else if (st === 'UNPAIRED' || st === 'UNPAIRED_IDLE') {
            this.setState('logged_out');
          } else if (st === 'CONNECTED' && this.current !== 'stopped') {
            this.setState('connected');
          }
        });
        client.initialize().catch((err: unknown) => fail(errors.transport('initialize', err)));
      });
    } catch (err) {
      if (!(err instanceof BridgeError && err.code === 'LOGGED_OUT')) {
        this.opts.versions.markBad(this.webVersion);
      }
      await this.destroyClient();
      if (this.current !== 'logged_out') this.setState('failed');
      throw err;
    }

    this.remoteVersion = await client.getWWebVersion().catch(() => null);
    this.opts.versions.markGood(this.webVersion);
    this.setState('connected');
    log.info('connected', { remoteVersion: this.remoteVersion });
  }

  async stop(): Promise<void> {
    await this.destroyClient();
    this.setState('stopped');
  }

  async logout(): Promise<void> {
    const c = this.client;
    if (c) await c.logout().catch(() => undefined);
    await this.destroyClient();
    this.setState('logged_out');
  }

  async probe(): Promise<void> {
    const c = this.requireClient();
    const st = String(await c.getState());
    if (st !== 'CONNECTED') {
      if (st === 'UNPAIRED' || st === 'UNPAIRED_IDLE') {
        this.setState('logged_out');
        throw errors.loggedOut();
      }
      throw errors.transport('probe', `WhatsApp Web state is ${st}`);
    }
  }

  async listChats(opts: { limit: number; includeArchived: boolean }): Promise<Chat[]> {
    const chats = await this.requireClient().getChats();
    return chats
      .filter((c) => opts.includeArchived || !c.archived)
      .sort(
        (a, b) => Number(b.pinned) - Number(a.pinned) || (b.timestamp ?? 0) - (a.timestamp ?? 0),
      )
      .slice(0, opts.limit)
      .map(toChat);
  }

  async getChat(chatId: ChatId): Promise<Chat> {
    return toChat(await this.fetchChat(chatId));
  }

  async getMessages(chatId: ChatId, opts: { limit: number }): Promise<Message[]> {
    const chat = await this.fetchChat(chatId);
    const msgs = await chat.fetchMessages({ limit: opts.limit });
    return msgs.map((m) => toMessage(m, chatId));
  }

  async searchMessages(
    query: string,
    opts: { chatId?: ChatId; limit: number },
  ): Promise<Message[]> {
    const msgs = await this.requireClient().searchMessages(query, {
      ...(opts.chatId ? { chatId: opts.chatId } : {}),
      limit: opts.limit,
    });
    return msgs.slice(0, opts.limit).map((m) => toMessage(m));
  }

  async searchContacts(query: string, opts: { limit: number }): Promise<Contact[]> {
    const q = query.toLowerCase();
    const contacts = await this.requireClient().getContacts();
    return contacts
      .filter((c) => c.isUser && !c.isGroup)
      .filter((c) => [c.name, c.pushname, c.number].some((v) => v?.toLowerCase().includes(q)))
      .sort((a, b) => Number(b.isMyContact) - Number(a.isMyContact))
      .slice(0, opts.limit)
      .map(toContact);
  }

  async resolvePhoneNumber(phone: string): Promise<ChatId | null> {
    const id = await this.requireClient().getNumberId(phone.replace(/\D/g, ''));
    return id?._serialized ?? null;
  }

  async sendText(
    chatId: ChatId,
    text: string,
    opts?: { quotedMessageId?: string },
  ): Promise<SentMessage> {
    const m = await this.requireClient().sendMessage(chatId, text, {
      ...(opts?.quotedMessageId ? { quotedMessageId: opts.quotedMessageId } : {}),
    });
    return { id: m.id._serialized, chatId, timestamp: m.timestamp * 1000 };
  }

  async sendMedia(
    chatId: ChatId,
    filePath: string,
    opts?: { caption?: string },
  ): Promise<SentMessage> {
    const media = MessageMedia.fromFilePath(filePath);
    const m = await this.requireClient().sendMessage(chatId, media, {
      ...(opts?.caption ? { caption: opts.caption } : {}),
    });
    return { id: m.id._serialized, chatId, timestamp: m.timestamp * 1000 };
  }

  async markRead(chatId: ChatId): Promise<void> {
    await this.fetchChat(chatId);
    await this.requireClient().sendSeen(chatId);
  }

  // ---------------------------------------------------------------- internals

  private requireClient(): WClient {
    if (this.current === 'logged_out') throw errors.loggedOut();
    if (!this.client || this.current !== 'connected') throw errors.notConnected(this.current);
    return this.client;
  }

  private async fetchChat(chatId: ChatId): Promise<WChat> {
    try {
      const chat = await this.requireClient().getChatById(chatId);
      if (!chat) throw errors.notFound(`Chat ${chatId}`);
      return chat;
    } catch (err) {
      if (err instanceof BridgeError) throw err;
      // wwebjs throws a generic error for unknown ids; normalise it.
      if (/not.*found|undefined|null|serialize/i.test(describe(err)))
        throw errors.notFound(`Chat ${chatId}`);
      throw err;
    }
  }

  private async destroyClient(): Promise<void> {
    const c = this.client;
    this.client = null;
    if (!c) return;
    c.removeAllListeners();
    await c.destroy().catch(() => undefined);
  }

  private setState(s: ConnectionState): void {
    if (s === this.current) return;
    this.current = s;
    this.events.emit('state', s);
  }
}

// ------------------------------------------------------------------ mapping

function toChat(c: WChat): Chat {
  return {
    id: c.id._serialized,
    name: c.name || c.id.user,
    isGroup: c.isGroup,
    unreadCount: c.unreadCount ?? 0,
    lastActivityAt: c.timestamp ? c.timestamp * 1000 : null,
    archived: Boolean(c.archived),
    pinned: Boolean(c.pinned),
    muted: Boolean(c.isMuted),
  };
}

const KIND: Record<string, MessageKind> = {
  chat: 'text',
  image: 'image',
  video: 'video',
  audio: 'audio',
  ptt: 'audio',
  document: 'document',
  sticker: 'sticker',
  location: 'location',
  vcard: 'contact',
  multi_vcard: 'contact',
};

function toMessage(m: WMessage, chatId?: ChatId): Message {
  const raw = m as unknown as { _data?: { notifyName?: string; quotedStanzaID?: string } };
  const resolvedChatId = chatId ?? (m.fromMe ? m.to : m.from);
  return {
    id: m.id._serialized,
    chatId: resolvedChatId,
    senderId: m.fromMe ? 'me' : (m.author ?? m.from),
    senderName: m.fromMe ? null : (raw._data?.notifyName ?? null),
    fromMe: m.fromMe,
    timestamp: m.timestamp * 1000,
    kind: KIND[m.type] ?? 'other',
    text: m.body ?? '',
    hasMedia: m.hasMedia,
    quotedMessageId: m.hasQuotedMsg ? (raw._data?.quotedStanzaID ?? null) : null,
  };
}

function toContact(c: WContact): Contact {
  return {
    id: c.id._serialized,
    name: c.name ?? null,
    pushName: c.pushname ?? null,
    phoneNumber: c.number ?? null,
    isMyContact: c.isMyContact,
    isBusiness: c.isBusiness,
  };
}

function libraryVersion(): string {
  try {
    const req = createRequire(import.meta.url);
    return (req('whatsapp-web.js/package.json') as { version: string }).version;
  } catch {
    return 'unknown';
  }
}
