import { existsSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createApp, type App } from '../app.js';
import { loadConfig, sessionDir, type Config } from '../config.js';
import { describe } from '../domain/errors.js';
import { createMcpServer, renderQr } from '../mcp/server.js';
import { findBrowser } from '../transport/wwebjs/browser.js';
import { VERSION } from '../version.js';
import { runCanary } from './canary.js';

const HELP = `whatsapp-bridge-mcp ${VERSION}

Usage: whatsapp-bridge-mcp [command] [options]

Commands:
  serve            Run the MCP server on stdio (default)
  login            Link this device by scanning a QR code
  status           Connect and print health/status as JSON
  logout           Unlink this device and delete its local session
  doctor           Check the environment (Node, browser, config, session)
  canary           Live end-to-end self-test (used by CI against a test number)

Options:
  --profile <name>      Session profile (default: "default")
  --transport <name>    wwebjs | baileys | fake
  -h, --help            Show help
  -v, --version         Show version

Configuration: <dataDir>/config.json and WA_BRIDGE_* environment variables (see README).`;

export async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      profile: { type: 'string' },
      transport: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
      version: { type: 'boolean', short: 'v' },
      report: { type: 'string' },
    },
  });
  if (values.help) return print(HELP, 0);
  if (values.version) return print(VERSION, 0);

  const env = { ...process.env };
  if (values.profile) env.WA_BRIDGE_PROFILE = values.profile;
  if (values.transport) env.WA_BRIDGE_TRANSPORT = values.transport;

  let config: Config;
  try {
    config = loadConfig(env);
  } catch (err) {
    console.error(describe(err));
    return 2;
  }

  const command = positionals[0] ?? 'serve';
  switch (command) {
    case 'serve':
      return serve(config);
    case 'login':
      return login(config);
    case 'status':
      return status(config);
    case 'logout':
      return logout(config);
    case 'doctor':
      return doctor(config);
    case 'canary':
      return runCanary(await createApp(config), values.report);
    default:
      console.error(`Unknown command "${command}".\n\n${HELP}`);
      return 2;
  }
}

async function serve(config: Config): Promise<number> {
  const app = await createApp(config);
  const server = createMcpServer(app);
  app.supervisor.start();
  await server.connect(new StdioServerTransport());
  app.log.info('MCP server ready', { version: VERSION, transport: config.transport });

  return new Promise<number>((resolve) => {
    let closing = false;
    const shutdown = (reason: string) => {
      if (closing) return;
      closing = true;
      app.log.info('shutting down', { reason });
      const hardExit = setTimeout(() => resolve(0), 10_000);
      hardExit.unref();
      void Promise.allSettled([app.supervisor.stop(), server.close()]).then(() => resolve(0));
    };
    process.once('SIGINT', () => shutdown('SIGINT'));
    process.once('SIGTERM', () => shutdown('SIGTERM'));
    process.stdin.once('close', () => shutdown('stdin closed'));
  });
}

async function login(config: Config): Promise<number> {
  const app = await createApp(config);
  app.supervisor.onQr(({ qr }) => {
    console.log('\nScan with WhatsApp: Settings > Linked devices > Link a device\n');
    console.log(renderQr(qr));
  });
  const first = await app.supervisor.beginInteractiveLogin(config.resilience.startTimeoutMs);
  try {
    await app.supervisor.waitUntilConnected(config.resilience.startTimeoutMs);
    console.log(first ? '\nLinked successfully.' : '\nAlready linked; session is valid.');
    return 0;
  } catch (err) {
    console.error(`\nLogin failed: ${describe(err)}`);
    return 1;
  } finally {
    await app.supervisor.stop();
  }
}

async function withConnected<T>(config: Config, fn: (app: App) => Promise<T>): Promise<T> {
  const app = await createApp(config);
  app.supervisor.start();
  try {
    await app.supervisor
      .waitUntilConnected(config.resilience.startTimeoutMs)
      .catch(() => undefined);
    return await fn(app);
  } finally {
    await app.supervisor.stop();
  }
}

async function status(config: Config): Promise<number> {
  return withConnected(config, async (app) => {
    const s = app.service.status();
    console.log(JSON.stringify(s, null, 2));
    return s.state === 'running' ? 0 : 1;
  });
}

async function logout(config: Config): Promise<number> {
  const app = await createApp(config);
  app.supervisor.start();
  await app.supervisor.waitUntilConnected(60_000).catch(() => undefined);
  await app.supervisor.logout();
  console.log('Logged out and local session deleted.');
  return 0;
}

async function doctor(config: Config): Promise<number> {
  const checks: [string, boolean, string][] = [];
  const major = Number(process.versions.node.split('.')[0]);
  checks.push(['Node.js >= 20', major >= 20, process.versions.node]);
  checks.push(['Config valid', true, `${config.dataDir} (profile ${config.profile})`]);
  if (config.transport === 'wwebjs' || config.fallbackTransport === 'wwebjs') {
    let browser: string | undefined;
    let note = '';
    try {
      browser = findBrowser(config.browserPath);
    } catch (err) {
      note = describe(err);
    }
    checks.push([
      'Browser for wwebjs',
      Boolean(browser),
      browser ?? (note || 'none found; install Chrome or set WA_BRIDGE_BROWSER_PATH'),
    ]);
  }
  for (const t of [config.transport, config.fallbackTransport]) {
    if (t === 'none' || t === 'fake') continue;
    const dir = sessionDir(config, t);
    checks.push([
      `Session (${t})`,
      existsSync(dir),
      existsSync(dir) ? dir : 'not linked; run `login`',
    ]);
  }
  checks.push(['Sending', true, config.send.enabled ? 'enabled' : 'disabled (read-only)']);
  for (const [name, ok, detail] of checks)
    console.log(`${ok ? 'OK  ' : 'FAIL'}  ${name}: ${detail}`);
  return checks.every(([, ok]) => ok) ? 0 : 1;
}

function print(s: string, code: number): number {
  console.log(s);
  return code;
}
