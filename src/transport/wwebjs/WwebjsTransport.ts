import { createRequire } from 'node:module';
import wwebjs from 'whatsapp-web.js';
import type { Client as WClient, Message as WMessage } from 'whatsapp-web.js';
import { BridgeError, errors } from '../../domain/errors.js';
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
import { applyCompatShims, ResilientClient, serializedMsgId } from './compat.js';
import type { VersionSelector, WebVersion } from './versionSelector.js';

const { LocalAuth, MessageMedia } = wwebjs;
/** Exported at runtime but missing from the library's type definitions. */
const WChatClass = (
  wwebjs as unknown as {
    Chat: { prototype: { fetchMessages(this: unknown, o: { limit: number }): Promise<unknown> } };
  }
).Chat;

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

    const client = new ResilientClient({
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

    await this.applyShims(client, log);
    // WhatsApp Web can reload itself; wwebjs re-injects and emits 'ready' again.
    client.on('ready', () => void this.applyShims(client, log));
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
    const chats = await this.readChats(null);
    return chats
      .filter((c) => opts.includeArchived || !c.archived)
      .sort(
        (a, b) =>
          Number(b.pinned) - Number(a.pinned) || (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0),
      )
      .slice(0, opts.limit);
  }

  async getChat(chatId: ChatId): Promise<Chat> {
    const [chat] = await this.readChats(chatId);
    if (!chat) throw errors.notFound(`Chat ${chatId}`);
    return chat;
  }

  async getMessages(chatId: ChatId, opts: { limit: number }): Promise<Message[]> {
    await this.getChat(chatId);
    // wwebjs' fetchMessages only needs the chat id; calling it on a minimal receiver avoids
    // client.getChatById(), whose full chat serialisation is broken on current WhatsApp Web.
    const receiver = { client: this.requireClient(), id: { _serialized: chatId } };
    const msgs = (await WChatClass.prototype.fetchMessages.call(receiver, {
      limit: opts.limit,
    })) as WMessage[];
    return msgs.map((m) => toMessage(m, chatId)).sort((a, b) => a.timestamp - b.timestamp);
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

  /**
   * Filters inside the page and only serialises matches. wwebjs' getContacts() serialises every
   * contact first (40s+ for a few thousand contacts).
   */
  async searchContacts(query: string, opts: { limit: number }): Promise<Contact[]> {
    return this.requireClient().pupPage!.evaluate(
      (q: string, limit: number) => {
        type WaWid = { _serialized: string; user?: string; server?: string };
        type WaContact = { id: WaWid; phoneNumber?: WaWid; isBusiness?: boolean };
        type Getters = Record<string, ((c: WaContact) => unknown) | undefined>;
        const w = globalThis as unknown as { require(m: string): Record<string, unknown> };
        const call = (g: Getters, fn: string, c: WaContact): unknown => {
          try {
            return g[fn]?.(c);
          } catch {
            return undefined;
          }
        };
        const getters = w.require('WAWebContactGetters') as Getters;
        const frontend = w.require('WAWebFrontendContactGetters') as Getters;
        const contacts = (
          w.require('WAWebCollections').Contact as { getModelsArray(): WaContact[] }
        ).getModelsArray();
        const needle = q.toLowerCase();
        const out: {
          id: string;
          name: string | null;
          pushName: string | null;
          phoneNumber: string | null;
          isMyContact: boolean;
          isBusiness: boolean;
        }[] = [];
        for (const c of contacts) {
          const server = c.id.server;
          if (server === 'g.us' || server === 'broadcast' || server === 'newsletter') continue;
          const name = call(getters, 'getName', c) as string | undefined;
          const pushname = call(getters, 'getPushname', c) as string | undefined;
          const number = c.phoneNumber?.user ?? (server === 'c.us' ? c.id.user : undefined);
          if (![name, pushname, number].some((v) => v?.toLowerCase().includes(needle))) continue;
          if (call(getters, 'getIsUser', c) === false) continue;
          out.push({
            id: server === 'lid' && c.phoneNumber ? c.phoneNumber._serialized : c.id._serialized,
            name: name ?? null,
            pushName: pushname ?? null,
            phoneNumber: number ?? null,
            isMyContact: Boolean(call(frontend, 'getIsMyContact', c)),
            isBusiness: Boolean(c.isBusiness),
          });
        }
        // One person can exist as both a phone-number and a LID contact; keep one entry per id.
        const unique = [...new Map(out.map((x) => [x.id, x])).values()];
        unique.sort((a, b) => Number(b.isMyContact) - Number(a.isMyContact));
        return unique.slice(0, limit);
      },
      query,
      opts.limit,
    );
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
    return { id: serializedMsgId(m.id), chatId, timestamp: m.timestamp * 1000 };
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
    return { id: serializedMsgId(m.id), chatId, timestamp: m.timestamp * 1000 };
  }

  async markRead(chatId: ChatId): Promise<void> {
    await this.getChat(chatId);
    await this.requireClient().sendSeen(chatId);
  }

  // ---------------------------------------------------------------- internals

  private async applyShims(client: WClient, log: Logger): Promise<void> {
    try {
      const applied = await applyCompatShims(client);
      if (applied.length) log.info('applied WhatsApp Web compatibility shims', { applied });
    } catch (err) {
      log.warn('could not apply compatibility shims', { err });
    }
  }

  private requireClient(): WClient {
    if (this.current === 'logged_out') throw errors.loggedOut();
    if (!this.client || this.current !== 'connected') throw errors.notConnected(this.current);
    return this.client;
  }

  /**
   * Reads chats with our own minimal in-page serialiser instead of wwebjs' getChats()/
   * getChatById(). Those build a full model including the last message, which fails on current
   * WhatsApp Web builds (empty IndexedDB key). Reading only the fields we need touches far fewer
   * WhatsApp internals, so it is also less likely to break on future changes.
   * @param only a single chat id, or null for all chats
   */
  private async readChats(only: ChatId | null): Promise<Chat[]> {
    const raw = await this.requireClient().pupPage!.evaluate((id: string | null) => {
      type WaChat = {
        id: { _serialized: string; user?: string; server?: string };
        formattedTitle?: string;
        name?: string;
        contact?: { name?: string; pushname?: string };
        groupMetadata?: { subject?: string };
        unreadCount?: number;
        t?: number;
        archive?: boolean;
        pin?: number;
        mute?: { expiration?: number };
      };
      const w = globalThis as unknown as { require(m: string): Record<string, never> };
      const collection = w.require('WAWebCollections').Chat as unknown as {
        getModelsArray(): WaChat[];
        get(wid: unknown): WaChat | undefined;
      };
      const safe = <T>(f: () => T, d: T): T => {
        try {
          return f() ?? d;
        } catch {
          return d;
        }
      };
      let chats: WaChat[];
      if (id) {
        const wid = safe(
          () =>
            (
              w.require('WAWebWidFactory') as unknown as { createWid(s: string): unknown }
            ).createWid(id),
          null,
        );
        const one = wid ? collection.get(wid) : undefined;
        chats = one ? [one] : [];
      } else {
        chats = collection.getModelsArray();
      }
      return chats
        .filter((c) => !/@(newsletter|broadcast)$/.test(c.id._serialized))
        .map((c) => {
          const expiration = safe(() => c.mute?.expiration, 0);
          return {
            id: c.id._serialized,
            name: String(
              safe(
                () =>
                  c.formattedTitle ||
                  c.name ||
                  c.groupMetadata?.subject ||
                  c.contact?.name ||
                  c.contact?.pushname ||
                  c.id.user,
                c.id._serialized,
              ),
            ),
            isGroup: Boolean(c.groupMetadata) || c.id.server === 'g.us',
            unreadCount: safe(() => c.unreadCount, 0) ?? 0,
            t: safe(() => c.t, 0) ?? 0,
            archived: Boolean(safe(() => c.archive, false)),
            pinned: Boolean(safe(() => c.pin, 0)),
            muted: typeof expiration === 'number' && expiration !== 0,
          };
        });
    }, only);
    return raw.map((c) => ({
      id: c.id,
      name: c.name,
      isGroup: c.isGroup,
      unreadCount: Math.max(0, c.unreadCount),
      lastActivityAt: c.t ? c.t * 1000 : null,
      archived: c.archived,
      pinned: c.pinned,
      muted: c.muted,
    }));
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
    id: serializedMsgId(m.id),
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

function libraryVersion(): string {
  try {
    const req = createRequire(import.meta.url);
    return (req('whatsapp-web.js/package.json') as { version: string }).version;
  } catch {
    return 'unknown';
  }
}
