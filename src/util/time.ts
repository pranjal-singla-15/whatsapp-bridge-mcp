import { errors } from '../domain/errors.js';

/** Injectable clock so time-based logic (rate limits, breakers, tokens) is deterministic in tests. */
export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

export async function withTimeout<T>(op: string, ms: number, fn: () => Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(errors.timeout(op, ms)), ms);
  });
  try {
    return await Promise.race([fn(), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** Exponential backoff with full jitter, capped. attempt is 0-based. */
export function backoffDelay(
  attempt: number,
  opts: { baseMs: number; maxMs: number },
  random: () => number = Math.random,
): number {
  const exp = Math.min(opts.maxMs, opts.baseMs * 2 ** attempt);
  return Math.round(exp / 2 + random() * (exp / 2));
}
