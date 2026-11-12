import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Chat, Contact, Message } from '../../domain/types.js';

interface Snapshot {
  chats: Chat[];
  contacts: Contact[];
  messages: Message[];
}

/**
 * Baileys does not keep chat history itself, and WhatsApp only sends the history once
 * (at link time). This small store keeps domain objects in memory and persists them,
 * bounded per chat, with debounced atomic writes.
 */
export class BaileysStore {
  readonly chats = new Map<string, Chat>();
  readonly contacts = new Map<string, Contact>();
  private readonly messages = new Map<string, Message[]>();
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly file: string,
    private readonly perChatLimit = 300,
  ) {
    this.load();
  }

  upsertChat(chat: Partial<Chat> & { id: string }): void {
    const prev = this.chats.get(chat.id);
    this.chats.set(chat.id, {
      name: chat.id.split('@')[0] ?? chat.id,
      isGroup: chat.id.endsWith('@g.us'),
      unreadCount: 0,
      lastActivityAt: null,
      archived: false,
      pinned: false,
      muted: false,
      ...prev,
      ...stripUndefined(chat),
      id: chat.id,
    });
    this.scheduleSave();
  }

  upsertContact(c: Partial<Contact> & { id: string }): void {
    const prev = this.contacts.get(c.id);
    this.contacts.set(c.id, {
      name: null,
      pushName: null,
      phoneNumber: c.id.endsWith('@c.us') ? (c.id.split('@')[0] ?? null) : null,
      isMyContact: false,
      isBusiness: false,
      ...prev,
      ...stripUndefined(c),
      id: c.id,
    });
    const chat = this.chats.get(c.id);
    const display = c.name ?? c.pushName;
    if (chat && display && chat.name === chat.id.split('@')[0]) chat.name = display;
    this.scheduleSave();
  }

  addMessage(m: Message): void {
    const list = this.messages.get(m.chatId) ?? [];
    if (!list.some((x) => x.id === m.id)) {
      list.push(m);
      list.sort((a, b) => a.timestamp - b.timestamp);
      if (list.length > this.perChatLimit) list.splice(0, list.length - this.perChatLimit);
      this.messages.set(m.chatId, list);
    }
    if (!this.chats.has(m.chatId)) this.upsertChat({ id: m.chatId });
    const chat = this.chats.get(m.chatId)!;
    if (!chat.lastActivityAt || m.timestamp > chat.lastActivityAt)
      chat.lastActivityAt = m.timestamp;
    if (!m.fromMe && m.senderName && !chat.isGroup && chat.name === chat.id.split('@')[0]) {
      chat.name = m.senderName;
    }
    this.scheduleSave();
  }

  messagesFor(chatId: string): Message[] {
    return [...(this.messages.get(chatId) ?? [])];
  }

  allMessages(): Message[] {
    return [...this.messages.values()].flat();
  }

  flush(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const snap: Snapshot = {
      chats: [...this.chats.values()],
      contacts: [...this.contacts.values()],
      messages: this.allMessages(),
    };
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(`${this.file}.tmp`, JSON.stringify(snap));
    renameSync(`${this.file}.tmp`, this.file);
  }

  private scheduleSave(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      try {
        this.flush();
      } catch {
        // retried on next change
      }
    }, 2_000);
    this.timer.unref();
  }

  private load(): void {
    try {
      const snap = JSON.parse(readFileSync(this.file, 'utf8')) as Snapshot;
      for (const c of snap.chats ?? []) this.chats.set(c.id, c);
      for (const c of snap.contacts ?? []) this.contacts.set(c.id, c);
      for (const m of snap.messages ?? []) {
        const list = this.messages.get(m.chatId) ?? [];
        list.push(m);
        this.messages.set(m.chatId, list);
      }
    } catch {
      // empty store
    }
  }
}

function stripUndefined<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}
