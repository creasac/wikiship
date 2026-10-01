import { describe, expect, it, vi } from 'vitest';
import type { App } from 'obsidian';
vi.mock('obsidian', () => ({ MarkdownView: class MarkdownView {} }));
import { currentHeadings, EditorContext } from '../src/context/editor';
import { pin } from '../src/context/references';
import { Journal } from '../src/provenance/journal';
import { emptyState, type ContextReader } from '../src/model';

function fakeApp() {
  const events = { on: () => ({}), offref: () => undefined };
  return { vault: events, workspace: { ...events, activeEditor: null, getActiveViewOfType: () => null } } as unknown as App;
}

describe('current Markdown section locations', () => {
  it('uses current offsets for ATX and setext headings while ignoring fences and YAML', () => {
    const text = '---\ntitle: Title\n---\n# Architecture\n\n```md\n# Pretend\n```\n## Storage ##\nData\n\nFuture\n------\nPlan\n';
    const headings = currentHeadings(text);
    expect(headings.map(h => h.path)).toEqual([['Architecture'], ['Architecture', 'Storage'], ['Architecture', 'Future']]);
    expect(text.slice(headings[1]!.from, headings[1]!.to)).toBe('## Storage ##\nData\n\n');
    expect(text.slice(headings[2]!.from, headings[2]!.to)).toBe('Future\n------\nPlan\n');
  });
  it('keeps duplicate heading paths so references fail as ambiguous', () => {
    expect(currentHeadings('# A\n## B\none\n## B\ntwo').map(h => h.path)).toEqual([['A'], ['A', 'B'], ['A', 'B']]);
  });
});

describe('context retrieval isolation', () => {
  it('keeps the remaining basket usable when one file is missing and relocates edited sections', async () => {
    const original = '# Plan\n## Storage\nold\n## Next\nlater';
    const next = '# Plan\nPreamble added\n## Storage\ncurrent\n## Next\nlater';
    const state = emptyState();
    state.context = [pin('note', 'missing.md', 'gone'), pin('section', 'plan.md', original, 7, original.indexOf('## Next'), ['Plan', 'Storage'])];
    const journal = new Journal({ load: async () => state, save: async () => undefined }, { read: async () => null, apply: async () => undefined });
    await journal.load();
    const reader: ContextReader = async path => { if (path === 'missing.md') throw new Error('Missing file'); return { text: next, source: 'editor' }; };
    const context = new EditorContext(fakeApp(), journal, reader);
    const results = await context.getContext();
    expect(results[0]).toMatchObject({ status: 'stale', reason: 'Missing file' });
    expect(results[1]).toMatchObject({ status: 'changed', content: '## Storage\ncurrent\n', source: 'editor' });
    context.dispose();
  });
  it('refuses changed live buffers captured before an asynchronous read', async () => {
    const app = fakeApp(); let text = '# Note\nfirst';
    const editor = { getValue: () => text, getCursor: () => ({ line: 0, ch: 0 }), posToOffset: () => 0 };
    Object.assign(app.workspace, { activeEditor: { file: { path: 'note.md' }, editor } });
    const journal = new Journal({ load: async () => null, save: async () => undefined }, { read: async () => null, apply: async () => undefined });
    const context = new EditorContext(app, journal, async () => { text = '# Note\nsecond'; return { text, source: 'editor' }; });
    await expect(context.cursorTarget()).rejects.toThrow('Editor changed');
    context.dispose();
  });
  it('refuses a cursor change during an asynchronous read even if the file text is unchanged', async () => {
    const app = fakeApp(), text = '# Note\ncontent'; let offset = 0;
    const editor = { getValue: () => text, getCursor: () => ({ line: 0, ch: offset }), posToOffset: (position: { ch: number }) => position.ch };
    Object.assign(app.workspace, { activeEditor: { file: { path: 'note.md' }, editor } });
    const journal = new Journal({ load: async () => null, save: async () => undefined }, { read: async () => null, apply: async () => undefined });
    const context = new EditorContext(app, journal, async () => { offset = 2; return { text, source: 'editor' }; });
    await expect(context.cursorTarget()).rejects.toThrow('Editor changed');
    context.dispose();
  });
  it('pins the final section when the cursor is at the end of the document', async () => {
    const app = fakeApp(), text = '# Note\n## Last\ncontent';
    const editor = { getValue: () => text, getCursor: () => ({ line: 0, ch: text.length }), posToOffset: (position: { ch: number }) => position.ch };
    Object.assign(app.workspace, { activeEditor: { file: { path: 'note.md' }, editor } });
    const journal = new Journal({ load: async () => null, save: async () => undefined }, { read: async () => null, apply: async () => undefined });
    await journal.load();
    const context = new EditorContext(app, journal, async () => ({ text, source: 'editor' }));
    const pinned = await context.addSection();
    expect(pinned.headingPath).toEqual(['Note', 'Last']);
    expect((await context.getContext())[0]?.content).toBe('## Last\ncontent');
    context.dispose();
  });
});
