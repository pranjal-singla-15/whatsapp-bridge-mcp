import { createRequire } from 'node:module';
import { join } from 'node:path';
import { type Config, sessionDir, stateDir, type TransportName } from './config.js';
import { RateLimiter } from './core/rateLimiter.js';
import { WhatsAppService } from './core/service.js';
import { SessionVault } from './core/sessionVault.js';
import { Supervisor, type TransportSlot } from './core/supervisor.js';
import { createLogger, type Logger } from './logger.js';
import type { WhatsAppTransport } from './transport/transport.js';
import { systemClock, type Clock } from './util/time.js';

export interface App {
  config: Config;
  log: Logger;
  supervisor: Supervisor;
  service: WhatsAppService;
}

export interface AppOverrides {
  clock?: Clock;
  log?: Logger;
  /** Replace transport construction (tests). */
  transportFactory?: (name: TransportName, opts: { interactive: boolean }) => WhatsAppTransport;
}

/**
 * Composition root: the only place where concrete implementations are chosen and wired.
 * Real transports are loaded lazily so the fake/test path never imports puppeteer or Baileys.
 */
export async function createApp(config: Config, overrides: AppOverrides = {}): Promise<App> {
  const clock = overrides.clock ?? systemClock;
  const log = overrides.log ?? createLogger(config.logLevel, { profile: config.profile });

  const names: TransportName[] = [config.transport];
  if (config.fallbackTransport !== 'none') names.push(config.fallbackTransport);

  const slots: TransportSlot[] = [];
  for (const name of names) {
    const factory = overrides.transportFactory ?? (await transportFactoryFor(name, config, log));
    slots.push({
      name,
      create: (opts) => factory(name, opts),
      ...(name === 'fake' || overrides.transportFactory
        ? {}
        : { vault: new SessionVault(sessionDir(config, name), log.child({ transport: name })) }),
    });
  }

  const supervisor = new Supervisor(
    slots,
    config.resilience,
    clock,
    log.child({ component: 'supervisor' }),
  );
  const limiter = new RateLimiter(config.send, clock, join(stateDir(config), 'send-log.json'));
  const service = new WhatsAppService(
    supervisor,
    limiter,
    config.send,
    clock,
    log.child({ component: 'service' }),
  );
  return { config, log, supervisor, service };
}

/** Known-good WhatsApp Web builds shipped with this release (updated by the canary). */
function shippedPins(): string[] {
  try {
    const file = createRequire(import.meta.url)('./transport/wwebjs/pins.json') as {
      versions?: unknown;
    };
    return Array.isArray(file.versions)
      ? file.versions.filter((v): v is string => typeof v === 'string')
      : [];
  } catch {
    return [];
  }
}

export async function transportFactoryFor(
  name: TransportName,
  config: Config,
  log: Logger,
): Promise<NonNullable<AppOverrides['transportFactory']>> {
  switch (name) {
    case 'wwebjs': {
      const [{ WwebjsTransport }, { VersionSelector }] = await Promise.all([
        import('./transport/wwebjs/WwebjsTransport.js'),
        import('./transport/wwebjs/versionSelector.js'),
      ]);
      const versions = new VersionSelector(
        config.pinnedWebVersions.length ? config.pinnedWebVersions : shippedPins(),
        join(stateDir(config), 'web-version.json'),
      );
      return (_n, { interactive }) =>
        new WwebjsTransport({
          sessionDir: sessionDir(config, 'wwebjs'),
          allowQr: interactive,
          headful: config.headful,
          browserPath: config.browserPath,
          versions,
          log: log.child({ transport: 'wwebjs' }),
        });
    }
    case 'baileys': {
      const { BaileysTransport } = await import('./transport/baileys/BaileysTransport.js');
      return (_n, { interactive }) =>
        new BaileysTransport({
          sessionDir: sessionDir(config, 'baileys'),
          allowQr: interactive,
          log: log.child({ transport: 'baileys' }),
        });
    }
    case 'fake': {
      const { createDemoTransport } = await import('./transport/fake/demo.js');
      return () => createDemoTransport();
    }
  }
}
