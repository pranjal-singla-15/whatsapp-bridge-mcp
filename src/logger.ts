import type { LogLevel } from './config.js';

/**
 * Structured JSON-lines logger that writes ONLY to stderr.
 * stdout carries the MCP stdio protocol; a single stray byte there corrupts the session.
 *
 * Privacy: message bodies and phone numbers are redacted unless explicitly marked safe.
 */
export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
  child(bindings: Record<string, unknown>): Logger;
}

const ORDER: Record<Exclude<LogLevel, 'silent'>, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};
const SENSITIVE_KEYS = /^(text|body|caption|message|content|qr|phone|phoneNumber|query)$/i;
const PHONE_LIKE = /\b\d{7,15}(@[a-z.]+)?\b/g;

export function redact(value: unknown, key = ''): unknown {
  if (SENSITIVE_KEYS.test(key))
    return typeof value === 'string' ? `[redacted:${value.length}]` : '[redacted]';
  if (typeof value === 'string') return value.replace(PHONE_LIKE, (m) => `${m.slice(0, 3)}***`);
  if (value instanceof Error) return { name: value.name, message: redact(value.message) };
  if (Array.isArray(value)) return value.map((v) => redact(v));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redact(v, k)]));
  }
  return value;
}

export function createLogger(
  level: LogLevel,
  bindings: Record<string, unknown> = {},
  write: (line: string) => void = (l) => process.stderr.write(l + '\n'),
): Logger {
  const threshold = level === 'silent' ? Infinity : ORDER[level];
  const log = (lvl: Exclude<LogLevel, 'silent'>, msg: string, fields?: Record<string, unknown>) => {
    if (ORDER[lvl] < threshold) return;
    const entry = {
      t: new Date().toISOString(),
      level: lvl,
      msg,
      ...(redact({ ...bindings, ...fields }) as object),
    };
    write(JSON.stringify(entry));
  };
  return {
    debug: (m, f) => log('debug', m, f),
    info: (m, f) => log('info', m, f),
    warn: (m, f) => log('warn', m, f),
    error: (m, f) => log('error', m, f),
    child: (b) => createLogger(level, { ...bindings, ...b }, write),
  };
}
