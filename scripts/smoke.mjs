// Smoke test of the BUILT package over real stdio, exactly as an MCP client launches it.
// Uses the built-in demo transport, so it needs no WhatsApp account.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const transport = new StdioClientTransport({
  command: process.execPath,
  args: ['dist/index.js'],
  env: {
    ...process.env,
    WA_BRIDGE_TRANSPORT: 'fake',
    WA_BRIDGE_DATA_DIR: mkdtempSync(join(tmpdir(), 'wa-bridge-smoke-')),
    WA_BRIDGE_SEND_ENABLED: 'true',
    WA_BRIDGE_LOG_LEVEL: 'warn',
  },
  stderr: 'inherit',
});
const client = new Client({ name: 'smoke', version: '0' });

const fail = (msg) => {
  console.error(`SMOKE FAIL: ${msg}`);
  process.exit(1);
};
const text = (r) => r.content?.[0]?.text ?? '';

await client.connect(transport);
const { tools } = await client.listTools();
if (tools.length !== 9) fail(`expected 9 tools, got ${tools.length}`);

const status = JSON.parse(text(await client.callTool({ name: 'whatsapp_status', arguments: {} })));
if (!['running', 'connecting'].includes(status.state)) fail(`unexpected state ${status.state}`);

const chats = await client.callTool({ name: 'whatsapp_list_chats', arguments: { limit: 5 } });
if (chats.isError || !text(chats).includes('Alice (demo)')) fail(`list_chats: ${text(chats)}`);

const prep = await client.callTool({
  name: 'whatsapp_send_message',
  arguments: { to: 'Alice', text: 'smoke test' },
});
const { confirmationToken } = JSON.parse(text(prep));
const sent = JSON.parse(
  text(await client.callTool({ name: 'whatsapp_confirm_send', arguments: { confirmationToken } })),
);
if (sent.status !== 'sent') fail(`send: ${JSON.stringify(sent)}`);

await client.close();
console.log('SMOKE OK: 9 tools, status, list, two-step send');
