/**
 * Typed error hierarchy. Every error carries a stable `code` (for programmatic handling
 * and tests), a `retryable` hint (for the resilience layer), and a human-readable,
 * actionable message (for the MCP client / end user).
 */
export type ErrorCode =
  | 'NOT_CONNECTED'
  | 'LOGGED_OUT'
  | 'TIMEOUT'
  | 'TRANSPORT_FAILURE'
  | 'CAPABILITY_UNAVAILABLE'
  | 'NOT_FOUND'
  | 'INVALID_INPUT'
  | 'SEND_DISABLED'
  | 'RECIPIENT_NOT_ALLOWED'
  | 'RATE_LIMITED'
  | 'CONFIRMATION_REQUIRED'
  | 'CONFIRMATION_INVALID';

export class BridgeError extends Error {
  readonly code: ErrorCode;
  readonly retryable: boolean;

  constructor(
    code: ErrorCode,
    message: string,
    opts: { retryable?: boolean; cause?: unknown } = {},
  ) {
    super(message, opts.cause === undefined ? undefined : { cause: opts.cause });
    this.name = 'BridgeError';
    this.code = code;
    this.retryable = opts.retryable ?? false;
  }
}

export const errors = {
  notConnected: (state: string) =>
    new BridgeError(
      'NOT_CONNECTED',
      `WhatsApp is not connected (state: ${state}). It reconnects automatically; try again shortly or run the whatsapp_status tool.`,
      { retryable: true },
    ),
  loggedOut: () =>
    new BridgeError(
      'LOGGED_OUT',
      'This device was logged out of WhatsApp. Run `npx whatsapp-bridge-mcp login` and scan the QR code again.',
    ),
  timeout: (op: string, ms: number) =>
    new BridgeError('TIMEOUT', `WhatsApp operation "${op}" timed out after ${ms} ms.`, {
      retryable: true,
    }),
  transport: (op: string, cause: unknown) =>
    new BridgeError('TRANSPORT_FAILURE', `WhatsApp operation "${op}" failed: ${describe(cause)}`, {
      retryable: true,
      cause,
    }),
  capabilityUnavailable: (cap: string, retryInSec: number) =>
    new BridgeError(
      'CAPABILITY_UNAVAILABLE',
      `The "${cap}" feature is temporarily disabled after repeated failures (WhatsApp may have changed something). ` +
        `Other features still work. It will be retried automatically in ~${retryInSec}s.`,
      { retryable: true },
    ),
  notFound: (what: string) => new BridgeError('NOT_FOUND', `${what} was not found.`),
  invalidInput: (msg: string) => new BridgeError('INVALID_INPUT', msg),
};

export function describe(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

export function isBridgeError(err: unknown, code?: ErrorCode): err is BridgeError {
  return err instanceof BridgeError && (code === undefined || err.code === code);
}
