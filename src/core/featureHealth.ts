import { CAPABILITIES, type Capability } from '../domain/types.js';
import type { Clock } from '../util/time.js';

export type BreakerState = 'closed' | 'open' | 'half_open';

export interface CapabilityHealth {
  capability: Capability;
  state: BreakerState;
  consecutiveFailures: number;
  lastError: string | null;
  lastSuccessAt: number | null;
  /** When an open breaker will allow a trial call. */
  retryAt: number | null;
}

/**
 * Per-capability circuit breakers ("graceful degradation").
 * If WhatsApp changes something that breaks, say, search, only search is switched off;
 * reading and sending keep working. After a cooldown one trial call is let through
 * (half-open); success closes the breaker, failure re-opens it.
 */
export class FeatureHealth {
  private readonly entries = new Map<Capability, CapabilityHealth>();

  constructor(
    private readonly clock: Clock,
    private readonly threshold: number,
    private readonly cooldownMs: number,
  ) {
    for (const c of CAPABILITIES) {
      this.entries.set(c, {
        capability: c,
        state: 'closed',
        consecutiveFailures: 0,
        lastError: null,
        lastSuccessAt: null,
        retryAt: null,
      });
    }
  }

  /** Returns null if the call may proceed, else seconds until the next trial. */
  check(cap: Capability): number | null {
    const e = this.get(cap);
    if (e.state !== 'open') return null;
    const now = this.clock.now();
    if (e.retryAt !== null && now >= e.retryAt) {
      e.state = 'half_open';
      return null;
    }
    return Math.max(1, Math.ceil(((e.retryAt ?? now) - now) / 1000));
  }

  success(cap: Capability): void {
    const e = this.get(cap);
    e.state = 'closed';
    e.consecutiveFailures = 0;
    e.retryAt = null;
    e.lastSuccessAt = this.clock.now();
  }

  /** Open the breaker immediately (e.g. a post-connect self-test proved the feature broken). */
  trip(cap: Capability, error: string): void {
    const e = this.get(cap);
    e.consecutiveFailures = Math.max(e.consecutiveFailures, this.threshold);
    e.lastError = error;
    e.state = 'open';
    e.retryAt = this.clock.now() + this.cooldownMs;
  }

  failure(cap: Capability, error: string): void {
    const e = this.get(cap);
    e.consecutiveFailures += 1;
    e.lastError = error;
    if (e.state === 'half_open' || e.consecutiveFailures >= this.threshold) {
      e.state = 'open';
      e.retryAt = this.clock.now() + this.cooldownMs;
    }
  }

  /** Clear all breakers, e.g. after switching to a different transport. */
  reset(): void {
    for (const e of this.entries.values()) {
      e.state = 'closed';
      e.consecutiveFailures = 0;
      e.retryAt = null;
    }
  }

  snapshot(): CapabilityHealth[] {
    return [...this.entries.values()].map((e) => ({ ...e }));
  }

  private get(cap: Capability): CapabilityHealth {
    const e = this.entries.get(cap);
    if (!e) throw new Error(`Unknown capability ${cap}`);
    return e;
  }
}
