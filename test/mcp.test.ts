import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it } from 'vitest';
import { createMcpServer } from '../src/mcp/server.js';
import { fakeApp } from './helpers.js';

async function setup(send = {}) {
  const app = await fakeApp({ send });
  app.supervisor.start();
  await app.supervisor.waitUntilConnected(1_000);
  const server = createMcpServer(app);
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0' });
  await Promise.all([server.connect(a), client.connect(b)]);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = await client.callTool({ name, arguments: args });
    const text = (r.content as { type: string; text: string }[])[0]?.text ?? '';
    return { isError: Boolean(r.isError), text };
  };
  return {
    app,
    client,
    call,
    close: async () => {
      await client.close();
      await app.supervisor.stop();
    },
  };
}

describe('MCP server', () => {
  it('exposes the expected tools with safety annotations', async () => {
    const { client, close } = await setup();
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual([
      'whatsapp_confirm_send',
      'whatsapp_get_messages',
      'whatsapp_list_chats',
      'whatsapp_login',
      'whatsapp_mark_read',
      'whatsapp_search_contacts',
      'whatsapp_search_messages',
      'whatsapp_send_message',
      'whatsapp_status',
    ]);
    expect(tools.find((t) => t.name === 'whatsapp_list_chats')?.annotations?.readOnlyHint).toBe(
      true,
    );
    expect(
      tools.find((t) => t.name === 'whatsapp_confirm_send')?.annotations?.destructiveHint,
    ).toBe(true);
    await close();
  });

  it('wraps message content as untrusted data', async () => {
    const { call, close } = await setup();
    const r = await call('whatsapp_get_messages', { chat: 'Alice' });
    expect(r.isError).toBe(false);
    expect(r.text).toContain('<untrusted_messages>');
    expect(r.text).toContain('lunch tomorrow?');
    await close();
  });

  it('runs the two-step send flow end to end', async () => {
    const { app, call, close } = await setup();
    const prep = await call('whatsapp_send_message', { to: 'Alice', text: 'See you at 1' });
    const { confirmationToken } = JSON.parse(prep.text) as { confirmationToken: string };
    expect(app.transports[0]!.sent()).toHaveLength(0);
    const done = await call('whatsapp_confirm_send', { confirmationToken });
    expect(JSON.parse(done.text)).toMatchObject({ status: 'sent', to: 'Alice' });
    expect(app.transports[0]!.sent()).toHaveLength(1);
    await close();
  });

  it('returns structured, actionable errors instead of throwing', async () => {
    const { call, close } = await setup({ enabled: false });
    const r = await call('whatsapp_send_message', { to: 'Alice', text: 'x' });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/^SEND_DISABLED: /);
    await close();
  });

  it('reports status', async () => {
    const { call, close } = await setup();
    const s = JSON.parse((await call('whatsapp_status')).text) as {
      state: string;
      sendingEnabled: boolean;
    };
    expect(s).toMatchObject({ state: 'running', sendingEnabled: true });
    await close();
  });
});
