import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { createToolDefinitions, type EditorTarget, type WikiShipContext } from '../src/mcp/tools';
import { Journal } from '../src/provenance/journal';
import { headingRanges, pin, resolve, sameHeading } from '../src/context/references';
import { hash, textSnapshot, type Operation, type Snapshot, type State, type StateStore, type WorkspaceFiles } from '../src/model';

class MemoryStore implements StateStore {
  saved: State | null = null;
  async load() { return this.saved; }
  async save(state: State) { this.saved = structuredClone(state); }
}
class MemoryFiles implements WorkspaceFiles {
  values = new Map<string, Snapshot>();
  async read(path: string) { return this.values.get(path) ?? null; }
  async apply(op: Operation, reverse: boolean) {
    const source = reverse && op.kind === 'move' ? op.target! : op.path;
    const expected = reverse ? op.after : op.before;
    if ((await this.read(source))?.hash !== expected?.hash) throw new Error('Conflict: changed during write.');
    if (op.kind === 'move') {
      const target = reverse ? op.path : op.target!;
      if (this.values.has(target)) throw new Error('Conflict: destination exists.');
      this.values.set(target, expected!); this.values.delete(source);
    } else {
      const next = reverse ? op.before : op.after;
      if (next) this.values.set(source, next); else this.values.delete(source);
    }
  }
}
function headings(text: string) {
  return headingRanges([...text.matchAll(/^(#{1,6}) (.+)$/gm)].map(match => ({
    heading: match[2]!, level: match[1]!.length, position: { start: { offset: match.index } },
  })), text.length);
}
class Context implements WikiShipContext {
  active = 'A.md'; from = 0; to = 5;
  constructor(private journal: Journal, private files: MemoryFiles) {}
  private text(path = this.active) { const file = this.files.values.get(path); if (!file) throw new Error('Missing file.'); return file.data; }
  async selectionTarget(): Promise<EditorTarget> { return { path: this.active, from: this.from, to: this.to, fileHash: hash(this.text()) }; }
  async cursorTarget() { return { ...await this.selectionTarget(), from: this.to, to: this.to }; }
  async sectionTarget(path?: string[]) {
    const text = this.text(); const found = headings(text).filter(h => sameHeading(h.path, path ?? ['Architecture', 'Storage']));
    if (found.length !== 1) throw new Error('Section is missing or ambiguous.');
    return { path: this.active, from: found[0]!.from, to: found[0]!.to, fileHash: hash(text) };
  }
  async getEditorState() { return { activeFile: this.active, selection: await this.selectionTarget() }; }
  async getSelection() { return { ...await this.selectionTarget(), content: this.text().slice(this.from, this.to) }; }
  async getContext() { return this.journal.state.context.map(item => resolve(item, this.text(item.path), headings(this.text(item.path)))); }
  async addSelection() { return this.journal.addContext(pin('selection', this.active, this.text(), this.from, this.to)); }
  async addSection() { const target = await this.sectionTarget(); return this.journal.addContext(pin('section', this.active, this.text(), target.from, target.to, ['Architecture', 'Storage'])); }
  async addNote(path = this.active) { return this.journal.addContext(pin('note', path, this.text(path))); }
}

const closers: (() => Promise<void>)[] = [];
afterEach(async () => { await Promise.allSettled(closers.splice(0).map(close => close())); });

async function fixture() {
  const files = new MemoryFiles(), store = new MemoryStore(), journal = new Journal(store, files);
  files.values.set('A.md', textSnapshot('First paragraph.\n\nSecond paragraph.\n'));
  files.values.set('B.md', textSnapshot('# Architecture\n\n## Storage\nOriginal design.\n\n## API\nPreserve this.\n'));
  await journal.load();
  const context = new Context(journal, files);
  const definitions = createToolDefinitions(context, journal);
  const server = new McpServer({ name: 'local-rest-api-fixture', version: '5.3.0' });
  for (const definition of definitions) {
    server.registerTool(definition.name, {
      description: definition.description, inputSchema: definition.inputSchema,
      annotations: definition.annotations,
    }, definition.callback);
  }
  const client = new Client({ name: 'wikiship-test-client', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport); await client.connect(clientTransport);
  closers.push(() => client.close(), () => server.close());
  return { files, store, journal, context, definitions, server, client };
}
function data(result: Awaited<ReturnType<Client['callTool']>>): Record<string, unknown> {
  const parsed = result as CallToolResult;
  expect(parsed.isError, JSON.stringify(parsed.content)).not.toBe(true);
  const block = parsed.content[0];
  if (!block || block.type !== 'text') throw new Error('Expected JSON text result.');
  return JSON.parse(block.text) as Record<string, unknown>;
}

describe('WikiShip through a real MCP SDK client', () => {
  it('lists schemas, pins across files, reads current context, and journals a section edit', async () => {
    const { client, context, journal, store, files } = await fixture();
    const list = await client.listTools();
    expect(list.tools).toHaveLength(18);
    const replacement = list.tools.find(tool => tool.name === 'wikiship_replace_range')!;
    expect(replacement.inputSchema.required).toContain('expectedHash');
    expect(replacement.annotations?.destructiveHint).toBe(true);
    expect(list.tools.some(tool => /revert|review/.test(tool.name))).toBe(false);

    context.to = files.values.get('A.md')!.data.length;
    data(await client.callTool({ name: 'wikiship_context_add_selection', arguments: {} }));
    context.active = 'B.md';
    data(await client.callTool({ name: 'wikiship_context_add_section', arguments: {} }));
    const pinned = data(await client.callTool({ name: 'wikiship_get_context', arguments: {} })) as unknown as { path: string; content: string; status: string }[];
    expect(pinned.map(item => item.path)).toEqual(['A.md', 'B.md']);
    expect(pinned[0]!.content).toContain('Second paragraph.');
    expect(pinned[1]!.content).toBe('## Storage\nOriginal design.\n\n');

    const state = data(await client.callTool({ name: 'wikiship_get_file_state', arguments: { path: 'B.md' } }));
    const operation = data(await client.callTool({ name: 'wikiship_patch_section', arguments: {
      path: 'B.md', expectedHash: state.fileHash, headingPath: ['Architecture', 'Storage'],
      content: '## Storage\nRecorded AI design.\n\n', agent: 'test-client', session: 'acceptance',
    } }));
    expect(operation.status).toBe('applied');
    expect(files.values.get('B.md')!.data).toContain('Recorded AI design.');
    expect(files.values.get('B.md')!.data).toContain('## API\nPreserve this.');
    expect(journal.state.operations[0]!.before!.data).toContain('Original design.');
    expect(store.saved!.operations[0]!.agent).toBe('test-client');
    expect(store.saved!.operations[0]!.review).toBe('unreviewed');

    const updated = data(await client.callTool({ name: 'wikiship_get_context', arguments: {} })) as unknown as { status: string }[];
    expect(updated[1]!.status).toBe('changed');
    const changes = data(await client.callTool({ name: 'wikiship_get_changes', arguments: { limit: 1 } }));
    expect(JSON.stringify(changes)).not.toContain('Original design.');
    await journal.revert(String(operation.id));
    expect(files.values.get('B.md')!.data).toContain('Original design.');
  });

  it('rejects stale hashes, changed editor selection, invalid ranges and arguments without attribution', async () => {
    const { client, context, journal, files, definitions } = await fixture();
    const previous = hash(files.values.get('A.md')!.data);
    files.values.set('A.md', textSnapshot('Human edited this.'));
    const stale = await client.callTool({ name: 'wikiship_replace_range', arguments: {
      path: 'A.md', expectedHash: previous, from: 0, to: 5, content: 'Bad',
    } });
    expect(stale.isError).toBe(true);
    const current = hash(files.values.get('A.md')!.data);
    context.from = 3; context.to = 8;
    const selection = await client.callTool({ name: 'wikiship_replace_selection', arguments: {
      path: 'A.md', expectedHash: current, from: 0, to: 5, content: 'Bad',
    } });
    expect(selection.isError).toBe(true);
    const invalid = await client.callTool({ name: 'wikiship_replace_range', arguments: {
      path: 'A.md', expectedHash: current, from: 30, to: 1, content: 'Bad',
    } });
    expect(invalid.isError).toBe(true);
    const missingHash = await client.callTool({ name: 'wikiship_delete_file', arguments: { path: 'A.md' } });
    expect(missingHash.isError).toBe(true);
    const direct = await definitions.find(tool => tool.name === 'wikiship_create_file')!.callback({ path: 'X.md', content: 4 });
    expect(direct.isError).toBe(true);
    expect(journal.state.operations).toHaveLength(0);
    expect(files.values.get('A.md')!.data).toBe('Human edited this.');
  });

  it('journals create/move/rename/delete and retains deletions for human recovery', async () => {
    const { client, journal, files } = await fixture();
    const created = data(await client.callTool({ name: 'wikiship_create_file', arguments: { path: 'new.md', content: 'Keep me.' } }));
    expect((await client.callTool({ name: 'wikiship_create_file', arguments: { path: 'new.md', content: 'Overwrite.' } })).isError).toBe(true);
    const moved = data(await client.callTool({ name: 'wikiship_move_file', arguments: { path: 'new.md', target: 'folder/new.md', expectedHash: created.afterHash } }));
    const renamed = data(await client.callTool({ name: 'wikiship_rename_file', arguments: { path: 'folder/new.md', name: 'renamed.md', expectedHash: moved.afterHash } }));
    expect(renamed.target).toBe('folder/renamed.md');
    const deleted = data(await client.callTool({ name: 'wikiship_delete_file', arguments: { path: 'folder/renamed.md', expectedHash: renamed.afterHash } }));
    expect(files.values.has('folder/renamed.md')).toBe(false);
    expect(journal.state.operations.map(op => op.kind)).toEqual(['create', 'move', 'move', 'delete']);
    await journal.revert(String(deleted.id));
    expect(files.values.get('folder/renamed.md')!.data).toBe('Keep me.');
    files.values.set('folder/renamed.md', textSnapshot('New human content.'));
    await expect(journal.revert(String(renamed.id))).rejects.toThrow('Conflict');
    expect(files.values.get('folder/renamed.md')!.data).toBe('New human content.');
  });

  it.each(['wikiship_replace_selection', 'wikiship_insert_at_cursor'])('rechecks the unchanged-text editor target after slow journal persistence for %s', async name => {
    const { client, context, journal, store, files } = await fixture();
    const original = files.values.get('A.md')!.data;
    let started!: () => void, resume!: () => void;
    const saving = new Promise<void>(resolve => { started = resolve; });
    const gate = new Promise<void>(resolve => { resume = resolve; });
    const save = store.save.bind(store);
    vi.spyOn(store, 'save').mockImplementationOnce(async state => { await save(state); started(); await gate; });
    const pending = client.callTool({ name, arguments: {
      path: 'A.md', expectedHash: hash(original), content: 'AI replacement',
      ...(name === 'wikiship_replace_selection' ? { from: 0, to: 5 } : { offset: 5 }),
    } });
    await saving;
    context.from = 10; context.to = 15;
    resume();
    const response = await pending;
    expect(response.isError).toBe(true);
    expect(JSON.stringify(response.content)).toContain('selection, cursor, or content changed');
    expect(files.values.get('A.md')!.data).toBe(original);
    expect(journal.state.operations).toHaveLength(1);
    expect(journal.state.operations[0]!.status).toBe('failed');
    expect(Object.keys(store.saved!.operations[0]!)).not.toContain('guard');
  });

  it('rejects a changed active section target after intent persistence', async () => {
    const { client, context, journal, store, files } = await fixture();
    context.active = 'B.md';
    const original = files.values.get('B.md')!.data, save = store.save.bind(store);
    vi.spyOn(store, 'save').mockImplementationOnce(async state => { await save(state); context.active = 'A.md'; });
    const response = await client.callTool({ name: 'wikiship_patch_section', arguments: {
      path: 'B.md', expectedHash: hash(original), headingPath: ['Architecture', 'Storage'], content: '## Storage\nAI\n',
    } });
    expect(response.isError).toBe(true);
    expect(files.values.get('B.md')!.data).toBe(original);
    expect(journal.state.operations[0]!.status).toBe('failed');
  });
});

interface BridgeModule {
  ALLOWED_TOOLS: readonly string[];
  createBridge(upstream: Client): Server;
  readConfiguration(env: Record<string, string | undefined>): { url: URL; token: string };
}
const bridgeUrl = new URL('../../adapters/stdio-bridge.mjs', import.meta.url).href;
async function bridgeModule(): Promise<BridgeModule> { return import(bridgeUrl); }

describe('tools-only stdio bridge policy', () => {
  it('forwards allowed MCP calls and refuses host writes, arbitrary commands, and prefix lookalikes', async () => {
    const { client: upstream, server: host, journal } = await fixture();
    let bypassCalls = 0;
    for (const name of ['vault_write', 'command_execute', 'open_file', 'vault_get_upload_url', 'wikiship_raw_write']) {
      host.registerTool(name, { inputSchema: { path: z.string().optional() } }, async () => {
        bypassCalls++; return { content: [{ type: 'text', text: 'Bypassed' }] };
      });
    }
    const { createBridge, ALLOWED_TOOLS } = await bridgeModule();
    const readTools = ALLOWED_TOOLS.filter(name => !name.startsWith('wikiship_'));
    for (const name of readTools) host.registerTool(name, { inputSchema: {} }, async () => ({ content: [{ type: 'text', text: JSON.stringify({ read: name }) }] }));
    const bridge = createBridge(upstream), client = new Client({ name: 'external-agent', version: '1' });
    const [agentTransport, bridgeTransport] = InMemoryTransport.createLinkedPair();
    await bridge.connect(bridgeTransport); await client.connect(agentTransport);
    closers.push(() => client.close(), () => bridge.close());
    const list = await client.listTools();
    expect(list.tools.map(tool => tool.name).sort()).toEqual([...ALLOWED_TOOLS].sort());
    for (const name of ['vault_write', 'command_execute', 'open_file', 'vault_get_upload_url', 'wikiship_raw_write']) {
      expect((await client.callTool({ name, arguments: { path: 'A.md' } })).isError).toBe(true);
    }
    expect(bypassCalls).toBe(0);
    for (const name of readTools) expect(data(await client.callTool({ name, arguments: {} })).read).toBe(name);
    const created = data(await client.callTool({ name: 'wikiship_create_file', arguments: { path: 'through-bridge.md', content: 'Journal me.' } }));
    expect(created.status).toBe('applied');
    expect(journal.state.operations[0]!.path).toBe('through-bridge.md');
  });

  it('rejects remote/credential-bearing endpoints and does not include secrets in config errors', async () => {
    const { readConfiguration } = await bridgeModule();
    for (const url of ['https://example.com/mcp', 'https://secret@localhost/mcp', 'http://localhost/vault/', 'https://localhost/mcp?token=secret']) {
      expect(() => readConfiguration({ WIKISHIP_MCP_URL: url, WIKISHIP_API_KEY: 'secret' })).toThrow('must point to /mcp');
    }
    const configured = readConfiguration({ WIKISHIP_MCP_URL: 'http://127.0.0.1:27123/mcp', WIKISHIP_API_KEY: 'test-key' });
    expect(configured.url.hostname).toBe('127.0.0.1');
    expect(() => readConfiguration({ WIKISHIP_API_KEY: 'secret\nvalue' })).toThrow('Set WIKISHIP_API_KEY');
  });
});
