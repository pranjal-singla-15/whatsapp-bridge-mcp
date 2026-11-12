import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { z } from 'zod';

/**
 * Configuration: defaults < config file (<dataDir>/config.json) < environment variables.
 * Defaults are deliberately conservative: read-only, confirmation required, known recipients only.
 */
const TransportName = z.enum(['wwebjs', 'baileys', 'fake']);
export type TransportName = z.infer<typeof TransportName>;

const LogLevel = z.enum(['debug', 'info', 'warn', 'error', 'silent']);
export type LogLevel = z.infer<typeof LogLevel>;

export const ConfigSchema = z.object({
  dataDir: z.string(),
  profile: z
    .string()
    .regex(/^[a-zA-Z0-9_-]{1,32}$/, 'profile may contain letters, digits, _ and - only'),
  transport: TransportName,
  /** Secondary transport used when the primary keeps failing. Requires its own login. */
  fallbackTransport: TransportName.or(z.literal('none')),
  logLevel: LogLevel,
  /** Show the browser window (wwebjs only). Useful for debugging. */
  headful: z.boolean(),
  /** Chrome/Edge executable for wwebjs. Auto-detected when null. */
  browserPath: z.string().nullable(),
  send: z.object({
    enabled: z.boolean(),
    requireConfirmation: z.boolean(),
    /** Allow sending to numbers you have never chatted with. Off by default: cold messaging is the #1 ban trigger. */
    allowUnknownRecipients: z.boolean(),
    confirmationTtlSec: z.number().int().min(30).max(3600),
    maxPerMinute: z.number().int().min(1).max(30),
    maxPerHour: z.number().int().min(1).max(300),
    maxPerDay: z.number().int().min(1).max(1000),
    /** Random human-like pause before each send. */
    minDelayMs: z.number().int().min(0),
    maxDelayMs: z.number().int().min(0),
    maxTextLength: z.number().int().min(1).max(65536),
  }),
  resilience: z.object({
    opTimeoutMs: z.number().int().min(1000),
    startTimeoutMs: z.number().int().min(5000),
    probeIntervalMs: z.number().int().min(5000),
    reconnectBaseMs: z.number().int().min(100),
    reconnectMaxMs: z.number().int().min(1000),
    /** Consecutive primary start failures before failing over. */
    failoverAfter: z.number().int().min(1),
    breakerThreshold: z.number().int().min(1),
    breakerCooldownMs: z.number().int().min(1000),
    connectGraceMs: z.number().int().min(0).max(120_000),
  }),
  /** Ordered list of known-good WhatsApp Web builds to try (wwebjs). Empty = library default. */
  pinnedWebVersions: z.array(z.string().regex(/^\d+\.\d+\.\d+(-[\w.]+)?$/)),
});
export type Config = z.infer<typeof ConfigSchema>;

export function defaultConfig(): Config {
  return {
    dataDir: join(homedir(), '.whatsapp-bridge'),
    profile: 'default',
    transport: 'wwebjs',
    fallbackTransport: 'none',
    logLevel: 'info',
    headful: false,
    browserPath: null,
    send: {
      enabled: false,
      requireConfirmation: true,
      allowUnknownRecipients: false,
      confirmationTtlSec: 300,
      maxPerMinute: 5,
      maxPerHour: 40,
      maxPerDay: 150,
      minDelayMs: 1200,
      maxDelayMs: 3500,
      maxTextLength: 4096,
    },
    resilience: {
      opTimeoutMs: 45_000,
      startTimeoutMs: 180_000,
      probeIntervalMs: 60_000,
      reconnectBaseMs: 2_000,
      reconnectMaxMs: 5 * 60_000,
      failoverAfter: 3,
      breakerThreshold: 3,
      breakerCooldownMs: 10 * 60_000,
      connectGraceMs: 45_000,
    },
    pinnedWebVersions: [],
  };
}

type Env = Record<string, string | undefined>;

const bool = (v: string | undefined): boolean | undefined =>
  v === undefined ? undefined : ['1', 'true', 'yes', 'on'].includes(v.toLowerCase());
const int = (v: string | undefined): number | undefined =>
  v === undefined || v === '' ? undefined : Number.parseInt(v, 10);

function stripUndefined<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}

function envOverrides(env: Env): Record<string, unknown> {
  return stripUndefined({
    dataDir: env.WA_BRIDGE_DATA_DIR,
    profile: env.WA_BRIDGE_PROFILE,
    transport: env.WA_BRIDGE_TRANSPORT,
    fallbackTransport: env.WA_BRIDGE_FALLBACK_TRANSPORT,
    logLevel: env.WA_BRIDGE_LOG_LEVEL,
    headful: bool(env.WA_BRIDGE_HEADFUL),
    browserPath: env.WA_BRIDGE_BROWSER_PATH,
    pinnedWebVersions: env.WA_BRIDGE_WEB_VERSIONS?.split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    send: stripUndefined({
      enabled: bool(env.WA_BRIDGE_SEND_ENABLED),
      requireConfirmation: bool(env.WA_BRIDGE_REQUIRE_CONFIRMATION),
      allowUnknownRecipients: bool(env.WA_BRIDGE_ALLOW_UNKNOWN_RECIPIENTS),
      maxPerMinute: int(env.WA_BRIDGE_MAX_PER_MINUTE),
      maxPerHour: int(env.WA_BRIDGE_MAX_PER_HOUR),
      maxPerDay: int(env.WA_BRIDGE_MAX_PER_DAY),
    }),
  });
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function deepMerge(base: Record<string, unknown>, over: Record<string, unknown>) {
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(over)) {
    const b = out[k];
    out[k] = isPlainObject(b) && isPlainObject(v) ? deepMerge(b, v) : v;
  }
  return out;
}

export function loadConfig(env: Env = process.env): Config {
  const defaults = defaultConfig();
  const fromEnv = envOverrides(env);
  const dataDir = resolve((fromEnv.dataDir as string | undefined) ?? defaults.dataDir);

  let fromFile: Record<string, unknown> = {};
  const file = join(dataDir, 'config.json');
  if (existsSync(file)) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
      if (!isPlainObject(parsed)) throw new Error('top-level value must be an object');
      fromFile = parsed;
    } catch (err) {
      throw new Error(`Invalid config file ${file}: ${(err as Error).message}`, { cause: err });
    }
  }

  const merged = deepMerge(deepMerge(defaults, fromFile), {
    ...fromEnv,
    dataDir,
  });
  const result = ConfigSchema.safeParse(merged);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid configuration: ${issues}`);
  }
  const cfg = result.data;
  if (cfg.send.minDelayMs > cfg.send.maxDelayMs) {
    throw new Error('Invalid configuration: send.minDelayMs must be <= send.maxDelayMs');
  }
  if (cfg.fallbackTransport === cfg.transport) {
    throw new Error('Invalid configuration: fallbackTransport must differ from transport');
  }
  return cfg;
}

/** Per-profile, per-transport session directory. */
export function sessionDir(cfg: Config, transport: TransportName): string {
  return join(cfg.dataDir, 'profiles', cfg.profile, transport);
}

export function stateDir(cfg: Config): string {
  return join(cfg.dataDir, 'profiles', cfg.profile, 'state');
}
