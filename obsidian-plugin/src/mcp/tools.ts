import { z } from 'zod';
import type { LocalRestApiPublicApi, McpToolDefinition, McpToolResult } from 'obsidian-local-rest-api';
import type { Journal } from '../provenance/journal';
import type { Operation } from '../model';

export interface EditorTarget { path: string; from: number; to: number; fileHash: string; }
export interface wikishipContext {
  getEditorState(): unknown | Promise<unknown>;
  getSelection(): unknown | Promise<unknown>;
  selectionTarget(): Promise<EditorTarget>;
  cursorTarget(): Promise<EditorTarget>;
  sectionTarget(headingPath?: string[]): Promise<EditorTarget>;
}

const path = z.string().min(1).max(4096).describe('Vault-relative file path with forward slashes.');
const expectedHash = z.string().regex(/^[a-f0-9]{64}$/).describe('SHA-256 of the entire current file, obtained from wikiship.');
const offset = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const content = z.string().max(2_000_000).describe('Literal replacement text.');
const identity = {
  agent: z.string().min(1).max(128).optional().describe('Optional self-reported client identity; not authenticated identity.'),
  session: z.string().min(1).max(128).optional().describe("Optional self-reported session label. Use the same label for related changes so a person can undo or clear them together in machine minds' changes."),
};

function result(value: unknown): McpToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(value) }] };
}
function tool<S extends z.ZodRawShape>(name: string, description: string, shape: S,
  execute: (args: z.infer<z.ZodObject<S>>) => Promise<unknown>, writes = false, destructive = false): McpToolDefinition {
  // The host validates input too, but direct callback invocations must be equally safe.
  const schema = z.object(shape).strict();
  return {
    name, description, inputSchema: shape,
    annotations: { readOnlyHint: !writes, destructiveHint: destructive, openWorldHint: false, idempotentHint: !writes },
    callback: async (raw) => {
      try { return result(await execute(schema.parse(raw))); }
      catch (error) {
        const message = error instanceof z.ZodError
          ? `Invalid arguments: ${error.issues.map(issue => `${issue.path.join('.') || 'arguments'}: ${issue.message}`).join('; ')}`
          : error instanceof Error ? error.message : 'wikiship operation failed.';
        return { isError: true, content: [{ type: 'text', text: message }] };
      }
    },
  };
}

export function operationSummary(op: Operation) {
  return { id: op.id, timestamp: op.timestamp, kind: op.kind, path: op.path, target: op.target,
    beforeHash: op.before?.hash ?? null, afterHash: op.after?.hash ?? null,
    status: op.status, pendingApproval: op.status === 'pending-delete', agent: op.agent, session: op.session,
    from: op.from, to: op.to, error: op.error };
}

function verifyTarget(target: EditorTarget, expected: { path: string; expectedHash: string; from?: number; to?: number }) {
  if (target.path !== expected.path || target.fileHash !== expected.expectedHash ||
    (expected.from !== undefined && target.from !== expected.from) || (expected.to !== undefined && target.to !== expected.to)) {
    throw new Error('Conflict: the active file, selection, cursor, or content changed. Read editor state again.');
  }
}

export function createToolDefinitions(context: wikishipContext, journal: Journal): McpToolDefinition[] {
  const mutate = async (input: Parameters<Journal['mutate']>[0], guard?: Parameters<Journal['mutate']>[1]) => operationSummary(await journal.mutate(input, guard));
  return [
    tool('wikiship_get_editor_state', 'Read the active Markdown editor, cursor, selection, current section, and open Markdown tabs.', {}, async () => context.getEditorState()),
    tool('wikiship_get_selection', 'Read the active selection, its UTF-16 offsets, and the entire file hash.', {}, async () => context.getSelection()),
    tool('wikiship_get_file_state', 'Read a file hash and a bounded text excerpt for mutation preconditions. Binary files return metadata only. No search is performed.', {
      path, from: offset.default(0), length: z.number().int().min(1).max(100_000).default(20_000),
    }, async args => {
      const file = await journal.files.read(args.path);
      if (!file) return { path: args.path, exists: false };
      if (file.encoding !== 'utf8') return { path: args.path, exists: true, fileHash: file.hash, size: file.size, encoding: file.encoding };
      const to = Math.min(args.from + args.length, file.data.length);
      if (args.from > file.data.length) throw new Error('The requested offset is beyond the file.');
      return { path: args.path, exists: true, fileHash: file.hash, size: file.size, encoding: file.encoding,
        content: file.data.slice(args.from, to), from: args.from, to, totalLength: file.data.length,
        nextOffset: to < file.data.length ? to : null };
    }),
    tool('wikiship_replace_range', 'Replace an explicit [from,to) UTF-16 range. Requires the current file hash; records before/after provenance.', {
      path, expectedHash, from: offset, to: offset, content, ...identity,
    }, args => mutate({ ...args, kind: 'edit' }), true, true),
    tool('wikiship_replace_selection', 'Replace the active selection only if its file, entire hash, and UTF-16 range still match the previously read state.', {
      path, expectedHash, from: offset, to: offset, content, ...identity,
    }, async args => {
      const guard = async () => {
        const target = await context.selectionTarget(); verifyTarget(target, args);
        if (target.from === target.to) throw new Error('There is no selected text.');
      };
      return mutate({ ...args, kind: 'edit' }, guard);
    }, true, true),
    tool('wikiship_insert_at_cursor', 'Insert text only if the active file, hash, and UTF-16 cursor offset match the previously read state.', {
      path, expectedHash, offset, content, ...identity,
    }, async args => {
      const guard = async () => verifyTarget(await context.cursorTarget(), { ...args, from: args.offset, to: args.offset });
      return mutate({ ...args, kind: 'edit', from: args.offset, to: args.offset }, guard);
    }, true),
    tool('wikiship_patch_section', 'Replace a uniquely identified section in the active Markdown file, including its heading and nested sections. Supply the complete desired section text.', {
      path, expectedHash, headingPath: z.array(z.string().min(1)).min(1).max(32), content, ...identity,
    }, async args => {
      const target = await context.sectionTarget(args.headingPath); verifyTarget(target, args);
      const guard = async () => verifyTarget(await context.sectionTarget(args.headingPath), { ...args, from: target.from, to: target.to });
      return mutate({ ...args, kind: 'edit', from: target.from, to: target.to }, guard);
    }, true, true),
    tool('wikiship_create_file', 'Create a UTF-8 file at an absent path, recording machine-mind provenance. Existing files are never overwritten.', {
      path, content, ...identity,
    }, args => mutate({ ...args, kind: 'create' }), true),
    tool('wikiship_delete_file', 'Stage a file deletion only if its current hash matches. The file stays in the vault until a human approves the batch; then it moves to trash.', {
      path, expectedHash, ...identity,
    }, args => mutate({ ...args, kind: 'delete' }), true, true),
    tool('wikiship_move_file', 'Move a file to an absent vault-relative target. Require its current hash and record both paths. Does not update links in other files.', {
      path, target: path, expectedHash, ...identity,
    }, args => mutate({ ...args, kind: 'move' }), true, true),
    tool('wikiship_rename_file', 'Rename a file within the same directory. Require its current hash. Does not update links in other files.', {
      path, name: z.string().min(1).max(255).refine(name => !/[\\/]/.test(name) && name !== '.' && name !== '..', 'Use a file name without directories.'),
      expectedHash, ...identity,
    }, args => {
      const slash = args.path.lastIndexOf('/');
      return mutate({ ...args, kind: 'move', target: args.path.slice(0, slash + 1) + args.name });
    }, true, true),
    tool('wikiship_get_changes', 'Read a bounded page of pending change summaries, newest first. File contents and human approval/undo actions are not exposed.', {
      path: path.optional(), offset: offset.default(0), limit: z.number().int().min(1).max(100).default(20),
    }, async args => {
      const operations = journal.state.operations.filter(op => !args.path || op.path === args.path || op.target === args.path).reverse();
      const end = args.offset + args.limit;
      return { operations: operations.slice(args.offset, end).map(operationSummary), total: operations.length, nextOffset: end < operations.length ? end : null };
    }),
  ];
}

export function registerTools(api: Pick<LocalRestApiPublicApi, 'addMcpTool'>, context: wikishipContext, journal: Journal) {
  for (const definition of createToolDefinitions(context, journal)) api.addMcpTool(definition);
}
