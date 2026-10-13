#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema, ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';

// Deliberately exact names: never forward arbitrary commands, host writes, or
// tools added later merely because their names share a prefix. The host read
// tools below were inspected in Local REST API 5.3.0; no annotations are trusted
// as a substitute for this explicit list.
export const ALLOWED_TOOLS = Object.freeze([
  'vault_list', 'vault_read', 'vault_get_document_map', 'active_file_get_path',
  'search_query', 'search_simple', 'tag_list',
  'wikidiff_get_editor_state', 'wikidiff_get_selection',
  'wikidiff_get_file_state',
  'wikidiff_replace_range', 'wikidiff_replace_selection', 'wikidiff_insert_at_cursor',
  'wikidiff_patch_section', 'wikidiff_create_file', 'wikidiff_delete_file',
  'wikidiff_move_file', 'wikidiff_rename_file', 'wikidiff_get_changes',
]);
const allowed = new Set(ALLOWED_TOOLS);
const failure = message => ({ isError: true, content: [{ type: 'text', text: message }] });

/** Construct an MCP tools-only proxy over an already connected upstream client. */
export function createBridge(upstream) {
  const server = new Server({ name: 'wikidiff', version: '0.1.4' }, { capabilities: { tools: { listChanged: true } } });
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const tools = [];
    let cursor;
    // Host tool lists are small. Bound pagination rather than trusting an
    // accidentally cyclic nextCursor supplied by an upstream server.
    for (let page = 0; page < 20; page++) {
      let batch;
      try { batch = await upstream.listTools(cursor ? { cursor } : undefined); }
      catch { throw new Error('Cannot list wikidiff tools. Check the local host connection.'); }
      tools.push(...batch.tools.filter(tool => allowed.has(tool.name)));
      cursor = batch.nextCursor;
      if (!cursor) return { tools };
    }
    throw new Error('The local host returned too many tool-list pages.');
  });
  server.setRequestHandler(CallToolRequestSchema, async request => {
    if (!allowed.has(request.params.name)) return failure('This tool is not available through the wikidiff bridge.');
    try {
      return await upstream.callTool({ name: request.params.name, arguments: request.params.arguments ?? {} });
    } catch {
      // Transport errors can include request details. Never echo auth headers or
      // the configured endpoint; application isError results pass through above.
      return failure('The local wikidiff host request failed. Check Obsidian and its Local REST API connection.');
    }
  });
  upstream.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
    if (server.transport) await server.sendToolListChanged();
  });
  return server;
}

export function readConfiguration(env) {
  let url;
  try { url = new URL(env.WIKIDIFF_MCP_URL || 'https://127.0.0.1:27124/mcp/'); }
  catch { throw new Error('WIKIDIFF_MCP_URL must be a local MCP URL.'); }
  if (!['http:', 'https:'].includes(url.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
    !['/mcp', '/mcp/'].includes(url.pathname) || url.search || url.hash || url.username || url.password) {
    throw new Error('WIKIDIFF_MCP_URL must point to /mcp on localhost with no credentials, query, or fragment.');
  }
  const token = env.WIKIDIFF_API_KEY;
  if (typeof token !== 'string' || token.length === 0 || /[\r\n]/.test(token)) {
    throw new Error('Set WIKIDIFF_API_KEY to the Local REST API key in the client environment.');
  }
  return { url, token };
}

export async function main() {
  const { url, token } = readConfiguration(process.env);
  const upstream = new Client({ name: 'wikidiff-bridge', version: '0.1.4' });
  const transport = new StreamableHTTPClientTransport(url, {
    requestInit: { headers: { Authorization: `Bearer ${token}` }, redirect: 'error' },
  });
  try { await upstream.connect(transport); }
  catch {
    await upstream.close().catch(() => {});
    throw new Error('Cannot connect to the local MCP host. Check the URL, API key, certificate trust, and Obsidian.');
  }
  const server = createBridge(upstream);
  let closing = false;
  const close = async () => {
    if (closing) return;
    closing = true;
    await Promise.allSettled([server.close(), upstream.close()]);
  };
  server.onclose = () => { void close(); };
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { void close(); });
  await server.connect(new StdioServerTransport());
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    // Only our own configuration/connection errors reach here.
    process.stderr.write(`wikidiff bridge: ${error instanceof Error ? error.message : 'Startup failed.'}\n`);
    process.exitCode = 1;
  });
}
