import { hash, id, isTextBoundary, MAX_FILE_BYTES, type ContextItem } from '../model';

export interface Heading { path: string[]; from: number; to: number; level: number; }
// Caller supplies Obsidian metadata headings in production. The core does not parse Markdown.
export function headingRanges(headings: { heading: string; level: number; position: { start: { offset: number } } }[], length: number): Heading[] {
  const stack: { name: string; level: number }[] = [];
  return headings.map((h, i) => {
    while (stack.length && stack[stack.length - 1]!.level >= h.level) stack.pop();
    stack.push({ name: h.heading, level: h.level });
    return {
      path: stack.map(s => s.name), from: h.position.start.offset,
      to: headings.slice(i + 1).find(next => next.level <= h.level)?.position.start.offset ?? length, level: h.level,
    };
  });
}
export const sameHeading = (a: string[], b: string[]) => JSON.stringify(a) === JSON.stringify(b);
export function sectionAt(headings: Heading[], offset: number): Heading | undefined {
  return headings.filter(h => h.from <= offset && h.to > offset).at(-1);
}
export function pin(kind: ContextItem['kind'], path: string, text: string, from = 0, to = text.length, headingPath?: string[]): ContextItem {
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to > text.length || from > to) throw new Error('Invalid context range.');
  if (kind === 'selection' && from === to) throw new Error('Select some text first.');
  if (!isTextBoundary(text, from) || !isTextBoundary(text, to)) throw new Error('Context range splits a Unicode character.');
  if (kind === 'section' && !headingPath?.length) throw new Error('Section context requires its heading path.');
  if (kind === 'note' && (from !== 0 || to !== text.length)) throw new Error('Note context must include the entire file.');
  const content = text.slice(from, to);
  if (Buffer.byteLength(content) > MAX_FILE_BYTES) throw new Error('Pinned context exceeds the 5 MiB limit.');
  return { id: id(), kind, path, pinnedAt: new Date().toISOString(), from, to, headingPath,
    fileHash: hash(text), contentHash: hash(content), snapshot: content,
    prefix: text.slice(Math.max(0, from - 64), from), suffix: text.slice(to, to + 64) };
}
export interface ResolvedContext {
  id: string; kind: ContextItem['kind']; path: string; status: 'current' | 'changed' | 'stale';
  content?: string; contentHash?: string; fileHash?: string; from?: number; to?: number;
  headingPath?: string[]; reason?: string; source?: 'editor' | 'disk'; mtime?: number;
}
export function resolve(item: ContextItem, text: string, headings: Heading[] = []): ResolvedContext {
  const base = { id: item.id, kind: item.kind, path: item.path, headingPath: item.headingPath, fileHash: hash(text) };
  const current = (from: number, to: number): ResolvedContext => {
    const content = text.slice(from, to), contentHash = hash(content);
    return { ...base, status: contentHash === item.contentHash ? 'current' : 'changed', content, contentHash, from, to };
  };
  if (item.kind === 'note') return current(0, text.length);
  if (item.kind === 'section') {
    const matches = headings.filter(h => sameHeading(h.path, item.headingPath ?? []));
    if (matches.length !== 1) return { ...base, status: 'stale', reason: 'Heading removed, renamed, or ambiguous. Pin the section again.' };
    return current(matches[0]!.from, matches[0]!.to);
  }
  if (base.fileHash === item.fileHash) return current(item.from, item.to);
  // Do not trust offsets alone after a file edit. Relocate only the same text with
  // the same surrounding anchors, uniquely. Edited selections require a new pin.
  const anchor = item.prefix + item.snapshot + item.suffix;
  const at = text.indexOf(anchor);
  if (at < 0 || text.indexOf(anchor, at + 1) !== -1) return { ...base, status: 'stale', reason: 'Selection changed or its anchors are no longer unique. Pin it again.' };
  return current(at + item.prefix.length, at + item.prefix.length + item.snapshot.length);
}
