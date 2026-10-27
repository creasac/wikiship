import { timingSafeEqual } from 'node:crypto';
import { createServer, type Server as HttpServer } from 'node:http';
import type { App } from 'obsidian';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CfWorkerJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/cfworker';
import type { Journal } from '../provenance/journal';
import type { PathPolicy } from '../provenance/storage';
import { createToolDefinitions, type wikishipContext } from './tools';
import { createReadToolDefinitions } from './read-tools';

const HOST = '127.0.0.1';
export const DEFAULT_MCP_PORT = 27126;
const MAX_TOOL_INPUT_ELEMENTS = 64;
const MAX_MCP_REQUEST_BYTES = 16 * 1024 * 1024;

function authorized(header: string | undefined, token: string) {
  if (!header?.startsWith('Bearer ')) return false;
  const supplied = Buffer.from(header.slice(7));
  const expected = Buffer.from(token);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

function localOrigin(origin: string | undefined) {
  if (!origin) return true;
  try {
    const host = new URL(origin).hostname;
    return host === 'localhost' || host === '127.0.0.1' || host === '[::1]';
  } catch { return false; }
}

export class WikishipMcpServer {
  private http?: HttpServer;
  private readonly active = new Set<{ transport: StreamableHTTPServerTransport; mcp: McpServer }>();

  constructor(private app: App, private context: wikishipContext, private journal: Journal, private policy: PathPolicy,
    readonly port: number, private token: string, private version: string) {}

  async start() {
    if (this.http) return;
    const server = createServer((req, res) => {
      if (req.url === '/health') {
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        res.end(JSON.stringify({ ok: true, name: 'wikiship', transport: 'streamable-http' }));
        return;
      }
      if (req.url !== '/mcp' && req.url !== '/mcp/') {
        res.writeHead(404); res.end('Not found'); return;
      }
      if (!localOrigin(req.headers.origin)) {
        res.writeHead(403); res.end('Forbidden origin'); return;
      }
      if (!authorized(req.headers.authorization, this.token)) {
        res.writeHead(401, { 'www-authenticate': 'Bearer', 'cache-control': 'no-store' });
        res.end('Unauthorized'); return;
      }
      void this.handleMcpRequest(req, res).catch(() => {
        if (!res.headersSent) { res.writeHead(500); res.end('MCP request failed'); }
        else if (!res.writableEnded) res.end();
      });
    });
    this.http = server;
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => { server.off('listening', onListening); reject(error); };
      const onListening = () => { server.off('error', onError); resolve(); };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(this.port, HOST);
    }).catch(async error => {
      this.http = undefined;
      throw error;
    });
  }

  private async handleMcpRequest(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) {
    const mcp = new McpServer({ name: 'wikiship', version: this.version }, {
      maxToolInputElements: MAX_TOOL_INPUT_ELEMENTS,
      jsonSchemaValidator: new CfWorkerJsonSchemaValidator(),
    });
    for (const definition of [...createReadToolDefinitions(this.app, this.journal, this.policy), ...createToolDefinitions(this.context, this.journal)]) {
      mcp.registerTool(definition.name, {
        description: definition.description,
        inputSchema: definition.inputSchema,
        annotations: definition.annotations,
      }, args => definition.callback(args));
    }
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
      maxRequestBodySize: MAX_MCP_REQUEST_BYTES,
    });
    const active = { transport, mcp };
    this.active.add(active);
    const cleanup = () => {
      if (!this.active.delete(active)) return;
      void transport.close().catch(() => {});
      void mcp.close().catch(() => {});
    };
    res.once('close', cleanup);
    res.once('finish', cleanup);
    try {
      await mcp.connect(transport);
      await transport.handleRequest(req, res);
    } catch (error) {
      cleanup();
      throw error;
    }
  }

  async close() {
    const http = this.http;
    this.http = undefined;
    await Promise.all([...this.active].map(async ({ transport, mcp }) => {
      await transport.close().catch(() => {});
      await mcp.close().catch(() => {});
    }));
    this.active.clear();
    if (http?.listening) await new Promise<void>(resolve => http.close(() => resolve()));
  }

  get url() { return `http://${HOST}:${this.port}/mcp`; }
}

export function codexConfig(url: string, token: string) {
  const header = `Bearer ${token}`.replaceAll('\\', '\\\\').replaceAll('"', '\\"');
  return `[mcp_servers.wikiship]\nurl = "${url}"\nhttp_headers = { "Authorization" = "${header}" }`;
}
