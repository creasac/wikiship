import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileSystemAdapter, type App, type PluginManifest } from 'obsidian';
import { AtomicStateStore } from '../src/provenance/storage';
import type { Operation, Snapshot } from '../src/model';

// Only the desktop UI boundary is mocked. Startup, journal queue, persistence,
// filesystem lock, and unload are the production implementations.
vi.mock('obsidian', () => ({
  FileSystemAdapter: class { getBasePath() { return ''; } },
  addIcon: vi.fn(), MarkdownView: class {}, TFile: class {}, Notice: vi.fn(), PluginSettingTab: class {}, Setting: class {},
  Plugin: class {
    constructor(readonly app: App, readonly manifest: PluginManifest) {}
    async loadData() { return null; }
    async saveData() {}
    register() {} registerView() {} registerEditorExtension() {} registerEvent() {}
    addRibbonIcon() {} addCommand() {} addSettingTab() {}
    addStatusBarItem() { return { setText() {}, addClass() {}, addEventListener() {}, setAttribute() {} }; }
  },
}));
vi.mock('../src/mcp/server', () => ({ DEFAULT_MCP_PORT: 27126, WikishipMcpServer: class {
  constructor(readonly app: unknown, readonly context: unknown, readonly journal: unknown, readonly policy: unknown, readonly port: number, readonly token: string) {}
  async start() {}
  async close() {}
} }));
vi.mock('../src/provenance/obsidian-files', () => ({ ObsidianFiles: class {
  private files = new Map<string, Snapshot>();
  async read(path: string) { return this.files.get(path) ?? null; }
  async apply(op: Operation) { if (op.after) this.files.set(op.path, op.after); else this.files.delete(op.path); }
  async trash(path: string) { this.files.delete(path); }
} }));
vi.mock('../src/context/editor', () => ({ EditorContext: class {} }));
vi.mock('../src/review/views', () => ({ ChangesView: class {}, FileReviewModal: class {}, RevertFileModal: class {}, CHANGES_VIEW_TYPE: 'changes', nextUnreviewed: vi.fn() }));
vi.mock('../src/review/gutter', () => ({ createReviewExtension: () => ({ extension: [], destroy() {} }) }));

// Obsidian runs this module in a renderer. Provide its shared window object so
// the reload test exercises the same cross-module shutdown barrier under Node.
vi.stubGlobal('window', {});
const { default: wikiship } = await import('../src/main');
const { waitForJournalShutdown } = await import('../src/provenance/lifecycle');

const roots: string[] = [];
function gate() { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); return { promise, release }; }
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'wikiship-lifecycle-')); roots.push(root);
  const directory = join(root, '.obsidian/plugins/wikiship');
  const adapter = new FileSystemAdapter(); vi.spyOn(adapter, 'getBasePath').mockReturnValue(root);
  const leaf = { setViewState: vi.fn(), view: {} };
  const workspace = { on: vi.fn(), onLayoutReady: vi.fn(), getLeavesOfType: vi.fn(() => []), getRightLeaf: vi.fn(() => leaf), revealLeaf: vi.fn() };
  const app = { vault: { adapter, configDir: '.obsidian', on: vi.fn() }, workspace } as unknown as App;
  const plugin = (Ctor = wikiship) => new Ctor(app, { id: 'wikiship' } as PluginManifest);
  return { root, directory, plugin, workspace, leaf };
}
afterEach(async () => { vi.restoreAllMocks(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

async function blockedMutation(plugin: InstanceType<typeof wikiship>) {
  const entered = gate(), finish = gate(), save = AtomicStateStore.prototype.save;
  vi.spyOn(AtomicStateStore.prototype, 'save').mockImplementationOnce(async function(this: AtomicStateStore, state) { entered.release(); await finish.promise; return save.call(this, state); });
  const pending = plugin.journal.mutate({ kind: 'create', path: 'synthetic.md', content: 'synthetic test content' });
  await entered.promise;
  return { pending, finish };
}

describe('plugin journal lifecycle', () => {
  it('registers exactly the six supported review, recovery and connection commands', async () => {
    const { directory, plugin } = await fixture(), instance = plugin();
    const commands = vi.spyOn(instance, 'addCommand');
    await instance.onload();
    try {
      expect(commands.mock.calls.map(([command]) => ({ id: command.id, name: command.name }))).toEqual([
        { id: 'open-changes', name: "Show machine minds' changes" },
        { id: 'next-change', name: 'Review next file' },
        { id: 'complete-changes', name: 'Approve all changes' },
        { id: 'undo-changes', name: "Undo all machine minds' changes" },
        { id: 'recover', name: 'Recover interrupted operations' },
        { id: 'restart-mcp', name: 'Restart MCP server' },
      ]);
    } finally { instance.onunload(); await waitForJournalShutdown(directory); }
  });

  it('opens the review side panel on the first queued change and exposes a clickable status item', async () => {
    const { directory, plugin, workspace, leaf } = await fixture(), instance = plugin();
    await instance.onload();
    try {
      await instance.journal.mutate({ kind: 'create', path: 'first.md', content: 'first' });
      await vi.waitFor(() => expect(leaf.setViewState).toHaveBeenCalledOnce());
      expect(leaf.setViewState).toHaveBeenCalledWith({ type: 'changes', active: true });
      expect(workspace.revealLeaf).toHaveBeenCalledOnce();
      await instance.journal.mutate({ kind: 'create', path: 'second.md', content: 'second' });
      expect(leaf.setViewState).toHaveBeenCalledOnce();
    } finally { instance.onunload(); await waitForJournalShutdown(directory); }
  });

  it('waits across module reload for accepted writes, then opens their saved state', async () => {
    const { root, directory, plugin } = await fixture();
    const old = plugin(); await old.onload();
    const work = await blockedMutation(old), lock = join(directory, 'state.lock');
    const before = await readFile(lock, 'utf8');
    old.onunload();
    await expect(old.journal.undoAll()).rejects.toThrow('unloading');
    // Obsidian discards the old plugin module on reload: a module-local map
    // would fail this test even though a same-module replacement could pass.
    vi.resetModules();
    const { default: Reloadedwikiship } = await import('../src/main');
    const { AtomicStateStore: ReloadedStore } = await import('../src/provenance/storage');
    const open = vi.spyOn(ReloadedStore.prototype, 'open');
    const path = vi.spyOn(old.app.vault.adapter as FileSystemAdapter, 'getBasePath').mockClear();
    const next = plugin(Reloadedwikiship), opening = next.onload();
    try {
      await vi.waitFor(() => expect(path).toHaveBeenCalledOnce());
      expect(await readFile(lock, 'utf8')).toBe(before);
      expect(open).not.toHaveBeenCalled();
      // A different vault can still start while this journal drains.
      const otherFixture = await fixture(), other = otherFixture.plugin();
      await other.onload(); other.onunload(); await waitForJournalShutdown(otherFixture.directory);
      work.finish.release(); await work.pending; await opening;
      expect(next.journal.state.operations).toEqual([await work.pending]);
      expect(await readFile(lock, 'utf8')).not.toBe(before);
      expect(open).toHaveBeenCalledOnce();
      const competing = new ReloadedStore(directory, root);
      await expect(competing.open()).rejects.toThrow('already open');
    } finally {
      work.finish.release(); await work.pending; await opening.catch(() => undefined);
      next.onunload(); await waitForJournalShutdown(directory);
    }
  });

  it('cancels a replacement disabled while waiting and lets the next enable finish', async () => {
    const { directory, plugin } = await fixture();
    const old = plugin(); await old.onload();
    const work = await blockedMutation(old), lock = join(directory, 'state.lock');
    const before = await readFile(lock, 'utf8'); old.onunload();
    const waiting = plugin(), waitingStart = waiting.onload();
    // Reaching the barrier is observable through the established directory,
    // without any journal acquisition or filesystem sleep in the test.
    await vi.waitFor(() => expect(waiting).toHaveProperty('store'));
    waiting.onunload(); waiting.onunload();
    const next = plugin(), opening = next.onload();
    try {
      expect(await readFile(lock, 'utf8')).toBe(before);
      work.finish.release(); await work.pending; await waitingStart; await opening;
      expect(waiting.context).toBeUndefined(); expect(waiting.journal).toBeUndefined();
      expect(next.journal.state.operations).toEqual([await work.pending]);
    } finally {
      work.finish.release(); await work.pending; await opening.catch(() => undefined);
      next.onunload(); await waitForJournalShutdown(directory);
    }
  });

  it('finishes an in-flight lock acquisition before releasing it on unload', async () => {
    const { directory, plugin } = await fixture(), entered = gate(), finish = gate();
    const open = AtomicStateStore.prototype.open;
    vi.spyOn(AtomicStateStore.prototype, 'open').mockImplementationOnce(async function(this: AtomicStateStore) {
      await open.call(this); entered.release(); await finish.promise;
    });
    const old = plugin(), starting = old.onload(); await entered.promise; old.onunload();
    const next = plugin(), opening = next.onload();
    try {
      finish.release(); await starting; await opening;
      expect(old.context).toBeUndefined(); expect(old.journal).toBeUndefined();
      expect(next.journal.state.operations).toEqual([]);
      await expect(next.journal.mutate({ kind: 'create', path: 'synthetic.md', content: 'text' })).resolves.toMatchObject({ path: 'synthetic.md' });
    } finally {
      finish.release(); await starting; await opening.catch(() => undefined);
      next.onunload(); await waitForJournalShutdown(directory);
    }
  });

  it('drains an in-flight journal load without registering a disabled instance', async () => {
    const { directory, plugin } = await fixture(), entered = gate(), finish = gate();
    const load = AtomicStateStore.prototype.load;
    vi.spyOn(AtomicStateStore.prototype, 'load').mockImplementationOnce(async function(this: AtomicStateStore) {
      entered.release(); await finish.promise; return load.call(this);
    });
    const old = plugin(), starting = old.onload(); await entered.promise; old.onunload();
    const next = plugin(), opening = next.onload();
    try {
      finish.release(); await starting; await opening;
      expect(old.context).toBeUndefined();
      await expect(old.journal.undoAll()).rejects.toThrow('unloading');
      expect(next.journal.state.operations).toEqual([]);
    } finally {
      finish.release(); await starting; await opening.catch(() => undefined);
      next.onunload(); await waitForJournalShutdown(directory);
    }
  });

  it('never acquires the lock when disabled before the vault path is resolved', async () => {
    const { directory, plugin } = await fixture(), finish = gate();
    const old = plugin(), open = vi.spyOn(AtomicStateStore.prototype, 'open');
    vi.spyOn(old, 'loadData').mockImplementationOnce(async () => { await finish.promise; return null; });
    const starting = old.onload(); old.onunload(); finish.release(); await starting;
    expect(open).not.toHaveBeenCalled(); expect(old.context).toBeUndefined();
    await expect(readFile(join(directory, 'state.lock'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('still refuses an independently live owner and preserves its lock', async () => {
    const { directory, plugin } = await fixture();
    const owner = plugin(), rejected = plugin(); await owner.onload();
    const lock = join(directory, 'state.lock'), before = await readFile(lock, 'utf8');
    try {
      await expect(rejected.onload()).rejects.toThrow('already open');
      expect(await readFile(lock, 'utf8')).toBe(before);
      await expect(owner.journal.mutate({ kind: 'create', path: 'synthetic.md', content: 'text' })).resolves.toMatchObject({ path: 'synthetic.md' });
    } finally { owner.onunload(); await waitForJournalShutdown(directory); }
  });

  it('fails closed if previous cleanup fails, keeping the owner lock intact', async () => {
    const { directory, plugin } = await fixture();
    const old = plugin(); await old.onload();
    const lock = join(directory, 'state.lock'), before = await readFile(lock, 'utf8');
    const close = AtomicStateStore.prototype.close;
    let owner!: AtomicStateStore;
    vi.spyOn(AtomicStateStore.prototype, 'close').mockImplementationOnce(async function(this: AtomicStateStore) { owner = this; throw new Error('Synthetic cleanup failure'); });
    const reported = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    old.onunload();
    const shutdown = waitForJournalShutdown(directory);
    await expect(shutdown).rejects.toThrow('Synthetic cleanup failure');
    await expect(plugin().onload()).rejects.toThrow('already open');
    expect(await readFile(lock, 'utf8')).toBe(before);
    expect(reported).toHaveBeenCalledWith('wikiship could not close its journal', expect.any(Error));
    // Restore normal owner-token cleanup of this synthetic test fixture only.
    await close.call(owner);
    const next = plugin(); await next.onload(); next.onunload(); await waitForJournalShutdown(directory);
  });
  it('releases its own lock when loading the journal fails, allowing a later startup', async () => {
    const { directory, plugin } = await fixture();
    vi.spyOn(AtomicStateStore.prototype, 'load').mockRejectedValueOnce(new Error('Synthetic journal load failure'));
    const failed = plugin(); await expect(failed.onload()).rejects.toThrow('Synthetic journal load failure');
    await expect(readFile(join(directory, 'state.lock'))).rejects.toMatchObject({ code: 'ENOENT' });
    const next = plugin(); await next.onload(); next.onunload(); await waitForJournalShutdown(directory);
  });

});
