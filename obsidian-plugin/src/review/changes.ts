import { hash, type Operation } from '../model';

export interface ChangeRegion { from: number; beforeTo: number; afterTo: number; kind: 'inserted' | 'modified' | 'deleted'; }
export interface ChangeLocation { operationId: string; from: number; to: number; kind: ChangeRegion['kind']; }

export function changeRegion(operation: Operation): ChangeRegion | null {
  if (!operation.after || operation.after.encoding !== 'utf8' || operation.before?.encoding === 'base64') return null;
  const before = operation.before?.data ?? '', after = operation.after.data;
  if (before === after) return null;
  let from = 0;
  while (from < before.length && from < after.length && before[from] === after[from]) from++;
  let beforeTo = before.length, afterTo = after.length;
  while (beforeTo > from && afterTo > from && before[beforeTo - 1] === after[afterTo - 1]) { beforeTo--; afterTo--; }
  return { from, beforeTo, afterTo, kind: from === beforeTo ? 'inserted' : from === afterTo ? 'deleted' : 'modified' };
}

/** Only locate changes across a continuous, verified chain of recorded file states. */
export function locationsForFile(operations: Operation[], path: string, text: string): ChangeLocation[] {
  let currentPath = path, currentHash = hash(text);
  const following: ChangeRegion[] = [], located: ChangeLocation[] = [];
  for (let i = operations.length - 1; i >= 0; i--) {
    const op = operations[i]!;
    if (op.status !== 'applied') continue;
    const afterPath = op.kind === 'move' ? op.target : op.path;
    if (afterPath !== currentPath || op.after?.hash !== currentHash) continue;
    if (op.kind === 'move') {
      located.push({ operationId: op.id, from: 0, to: 0, kind: 'modified' });
      currentPath = op.path;
    } else {
      const region = changeRegion(op);
      if (region) {
        let from = region.from, to = region.afterTo, replaced = false;
        // following is newest first; transform from this operation's result forward.
        for (let j = following.length - 1; j >= 0; j--) {
          const later = following[j]!, delta = later.afterTo - later.beforeTo;
          // Overlapping edits no longer have one attributable contiguous span.
          // Keep the change in the sidebar instead of marking unrelated text.
          if ((later.from < to && later.beforeTo > from) ||
            (from === to && later.from <= from && later.beforeTo > from) ||
            (later.from > from && later.from < to)) { replaced = true; break; }
          const map = (offset: number, end: boolean) => offset < later.from ? offset : offset >= later.beforeTo ? offset + delta : end ? later.afterTo : later.from;
          from = map(from, false); to = map(to, true);
        }
        if (!replaced) located.push({ operationId: op.id, from, to, kind: region.kind });
        following.push(region);
      }
    }
    if (!op.before) break;
    currentHash = op.before.hash;
  }
  return located;
}

export function operationLabel(operation: Operation): string {
  if (operation.kind === 'move') return `Moved to ${operation.target}`;
  if (operation.kind === 'create') return 'Created file';
  if (operation.kind === 'delete') return 'Deleted file';
  const region = changeRegion(operation);
  if (!region) return 'Changed file';
  const before = operation.before?.data.slice(region.from, region.beforeTo) ?? '';
  const after = operation.after?.data.slice(region.from, region.afterTo) ?? '';
  const lines = (value: string) => value.length ? value.split('\n').length : 0;
  return region.kind === 'inserted' ? `+ ${lines(after)} lines inserted` : region.kind === 'deleted'
    ? `− ${lines(before)} lines deleted` : `${lines(before)} → ${lines(after)} lines modified`;
}
