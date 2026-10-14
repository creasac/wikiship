import { FileSystemAdapter, Notice, Plugin, PluginSettingTab, Setting, type App, type EventRef } from 'obsidian';
import { getAPI, type LocalRestApiPublicApi } from 'obsidian-local-rest-api';
import { realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { Journal } from './provenance/journal';
import { registerwikishipIcon, wikishipIconId } from './icon';
import { trackJournalShutdown, waitForJournalShutdown } from './provenance/lifecycle';
import { AtomicStateStore, DEFAULT_EXCLUSIONS, PathPolicy } from './provenance/storage';
import { ObsidianFiles } from './provenance/obsidian-files';
import { EditorContext } from './context/editor';
import { ChangesView, FileReviewModal, CHANGES_VIEW_TYPE, nextChange } from './review/views';
import { createReviewExtension } from './review/gutter';
import { registerTools } from './mcp/tools';

interface Settings { exclusions: string[]; }

export default class wikiship extends Plugin {
  journal!: Journal;
  context!: EditorContext;
  private store?: AtomicStateStore;
  private api?: LocalRestApiPublicApi;
  private stopped = false;
  private loading: Promise<void> = Promise.resolve();
  private connection?: HTMLElement;
  settings: Settings = { exclusions: [...DEFAULT_EXCLUSIONS] };

  onload() { return this.loading = this.start(); }
  private async start() {
    try {
      const saved = await this.loadData() as Partial<Settings> | null;
      if (Array.isArray(saved?.exclusions) && saved.exclusions.every(e => typeof e === 'string' && e && !e.includes('/'))) this.settings.exclusions = saved.exclusions;
      const adapter = this.app.vault.adapter;
      if (!(adapter instanceof FileSystemAdapter)) throw new Error('wikiship v1 requires a local desktop vault.');
      const root = await realpath(adapter.getBasePath());
      if (this.stopped) return;
      this.store = new AtomicStateStore(join(root, this.app.vault.configDir, 'plugins', this.manifest.id), root);
      await waitForJournalShutdown(this.store.directory);
      if (this.stopped) return;
      await this.store.open();
      if (this.stopped) return;
      const files = new ObsidianFiles(this.app, new PathPolicy(root, this.app.vault.configDir, this.settings.exclusions));
      this.journal = new Journal(this.store, files);
      await this.journal.load();
      if (this.stopped) return;
      this.context = new EditorContext(this.app, path => files.readContext(path));
      registerwikishipIcon();
      this.registerView(CHANGES_VIEW_TYPE, leaf => new ChangesView(leaf, this.journal));
      const gutter = createReviewExtension(this.journal, id => new FileReviewModal(this.app, this.journal, id).open());
      this.registerEditorExtension(gutter.extension);
      this.register(gutter.destroy);
      this.connection = this.addStatusBarItem();
      this.connection.addClass('wikiship-statusbar');
      this.connection.setAttribute('role', 'button');
      this.connection.setAttribute('tabindex', '0');
      this.connection.addEventListener('click', () => this.run(() => this.openView(CHANGES_VIEW_TYPE)));
      this.connection.addEventListener('keydown', event => {
        if (event instanceof KeyboardEvent && (event.key === 'Enter' || event.key === ' ')) {
          event.preventDefault(); this.run(() => this.openView(CHANGES_VIEW_TYPE));
        }
      });
      this.connection.setAttribute('aria-label', 'Open wikiship');
      const reviewable = () => this.journal.state.operations.some(op => !['prepared', 'committing-delete'].includes(op.status));
      let hasReviewableChanges = reviewable();
      if (hasReviewableChanges) this.run(() => this.openView(CHANGES_VIEW_TYPE));
      this.register(this.journal.subscribe(() => {
        const count = this.journal.state.operations.length;
        const hasReviewable = reviewable();
        // Do not steal editor focus while a guarded mutation is between its
        // write-ahead save and its final editor-target check.
        if (hasReviewable && !hasReviewableChanges) this.run(() => this.openView(CHANGES_VIEW_TYPE));
        hasReviewableChanges = hasReviewable;
        this.connection?.setText(count ? `wikiship · ${count} change${count === 1 ? '' : 's'} · review` : this.api ? 'wikiship · MCP ready' : 'wikiship · enable Local REST API');
      }));
      this.addRibbonIcon(wikishipIconId, 'wikiship', () => this.run(() => this.openView(CHANGES_VIEW_TYPE)));
      this.addCommands();
      this.addSettingTab(new wikishipSettings(this.app, this));
      this.registerEvent(this.app.workspace.on('obsidian-local-rest-api:loaded', () => this.connectMcp()));
      this.app.workspace.onLayoutReady(() => {
        if (this.stopped) return;
        this.connectMcp();
      });
    } catch (error) {
      new Notice(`wikiship could not start: ${message(error)}`, 15000);
      await this.journal?.close();
      await this.store?.close();
      throw error;
    }
  }
  run(task: () => Promise<unknown> | unknown) {
    if (this.stopped) return;
    void Promise.resolve().then(task).catch(error => new Notice(`wikiship: ${message(error)}`, 9000));
  }
  private addCommands() {
    this.addCommand({ id: 'open-changes', name: "Show machine minds' changes", callback: () => this.run(() => this.openView(CHANGES_VIEW_TYPE)) });
    this.addCommand({ id: 'next-change', name: 'Review next file', callback: () => this.run(() => nextChange(this.app, this.journal)) });
    this.addCommand({ id: 'complete-changes', name: 'Approve all changes', callback: () => this.run(() => this.journal.completeAll()) });
    this.addCommand({ id: 'undo-changes', name: "Undo all machine minds' changes", callback: () => this.run(() => this.journal.undoAll()) });
    this.addCommand({ id: 'recover', name: 'Recover interrupted operations', callback: () => this.run(() => this.journal.recover()) });
    this.addCommand({ id: 'reconnect-mcp', name: 'Reconnect Local REST API', callback: () => this.connectMcp() });
  }
  private connectMcp() {
    if (this.stopped || !this.journal) return;
    this.api?.unregister(); this.api = undefined;
    try {
      this.api = getAPI(this.app, this.manifest, 3);
      if (this.api) registerTools(this.api, this.context, this.journal);
      const pending = this.journal.state.operations.length;
      this.connection?.setText(pending ? `wikiship · ${pending} change${pending === 1 ? '' : 's'} · review` : this.api ? 'wikiship · MCP ready' : 'wikiship · enable Local REST API');
    } catch (error) {
      this.api?.unregister(); this.api = undefined;
      this.connection?.setText('wikiship · MCP unavailable');
      new Notice(`wikiship MCP: ${message(error)}`, 10000);
    }
  }
  private async openView(type: string) {
    let leaf = this.app.workspace.getLeavesOfType(type)[0];
    if (!leaf) { leaf = this.app.workspace.getRightLeaf(false) ?? undefined; if (!leaf) throw new Error('Cannot open the sidebar.'); await leaf.setViewState({ type, active: true }); }
    await this.app.workspace.revealLeaf(leaf);
  }
  onunload() {
    if (this.stopped) return;
    this.stopped = true;
    this.api?.unregister(); this.api = undefined;
    // Reject new mutations immediately. Also wait for any in-flight startup so
    // it cannot acquire a lock after cleanup; start() cancels further setup.
    const drained = this.journal?.close() ?? Promise.resolve();
    const shutdown = this.loading.catch(() => undefined).then(() => drained).then(() => this.store?.close());
    // Obsidian does not await this synchronous hook. Publish cleanup before it
    // returns so a replacement instance waits before attempting the writer lock.
    const pending = this.store ? trackJournalShutdown(this.store.directory, shutdown) : shutdown;
    void pending.catch(error => console.error('wikiship could not close its journal', error));
  }
}
function message(error: unknown) { return error instanceof Error ? error.message : String(error); }

class wikishipSettings extends PluginSettingTab {
  constructor(app: App, private plugin: wikiship) { super(app, plugin); }
  display() {
    this.containerEl.empty();
    this.containerEl.createEl('h2', { text: 'wikiship' });
    this.containerEl.createEl('p', { text: 'Connect through Local REST API 5.3.0 or later. Use the wikiship MCP bridge to restrict agents to tracked mutations. Pending changes and their before/after content stay in this vault’s plugin data until you undo or approve them.' });
    new Setting(this.containerEl).setName('Excluded directory names').setDesc('One name per line. Applies only to wikiship reads and writes. Obsidian settings are unchanged. Reload wikiship after editing.').addTextArea(input => input.setValue(this.plugin.settings.exclusions.join('\n')).onChange(async value => {
      const exclusions = value.split('\n').map(line => line.trim()).filter(Boolean);
      if (exclusions.some(name => name.includes('/') || name.includes('\\') || name === '.' || name === '..')) return;
      this.plugin.settings = { exclusions }; await this.plugin.saveData(this.plugin.settings);
    }));
  }
}

declare module 'obsidian' {
  interface Workspace { on(name: 'obsidian-local-rest-api:loaded', callback: () => void, ctx?: unknown): EventRef; }
}
