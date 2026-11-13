import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import * as path from 'node:path';

const CLI_PATH = path.resolve(__dirname, '../dist/cli.js');

const EXPECTED_TOOLS = [
  'browser_rent',
  'browser_search',
  'browser_navigate',
  'browser_click',
  'browser_type',
  'browser_scroll',
  'browser_screenshot',
  'browser_snapshot',
  'browser_cdp',
  'browser_captcha',
  'browser_release',
];

describe('MCP server', () => {
  it('ceki mcp starts and tools/list returns the 11 browser tools', async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [CLI_PATH, 'mcp'],
      env: { ...process.env, CEKI_API_KEY: process.env.CEKI_API_KEY ?? process.env.CEKI_AGENT_TOKEN ?? 'ag_test' },
    });
    const client = new Client({ name: 'ceki-mcp-test', version: '0.0.0' });
    await client.connect(transport);

    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual([...EXPECTED_TOOLS].sort());

    await client.close();
  });
});
