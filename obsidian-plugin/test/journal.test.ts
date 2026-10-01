import { describe, expect, it, vi } from 'vitest';
import { bytes, emptyState, hash, MAX_FILE_BYTES, MutationPreconditionError, snapshot, stateSchema, textSnapshot, type Operation, type Snapshot, type State, type StateStore, type WorkspaceFiles } from '../src/model';
import { pin } from '../src/context/references';
import { Journal } from '../src/provenance/journal';

class MemoryStore implements StateStore {
  saved: State | null = null;
  calls = 0;
  failAt = -1;
  commitBeforeError = false;
  async load() { return structuredClone(this.saved); }
  async save(state: State) {
    this.calls++;
    if (this.calls === this.failAt) {
      if (this.commitBeforeError) this.saved = structuredClone(state);
      throw new Error('Storage unavailable');
    }
    this.saved = structuredClone(state);
  }
}
class MemoryFiles implements WorkspaceFiles {
  content = new Map<string, Snapshot>();
  constructor(private store: MemoryStore) {}
  put(path: string, content: string | Uint8Array) { this.content.set(path, typeof content === 'string' ? textSnapshot(content) : snapshot(content)); }
  text(path: string) { return this.content.get(path)?.data; }
  async read(path: string) { return structuredClone(this.content.get(path) ?? null); }
  async apply(op: Operation, reverse: boolean) {
    // Exercise the journal/adapter contract: durable intent and a second compare
    // immediately before mutation, including the destination of a move.
    expect(this.store.saved?.operations.find(item => item.id === op.id)?.status).toBe(reverse ? 'reverting' : 'prepared');
    const source = reverse && op.kind === 'move' ? op.target! : op.path;
    const target = reverse && op.kind === 'move' ? op.path : op.target;
    const expected = reverse ? op.after : op.before;
    if ((await this.read(source))?.hash !== expected?.hash) throw new MutationPreconditionError('Conflict: changed at write boundary');
    if (op.kind === 'move') {
      if (await this.read(target!) !== null) throw new MutationPreconditionError('Conflict: destination exists');
      this.content.set(target!, structuredClone(expected!));
      this.content.delete(source);
    } else {
      const next = reverse ? op.before : op.after;
      if (next) this.content.set(source, structuredClone(next)); else this.content.delete(source);
    }
  }
}
async function setup(initial = 'original') {
  const store = new MemoryStore(), files = new MemoryFiles(store), journal = new Journal(store, files);
  files.put('note.md', initial);
  await journal.load();
  const edit = (content = 'AI text') => journal.mutate({ kind: 'edit', path: 'note.md', expectedHash: hash(initial), from: 0, to: initial.length, content, agent: 'test-agent', session: 'test-session' });
  return { store, files, journal, edit };
}

describe('AI provenance and safe inverse operations', () => {
  it('records before/after and attribution, persists review, and reverts the exact text', async () => {
    const { journal, files, store, edit } = await setup();
    const op = await edit();
    expect(files.text('note.md')).toBe('AI text');
    expect(op).toMatchObject({ before: { data: 'original' }, after: { data: 'AI text' }, status: 'applied', review: 'unreviewed', agent: 'test-agent', session: 'test-session' });
    await journal.markReviewed(op.id);
    expect(store.saved?.operations[0]?.review).toBe('reviewed');
    await journal.revert(op.id);
    expect(files.text('note.md')).toBe('original');
    expect(journal.state.operations[0]?.status).toBe('reverted');
  });
  it('preserves a newer manual edit when reverting', async () => {
    const { journal, files, edit } = await setup();
    const op = await edit();
    files.put('note.md', 'human text');
    await expect(journal.revert(op.id)).rejects.toThrow('Conflict');
    expect(files.text('note.md')).toBe('human text');
    expect(journal.state.operations).toHaveLength(1);
    expect(journal.state.operations[0]?.status).toBe('applied');
  });
  it('preserves a manual edit racing with the inverse write', async () => {
    const { journal, files, edit } = await setup();
    const op = await edit(), apply = files.apply.bind(files);
    vi.spyOn(files, 'apply').mockImplementationOnce(async (...args) => { files.put('note.md', 'human race'); await apply(...args); });
    await expect(journal.revert(op.id)).rejects.toThrow('Conflict');
    expect(files.text('note.md')).toBe('human race');
    expect(journal.state.operations[0]).toMatchObject({ status: 'applied', recoveryDirection: 'reverse' });
  });
  it('serializes two writers using the same precondition', async () => {
    const { journal, files, edit } = await setup();
    const results = await Promise.allSettled([edit('first agent'), edit('second agent')]);
    expect(results.map(result => result.status)).toEqual(['fulfilled', 'rejected']);
    expect(files.text('note.md')).toBe('first agent');
    expect(journal.state.operations).toHaveLength(1);
  });
  it('rechecks ephemeral preconditions after waiting for previously queued work', async () => {
    const { journal, files, store } = await setup();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; }), save = store.save.bind(store);
    vi.spyOn(store, 'save').mockImplementationOnce(async state => { await gate; await save(state); });
    const first = journal.mutate({ kind: 'create', path: 'other.md', content: 'first' });
    let selection = 0;
    const guard = vi.fn(() => { if (selection !== 0) throw new Error('Selection moved'); });
    const second = journal.mutate({ kind: 'edit', path: 'note.md', expectedHash: hash('original'), from: 0, to: 8, content: 'AI' }, guard);
    selection = 1; release();
    await first; await expect(second).rejects.toThrow('Selection moved');
    expect(guard).toHaveBeenCalledOnce();
    expect(files.text('note.md')).toBe('original');
    expect(journal.state.operations).toHaveLength(1);
  });
  it('never records arbitrary external file changes as completed AI changes', async () => {
    const { journal, files, edit } = await setup();
    files.put('note.md', 'external modification');
    expect(journal.state.operations).toEqual([]);
    await expect(edit()).rejects.toThrow('Conflict');
    expect(journal.state.operations).toEqual([]);
  });
  it('uses the adapter precondition if a human edits after the first read', async () => {
    const { journal, files, edit } = await setup(), apply = files.apply.bind(files);
    vi.spyOn(files, 'apply').mockImplementationOnce(async (...args) => { files.put('note.md', 'manual race'); await apply(...args); });
    await expect(edit()).rejects.toThrow('failed');
    expect(files.text('note.md')).toBe('manual race');
    expect(journal.state.operations[0]).toMatchObject({ before: { data: 'original' }, after: { data: 'AI text' }, status: 'failed' });
    await journal.mutate({ kind: 'edit', path: 'note.md', expectedHash: hash('manual race'), from: 0, to: 11, content: 'fresh authorized edit' });
    expect(files.text('note.md')).toBe('fresh authorized edit');
  });
  it('does not attribute a coincidentally matching human edit to a refused AI write', async () => {
    const { journal, files, edit } = await setup(), apply = files.apply.bind(files);
    vi.spyOn(files, 'apply').mockImplementationOnce(async (...args) => { files.put('note.md', 'AI text'); await apply(...args); });
    await expect(edit()).rejects.toThrow('failed');
    expect(files.text('note.md')).toBe('AI text');
    expect(journal.state.operations[0]?.status).toBe('failed');
  });
  it('marks a rejected editor guard failed even if the human independently made the requested change', async () => {
    const { journal, files, store } = await setup(), save = store.save.bind(store);
    let changed = false;
    vi.spyOn(store, 'save').mockImplementationOnce(async state => { await save(state); files.put('note.md', 'AI text'); changed = true; });
    const guard = () => { if (changed) throw new Error('Selection changed'); };
    const apply = vi.spyOn(files, 'apply');
    await expect(journal.mutate({ kind: 'edit', path: 'note.md', expectedHash: hash('original'), from: 0, to: 8, content: 'AI text' }, guard)).rejects.toThrow('cancelled before writing');
    expect(apply).not.toHaveBeenCalled();
    expect(journal.state.operations[0]?.status).toBe('failed');
    expect(files.text('note.md')).toBe('AI text');
  });
  it('reverts creation and restores exact binary deletion bytes', async () => {
    const { journal, files } = await setup();
    const create = await journal.mutate({ kind: 'create', path: 'new.md', content: 'new file' });
    await journal.revert(create.id);
    expect(await files.read('new.md')).toBeNull();
    const binary = new Uint8Array([0, 255, 254, 17, 128, 13, 10]);
    files.put('diagram.png', binary);
    const remove = await journal.mutate({ kind: 'delete', path: 'diagram.png', expectedHash: hash(binary) });
    expect(remove.before?.encoding).toBe('base64');
    expect(await files.read('diagram.png')).toBeNull();
    await journal.revert(remove.id);
    expect(bytes((await files.read('diagram.png'))!)).toEqual(Buffer.from(binary));
  });
  it('refuses to restore a deletion over a new human file', async () => {
    const { journal, files } = await setup();
    const op = await journal.mutate({ kind: 'delete', path: 'note.md', expectedHash: hash('original') });
    files.put('note.md', 'new human file');
    await expect(journal.revert(op.id)).rejects.toThrow('Conflict');
    expect(files.text('note.md')).toBe('new human file');
  });
  it('reverts moves but never overwrites a new file at the old path', async () => {
    const { journal, files } = await setup();
    const op = await journal.mutate({ kind: 'move', path: 'note.md', target: 'renamed.md', expectedHash: hash('original') });
    files.put('note.md', 'new human file');
    await expect(journal.revert(op.id)).rejects.toThrow('Conflict');
    expect(files.text('note.md')).toBe('new human file');
    expect(files.text('renamed.md')).toBe('original');
    files.content.delete('note.md');
    await journal.revert(op.id);
    expect(files.text('note.md')).toBe('original');
    expect(await files.read('renamed.md')).toBeNull();
  });
  it.each(['note.md', 'b.md', 'c.md'])('follows file history through multiple renames when reverting using %s', async path => {
    const { journal, files, edit } = await setup();
    await edit('first');
    await journal.mutate({ kind: 'move', path: 'note.md', target: 'b.md', expectedHash: hash('first') });
    await journal.mutate({ kind: 'edit', path: 'b.md', expectedHash: hash('first'), from: 0, to: 5, content: 'second' });
    await journal.mutate({ kind: 'create', path: 'unrelated.md', content: 'keep me' });
    await journal.mutate({ kind: 'move', path: 'b.md', target: 'c.md', expectedHash: hash('second') });
    await journal.mutate({ kind: 'edit', path: 'c.md', expectedHash: hash('second'), from: 6, to: 6, content: '!' });
    expect(await journal.revertFile(path)).toEqual({ reverted: 5 });
    expect(files.text('note.md')).toBe('original');
    expect(files.text('unrelated.md')).toBe('keep me');
    expect(await files.read('c.md')).toBeNull();
  });
  it('stops at creation when a path has been reused for a new file', async () => {
    const { journal, files, edit } = await setup();
    const old = await edit('old AI edit');
    await journal.mutate({ kind: 'move', path: 'note.md', target: 'archived.md', expectedHash: hash('old AI edit') });
    await journal.mutate({ kind: 'create', path: 'note.md', content: 'new incarnation' });
    expect(await journal.revertFile('note.md')).toEqual({ reverted: 1 });
    expect(files.text('archived.md')).toBe('old AI edit');
    expect(journal.state.operations.find(op => op.id === old.id)?.status).toBe('applied');
  });
  it('reports partial file-wide revert and stops before overwriting older manual edits', async () => {
    const { journal, files, edit } = await setup();
    await edit('first');
    files.put('note.md', 'first plus human edit');
    await journal.mutate({ kind: 'edit', path: 'note.md', expectedHash: hash('first plus human edit'), from: 0, to: 5, content: 'second' });
    await expect(journal.revertFile('note.md')).rejects.toThrow('Reverted 1 change(s); stopped');
    expect(files.text('note.md')).toBe('first plus human edit');
    expect(journal.state.operations.map(op => op.status)).toEqual(['applied', 'reverted']);
  });
});

describe('write-ahead persistence and interruption recovery', () => {
  it.each([false, true])('never writes the workspace if preparing fails (save committed=%s)', async commitBeforeError => {
    const { journal, files, store, edit } = await setup();
    store.failAt = 1; store.commitBeforeError = commitBeforeError;
    const apply = vi.spyOn(files, 'apply');
    await expect(edit()).rejects.toThrow('Storage unavailable');
    expect(apply).not.toHaveBeenCalled();
    expect(files.text('note.md')).toBe('original');
    await expect(edit()).rejects.toThrow('persistence failed');
    await journal.recover();
    expect(journal.state.operations.map(op => op.status)).toEqual(commitBeforeError ? ['failed'] : []);
    await edit();
    expect(files.text('note.md')).toBe('AI text');
  });
  it.each([false, true])('recovers failed forward finalization after a restart (save committed=%s)', async commitBeforeError => {
    const { journal, files, store, edit } = await setup();
    store.failAt = 2; store.commitBeforeError = commitBeforeError;
    await expect(edit()).rejects.toThrow('finalization failed');
    expect(files.text('note.md')).toBe('AI text');
    await expect(journal.mutate({ kind: 'create', path: 'next.md' })).rejects.toThrow('persistence failed');
    const restarted = new Journal(store, files); await restarted.load();
    expect(restarted.state.operations[0]?.status).toBe('applied');
    await restarted.revert(restarted.state.operations[0]!.id);
    expect(files.text('note.md')).toBe('original');
  });
  it('reloads a possibly committed state before resuming after failed persistence', async () => {
    const { journal, files, store, edit } = await setup();
    store.failAt = 2; store.commitBeforeError = true;
    await expect(edit()).rejects.toThrow('finalization failed');
    await journal.recover();
    expect(journal.state.operations[0]?.status).toBe('applied');
    await journal.revert(journal.state.operations[0]!.id);
    expect(files.text('note.md')).toBe('original');
  });
  it('recovers failed reverse finalization without replaying the inverse', async () => {
    const { journal, files, store, edit } = await setup();
    const op = await edit(); store.failAt = 4;
    await expect(journal.revert(op.id)).rejects.toThrow('finalization failed');
    expect(store.saved?.operations[0]?.status).toBe('reverting');
    expect(files.text('note.md')).toBe('original');
    const apply = vi.spyOn(files, 'apply'), restarted = new Journal(store, files);
    await restarted.load();
    expect(restarted.state.operations[0]?.status).toBe('reverted');
    expect(apply).not.toHaveBeenCalled();
  });
  it('preserves reverse direction through uncertain recovery and subsequent restarts', async () => {
    const { journal, files, store, edit } = await setup();
    const op = await edit();
    vi.spyOn(files, 'apply').mockImplementationOnce(async () => { files.put('note.md', 'partial inverse'); throw new Error('Interrupted'); });
    await expect(journal.revert(op.id)).rejects.toThrow('Interrupted');
    const restarted = new Journal(store, files); await restarted.load();
    expect(restarted.state.operations[0]).toMatchObject({ status: 'uncertain', recoveryDirection: 'reverse' });
    expect(files.text('note.md')).toBe('partial inverse');
    files.put('note.md', 'original');
    await restarted.recover();
    expect(restarted.state.operations[0]?.status).toBe('reverted');
  });
  it('does not guess the direction of a legacy uncertain record', async () => {
    const { journal, files, store, edit } = await setup(); await edit();
    const persisted = store.saved!.operations[0]!;
    persisted.status = 'uncertain'; delete persisted.recoveryDirection;
    files.put('note.md', 'original');
    const restarted = new Journal(store, files); await restarted.load();
    expect(restarted.state.operations[0]?.status).toBe('uncertain');
    await expect(restarted.mutate({ kind: 'create', path: 'next.md' })).rejects.toThrow('needs recovery');
  });
  it('classifies an adapter error after a completed write as applied', async () => {
    const { journal, files, edit } = await setup(), apply = files.apply.bind(files);
    vi.spyOn(files, 'apply').mockImplementationOnce(async (...args) => { await apply(...args); throw new Error('Notification failed'); });
    await expect(edit()).rejects.toThrow('Mutation failed (applied)');
    expect(journal.state.operations[0]?.status).toBe('applied');
    expect(files.text('note.md')).toBe('AI text');
  });
  it('classifies an adapter error without a write as failed', async () => {
    const { journal, files, edit } = await setup();
    vi.spyOn(files, 'apply').mockRejectedValueOnce(new Error('Write denied'));
    await expect(edit()).rejects.toThrow('Mutation failed (failed)');
    expect(journal.state.operations[0]?.status).toBe('failed');
    expect(files.text('note.md')).toBe('original');
  });
  it('leaves durable intent recoverable when inspection itself fails after a write error', async () => {
    const { journal, files, store, edit } = await setup();
    const read = files.read.bind(files);
    vi.spyOn(files, 'apply').mockImplementationOnce(async () => {
      files.put('note.md', 'AI text');
      vi.spyOn(files, 'read').mockRejectedValueOnce(new Error('Read unavailable'));
      throw new Error('Write notification failed');
    });
    await expect(edit()).rejects.toThrow('Read unavailable');
    expect(store.saved?.operations[0]?.status).toBe('prepared');
    expect((await read('note.md'))?.data).toBe('AI text');
    await expect(journal.mutate({ kind: 'create', path: 'next.md' })).rejects.toThrow('needs recovery');
    await journal.recover();
    expect(journal.state.operations[0]?.status).toBe('applied');
  });
  it('retains the binary preimage across deletion finalization failure and restart', async () => {
    const { journal, files, store } = await setup();
    const binary = new Uint8Array([0, 255, 2, 128, 254]);
    files.put('binary.dat', binary); store.failAt = 2;
    await expect(journal.mutate({ kind: 'delete', path: 'binary.dat', expectedHash: hash(binary) })).rejects.toThrow('finalization failed');
    const restarted = new Journal(store, files); await restarted.load();
    expect(restarted.state.operations[0]?.status).toBe('applied');
    await restarted.revert(restarted.state.operations[0]!.id);
    expect(bytes((await files.read('binary.dat'))!)).toEqual(Buffer.from(binary));
  });
  it('keeps an interrupted partial move uncertain and never deletes either copy during recovery', async () => {
    const { journal, files, store } = await setup();
    vi.spyOn(files, 'apply').mockImplementationOnce(async () => { files.put('new.md', 'original'); throw new Error('Interrupted before source deletion'); });
    await expect(journal.mutate({ kind: 'move', path: 'note.md', target: 'new.md', expectedHash: hash('original') })).rejects.toThrow('uncertain');
    const restarted = new Journal(store, files); await restarted.load();
    expect(restarted.state.operations[0]?.status).toBe('uncertain');
    expect(files.text('note.md')).toBe('original');
    expect(files.text('new.md')).toBe('original');
    files.content.delete('note.md'); await restarted.recover();
    expect(restarted.state.operations[0]?.status).toBe('applied');
  });
});

describe('journal validation, lifecycle and isolation', () => {
  it('refuses operations before a successful load', async () => {
    const store = new MemoryStore(), journal = new Journal(store, new MemoryFiles(store));
    await expect(journal.mutate({ kind: 'create', path: 'new.md' })).rejects.toThrow('not loaded');
  });
  it('does not split emoji or silently accept invalid edit offsets', async () => {
    const { journal, files } = await setup('a🚢b');
    for (const [from, to] of [[2, 2], [-1, 0], [0, 99], [2.5, 3]]) {
      await expect(journal.mutate({ kind: 'edit', path: 'note.md', expectedHash: hash('a🚢b'), from, to, content: 'x' })).rejects.toThrow();
    }
    expect(files.text('note.md')).toBe('a🚢b');
    expect(journal.state.operations).toEqual([]);
  });
  it('bounds request and resulting file size before preparing a write', async () => {
    const { journal } = await setup();
    await expect(journal.mutate({ kind: 'create', path: 'large.md', content: 'x'.repeat(MAX_FILE_BYTES + 1) })).rejects.toThrow('5 MiB');
    await expect(journal.mutate({ kind: 'edit', path: 'note.md', expectedHash: hash('original'), from: 0, to: 0, content: 'x'.repeat(MAX_FILE_BYTES) })).rejects.toThrow('5 MiB');
    expect(journal.state.operations).toEqual([]);
  });
  it('rejects corrupted snapshots and inconsistent mutation records on load', async () => {
    const { files, store, edit } = await setup(); await edit();
    const valid = structuredClone(store.saved!);
    const corruptions: ((state: State) => void)[] = [
      state => { state.operations[0]!.before!.data = 'tampered'; },
      state => { state.operations[0]!.after!.size++; },
      state => { state.operations[0]!.before = null; },
      state => { state.operations.push(structuredClone(state.operations[0]!)); },
      state => { state.operations[0]!.kind = 'move'; state.operations[0]!.target = 'new.md'; },
      state => { state.operations[0]!.before = { encoding: 'base64', data: 'YQ==!', size: 1, hash: hash('a') }; },
    ];
    for (const corrupt of corruptions) {
      store.saved = structuredClone(valid); corrupt(store.saved);
      const restarted = new Journal(store, files);
      await expect(restarted.load()).rejects.toThrow();
      await expect(restarted.mutate({ kind: 'create', path: 'new.md' })).rejects.toThrow('not loaded');
    }
    expect(files.text('note.md')).toBe('AI text');
  });
  it('returns detached state, mutation and context objects', async () => {
    const { journal, edit } = await setup();
    const op = await edit(); op.status = 'failed'; op.after!.data = 'tampered';
    const item = pin('note', 'note.md', 'AI text'), added = await journal.addContext(item);
    item.path = 'wrong.md'; added.path = 'also-wrong.md';
    journal.state.operations[0]!.status = 'failed';
    expect(journal.state.operations[0]).toMatchObject({ status: 'applied', after: { data: 'AI text' } });
    expect(journal.state.context[0]?.path).toBe('note.md');
  });
  it('rejects a reused context ID without corrupting persisted state', async () => {
    const { journal, store } = await setup();
    const item = pin('note', 'one.md', 'one');
    await journal.addContext(item);
    await expect(journal.addContext({ ...pin('note', 'two.md', 'two'), id: item.id })).rejects.toThrow('ID already exists');
    expect(stateSchema.parse(store.saved).context).toHaveLength(1);
  });
  it('does not let a failed rendering listener fail a committed mutation', async () => {
    const { journal, edit } = await setup();
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    journal.subscribe(() => { throw new Error('render failed'); });
    await expect(edit()).resolves.toMatchObject({ status: 'applied' });
    expect(log).toHaveBeenCalled(); log.mockRestore();
  });
  it('drains already accepted work and rejects new operations during unload', async () => {
    const { journal, files } = await setup();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; }), apply = files.apply.bind(files);
    vi.spyOn(files, 'apply').mockImplementationOnce(async (...args) => { await gate; await apply(...args); });
    const first = journal.mutate({ kind: 'create', path: 'one.md' });
    const second = journal.mutate({ kind: 'create', path: 'two.md' });
    const closing = journal.close();
    await expect(journal.mutate({ kind: 'create', path: 'three.md' })).rejects.toThrow('unloading');
    release(); await Promise.all([first, second, closing]);
    expect(journal.state.operations).toHaveLength(2);
    expect(await files.read('three.md')).toBeNull();
  });
  it('persists deduplicated context and updates nested paths without attributing file events to AI', async () => {
    const { journal, files, store } = await setup();
    const item = pin('selection', 'docs/note.md', 'one\ntwo\nthree', 0, 7);
    await journal.addContext(item); await journal.addContext({ ...item, id: 'second-pin' });
    await journal.addContext(pin('note', 'docs-extra/note.md', 'other'));
    await journal.renameContext('docs', 'renamed');
    const restarted = new Journal(store, files); await restarted.load();
    expect(restarted.state.context.map(context => context.path)).toEqual(['renamed/note.md', 'docs-extra/note.md']);
    expect(restarted.state.operations).toEqual([]);
    await restarted.removeContext(item.id);
    expect(restarted.state.context).toHaveLength(1);
    await restarted.removeContext(); expect(restarted.state.context).toEqual([]);
  });
  it('validates the empty v1 state', () => { expect(stateSchema.parse(emptyState())).toEqual(emptyState()); });
});
