import { ItemView, MarkdownView, Modal, Notice, type App, type WorkspaceLeaf } from 'obsidian';
import { diffLines } from 'diff';
import type { EditorContext } from '../context/editor';
import type { ResolvedContext } from '../context/references';
import type { Operation, Snapshot } from '../model';
import type { Journal } from '../provenance/journal';
import { locationsForFile, operationLabel } from './changes';
import { snapshotPage } from './paging';
import { WIKISHIP_ICON_ID } from '../icon';

export const CONTEXT_VIEW_TYPE = 'wikiship-context';
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

export class ContextView extends ItemView {
  private stop?: () => void;
  private timer?: ReturnType<typeof setTimeout>;
  private generation = 0;
  private opened = false;
  constructor(leaf: WorkspaceLeaf, readonly context: EditorContext, readonly journal: Journal) { super(leaf); }
  getViewType() { return CONTEXT_VIEW_TYPE; }
  getDisplayText() { return 'WikiShip context'; }
  getIcon() { return WIKISHIP_ICON_ID; }
  async onOpen() {
    this.opened = true;
    this.contentEl.addClass('wikiship-view');
    this.stop = this.context.subscribe(() => {
      if (this.timer) clearTimeout(this.timer);
      this.timer = setTimeout(() => { void this.render(); }, 180);
    });
    await this.render();
  }
  async onClose() {
    this.opened = false; this.generation++; this.stop?.();
    if (this.timer) clearTimeout(this.timer);
  }
  private async render() {
    const generation = ++this.generation;
    const items = await this.context.getContext();
    if (!this.opened || generation !== this.generation) return;
    const root = this.contentEl; root.empty();
    root.createEl('h4', { text: 'WikiShip context' });
    const tools = root.createDiv('wikiship-actions');
    action(tools, 'Selection', () => this.context.addSelection());
    action(tools, 'Section', () => this.context.addSection());
    action(tools, 'Note', () => this.context.addNote());
    if (!items.length) {
      root.createEl('p', { cls: 'wikiship-muted', text: 'Select text or place your cursor in a section, then pin it here. Your context stays with you as you switch notes.' });
      return;
    }
    root.createEl('p', { cls: 'wikiship-muted', text: `${items.length} pinned ${items.length === 1 ? 'item' : 'items'} · current content is shared with agents` });
    const groups = new Map<string, ResolvedContext[]>();
    for (const item of items) { const group = groups.get(item.path) ?? []; group.push(item); groups.set(item.path, group); }
    for (const [path, group] of groups) {
      const section = root.createDiv('wikiship-file-group');
      section.createEl('h5', { text: path, cls: 'wikiship-path' });
      for (const item of group) {
        const row = section.createDiv('wikiship-context-item');
        const label = item.kind === 'note' ? 'Entire note / file' : item.kind === 'section' ? `§ ${item.headingPath?.join(' › ')}` : 'Selected text';
        action(row, label, () => openLocation(this.app, path, item.status === 'stale' ? undefined : item.from, item.to), 'wikiship-text-button');
        row.createSpan({ cls: `wikiship-status wikiship-status-${item.status}`, text: item.status });
        if (item.reason) row.createEl('p', { text: item.reason, cls: 'wikiship-muted' });
        else if (item.content) row.createEl('p', { cls: 'wikiship-context-preview', text: item.content.replace(/\s+/g, ' ').slice(0, 140) });
        action(row, 'Remove', () => this.journal.removeContext(item.id), 'wikiship-text-button wikiship-muted');
      }
    }
    action(root, 'Clear context', () => this.journal.removeContext(), 'wikiship-clear');
  }
}

export class RevertFileModal extends Modal {
  constructor(app: App, private journal: Journal, private path: string) { super(app); }
  onOpen() {
    this.titleEl.setText('Revert AI changes in this file');
    this.contentEl.createEl('p', { text: `Revert the recorded AI changes associated with ${this.path}, including reviewed changes and changes made under previous filenames?` });
    this.contentEl.createEl('p', { cls: 'wikiship-muted', text: 'Changes are reverted newest first. Reverting a creation removes the file; reverting a deletion restores it. Revert stops if a newer edit conflicts.' });
    const buttons = this.contentEl.createDiv('wikiship-actions');
    action(buttons, 'Cancel', () => this.close());
    action(buttons, 'Revert changes', async () => {
      const result = await this.journal.revertFile(this.path);
      new Notice(`Reverted ${result.reverted} AI changes.`); this.close();
    }, 'mod-warning');
  }
  onClose() { this.contentEl.empty(); }
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
    const unreviewed = all.filter(op => op.status === 'applied' && op.review === 'unreviewed');
    const tools = root.createDiv('wikiship-actions');
    action(tools, 'Next unreviewed', () => nextUnreviewed(this.app, this.journal)).disabled = !unreviewed.length;
    action(tools, 'Mark all reviewed', () => this.journal.markReviewed()).disabled = !unreviewed.length;
    if (all.some(op => ['prepared', 'uncertain', 'reverting'].includes(op.status))) {
      root.createEl('p', { cls: 'wikiship-warning', text: 'An interrupted operation needs recovery. Inspect its recorded states before making further AI changes.' });
      action(root, 'Recover interrupted operations', () => this.journal.recover());
    }
    if (!all.length) {
      root.createEl('p', { cls: 'wikiship-muted', text: 'Changes made through WikiShip appear here. Your ordinary edits are never labeled as AI changes.' }); return;
    }
    root.createEl('p', { cls: 'wikiship-muted', text: `${unreviewed.length} unreviewed · click a change to inspect before and after` });
    const groups = new Map<string, Operation[]>();
    for (const op of [...all].reverse()) {
      const path = op.target ?? op.path, group = groups.get(path) ?? [];
      group.push(op); groups.set(path, group);
    }
    for (const [path, operations] of groups) {
      const section = root.createDiv('wikiship-file-group');
      section.createEl('h5', { text: path, cls: 'wikiship-path' });
      if (operations.some(op => op.status === 'applied')) action(section, 'Revert all in file…', () => new RevertFileModal(this.app, this.journal, path).open(), 'wikiship-text-button wikiship-muted');
      const pending = operations.filter(op => op.status !== 'reverted' && op.review === 'unreviewed');
      const history = operations.filter(op => op.status === 'reverted' || op.review === 'reviewed');
      for (const op of pending) this.row(section, op);
      if (history.length) {
        const details = section.createEl('details', { cls: 'wikiship-history' });
        details.createEl('summary', { text: `Reviewed / reverted (${history.length})` });
        for (const op of history) this.row(details, op);
      }
    }
  }
  private row(parent: HTMLElement, op: Operation) {
    const row = parent.createDiv('wikiship-change-item');
    action(row, operationLabel(op), () => new ChangeModal(this.app, this.journal, op.id).open(), 'wikiship-text-button');
    row.createSpan({ cls: `wikiship-status wikiship-status-${op.status}`, text: op.status === 'applied' ? op.review : op.status });
    row.createEl('div', { cls: 'wikiship-muted wikiship-change-time', text: `${new Date(op.timestamp).toLocaleString()}${op.agent ? ` · ${op.agent}` : ''}` });
    if (op.error) row.createEl('p', { cls: 'wikiship-warning', text: op.error });
  }
}

function snapshotPanel(parent: HTMLElement, label: string, snapshot: Snapshot | null) {
  const panel = parent.createDiv('wikiship-snapshot');
  panel.dataset.wikishipSnapshot = label.toLowerCase();
  panel.createEl('h5', { text: label });
  if (!snapshot) { panel.createEl('p', { cls: 'wikiship-muted', text: 'File does not exist' }); return; }
  if (snapshot.encoding === 'base64') {
    panel.createEl('p', { cls: 'wikiship-muted', text: `Binary file · ${snapshot.size.toLocaleString()} bytes · full content preserved for revert` });
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
    root.createEl('p', { cls: 'wikiship-muted', text: `${operationLabel(op)} · ${op.status} · ${op.review}` });
    root.createEl('p', { cls: 'wikiship-muted', text: `${new Date(op.timestamp).toLocaleString()}${op.agent ? ` · Agent: ${op.agent}` : ''}${op.session ? ` · Session: ${op.session}` : ''}` });
    if (op.error) root.createEl('p', { cls: 'wikiship-warning', text: op.error });
    const actions = root.createDiv('wikiship-actions');
    if (op.status === 'applied') {
      if (op.review !== 'reviewed') action(actions, 'Mark reviewed', () => this.journal.markReviewed(op.id), 'mod-cta');
      action(actions, 'Revert this change', async () => { await this.journal.revert(op.id); new Notice('AI change reverted.'); });
    }
    action(actions, 'Next unreviewed', async () => { this.close(); await nextUnreviewed(this.app, this.journal, op.id); });
    const path = op.target ?? op.path;
    if (this.app.vault.getFileByPath(path)) action(actions, 'Open file', () => openLocation(this.app, path));
    const before = op.before?.encoding === 'utf8' ? op.before.data : op.before ? null : '';
    const after = op.after?.encoding === 'utf8' ? op.after.data : op.after ? null : '';
    let expandSnapshots = before === null || after === null;
    if (before !== null && after !== null && before !== after && before.length + after.length > 400_000) {
      root.createEl('p', { cls: 'wikiship-muted', text: 'This change is too large for an inline diff. Compare the complete recorded snapshots below; use the page controls to inspect any part of the file.' });
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
      } else { diff.setText('Diff calculation reached its time limit. Compare the recorded snapshots below.'); expandSnapshots = true; }
    }
    const snapshots = root.createEl('details', { cls: 'wikiship-snapshots' });
    snapshots.open = expandSnapshots;
    snapshots.createEl('summary', { text: 'Before and after snapshots' });
    const columns = snapshots.createDiv('wikiship-snapshot-columns');
    snapshotPanel(columns, 'Before', op.before); snapshotPanel(columns, 'After', op.after);
    root.createEl('p', { cls: 'wikiship-muted', text: 'These are the recorded states at the time of the AI change. Reverting checks the current file and stops if it has changed since.' });
    root.createEl('div', { cls: 'wikiship-hash', text: `Operation ${op.id}` });
  }
}

const lastInspected = new WeakMap<Journal, string>();

export async function nextUnreviewed(app: App, journal: Journal, afterId?: string): Promise<void> {
  const all = journal.state.operations;
  const pending = all.filter(op => op.status === 'applied' && op.review === 'unreviewed');
  if (!pending.length) { new Notice('No unreviewed AI changes.'); return; }
  const at = all.findIndex(op => op.id === (afterId ?? lastInspected.get(journal)));
  const next = pending.find(op => all.indexOf(op) > at) ?? pending[0]!;
  lastInspected.set(journal, next.id);
  const path = next.target ?? next.path;
  const file = app.vault.getFileByPath(path);
  if (file) {
    const current = await journal.files.read(path);
    const location = current?.encoding === 'utf8' ? locationsForFile(all, path, current.data).find(loc => loc.operationId === next.id) : undefined;
    await openLocation(app, path, location?.from, location?.to);
  }
  new ChangeModal(app, journal, next.id).open();
}
