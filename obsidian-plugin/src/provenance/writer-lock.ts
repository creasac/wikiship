import * as fs from 'node:fs/promises';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { id } from '../model';

interface Owner { pid: number; host: string; token: string; }
const tokenPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const code = (error: unknown) => (error as NodeJS.ErrnoException).code;
const unknownOwner = () => new Error('wikidiff journal lock ownership cannot be verified. Preserve the lock and close other vault instances before recovery.');
async function ownerAt(path: string): Promise<Owner> {
  if (!(await fs.lstat(path)).isFile()) throw unknownOwner(); // Never follow a lock symlink.
  let owner: Partial<Owner> | null;
  try { owner = JSON.parse(await fs.readFile(path, 'utf8')) as Partial<Owner> | null; }
  catch (error) { if (code(error) === 'ENOENT') throw error; throw unknownOwner(); }
  if (!owner || !Number.isInteger(owner.pid) || owner.pid! <= 0 || typeof owner.host !== 'string' || typeof owner.token !== 'string' || !tokenPattern.test(owner.token)) throw unknownOwner();
  return owner as Owner;
}
function requireDead(owner: Owner) {
  if (owner.host !== hostname()) throw new Error('wikidiff journal is locked by another host.');
  try { process.kill(owner.pid, 0); }
  catch (error) {
    if (code(error) === 'ESRCH') return;
    throw unknownOwner(); // EPERM and other errors are not evidence of death.
  }
  // A reused PID is deliberately treated as live; names/ages are not proof.
  throw new Error('wikidiff journal is already open in another instance.');
}

/** Serializes dead-owner recovery without a second unrecoverable lock file. */
export class JournalWriterLock {
  private readonly token = id();
  private readonly ownerName = `owner-${this.token}.json`;
  private readonly guard: string;
  private readonly legacy: string;
  private guardOwned = false;
  private legacyOwned = false;
  constructor(private directory: string, private checkDirectory: () => Promise<void>) {
    this.guard = join(directory, 'state.lock.guard');
    this.legacy = join(directory, 'state.lock');
  }
  private async checkGuard() {
    await this.checkDirectory();
    if (!(await fs.lstat(this.guard)).isDirectory()) throw unknownOwner();
  }
  private async removeEmptyGuard() {
    try { await fs.rmdir(this.guard); }
    catch (error) { if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(code(error)!)) throw error; }
  }
  async open() {
    const staging = await fs.mkdtemp(join(this.directory, 'state.lock-'));
    const prepared = join(staging, this.ownerName);
    try {
      const handle = await fs.open(prepared, 'wx', 0o600);
      try { await handle.writeFile(JSON.stringify({ pid: process.pid, host: hostname(), token: this.token })); await handle.sync(); }
      finally { await handle.close(); }
      for (let attempt = 0; attempt < 16; attempt++) {
        await this.checkDirectory();
        try {
          // Publish an already populated directory. A live guard is never empty;
          // rename cannot replace it. Empty leftovers are safe to remove.
          await fs.rename(staging, this.guard); this.guardOwned = true; break;
        } catch (error) {
          if (!['EEXIST', 'ENOTEMPTY', 'EPERM'].includes(code(error)!)) throw error;
        }
        try {
          await this.checkGuard();
          const entries = await fs.readdir(this.guard);
          if (entries.length === 0) { await this.removeEmptyGuard(); continue; }
          if (entries.length !== 1 || !/^owner-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.json$/.test(entries[0]!)) throw unknownOwner();
          const path = join(this.guard, entries[0]!);
          const owner = await ownerAt(path);
          if (entries[0] !== `owner-${owner.token}.json`) throw unknownOwner();
          requireDead(owner);
          // A delayed reclaimer can only unlink the dead owner's unique name,
          // never a replacement owner's record. No recursive directory deletion.
          await fs.unlink(path);
          await this.removeEmptyGuard();
        } catch (error) { if (code(error) !== 'ENOENT') throw error; }
      }
      if (!this.guardOwned) throw new Error('wikidiff journal ownership is changing. Try enabling the plugin again.');
      const record = join(this.guard, this.ownerName);
      try { await fs.link(record, this.legacy); }
      catch (error) {
        if (code(error) !== 'EEXIST') throw error;
        try {
          const owner = await ownerAt(this.legacy); requireDead(owner);
          // All new reclaimers hold the guard. An older plugin can race this
          // publication, but link's exclusive create then rejects that writer.
          await fs.unlink(this.legacy);
        } catch (error) { if (code(error) !== 'ENOENT') throw error; }
        await fs.link(record, this.legacy);
      }
      this.legacyOwned = true;
    } catch (error) { await this.close(); throw error; }
    finally {
      await fs.unlink(prepared).catch(error => { if (code(error) !== 'ENOENT') throw error; });
      await fs.rmdir(staging).catch(error => { if (code(error) !== 'ENOENT') throw error; });
    }
  }
  async close() {
    await this.checkDirectory();
    if (this.legacyOwned) {
      try { if ((await ownerAt(this.legacy)).token === this.token) await fs.unlink(this.legacy); }
      catch (error) { if (code(error) !== 'ENOENT') throw error; }
      this.legacyOwned = false;
    }
    if (this.guardOwned) {
      try { await this.checkGuard(); await fs.unlink(join(this.guard, this.ownerName)); }
      catch (error) { if (code(error) !== 'ENOENT') throw error; }
      await this.removeEmptyGuard(); this.guardOwned = false;
    }
  }
}
