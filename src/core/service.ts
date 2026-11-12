import { randomUUID } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import type { Config } from '../config.js';
import { BridgeError, describe, errors, isBridgeError } from '../domain/errors.js';
import type { Chat, ChatId, Contact, Message, SentMessage } from '../domain/types.js';
import type { Logger } from '../logger.js';
import type { Clock } from '../util/time.js';
import type { RateLimiter } from './rateLimiter.js';
import type { Supervisor, SupervisorStatus } from './supervisor.js';

export interface Recipient {
  chatId: ChatId;
  name: string;
  /** True if there is existing chat history or the number is a saved contact. */
  known: boolean;
}

export interface SendRequest {
  to: string;
  text?: string;
  filePath?: string;
  replyToMessageId?: string;
}

interface PendingSend {
  token: string;
  recipient: Recipient;
  request: SendRequest;
  expiresAt: number;
  state: 'pending' | 'sending' | 'sent' | 'unknown';
  result?: SentMessage;
}

export type SendOutcome =
  | {
      status: 'pending_confirmation';
      confirmationToken: string;
      expiresAt: string;
      preview: { to: string; chatId: ChatId; text: string | null; file: string | null };
      instructions: string;
    }
  | { status: 'sent'; messageId: string; chatId: ChatId; to: string; verifiedAfterError: boolean };

const MAX_MEDIA_BYTES = 64 * 1024 * 1024;

/**
 * Application service: the only API the MCP layer talks to. Holds the business rules
 * (recipient resolution, send policy, confirmation, idempotency) and delegates I/O to
 * the Supervisor, which owns resilience.
 */
export class WhatsAppService {
  private readonly pending = new Map<string, PendingSend>();

  constructor(
    private readonly supervisor: Supervisor,
    private readonly limiter: RateLimiter,
    private readonly sendCfg: Config['send'],
    private readonly clock: Clock,
    private readonly log: Logger,
    private readonly random: () => number = Math.random,
  ) {}

  status(): SupervisorStatus & {
    sendingEnabled: boolean;
    sendUsage: ReturnType<RateLimiter['usage']>;
  } {
    return {
      ...this.supervisor.status(),
      sendingEnabled: this.sendCfg.enabled,
      sendUsage: this.limiter.usage(),
    };
  }

  // ------------------------------------------------------------------ reads

  async listChats(opts: {
    limit: number;
    includeArchived: boolean;
    unreadOnly: boolean;
  }): Promise<Chat[]> {
    const chats = await this.supervisor.exec(
      'listChats',
      (t) =>
        t.listChats({
          limit: opts.unreadOnly ? 500 : opts.limit,
          includeArchived: opts.includeArchived,
        }),
      { idempotent: true },
    );
    return (opts.unreadOnly ? chats.filter((c) => c.unreadCount > 0) : chats).slice(0, opts.limit);
  }

  async getMessages(
    chat: string,
    limit: number,
  ): Promise<{ chat: Recipient; messages: Message[] }> {
    const recipient = await this.resolveRecipient(chat);
    const messages = await this.supervisor.exec(
      'getMessages',
      (t) => t.getMessages(recipient.chatId, { limit }),
      { idempotent: true },
    );
    return { chat: recipient, messages };
  }

  async searchMessages(query: string, opts: { chat?: string; limit: number }): Promise<Message[]> {
    if (!query.trim()) throw errors.invalidInput('query must not be empty');
    const chatId = opts.chat ? (await this.resolveRecipient(opts.chat)).chatId : undefined;
    return this.supervisor.exec(
      'searchMessages',
      (t) => t.searchMessages(query, { ...(chatId ? { chatId } : {}), limit: opts.limit }),
      { idempotent: true },
    );
  }

  async searchContacts(query: string, limit: number): Promise<Contact[]> {
    if (!query.trim()) throw errors.invalidInput('query must not be empty');
    return this.supervisor.exec('searchContacts', (t) => t.searchContacts(query, { limit }), {
      idempotent: true,
    });
  }

  async markRead(chat: string): Promise<Recipient> {
    const recipient = await this.resolveRecipient(chat);
    await this.supervisor.exec('markRead', (t) => t.markRead(recipient.chatId), {
      idempotent: true,
    });
    return recipient;
  }

  /**
   * Accepts a chat id (`...@c.us` / `...@g.us`), a phone number with country code,
   * or a (partial) chat/contact name. Ambiguous names are rejected with the candidates.
   */
  async resolveRecipient(spec: string): Promise<Recipient> {
    const s = spec.trim();
    if (!s) throw errors.invalidInput('Recipient must not be empty.');

    if (s.includes('@')) {
      try {
        const chat = await this.supervisor.exec('listChats', (t) => t.getChat(s), {
          idempotent: true,
        });
        return { chatId: chat.id, name: chat.name, known: true };
      } catch (err) {
        if (isBridgeError(err, 'NOT_FOUND') && s.endsWith('@c.us'))
          return { chatId: s, name: s, known: false };
        throw err;
      }
    }

    if (/^\+?[\d\s()-]{7,20}$/.test(s)) {
      const digits = s.replace(/\D/g, '');
      const chatId = await this.supervisor.exec(
        'searchContacts',
        (t) => t.resolvePhoneNumber(digits),
        {
          idempotent: true,
        },
      );
      if (!chatId) throw errors.notFound(`WhatsApp account for number +${digits}`);
      return this.describeChatId(chatId, `+${digits}`);
    }

    const needle = s.toLowerCase();
    const chats = await this.supervisor.exec(
      'listChats',
      (t) => t.listChats({ limit: 1000, includeArchived: true }),
      { idempotent: true },
    );
    const exact = chats.filter((c) => c.name.toLowerCase() === needle);
    const partial = exact.length
      ? exact
      : chats.filter((c) => c.name.toLowerCase().includes(needle));
    if (partial.length === 1)
      return { chatId: partial[0]!.id, name: partial[0]!.name, known: true };
    if (partial.length > 1)
      throw ambiguous(
        s,
        partial.map((c) => `${c.name} (${c.id})`),
      );

    const contacts = await this.supervisor.exec(
      'searchContacts',
      (t) => t.searchContacts(s, { limit: 10 }),
      { idempotent: true },
    );
    if (contacts.length === 1) {
      const c = contacts[0]!;
      return { chatId: c.id, name: c.name ?? c.pushName ?? c.id, known: c.isMyContact };
    }
    if (contacts.length > 1) {
      throw ambiguous(
        s,
        contacts.map((c) => `${c.name ?? c.pushName ?? '?'} (${c.id})`),
      );
    }
    throw errors.notFound(`Chat or contact matching "${s}"`);
  }

  // ------------------------------------------------------------------ sends

  async prepareSend(req: SendRequest): Promise<SendOutcome> {
    if (!this.sendCfg.enabled) {
      throw new BridgeError(
        'SEND_DISABLED',
        'Sending is disabled (read-only mode). Enable it by setting WA_BRIDGE_SEND_ENABLED=true or "send": {"enabled": true} in config.json.',
      );
    }
    await this.validateContent(req);
    const recipient = await this.resolveRecipient(req.to);
    if (!recipient.known && !this.sendCfg.allowUnknownRecipients) {
      throw new BridgeError(
        'RECIPIENT_NOT_ALLOWED',
        `${recipient.name} has no chat history with you and is not a saved contact. Messaging unknown numbers is blocked by default because it is the most common cause of WhatsApp bans. Set send.allowUnknownRecipients=true to override.`,
      );
    }
    this.limiter.assertAvailable();
    this.gc();

    const p: PendingSend = {
      token: randomUUID(),
      recipient,
      request: req,
      expiresAt: this.clock.now() + this.sendCfg.confirmationTtlSec * 1000,
      state: 'pending',
    };
    this.pending.set(p.token, p);

    if (!this.sendCfg.requireConfirmation) return this.confirmSend(p.token);
    return {
      status: 'pending_confirmation',
      confirmationToken: p.token,
      expiresAt: new Date(p.expiresAt).toISOString(),
      preview: {
        to: recipient.name,
        chatId: recipient.chatId,
        text: req.text ?? null,
        file: req.filePath ?? null,
      },
      instructions:
        "Show this exact preview to the user and get their explicit approval, then call whatsapp_confirm_send with the confirmationToken. Do not confirm on the user's behalf.",
    };
  }

  async confirmSend(token: string): Promise<SendOutcome> {
    const p = this.pending.get(token);
    if (!p)
      throw new BridgeError(
        'CONFIRMATION_INVALID',
        'Unknown or expired confirmation token. Prepare the message again.',
      );
    if (p.state === 'sent' && p.result) {
      // Idempotent: confirming twice never sends twice.
      return {
        status: 'sent',
        messageId: p.result.id,
        chatId: p.result.chatId,
        to: p.recipient.name,
        verifiedAfterError: false,
      };
    }
    if (p.state === 'sending')
      throw new BridgeError('CONFIRMATION_INVALID', 'This message is already being sent.');
    if (p.state === 'unknown') {
      throw new BridgeError(
        'CONFIRMATION_INVALID',
        'A previous attempt with this token may or may not have been delivered. Check the chat with whatsapp_get_messages before preparing it again.',
      );
    }
    if (this.clock.now() > p.expiresAt) {
      this.pending.delete(token);
      throw new BridgeError(
        'CONFIRMATION_INVALID',
        'Confirmation token expired. Prepare the message again.',
      );
    }

    this.limiter.consume();
    p.state = 'sending';
    await this.clock.sleep(this.humanDelay());
    const startedAt = this.clock.now();
    const { chatId } = p.recipient;
    const { text, filePath, replyToMessageId } = p.request;
    try {
      const result = filePath
        ? await this.supervisor.exec(
            'sendMedia',
            (t) => t.sendMedia(chatId, filePath, text ? { caption: text } : {}),
            { idempotent: false },
          )
        : await this.supervisor.exec(
            'sendText',
            (t) =>
              t.sendText(
                chatId,
                text ?? '',
                replyToMessageId ? { quotedMessageId: replyToMessageId } : {},
              ),
            { idempotent: false },
          );
      p.state = 'sent';
      p.result = result;
      this.log.info('message sent', { chatId, messageId: result.id });
      return {
        status: 'sent',
        messageId: result.id,
        chatId,
        to: p.recipient.name,
        verifiedAfterError: false,
      };
    } catch (err) {
      return this.reconcileFailedSend(p, startedAt, err);
    }
  }

  /**
   * A send that errored (e.g. timed out) may still have been delivered. Never blindly
   * retry: look for our message in the chat first.
   */
  private async reconcileFailedSend(
    p: PendingSend,
    startedAt: number,
    err: unknown,
  ): Promise<SendOutcome> {
    const { chatId } = p.recipient;
    const definitelyNotSent =
      isBridgeError(err) &&
      [
        'NOT_CONNECTED',
        'LOGGED_OUT',
        'CAPABILITY_UNAVAILABLE',
        'NOT_FOUND',
        'INVALID_INPUT',
      ].includes(err.code);
    if (definitelyNotSent) {
      p.state = 'pending';
      throw err;
    }
    try {
      const recent = await this.supervisor.exec(
        'getMessages',
        (t) => t.getMessages(chatId, { limit: 15 }),
        { idempotent: true },
      );
      const expected = (p.request.text ?? '').trim();
      const match = recent.find(
        (m) => m.fromMe && m.timestamp >= startedAt - 10_000 && m.text.trim() === expected,
      );
      if (match) {
        p.state = 'sent';
        p.result = { id: match.id, chatId, timestamp: match.timestamp };
        this.log.warn('send reported an error but delivery was verified', { chatId, err });
        return {
          status: 'sent',
          messageId: match.id,
          chatId,
          to: p.recipient.name,
          verifiedAfterError: true,
        };
      }
      p.state = 'pending';
      throw new BridgeError(
        'TRANSPORT_FAILURE',
        `Sending failed and the message is NOT in the chat (${describe(err)}). It is safe to retry whatsapp_confirm_send with the same token.`,
        { retryable: true, cause: err },
      );
    } catch (verifyErr) {
      if (isBridgeError(verifyErr, 'TRANSPORT_FAILURE') && p.state === 'pending') throw verifyErr;
      p.state = 'unknown';
      throw new BridgeError(
        'TRANSPORT_FAILURE',
        `Sending failed (${describe(err)}) and delivery could not be verified. Check the chat before trying again to avoid a duplicate.`,
        { cause: err },
      );
    }
  }

  private async validateContent(req: SendRequest): Promise<void> {
    const hasText = typeof req.text === 'string' && req.text.trim().length > 0;
    if (!hasText && !req.filePath) throw errors.invalidInput('Provide text and/or filePath.');
    if (req.text && req.text.length > this.sendCfg.maxTextLength) {
      throw errors.invalidInput(
        `Text is too long (${req.text.length} > ${this.sendCfg.maxTextLength} characters).`,
      );
    }
    if (req.filePath) {
      if (!isAbsolute(req.filePath))
        throw errors.invalidInput('filePath must be an absolute path.');
      const s = await stat(req.filePath).catch(() => null);
      if (!s?.isFile()) throw errors.invalidInput(`File not found: ${req.filePath}`);
      if (s.size > MAX_MEDIA_BYTES) throw errors.invalidInput('File is larger than 64 MB.');
    }
  }

  private async describeChatId(chatId: ChatId, fallbackName: string): Promise<Recipient> {
    try {
      const chat = await this.supervisor.exec('listChats', (t) => t.getChat(chatId), {
        idempotent: true,
      });
      return { chatId, name: chat.name || fallbackName, known: true };
    } catch (err) {
      if (!isBridgeError(err, 'NOT_FOUND')) throw err;
    }
    const contacts = await this.supervisor
      .exec('searchContacts', (t) => t.searchContacts(chatId.split('@')[0]!, { limit: 5 }), {
        idempotent: true,
      })
      .catch(() => [] as Contact[]);
    const c = contacts.find((x) => x.id === chatId);
    return { chatId, name: c?.name ?? c?.pushName ?? fallbackName, known: c?.isMyContact ?? false };
  }

  private humanDelay(): number {
    const { minDelayMs, maxDelayMs } = this.sendCfg;
    return Math.round(minDelayMs + this.random() * (maxDelayMs - minDelayMs));
  }

  private gc(): void {
    const now = this.clock.now();
    for (const [k, p] of this.pending) {
      if (now > p.expiresAt + 3_600_000) this.pending.delete(k);
    }
  }
}

function ambiguous(spec: string, candidates: string[]): BridgeError {
  return errors.invalidInput(
    `"${spec}" matches several chats. Ask the user which one, then pass its id:\n- ${candidates.slice(0, 10).join('\n- ')}`,
  );
}
