import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';

export const hash = (text: string | Uint8Array) => createHash('sha256').update(text).digest('hex');
export const id = () => randomUUID();
export const MAX_FILE_BYTES = 5 * 1024 * 1024;
/** Only throw before any workspace side effect has occurred. */
export class MutationPreconditionError extends Error {
  constructor(message: string) { super(message); this.name = 'MutationPreconditionError'; }
}
const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const snapshotSchema = z.object({
  encoding: z.enum(['utf8', 'base64']), data: z.string(), hash: digest, size: z.number().int().nonnegative(),
}).superRefine((value, context) => {
  const content = Buffer.from(value.data, value.encoding === 'utf8' ? 'utf8' : 'base64');
  if (content.length > MAX_FILE_BYTES || content.length !== value.size || hash(content) !== value.hash ||
      (value.encoding === 'base64' && content.toString('base64') !== value.data) ||
      (value.encoding === 'utf8' && content.toString('utf8') !== value.data)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'Journal snapshot is corrupt or exceeds the 5 MiB file limit.' });
  }
});
export type Snapshot = z.infer<typeof snapshotSchema>;
export const folderEntrySchema = z.object({
  path: z.string().min(1).refine(path => !path.startsWith('/') && !path.split('/').some(part => !part || part === '.' || part === '..'), 'Folder entries must be relative paths inside the folder.'),
  kind: z.enum(['file', 'folder']), hash: digest.optional(), size: z.number().int().nonnegative().optional(),
}).superRefine((entry, context) => {
  if (entry.kind === 'file' ? !entry.hash || entry.size === undefined : entry.hash !== undefined || entry.size !== undefined) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'Folder manifest entry does not match its kind.' });
  }
});
export type FolderEntry = z.infer<typeof folderEntrySchema>;
const folderManifestSchema = z.array(folderEntrySchema);
export function folderSnapshot(entries: FolderEntry[]): Snapshot {
  const sorted = [...entries].sort((a, b) => a.path.localeCompare(b.path));
  return textSnapshot(JSON.stringify(folderManifestSchema.parse(sorted)));
}
export function folderEntries(snapshot: Snapshot): FolderEntry[] {
  if (snapshot.encoding !== 'utf8') throw new Error('Folder manifest is not readable.');
  return folderManifestSchema.parse(JSON.parse(snapshot.data));
}
export function snapshot(bytes: Uint8Array): Snapshot {
  if (bytes.length > MAX_FILE_BYTES) throw new Error('Files larger than 5 MiB are not supported by the mutation journal.');
  const buffer = Buffer.from(bytes);
  const text = buffer.toString('utf8');
  const isText = !buffer.includes(0) && Buffer.from(text).equals(buffer);
  return { encoding: isText ? 'utf8' : 'base64', data: isText ? text : buffer.toString('base64'), hash: hash(buffer), size: buffer.length };
}
export function textSnapshot(text: string): Snapshot {
  const encoded = Buffer.from(text);
  if (text.includes('\0') || encoded.toString('utf8') !== text) throw new Error('Text mutations require valid Unicode text without NUL bytes.');
  return snapshot(encoded);
}
export const bytes = (s: Snapshot) => Buffer.from(s.data, s.encoding === 'utf8' ? 'utf8' : 'base64');
export function textOf(s: Snapshot): string {
  if (s.encoding !== 'utf8') throw new Error('This operation requires a UTF-8 text file.');
  return s.data;
}
export function isTextBoundary(text: string, offset: number): boolean {
  return !(offset > 0 && offset < text.length && /[\uD800-\uDBFF]/.test(text[offset - 1]!) && /[\uDC00-\uDFFF]/.test(text[offset]!));
}

export const operationSchema = z.object({
  id: z.string().min(1), timestamp: z.string(), kind: z.enum(['edit', 'create', 'delete', 'move', 'create-folder', 'delete-folder', 'move-folder']),
  path: z.string().min(1), target: z.string().min(1).optional(), before: snapshotSchema.nullable(), after: snapshotSchema.nullable(),
  status: z.enum(['prepared', 'applied', 'failed', 'uncertain', 'reverting', 'reverted', 'pending-delete', 'committing-delete']),
  agent: z.string().optional(), session: z.string().optional(),
  from: z.number().int().nonnegative().optional(), to: z.number().int().nonnegative().optional(),
  error: z.string().optional(),
  recoveryDirection: z.enum(['forward', 'reverse']).optional(),
}).superRefine((op, context) => {
  const folderOperation = op.kind.endsWith('-folder');
  let valid = op.kind === 'create' ? op.before === null && op.after !== null :
    op.kind === 'create-folder' ? op.before === null && op.after?.encoding === 'utf8' && !!parseFolderManifest(op.after) :
    op.kind === 'delete' || op.kind === 'delete-folder' ? op.before !== null && op.after === null : op.before !== null && op.after !== null;
  if (op.kind === 'move' || op.kind === 'move-folder') valid &&= !!op.target && op.target !== op.path && op.before?.hash === op.after?.hash;
  else valid &&= op.target === undefined;
  if (op.kind === 'delete-folder') valid &&= op.before?.encoding === 'utf8' && !!parseFolderManifest(op.before);
  if (op.kind === 'move-folder') valid &&= op.before?.encoding === 'utf8' && op.after?.encoding === 'utf8' && !!parseFolderManifest(op.before) && !!parseFolderManifest(op.after);
  if (folderOperation) valid &&= op.from === undefined && op.to === undefined;
  if (op.kind === 'edit') valid &&= op.before?.encoding === 'utf8' && op.after?.encoding === 'utf8' && op.before.hash !== op.after?.hash &&
    op.from !== undefined && op.to !== undefined && op.from <= op.to && op.to <= op.before.data.length &&
    isTextBoundary(op.before.data, op.from) && isTextBoundary(op.before.data, op.to);
  if (!valid) context.addIssue({ code: z.ZodIssueCode.custom, message: 'Operation states do not match its mutation kind.' });
});
function parseFolderManifest(value: Snapshot): boolean {
  try { folderManifestSchema.parse(JSON.parse(textOf(value))); return true; } catch { return false; }
}
export type Operation = z.infer<typeof operationSchema>;
export const stateSchema = z.object({
  version: z.literal(1), operations: z.array(operationSchema),
}).passthrough().superRefine((state, context) => {
  if (new Set(state.operations.map(op => op.id)).size !== state.operations.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'Journal operation IDs must be unique.' });
  }
});
export type State = z.infer<typeof stateSchema>;
export const emptyState = (): State => ({ version: 1, operations: [] });
export interface StateStore { load(): Promise<unknown | null>; save(state: State): Promise<void>; }
export interface WorkspaceFiles {
  read(path: string): Promise<Snapshot | null>;
  readFolder(path: string): Promise<Snapshot | null>;
  // The adapter must recheck content and any open editors at the point of writing.
  apply(op: Operation, reverse: boolean): Promise<void>;
  /** Move an approved pending deletion to trash, after rechecking its hash. */
  trash(path: string, expected: Snapshot): Promise<void>;
  /** Move a staged folder deletion to the configured Obsidian trash. */
  trashFolder(path: string, expected: Snapshot): Promise<void>;
}
export type ContextReader = (path: string) => Promise<{ text: string; mtime?: number; source: 'editor' | 'disk' }>;

export class SerialQueue {
  private tail: Promise<unknown> = Promise.resolve();
  run<T>(task: () => Promise<T>): Promise<T> {
    const next = this.tail.then(task);
    this.tail = next.catch(() => undefined);
    return next;
  }
  async drain(): Promise<void> { await this.tail; }
}
