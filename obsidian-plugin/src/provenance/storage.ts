import * as fs from 'node:fs/promises';
import { hostname } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep, win32 } from 'node:path';
import { hash, id, type State, type StateStore } from '../model';
export { MAX_FILE_BYTES } from '../model';

export const DEFAULT_EXCLUSIONS = ['node_modules', 'dist', 'build', 'coverage', 'vendor', '.cache'];
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';
function descendant(root: string, path: string): string {
  const result = relative(resolve(root), resolve(path));
  if (!result || result === '..' || result.startsWith('..' + sep) || isAbsolute(result)) throw new Error('Path is outside the vault.');
  return result;
}

/** WikiShip's path policy; it never changes Obsidian's own visibility settings. */
export class PathPolicy {
  constructor(readonly root: string, private configDir: string, private exclusions = DEFAULT_EXCLUSIONS) {}
  validate(path: string): string {
    if (!path || path.includes('\\') || /[\x00-\x1f:]/.test(path) || path.startsWith('/') || win32.isAbsolute(path)) throw new Error('Use a vault-relative path with forward slashes.');
    const parts = path.split('/');
    if (parts.some(p => !p || p === '.' || p === '..' || p.endsWith('.') || p.endsWith(' '))) throw new Error('Path contains an invalid segment.');
    const internal = [this.configDir, '.obsidian', '.git', '.trash'];
    const lower = path.toLowerCase();
    const reserved = internal.filter(p => !p.includes('/'));
    if (internal.some(p => lower === p.toLowerCase() || lower.startsWith(p.toLowerCase() + '/')) ||
      parts.some(p => [...reserved, ...this.exclusions].some(e => e.toLowerCase() === p.toLowerCase()))) throw new Error('Path is excluded from WikiShip.');
    const absolute = resolve(this.root, path);
    descendant(this.root, absolute);
    return absolute;
  }
  async check(path: string): Promise<string> {
    const absolute = this.validate(path);
    // Refuse symlinks, including parent directories, instead of following them out
    // of the vault or into an excluded location.
    await assertNoSymlinks(this.root, path);
    return absolute;
  }
}

async function assertNoSymlinks(root: string, path: string) {
  let current = root;
  for (const part of path.split('/')) {
    current = join(current, part);
    try { if ((await fs.lstat(current)).isSymbolicLink()) throw new Error('WikiShip does not follow symlinks.'); }
    catch (error) { if (missing(error)) return; throw error; }
  }
}

/** Atomic local persistence with a writer lock and detection of external changes. */
export class AtomicStateStore implements StateStore {
  private expected: string | null = null;
  private token = id();
  private locked = false;
  private closed = false;
  constructor(readonly directory: string, private vaultRoot: string) {}
  private get path() { return join(this.directory, 'state.json'); }
  private get lockPath() { return join(this.directory, 'state.lock'); }
  private async checkDirectory() {
    await assertNoSymlinks(this.vaultRoot, descendant(this.vaultRoot, this.directory).split(sep).join('/'));
  }
  async open() {
    await this.checkDirectory();
    await fs.mkdir(this.directory, { recursive: true });
    await this.checkDirectory();
    const acquire = async () => {
      const handle = await fs.open(this.lockPath, 'wx', 0o600);
      try { await handle.writeFile(JSON.stringify({ pid: process.pid, host: hostname(), token: this.token })); await handle.sync(); }
      finally { await handle.close(); }
      this.locked = true;
    };
    try { await acquire(); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const lock = JSON.parse(await fs.readFile(this.lockPath, 'utf8')) as { pid: number; host: string };
      if (lock.host !== hostname() || !Number.isInteger(lock.pid) || lock.pid <= 0) throw new Error('WikiShip journal is locked by another instance.');
      try { process.kill(lock.pid, 0); }
      catch (check) {
        // Two concurrent reclaimers could otherwise unlink each other's newly
        // acquired lock. Never remove another instance's lock automatically.
        if ((check as NodeJS.ErrnoException).code === 'ESRCH') throw new Error('A stale WikiShip journal lock remains. After closing other vault instances, remove state.lock from the WikiShip plugin folder and reload the plugin.');
        throw check;
      }
      throw new Error('WikiShip journal is already open in another instance.');
    }
  }
  private async raw(): Promise<string | null> {
    await this.checkDirectory();
    try {
      if ((await fs.lstat(this.path)).isSymbolicLink()) throw new Error('Journal cannot be a symlink.');
      return await fs.readFile(this.path, 'utf8');
    } catch (error) { if (missing(error)) return null; throw error; }
  }
  async load() {
    if (!this.locked || this.closed) throw new Error('Journal store is not open.');
    const raw = await this.raw(); this.expected = raw === null ? null : hash(raw);
    return raw === null ? null : JSON.parse(raw) as unknown;
  }
  async save(state: State) {
    if (!this.locked || this.closed) throw new Error('Journal store is not open.');
    const current = await this.raw();
    if ((current === null ? null : hash(current)) !== this.expected) throw new Error('Journal changed outside WikiShip. Reload after resolving the external change.');
    const data = JSON.stringify(state);
    const temporary = join(this.directory, `state.${id()}.tmp`);
    const handle = await fs.open(temporary, 'wx', 0o600);
    try { await handle.writeFile(data, 'utf8'); await handle.sync(); }
    finally { await handle.close(); }
    try {
      const latest = await this.raw();
      if ((latest === null ? null : hash(latest)) !== this.expected) throw new Error('Journal changed outside WikiShip while saving. Resolve the external change before recovery.');
      // Rename keeps the previous complete state intact if writing the temp file fails.
      await fs.rename(temporary, this.path);
      this.expected = hash(data);
      // Directory fsync is supported on Unix, but not on every Windows filesystem.
      if (process.platform !== 'win32') {
        const directory = await fs.open(dirname(this.path), 'r');
        try { await directory.sync(); } finally { await directory.close(); }
      }
    } finally { await fs.unlink(temporary).catch(error => { if (!missing(error)) throw error; }); }
  }
  async close() {
    this.closed = true;
    if (!this.locked) return;
    await this.checkDirectory();
    const lock = JSON.parse(await fs.readFile(this.lockPath, 'utf8')) as { token: string };
    if (lock.token === this.token) await fs.unlink(this.lockPath);
    this.locked = false;
  }
}
