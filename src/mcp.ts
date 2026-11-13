/**
 * MCP (Model Context Protocol) stdio server for @ceki/sdk.
 *
 * Exposes browser.ceki.me rentals as MCP tools so any MCP client (Claude
 * Code, Cline, Cursor) can drive a real browser without writing CDP code.
 * Each tool is a thin wrapper over the existing SDK methods — no new
 * browser logic lives here.
 *
 * Run with: `ceki mcp` (env: CEKI_API_KEY / CEKI_TOKEN).
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { connect } from './client.js';
import type { Client } from './client.js';
import type { Browser } from './browser.js';

const VERSION = '1.0.0';

/** Resolve the API key the same way the rest of the CLI does. */
function resolveApiKey(): string {
  const key = process.env.CEKI_API_KEY ?? process.env.CEKI_TOKEN;
  if (!key) {
    throw new Error('CEKI_API_KEY (or CEKI_TOKEN) not set — MCP server cannot authenticate');
  }
  return key;
}

/** Result content helpers — normalize any tool return into MCP text content. */
function text(content: unknown): { content: { type: 'text'; text: string }[] } {
  const body = typeof content === 'string' ? content : JSON.stringify(content);
  return { content: [{ type: 'text', text: body }] };
}

export class CekiMcpServer {
  private apiKey: string;
  private client: Client | null = null;
  private connectError: Error | null = null;
  private browser: Browser | null = null;
  private mcp: McpServer;

  constructor(apiKey: string) {
    this.apiKey = apiKey;
    this.mcp = new McpServer({ name: 'ceki', version: VERSION }, {
      instructions:
        'Rent and drive real browsers from browser.ceki.me. Call browser_rent first, ' +
        'use the other browser_* tools to automate, then browser_release when done.',
    });
    this.registerTools();
  }

  /** Create client + connect lazily — first browser_rent triggers the relay connect. */
  static create(apiKey: string): CekiMcpServer {
    return new CekiMcpServer(apiKey);
  }

  /** Lazy connect — only browser_rent needs the WS relay; search is plain HTTP. */
  private async ensureClient(): Promise<Client> {
    if (this.client) return this.client;
    if (this.connectError) throw this.connectError;
    try {
      this.client = await connect(this.apiKey, { reconnect: false });
      return this.client;
    } catch (err) {
      this.connectError = err instanceof Error ? err : new Error(String(err));
      throw this.connectError;
    }
  }

  private requireBrowser(): Browser {
    if (!this.browser) {
      throw new Error('no active session — call browser_rent first');
    }
    return this.browser;
  }

  private registerTools(): void {
    const mcp = this.mcp;

    mcp.registerTool('browser_rent', {
      title: 'Rent a browser',
      description:
        'Rent a real browser by schedule_id (find one via browser_search). ' +
        'Starts an active session — exactly one at a time. Call browser_release ' +
        'before renting again.',
      inputSchema: {
        scheduleId: z.number().int().describe('Schedule ID of the browser to rent'),
        mode: z.enum(['incognito', 'main']).optional().describe('Profile mode'),
        maskingMode: z.boolean().optional().describe('Enable fingerprint masking'),
      },
    }, async (args) => {
      if (this.browser) {
        throw new Error('session already active, call browser_release first');
      }
      const client = await this.ensureClient();
      const browser = await client.rent(args.scheduleId, {
        mode: args.mode,
        maskingMode: args.maskingMode,
      });
      this.browser = browser;
      return text({ ok: true, session_id: browser.sessionId });
    });

    mcp.registerTool('browser_search', {
      title: 'Search available browsers',
      description:
        'List browsers available for rent, optionally filtered by geo/language ' +
        '(filters applied server-side, e.g. { geo: "US", language: "en" }).',
      inputSchema: {
        filters: z.record(z.string(), z.unknown()).optional().describe('Filter map'),
        limit: z.number().int().positive().optional().describe('Max results'),
      },
    }, async (args) => {
      const rows = await this.ensureClient().then((c) => c.search(args.filters, args.limit));
      return text(rows);
    });

    mcp.registerTool('browser_navigate', {
      title: 'Navigate to URL',
      description: 'Navigate the active browser to a URL.',
      inputSchema: {
        url: z.string().describe('URL to navigate to'),
        timeout: z.number().int().positive().optional().describe('CDP timeout ms'),
      },
    }, async (args) => {
      const result = await this.requireBrowser().navigate(args.url, args.timeout ?? 30000);
      return text(result);
    });

    mcp.registerTool('browser_click', {
      title: 'Click at coordinates',
      description: 'Click at (x, y) page coordinates in the active browser.',
      inputSchema: {
        x: z.number().describe('X coordinate'),
        y: z.number().describe('Y coordinate'),
      },
    }, async (args) => {
      await this.requireBrowser().click(args.x, args.y);
      return text({ ok: true });
    });

    mcp.registerTool('browser_type', {
      title: 'Type text',
      description: 'Type text into the active browser (focused element by default, or a CSS selector).',
      inputSchema: {
        text: z.string().describe('Text to type'),
        selector: z.string().optional().describe('Optional CSS selector to focus first'),
      },
    }, async (args) => {
      await this.requireBrowser().type(args.text, { selector: args.selector });
      return text({ ok: true });
    });

    mcp.registerTool('browser_scroll', {
      title: 'Scroll the page',
      description: 'Scroll the active browser. deltaY negative scrolls down.',
      inputSchema: {
        x: z.number().optional().describe('X base coordinate'),
        y: z.number().optional().describe('Y base coordinate'),
        deltaX: z.number().optional().describe('Horizontal scroll delta'),
        deltaY: z.number().optional().describe('Vertical scroll delta (negative = down)'),
      },
    }, async (args) => {
      await this.requireBrowser().scroll({
        x: args.x, y: args.y, deltaX: args.deltaX, deltaY: args.deltaY,
      });
      return text({ ok: true });
    });

    mcp.registerTool('browser_screenshot', {
      title: 'Take a screenshot',
      description:
        'Take a screenshot of the active browser. Returns base64 image data ' +
        '(PNG) — the client should decode it to an image.',
      inputSchema: {
        fullPage: z.boolean().optional().describe('Capture the full scrollable page'),
      },
    }, async (args) => {
      const shot = await this.requireBrowser().screenshot({ format: 'base64', fullPage: args.fullPage ?? false });
      const data = (shot as { data: string }).data;
      return {
        content: [
          { type: 'text', text: data },
          { type: 'text', text: `\n[screenshot] fullPage=${args.fullPage ?? false} base64-png` },
        ],
      };
    });

    mcp.registerTool('browser_snapshot', {
      title: 'Snapshot the page',
      description: 'Take a screenshot plus the latest chat messages from the active browser.',
      inputSchema: {},
    }, async () => {
      const snap = await this.requireBrowser().snapshot();
      return text({ screenshot: snap.screenshot, chat: snap.chat, ts: snap.ts.toISOString() });
    });

    mcp.registerTool('browser_cdp', {
      title: 'Send raw CDP command',
      description:
        'Escape hatch: send a raw Chrome DevTools Protocol command to the active ' +
        'browser, e.g. { method: "DOM.getDocument" }.',
      inputSchema: {
        method: z.string().describe('CDP method name'),
        params: z.record(z.string(), z.unknown()).optional().describe('CDP params'),
        timeout: z.number().int().positive().optional().describe('CDP timeout ms'),
      },
    }, async (args) => {
      const result = await this.requireBrowser().send(
        { method: args.method, params: args.params ?? {} },
        args.timeout ?? 30000,
      );
      return text(result);
    });

    mcp.registerTool('browser_captcha', {
      title: 'Request captcha solving',
      description:
        'Request the human provider solve a captcha in the active browser via chat. ' +
        'Returns the solve result; acceptance/completion timeouts in seconds.',
      inputSchema: {
        acceptanceTimeout: z.number().int().optional().describe('Seconds to wait for acceptance (>=30)'),
        completionTimeout: z.number().int().optional().describe('Seconds to wait for completion (>=30)'),
        autoAccept: z.boolean().optional().describe('Auto-accept the proposed work'),
      },
    }, async (args) => {
      const result = await this.requireBrowser().requestCaptcha({
        acceptanceTimeout: args.acceptanceTimeout ?? 60,
        completionTimeout: args.completionTimeout ?? 120,
        autoAccept: args.autoAccept ?? true,
      });
      return text({
        solved: result.solved,
        proofMessageId: result.proofMessageId,
        cancelReason: result.cancelReason,
        childEventId: result.childEventId,
      });
    });

    mcp.registerTool('browser_release', {
      title: 'Release the browser',
      description:
        'End the active rent session and free the browser. Always call when done ' +
        '— an unreleased session keeps burning balance.',
      inputSchema: {},
    }, async () => {
      const browser = this.requireBrowser();
      this.browser = null;
      await browser.release();
      return text({ ok: true });
    });
  }

  async run(): Promise<void> {
    const transport = new StdioServerTransport();
    await this.mcp.connect(transport);
  }

  /** Close the active session if any (SIGINT/SIGTERM handler). */
  async close(): Promise<void> {
    if (this.browser) {
      const browser = this.browser;
      this.browser = null;
      await browser.release().catch(() => {});
    }
    if (this.client) {
      await this.client.close().catch(() => {});
    }
  }
}

/** Entry point for `ceki mcp`. */
export async function main(): Promise<void> {
  const apiKey = resolveApiKey();
  const server = CekiMcpServer.create(apiKey);

  // On shutdown, release the active session so the rent doesn't hang and
  // burn balance (project_session_lifecycle: disconnect does NOT finish the
  // session — an explicit release/close is required).
  let closing = false;
  const shutdown = async (): Promise<void> => {
    if (closing) return;
    closing = true;
    await server.close();
    process.exit(0);
  };
  process.on('SIGINT', () => { void shutdown(); });
  process.on('SIGTERM', () => { void shutdown(); });

  await server.run();
}
