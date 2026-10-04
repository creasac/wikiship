import { contextSchema, emptyState, id, isTextBoundary, MAX_FILE_BYTES, MutationPreconditionError, operationSchema, stateSchema, textOf, textSnapshot, SerialQueue, type ContextItem, type Operation, type State, type StateStore, type WorkspaceFiles } from '../model';

type FilePhase = 'before' | 'after' | 'unknown';

export class Journal {
  private current = emptyState();
  private queue = new SerialQueue();
  private listeners = new Set<() => void>();
  private loaded = false;
  private closed = false;
  private persistenceFault = false;
  constructor(private store: StateStore, readonly files: WorkspaceFiles) {}
  get state(): State { return structuredClone(this.current); }
  subscribe(listener: () => void) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  private emit() {
    for (const listener of this.listeners) {
      // A view failing to render must not turn a committed mutation into a failed one.
      try { listener(); } catch (error) { console.error('wikiship journal subscriber failed', error); }
    }
  }
  private run<T>(task: () => Promise<T>, initializing = false): Promise<T> {
    if (this.closed) return Promise.reject(new Error('wikiship is unloading. No new changes are accepted.'));
    return this.queue.run(async () => {
      if (!initializing && !this.loaded) throw new Error('The wikiship journal has not loaded successfully.');
      return task();
    });
  }
  /** Stop accepting work immediately, then let previously accepted operations finish. */
  async close(): Promise<void> { this.closed = true; await this.queue.drain(); this.listeners.clear(); }
  private async readState(): Promise<void> {
    const saved = await this.store.load();
    this.current = saved === null ? emptyState() : stateSchema.parse(saved);
    this.persistenceFault = false;
  }
  async load(): Promise<void> { return this.run(async () => {
    if (this.loaded) return;
    await this.readState();
    await this.recoverPending();
    this.loaded = true;
  }, true); }
  private async save(next: State) {
    try { await this.store.save(structuredClone(next)); }
    catch (error) { this.persistenceFault = true; throw error; }
    this.current = next;
    this.emit();
  }
  private async updateOperation(op: Operation) {
    const next = this.state, at = next.operations.findIndex(o => o.id === op.id);
    if (at < 0) next.operations.push(structuredClone(op)); else next.operations[at] = structuredClone(op);
    await this.save(next);
  }
  private assertStorage() {
    if (this.persistenceFault) throw new Error('Journal persistence failed. Run Recover interrupted operations before further changes.');
  }
  async addContext(item: ContextItem) { return this.run(async () => {
    this.assertStorage();
    const validated = contextSchema.parse(item), next = this.state;
    const existing = next.context.find(i => i.kind === validated.kind && i.path === validated.path && i.contentHash === validated.contentHash && i.from === validated.from && JSON.stringify(i.headingPath) === JSON.stringify(validated.headingPath));
    if (existing) return existing;
    if (next.context.some(i => i.id === validated.id)) throw new Error('Context item ID already exists.');
    next.context.push(validated); await this.save(next); return structuredClone(validated);
  }); }
  async removeContext(itemId?: string) { return this.run(async () => {
    this.assertStorage();
    const next = this.state; next.context = itemId ? next.context.filter(i => i.id !== itemId) : [];
    await this.save(next); return { remaining: next.context.length };
  }); }
  async renameContext(oldPath: string, newPath: string) { return this.run(async () => {
    this.assertStorage();
    const next = this.state;
    for (const item of next.context) if (item.path === oldPath || item.path.startsWith(oldPath + '/')) item.path = newPath + item.path.slice(oldPath.length);
    await this.save(next);
  }); }
  private assertSettled() {
    this.assertStorage();
    if (this.current.operations.some(o => ['prepared', 'reverting', 'uncertain'].includes(o.status))) throw new Error('An operation needs recovery. Inspect AI Changes and run Recover interrupted operations before further mutations.');
  }
  async mutate(input: { kind: Operation['kind']; path: string; target?: string; expectedHash?: string; content?: string; from?: number; to?: number; agent?: string; session?: string }, guard?: () => Promise<void> | void) {
    return this.run(async () => {
      this.assertSettled();
      // Editor-target preconditions are ephemeral. Recheck after waiting for the
      // queue, and after persisting intent; never serialize a callback or retarget.
      await guard?.();
      if (input.content !== undefined && Buffer.byteLength(input.content) > MAX_FILE_BYTES) throw new Error('Mutation content exceeds the 5 MiB file limit.');
      const before = await this.files.read(input.path);
      if (input.kind === 'create') {
        if (before !== null) throw new Error('Conflict: file already exists.');
      } else if (!before || before.hash !== input.expectedHash) throw new Error('Conflict: file changed or is missing. Read its current hash first.');
      if (input.kind === 'move' && (!input.target || input.target === input.path || await this.files.read(input.target) !== null)) throw new Error('Conflict: move destination must be a different, absent file.');
      let after = input.kind === 'delete' ? null : before;
      if (input.kind === 'create') after = textSnapshot(input.content ?? '');
      if (input.kind === 'edit') {
        const text = textOf(before!), from = input.from!, to = input.to!;
        if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to < from || to > text.length) throw new Error('Invalid UTF-16 range.');
        if (!isTextBoundary(text, from) || !isTextBoundary(text, to)) throw new Error('Range splits a Unicode character.');
        after = textSnapshot(text.slice(0, from) + (input.content ?? '') + text.slice(to));
        if (after.hash === before!.hash) throw new Error('No change to record.');
      }
      const op = operationSchema.parse({ id: id(), timestamp: new Date().toISOString(), kind: input.kind, path: input.path,
        target: input.target, before, after, status: 'prepared', recoveryDirection: 'forward', review: 'unreviewed',
        agent: input.agent, session: input.session, from: input.from, to: input.to });
      await this.updateOperation(op); // Durable write-ahead intent; no filesystem mutation before this.
      try { await guard?.(); }
      catch (error) {
        // A rejected editor guard never reached the adapter. In particular, a
        // human's coincidentally matching edit must not acquire AI provenance.
        op.status = 'failed'; op.error = String(error); await this.updateOperation(op);
        throw new Error(`Mutation cancelled before writing; operation ${op.id}: ${op.error}`);
      }
      try { await this.files.apply(op, false); }
      catch (error) {
        op.error = String(error);
        // A failed adapter call might have completed part or all of a write.
        op.status = error instanceof MutationPreconditionError ? 'failed' : this.outcome(await this.classify(op), 'forward');
        await this.updateOperation(op);
        throw new Error(`Mutation failed (${op.status}); operation ${op.id}: ${op.error}`);
      }
      op.status = 'applied';
      try { await this.updateOperation(op); }
      catch { throw new Error(`File changed, but journal finalization failed. Operation ${op.id} needs recovery before continuing.`); }
      return structuredClone(op);
    });
  }
  private async classify(op: Operation): Promise<FilePhase> {
    const source = await this.files.read(op.path), target = op.target ? await this.files.read(op.target) : null;
    const equals = (a: typeof source, b: typeof source) => a?.hash === b?.hash;
    if (op.kind === 'move') {
      if (source === null && equals(target, op.after)) return 'after';
      if (equals(source, op.before) && target === null) return 'before';
    } else {
      if (equals(source, op.after)) return 'after';
      if (equals(source, op.before)) return 'before';
    }
    return 'unknown';
  }
  private outcome(phase: FilePhase, direction: 'forward' | 'reverse'): Operation['status'] {
    return phase === 'after' ? 'applied' : phase === 'before' ? (direction === 'reverse' ? 'reverted' : 'failed') : 'uncertain';
  }
  private async recoverPending(): Promise<void> {
    for (const original of this.state.operations) {
      if (!['prepared', 'uncertain', 'reverting'].includes(original.status)) continue;
      const op = structuredClone(original);
      const direction = original.status === 'reverting' ? 'reverse' : original.status === 'prepared' ? 'forward' : original.recoveryDirection;
      op.status = direction ? this.outcome(await this.classify(op), direction) : 'uncertain';
      op.recoveryDirection = direction;
      op.error = op.status === 'uncertain' ? 'File state or recovery direction is uncertain. Restore a recorded state and recover again; no file was overwritten.' : undefined;
      await this.updateOperation(op);
    }
  }
  async recover(): Promise<void> { return this.run(async () => {
    // save() may have committed before reporting an error. Reload its authoritative
    // result before deciding whether another write would be safe.
    if (this.persistenceFault) await this.readState();
    await this.recoverPending();
    this.emit();
  }); }
  async markReviewed(operationId?: string) { return this.run(async () => {
    this.assertStorage();
    const next = this.state;
    for (const op of next.operations) if ((!operationId || op.id === operationId) && op.status === 'applied') op.review = 'reviewed';
    await this.save(next);
  }); }
  private async revertOne(operationId: string) {
    this.assertSettled();
    const op = this.state.operations.find(o => o.id === operationId);
    if (!op || op.status !== 'applied') throw new Error('Only applied changes can be reverted.');
    if (await this.classify(op) !== 'after') throw new Error('Conflict: newer edits or file moves detected. Nothing was overwritten.');
    op.status = 'reverting'; op.recoveryDirection = 'reverse'; await this.updateOperation(op);
    try { await this.files.apply(op, true); }
    catch (error) {
      op.status = error instanceof MutationPreconditionError ? 'applied' : this.outcome(await this.classify(op), 'reverse');
      op.error = String(error); await this.updateOperation(op); throw error;
    }
    op.status = 'reverted'; op.error = undefined;
    try { await this.updateOperation(op); }
    catch { throw new Error(`File reverted, but journal finalization failed. Operation ${op.id} needs recovery before continuing.`); }
  }
  async revert(operationId: string) { return this.run(() => this.revertOne(operationId)); }
  async revertFile(path: string) { return this.run(async () => {
    this.assertSettled();
    const atPath = new Map<string, Operation[]>(), lastAtPath = new Map<string, Operation[]>();
    // Track each file's history through renames, accepting its current or old
    // name. Creation starts a new lifetime when an old pathname is reused.
    for (const op of this.state.operations) {
      if (op.status !== 'applied') continue;
      const history = op.kind === 'create' ? [] : atPath.get(op.path) ?? [];
      history.push(op);
      lastAtPath.set(op.path, history);
      if (op.kind === 'move') {
        atPath.delete(op.path); atPath.set(op.target!, history); lastAtPath.set(op.target!, history);
      } else if (op.kind === 'delete') atPath.delete(op.path);
      else atPath.set(op.path, history);
    }
    let count = 0;
    for (const op of [...(atPath.get(path) ?? lastAtPath.get(path) ?? [])].reverse()) {
      try { await this.revertOne(op.id); }
      catch (error) { throw new Error(`Reverted ${count} change(s); stopped at ${op.path} (${op.id}): ${String(error)}`); }
      count++;
    }
    return { reverted: count };
  }); }
}
