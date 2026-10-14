import { emptyState, folderSnapshot, id, isTextBoundary, MAX_FILE_BYTES, MutationPreconditionError, operationSchema, stateSchema, textOf, textSnapshot, SerialQueue, type Operation, type State, type StateStore, type WorkspaceFiles } from '../model';

type FilePhase = 'before' | 'after' | 'unknown';
type FileMutationKind = 'edit' | 'create' | 'delete' | 'move';

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
  private assertSettled() {
    this.assertStorage();
    if (this.current.operations.some(o => ['prepared', 'reverting', 'uncertain', 'committing-delete'].includes(o.status))) throw new Error("An operation needs recovery. Inspect machine minds' changes and run Recover interrupted operations before further mutations.");
  }
  private readOperationPath(op: Operation, path: string) {
    return op.kind.endsWith('-folder') ? this.files.readFolder(path) : this.files.read(path);
  }
  private pathHasPendingDeletion(path: string, folderOperation = false) {
    return this.current.operations.some(op => {
      if (!['delete', 'delete-folder'].includes(op.kind) || !['pending-delete', 'committing-delete'].includes(op.status)) return false;
      return path === op.path || (op.kind === 'delete-folder' &&
        path.startsWith(`${op.path}/`)) || (folderOperation && op.path.startsWith(`${path}/`));
    });
  }
  async mutate(input: { kind: FileMutationKind; path: string; target?: string; expectedHash?: string; content?: string; from?: number; to?: number; agent?: string; session?: string }, guard?: () => Promise<void> | void) {
    return this.run(async () => {
      this.assertSettled();
      // Editor-target preconditions are ephemeral. Recheck after waiting for the
      // queue, and after persisting intent; never serialize a callback or retarget.
      await guard?.();
      if (input.content !== undefined && Buffer.byteLength(input.content) > MAX_FILE_BYTES) throw new Error('Mutation content exceeds the 5 MiB file limit.');
      if (this.pathHasPendingDeletion(input.path) || (input.target && this.pathHasPendingDeletion(input.target))) {
        throw new Error('This path is inside a deletion awaiting review. Undo or confirm that deletion before changing it again.');
      }
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
        target: input.target, before, after, status: input.kind === 'delete' ? 'pending-delete' : 'prepared', recoveryDirection: 'forward',
        agent: input.agent, session: input.session, from: input.from, to: input.to });
      await this.updateOperation(op); // Durable write-ahead intent; no filesystem mutation before this.
      // Deletion is intentionally staged. The file remains in the vault until a
      // human approves the batch from machine minds' changes, where it will go to trash.
      if (input.kind === 'delete') return structuredClone(op);
      try { await guard?.(); }
      catch (error) {
        // A rejected editor guard never reached the adapter. In particular, a
        // human's coincidentally matching edit must not acquire machine-mind provenance.
        await this.removeOperations(new Set([op.id]));
        throw new Error(`Mutation cancelled before writing; operation ${op.id}: ${String(error)}`);
      }
      try { await this.files.apply(op, false); }
      catch (error) {
        // Known precondition failures never wrote. For other adapter errors,
        // classify the file before deciding whether a review record is needed.
        const phase = error instanceof MutationPreconditionError ? 'before' : await this.classify(op);
        if (phase === 'before') {
          await this.removeOperations(new Set([op.id]));
          throw new Error(`Mutation failed (not applied); operation ${op.id}: ${String(error)}`);
        }
        op.error = String(error);
        op.status = this.outcome(phase, 'forward');
        await this.updateOperation(op);
        throw new Error(`Mutation failed (${op.status}); operation ${op.id}: ${op.error}`);
      }
      op.status = 'applied';
      try { await this.updateOperation(op); }
      catch { throw new Error(`File changed, but journal finalization failed. Operation ${op.id} needs recovery before continuing.`); }
      return structuredClone(op);
    });
  }
  async mutateFolder(input: { kind: 'create-folder' | 'delete-folder' | 'move-folder'; path: string; target?: string; expectedHash?: string; agent?: string; session?: string }) {
    return this.run(async () => {
      this.assertSettled();
      if (this.pathHasPendingDeletion(input.path, true) || (input.target && this.pathHasPendingDeletion(input.target, true))) {
        throw new Error('This path is inside a deletion awaiting review. Undo or confirm that deletion before changing it again.');
      }
      const before = await this.files.readFolder(input.path);
      if (input.kind === 'create-folder') {
        if (before !== null) throw new Error('Conflict: folder already exists.');
      } else if (!before || before.hash !== input.expectedHash) throw new Error('Conflict: folder changed or is missing. Read its current state first.');
      if (input.kind === 'move-folder') {
        if (!input.target || input.target === input.path || await this.files.readFolder(input.target) !== null) {
          throw new Error('Conflict: move destination must be a different, absent folder.');
        }
      }
      const after = input.kind === 'delete-folder' ? null : before ?? folderSnapshot([]);
      const op = operationSchema.parse({ id: id(), timestamp: new Date().toISOString(), kind: input.kind, path: input.path,
        target: input.target, before, after, status: input.kind === 'delete-folder' ? 'pending-delete' : 'prepared',
        recoveryDirection: 'forward', agent: input.agent, session: input.session });
      await this.updateOperation(op);
      if (input.kind === 'delete-folder') return structuredClone(op);
      try { await this.files.apply(op, false); }
      catch (error) {
        const phase = error instanceof MutationPreconditionError ? 'before' : await this.classify(op);
        if (phase === 'before') {
          await this.removeOperations(new Set([op.id]));
          throw new Error(`Folder operation failed (not applied); operation ${op.id}: ${String(error)}`);
        }
        op.error = String(error); op.status = this.outcome(phase, 'forward'); await this.updateOperation(op);
        throw new Error(`Folder operation failed (${op.status}); operation ${op.id}: ${op.error}`);
      }
      op.status = 'applied';
      try { await this.updateOperation(op); }
      catch { throw new Error(`Folder changed, but journal finalization failed. Operation ${op.id} needs recovery before continuing.`); }
      return structuredClone(op);
    });
  }
  private async classify(op: Operation): Promise<FilePhase> {
    const source = await this.readOperationPath(op, op.path), target = op.target ? await this.readOperationPath(op, op.target) : null;
    const equals = (a: typeof source, b: typeof source) => a?.hash === b?.hash;
    if (op.kind === 'move' || op.kind === 'move-folder') {
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
      if (!['prepared', 'uncertain', 'reverting', 'committing-delete'].includes(original.status)) continue;
      const op = structuredClone(original);
      if (original.status === 'committing-delete') {
        const current = await this.readOperationPath(op, op.path);
        if (current === null || current.hash === op.before?.hash) {
          // A crash may occur just after trashing but before journal cleanup. Keep
          // the confirmation visible; the next confirmation safely finishes it.
          op.status = 'pending-delete'; op.error = undefined;
        } else {
          op.status = 'uncertain'; op.error = 'The file changed while a confirmed deletion was being finalized. Inspect the file before continuing.';
        }
        await this.updateOperation(op);
        continue;
      }
      const direction = original.status === 'reverting' ? 'reverse' : original.status === 'prepared' ? 'forward' : original.recoveryDirection;
      const phase = await this.classify(op);
      if (direction && phase === 'before') {
        await this.removeOperations(new Set([op.id]));
        continue;
      }
      op.status = direction ? this.outcome(phase, direction) : 'uncertain';
      op.recoveryDirection = direction;
        op.error = op.status === 'uncertain' ? 'File or folder state or recovery direction is uncertain. Restore a recorded state and recover again; no file was overwritten.' : undefined;
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
  private async undoApplied(operationId: string) {
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
    catch { throw new Error(`File was undone, but journal finalization failed. Operation ${op.id} needs recovery before continuing.`); }
  }

  private matchesSession(op: Operation, session: string | undefined) { return op.session === session; }
  private async removeOperations(ids: Set<string>) {
    const next = this.state;
    next.operations = next.operations.filter(op => !ids.has(op.id));
    // Do not leave old snapshot/context payloads behind once the review queue is empty.
    await this.save(next.operations.length ? next : emptyState());
  }
  /** Undo and remove one queued change. A staged deletion has not touched the file. */
  async undo(operationId: string) { return this.run(async () => {
    this.assertSettled();
    const op = this.state.operations.find(candidate => candidate.id === operationId);
    if (!op) throw new Error('This change is no longer in the review queue.');
    if (op.status === 'applied') await this.undoApplied(operationId);
    else if (op.status === 'pending-delete' || op.status === 'failed' || op.status === 'reverted') { /* no workspace change to undo */ }
    else throw new Error('This change needs recovery before it can be undone.');
    await this.removeOperations(new Set([operationId]));
  }); }

  private async undoMatching(predicate: (op: Operation) => boolean) {
    this.assertSettled();
    const operations = this.state.operations.filter(predicate).reverse();
    let undone = 0;
    for (const op of operations) {
      try {
        if (op.status === 'applied') await this.undoApplied(op.id);
        else if (!['pending-delete', 'failed', 'reverted'].includes(op.status)) throw new Error('This change needs recovery before it can be undone.');
      } catch (error) {
        throw new Error(`Undid ${undone} change(s); stopped at ${op.path} (${op.id}): ${String(error)}`);
      }
      undone++;
    }
    await this.removeOperations(new Set(operations.map(op => op.id)));
    return { undone };
  }
  /** Undo a change session newest first, then discard all its review data. */
  async undoSession(session?: string) { return this.run(() => this.undoMatching(op => this.matchesSession(op, session))); }
  /** Undo every queued session and erase all review snapshots. */
  async undoAll() { return this.run(() => this.undoMatching(() => true)); }

  private async complete(predicate: (op: Operation) => boolean) {
    this.assertSettled();
    const selected = this.state.operations.filter(predicate);
    for (const original of selected) {
      if (!['delete', 'delete-folder'].includes(original.kind) || original.status !== 'pending-delete') continue;
      const op = structuredClone(original);
      const current = await this.readOperationPath(op, op.path);
      // Missing means the file has already been moved to trash (for example, a
      // restart after the trash operation), or the requested deletion happened
      // outside wikiship. Either way, there is no vault file left to remove.
      if (!current) continue;
      if (current.hash !== op.before?.hash) throw new Error(`Conflict: ${op.path} changed after the deletion was staged. Nothing was cleared.`);
      op.status = 'committing-delete'; await this.updateOperation(op);
      try {
        if (op.kind === 'delete-folder') await this.files.trashFolder(op.path, op.before!);
        else await this.files.trash(op.path, op.before!);
      }
      catch (error) {
        const latest = await this.readOperationPath(op, op.path).catch(() => op.before);
        op.status = latest === null ? 'pending-delete' : latest?.hash === op.before?.hash ? 'pending-delete' : 'uncertain';
        op.error = String(error); await this.updateOperation(op);
        throw new Error(`Could not move ${op.path} to trash. Its review data is still available: ${String(error)}`);
      }
    }
    const ids = new Set(selected.map(op => op.id));
    if (ids.size) await this.removeOperations(ids);
    return { cleared: ids.size };
  }

  /** Approve one batch; staged deletions go to trash before records are erased. */
  async completeSession(session?: string) { return this.run(() => this.complete(op => this.matchesSession(op, session))); }
  /** Accept every queued session and erase all review snapshots. */
  async completeAll() { return this.run(() => this.complete(() => true)); }
}
