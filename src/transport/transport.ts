import type {
  Chat,
  ChatId,
  ConnectionState,
  Contact,
  Message,
  QrEvent,
  SentMessage,
  TransportInfo,
} from '../domain/types.js';

/**
 * The single seam between our code and any WhatsApp implementation.
 *
 * Contract (enforced by test/contract/transportContract.ts for every implementation):
 *  - Methods return domain objects only; library objects never leak out.
 *  - Calls made while not `connected` reject with BridgeError NOT_CONNECTED.
 *  - Unknown chats reject with BridgeError NOT_FOUND.
 *  - `start()` resolves once connected; it emits `qr` events while waiting for a scan and
 *    rejects with LOGGED_OUT if the stored session is no longer valid.
 *  - Implementations must not retry internally; retries/failover belong to the supervisor.
 */
export interface WhatsAppTransport {
  readonly name: string;

  start(): Promise<void>;
  stop(): Promise<void>;
  /** Unlinks this device from the account and deletes local session data. */
  logout(): Promise<void>;

  state(): ConnectionState;
  info(): TransportInfo;
  /** Cheap end-to-end liveness check. Rejects if the session is wedged. */
  probe(): Promise<void>;

  on(event: 'state', listener: (state: ConnectionState) => void): () => void;
  on(event: 'qr', listener: (e: QrEvent) => void): () => void;

  listChats(opts: { limit: number; includeArchived: boolean }): Promise<Chat[]>;
  getChat(chatId: ChatId): Promise<Chat>;
  getMessages(chatId: ChatId, opts: { limit: number }): Promise<Message[]>;
  searchMessages(query: string, opts: { chatId?: ChatId; limit: number }): Promise<Message[]>;
  searchContacts(query: string, opts: { limit: number }): Promise<Contact[]>;
  /** Maps a phone number (digits, with country code) to a chat id, or null if not on WhatsApp. */
  resolvePhoneNumber(phone: string): Promise<ChatId | null>;

  sendText(chatId: ChatId, text: string, opts?: { quotedMessageId?: string }): Promise<SentMessage>;
  sendMedia(chatId: ChatId, filePath: string, opts?: { caption?: string }): Promise<SentMessage>;
  markRead(chatId: ChatId): Promise<void>;
}

export type TransportFactory = () => WhatsAppTransport;
