import { FileSystemAdapter, MarkdownView, Notice, Plugin, PluginSettingTab, Setting, TFile, type App, type EventRef } from 'obsidian';
import { getAPI, type LocalRestApiPublicApi } from 'obsidian-local-rest-api';
import { realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { Journal } from './provenance/journal';
import { trackJournalShutdown, waitForJournalShutdown } from './provenance/lifecycle';
import { AtomicStateStore, DEFAULT_EXCLUSIONS, PathPolicy } from './provenance/storage';
import { ObsidianFiles } from './provenance/obsidian-files';
import { EditorContext } from './context/editor';
import { ChangesView, ChangeModal, ContextView, RevertFileModal, CHANGES_VIEW_TYPE, CONTEXT_VIEW_TYPE, nextUnreviewed } from './review/views';
import { createReviewExtension } from './review/gutter';
import { registerTools } from './mcp/tools';
import { codexDeepLink, handoffPrompt } from './integrations/chatgpt/launch';

interface Settings { exclusions: string[]; }

export default class WikiShip extends Plugin {
  journal!: Journal;
  context!: EditorContext;
  private store?: AtomicStateStore;
  private api?: LocalRestApiPublicApi;
  private stopped = false;
  private loading: Promise<void> = Promise.resolve();
  private root = '';
  private connection?: HTMLElement;
  settings: Settings = { exclusions: [...DEFAULT_EXCLUSIONS] };

  onload() { return this.loading = this.start(); }
  private async start() {
    try {
      const saved = await this.loadData() as Partial<Settings> | null;
      if (Array.isArray(saved?.exclusions) && saved.exclusions.every(e => typeof e === 'string' && e && !e.includes('/'))) this.settings.exclusions = saved.exclusions;
      const adapter = this.app.vault.adapter;
      if (!(adapter instanceof FileSystemAdapter)) throw new Error('WikiShip v1 requires a local desktop vault.');
      this.root = await realpath(adapter.getBasePath());
      if (this.stopped) return;
      this.store = new AtomicStateStore(join(this.root, this.app.vault.configDir, 'plugins', this.manifest.id), this.root);
      await waitForJournalShutdown(this.store.directory);
      if (this.stopped) return;
      await this.store.open();
      if (this.stopped) return;
      const files = new ObsidianFiles(this.app, new PathPolicy(this.root, this.app.vault.configDir, this.settings.exclusions));
      this.journal = new Journal(this.store, files);
      await this.journal.load();
      if (this.stopped) return;
      this.context = new EditorContext(this.app, this.journal, path => files.readContext(path));
      this.register(() => this.context.dispose());
      this.registerView(CONTEXT_VIEW_TYPE, leaf => new ContextView(leaf, this.context, this.journal));
      this.registerView(CHANGES_VIEW_TYPE, leaf => new ChangesView(leaf, this.journal));
      const gutter = createReviewExtension(this.journal, id => new ChangeModal(this.app, this.journal, id).open());
      this.registerEditorExtension(gutter.extension);
      this.register(gutter.destroy);
      this.connection = this.addStatusBarItem();
      this.addRibbonIcon('pin', 'WikiShip context', () => this.run(() => this.openView(CONTEXT_VIEW_TYPE)));
      this.addCommands();
      this.addSettingTab(new WikiShipSettings(this.app, this));
      this.registerEvent(this.app.workspace.on('editor-menu', (menu, editor, info) => {
        if (!info.file) return;
        if (editor.somethingSelected()) menu.addItem(item => item.setTitle('Add selection to WikiShip context').setIcon('pin').onClick(() => this.run(() => this.context.addSelection())));
        menu.addItem(item => item.setTitle('Add current section to WikiShip context').setIcon('heading').onClick(() => this.run(() => this.context.addSection())));
        menu.addItem(item => item.setTitle('Add current note to WikiShip context').setIcon('file-text').onClick(() => this.run(() => this.context.addNote(info.file!.path))));
      }));
      this.registerEvent(this.app.workspace.on('file-menu', (menu, file) => {
        if (!(file instanceof TFile)) return;
        menu.addItem(item => item.setTitle('Add file to WikiShip context').setIcon('pin').onClick(() => this.run(() => this.context.addNote(file.path))));
      }));
      this.registerEvent(this.app.vault.on('rename', (file, oldPath) => this.run(() => this.journal.renameContext(oldPath, file.path))));
      this.registerEvent(this.app.workspace.on('obsidian-local-rest-api:loaded', () => this.connectMcp()));
      this.app.workspace.onLayoutReady(() => {
        if (this.stopped) return;
        this.connectMcp();
        if (this.journal.state.context.length) this.run(() => this.openView(CONTEXT_VIEW_TYPE));
      });
    } catch (error) {
      new Notice(`WikiShip could not start: ${message(error)}`, 15000);
      await this.journal?.close();
      await this.store?.close();
      throw error;
    }
  }
  run(task: () => Promise<unknown> | unknown) {
    if (this.stopped) return;
    void Promise.resolve().then(task).catch(error => new Notice(`WikiShip: ${message(error)}`, 9000));
  }
  private addCommands() {
    this.addCommand({ id: 'open-context', name: 'Show context', callback: () => this.run(() => this.openView(CONTEXT_VIEW_TYPE)) });
    this.addCommand({ id: 'open-changes', name: 'Show AI Changes', callback: () => this.run(() => this.openView(CHANGES_VIEW_TYPE)) });
    for (const [kind, name] of [['selection', 'selection'], ['section', 'current section'], ['note', 'current note']] as const) {
      this.addCommand({ id: `add-${kind}`, name: `Add ${name} to WikiShip context`, checkCallback: checking => {
        const view = this.app.workspace.getActiveViewOfType(MarkdownView);
        const available = !!view?.file && (kind !== 'selection' || (view.getMode() === 'source' && view.editor.somethingSelected()));
        if (!checking && available) this.run(async () => {
          if (kind === 'selection') await this.context.addSelection();
          else if (kind === 'section') await this.context.addSection();
          else await this.context.addNote();
          await this.openView(CONTEXT_VIEW_TYPE);
        });
        return available;
      } });
    }
    this.addCommand({ id: 'remove-context', name: 'Remove current file from WikiShip context', callback: () => this.run(async () => {
      const path = this.app.workspace.getActiveFile()?.path;
      for (const item of this.journal.state.context.filter(item => item.path === path)) await this.journal.removeContext(item.id);
    }) });
    this.addCommand({ id: 'clear-context', name: 'Clear WikiShip context', callback: () => this.run(() => this.journal.removeContext()) });
    this.addCommand({ id: 'next-change', name: 'Next unreviewed AI change', callback: () => this.run(() => nextUnreviewed(this.app, this.journal)) });
    this.addCommand({ id: 'mark-all-reviewed', name: 'Mark all AI changes reviewed', callback: () => this.run(() => this.journal.markReviewed()) });
    this.addCommand({ id: 'revert-file', name: 'Revert all AI changes in current file', callback: () => this.run(async () => {
      const path = this.app.workspace.getActiveFile()?.path;
      if (!path) throw new Error('Open a file first.');
      new RevertFileModal(this.app, this.journal, path).open();
    }) });
    this.addCommand({ id: 'recover', name: 'Recover interrupted operations', callback: () => this.run(() => this.journal.recover()) });
    this.addCommand({ id: 'reconnect-mcp', name: 'Reconnect Local REST API', callback: () => this.connectMcp() });
    this.addCommand({ id: 'ask-chatgpt', name: 'Ask ChatGPT / Open in Codex', callback: () => this.run(() => this.launch()) });
    this.addCommand({ id: 'copy-prompt', name: 'Copy agent handoff prompt', callback: () => this.run(async () => {
      await navigator.clipboard.writeText(handoffPrompt(this.launchContext()));
      new Notice('WikiShip handoff prompt copied.');
    }) });
  }
  private launchContext() { return { path: this.root, vaultName: this.app.vault.getName(), itemIds: this.journal.state.context.map(i => i.id) }; }
  private async launch() {
    const url = codexDeepLink(this.launchContext());
    const { shell } = require('electron') as { shell: { openExternal(url: string): Promise<void> } };
    await shell.openExternal(url);
  }
  private connectMcp() {
    if (this.stopped || !this.journal) return;
    this.api?.unregister(); this.api = undefined;
    try {
      this.api = getAPI(this.app, this.manifest, 3);
      if (this.api) registerTools(this.api, this.context, this.journal);
      this.connection?.setText(this.api ? 'WikiShip · MCP ready' : 'WikiShip · enable Local REST API');
    } catch (error) {
      this.api?.unregister(); this.api = undefined;
      this.connection?.setText('WikiShip · MCP unavailable');
      new Notice(`WikiShip MCP: ${message(error)}`, 10000);
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
    void pending.catch(error => console.error('WikiShip could not close its journal', error));
  }
}
function message(error: unknown) { return error instanceof Error ? error.message : String(error); }

class WikiShipSettings extends PluginSettingTab {
  constructor(app: App, private plugin: WikiShip) { super(app, plugin); }
  display() {
    this.containerEl.empty();
    this.containerEl.createEl('h2', { text: 'WikiShip' });
    this.containerEl.createEl('p', { text: 'Connect through Local REST API 5.3.0 or later. Use the WikiShip MCP bridge to restrict agents to tracked mutations. Context and complete change snapshots stay in this vault’s WikiShip plugin directory.' });
    new Setting(this.containerEl).setName('Excluded directory names').setDesc('One name per line. Applies only to WikiShip reads and writes. Obsidian settings are unchanged. Reload WikiShip after editing.').addTextArea(input => input.setValue(this.plugin.settings.exclusions.join('\n')).onChange(async value => {
      const exclusions = value.split('\n').map(line => line.trim()).filter(Boolean);
      if (exclusions.some(name => name.includes('/') || name.includes('\\') || name === '.' || name === '..')) return;
      this.plugin.settings = { exclusions }; await this.plugin.saveData(this.plugin.settings);
    }));
  }
}

declare module 'obsidian' {
  interface Workspace { on(name: 'obsidian-local-rest-api:loaded', callback: () => void, ctx?: unknown): EventRef; }
}
