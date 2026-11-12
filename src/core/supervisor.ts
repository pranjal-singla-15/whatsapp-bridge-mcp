import { BridgeError, describe, errors, isBridgeError } from '../domain/errors.js';
import type { Capability, ConnectionState, QrEvent, TransportInfo } from '../domain/types.js';
import type { Logger } from '../logger.js';
import type { WhatsAppTransport } from '../transport/transport.js';
import { Emitter } from '../util/emitter.js';
import { backoffDelay, type Clock, withTimeout } from '../util/time.js';
import { FeatureHealth, type CapabilityHealth } from './featureHealth.js';
import type { SessionVault } from './sessionVault.js';

export interface TransportSlot {
  name: string;
  /** interactive=true allows the transport to wait for a QR scan instead of reporting logged_out. */
  create: (opts: { interactive: boolean }) => WhatsAppTransport;
  vault?: SessionVault;
}

export interface SupervisorOptions {
  opTimeoutMs: number;
  startTimeoutMs: number;
  probeIntervalMs: number;
  reconnectBaseMs: number;
  reconnectMaxMs: number;
  failoverAfter: number;
  breakerThreshold: number;
  breakerCooldownMs: number;
  /**
   * How long a call waits for an in-progress (re)connect before failing with NOT_CONNECTED.
   * Covers cold start: launching the browser and loading WhatsApp Web can take 20-40s.
   */
  connectGraceMs?: number;
  /** How long to stay on a fallback transport before trying the primary again. */
  failbackAfterMs?: number;
}

export type SupervisorState = 'idle' | 'connecting' | 'running' | 'logged_out' | 'stopped';

export interface SupervisorStatus {
  state: SupervisorState;
  activeTransport: string | null;
  transportState: ConnectionState | null;
  transportInfo: TransportInfo | null;
  usingFallback: boolean;
  connectedSince: number | null;
  reconnects: number;
  lastError: string | null;
  capabilities: CapabilityHealth[];
  recentEvents: { at: number; event: string }[];
}

/** Errors that reflect the caller's input, not the health of WhatsApp. */
const CALLER_ERRORS = new Set(['NOT_FOUND', 'INVALID_INPUT']);
const MAX_EVENTS = 25;

/**
 * Runtime self-healing. Owns the transport lifecycle:
 *  - connects with exponential backoff + jitter, forever (until stopped or logged out)
 *  - restores the last-good session after repeated start failures
 *  - fails over to a secondary transport, and periodically fails back to the primary
 *  - watchdog: periodic liveness probe; a wedged transport is torn down and rebuilt
 *  - per-capability circuit breakers with timeouts on every call
 */
export class Supervisor {
  private status_: SupervisorState = 'idle';
  private transport: WhatsAppTransport | null = null;
  private activeSlot = 0;
  private readonly failures: number[];
  private readonly loggedOut: boolean[];
  private unsubscribe: (() => void)[] = [];
  private loop: Promise<void> | null = null;
  private abort = new AbortController();
  private watchdog: NodeJS.Timeout | null = null;
  private probeFailures = 0;
  private connectedSince: number | null = null;
  private reconnects = 0;
  private everConnected = false;
  private interactive = false;
  private lastRevive = 0;
  private lastError: string | null = null;
  private readonly events_: { at: number; event: string }[] = [];
  private readonly emitter = new Emitter<{ qr: QrEvent; state: SupervisorState }>();
  readonly health: FeatureHealth;

  constructor(
    private readonly slots: TransportSlot[],
    private readonly opts: SupervisorOptions,
    private readonly clock: Clock,
    private readonly log: Logger,
    private readonly random: () => number = Math.random,
  ) {
    if (slots.length === 0) throw new Error('Supervisor needs at least one transport');
    this.failures = slots.map(() => 0);
    this.loggedOut = slots.map(() => false);
    this.health = new FeatureHealth(clock, opts.breakerThreshold, opts.breakerCooldownMs);
  }

  onQr(listener: (e: QrEvent) => void): () => void {
    return this.emitter.on('qr', listener);
  }

  onState(listener: (s: SupervisorState) => void): () => void {
    return this.emitter.on('state', listener);
  }

  /** Begins connecting in the background. Idempotent. */
  start(): void {
    if (this.status_ === 'connecting' || this.status_ === 'running') return;
    this.abort = new AbortController();
    this.setStatus('connecting');
    this.ensureLoop();
    if (!this.watchdog) {
      this.watchdog = setInterval(() => void this.tick(), this.opts.probeIntervalMs);
      this.watchdog.unref();
    }
  }

  /** Resolves when connected; rejects on timeout or logout. */
  async waitUntilConnected(timeoutMs: number): Promise<void> {
    if (this.status_ === 'running') return;
    if (this.status_ === 'logged_out') throw errors.loggedOut();
    await withTimeout(
      'connect',
      timeoutMs,
      () =>
        new Promise<void>((resolve, reject) => {
          const off = this.emitter.on('state', (s) => {
            if (s === 'running') {
              off();
              resolve();
            } else if (s === 'logged_out' || s === 'stopped') {
              off();
              reject(s === 'logged_out' ? errors.loggedOut() : errors.notConnected(s));
            }
          });
        }),
    );
  }

  /**
   * Starts (or restarts) connecting in interactive mode so a QR code can be scanned.
   * Resolves with the first QR payload, or null if the session was still valid.
   */
  async beginInteractiveLogin(timeoutMs = 90_000): Promise<string | null> {
    if (this.status_ === 'running') return null;
    await this.stop();
    this.interactive = true;
    this.loggedOut.fill(false);
    this.failures.fill(0);
    this.setStatus('idle');
    const firstQr = new Promise<string | null>((resolve) => {
      const timer = setTimeout(() => done(null), timeoutMs);
      const offQr = this.emitter.on('qr', (e) => done(e.qr));
      const offState = this.emitter.on('state', (s) => {
        if (s === 'running' || s === 'logged_out') done(null);
      });
      function done(v: string | null) {
        clearTimeout(timer);
        offQr();
        offState();
        resolve(v);
      }
    });
    this.start();
    return firstQr;
  }

  /**
   * Self-heal after the user logs in from another process (e.g. the `login` CLI):
   * while logged out, periodically re-check whether a valid session now exists.
   */
  revive(): void {
    const now = this.clock.now();
    if (this.status_ !== 'logged_out' || now - this.lastRevive < 30_000) return;
    this.lastRevive = now;
    this.loggedOut.fill(false);
    this.failures.fill(0);
    this.setStatus('idle');
    this.start();
  }

  async stop(): Promise<void> {
    this.setStatus('stopped');
    this.abort.abort();
    if (this.watchdog) clearInterval(this.watchdog);
    this.watchdog = null;
    await this.teardown();
    await this.loop?.catch(() => undefined);
  }

  /** Unlinks the active transport's device and wipes its local session. */
  async logout(): Promise<void> {
    const t = this.transport;
    const slot = this.slots[this.activeSlot];
    await this.stop();
    if (t) await t.logout().catch((err: unknown) => this.log.warn('logout failed', { err }));
    await slot?.vault?.destroy();
  }

  status(): SupervisorStatus {
    return {
      state: this.status_,
      activeTransport: this.transport?.name ?? null,
      transportState: this.transport?.state() ?? null,
      transportInfo: this.transport?.info() ?? null,
      usingFallback: this.transport !== null && this.activeSlot > 0,
      connectedSince: this.connectedSince,
      reconnects: this.reconnects,
      lastError: this.lastError,
      capabilities: this.health.snapshot(),
      recentEvents: [...this.events_],
    };
  }

  /**
   * Runs a transport operation with circuit breaker, timeout and error normalisation.
   * `idempotent` operations get one automatic retry; sends never do (see SendGuard).
   */
  async exec<T>(
    cap: Capability,
    fn: (t: WhatsAppTransport) => Promise<T>,
    opts: { idempotent: boolean },
  ): Promise<T> {
    const wait = this.health.check(cap);
    if (wait !== null) throw errors.capabilityUnavailable(cap, wait);

    const attempts = opts.idempotent ? 2 : 1;
    let lastErr: unknown;
    for (let i = 0; i < attempts; i++) {
      const t = await this.connectedTransport();
      try {
        const result = await withTimeout(cap, this.opts.opTimeoutMs, () => fn(t));
        this.health.success(cap);
        return result;
      } catch (err) {
        lastErr = err;
        if (isBridgeError(err) && CALLER_ERRORS.has(err.code)) throw err;
        if (isBridgeError(err, 'LOGGED_OUT')) {
          this.handleLoggedOut();
          throw err;
        }
        if (isBridgeError(err, 'NOT_CONNECTED')) {
          this.requestRecovery('operation saw a disconnected transport');
        } else {
          this.health.failure(cap, describe(err));
        }
        if (i + 1 < attempts && this.health.check(cap) === null) {
          await this.clock.sleep(300);
          continue;
        }
      }
    }
    throw lastErr instanceof BridgeError ? lastErr : errors.transport(cap, lastErr);
  }

  // ---------------------------------------------------------------- internals

  private async connectedTransport(): Promise<WhatsAppTransport> {
    if (this.status_ === 'logged_out') {
      this.revive();
      throw errors.loggedOut();
    }
    if (this.status_ !== 'running' || !this.transport) {
      if (this.status_ === 'connecting') {
        // Brief grace period so calls made during a quick reconnect succeed transparently.
        await this.waitUntilConnected(this.opts.connectGraceMs ?? 45_000).catch(() => undefined);
      }
      if (this.status_ !== 'running' || !this.transport) {
        throw errors.notConnected(this.transport?.state() ?? this.status_);
      }
    }
    return this.transport;
  }

  private ensureLoop(): void {
    if (this.loop) return;
    this.loop = this.connectLoop()
      .catch((err: unknown) => this.log.error('connect loop crashed', { err }))
      .finally(() => {
        this.loop = null;
      });
  }

  private pickSlot(): number | null {
    const usable = this.slots.map((_, i) => i).filter((i) => !this.loggedOut[i]);
    if (usable.length === 0) return null;
    const primary = usable[0]!;
    const fallback = usable[1];
    if (fallback !== undefined && this.failures[primary]! >= this.opts.failoverAfter)
      return fallback;
    return primary;
  }

  private async connectLoop(): Promise<void> {
    let attempt = 0;
    while (!this.abort.signal.aborted && this.status_ === 'connecting') {
      const idx = this.pickSlot();
      if (idx === null) {
        this.handleLoggedOut();
        return;
      }
      const slot = this.slots[idx]!;
      try {
        await this.startSlot(idx, slot);
        this.failures[idx] = 0;
        return;
      } catch (err) {
        if (this.abort.signal.aborted) return;
        this.lastError = describe(err);
        if (isBridgeError(err, 'LOGGED_OUT')) {
          this.loggedOut[idx] = true;
          this.record(`${slot.name}: logged out`);
          continue;
        }
        this.failures[idx] = (this.failures[idx] ?? 0) + 1;
        this.record(`${slot.name}: start failed (${this.failures[idx]}): ${this.lastError}`);
        // NOTE: never auto-restore the session backup here. WhatsApp's end-to-end encryption
        // state ratchets forward; rolling it back to an older snapshot gets the device unlinked
        // (observed 2026-11-12). Generic start failures are retried; the backup is for manual
        // recovery only (SessionVault.restore).
        const delay = backoffDelay(
          attempt++,
          { baseMs: this.opts.reconnectBaseMs, maxMs: this.opts.reconnectMaxMs },
          this.random,
        );
        this.log.warn('connect failed, backing off', { transport: slot.name, delayMs: delay, err });
        await this.sleep(delay);
      }
    }
  }

  private async startSlot(idx: number, slot: TransportSlot): Promise<void> {
    await this.teardown();
    await slot.vault?.snapshotIfHealthy();
    const t = slot.create({ interactive: this.interactive });
    this.transport = t;
    this.activeSlot = idx;
    this.unsubscribe.push(
      t.on('qr', (e) => this.emitter.emit('qr', e)),
      t.on('state', (s) => this.onTransportState(t, s)),
    );
    this.record(`${slot.name}: starting`);
    await withTimeout('start', this.opts.startTimeoutMs, () => t.start());
    if (this.abort.signal.aborted) return;
    await slot.vault?.markHealthy();
    this.interactive = false;
    if (this.everConnected) this.reconnects++;
    this.everConnected = true;
    this.connectedSince = this.clock.now();
    this.probeFailures = 0;
    if (idx > 0) this.health.reset();
    this.record(`${slot.name}: connected${idx > 0 ? ' (fallback)' : ''}`);
    this.setStatus('running');
  }

  private onTransportState(t: WhatsAppTransport, s: ConnectionState): void {
    if (t !== this.transport) return;
    if (s === 'logged_out') {
      this.loggedOut[this.activeSlot] = true;
      this.record(`${t.name}: logged out by WhatsApp`);
      if (this.status_ === 'running') this.requestRecovery('logged out', true);
    } else if (
      (s === 'reconnecting' || s === 'failed' || s === 'stopped') &&
      this.status_ === 'running'
    ) {
      this.requestRecovery(`transport state ${s}`);
    }
  }

  private requestRecovery(reason: string, immediate = false): void {
    if (this.status_ !== 'running') return;
    this.record(`recovering: ${reason}`);
    this.connectedSince = null;
    this.setStatus('connecting');
    // Give the library a moment to reconnect by itself before we rebuild it.
    void (immediate ? Promise.resolve() : this.sleep(this.opts.reconnectBaseMs)).then(() => {
      if (this.status_ !== 'connecting') return;
      if (this.transport?.state() === 'connected' && !immediate) {
        this.connectedSince = this.clock.now();
        this.record('transport recovered on its own');
        this.setStatus('running');
        return;
      }
      this.ensureLoop();
    });
  }

  private handleLoggedOut(): void {
    if (this.status_ === 'logged_out') return;
    this.lastRevive = this.clock.now();
    this.record('all transports logged out; QR scan required');
    this.setStatus('logged_out');
    void this.teardown();
  }

  private async tick(): Promise<void> {
    if (this.status_ !== 'running' || !this.transport) return;
    const t = this.transport;
    try {
      await withTimeout('probe', Math.min(this.opts.opTimeoutMs, 30_000), () => t.probe());
      this.probeFailures = 0;
    } catch (err) {
      if (isBridgeError(err, 'LOGGED_OUT')) {
        this.loggedOut[this.activeSlot] = true;
        this.requestRecovery('logged out', true);
        return;
      }
      this.probeFailures++;
      this.log.warn('watchdog probe failed', { failures: this.probeFailures, err });
      if (this.probeFailures >= 2) {
        this.probeFailures = 0;
        this.requestRecovery('watchdog: transport unresponsive', true);
      }
      return;
    }
    // Fail back to the primary after a while on the fallback.
    const failbackAfter = this.opts.failbackAfterMs ?? 30 * 60_000;
    if (
      this.activeSlot > 0 &&
      !this.loggedOut[0] &&
      this.connectedSince !== null &&
      this.clock.now() - this.connectedSince >= failbackAfter
    ) {
      this.failures[0] = Math.max(0, this.opts.failoverAfter - 1); // one trial, then back to fallback
      this.requestRecovery('attempting failback to primary transport', true);
    }
  }

  private async teardown(): Promise<void> {
    for (const off of this.unsubscribe) off();
    this.unsubscribe = [];
    const t = this.transport;
    this.transport = null;
    if (t && t.state() !== 'stopped') {
      await withTimeout('stop', 15_000, () => t.stop()).catch((err: unknown) =>
        this.log.warn('transport stop failed', { err }),
      );
    }
  }

  private sleep(ms: number): Promise<void> {
    const signal = this.abort.signal;
    return new Promise((resolve) => {
      if (signal.aborted) return resolve();
      const timer = setTimeout(done, ms);
      timer.unref?.();
      function done() {
        signal.removeEventListener('abort', done);
        clearTimeout(timer);
        resolve();
      }
      signal.addEventListener('abort', done);
    });
  }

  private record(event: string): void {
    this.events_.push({ at: this.clock.now(), event });
    if (this.events_.length > MAX_EVENTS) this.events_.shift();
    this.log.info(event);
  }

  private setStatus(s: SupervisorState): void {
    if (this.status_ === s) return;
    this.status_ = s;
    this.emitter.emit('state', s);
  }
}
