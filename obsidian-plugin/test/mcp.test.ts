import { afterEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { createToolDefinitions, type EditorTarget, type wikishipContext } from '../src/mcp/tools';
import { Journal } from '../src/provenance/journal';
import { headingRanges, sameHeading } from '../src/context/references';
import { folderSnapshot, hash, textSnapshot, type Operation, type Snapshot, type State, type StateStore, type WorkspaceFiles } from '../src/model';

class MemoryStore implements StateStore {
  saved: State | null = null;
  async load() { return this.saved; }
  async save(state: State) { this.saved = structuredClone(state); }
}
class MemoryFiles implements WorkspaceFiles {
  values = new Map<string, Snapshot>();
  folders = new Map<string, Snapshot>();
  async read(path: string) { return this.values.get(path) ?? null; }
  async readFolder(path: string) { return this.folders.get(path) ?? null; }
  async trash(path: string, expected: Snapshot) {
    if ((await this.read(path))?.hash !== expected.hash) throw new Error('Conflict: changed before trash.');
    this.values.delete(path);
  }
  async trashFolder(path: string, expected: Snapshot) {
    if ((await this.readFolder(path))?.hash !== expected.hash) throw new Error('Conflict: folder changed before trash.');
    this.folders.delete(path);
  }
  async apply(op: Operation, reverse: boolean) {
    if (op.kind.endsWith('-folder')) {
      const source = reverse && op.kind === 'move-folder' ? op.target! : op.path;
      const expected = reverse ? op.after : op.before;
      if ((await this.readFolder(source))?.hash !== expected?.hash) throw new Error('Conflict: folder changed during write.');
      if (op.kind === 'move-folder') {
        const target = reverse ? op.path : op.target!;
        if (this.folders.has(target)) throw new Error('Conflict: folder destination exists.');
        this.folders.set(target, expected!); this.folders.delete(source);
      } else if (op.kind === 'create-folder') {
        const next = reverse ? op.before : op.after;
        if (next) this.folders.set(source, next); else this.folders.delete(source);
      }
      return;
    }
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
class Context implements wikishipContext {
  active = 'A.md'; from = 0; to = 5;
  constructor(private files: MemoryFiles) {}
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

}

const closers: (() => Promise<void>)[] = [];
afterEach(async () => { await Promise.allSettled(closers.splice(0).map(close => close())); });

async function fixture() {
  const files = new MemoryFiles(), store = new MemoryStore(), journal = new Journal(store, files);
  files.values.set('A.md', textSnapshot('First paragraph.\n\nSecond paragraph.\n'));
  files.values.set('B.md', textSnapshot('# Architecture\n\n## Storage\nOriginal design.\n\n## API\nPreserve this.\n'));
  await journal.load();
  const context = new Context(files);
  const definitions = createToolDefinitions(context, journal);
  const server = new McpServer({ name: 'wikiship-fixture', version: '0.2.0' });
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

describe('wikiship through a real MCP SDK client', () => {
  it('lists live tools, reads the current selection, and journals a section edit', async () => {
    const { client, context, journal, store, files } = await fixture();
    const list = await client.listTools();
    expect(list.tools).toHaveLength(17);
    const replacement = list.tools.find(tool => tool.name === 'wikiship_replace_range')!;
    expect(replacement.inputSchema.required).toContain('expectedHash');
    expect(replacement.annotations?.destructiveHint).toBe(true);
    expect(list.tools.some(tool => /revert|review/.test(tool.name))).toBe(false);

    context.to = files.values.get('A.md')!.data.length;
    const selected = data(await client.callTool({ name: 'wikiship_get_selection', arguments: {} }));
    expect(selected.content).toContain('Second paragraph.');
    context.active = 'B.md';
    expect(data(await client.callTool({ name: 'wikiship_get_editor_state', arguments: {} })).activeFile).toBe('B.md');
    expect(journal.state.operations).toEqual([]);

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
    expect(store.saved!.operations[0]!.status).toBe('applied');

    const changes = data(await client.callTool({ name: 'wikiship_get_changes', arguments: { limit: 1 } }));
    expect(JSON.stringify(changes)).not.toContain('Original design.');
    await journal.undo(String(operation.id));
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

  it('journals create/move/rename and lets a human cancel a staged deletion', async () => {
    const { client, journal, files } = await fixture();
    const created = data(await client.callTool({ name: 'wikiship_create_file', arguments: { path: 'new.md', content: 'Keep me.' } }));
    expect((await client.callTool({ name: 'wikiship_create_file', arguments: { path: 'new.md', content: 'Overwrite.' } })).isError).toBe(true);
    const moved = data(await client.callTool({ name: 'wikiship_move_file', arguments: { path: 'new.md', target: 'folder/new.md', expectedHash: created.afterHash } }));
    const renamed = data(await client.callTool({ name: 'wikiship_rename_file', arguments: { path: 'folder/new.md', name: 'renamed.md', expectedHash: moved.afterHash } }));
    expect(renamed.target).toBe('folder/renamed.md');
    const deleted = data(await client.callTool({ name: 'wikiship_delete_file', arguments: { path: 'folder/renamed.md', expectedHash: renamed.afterHash } }));
    expect(files.values.has('folder/renamed.md')).toBe(true);
    expect(deleted.status).toBe('pending-delete');
    expect(journal.state.operations.map(op => op.kind)).toEqual(['create', 'move', 'move', 'delete']);
    await journal.undo(String(deleted.id));
    expect(files.values.get('folder/renamed.md')!.data).toBe('Keep me.');
    files.values.set('folder/renamed.md', textSnapshot('New human content.'));
    await expect(journal.undo(String(renamed.id))).rejects.toThrow('Conflict');
    expect(files.values.get('folder/renamed.md')!.data).toBe('New human content.');
  });

  it('lists folders and journals empty creation, moves, and staged recursive deletion', async () => {
    const { client, files, journal } = await fixture();
    const created = data(await client.callTool({ name: 'wikiship_create_folder', arguments: { path: 'empty' } }));
    expect(created.kind).toBe('create-folder');
    expect(files.folders.has('empty')).toBe(true);
    const emptyState = data(await client.callTool({ name: 'wikiship_get_folder_state', arguments: { path: 'empty' } }));
    expect(emptyState.entries).toEqual([]);

    files.folders.set('notes', folderSnapshot([{ path: 'nested', kind: 'folder' }, { path: 'nested/a.md', kind: 'file', hash: hash('note'), size: 4 }]));
    const state = data(await client.callTool({ name: 'wikiship_get_folder_state', arguments: { path: 'notes' } }));
    expect(state.fileCount).toBe(1);
    const moved = data(await client.callTool({ name: 'wikiship_move_folder', arguments: { path: 'notes', target: 'archive', expectedHash: state.folderHash } }));
    expect(moved.kind).toBe('move-folder');
    expect(files.folders.has('archive')).toBe(true);
    const archive = data(await client.callTool({ name: 'wikiship_get_folder_state', arguments: { path: 'archive' } }));
    const deletion = data(await client.callTool({ name: 'wikiship_delete_folder', arguments: { path: 'archive', expectedHash: archive.folderHash } }));
    expect(deletion.status).toBe('pending-delete');
    expect(files.folders.has('archive')).toBe(true);
    expect(journal.state.operations.map(op => op.kind)).toContain('delete-folder');
    await journal.completeAll();
    expect(files.folders.has('archive')).toBe(false);
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
    expect(journal.state.operations).toEqual([]);
    expect(store.saved!.operations).toEqual([]);
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
    expect(journal.state.operations).toEqual([]);
  });
});
