import { ItemView, MarkdownView, Modal, Notice, type App, type WorkspaceLeaf } from 'obsidian';
import { diffLines } from 'diff';
import { wikishipIconId } from '../icon';
import { folderEntries, type FolderEntry, type Operation, type Snapshot } from '../model';
import type { Journal } from '../provenance/journal';
import { locationsForFile, operationLabel } from './changes';
import { snapshotPage } from './paging';

export const CHANGES_VIEW_TYPE = 'wikiship-changes';

function errorMessage(error: unknown) { return error instanceof Error ? error.message : String(error); }

function action(parent: HTMLElement, label: string, callback: () => unknown | Promise<unknown>, cls?: string) {
  const button = parent.createEl('button', { text: label, cls, attr: { type: 'button' } });
  button.addEventListener('click', async () => {
    if (button.disabled) return;
    button.disabled = true;
    try { await callback(); }
    catch (error) { new Notice(errorMessage(error), 9000); }
    finally { button.disabled = false; }
  });
  return button;
}

async function openLocation(app: App, path: string, from?: number, to?: number) {
  const file = app.vault.getFileByPath(path);
  if (!file) throw new Error("This file is missing. Its recorded content is still available in machine minds' changes.");
  const leaf = app.workspace.getLeaf(false);
  await leaf.openFile(file, { active: true });
  if (from !== undefined && leaf.view instanceof MarkdownView) {
    const editor = leaf.view.editor, end = Math.min(editor.getValue().length, to ?? from);
    const start = editor.offsetToPos(Math.min(from, end)), finish = editor.offsetToPos(end);
    editor.setSelection(start, finish); editor.scrollIntoView({ from: start, to: finish }, true);
  }
}

async function openChangeLocation(app: App, journal: Journal, op: Operation) {
  const path = op.target ?? op.path;
  if (!app.vault.getFileByPath(path)) return;
  if (op.kind === 'delete' && op.before?.encoding === 'utf8') {
    await openLocation(app, path, 0, op.before.data.length);
    return;
  }
  const current = await journal.files.read(path);
  const location = current?.encoding === 'utf8'
    ? locationsForFile(journal.state.operations, path, current.data).find(candidate => candidate.operationId === op.id)
    : undefined;
  await openLocation(app, path, location?.from, location?.to);
}

interface FileReviewGroup {
  operations: Operation[];
  path: string;
  movedFrom?: string;
  first: Operation;
  last: Operation;
  category: 'Added' | 'Modified' | 'Deleted' | 'Moved' | 'Needs review';
  removed: number;
  added: number;
  lineTotalsAvailable: boolean;
  conflict: boolean;
}

interface FolderReviewGroup {
  operation: Operation;
  path: string;
  category: 'Added' | 'Deleted' | 'Moved';
  entries: FolderEntry[];
  needsReview: boolean;
}

interface ReviewBatch { session?: string; operations: Operation[]; files: FileReviewGroup[]; folders: FolderReviewGroup[]; }

function visibleLines(value: string): number {
  if (!value) return 0;
  const lines = value.split('\n');
  if (lines.at(-1) === '') lines.pop();
  return lines.length;
}

function lineTotals(before: Snapshot | null, after: Snapshot | null) {
  if (before?.encoding === 'base64' || after?.encoding === 'base64') return { removed: 0, added: 0, available: false };
  const parts = diffLines(before?.data ?? '', after?.data ?? '', { timeout: 1000 });
  if (!parts) return { removed: 0, added: 0, available: false };
  return { ...parts.reduce((total, part) => {
    if (part.removed) total.removed += visibleLines(part.value);
    if (part.added) total.added += visibleLines(part.value);
    return total;
  }, { removed: 0, added: 0 }), available: true };
}

function reviewBatches(operations: Operation[]): ReviewBatch[] {
  const batches = new Map<string | undefined, Operation[]>();
  for (const op of operations) {
    const group = batches.get(op.session) ?? [];
    group.push(op); batches.set(op.session, group);
  }
  return [...batches].map(([session, items]) => {
    const groups: FileReviewGroup[] = [];
    const owner = new Map<string, FileReviewGroup>();
    const folderOperations = items.filter(op => op.kind.endsWith('-folder'));
    for (const op of items.filter(operation => !operation.kind.endsWith('-folder'))) {
      const group = owner.get(op.path);
      if (group) {
        group.operations.push(op); group.last = op;
        if (op.kind === 'move' && op.target) {
          owner.delete(op.path); owner.set(op.target, group);
        }
        Object.assign(group, displayFilePath(group.operations));
      } else {
        const displayPath = displayFilePath([op]);
        const created: FileReviewGroup = {
          operations: [op], ...displayPath,
          first: op, last: op, category: 'Modified', removed: 0, added: 0, lineTotalsAvailable: true, conflict: false,
        };
        groups.push(created); owner.set(op.kind === 'move' && op.target ? op.target : op.path, created);
      }
    }
    for (const file of groups) {
      const chain = file.operations;
      file.conflict = chain.some(op => !['applied', 'pending-delete'].includes(op.status)) ||
        chain.slice(1).some((op, index) => chain[index]!.after?.hash !== op.before?.hash);
      const before = file.first.before, after = file.last.after;
      if (file.conflict) file.category = 'Needs review';
      else if (after === null) file.category = 'Deleted';
      else if (before === null) file.category = 'Added';
      else if (chain.some(op => op.kind === 'move')) file.category = 'Moved';
      else file.category = 'Modified';
      if (!file.conflict) {
        const totals = lineTotals(before, after);
        file.removed = totals.removed; file.added = totals.added; file.lineTotalsAvailable = totals.available;
      } else file.lineTotalsAvailable = false;
    }
    const folders: FolderReviewGroup[] = folderOperations.map(operation => ({
      operation,
      path: operation.path,
      category: operation.kind === 'create-folder' ? 'Added' : operation.kind === 'delete-folder' ? 'Deleted' : 'Moved',
      entries: folderEntries((operation.kind === 'delete-folder' ? operation.before : operation.after)!),
      needsReview: !['applied', 'pending-delete'].includes(operation.status),
    }));
    return { session, operations: items, files: groups, folders };
  }).sort((a, b) => latestTimestamp(b.operations).localeCompare(latestTimestamp(a.operations)));
}

function displayFilePath(operations: Operation[]) {
  const firstPath = operations[0]!.path;
  const last = operations.at(-1)!;
  const finalPath = last.kind === 'move' ? last.target! : last.path;
  return { path: finalPath, movedFrom: firstPath === finalPath ? undefined : firstPath };
}

function renderPath(parent: HTMLElement, path: string, movedFrom?: string, folder = false) {
  const suffix = folder ? '/' : '';
  const stack = parent.createSpan({ cls: 'wikiship-path-stack' });
  if (movedFrom) {
    stack.createSpan({ text: `${movedFrom}${suffix}` });
    stack.createSpan({ cls: 'wikiship-move-arrow', text: '→' });
  }
  stack.createSpan({ text: `${path}${suffix}` });
}

function lineCount(value: number, sign: '−' | '+') { return value ? `${sign} ${value}` : ''; }

function latestTimestamp(operations: Operation[]) {
  return operations.reduce((latest, op) => op.timestamp > latest ? op.timestamp : latest, operations[0]!.timestamp);
}
function formatTimestamp(timestamp: string) {
  const date = new Date(timestamp);
  const dateText = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
    .formatToParts(date).map(part => part.type === 'month' ? part.value.toLowerCase() : part.value).join('');
  const timeText = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(date);
  return `${dateText}, ${timeText}`;
}
function formatBatchTime(operations: Operation[]) { return formatTimestamp(latestTimestamp(operations)); }

async function undoFile(journal: Journal, group: FileReviewGroup) {
  for (const op of [...group.operations].reverse()) await journal.undo(op.id);
}

export class ChangesView extends ItemView {
  private stop?: () => void;
  constructor(leaf: WorkspaceLeaf, readonly journal: Journal) { super(leaf); }
  getViewType() { return CHANGES_VIEW_TYPE; }
  getDisplayText() { return "machine minds' changes"; }
  getIcon() { return wikishipIconId; }
  async onOpen() {
    this.contentEl.addClass('wikiship-view');
    this.stop = this.journal.subscribe(() => this.render()); this.render();
  }
  async onClose() { this.stop?.(); }
  private render() {
    const root = this.contentEl; root.empty();
    root.createEl('h4', { text: 'wikiship' });
    const all = this.journal.state.operations;
    if (all.some(op => ['prepared', 'uncertain', 'reverting', 'committing-delete'].includes(op.status))) {
      root.createEl('p', { cls: 'wikiship-warning', text: 'An interrupted operation needs recovery before changes can be undone or cleared.' });
      action(root, 'Recover interrupted operations', () => this.journal.recover());
    }
    if (!all.length) {
      root.createEl('p', { cls: 'wikiship-muted', text: 'No changes to review.' }); return;
    }
    root.createEl('p', { cls: 'wikiship-muted wikiship-approval-hint', text: 'Approve to keep the changes and clear the review.' });
    const batches = reviewBatches(all);
    for (const batch of batches) {
      const { session, operations } = batch;
      const section = root.createDiv('wikiship-session-group');
      const title = session || 'Unlabelled session';
      section.createEl('h5', { text: title, cls: 'wikiship-path' });
      section.createEl('div', { cls: 'wikiship-muted wikiship-batch-meta', text: formatBatchTime(operations) });
      for (const folderGroup of batch.folders) {
        const { operation } = folderGroup;
        const details = section.createEl('details', { cls: 'wikiship-folder-review' });
        const summary = details.createEl('summary', { cls: 'wikiship-folder-summary' });
        const filenameClass = folderGroup.category === 'Added' ? ' wikiship-file-added'
          : folderGroup.category === 'Deleted' ? ' wikiship-file-deleted' : '';
        const path = summary.createSpan({ cls: `wikiship-file-link${filenameClass}` });
        renderPath(path, folderGroup.operation.kind === 'move-folder' ? folderGroup.operation.target! : folderGroup.path,
          folderGroup.operation.kind === 'move-folder' ? folderGroup.path : undefined, true);
        summary.createSpan({ cls: 'wikiship-file-meta', text: `folder · ${folderGroup.entries.filter(entry => entry.kind === 'file').length} files · ${folderGroup.entries.filter(entry => entry.kind === 'folder').length} subfolders` });
        if (folderGroup.needsReview) details.createEl('p', { cls: 'wikiship-warning wikiship-file-warning', text: operation.error ?? 'Folder operation needs recovery before approval.' });
        if (!folderGroup.entries.length) details.createEl('div', { cls: 'wikiship-muted wikiship-folder-empty', text: 'Empty folder' });
        else {
          const contents = details.createDiv('wikiship-folder-contents');
          const rootPath = operation.kind === 'move-folder' ? operation.target! : operation.path;
          for (const entry of folderGroup.entries) {
            if (entry.kind === 'folder') contents.createDiv({ cls: 'wikiship-folder-child wikiship-muted', text: `▸ ${entry.path}/` });
            else action(contents, entry.path, () => openLocation(this.app, `${rootPath}/${entry.path}`), 'wikiship-text-button wikiship-folder-child');
          }
        }
      }
      for (const [index, fileGroup] of batch.files.entries()) {
        const file = section.createDiv(`wikiship-file-group${index === 0 ? ' wikiship-first-file-group' : ''}`);
        const filenameClass = fileGroup.category === 'Added' ? ' wikiship-file-added'
          : fileGroup.category === 'Deleted' ? ' wikiship-file-deleted' : '';
        const row = action(file, '', () => inspectFile(this.app, this.journal, fileGroup), 'wikiship-text-button wikiship-file-row');
        const path = row.createSpan({ cls: `wikiship-file-link${filenameClass}` });
        renderPath(path, fileGroup.path, fileGroup.movedFrom);
        const counts = fileGroup.lineTotalsAvailable
          ? [lineCount(fileGroup.removed, '−'), lineCount(fileGroup.added, '+')].filter(Boolean).join(' ')
          : 'line totals unavailable';
        row.createSpan({ cls: `wikiship-file-meta${fileGroup.conflict ? ' wikiship-warning' : ''}`, text: counts });
        if (fileGroup.conflict) file.createEl('p', { cls: 'wikiship-warning wikiship-file-warning', text: 'Recorded steps do not form a verified sequence. Open review to inspect each step.' });
      }
      const sessionActions = section.createDiv('wikiship-session-actions');
      action(sessionActions, 'Approve', async () => {
        const deletes = operations.filter(op => ['delete', 'delete-folder'].includes(op.kind) && op.status === 'pending-delete').length;
        const result = await this.journal.completeSession(session);
        new Notice(`Approved ${result.cleared} change(s)${deletes ? `; moved ${deletes} item(s) to trash` : ''}.`);
      }, 'mod-cta');
      action(sessionActions, 'Undo', async () => {
        const result = await this.journal.undoSession(session); new Notice(`Undid ${result.undone} change(s). Review data cleared.`);
      }, 'mod-warning');
    }
  }
}

async function inspectFile(app: App, journal: Journal, group: FileReviewGroup) {
  const latest = group.operations.at(-1)!;
  lastInspected.set(journal, latest.id);
  await openChangeLocation(app, journal, latest);
  new FileReviewModal(app, journal, latest.id).open();
}

function snapshotPanel(parent: HTMLElement, label: string, snapshot: Snapshot | null) {
  const panel = parent.createDiv('wikiship-snapshot');
  panel.dataset.wikishipSnapshot = label.toLowerCase();
  panel.createEl('h5', { text: label });
  if (!snapshot) { panel.createEl('p', { cls: 'wikiship-muted', text: label === 'After approval' ? 'Moves to trash when approved' : 'File does not exist' }); return; }
  if (snapshot.encoding === 'base64') {
    panel.createEl('p', { cls: 'wikiship-muted', text: `Binary file · ${snapshot.size.toLocaleString()} bytes · content retained only while this change is queued` });
  } else {
    const first = snapshotPage(snapshot.data);
    const navigation = first.pageCount > 1 ? panel.createDiv('wikiship-snapshot-navigation wikiship-actions') : undefined;
    const source = panel.createEl('pre', { text: first.text, cls: 'wikiship-source' });
    if (navigation) {
      let currentPage = 0;
      const button = (text: string, target: () => number) => {
        const element = navigation.createEl('button', { text, attr: { type: 'button', 'aria-label': `${label} ${text.toLowerCase()} page` } });
        element.addEventListener('click', () => showPage(target()));
        return element;
      };
      const firstButton = button('First', () => 0), previousButton = button('Previous', () => currentPage - 1);
      const pageLabel = navigation.createEl('label', { cls: 'wikiship-snapshot-page-label', text: 'Page ' });
      const pageInput = pageLabel.createEl('input', { type: 'number', value: '1', attr: {
        min: 1, max: first.pageCount, step: 1, 'aria-label': `${label} snapshot page`,
      } });
      pageInput.setCssStyles({ width: '4.5em' });
      pageLabel.createSpan({ text: ` of ${first.pageCount}` });
      const nextButton = button('Next', () => currentPage + 1), lastButton = button('Last', () => first.pageCount - 1);
      function showPage(index: number) {
        const page = snapshotPage(snapshot!.data, index);
        currentPage = page.page; source.setText(page.text); source.scrollTop = 0;
        pageInput.value = String(currentPage + 1);
        firstButton.disabled = previousButton.disabled = currentPage === 0;
        nextButton.disabled = lastButton.disabled = currentPage === page.pageCount - 1;
      }
      pageInput.addEventListener('change', () => showPage(pageInput.valueAsNumber - 1));
      pageInput.addEventListener('keydown', event => {
        if (event.key === 'Enter') { event.preventDefault(); showPage(pageInput.valueAsNumber - 1); }
      });
      showPage(0);
    }
  }
  panel.createEl('div', { cls: 'wikiship-hash', text: `SHA-256 ${snapshot.hash}` });
}

export class FileReviewModal extends Modal {
  private stop?: () => void;
  constructor(app: App, readonly journal: Journal, readonly operationId: string) { super(app); }
  onOpen() {
    this.modalEl.addClass('wikiship-review-modal');
    this.stop = this.journal.subscribe(() => this.renderFile()); this.renderFile();
  }
  onClose() { this.stop?.(); this.contentEl.empty(); }
  private renderFile() {
    const batches = reviewBatches(this.journal.state.operations);
    const batch = batches.find(candidate => candidate.files.some(file => file.operations.some(op => op.id === this.operationId)));
    const group = batch?.files.find(file => file.operations.some(op => op.id === this.operationId));
    const root = this.contentEl; root.empty();
    this.titleEl.setText('Review changes');
    if (!batch || !group) { root.createEl('p', { text: 'This file is no longer in the review queue.' }); return; }
    const index = batch.files.indexOf(group);
    const title = root.createDiv({ cls: 'wikiship-path wikiship-review-file-title' });
    renderPath(title, group.path, group.movedFrom);
    const counts = group.lineTotalsAvailable
      ? [lineCount(group.removed, '−'), lineCount(group.added, '+')].filter(Boolean).join(' ')
      : 'line totals unavailable';
    if (group.conflict) root.createEl('p', { cls: 'wikiship-warning', text: 'These recorded steps do not form one verified before-and-after chain. Review each step and the current file before approving or undoing.' });
    if (group.operations.some(op => op.kind === 'delete' && op.status === 'pending-delete')) {
      root.createEl('p', { cls: 'wikiship-delete-notice', text: 'The file stays in your vault until approval. Approval moves it to trash. Undo cancels the deletion.' });
    }
    if (group.operations.length > 1) {
      const history = root.createEl('details', { cls: 'wikiship-history' });
      history.createEl('summary', { text: 'Operation history' });
      const entries = history.createEl('ol');
      for (const operation of group.operations) entries.createEl('li', { text: operationLabel(operation) });
    }
    const toolbar = root.createDiv({ cls: 'wikiship-review-toolbar' });
    const toolbarStart = toolbar.createDiv({ cls: 'wikiship-review-toolbar-start' });
    const changeControls = toolbar.createDiv({ cls: 'wikiship-review-toolbar-changes' });
    const toolbarEnd = toolbar.createDiv({ cls: 'wikiship-review-toolbar-end' });
    toolbarStart.createSpan({ cls: 'wikiship-muted', text: `File ${index + 1} of ${batch.files.length}` });
    if (batch.files.length > 1) action(toolbarStart, 'Next file', async () => { this.close(); await nextFile(this.app, this.journal, this.operationId); });
    if (counts) toolbarEnd.createSpan({ cls: 'wikiship-muted wikiship-review-line-counts', text: counts });
    action(toolbarEnd, 'Undo file', async () => { await undoFile(this.journal, group); new Notice('File changes undone and review data cleared.'); this.close(); }, 'mod-warning');

    const before = group.first.before?.encoding === 'utf8' ? group.first.before.data : group.first.before ? null : '';
    const after = group.last.after?.encoding === 'utf8' ? group.last.after.data : group.last.after ? null : '';
    let showRecoveryRecord = false;
    if (group.conflict) {
      root.createEl('h5', { text: 'Recorded steps' });
      root.createEl('p', { cls: 'wikiship-muted', text: 'A combined diff is unavailable because the saved steps are not continuous. Recovery snapshots are available below.' });
      showRecoveryRecord = true;
    } else if (before !== null && after !== null && before !== after && before.length + after.length <= 400_000) {
      const diff = root.createEl('pre', { cls: 'wikiship-diff' });
      const parts = diffLines(before, after, { timeout: 1000 });
      if (parts) {
        const changes: HTMLElement[][] = [];
        let activeChange: HTMLElement[] | undefined;
        for (const part of parts) {
          const type = part.added ? 'added' : part.removed ? 'removed' : 'unchanged';
          if (type === 'unchanged') activeChange = undefined;
          else if (!activeChange) {
            activeChange = [];
            changes.push(activeChange);
          }
          const lines = part.value.split('\n');
          if (lines.at(-1) === '') lines.pop();
          for (const line of lines) {
            const row = diff.createDiv({ cls: 'wikiship-diff-row' });
            row.createSpan({ cls: 'wikiship-diff-selection-marker' });
            row.createSpan({ cls: 'wikiship-diff-sign', text: part.added ? '+' : part.removed ? '−' : '' });
            row.createSpan({ cls: `wikiship-diff-${type}`, text: line });
            if (type !== 'unchanged') activeChange!.push(row);
          }
        }
        if (changes.length) {
          let currentChange = 0;
          const navigation = changeControls.createDiv({ cls: 'wikiship-change-navigation' });
          if (changes.length > 1) action(navigation, 'Previous', () => {
            currentChange = (currentChange - 1 + changes.length) % changes.length;
            showCurrentChange();
          });
          const position = navigation.createEl('span', { cls: 'wikiship-muted' });
          if (changes.length > 1) action(navigation, 'Next', () => {
            currentChange = (currentChange + 1) % changes.length;
            showCurrentChange();
          });
          const showCurrentChange = () => {
            position.setText(`Change ${currentChange + 1} of ${changes.length}`);
            changes.forEach((rows, index) => rows.forEach((row, rowIndex) => {
              row.querySelector('.wikiship-diff-selection-marker')?.setText(index === currentChange && rowIndex === 0 ? '›' : '');
            }));
            changes[currentChange]![0]!.scrollIntoView({ behavior: 'smooth', block: 'center' });
          };
          showCurrentChange();
        }
      } else {
        root.createEl('p', { cls: 'wikiship-muted', text: 'Diff calculation reached its time limit. Recovery snapshots are available below.' });
        showRecoveryRecord = true;
      }
    } else if (before !== null && after !== null && before !== after) {
      root.createEl('p', { cls: 'wikiship-muted', text: 'This change is too large for an inline diff. Recovery snapshots are available below.' });
      showRecoveryRecord = true;
    } else if (group.last.kind === 'delete' && group.last.status === 'pending-delete') {
      root.createEl('p', { cls: 'wikiship-muted', text: 'This file will be removed from the vault when approved.' });
    } else if (group.first.before?.encoding === 'base64' || group.last.after?.encoding === 'base64') {
      root.createEl('p', { cls: 'wikiship-muted', text: 'Binary file. Contents are available in the recovery record.' });
      showRecoveryRecord = true;
    } else if (group.operations.some(op => op.kind === 'move')) {
      root.createEl('p', { cls: 'wikiship-muted', text: 'File moved. Its contents are unchanged.' });
    }

    if (showRecoveryRecord) {
      const recovery = root.createEl('details', { cls: 'wikiship-snapshots' });
      recovery.createEl('summary', { text: `Recovery snapshots · ${group.operations.length} steps` });
      for (const op of group.operations) {
        const details = recovery.createEl('details', { cls: 'wikiship-recovery-operation' });
        details.createEl('summary', { text: `${operationLabel(op)} · ${op.id}` });
        if (op.error) details.createEl('p', { cls: 'wikiship-warning', text: op.error });
        const columns = details.createDiv('wikiship-snapshot-columns');
        snapshotPanel(columns, 'Before', op.before);
        snapshotPanel(columns, op.kind === 'delete' && op.status === 'pending-delete' ? 'After approval' : 'After', op.after);
      }
    }
  }
}

const lastInspected = new WeakMap<Journal, string>();

export async function nextChange(app: App, journal: Journal, afterId?: string): Promise<void> {
  await nextFile(app, journal, afterId ?? lastInspected.get(journal));
}

async function nextFile(app: App, journal: Journal, afterId?: string) {
  const files = reviewBatches(journal.state.operations).flatMap(batch => batch.files.map(file => ({ batch, file })));
  if (!files.length) { new Notice('No files are awaiting review.'); return; }
  const at = files.findIndex(item => item.file.operations.some(op => op.id === afterId));
  const next = files[at >= 0 ? (at + 1) % files.length : 0]!;
  const op = next.file.operations.at(-1)!;
  lastInspected.set(journal, op.id);
  const path = op.kind === 'move' ? op.target! : op.path;
  if (app.vault.getFileByPath(path)) await openChangeLocation(app, journal, op);
  new FileReviewModal(app, journal, op.id).open();
}
