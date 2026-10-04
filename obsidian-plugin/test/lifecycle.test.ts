import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileSystemAdapter, type App, type PluginManifest } from 'obsidian';
import WikiShip from '../src/main';
import { AtomicStateStore } from '../src/provenance/storage';
import { waitForJournalShutdown } from '../src/provenance/lifecycle';
import { pin } from '../src/context/references';

// Only the desktop UI boundary is mocked. Startup, journal queue, persistence,
// filesystem lock, and unload are the production implementations.
vi.mock('obsidian', () => ({
  FileSystemAdapter: class { getBasePath() { return ''; } },
  addIcon: vi.fn(), MarkdownView: class {}, TFile: class {}, Notice: vi.fn(), PluginSettingTab: class {}, Setting: class {},
  Plugin: class {
    constructor(readonly app: App, readonly manifest: PluginManifest) {}
    async loadData() { return null; }
    register() {} registerView() {} registerEditorExtension() {} registerEvent() {}
    addRibbonIcon() {} addCommand() {} addSettingTab() {}
    addStatusBarItem() { return { setText() {} }; }
  },
}));
vi.mock('obsidian-local-rest-api', () => ({ getAPI: vi.fn() }));
vi.mock('../src/provenance/obsidian-files', () => ({ ObsidianFiles: class {} }));
vi.mock('../src/context/editor', () => ({ EditorContext: class { dispose() {} } }));
vi.mock('../src/review/views', () => ({ ChangesView: class {}, ChangeModal: class {}, ContextView: class {}, RevertFileModal: class {}, CHANGES_VIEW_TYPE: 'changes', CONTEXT_VIEW_TYPE: 'context', nextUnreviewed: vi.fn() }));
vi.mock('../src/review/gutter', () => ({ createReviewExtension: () => ({ extension: [], destroy() {} }) }));
vi.mock('../src/mcp/tools', () => ({ registerTools: vi.fn() }));

const roots: string[] = [];
function gate() { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); return { promise, release }; }
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'wikiship-lifecycle-')); roots.push(root);
  const directory = join(root, '.obsidian/plugins/wikiship');
  const adapter = new FileSystemAdapter(); vi.spyOn(adapter, 'getBasePath').mockReturnValue(root);
  const app = { vault: { adapter, configDir: '.obsidian', on: vi.fn() }, workspace: { on: vi.fn(), onLayoutReady: vi.fn() } } as unknown as App;
  const plugin = (Ctor = WikiShip) => new Ctor(app, { id: 'wikiship' } as PluginManifest);
  return { root, directory, plugin };
}
afterEach(async () => { vi.restoreAllMocks(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

async function blockedPin(plugin: WikiShip) {
  const entered = gate(), finish = gate(), save = AtomicStateStore.prototype.save;
  vi.spyOn(AtomicStateStore.prototype, 'save').mockImplementationOnce(async function(this: AtomicStateStore, state) { entered.release(); await finish.promise; return save.call(this, state); });
  const item = pin('note', 'synthetic.md', 'synthetic test content');
  const pending = plugin.journal.addContext(item);
  await entered.promise;
  return { item, pending, finish };
}

describe('plugin journal lifecycle', () => {
  it('waits across module reload for accepted writes, then opens their saved state', async () => {
    const { root, directory, plugin } = await fixture();
    const old = plugin(); await old.onload();
    const work = await blockedPin(old), lock = join(directory, 'state.lock');
    const before = await readFile(lock, 'utf8');
    old.onunload();
    await expect(old.journal.removeContext()).rejects.toThrow('unloading');
    // Obsidian discards the old plugin module on reload: a module-local map
    // would fail this test even though a same-module replacement could pass.
    vi.resetModules();
    const { default: ReloadedWikiShip } = await import('../src/main');
    const { AtomicStateStore: ReloadedStore } = await import('../src/provenance/storage');
    const open = vi.spyOn(ReloadedStore.prototype, 'open');
    const path = vi.spyOn(old.app.vault.adapter as FileSystemAdapter, 'getBasePath').mockClear();
    const next = plugin(ReloadedWikiShip), opening = next.onload();
    try {
      await vi.waitFor(() => expect(path).toHaveBeenCalledOnce());
      expect(await readFile(lock, 'utf8')).toBe(before);
      expect(open).not.toHaveBeenCalled();
      // A different vault can still start while this journal drains.
      const otherFixture = await fixture(), other = otherFixture.plugin();
      await other.onload(); other.onunload(); await waitForJournalShutdown(otherFixture.directory);
      work.finish.release(); await work.pending; await opening;
      expect(next.journal.state.context).toEqual([work.item]);
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
    const work = await blockedPin(old), lock = join(directory, 'state.lock');
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
      expect(next.journal.state.context).toEqual([work.item]);
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
      expect(next.journal.state.context).toEqual([]);
      await expect(next.journal.addContext(pin('note', 'synthetic.md', 'text'))).resolves.toMatchObject({ path: 'synthetic.md' });
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
      await expect(old.journal.removeContext()).rejects.toThrow('unloading');
      expect(next.journal.state.context).toEqual([]);
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
      await expect(owner.journal.addContext(pin('note', 'synthetic.md', 'text'))).resolves.toMatchObject({ path: 'synthetic.md' });
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
    expect(reported).toHaveBeenCalledWith('WikiShip could not close its journal', expect.any(Error));
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
