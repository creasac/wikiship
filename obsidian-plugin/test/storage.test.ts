import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, writeFile, symlink, rm, rename } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import { join, parse, sep } from 'node:path';
import { AtomicStateStore, PathPolicy } from '../src/provenance/storage';
import { emptyState } from '../src/model';
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function root() { const path = await mkdtemp(join(tmpdir(), 'wikiship-storage-')); roots.push(path); return path; }
describe('path policy', () => {
  it('rejects traversal, absolute paths, configuration, and generated directories', async () => {
    const dir = await root(), policy = new PathPolicy(dir, '.custom-config');
    for (const path of ['../escape', '/tmp/escape', 'C:\\file', 'a//b', './a', 'a/../b', 'file:stream', '.git/config', '.custom-config/data', 'nested/node_modules/a.js', 'dist/a', 'dir./a']) expect(() => policy.validate(path), path).toThrow();
    expect(() => policy.validate('.obsidian/data')).not.toThrow();
    expect(await policy.check('src/main.ts')).toBe(join(dir, 'src/main.ts'));
    for (const path of ['nested/.git/config', 'nested/.Git', 'nested/.trash/deleted.md', 'nested/.custom-config/data']) expect(() => policy.validate(path), path).toThrow('excluded');
  });
  it('rejects leaf and ancestor symlinks, including broken links', async () => {
    const dir = await root(), outside = await root(), policy = new PathPolicy(dir, '.obsidian');
    await writeFile(join(outside, 'secret'), 'secret');
    await symlink(outside, join(dir, 'linked')); await symlink(join(outside, 'missing'), join(dir, 'broken'));
    await expect(policy.check('linked/secret')).rejects.toThrow('symlink');
    await expect(policy.check('broken')).rejects.toThrow('symlink');
  });
  it('accepts files under a filesystem root or trailing-slash vault root', async () => {
    const dir = await root(), filesystemRoot = parse(dir).root;
    expect(new PathPolicy(filesystemRoot, '.obsidian').validate('tmp/note.md')).toBe(join(filesystemRoot, 'tmp/note.md'));
    expect(new PathPolicy(dir + sep, '.obsidian').validate('note.md')).toBe(join(dir, 'note.md'));
  });
});
describe('atomic journal persistence', () => {
  it('survives reopen and rejects simultaneous writers', async () => {
    const dir = await root(), data = join(dir, '.obsidian/plugins/wikiship');
    const store = new AtomicStateStore(data, dir); await store.open(); expect(await store.load()).toBeNull();
    await store.save(emptyState());
    const second = new AtomicStateStore(data, dir); await expect(second.open()).rejects.toThrow('already open');
    await store.close(); await second.open(); expect(await second.load()).toEqual(emptyState()); await second.close();
  });
  it('does not overwrite externally edited or corrupt state', async () => {
    const dir = await root(), data = join(dir, '.obsidian/plugins/wikiship');
    const store = new AtomicStateStore(data, dir); await store.open(); await store.load(); await store.save(emptyState());
    await writeFile(join(data, 'state.json'), '{bad json');
    await expect(store.save(emptyState())).rejects.toThrow('changed outside');
    expect(await readFile(join(data, 'state.json'), 'utf8')).toBe('{bad json'); await store.close();
  });
  it('refuses a symlinked data directory', async () => {
    const dir = await root(), outside = await root(); await mkdir(join(dir, '.obsidian'));
    await symlink(outside, join(dir, '.obsidian/plugins'));
    await expect(new AtomicStateStore(join(dir, '.obsidian/plugins/wikiship'), dir).open()).rejects.toThrow('symlink');
  });
  it('resolves the data location correctly when the vault path has a trailing slash', async () => {
    const dir = await root(), data = join(dir, '.obsidian/plugins/wikiship');
    const store = new AtomicStateStore(data, dir + sep);
    await store.open(); await store.load(); await store.save(emptyState()); await store.close();
    expect(JSON.parse(await readFile(join(data, 'state.json'), 'utf8'))).toEqual(emptyState());
  });
  it('refuses a data-directory symlink introduced after opening without writing its target', async () => {
    const dir = await root(), outside = await root(), data = join(dir, '.obsidian/plugins/wikiship');
    const store = new AtomicStateStore(data, dir);
    await store.open(); await store.load(); await store.save(emptyState());
    const original = await readFile(join(data, 'state.json'), 'utf8');
    await writeFile(join(outside, 'state.json'), original);
    await rename(data, data + '-original'); await symlink(outside, data);
    await expect(store.save(emptyState())).rejects.toThrow('symlink');
    await expect(store.load()).rejects.toThrow('symlink');
    expect(await readFile(join(outside, 'state.json'), 'utf8')).toBe(original);
    await rm(data); await rename(data + '-original', data); await store.close();
  });
  it('recovers a confirmed dead local legacy owner under the recovery guard', async () => {
    const dir = await root(), data = join(dir, '.obsidian/plugins/wikiship');
    await mkdir(data, { recursive: true });
    const stale = JSON.stringify({ pid: 2147483647, host: hostname(), token: '00000000-0000-4000-8000-000000000000' });
    await writeFile(join(data, 'state.lock'), stale);
    const kill = vi.spyOn(process, 'kill').mockImplementationOnce(() => { throw Object.assign(new Error('No such process'), { code: 'ESRCH' }); });
    const store = new AtomicStateStore(data, dir);
    try { await store.open(); } finally { kill.mockRestore(); }
    expect(JSON.parse(await readFile(join(data, 'state.lock'), 'utf8')).pid).toBe(process.pid);
    expect(await store.load()).toBeNull(); await store.close();
  });
  it.each(['live', 'foreign', 'unverifiable', 'malformed'])('preserves a %s legacy owner record', async kind => {
    const dir = await root(), data = join(dir, '.obsidian/plugins/wikiship'); await mkdir(data, { recursive: true });
    const owner = JSON.stringify({ pid: kind === 'live' ? process.pid : 2147483647, host: kind === 'foreign' ? hostname() + '-foreign' : hostname(), token: '00000000-0000-4000-8000-000000000000' });
    const record = kind === 'malformed' ? '{partial' : owner;
    await writeFile(join(data, 'state.lock'), record);
    const kill = kind === 'unverifiable' ? vi.spyOn(process, 'kill').mockImplementation(() => { throw Object.assign(new Error('Permission denied'), { code: 'EPERM' }); }) : undefined;
    try { await expect(new AtomicStateStore(data, dir).open()).rejects.toThrow(); }
    finally { kill?.mockRestore(); }
    expect(await readFile(join(data, 'state.lock'), 'utf8')).toBe(record);
    await expect(readFile(join(data, 'state.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it.each(['live', 'foreign', 'malformed'])('preserves a %s recovery guard', async kind => {
    const dir = await root(), data = join(dir, '.obsidian/plugins/wikiship'), guard = join(data, 'state.lock.guard');
    await mkdir(guard, { recursive: true });
    const token = '00000000-0000-4000-8000-000000000000', path = join(guard, `owner-${token}.json`);
    const record = kind === 'malformed' ? '{partial' : JSON.stringify({ pid: process.pid, host: kind === 'foreign' ? hostname() + '-foreign' : hostname(), token });
    await writeFile(path, record);
    await expect(new AtomicStateStore(data, dir).open()).rejects.toThrow();
    expect(await readFile(path, 'utf8')).toBe(record);
    await expect(readFile(join(data, 'state.lock'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('rejects lock and guard symlinks without changing their targets', async () => {
    const dir = await root(), outside = await root(), data = join(dir, '.obsidian/plugins/wikiship');
    await mkdir(data, { recursive: true });
    const target = join(outside, 'owner.json'); await writeFile(target, 'preserve');
    await symlink(target, join(data, 'state.lock'));
    await expect(new AtomicStateStore(data, dir).open()).rejects.toThrow('ownership');
    expect(await readFile(target, 'utf8')).toBe('preserve'); await rm(join(data, 'state.lock'));
    await symlink(outside, join(data, 'state.lock.guard'));
    await expect(new AtomicStateStore(data, dir).open()).rejects.toThrow();
    expect(await readFile(target, 'utf8')).toBe('preserve');
  });

});
