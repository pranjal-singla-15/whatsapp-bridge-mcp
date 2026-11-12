/**
 * Transport-agnostic domain model.
 *
 * Nothing in this file may reference a specific WhatsApp library. Every transport
 * (whatsapp-web.js, Baileys, fakes) maps its own objects into these shapes, which is
 * what lets us swap or fail over between transports without touching the tools.
 */

/** Stable WhatsApp JID-style id, e.g. `919876543210@c.us` or `12036...@g.us`. */
export type ChatId = string;

export interface Chat {
  id: ChatId;
  name: string;
  isGroup: boolean;
  unreadCount: number;
  /** Unix epoch milliseconds of the last activity, if known. */
  lastActivityAt: number | null;
  archived: boolean;
  pinned: boolean;
  muted: boolean;
}

export type MessageKind =
  'text' | 'image' | 'video' | 'audio' | 'document' | 'sticker' | 'location' | 'contact' | 'other';

export interface Message {
  id: string;
  chatId: ChatId;
  /** Sender id. For 1:1 chats this equals chatId when not fromMe. */
  senderId: string;
  senderName: string | null;
  fromMe: boolean;
  /** Unix epoch milliseconds. */
  timestamp: number;
  kind: MessageKind;
  /** Text body or media caption. Empty string when none. */
  text: string;
  hasMedia: boolean;
  quotedMessageId: string | null;
}

export interface Contact {
  id: ChatId;
  name: string | null;
  pushName: string | null;
  phoneNumber: string | null;
  isMyContact: boolean;
  isBusiness: boolean;
}

export interface SentMessage {
  id: string;
  chatId: ChatId;
  timestamp: number;
}

export type ConnectionState =
  'stopped' | 'starting' | 'awaiting_qr' | 'connected' | 'reconnecting' | 'logged_out' | 'failed';

/** Discrete features. Each one is health-tracked independently (graceful degradation). */
export const CAPABILITIES = [
  'listChats',
  'getMessages',
  'searchMessages',
  'searchContacts',
  'sendText',
  'sendMedia',
  'markRead',
] as const;
export type Capability = (typeof CAPABILITIES)[number];

export interface TransportInfo {
  name: string;
  libraryVersion: string;
  /** WhatsApp Web build in use, when the transport knows it. */
  remoteVersion: string | null;
}

export interface QrEvent {
  /** Raw QR payload to be rendered by the caller. */
  qr: string;
}
