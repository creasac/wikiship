import { ItemView, MarkdownView, Modal, Notice, type App, type WorkspaceLeaf } from 'obsidian';
import { diffLines } from 'diff';
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
  if (!file) throw new Error('This file is missing. Its recorded content is still available in AI Changes.');
  const leaf = app.workspace.getLeaf(false);
  await leaf.openFile(file, { active: true });
  if (from !== undefined && leaf.view instanceof MarkdownView) {
    const editor = leaf.view.editor, end = Math.min(editor.getValue().length, to ?? from);
    const start = editor.offsetToPos(Math.min(from, end)), finish = editor.offsetToPos(end);
    editor.setSelection(start, finish); editor.scrollIntoView({ from: start, to: finish }, true);
  }
}

export class ChangesView extends ItemView {
  private stop?: () => void;
  constructor(leaf: WorkspaceLeaf, readonly journal: Journal) { super(leaf); }
  getViewType() { return CHANGES_VIEW_TYPE; }
  getDisplayText() { return 'AI Changes'; }
  getIcon() { return 'git-pull-request'; }
  async onOpen() {
    this.contentEl.addClass('wikiship-view');
    this.stop = this.journal.subscribe(() => this.render()); this.render();
  }
  async onClose() { this.stop?.(); }
  private render() {
    const root = this.contentEl; root.empty();
    root.createEl('h4', { text: 'AI Changes' });
    const all = this.journal.state.operations;
    if (all.some(op => ['prepared', 'uncertain', 'reverting', 'committing-delete'].includes(op.status))) {
      root.createEl('p', { cls: 'wikiship-warning', text: 'An interrupted operation needs recovery before changes can be undone or cleared.' });
      action(root, 'Recover interrupted operations', () => this.journal.recover());
    }
    if (!all.length) {
      root.createEl('p', { cls: 'wikiship-muted', text: 'Changes made through WikiShip appear here. Your ordinary edits are never labeled as AI changes.' }); return;
    }
    root.createEl('div', { cls: 'wikiship-pending-banner', text: `${all.length} change${all.length === 1 ? '' : 's'} awaiting review. They stay here until you undo them or mark them done and clear them.` });
    const tools = root.createDiv('wikiship-actions');
    action(tools, 'Next change', () => nextChange(this.app, this.journal));
    action(tools, 'Undo all changes', async () => {
      const result = await this.journal.undoAll(); new Notice(`Undid ${result.undone} change(s). Review data cleared.`);
    }, 'mod-warning');
    action(tools, 'Mark all done & clear', async () => {
      const deletes = all.filter(op => op.kind === 'delete' && op.status === 'pending-delete').length;
      const result = await this.journal.completeAll();
      new Notice(`Cleared ${result.cleared} change(s)${deletes ? `; moved ${deletes} file(s) to Obsidian trash` : ''}.`);
    }, 'mod-cta');
    const groups = new Map<string | undefined, Operation[]>();
    for (const op of [...all].reverse()) {
      const group = groups.get(op.session) ?? [];
      group.push(op); groups.set(op.session, group);
    }
    for (const [session, operations] of groups) {
      const section = root.createDiv('wikiship-session-group');
      const title = session || 'Unlabelled session';
      section.createEl('h5', { text: `${title} · ${operations.length} change(s)`, cls: 'wikiship-path' });
      const sessionActions = section.createDiv('wikiship-actions');
      action(sessionActions, 'Undo session', async () => {
        const result = await this.journal.undoSession(session); new Notice(`Undid ${result.undone} change(s). Review data cleared.`);
      }, 'mod-warning');
      action(sessionActions, 'Mark session done & clear', async () => {
        const deletes = operations.filter(op => op.kind === 'delete' && op.status === 'pending-delete').length;
        const result = await this.journal.completeSession(session);
        new Notice(`Cleared ${result.cleared} change(s)${deletes ? `; moved ${deletes} file(s) to Obsidian trash` : ''}.`);
      }, 'mod-cta');
      const byPath = new Map<string, Operation[]>();
      for (const op of operations) {
        const path = op.target ?? op.path, changes = byPath.get(path) ?? [];
        changes.push(op); byPath.set(path, changes);
      }
      for (const [path, changes] of byPath) {
        const file = section.createDiv('wikiship-file-group');
        file.createEl('h6', { text: path, cls: 'wikiship-path' });
        for (const op of changes) this.row(file, op);
      }
    }
  }
  private row(parent: HTMLElement, op: Operation) {
    const row = parent.createDiv('wikiship-change-item');
    action(row, operationLabel(op), () => new ChangeModal(this.app, this.journal, op.id).open(), 'wikiship-text-button');
    row.createSpan({ cls: `wikiship-status wikiship-status-${op.status}`, text: op.status === 'pending-delete' ? 'Awaiting deletion approval' : op.status });
    action(row, 'Undo', async () => { await this.journal.undo(op.id); new Notice('Change undone and review data cleared.'); }, 'wikiship-text-button wikiship-muted');
    row.createEl('div', { cls: 'wikiship-muted wikiship-change-time', text: `${new Date(op.timestamp).toLocaleString()}${op.agent ? ` · ${op.agent}` : ''}` });
    if (op.error) row.createEl('p', { cls: 'wikiship-warning', text: op.error });
  }
}

function snapshotPanel(parent: HTMLElement, label: string, snapshot: Snapshot | null) {
  const panel = parent.createDiv('wikiship-snapshot');
  panel.dataset.wikishipSnapshot = label.toLowerCase();
  panel.createEl('h5', { text: label });
  if (!snapshot) { panel.createEl('p', { cls: 'wikiship-muted', text: label === 'After approval' ? 'File moves to Obsidian trash when approved' : 'File does not exist' }); return; }
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

export class ChangeModal extends Modal {
  private stop?: () => void;
  constructor(app: App, readonly journal: Journal, readonly operationId: string) { super(app); }
  onOpen() {
    this.modalEl.addClass('wikiship-review-modal');
    this.stop = this.journal.subscribe(() => this.renderChange()); this.renderChange();
  }
  onClose() { this.stop?.(); this.contentEl.empty(); }
  private renderChange() {
    const op = this.journal.state.operations.find(candidate => candidate.id === this.operationId);
    const root = this.contentEl; root.empty();
    this.titleEl.setText('Review AI change');
    if (!op) { root.createEl('p', { text: 'This operation is no longer available.' }); return; }
    root.createEl('p', { cls: 'wikiship-path', text: op.kind === 'move' ? `${op.path} → ${op.target}` : op.path });
    root.createEl('p', { cls: 'wikiship-muted', text: `${operationLabel(op)} · ${op.status === 'pending-delete' ? 'Awaiting your deletion approval' : op.status}` });
    root.createEl('p', { cls: 'wikiship-muted', text: `${new Date(op.timestamp).toLocaleString()}${op.agent ? ` · Agent: ${op.agent}` : ''}${op.session ? ` · Session: ${op.session}` : ''}` });
    if (op.error) root.createEl('p', { cls: 'wikiship-warning', text: op.error });
    if (op.status === 'pending-delete') root.createEl('p', { cls: 'wikiship-delete-notice', text: 'The file is still in your vault. Marking this session done moves it to Obsidian trash. Undoing this change cancels the deletion.' });
    const actions = root.createDiv('wikiship-actions');
    action(actions, 'Undo this change', async () => { await this.journal.undo(op.id); new Notice('Change undone and review data cleared.'); this.close(); }, 'mod-warning');
    action(actions, 'Mark session done & clear', async () => {
      const result = await this.journal.completeSession(op.session);
      new Notice(`Cleared ${result.cleared} change(s)${op.kind === 'delete' ? '; moved the file to Obsidian trash' : ''}.`); this.close();
    }, 'mod-cta');
    action(actions, 'Next change', async () => { this.close(); await nextChange(this.app, this.journal, op.id); });
    const path = op.target ?? op.path;
    if (this.app.vault.getFileByPath(path)) action(actions, 'Open file', () => openLocation(this.app, path));
    const before = op.before?.encoding === 'utf8' ? op.before.data : op.before ? null : '';
    const after = op.after?.encoding === 'utf8' ? op.after.data : op.after ? null : '';
    let expandSnapshots = before === null || after === null;
    if (before !== null && after !== null && before !== after && before.length + after.length > 400_000) {
      root.createEl('p', { cls: 'wikiship-muted', text: 'This change is too large for an inline diff. Compare the recorded file contents below; use the page controls to inspect any part.' });
      expandSnapshots = true;
    }
    if (before !== null && after !== null && before !== after && before.length + after.length <= 400_000) {
      root.createEl('h5', { text: 'Recorded diff' });
      const diff = root.createEl('pre', { cls: 'wikiship-diff' });
      const parts = diffLines(before, after, { timeout: 1000 });
      if (parts) for (const part of parts) {
        const type = part.added ? 'added' : part.removed ? 'removed' : 'unchanged';
        // Render literal text only: note contents must never execute HTML or scripts.
        const lines = part.value.split('\n');
        if (lines.at(-1) === '') lines.pop();
        const visible = type === 'unchanged' && lines.length > 8 ? [...lines.slice(0, 3), `… ${lines.length - 6} unchanged lines …`, ...lines.slice(-3)] : lines;
        for (const line of visible) diff.createSpan({ cls: `wikiship-diff-${type}`, text: `${part.added ? '+' : part.removed ? '−' : ' '} ${line}` });
      } else { diff.setText('Diff calculation reached its time limit. Compare the recorded file contents below.'); expandSnapshots = true; }
    }
    const snapshots = root.createEl('details', { cls: 'wikiship-snapshots' });
    snapshots.open = expandSnapshots;
    snapshots.createEl('summary', { text: 'Before and after' });
    const columns = snapshots.createDiv('wikiship-snapshot-columns');
    snapshotPanel(columns, 'Before', op.before);
    snapshotPanel(columns, op.kind === 'delete' && op.status === 'pending-delete' ? 'After approval' : 'After', op.after);
    root.createEl('p', { cls: 'wikiship-muted', text: 'WikiShip keeps these change records only until you undo them or mark them done and clear them. Once cleared, WikiShip cannot restore them.' });
    root.createEl('div', { cls: 'wikiship-hash', text: `Operation ${op.id}` });
  }
}

const lastInspected = new WeakMap<Journal, string>();

export async function nextChange(app: App, journal: Journal, afterId?: string): Promise<void> {
  const all = journal.state.operations;
  const pending = all.filter(op => !['reverted'].includes(op.status));
  if (!pending.length) { new Notice('No AI changes are awaiting review.'); return; }
  const at = all.findIndex(op => op.id === (afterId ?? lastInspected.get(journal)));
  const next = pending.find(op => all.indexOf(op) > at) ?? pending[0]!;
  lastInspected.set(journal, next.id);
  const path = next.target ?? next.path;
  const file = app.vault.getFileByPath(path);
  if (file) {
    const current = await journal.files.read(path);
    const location = next.kind !== 'delete' && current?.encoding === 'utf8' ? locationsForFile(all, path, current.data).find(loc => loc.operationId === next.id) : undefined;
    await openLocation(app, path, location?.from, location?.to);
  }
  new ChangeModal(app, journal, next.id).open();
}
