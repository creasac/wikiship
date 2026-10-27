import { App, MarkdownView, TFile, TFolder } from 'obsidian';
import * as fs from 'node:fs/promises';
import { dirname } from 'node:path';
import { bytes, folderSnapshot, hash, MutationPreconditionError, snapshot, textOf, type Operation, type Snapshot, type WorkspaceFiles } from '../model';
import { MAX_FILE_BYTES, PathPolicy } from './storage';

export class ObsidianFiles implements WorkspaceFiles {
  constructor(private app: App, readonly policy: PathPolicy) {}
  async read(path: string): Promise<Snapshot | null> {
    const absolute = await this.policy.check(path);
    let stat;
    try { stat = await fs.stat(absolute); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
    if (!stat.isFile()) throw new Error('wikiship operations require a file, not a directory.');
    if (stat.size > MAX_FILE_BYTES) throw new Error('wikiship v1 supports files up to 5 MiB.');
    // Use Obsidian's uncached adapter read, including ordinary project files.
    const content = new Uint8Array(await this.app.vault.adapter.readBinary(path));
    if (content.byteLength > MAX_FILE_BYTES) throw new Error('File exceeds 5 MiB.');
    return snapshot(content);
  }
  async readFolder(path: string): Promise<Snapshot | null> {
    const absolute = await this.policy.check(path);
    let stat;
    try { stat = await fs.stat(absolute); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
    if (!stat.isDirectory()) throw new Error('wikiship folder operations require a directory.');
    const root = this.app.vault.getAbstractFileByPath(path);
    if (!(root instanceof TFolder)) throw new MutationPreconditionError('Folder is no longer available in the vault.');
    const entries: { path: string; kind: 'file' | 'folder'; hash?: string; size?: number }[] = [];
    const visit = async (folder: TFolder) => {
      for (const child of folder.children) {
        const relative = child.path.slice(path.length + 1);
        await this.policy.check(child.path);
        if (child instanceof TFolder) {
          entries.push({ path: relative, kind: 'folder' });
          await visit(child);
        } else if (child instanceof TFile) {
          const content = new Uint8Array(await this.app.vault.adapter.readBinary(child.path));
          entries.push({ path: relative, kind: 'file', hash: hash(content), size: content.byteLength });
        } else throw new Error(`Unsupported vault item inside folder: ${child.path}`);
      }
    };
    await visit(root);
    return folderSnapshot(entries);
  }
  async trash(path: string, expected: Snapshot): Promise<void> {
    const current = await this.read(path);
    if (!current || current.hash !== expected.hash) throw new MutationPreconditionError('Conflict: file changed before its confirmed deletion could be moved to trash.');
    this.assertEditors(path, expected);
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) throw new MutationPreconditionError('Conflict: the file is no longer available to move to trash.');
    // `false` selects Obsidian's configured vault trash, not permanent deletion.
    await this.app.fileManager.trashFile(file);
  }
  private editors(path: string) {
    return this.app.workspace.getLeavesOfType('markdown').flatMap(leaf => {
      const view = leaf.view;
      return view instanceof MarkdownView && view.file?.path === path && view.getMode() === 'source' ? [view.editor] : [];
    });
  }
  private assertEditors(path: string, expected: Snapshot | null) {
    for (const editor of this.editors(path)) {
      if (!expected || expected.encoding !== 'utf8' || hash(editor.getValue()) !== expected.hash) throw new MutationPreconditionError('Conflict: an open editor has newer or unsaved content. Wait for Obsidian to save, then read again.');
    }
  }
  async readContext(path: string) {
    const file = await this.read(path);
    if (!file) throw new Error('Context file is missing.');
    const editors = this.editors(path);
    if (editors.length) {
      const text = editors[0]!.getValue();
      if (Buffer.byteLength(text) > MAX_FILE_BYTES) throw new Error('Context file exceeds 5 MiB.');
      if (editors.some(editor => editor.getValue() !== text)) throw new Error('Open editors disagree about this file. Save them before reading context.');
      return { text, source: 'editor' as const, mtime: this.app.vault.getFileByPath(path)?.stat.mtime };
    }
    return { text: textOf(file), source: 'disk' as const, mtime: this.app.vault.getFileByPath(path)?.stat.mtime };
  }
  private async assertState(path: string, expected: Snapshot | null) {
    try {
      const current = await this.read(path);
      if (current?.hash !== expected?.hash) throw new MutationPreconditionError('Conflict: file changed before the operation could be applied.');
      this.assertEditors(path, expected);
    } catch (error) {
      // All work in this function is read-only. Distinguish a known refusal from
      // an I/O failure after a mutation might already have happened.
      throw new MutationPreconditionError(error instanceof Error ? error.message : String(error));
    }
  }
  private async assertFolderState(path: string, expected: Snapshot | null) {
    try {
      const current = await this.readFolder(path);
      if (current?.hash !== expected?.hash) throw new MutationPreconditionError('Conflict: folder contents changed before the operation could be applied.');
    } catch (error) {
      throw new MutationPreconditionError(error instanceof Error ? error.message : String(error));
    }
  }
  private async checkFolderParent(path: string) {
    const parentPath = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
    if (parentPath && (await this.readFolder(parentPath)) === null) throw new MutationPreconditionError('Parent folder must already exist.');
  }
  private async applyFolder(op: Operation, reverse: boolean) {
    if (op.kind === 'delete-folder') throw new MutationPreconditionError('Folder deletion is staged and only runs after approval.');
    if (op.kind === 'create-folder') {
      if (reverse) {
        await this.assertFolderState(op.path, op.after);
        const folder = this.app.vault.getAbstractFileByPath(op.path);
        if (!(folder instanceof TFolder) || folder.children.length) throw new MutationPreconditionError('Conflict: created folder is no longer empty.');
        await this.app.vault.adapter.rmdir(op.path, false);
      } else {
        await this.assertFolderState(op.path, null);
        await this.checkFolderParent(op.path);
        await this.app.vault.createFolder(op.path);
      }
      return;
    }
    const source = reverse ? op.target! : op.path, target = reverse ? op.path : op.target!;
    const expected = reverse ? op.after : op.before;
    if (target === source || target.startsWith(`${source}/`) || source.startsWith(`${target}/`)) throw new MutationPreconditionError('Folder cannot be moved into itself or one of its descendants.');
    await this.assertFolderState(source, expected);
    await this.assertFolderState(target, null);
    await this.checkFolderParent(target);
    const folder = this.app.vault.getAbstractFileByPath(source);
    if (!(folder instanceof TFolder)) throw new MutationPreconditionError('Folder is no longer available to move.');
    await this.app.vault.rename(folder, target);
  }
  async trashFolder(path: string, expected: Snapshot): Promise<void> {
    await this.assertFolderState(path, expected);
    const folder = this.app.vault.getAbstractFileByPath(path);
    if (!(folder instanceof TFolder)) throw new MutationPreconditionError('Conflict: the folder is no longer available to move to trash.');
    await this.app.fileManager.trashFile(folder);
  }
  private async create(path: string, value: Snapshot) {
    await this.assertState(path, null);
    try {
      const absolute = await this.policy.check(path);
      if (!(await fs.stat(dirname(absolute))).isDirectory()) throw new Error('Parent folder must already exist.');
    } catch (error) { throw new MutationPreconditionError(error instanceof Error ? error.message : String(error)); }
    // Vault.create rejects existing files; unlike adapter.write, it does not
    // intentionally replace a destination. Parent folders are never auto-created.
    if (value.encoding === 'utf8') await this.app.vault.create(path, value.data);
    else await this.app.vault.createBinary(path, Uint8Array.from(bytes(value)).buffer);
  }
  async apply(op: Operation, reverse: boolean) {
    if (op.kind.endsWith('-folder')) return this.applyFolder(op, reverse);
    const from = reverse ? op.after : op.before, to = reverse ? op.before : op.after;
    if (op.kind === 'move') {
      const source = reverse ? op.target! : op.path, target = reverse ? op.path : op.target!;
      await this.assertState(target, null); await this.assertState(source, from);
      this.assertEditors(source, from);
      const file = this.app.vault.getAbstractFileByPath(source);
      // Vault.rename deliberately avoids FileManager's automatic backlink edits,
      // which would otherwise create unjournaled changes in other documents.
      if (file instanceof TFile) await this.app.vault.rename(file, target);
      else await this.app.vault.adapter.rename(source, target);
      return;
    }
    await this.assertState(op.path, from);
    if (from === null) { if (!to) throw new Error('Invalid create operation.'); await this.create(op.path, to); return; }
    if (to === null) {
      this.assertEditors(op.path, from);
      const file = this.app.vault.getAbstractFileByPath(op.path);
      if (file instanceof TFile) await this.app.fileManager.trashFile(file);
      else await this.app.vault.adapter.remove(op.path);
      return;
    }
    const update = (current: string) => {
      this.assertEditors(op.path, from);
      if (hash(current) !== from.hash) throw new MutationPreconditionError('Conflict: file changed during mutation.');
      return textOf(to);
    };
    const file = this.app.vault.getFileByPath(op.path);
    if (file) await this.app.vault.process(file, update);
    else await this.app.vault.adapter.process(op.path, update);
  }
}
