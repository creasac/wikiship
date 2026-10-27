import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as fsSync from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
vi.mock('obsidian', () => ({ MarkdownView: class MarkdownView {}, TFile: class TFile {}, TFolder: class TFolder {} }));
import { MarkdownView, TFile, TFolder, type App } from 'obsidian';
import { ObsidianFiles } from '../src/provenance/obsidian-files';
import { PathPolicy } from '../src/provenance/storage';
import { Journal } from '../src/provenance/journal';
import { folderEntries, hash, type State, type StateStore } from '../src/model';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await fs.mkdtemp(join(tmpdir(), 'wikiship-adapter-')); roots.push(root);
  const tracked = new Map<string, TFile>(), folders = new Map<string, TFolder>(), views: MarkdownView[] = [];
  function track(path: string) {
    const file = Object.assign(Object.create(TFile.prototype) as TFile, { path, stat: { mtime: 0 } });
    tracked.set(path, file); return file;
  }
  function trackFolder(path: string) {
    const existing = folders.get(path);
    if (existing) return existing;
    const folder = Object.assign(Object.create(TFolder.prototype) as TFolder, { path });
    Object.defineProperty(folder, 'children', { get: () => fsSync.readdirSync(join(root, folder.path), { withFileTypes: true }).map(entry => {
      const childPath = `${folder.path}/${entry.name}`;
      return entry.isDirectory() ? trackFolder(childPath) : track(childPath);
    }) });
    folders.set(path, folder); return folder;
  }
  function getNode(path: string) {
    try { return fsSync.statSync(join(root, path)).isDirectory() ? trackFolder(path) : track(path); }
    catch { return null; }
  }
  const adapter = {
    readBinary: async (path: string) => Uint8Array.from(await fs.readFile(join(root, path))).buffer,
    process: async (path: string, update: (text: string) => string) => {
      const current = await fs.readFile(join(root, path), 'utf8');
      await fs.writeFile(join(root, path), update(current));
    },
    remove: async (path: string) => { await fs.unlink(join(root, path)); },
    rmdir: async (path: string) => { await fs.rmdir(join(root, path)); folders.delete(path); },
    rename: async (from: string, to: string) => { await fs.rename(join(root, from), join(root, to)); },
  };
  const app = {
    workspace: { getLeavesOfType: () => views.map(view => ({ view })) },
    vault: {
      adapter, getFileByPath: (path: string) => tracked.get(path) ?? null,
      getAbstractFileByPath: getNode,
      create: async (path: string, value: string) => { await fs.writeFile(join(root, path), value, { flag: 'wx' }); return track(path); },
      createBinary: async (path: string, value: ArrayBuffer) => { await fs.writeFile(join(root, path), new Uint8Array(value), { flag: 'wx' }); return track(path); },
      createFolder: async (path: string) => { await fs.mkdir(join(root, path)); return trackFolder(path); },
      rename: async (file: TFile | TFolder, target: string) => {
        const source = file.path; await adapter.rename(source, target);
        if (file instanceof TFolder) { folders.delete(source); file.path = target; folders.set(target, file); }
        else { tracked.delete(source); file.path = target; tracked.set(target, file); }
      },
      process: async (file: TFile, update: (text: string) => string) => adapter.process(file.path, update),
    },
    fileManager: {
      trashFile: async (file: TFile | TFolder) => {
        await fs.rm(join(root, file.path), { recursive: true, force: true });
        tracked.delete(file.path); folders.delete(file.path);
      },
    },
  } as unknown as App;
  let saved: State | null = null;
  const store: StateStore = { load: async () => saved, save: async state => { saved = structuredClone(state); } };
  const files = new ObsidianFiles(app, new PathPolicy(root, '.obsidian')), journal = new Journal(store, files);
  await fs.writeFile(join(root, 'note.md'), 'original'); track('note.md'); await journal.load();
  return { root, app, adapter, views, tracked, files, journal, store };
}

describe('Obsidian file adapter boundaries with real temporary files', () => {
  it('creates empty folders, moves a folder tree, and checks staged deletion against nested changes', async () => {
    const { root, journal, files } = await fixture();
    const created = await journal.mutateFolder({ kind: 'create-folder', path: 'empty' });
    expect((await fs.stat(join(root, 'empty'))).isDirectory()).toBe(true);
    await journal.undo(created.id);
    await expect(fs.stat(join(root, 'empty'))).rejects.toMatchObject({ code: 'ENOENT' });

    await fs.mkdir(join(root, 'tree'));
    await fs.mkdir(join(root, 'tree', 'empty child'));
    await fs.mkdir(join(root, 'tree', 'nested'));
    await fs.writeFile(join(root, 'tree', 'nested', 'note.md'), 'original');
    const before = await files.readFolder('tree');
    expect(folderEntries(before!)).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'empty child', kind: 'folder' }),
      expect.objectContaining({ path: 'nested/note.md', kind: 'file', hash: hash('original'), size: 8 }),
    ]));
    const moved = await journal.mutateFolder({ kind: 'move-folder', path: 'tree', target: 'renamed tree', expectedHash: before!.hash });
    expect((await files.readFolder('renamed tree'))?.hash).toBe(before!.hash);
    await journal.undo(moved.id);
    expect((await files.readFolder('tree'))?.hash).toBe(before!.hash);

    const deletion = await journal.mutateFolder({ kind: 'delete-folder', path: 'tree', expectedHash: before!.hash });
    await fs.writeFile(join(root, 'tree', 'nested', 'note.md'), 'human edit');
    await expect(journal.completeSession(deletion.session)).rejects.toThrow('changed after the deletion was staged');
    await expect(fs.stat(join(root, 'tree'))).resolves.toBeDefined();
    await fs.writeFile(join(root, 'tree', 'nested', 'note.md'), 'original');
    await journal.completeSession(deletion.session);
    await expect(fs.stat(join(root, 'tree'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('refuses an unsaved open editor without attribution or a recovery lockout', async () => {
    const { root, views, tracked, journal } = await fixture();
    views.push(Object.assign(Object.create(MarkdownView.prototype) as MarkdownView, {
      file: tracked.get('note.md'), getMode: () => 'source', editor: { getValue: () => 'unsaved human text' },
    }));
    await expect(journal.mutate({ kind: 'edit', path: 'note.md', expectedHash: hash('original'), from: 0, to: 8, content: 'AI' })).rejects.toThrow('unsaved content');
    expect(await fs.readFile(join(root, 'note.md'), 'utf8')).toBe('original');
    expect(journal.state.operations).toEqual([]);
    views.length = 0;
    await journal.mutate({ kind: 'edit', path: 'note.md', expectedHash: hash('original'), from: 0, to: 8, content: 'AI' });
    expect(await fs.readFile(join(root, 'note.md'), 'utf8')).toBe('AI');
  });

  it('refuses a disk change at the process callback and accepts a later fresh hash', async () => {
    const { root, adapter, journal } = await fixture(), process = adapter.process;
    vi.spyOn(adapter, 'process').mockImplementationOnce(async (...args) => {
      await fs.writeFile(join(root, 'note.md'), 'human disk update'); await process(...args);
    });
    await expect(journal.mutate({ kind: 'edit', path: 'note.md', expectedHash: hash('original'), from: 0, to: 8, content: 'AI' })).rejects.toThrow('changed during mutation');
    expect(await fs.readFile(join(root, 'note.md'), 'utf8')).toBe('human disk update');
    expect(journal.state.operations).toEqual([]);
    await journal.mutate({ kind: 'edit', path: 'note.md', expectedHash: hash('human disk update'), from: 17, to: 17, content: ' plus AI' });
    expect(await fs.readFile(join(root, 'note.md'), 'utf8')).toBe('human disk update plus AI');
  });

  it('refuses a move destination created while its write-ahead intent is saved', async () => {
    const { root, store, journal } = await fixture(), save = store.save.bind(store);
    vi.spyOn(store, 'save').mockImplementationOnce(async state => { await save(state); await fs.writeFile(join(root, 'destination.md'), 'human destination'); });
    await expect(journal.mutate({ kind: 'move', path: 'note.md', target: 'destination.md', expectedHash: hash('original') })).rejects.toThrow('failed');
    expect(journal.state.operations).toEqual([]);
    expect(await fs.readFile(join(root, 'note.md'), 'utf8')).toBe('original');
    expect(await fs.readFile(join(root, 'destination.md'), 'utf8')).toBe('human destination');
  });

  it('restores exact binary bytes through the adapter after a tracked deletion', async () => {
    const { root, journal, tracked } = await fixture(), binary = Buffer.from([0, 255, 254, 128, 13, 10]);
    await fs.writeFile(join(root, 'image.bin'), binary);
    const file = Object.assign(Object.create(TFile.prototype) as TFile, { path: 'image.bin', stat: { mtime: 0 } });
    tracked.set('image.bin', file);
    const op = await journal.mutate({ kind: 'delete', path: 'image.bin', expectedHash: hash(binary) });
    await expect(fs.readFile(join(root, 'image.bin'))).resolves.toEqual(binary);
    expect(op.status).toBe('pending-delete');
    await journal.completeAll();
    await expect(fs.stat(join(root, 'image.bin'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(journal.state.operations).toEqual([]);
  });
});
