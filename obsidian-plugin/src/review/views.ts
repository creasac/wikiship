import { ItemView, MarkdownView, Modal, Notice, type App, type WorkspaceLeaf } from 'obsidian';
import { diffLines } from 'diff';
import { WIKISHIP_ICON_ID } from '../icon';
import type { Operation, Snapshot } from '../model';
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
  first: Operation;
  last: Operation;
  category: 'Added' | 'Modified' | 'Deleted' | 'Moved' | 'Needs review';
  removed: number;
  added: number;
  lineTotalsAvailable: boolean;
  conflict: boolean;
}

interface ReviewBatch { session?: string; operations: Operation[]; files: FileReviewGroup[]; }

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
    for (const op of items) {
      const group = owner.get(op.path);
      if (group) {
        group.operations.push(op); group.last = op;
        if (op.kind === 'move' && op.target) {
          owner.delete(op.path); owner.set(op.target, group);
        }
        group.path = displayFilePath(group.operations);
      } else {
        const created: FileReviewGroup = {
          operations: [op], path: op.kind === 'move' ? `${op.path} → ${op.target}` : op.path,
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
    return { session, operations: items, files: groups };
  }).sort((a, b) => latestTimestamp(b.operations).localeCompare(latestTimestamp(a.operations)));
}

function displayFilePath(operations: Operation[]) {
  const firstPath = operations[0]!.path;
  const last = operations.at(-1)!;
  const finalPath = last.kind === 'move' ? last.target! : last.path;
  return firstPath === finalPath ? firstPath : `${firstPath} → ${finalPath}`;
}

function lineCount(value: number, sign: '−' | '+') { return value ? `${sign} ${value}` : ''; }

function formatAgents(operations: Operation[]) {
  const agents = [...new Set(operations.map(op => op.agent).filter((name): name is string => !!name))];
  return agents.length ? agents.join(', ') : 'Agent not recorded';
}

function latestTimestamp(operations: Operation[]) {
  return operations.reduce((latest, op) => op.timestamp > latest ? op.timestamp : latest, operations[0]!.timestamp);
}
function formatBatchTime(operations: Operation[]) { return new Date(latestTimestamp(operations)).toLocaleString(); }

async function undoFile(journal: Journal, group: FileReviewGroup) {
  for (const op of [...group.operations].reverse()) await journal.undo(op.id);
}

export class ChangesView extends ItemView {
  private stop?: () => void;
  constructor(leaf: WorkspaceLeaf, readonly journal: Journal) { super(leaf); }
  getViewType() { return CHANGES_VIEW_TYPE; }
  getDisplayText() { return "machine minds' changes"; }
  getIcon() { return WIKISHIP_ICON_ID; }
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
      root.createEl('p', { cls: 'wikiship-muted', text: "Changes made by machine minds through wikiship appear here. Your ordinary edits are not included." }); return;
    }
    const batches = reviewBatches(all);
    for (const batch of batches) {
      const { session, operations } = batch;
      const section = root.createDiv('wikiship-session-group');
      const title = session || 'Unlabelled session';
      section.createEl('h5', { text: title, cls: 'wikiship-path' });
      section.createEl('div', { cls: 'wikiship-muted wikiship-batch-meta', text: `${formatBatchTime(operations)} · ${formatAgents(operations)}` });
      const sessionActions = section.createDiv('wikiship-session-actions');
      action(sessionActions, 'Approve session', async () => {
        const deletes = operations.filter(op => op.kind === 'delete' && op.status === 'pending-delete').length;
        const result = await this.journal.completeSession(session);
        new Notice(`Approved ${result.cleared} change(s)${deletes ? `; moved ${deletes} file(s) to trash` : ''}.`);
      }, 'mod-cta');
      action(sessionActions, 'Undo session', async () => {
        const result = await this.journal.undoSession(session); new Notice(`Undid ${result.undone} change(s). Review data cleared.`);
      }, 'mod-warning');
      for (const fileGroup of batch.files) {
        const file = section.createDiv('wikiship-file-group');
        const row = file.createDiv('wikiship-file-row');
        const filenameClass = fileGroup.category === 'Added' ? ' wikiship-file-added'
          : fileGroup.category === 'Deleted' ? ' wikiship-file-deleted' : '';
        action(row, fileGroup.path, () => inspectFile(this.app, this.journal, fileGroup), `wikiship-text-button wikiship-file-link${filenameClass}`);
        const counts = fileGroup.lineTotalsAvailable
          ? [lineCount(fileGroup.removed, '−'), lineCount(fileGroup.added, '+')].filter(Boolean).join(' ')
          : 'line totals unavailable';
        row.createSpan({ cls: `wikiship-file-meta${fileGroup.conflict ? ' wikiship-warning' : ''}`, text: counts });
        if (fileGroup.conflict) row.createEl('p', { cls: 'wikiship-warning wikiship-file-warning', text: 'Recorded steps do not form a verified sequence. Open review to inspect each step.' });
      }
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
    this.titleEl.setText('Review file');
    if (!batch || !group) { root.createEl('p', { text: 'This file is no longer in the review queue.' }); return; }
    const index = batch.files.indexOf(group);
    root.createEl('p', { cls: 'wikiship-path wikiship-review-file-title', text: group.path });
    root.createEl('p', { cls: 'wikiship-muted', text: `${index + 1} of ${batch.files.length} files · ${group.category}` });
    if (group.conflict) root.createEl('p', { cls: 'wikiship-warning', text: 'These recorded steps do not form one verified before-and-after chain. Review each step and the current file before approving or undoing.' });
    if (group.operations.some(op => op.kind === 'delete' && op.status === 'pending-delete')) {
      root.createEl('p', { cls: 'wikiship-delete-notice', text: 'The file stays in your vault until approval. Approval moves it to trash. Undo cancels the deletion.' });
    }
    const actions = root.createDiv('wikiship-actions');
    action(actions, 'Undo file', async () => { await undoFile(this.journal, group); new Notice('File changes undone and review data cleared.'); this.close(); }, 'mod-warning');
    action(actions, 'Approve session', async () => {
      const deletes = batch.operations.filter(op => op.kind === 'delete' && op.status === 'pending-delete').length;
      const result = await this.journal.completeSession(batch.session);
      new Notice(`Approved ${result.cleared} change(s)${deletes ? `; moved ${deletes} file(s) to trash` : ''}.`); this.close();
    }, 'mod-cta');
    action(actions, 'Next file', async () => { this.close(); await nextFile(this.app, this.journal, this.operationId); });
    const latest = group.operations.at(-1)!;
    const targetPath = latest.kind === 'move' ? latest.target! : latest.path;
    if (this.app.vault.getFileByPath(targetPath)) action(actions, 'Open file', () => openChangeLocation(this.app, this.journal, latest));

    const before = group.first.before?.encoding === 'utf8' ? group.first.before.data : group.first.before ? null : '';
    const after = group.last.after?.encoding === 'utf8' ? group.last.after.data : group.last.after ? null : '';
    if (group.conflict) {
      root.createEl('h5', { text: 'Recorded steps' });
      root.createEl('p', { cls: 'wikiship-muted', text: 'A combined diff is hidden because the saved steps are not continuous.' });
    } else if (before !== null && after !== null && before !== after && before.length + after.length <= 400_000) {
      root.createEl('h5', { text: 'Net diff' });
      const diff = root.createEl('pre', { cls: 'wikiship-diff' });
      const parts = diffLines(before, after, { timeout: 1000 });
      if (parts) for (const part of parts) {
        const type = part.added ? 'added' : part.removed ? 'removed' : 'unchanged';
        const lines = part.value.split('\n');
        if (lines.at(-1) === '') lines.pop();
        const visible = type === 'unchanged' && lines.length > 8 ? [...lines.slice(0, 3), `… ${lines.length - 6} unchanged lines …`, ...lines.slice(-3)] : lines;
        for (const line of visible) diff.createSpan({ cls: `wikiship-diff-${type}`, text: `${part.added ? '+' : part.removed ? '−' : ' '} ${line}` });
      } else root.createEl('p', { cls: 'wikiship-muted', text: 'Diff calculation reached its time limit. Use the recorded snapshots below.' });
    } else if (before !== null && after !== null && before !== after) {
      root.createEl('p', { cls: 'wikiship-muted', text: 'This change is too large for an inline diff. Use the recorded snapshots below.' });
    } else if (group.last.kind === 'delete' && group.last.status === 'pending-delete') {
      root.createEl('p', { cls: 'wikiship-muted', text: 'This file will be removed from the vault when approved.' });
    } else if (group.first.before?.encoding === 'base64' || group.last.after?.encoding === 'base64') {
      root.createEl('p', { cls: 'wikiship-muted', text: 'Binary file. Contents are available in the recovery record.' });
    } else if (group.operations.some(op => op.kind === 'move')) {
      root.createEl('p', { cls: 'wikiship-muted', text: 'File moved. Its contents are unchanged.' });
    }

    const history = root.createEl('details', { cls: 'wikiship-history' });
    history.createEl('summary', { text: `Operation history · ${group.operations.length}` });
    for (const op of group.operations) {
      const entry = history.createDiv('wikiship-history-entry');
      entry.createDiv({ cls: 'wikiship-history-description', text: `${new Date(op.timestamp).toLocaleString()} · ${operationLabel(op)} · ${op.status}` });
      if (op.agent) entry.createDiv({ cls: 'wikiship-muted', text: op.agent });
      if (op.error) entry.createEl('p', { cls: 'wikiship-warning', text: op.error });
      action(entry, 'Undo step', async () => { await this.journal.undo(op.id); new Notice('Change undone and review data cleared.'); }, 'wikiship-text-button wikiship-muted');
    }

    const recovery = root.createEl('details', { cls: 'wikiship-snapshots' });
    recovery.createEl('summary', { text: 'Recovery record' });
    for (const op of group.operations) {
      const details = recovery.createEl('details', { cls: 'wikiship-recovery-operation' });
      details.createEl('summary', { text: `${operationLabel(op)} · ${op.id}` });
      if (op.error) details.createEl('p', { cls: 'wikiship-warning', text: op.error });
      const columns = details.createDiv('wikiship-snapshot-columns');
      snapshotPanel(columns, 'Before', op.before);
      snapshotPanel(columns, op.kind === 'delete' && op.status === 'pending-delete' ? 'After approval' : 'After', op.after);
    }
    root.createEl('p', { cls: 'wikiship-muted', text: 'Approval clears these review records. WikiShip cannot restore them afterward.' });
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
