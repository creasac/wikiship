import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { build } from 'esbuild';
import { fork, type ChildProcess } from 'node:child_process';
import { mkdtemp, readFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

let scripts: string, fixture: string;
const roots: string[] = [], processes: ChildProcess[] = [];
beforeAll(async () => {
  scripts = await mkdtemp(join(tmpdir(), 'wikiship-process-fixture-')); fixture = join(scripts, 'writer.cjs');
  const source = fileURLToPath(new URL('../src', import.meta.url));
  await build({ bundle: true, platform: 'node', format: 'cjs', outfile: fixture, stdin: { resolveDir: source, contents: `
    import fs from 'node:fs/promises';
    import { hostname } from 'node:os';
    import { AtomicStateStore } from './provenance/storage';
    import { Journal } from './provenance/journal';
    import { emptyState, id, textSnapshot } from './model';
    const [root, mode] = process.argv.slice(2), directory = root + '/.obsidian/plugins/wikiship';
    const send = message => new Promise(resolve => process.send(message, resolve));
    let store, journal, resume;
    if (mode === 'guard-only' || mode === 'recovery-race') {
      const link = fs.link; let calls = 0;
      fs.link = async (...args) => {
        if (++calls === (mode === 'guard-only' ? 1 : 2)) {
          await send({ phase: mode }); await new Promise(resolve => { resume = resolve; });
        }
        return link(...args);
      };
    }
    if (mode === 'delayed-reaper') {
      const read = fs.readFile; let delayed = false;
      fs.readFile = async (...args) => {
        const result = await read(...args);
        if (!delayed && String(args[0]).includes('state.lock.guard/owner-')) {
          delayed = true; await send({ phase: 'dead-owner-read' }); await new Promise(resolve => { resume = resolve; });
        }
        return result;
      };
    }
    const files = {
      async read(path) { try { return textSnapshot(await fs.readFile(root + '/' + path, 'utf8')); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } },
      async apply(op) { await fs.writeFile(root + '/' + op.path, op.after.data); if (mode === 'pending') { await send({ phase: 'file-written' }); await new Promise(() => {}); } }
    };
    process.on('message', async action => {
      if (action === 'resume') { resume(); return; }
      if (action === 'exit') process.exit(0); // No opportunity to finish async unload.
      if (action === 'close') { await journal?.close(); await store?.close(); await send({ closed: true }); process.exit(0); }
      if (action !== 'open') return;
      try {
        if (mode === 'legacy') {
          await fs.mkdir(directory, { recursive: true });
          await fs.writeFile(directory + '/state.lock', JSON.stringify({ pid: process.pid, host: hostname(), token: id() }), { flag: 'wx', mode: 0o600 });
          await send({ opened: true, pid: process.pid }); return;
        }
        store = new AtomicStateStore(directory, root); await store.open();
        // Seed legacy compatibility data directly; no pin API remains.
        if (mode === 'seed' || mode === 'pending') await store.save({ ...emptyState(), context: [{ snapshot: 'synthetic saved pin' }] });
        journal = new Journal(store, files); await journal.load();
        await send({ opened: true, pid: process.pid, state: journal.state });
        if (mode === 'pending') await journal.mutate({ kind: 'create', path: 'synthetic.md', content: 'synthetic written text' });
      } catch (error) { await send({ opened: false, error: String(error) }); process.exit(2); }
    });
    send({ ready: true });
  ` } });
});
afterEach(async () => {
  await Promise.all(processes.splice(0).map(child => new Promise<void>(resolve => {
    if (child.exitCode !== null || child.signalCode !== null) { resolve(); return; }
    child.once('exit', () => resolve()); child.kill('SIGKILL');
  })));
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
afterAll(async () => { await rm(scripts, { recursive: true, force: true }); });
interface Reply { ready?: boolean; opened?: boolean; pid?: number; error?: string; phase?: string; closed?: boolean; state?: { context: { snapshot: string }[]; operations: { status: string }[] }; }
function writer(root: string, mode = 'normal') {
  const child = fork(fixture, [root, mode], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] }); processes.push(child);
  const messages: Reply[] = [], waiters: ((reply: Reply) => void)[] = [];
  child.on('message', message => { const waiter = waiters.shift(); if (waiter) waiter(message as Reply); else messages.push(message as Reply); });
  const exited = new Promise<void>(resolve => child.once('exit', () => resolve()));
  const next = () => messages.length ? Promise.resolve(messages.shift()!) : new Promise<Reply>(resolve => waiters.push(resolve));
  return { child, next, exited, async open() { expect(await next()).toEqual({ ready: true }); child.send('open'); return next(); } };
}
async function root() { const path = await mkdtemp(join(tmpdir(), 'wikiship-process-lock-')); roots.push(path); return path; }
async function lock(path: string) { return readFile(join(path, '.obsidian/plugins/wikiship/state.lock'), 'utf8'); }

describe('journal ownership across real process lifetimes', () => {
  it.each(['exit', 'kill'])('recovers after %s without losing legacy context data', async stop => {
    const dir = await root(), old = writer(dir, 'seed'); expect((await old.open()).opened).toBe(true);
    const before = await readFile(join(dir, '.obsidian/plugins/wikiship/state.json'), 'utf8');
    if (stop === 'exit') old.child.send('exit'); else old.child.kill('SIGKILL'); await old.exited;
    const next = writer(dir), opened = await next.open();
    expect(opened.opened, opened.error).toBe(true);
    expect(opened.state?.context[0]?.snapshot).toBe('synthetic saved pin');
    expect(await readFile(join(dir, '.obsidian/plugins/wikiship/state.json'), 'utf8')).toBe(before);
    next.child.send('close'); expect(await next.next()).toEqual({ closed: true }); await next.exited;
    await expect(lock(dir)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('recovers interrupted mutation intent after the writer is killed', async () => {
    const dir = await root(), old = writer(dir, 'pending'); expect((await old.open()).opened).toBe(true);
    expect(await old.next()).toEqual({ phase: 'file-written' }); old.child.kill('SIGKILL'); await old.exited;
    const next = writer(dir), opened = await next.open();
    expect(opened.opened, opened.error).toBe(true); expect(opened.state?.operations[0]?.status).toBe('applied');
    expect(await readFile(join(dir, 'synthetic.md'), 'utf8')).toBe('synthetic written text');
  });

  it.each(['seed', 'legacy'])('admits only one of six simultaneous reclaimers of a dead %s owner', async mode => {
    const dir = await root(), old = writer(dir, mode); expect((await old.open()).opened).toBe(true);
    old.child.kill('SIGKILL'); await old.exited;
    const contenders = Array.from({ length: 6 }, () => writer(dir));
    for (const contender of contenders) expect(await contender.next()).toEqual({ ready: true });
    for (const contender of contenders) contender.child.send('open');
    const replies = await Promise.all(contenders.map(contender => contender.next()));
    const winners = replies.filter(reply => reply.opened); expect(winners).toHaveLength(1);
    const owned = await lock(dir); expect(JSON.parse(owned).pid).toBe(winners[0]!.pid);
    const extra = writer(dir); expect((await extra.open()).opened).toBe(false); expect(await lock(dir)).toBe(owned);
    if (mode === 'seed') expect(winners[0]!.state?.context[0]?.snapshot).toBe('synthetic saved pin');
  });

  it('recovers a crash after publishing the guard but before the legacy lock', async () => {
    const dir = await root(), old = writer(dir, 'guard-only'); expect(await old.open()).toEqual({ phase: 'guard-only' });
    old.child.kill('SIGKILL'); await old.exited;
    const next = writer(dir); const opened = await next.open(); expect(opened.opened, opened.error).toBe(true);
  });

  it('does not replace an older plugin that wins during legacy-lock publication', async () => {
    const dir = await root(), dead = writer(dir, 'legacy'); expect((await dead.open()).opened).toBe(true);
    dead.child.kill('SIGKILL'); await dead.exited;
    const recovering = writer(dir, 'recovery-race'); expect(await recovering.open()).toEqual({ phase: 'recovery-race' });
    const olderPlugin = writer(dir, 'legacy'); expect((await olderPlugin.open()).opened).toBe(true);
    const owned = await lock(dir); recovering.child.send('resume'); expect((await recovering.next()).opened).toBe(false);
    expect(await lock(dir)).toBe(owned);
  });

  it('accepts an empty guard left between owner release and directory cleanup', async () => {
    const dir = await root(); await mkdir(join(dir, '.obsidian/plugins/wikiship/state.lock.guard'), { recursive: true });
    const next = writer(dir); const opened = await next.open(); expect(opened.opened, opened.error).toBe(true);
  });
  it('cannot unlink a replacement owner after a delayed dead-owner inspection', async () => {
    const dir = await root(), dead = writer(dir, 'seed'); expect((await dead.open()).opened).toBe(true);
    dead.child.kill('SIGKILL'); await dead.exited;
    const delayed = writer(dir, 'delayed-reaper'); expect(await delayed.open()).toEqual({ phase: 'dead-owner-read' });
    const winner = writer(dir); const opened = await winner.open(); expect(opened.opened, opened.error).toBe(true);
    const owned = await lock(dir); delayed.child.send('resume'); expect((await delayed.next()).opened).toBe(false);
    expect(await lock(dir)).toBe(owned);
  });

});
