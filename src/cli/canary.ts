import { randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import type { App } from '../app.js';
import { describe } from '../domain/errors.js';
import { VERSION } from '../version.js';

interface Check {
  name: string;
  ok: boolean;
  ms: number;
  error?: string;
}

export interface CanaryReport {
  ok: boolean;
  at: string;
  bridgeVersion: string;
  transport: string | null;
  libraryVersion: string | null;
  remoteVersion: string | null;
  checks: Check[];
}

/**
 * Live end-to-end self-test against a dedicated test number. Exercises every capability
 * through the same service layer the MCP tools use. Exit code 0 = healthy.
 *
 * Env: WA_BRIDGE_CANARY_TARGET = chat id that receives the test message (e.g. a second
 * test number, or the test number's own "message yourself" chat).
 */
export async function runCanary(app: App, reportPath?: string): Promise<number> {
  const { supervisor, service, config } = app;
  const target = process.env.WA_BRIDGE_CANARY_TARGET;
  const checks: Check[] = [];
  const step = async (name: string, fn: () => Promise<void>) => {
    const t0 = Date.now();
    try {
      await fn();
      checks.push({ name, ok: true, ms: Date.now() - t0 });
    } catch (err) {
      checks.push({ name, ok: false, ms: Date.now() - t0, error: describe(err) });
    }
  };

  supervisor.start();
  await step('connect', () => supervisor.waitUntilConnected(config.resilience.startTimeoutMs));
  const connected = checks[0]?.ok === true;

  if (connected) {
    let firstChat: string | undefined;
    await step('listChats', async () => {
      const chats = await service.listChats({
        limit: 10,
        includeArchived: false,
        unreadOnly: false,
      });
      if (chats.length === 0) throw new Error('no chats returned');
      firstChat = chats[0]!.id;
    });
    await step('getMessages', async () => {
      const id = target ?? firstChat;
      if (!id) throw new Error('no chat available');
      await service.getMessages(id, 5);
    });
    await step('searchContacts', async () => {
      await service.searchContacts('a', 5);
    });
    await step('searchMessages', async () => {
      await service.searchMessages('the', { limit: 5 });
    });
    if (target) {
      const marker = `canary ${new Date().toISOString()} ${randomBytes(3).toString('hex')}`;
      await step('sendText', async () => {
        if (!config.send.enabled) throw new Error('sending disabled in canary profile');
        const res = await service.prepareSend({ to: target, text: marker });
        if (res.status !== 'sent')
          throw new Error('canary profile must set send.requireConfirmation=false');
      });
      await step('verifyDelivery', async () => {
        await new Promise((r) => setTimeout(r, 3000));
        const { messages } = await service.getMessages(target, 20);
        if (!messages.some((m) => m.fromMe && m.text === marker))
          throw new Error('sent message not found in chat');
      });
    }
  }

  const s = supervisor.status();
  const report: CanaryReport = {
    ok: checks.every((c) => c.ok),
    at: new Date().toISOString(),
    bridgeVersion: VERSION,
    transport: s.activeTransport,
    libraryVersion: s.transportInfo?.libraryVersion ?? null,
    remoteVersion: s.transportInfo?.remoteVersion ?? null,
    checks,
  };
  await supervisor.stop();

  const out = JSON.stringify(report, null, 2);
  console.log(out);
  if (reportPath) writeFileSync(reportPath, out);
  return report.ok ? 0 : 1;
}
