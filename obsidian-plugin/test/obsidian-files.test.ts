import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
vi.mock('obsidian', () => ({ MarkdownView: class MarkdownView {}, TFile: class TFile {} }));
import { MarkdownView, TFile, type App } from 'obsidian';
import { ObsidianFiles } from '../src/provenance/obsidian-files';
import { PathPolicy } from '../src/provenance/storage';
import { Journal } from '../src/provenance/journal';
import { hash, type State, type StateStore } from '../src/model';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await fs.mkdtemp(join(tmpdir(), 'wikiship-adapter-')); roots.push(root);
  const tracked = new Map<string, TFile>(), views: MarkdownView[] = [];
  function track(path: string) {
    const file = Object.assign(Object.create(TFile.prototype) as TFile, { path, stat: { mtime: 0 } });
    tracked.set(path, file); return file;
  }
  const adapter = {
    readBinary: async (path: string) => Uint8Array.from(await fs.readFile(join(root, path))).buffer,
    process: async (path: string, update: (text: string) => string) => {
      const current = await fs.readFile(join(root, path), 'utf8');
      await fs.writeFile(join(root, path), update(current));
    },
    remove: async (path: string) => { await fs.unlink(join(root, path)); },
    rename: async (from: string, to: string) => { await fs.rename(join(root, from), join(root, to)); },
  };
  const app = {
    workspace: { getLeavesOfType: () => views.map(view => ({ view })) },
    vault: {
      adapter, getFileByPath: (path: string) => tracked.get(path) ?? null,
      getAbstractFileByPath: (path: string) => tracked.get(path) ?? null,
      create: async (path: string, value: string) => { await fs.writeFile(join(root, path), value, { flag: 'wx' }); return track(path); },
      createBinary: async (path: string, value: ArrayBuffer) => { await fs.writeFile(join(root, path), new Uint8Array(value), { flag: 'wx' }); return track(path); },
      delete: async (file: TFile) => { await adapter.remove(file.path); tracked.delete(file.path); },
      rename: async (file: TFile, target: string) => { const source = file.path; await adapter.rename(source, target); tracked.delete(source); file.path = target; tracked.set(target, file); },
      process: async (file: TFile, update: (text: string) => string) => adapter.process(file.path, update),
    },
  } as unknown as App;
  let saved: State | null = null;
  const store: StateStore = { load: async () => saved, save: async state => { saved = structuredClone(state); } };
  const files = new ObsidianFiles(app, new PathPolicy(root, '.obsidian')), journal = new Journal(store, files);
  await fs.writeFile(join(root, 'note.md'), 'original'); track('note.md'); await journal.load();
  return { root, app, adapter, views, tracked, files, journal, store };
}

describe('Obsidian file adapter boundaries with real temporary files', () => {
  it('refuses an unsaved open editor without attribution or a recovery lockout', async () => {
    const { root, views, tracked, journal } = await fixture();
    views.push(Object.assign(Object.create(MarkdownView.prototype) as MarkdownView, {
      file: tracked.get('note.md'), getMode: () => 'source', editor: { getValue: () => 'unsaved human text' },
    }));
    await expect(journal.mutate({ kind: 'edit', path: 'note.md', expectedHash: hash('original'), from: 0, to: 8, content: 'AI' })).rejects.toThrow('unsaved content');
    expect(await fs.readFile(join(root, 'note.md'), 'utf8')).toBe('original');
    expect(journal.state.operations[0]!.status).toBe('failed');
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
    expect(journal.state.operations[0]!.status).toBe('failed');
    await journal.mutate({ kind: 'edit', path: 'note.md', expectedHash: hash('human disk update'), from: 17, to: 17, content: ' plus AI' });
    expect(await fs.readFile(join(root, 'note.md'), 'utf8')).toBe('human disk update plus AI');
  });

  it('refuses a move destination created while its write-ahead intent is saved', async () => {
    const { root, store, journal } = await fixture(), save = store.save.bind(store);
    vi.spyOn(store, 'save').mockImplementationOnce(async state => { await save(state); await fs.writeFile(join(root, 'destination.md'), 'human destination'); });
    await expect(journal.mutate({ kind: 'move', path: 'note.md', target: 'destination.md', expectedHash: hash('original') })).rejects.toThrow('failed');
    expect(journal.state.operations[0]!.status).toBe('failed');
    expect(await fs.readFile(join(root, 'note.md'), 'utf8')).toBe('original');
    expect(await fs.readFile(join(root, 'destination.md'), 'utf8')).toBe('human destination');
  });

  it('restores exact binary bytes through the adapter after a tracked deletion', async () => {
    const { root, journal } = await fixture(), binary = Buffer.from([0, 255, 254, 128, 13, 10]);
    await fs.writeFile(join(root, 'image.bin'), binary);
    const op = await journal.mutate({ kind: 'delete', path: 'image.bin', expectedHash: hash(binary) });
    await expect(fs.stat(join(root, 'image.bin'))).rejects.toMatchObject({ code: 'ENOENT' });
    await journal.revert(op.id);
    expect(await fs.readFile(join(root, 'image.bin'))).toEqual(binary);
    expect(journal.state.operations[0]!.status).toBe('reverted');
  });
});
