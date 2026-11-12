import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { BridgeError } from '../domain/errors.js';
import type { Clock } from '../util/time.js';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export interface RateLimits {
  maxPerMinute: number;
  maxPerHour: number;
  maxPerDay: number;
}

/**
 * Sliding-window limiter over minute/hour/day. Persisted to disk so restarting the
 * server (or Claude Code) cannot be used to bypass the limits.
 */
export class RateLimiter {
  private events: number[] = [];

  constructor(
    private readonly limits: RateLimits,
    private readonly clock: Clock,
    private readonly file: string | null = null,
  ) {
    this.load();
  }

  /** Throws RATE_LIMITED if a send now would exceed any window. Does not consume. */
  assertAvailable(): void {
    const now = this.clock.now();
    this.prune(now);
    const windows: [string, number, number][] = [
      ['minute', MINUTE, this.limits.maxPerMinute],
      ['hour', HOUR, this.limits.maxPerHour],
      ['day', DAY, this.limits.maxPerDay],
    ];
    for (const [label, span, max] of windows) {
      const inWindow = this.events.filter((t) => t > now - span);
      if (inWindow.length >= max) {
        const retryInSec = Math.ceil((inWindow[0]! + span - now) / 1000);
        throw new BridgeError(
          'RATE_LIMITED',
          `Send limit reached (${max} per ${label}). This protects the account from being flagged. Try again in ~${retryInSec}s.`,
          { retryable: true },
        );
      }
    }
  }

  consume(): void {
    this.assertAvailable();
    this.events.push(this.clock.now());
    this.save();
  }

  usage(): { lastMinute: number; lastHour: number; lastDay: number; limits: RateLimits } {
    const now = this.clock.now();
    this.prune(now);
    const count = (span: number) => this.events.filter((t) => t > now - span).length;
    return {
      lastMinute: count(MINUTE),
      lastHour: count(HOUR),
      lastDay: count(DAY),
      limits: this.limits,
    };
  }

  private prune(now: number): void {
    this.events = this.events.filter((t) => t > now - DAY).sort((a, b) => a - b);
  }

  private load(): void {
    if (!this.file) return;
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.file, 'utf8'));
      if (Array.isArray(parsed))
        this.events = parsed.filter((n): n is number => typeof n === 'number');
    } catch {
      this.events = [];
    }
  }

  private save(): void {
    if (!this.file) return;
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.events));
    renameSync(tmp, this.file); // atomic replace
  }
}
