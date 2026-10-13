#!/usr/bin/env node
// Native acceptance harness. It creates and touches only a fresh fixture vault
// and isolated Obsidian profile. Run after npm run build, under xvfb-run on Linux.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, copyFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright-core';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const downloads = process.env.WIKISHIP_SMOKE_DOWNLOADS ?? '/tmp/wikiship-smoke/downloads';
const executablePath = process.env.WIKISHIP_OBSIDIAN_EXECUTABLE ?? '/opt/Obsidian/obsidian';
const root = await mkdtemp(join(tmpdir(), 'wikiship-native-'));
const profile = join(root, 'profile'), vault = join(root, 'vault');
const output = join(repository, 'artifacts');
const token = randomBytes(32).toString('hex');
const port = Number(process.env.WIKISHIP_SMOKE_PORT ?? 29123);
const checks = [];
const pageErrors = [];
let electron, browser, page, client, bridgeClient;
const noteA = '# Notes A\n\nFirst paragraph selected for the agent.\n\nSecond paragraph selected for the agent.\n\nUnselected final paragraph.\n';
const noteB = '# Architecture\n\n## Storage\nUse ordinary local files.\n\n## API\nPreserve this section.\n';
const largeBeforeSuffix = '<b data-test="literal">Before final line</b>\n';
const largeAfterSuffix = '<b data-test="literal">After final line from AI</b>\n';
const largeNote = 'Repeated stable line 0123456789.\n'.repeat(8000) + largeBeforeSuffix;
function passed(check) { checks.push(check); console.log(`PASS ${check}`); }
const redact = value => String(value).split(token).join('[redacted]');
async function json(path, value) { await writeFile(path, JSON.stringify(value, null, 2)); }
async function waitFor(predicate, label, timeout = 15_000) {
  const start = Date.now();
  for (;;) {
    if (await predicate()) return;
    if (Date.now() - start > timeout) throw new Error(`Timed out: ${label}`);
    await new Promise(resolve => setTimeout(resolve, 150));
  }
}
async function connect() {
  const next = new Client({ name: 'wikiship-native-acceptance', version: '1.0.0' });
  await next.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp/`), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  }));
  return next;
}
async function call(name, args = {}) {
  const response = await client.callTool({ name, arguments: args });
  assert.ok(!response.isError, `${name}: ${JSON.stringify(response.content)}`);
  return JSON.parse(response.content.find(block => block.type === 'text').text);
}
async function openNote(path, cursorText) {
  await page.bringToFront();
  await page.evaluate(() => { window.focus(); window.electron?.remote?.getCurrentWindow().focus(); });
  await page.evaluate(async ({ path, cursorText }) => {
    const file = app.vault.getFileByPath(path);
    if (!file) throw new Error(`Missing fixture note: ${path}`);
    const leaf = app.workspace.getLeaf(false);
    await leaf.openFile(file, { active: true });
    if (leaf.view.getMode() !== 'source') await leaf.setViewState({ ...leaf.getViewState(), state: { ...leaf.getViewState().state, mode: 'source' } });
    const editor = leaf.view.editor;
    editor.focus();
    if (cursorText) editor.setCursor(editor.offsetToPos(editor.getValue().indexOf(cursorText)));
  }, { path, cursorText });
}
async function command(id) {
  await page.evaluate(id => {
    if (!app.commands.executeCommandById(`wikiship:${id}`)) throw new Error(`Unavailable command: ${id}`);
  }, id);
}
async function state() { return page.evaluate(() => app.plugins.plugins.wikiship.journal.state); }
async function openChange(id) {
  await page.evaluate(async id => {
    const wiki = app.plugins.plugins.wikiship;
    const op = wiki.journal.state.operations.find(op => op.id === id);
  // The review command opens the next queued file.
    if (!op || op.status === 'reverted') throw new Error('Expected a queued fixture operation.');
    app.commands.executeCommandById('wikiship:next-change');
  }, id);
  await page.locator('.wikiship-review-modal').waitFor();
}

try {
  await mkdir(profile, { recursive: true });
  await mkdir(join(vault, '.obsidian', 'plugins', 'wikiship'), { recursive: true });
  await mkdir(join(vault, '.obsidian', 'plugins', 'obsidian-local-rest-api'), { recursive: true });
  await mkdir(join(vault, 'src'), { recursive: true });
  await mkdir(output, { recursive: true });
  await writeFile(join(profile, 'obsidian-1.13.7.asar'), gunzipSync(await readFile(join(downloads, 'obsidian-1.13.7.asar.gz'))));
  await json(join(profile, 'obsidian.json'), { vaults: { [randomBytes(8).toString('hex')]: { path: vault, ts: Date.now(), open: true } }, updateDisabled: true });
  await json(join(vault, '.obsidian', 'app.json'), { livePreview: true, defaultViewMode: 'source', alwaysUpdateLinks: false });
  await json(join(vault, '.obsidian', 'community-plugins.json'), ['obsidian-local-rest-api', 'wikiship']);
  await json(join(vault, '.obsidian', 'plugins', 'obsidian-local-rest-api', 'data.json'), {
    apiKey: token, enableInsecureServer: true, enableSecureServer: false,
    insecurePort: port, port: port + 1, bindingHost: '127.0.0.1',
  });
  for (const file of ['main.js', 'manifest.json', 'styles.css']) await copyFile(join(repository, 'obsidian-plugin', file), join(vault, '.obsidian', 'plugins', 'wikiship', file));
  await copyFile(join(downloads, 'rest-main.js'), join(vault, '.obsidian', 'plugins', 'obsidian-local-rest-api', 'main.js'));
  await copyFile(join(downloads, 'rest-manifest.json'), join(vault, '.obsidian', 'plugins', 'obsidian-local-rest-api', 'manifest.json'));
  await writeFile(join(vault, 'A.md'), noteA); await writeFile(join(vault, 'B.md'), noteB);
  await writeFile(join(vault, 'large-review.md'), largeNote);
  await writeFile(join(vault, 'src', 'answer.ts'), 'export const answer = 41;\n');
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  // Production Electron disables Node inspector switches, so Playwright's
  // _electron.launch cannot attach its main-process debugger. Its supported
  // Chromium DevTools endpoint still lets us automate the actual renderer.
  let devtoolsUrl;
  electron = spawn(executablePath, ['--no-sandbox', '--remote-debugging-port=0', `--user-data-dir=${profile}`], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let launchError;
  electron.on('error', error => { launchError = error; });
  electron.stderr.on('data', chunk => {
    const match = String(chunk).match(/DevTools listening on (ws:\/\/\S+)/);
    if (match) devtoolsUrl = match[1];
  });
  await waitFor(() => { if (launchError) throw launchError; return !!devtoolsUrl; }, 'Obsidian renderer DevTools', 30_000);
  browser = await chromium.connectOverCDP(devtoolsUrl);
  await waitFor(() => browser.contexts()[0]?.pages().length > 0, 'Obsidian window', 30_000);
  page = browser.contexts()[0].pages()[0];
  page.on('pageerror', error => pageErrors.push(redact(error.stack ?? error.message)));
  page.on('console', message => { if (message.type() === 'error') pageErrors.push(redact(message.text())); });
  await page.waitForFunction(() => typeof app !== 'undefined' && app.vault && app.workspace, { timeout: 30_000 });
  await page.setViewportSize({ width: 1440, height: 1000 });
  // Trust only this fresh throwaway fixture through Obsidian's own first-open
  // trust prompt; it then loads the two plugins declared in its configuration.
  await page.getByRole('button', { name: 'Trust author and enable plugins', exact: true }).click();
  await page.waitForFunction(() => !!app.plugins.plugins.wikiship?.journal && !!app.plugins.plugins['obsidian-local-rest-api']?.requestHandler, { timeout: 30_000 });
  // Local REST API opens its settings on first use. Close that real native
  // popout before exercising editor commands in the main vault window.
  await page.evaluate(() => app.setting.close());
  await page.bringToFront();
  await page.evaluate(() => { window.focus(); window.electron?.remote?.getCurrentWindow().focus(); });
  await waitFor(async () => { try { const r = await fetch(`http://127.0.0.1:${port}/`); return r.ok; } catch { return false; } }, 'local MCP listener', 30_000);
  client = await connect();
  const listed = await client.listTools();
  assert.equal(listed.tools.filter(tool => tool.name.startsWith('wikiship_')).length, 12);
  passed('Native Obsidian loads wikiship and registers 12 tools on the real host');

  await openNote('A.md');
  await page.evaluate(() => {
    const editor = app.workspace.activeEditor.editor, text = editor.getValue();
    editor.setSelection(editor.offsetToPos(text.indexOf('First paragraph')), editor.offsetToPos(text.indexOf('\n\nUnselected')));
  });
  const selection = await call('wikiship_get_selection');
  assert.equal(selection.path, 'A.md');
  assert.equal(selection.content, 'First paragraph selected for the agent.\n\nSecond paragraph selected for the agent.');
  await openNote('B.md', 'Use ordinary');
  const editorState = await call('wikiship_get_editor_state');
  assert.equal(editorState.activeFile, 'B.md');
  assert.deepEqual(editorState.section.path, ['Architecture', 'Storage']);
  const section = await call('wikiship_get_file_state', { path: 'B.md', from: editorState.section.from, length: editorState.section.to - editorState.section.from });
  assert.equal(section.fileHash, editorState.fileHash);
  assert.equal(section.content, '## Storage\nUse ordinary local files.\n\n');
  const commands = await page.evaluate(() => Object.keys(app.commands.commands).filter(id => id.startsWith('wikiship:')));
  assert.deepEqual(commands.sort(), ['open-changes', 'next-change', 'complete-changes', 'undo-changes', 'recover', 'reconnect-mcp'].map(id => `wikiship:${id}`).sort());
  passed('Live selection and cursor section follow the active note; the six review and recovery commands are registered');

  const edited = await call('wikiship_patch_section', { path: 'B.md', expectedHash: section.fileHash,
    headingPath: ['Architecture', 'Storage'], content: '## Storage\nAI writes are recorded and reviewable.\n\n', agent: 'native-smoke', session: 'isolated-vault' });
  await page.waitForFunction(() => app.workspace.getLeavesOfType('markdown').some(leaf =>
    leaf.view.file?.path === 'B.md' && leaf.view.editor.getValue().includes('AI writes are recorded')));
  await page.locator('.wikiship-gutter-marker').first().waitFor();
  await command('open-changes');
  await page.locator('.wikiship-file-group').first().waitFor();
  assert.match(await page.locator('.wikiship-session-group').first().innerText(), /native-smoke/);
  // The queue entry opens the changed file at its affected location and shows the diff.
  await page.locator('.wikiship-file-group').first().locator('.wikiship-file-link').click();
  await page.locator('.wikiship-review-modal .wikiship-diff-added').first().waitFor();
  assert.match(await page.locator('.wikiship-diff').innerText(), /AI writes are recorded/);
  assert.match(await page.locator('.wikiship-diff').innerText(), /Use ordinary local files/);
  await page.screenshot({ path: join(output, 'obsidian-acceptance.png'), fullPage: true });
  await page.getByRole('button', { name: 'Undo file', exact: true }).click();
  await waitFor(async () => !(await state()).operations.some(op => op.id === edited.id), 'change undone and cleared');
  assert.equal(await readFile(join(vault, 'B.md'), 'utf8'), noteB);
  await page.keyboard.press('Escape');
  passed('Live editor, auto-opened AI Changes, literal before/after diff, undo, and queue clearing work');

  await openNote('B.md', 'Use ordinary');
  const fileState = await call('wikiship_get_file_state', { path: 'B.md' });
  const conflictOp = await call('wikiship_replace_range', { path: 'B.md', expectedHash: fileState.fileHash,
    from: 0, to: 0, content: 'AI introduction.\n', agent: 'native-smoke' });
  await page.evaluate(() => {
    const editor = app.workspace.activeEditor.editor;
    editor.setCursor({ line: 0, ch: 0 }); editor.replaceRange('Human typed afterward.\n', { line: 0, ch: 0 });
  });
  await openChange(conflictOp.id);
  await page.getByRole('button', { name: 'Undo file', exact: true }).click();
  await page.locator('.notice').filter({ hasText: 'Conflict' }).first().waitFor();
  assert.equal((await state()).operations.find(op => op.id === conflictOp.id).status, 'applied');
  assert.match(await page.evaluate(() => app.workspace.activeEditor.editor.getValue()), /Human typed afterward/);
  await page.locator('.wikiship-review-modal').getByRole('button', { name: 'Approve session', exact: true }).click();
  await waitFor(async () => !(await state()).operations.some(op => op.id === conflictOp.id), 'conflicting change cleared');
  await page.keyboard.press('Escape');
  passed('A newer human editor change blocks undo and remains intact; the user can explicitly clear its record');

  const created = await call('wikiship_create_file', { path: 'AI-created.md', content: 'Created through the real MCP host.\n', agent: 'native-smoke' });
  const moved = await call('wikiship_move_file', { path: 'AI-created.md', target: 'AI-moved.md', expectedHash: created.afterHash });
  const deleted = await call('wikiship_delete_file', { path: 'AI-moved.md', expectedHash: moved.afterHash });
  await command('open-changes');
  const deletedGroup = page.locator('.wikiship-file-group').filter({ hasText: 'AI-created.md → AI-moved.md' });
  await deletedGroup.locator('.wikiship-file-link').click();
  await page.locator('.wikiship-review-modal .wikiship-delete-notice').waitFor();
  await page.locator('.wikiship-review-modal summary').filter({ hasText: 'Operation history' }).click();
  assert.match(await page.locator('.wikiship-history').innerText(), /Created file.*Moved to AI-moved\.md.*Deleted file/s);
  assert.equal(deleted.status, 'pending-delete');
  assert.equal(await readFile(join(vault, 'AI-moved.md'), 'utf8'), 'Created through the real MCP host.\n');
  await page.locator('.wikiship-review-modal').getByRole('button', { name: 'Approve session', exact: true }).click();
  await waitFor(async () => !(await state()).operations.some(op => op.id === deleted.id), 'delete session cleared');
  await page.keyboard.press('Escape');
  await assert.rejects(readFile(join(vault, 'AI-moved.md'), 'utf8'), { code: 'ENOENT' });
  const code = await call('wikiship_get_file_state', { path: 'src/answer.ts' });
  const changedCode = await call('wikiship_replace_range', { path: 'src/answer.ts', expectedHash: code.fileHash,
    from: 0, to: code.totalLength, content: 'export const answer = 42;\n' });
  assert.equal(changedCode.status, 'applied');
  assert.equal(await readFile(join(vault, 'src', 'answer.ts'), 'utf8'), 'export const answer = 42;\n');
  passed('Create, move, delete, recover, and an ordinary source-code file mutation retain provenance');

  const largeState = await call('wikiship_get_file_state', { path: 'large-review.md' });
  const largeOperation = await call('wikiship_replace_range', { path: 'large-review.md', expectedHash: largeState.fileHash,
    from: largeNote.length - largeBeforeSuffix.length, to: largeNote.length, content: largeAfterSuffix, agent: 'native-smoke' });
  await command('open-changes');
  const largeGroup = page.locator('.wikiship-file-group').filter({ hasText: 'large-review.md' });
  await largeGroup.locator('.wikiship-file-link').click();
  await page.locator('.wikiship-review-modal').waitFor();
  await page.locator('.wikiship-review-modal summary').filter({ hasText: 'Recovery record' }).click();
  await page.locator('.wikiship-recovery-operation summary').first().click();
  const beforePanel = page.locator('.wikiship-snapshot[data-wikiship-snapshot="before"]');
  const afterPanel = page.locator('.wikiship-snapshot[data-wikiship-snapshot="after"]');
  await beforePanel.getByRole('button', { name: 'Before last page', exact: true }).click();
  await afterPanel.getByRole('button', { name: 'After last page', exact: true }).click();
  assert.match(await beforePanel.locator('.wikiship-source').innerText(), /<b data-test="literal">Before final line<\/b>/);
  assert.match(await afterPanel.locator('.wikiship-source').innerText(), /<b data-test="literal">After final line from AI<\/b>/);
  assert.equal(await page.locator('.wikiship-review-modal [data-test="literal"]').count(), 0);
  await page.getByRole('button', { name: 'Undo file', exact: true }).click();
  await waitFor(async () => !(await state()).operations.some(op => op.id === largeOperation.id), 'large change undone and cleared');
  assert.equal(await readFile(join(vault, 'large-review.md'), 'utf8'), largeNote);
  await page.keyboard.press('Escape');
  passed('Large change last pages expose exact literal before/after EOF changes and safely undo');

  await openNote('B.md');
  const beforeReload = await state();
  await page.evaluate(async () => {
    await app.plugins.disablePlugin('wikiship');
    // The plugin drains and releases its durable journal lock asynchronously.
  });
  await new Promise(resolve => setTimeout(resolve, 350));
  await page.evaluate(async () => { await app.plugins.enablePlugin('wikiship'); });
  await page.waitForFunction(() => !!app.plugins.plugins.wikiship?.journal);
  await waitFor(async () => (await state()).operations.length === beforeReload.operations.length, 'persisted journal after reload');
  assert.deepEqual(JSON.parse(JSON.stringify((await state()).operations)), JSON.parse(JSON.stringify(beforeReload.operations)));
  assert.equal((await call('wikiship_get_editor_state')).activeFile, 'B.md');
  passed('Plugin reload preserves operation history and re-registers live MCP tools');

  await client.close(); client = undefined;
  await page.evaluate(async () => { await app.plugins.disablePlugin('obsidian-local-rest-api'); await app.plugins.enablePlugin('obsidian-local-rest-api'); });
  await waitFor(async () => { try { const r = await fetch(`http://127.0.0.1:${port}/`); return r.ok; } catch { return false; } }, 'reloaded host listener');
  client = await connect();
  assert.equal((await client.listTools()).tools.filter(tool => tool.name.startsWith('wikiship_')).length, 12);
  assert.equal((await call('wikiship_get_editor_state')).activeFile, 'B.md');
  passed('Host plugin reload reconnects wikiship registration on the same MCP endpoint');

  bridgeClient = new Client({ name: 'wikiship-native-stdio-acceptance', version: '1.0.0' });
  await bridgeClient.connect(new StdioClientTransport({ command: process.execPath,
    args: [join(repository, 'adapters', 'stdio-bridge.mjs')],
    env: { WIKISHIP_MCP_URL: `http://127.0.0.1:${port}/mcp/`, WIKISHIP_API_KEY: token }, stderr: 'pipe' }));
  assert.equal((await bridgeClient.listTools()).tools.length, 19);
  const bridgeContext = await bridgeClient.callTool({ name: 'wikiship_get_editor_state' });
  assert.ok(!bridgeContext.isError);
  assert.equal(JSON.parse(bridgeContext.content.find(block => block.type === 'text').text).activeFile, 'B.md');
  for (const name of ['command_execute', 'open_file', 'vault_write', 'wikiship_raw_write']) assert.equal((await bridgeClient.callTool({ name, arguments: {} })).isError, true);
  passed('Actual stdio bridge lists 19 approved tools, reads live context, and refuses unjournaled write and command bypasses');

  const versions = await page.evaluate(() => ({ obsidianRelease: '1.13.7', electron: process.versions.electron, wikiShip: app.plugins.plugins.wikiship.manifest.version, localRestApi: app.plugins.plugins['obsidian-local-rest-api'].manifest.version }));
  await json(join(output, 'obsidian-acceptance.json'), { ok: true, versions, checks, pageErrors, fixture: root });
  await rm(join(output, 'obsidian-acceptance-failure.png'), { force: true });
  console.log(JSON.stringify({ ok: true, checks: checks.length, versions, screenshot: join(output, 'obsidian-acceptance.png') }));
} catch (error) {
  if (page) {
    await page.screenshot({ path: join(output, 'obsidian-acceptance-failure.png'), fullPage: true }).catch(() => {});
    console.error('Visible UI:', redact((await page.locator('body').innerText().catch(() => '')).slice(0, 2500)));
  }
  await json(join(output, 'obsidian-acceptance.json'), { ok: false, checks, error: redact(error.stack ?? error), pageErrors, fixture: root });
  console.error(redact(error.stack ?? error));
  console.error('Renderer errors:', JSON.stringify(pageErrors));
  process.exitCode = 1;
} finally {
  if (client) await client.close().catch(() => {});
  if (bridgeClient) await bridgeClient.close().catch(() => {});
  if (browser) await browser.close().catch(() => {});
  if (electron && electron.exitCode === null) {
    electron.kill('SIGTERM');
    await Promise.race([new Promise(resolve => electron.once('exit', resolve)), new Promise(resolve => setTimeout(resolve, 2000))]);
    if (electron.exitCode === null) electron.kill('SIGKILL');
  }
}
