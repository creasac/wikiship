import { randomBytes } from 'node:crypto';
import { FileSystemAdapter, Notice, Plugin, PluginSettingTab, type App, type SettingDefinitionItem } from 'obsidian';
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
import { codexConfig, DEFAULT_MCP_PORT, WikishipMcpServer } from './mcp/server';

interface Settings { exclusions: string[]; mcpToken: string; }

export default class wikiship extends Plugin {
  journal!: Journal;
  context!: EditorContext;
  private store?: AtomicStateStore;
  private mcpServer?: WikishipMcpServer;
  private stopped = false;
  private loading: Promise<void> = Promise.resolve();
  private connection?: HTMLElement;
  settings: Settings = { exclusions: [...DEFAULT_EXCLUSIONS], mcpToken: '' };

  onload() { return this.loading = this.start(); }
  private async start() {
    try {
      const saved = await this.loadData() as Partial<Settings> | null;
      if (Array.isArray(saved?.exclusions) && saved.exclusions.every(e => typeof e === 'string' && e && !e.includes('/'))) this.settings.exclusions = saved.exclusions;
      this.settings.mcpToken = typeof saved?.mcpToken === 'string' && /^[a-f0-9]{64}$/.test(saved.mcpToken)
        ? saved.mcpToken : randomBytes(32).toString('hex');
      await this.saveData(this.settings);
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
      this.register(() => gutter.destroy());
      this.connection = this.addStatusBarItem();
      this.connection.addClass('wikiship-statusbar');
      this.connection.setAttribute('role', 'button');
      this.connection.setAttribute('tabindex', '0');
      this.connection.addEventListener('click', () => this.run(() => this.openView(CHANGES_VIEW_TYPE)));
      this.connection.addEventListener('keydown', event => {
        if (event.instanceOf(KeyboardEvent) && (event.key === 'Enter' || event.key === ' ')) {
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
        this.connection?.setText(count ? `wikiship · ${count} change${count === 1 ? '' : 's'} · review` : this.mcpServer ? 'wikiship · MCP ready' : 'wikiship · MCP unavailable');
      }));
      this.addRibbonIcon(wikishipIconId, 'wikiship', () => this.run(() => this.openView(CHANGES_VIEW_TYPE)));
      this.addCommands();
      this.addSettingTab(new wikishipSettings(this.app, this));
      try {
        this.mcpServer = new WikishipMcpServer(this.app, this.context, this.journal, files.policy, DEFAULT_MCP_PORT, this.settings.mcpToken, this.manifest.version);
        await this.mcpServer.start();
        this.connection.setText(this.journal.state.operations.length ? `wikiship · ${this.journal.state.operations.length} changes · review` : 'wikiship · MCP ready');
      } catch (error) {
        this.mcpServer = undefined;
        this.connection.setText('wikiship · MCP unavailable');
        new Notice(`wikiship MCP server could not start: ${message(error)}. See Settings → wikiship for the connection details.`, 15000);
      }
    } catch (error) {
      new Notice(`wikiship could not start: ${message(error)}`, 15000);
      await this.journal?.close();
      await this.store?.close();
      throw error;
    }
  }
  run(task: () => unknown) {
    if (this.stopped) return;
    void Promise.resolve().then(task).catch(error => new Notice(`wikiship: ${message(error)}`, 9000));
  }
  private addCommands() {
    this.addCommand({ id: 'open-changes', name: "Show machine minds' changes", callback: () => this.run(() => this.openView(CHANGES_VIEW_TYPE)) });
    this.addCommand({ id: 'next-change', name: 'Review next file', callback: () => this.run(() => nextChange(this.app, this.journal)) });
    this.addCommand({ id: 'complete-changes', name: 'Approve all changes', callback: () => this.run(() => this.journal.completeAll()) });
    this.addCommand({ id: 'undo-changes', name: "Undo all machine minds' changes", callback: () => this.run(() => this.journal.undoAll()) });
    this.addCommand({ id: 'recover', name: 'Recover interrupted operations', callback: () => this.run(() => this.journal.recover()) });
    this.addCommand({ id: 'restart-mcp', name: 'Restart MCP server', callback: () => this.restartMcp() });
  }
  async restartMcpFromSettings() { return this.restartMcp(); }
  private async restartMcp() {
    if (this.stopped || !this.journal) return;
    await this.mcpServer?.close();
    try {
      const root = await realpath((this.app.vault.adapter as FileSystemAdapter).getBasePath());
      this.mcpServer = new WikishipMcpServer(this.app, this.context, this.journal,
        new PathPolicy(root, this.app.vault.configDir, this.settings.exclusions), DEFAULT_MCP_PORT, this.settings.mcpToken, this.manifest.version);
      await this.mcpServer.start();
      this.connection?.setText('wikiship · MCP ready');
      new Notice('wikiship MCP server is ready.');
    } catch (error) {
      this.mcpServer = undefined;
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
    // Reject new mutations immediately. Also wait for any in-flight startup so
    // it cannot acquire a lock after cleanup; start() cancels further setup.
    const drained = this.journal?.close() ?? Promise.resolve();
    const shutdown = this.loading.catch(() => undefined).then(async () => {
      await Promise.allSettled([drained, this.mcpServer?.close() ?? Promise.resolve()]);
      await this.store?.close();
    });
    // Obsidian does not await this synchronous hook. Publish cleanup before it
    // returns so a replacement instance waits before attempting the writer lock.
    const pending = this.store ? trackJournalShutdown(this.store.directory, shutdown) : shutdown;
    void pending.catch(error => console.error('wikiship could not close its journal', error));
  }
}
function message(error: unknown) { return error instanceof Error ? error.message : String(error); }

class wikishipSettings extends PluginSettingTab {
  constructor(app: App, private plugin: wikiship) { super(app, plugin); }
  getSettingDefinitions(): SettingDefinitionItem[] {
    return [
      { type: 'group', heading: 'wikiship', items: [
        { name: 'About', desc: 'wikiship runs an authenticated local MCP server. Pending changes and their before/after content stay in this vault’s plugin data until you undo or approve them.' },
      ] },
      { type: 'group', heading: 'Connection', items: [
        {
          name: 'Codex config',
          desc: 'Select the text below and copy it into your Codex config.toml. It contains this vault’s local access token.',
          render: setting => {
            setting.addTextArea(area => {
              area.setValue(codexConfig(`http://127.0.0.1:${DEFAULT_MCP_PORT}/mcp`, this.plugin.settings.mcpToken));
              area.inputEl.rows = 4;
              area.inputEl.setAttribute('readonly', '');
              area.inputEl.setAttribute('spellcheck', 'false');
              area.inputEl.setAttribute('aria-label', 'Codex MCP configuration');
            });
          },
        },
        {
          name: 'MCP access token',
          desc: 'Stored in this vault’s wikiship plugin data. Regenerate it if you shared the Codex configuration with someone else.',
          render: setting => {
            setting.addButton(button => button.setButtonText('Regenerate').onClick(async () => {
              this.plugin.settings.mcpToken = randomBytes(32).toString('hex');
              await this.plugin.saveData(this.plugin.settings);
              await this.plugin.restartMcpFromSettings();
              this.update();
              new Notice('wikiship token regenerated. Copy the updated Codex config.');
            }));
          },
        },
      ] },
      { type: 'group', heading: 'Access', items: [
        {
          name: 'Excluded directory names',
          desc: 'One name per line. Applies only to wikiship reads and writes. Obsidian settings are unchanged. Reload wikiship after editing.',
          render: setting => {
            setting.addTextArea(input => input.setValue(this.plugin.settings.exclusions.join('\n')).onChange(async value => {
              const exclusions = value.split('\n').map(line => line.trim()).filter(Boolean);
              if (exclusions.some(name => name.includes('/') || name.includes('\\') || name === '.' || name === '..')) return;
              this.plugin.settings = { ...this.plugin.settings, exclusions };
              await this.plugin.saveData(this.plugin.settings);
            }));
          },
        },
      ] },
    ];
  }
}
