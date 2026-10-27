import { TFile, TFolder, type App } from 'obsidian';
import { z } from 'zod/v3';
import { currentHeadings } from '../context/editor';
import { textOf } from '../model';
import type { Journal } from '../provenance/journal';
import type { PathPolicy } from '../provenance/storage';
import type { McpToolDefinition } from './tools';

function value(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data) }] };
}

function readTool<S extends z.ZodRawShape>(name: string, description: string, inputSchema: S,
  run: (args: z.infer<z.ZodObject<S>>) => Promise<unknown>): McpToolDefinition {
  const schema = z.object(inputSchema).strict();
  return {
    name, description, inputSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true },
    callback: async raw => {
      try { return value(await run(schema.parse(raw))); }
      catch (error) {
        const message = error instanceof z.ZodError
          ? `Invalid arguments: ${error.issues.map(issue => `${issue.path.join('.') || 'arguments'}: ${issue.message}`).join('; ')}`
          : error instanceof Error ? error.message : 'wikiship read failed.';
        return { isError: true, content: [{ type: 'text', text: message }] };
      }
    },
  };
}

export function createReadToolDefinitions(app: App, journal: Journal, policy: PathPolicy): McpToolDefinition[] {
  const text = z.string();
  return [
    readTool('active_file_get_path', 'Return the vault-relative path of the active file, or null if no file is active or it is excluded.', {}, async () => {
      const file = app.workspace.getActiveFile();
      if (!file) return null;
      try { await policy.check(file.path); return file.path; } catch { return null; }
    }),
    readTool('vault_list', 'List files and subdirectories inside a vault directory. Directory entries end with /. Excluded paths are omitted.', {
      path: text.optional().default(''),
    }, async args => {
      const folder = args.path ? app.vault.getAbstractFileByPath(args.path) : app.vault.getRoot();
      if (!(folder instanceof TFolder)) throw new Error('Folder does not exist.');
      const names: string[] = [];
      for (const child of folder.children) {
        try { await policy.check(child.path); }
        catch { continue; }
        names.push(child instanceof TFolder ? `${child.name}/` : child.name);
      }
      return names.sort((a, b) => a.localeCompare(b));
    }),
    readTool('vault_read', 'Read a UTF-8 vault file and its Obsidian metadata. Excluded files and binary files are not returned.', {
      path: z.string().min(1).max(4096),
    }, async args => {
      const file = app.vault.getAbstractFileByPath(args.path);
      if (!(file instanceof TFile)) throw new Error('File does not exist.');
      const snapshot = await journal.files.read(args.path);
      if (!snapshot) throw new Error('File does not exist.');
      if (snapshot.encoding !== 'utf8') throw new Error('This file is binary; wikiship text reads support UTF-8 files only.');
      const cache = app.metadataCache.getFileCache(file);
      const links = (cache?.links ?? []).map(link => ({ link: link.link, displayText: link.displayText ?? null,
        targetPath: app.metadataCache.getFirstLinkpathDest(link.link, file.path)?.path ?? null }));
      const backlinks = Object.entries(app.metadataCache.resolvedLinks).filter(([, targets]) => targets[file.path])
        .map(([source]) => source);
      const visibleBacklinks: string[] = [];
      for (const source of backlinks) {
        try { await policy.check(source); visibleBacklinks.push(source); } catch { /* Excluded source notes are not disclosed. */ }
      }
      return { path: args.path, content: textOf(snapshot), tags: (cache?.tags ?? []).map(tag => tag.tag),
        frontmatter: cache?.frontmatter ?? {}, stat: file.stat, links,
        backlinks: visibleBacklinks.sort(),
        unresolvedLinks: Object.keys(app.metadataCache.unresolvedLinks[args.path] ?? {}),
      };
    }),
    readTool('vault_get_document_map', 'Return heading paths, block reference IDs, frontmatter fields, and the current file hash.', {
      path: z.string().min(1).max(4096),
    }, async args => {
      const file = await journal.files.read(args.path);
      if (!file) throw new Error('File does not exist.');
      if (file.encoding !== 'utf8') throw new Error('Document maps require a UTF-8 text file.');
      const content = textOf(file);
      const headings = currentHeadings(content).map(heading => ({ path: heading.path, level: heading.level, from: heading.from, to: heading.to }));
      const blocks = [...content.matchAll(/^\s*\^([\w-]+)\s*$/gm)].map(match => match[1]);
      const frontmatter = /^(?:\uFEFF)?---\r?\n([\s\S]*?)\r?\n(?:---|\.\.\.)(?:\r?\n|$)/.exec(content)?.[1] ?? '';
      const frontmatterFields = [...frontmatter.matchAll(/^([A-Za-z0-9_-]+):/gm)].map(match => match[1]);
      return { headings, blocks, frontmatterFields, version: file.hash };
    }),
    readTool('search_simple', 'Search UTF-8 Markdown notes using case-insensitive literal text search. Returns matching excerpts ranked by match count.', {
      query: z.string().min(1).max(2000), contextLength: z.number().int().min(0).max(1000).default(100),
    }, async args => {
      const query = args.query.toLocaleLowerCase();
      const results: { filename: string; score: number; matches: { match: string }[] }[] = [];
      for (const file of app.vault.getMarkdownFiles()) {
        let snapshot;
        try { snapshot = await journal.files.read(file.path); } catch { continue; }
        if (!snapshot || snapshot.encoding !== 'utf8') continue;
        const content = textOf(snapshot), lower = content.toLocaleLowerCase(), matches: { match: string }[] = [];
        let start = 0;
        while (matches.length < 20) {
          const at = lower.indexOf(query, start);
          if (at < 0) break;
          const from = Math.max(0, at - args.contextLength), to = Math.min(content.length, at + args.query.length + args.contextLength);
          matches.push({ match: content.slice(from, to) });
          start = at + Math.max(1, args.query.length);
        }
        if (matches.length) results.push({ filename: file.path, score: matches.length, matches });
      }
      return results.sort((a, b) => b.score - a.score || a.filename.localeCompare(b.filename)).slice(0, 100);
    }),
    readTool('tag_list', 'Return tags used in indexed Markdown notes with their occurrence counts.', {}, async () => {
      const counts = new Map<string, number>();
      for (const file of app.vault.getMarkdownFiles()) {
        try { await policy.check(file.path); } catch { continue; }
        for (const tag of app.metadataCache.getFileCache(file)?.tags ?? []) counts.set(tag.tag.replace(/^#/, ''), (counts.get(tag.tag.replace(/^#/, '')) ?? 0) + 1);
      }
      return [...counts].map(([tag, count]) => ({ tag, count })).sort((a, b) => a.tag.localeCompare(b.tag));
    }),
  ];
}
