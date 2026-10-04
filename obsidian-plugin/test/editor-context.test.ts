import { describe, expect, it, vi } from 'vitest';
import type { App } from 'obsidian';
import { currentHeadings, EditorContext } from '../src/context/editor';
import { hash } from '../src/model';

function fakeApp() {
  return { metadataCache: { getFirstLinkpathDest: vi.fn(() => null) }, workspace: {
    activeEditor: null, getActiveViewOfType: () => null, getLeavesOfType: () => [], getActiveFile: () => null,
  } } as unknown as App;
}
function active(app: App, path: string, text: string, from = 0, to = text.length) {
  const editor = { getValue: () => text, getCursor: (end?: string) => ({ line: 0, ch: end === 'from' ? from : to }), posToOffset: (position: { ch: number }) => position.ch };
  Object.assign(app.workspace, { activeEditor: { file: { path }, editor } });
  return editor;
}

describe('current Markdown section locations', () => {
  it('uses current offsets for ATX and setext headings while ignoring fences and YAML', () => {
    const text = '---\ntitle: Title\n---\n# Architecture\n\n```md\n# Pretend\n```\n## Storage ##\nData\n\nFuture\n------\nPlan\n';
    const headings = currentHeadings(text);
    expect(headings.map(h => h.path)).toEqual([['Architecture'], ['Architecture', 'Storage'], ['Architecture', 'Future']]);
    expect(text.slice(headings[1]!.from, headings[1]!.to)).toBe('## Storage ##\nData\n\n');
    expect(text.slice(headings[2]!.from, headings[2]!.to)).toBe('Future\n------\nPlan\n');
  });
  it('refuses duplicate heading paths as ambiguous section targets', async () => {
    const app = fakeApp(), text = '# A\n## B\none\n## B\ntwo'; active(app, 'note.md', text);
    expect(currentHeadings(text).map(h => h.path)).toEqual([['A'], ['A', 'B'], ['A', 'B']]);
    const context = new EditorContext(app, async () => ({ text, source: 'editor' }));
    await expect(context.sectionTarget(['A', 'B'])).rejects.toThrow('ambiguous');
  });
  it('locates the final section when the cursor is at the end of the document', async () => {
    const app = fakeApp(), text = '# Note\n## Last\ncontent'; active(app, 'note.md', text, text.length);
    const context = new EditorContext(app, async () => ({ text, source: 'editor' }));
    const target = await context.sectionTarget();
    expect(target).toMatchObject({ from: 7, to: text.length, fileHash: hash(text) });
    expect((await context.getEditorState()).section?.path).toEqual(['Note', 'Last']);
    expect(text.slice(target.from, target.to)).toBe('## Last\ncontent');
    expect((await context.getSelection()).empty).toBe(true);
  });
});

describe('live editor context', () => {
  it('refuses changed live buffers captured before an asynchronous read', async () => {
    const app = fakeApp(); let text = '# Note\nfirst';
    const editor = active(app, 'note.md', text); editor.getValue = () => text;
    const context = new EditorContext(app, async () => { text = '# Note\nsecond'; return { text, source: 'editor' }; });
    await expect(context.cursorTarget()).rejects.toThrow('Editor changed');
  });
  it('refuses a cursor change during an asynchronous read even if the file text is unchanged', async () => {
    const app = fakeApp(), text = '# Note\ncontent'; let offset = 0;
    const editor = active(app, 'note.md', text); editor.getCursor = () => ({ line: 0, ch: offset });
    const context = new EditorContext(app, async () => { offset = 2; return { text, source: 'editor' }; });
    await expect(context.cursorTarget()).rejects.toThrow('Editor changed');
  });
  it('refuses a tab switch during an asynchronous read even for identical content', async () => {
    const app = fakeApp(), text = 'same'; active(app, 'A.md', text);
    const context = new EditorContext(app, async () => { active(app, 'B.md', text); return { text, source: 'editor' }; });
    await expect(context.selectionTarget()).rejects.toThrow('Editor changed');
  });
  it('reports an active file without inventing selection or section when no editor is available', async () => {
    const app = fakeApp(); Object.assign(app.workspace, { getActiveFile: () => ({ path: 'reading.md' }) });
    const reader = vi.fn(), context = new EditorContext(app, reader);
    expect(await context.getEditorState()).toMatchObject({ activeFile: 'reading.md', cursor: null, selection: null, section: null, editorUnavailable: expect.any(String) });
    expect(reader).not.toHaveBeenCalled();
  });
});

describe('link metadata on live context responses', () => {
  it('enriches selection and editor state without reading linked files', async () => {
    const app = fakeApp(), path = 'Daily/source.md', content = 'Selected [[tmplt#Tasks|Template]]';
    const text = `[[outside]]\n${content}\n[[also-outside]]`, from = text.indexOf(content), to = from + content.length;
    active(app, path, text, from, to);
    const resolver = vi.fn(() => ({ path: 'Templates/tmplt.md' }));
    Object.assign(app.metadataCache, { getFirstLinkpathDest: resolver });
    const reader = vi.fn(async (requested: string) => {
      if (requested !== path) throw new Error('Unexpected target read');
      return { text, source: 'editor' as const };
    });
    const context = new EditorContext(app, reader);
    const selection = await context.getSelection(), editorState = await context.getEditorState();
    const expected = [{ raw: '[[tmplt#Tasks|Template]]', linkpath: 'tmplt', subpath: '#Tasks', displayText: 'Template', targetPath: 'Templates/tmplt.md', status: 'resolved' }];
    expect(selection).toMatchObject({ content, from, to, links: expected });
    expect(editorState.selection).toMatchObject({ content, from, to, links: expected });
    expect(resolver.mock.calls).toEqual(Array(2).fill(['tmplt', path]));
    expect(reader.mock.calls).toEqual(Array(2).fill([path]));
  });
  it('uses the current source and recomputes destinations after tab and metadata changes', async () => {
    const app = fakeApp(), text = '[[tmplt]]';
    const resolver = vi.fn((_path: string, source: string) => ({ path: source.replace('source', 'tmplt') }) as { path: string } | null);
    Object.assign(app.metadataCache, { getFirstLinkpathDest: resolver });
    const context = new EditorContext(app, async () => ({ text, source: 'editor' }));
    active(app, 'Daily/source.md', text);
    expect((await context.getSelection()).links[0]?.targetPath).toBe('Daily/tmplt.md');
    active(app, 'Work/source.md', text);
    expect((await context.getSelection()).links[0]?.targetPath).toBe('Work/tmplt.md');
    resolver.mockReturnValue(null);
    expect((await context.getSelection()).links[0]?.status).toBe('unresolved');
  });
});
