import wwebjs from 'whatsapp-web.js';
import type { Client as WClient, ClientOptions } from 'whatsapp-web.js';

/**
 * Compatibility shims for WhatsApp Web changes that whatsapp-web.js has not caught up with.
 * Each shim is idempotent, feature-detected (it is a no-op once upstream or WhatsApp fixes the
 * issue), and reports what it did so the canary/status can surface it.
 */
export async function applyCompatShims(client: WClient): Promise<string[]> {
  const page = client.pupPage;
  if (!page) return [];
  return page.evaluate(() => {
    const applied: string[] = [];
    const w = globalThis as unknown as { require(m: string): unknown };

    // 2026-11: WhatsApp Web 2.3000.105x renamed MsgKey#_serialized (now a minified `$1`).
    // whatsapp-web.js reads `key._serialized` when sending and when serialising chats, so both
    // broke (empty IndexedDB key / undefined message ids). MsgKey#toString() still returns the
    // canonical "fromMe_remote_id[_participant]" form, so restore the getter on top of it.
    try {
      // The module export IS the class (a function), not an object with a default export.
      const MsgKey = w.require('WAWebMsgKey') as (new () => unknown) | undefined;
      if (typeof MsgKey === 'function' && !('_serialized' in MsgKey.prototype)) {
        Object.defineProperty(MsgKey.prototype, '_serialized', {
          configurable: true,
          get(this: { toString(): string }) {
            return this.toString();
          },
        });
        applied.push('MsgKey._serialized');
      }
    } catch {
      // module renamed or gone: the canary will report the resulting failures
    }
    return applied;
  });
}

/**
 * Serialised message id from a (deserialised) MsgKey-like object, independent of the property
 * name WhatsApp currently uses for the cached string.
 */
export function serializedMsgId(id: unknown): string {
  if (typeof id === 'string') return id;
  if (!id || typeof id !== 'object') return '';
  const k = id as Record<string, unknown>;
  if (typeof k._serialized === 'string') return k._serialized;
  const wid = (v: unknown): string =>
    typeof v === 'string'
      ? v
      : v &&
          typeof v === 'object' &&
          typeof (v as { _serialized?: unknown })._serialized === 'string'
        ? (v as { _serialized: string })._serialized
        : '';
  if (typeof k.id === 'string' && k.remote !== undefined) {
    const participant = wid(k.participant);
    return `${String(Boolean(k.fromMe))}_${wid(k.remote)}_${k.id}${participant ? `_${participant}` : ''}`;
  }
  // last resort: any cached string that looks like a serialised key
  const cached = Object.values(k).find((v) => typeof v === 'string' && /^(true|false)_/.test(v));
  return typeof cached === 'string' ? cached : '';
}

type InjectableClient = WClient & { inject(): Promise<void> };
const BaseClient = wwebjs.Client as unknown as new (options: ClientOptions) => InjectableClient;

/**
 * whatsapp-web.js client with startup-race protection.
 *
 * 2026-11: on WhatsApp Web 2.3000.10542xxxxx, wwebjs' inject() runs as soon as
 * `window.Debug.VERSION` exists and immediately reads `WAWebSocketModel.Socket`, which is still
 * null for a moment on newer builds ("Cannot read properties of null (reading 'Socket')").
 * Wait until the socket model exists before injecting. inject() also runs on every page
 * reload, so this covers reconnects. If it never appears we proceed anyway and let the normal
 * error surface (and the supervisor retry).
 */
export class ResilientClient extends BaseClient {
  override async inject(): Promise<void> {
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      const ready = await this.pupPage
        ?.evaluate(() => {
          const w = globalThis as unknown as {
            Debug?: { VERSION?: string };
            require?: (m: string) => { Socket?: unknown } | undefined;
          };
          try {
            return Boolean(w.Debug?.VERSION && w.require?.('WAWebSocketModel')?.Socket);
          } catch {
            return false;
          }
        })
        .catch(() => false);
      if (ready) break;
      await new Promise((r) => setTimeout(r, 250));
    }
    return super.inject();
  }
}
