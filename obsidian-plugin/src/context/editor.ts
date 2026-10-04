import { MarkdownView, type App, type Editor, type MarkdownFileInfo } from 'obsidian';
import { parser } from '@lezer/markdown';
import { hash, type ContextReader } from '../model';
import { contextLinks } from './links';
import { headingRanges, sameHeading, sectionAt, type Heading } from './references';

/** Parse the actual buffer, so delayed Obsidian metadata never points at old offsets. */
export function currentHeadings(text: string): Heading[] {
  // CommonMark does not understand Obsidian YAML frontmatter. Preserve offsets
  // while excluding it from the standard parser's heading candidates.
  const frontmatter = /^(?:\uFEFF)?---\r?\n[\s\S]*?\r?\n(?:---|\.\.\.)(?:\r?\n|$)/.exec(text);
  const frontmatterEnd = frontmatter?.[0].length ?? 0;
  const found: { heading: string; level: number; position: { start: { offset: number } } }[] = [];
  parser.parse(text).iterate({ enter(node) {
    if (node.from < frontmatterEnd) return;
    const match = /^(ATX|Setext)Heading([1-6])$/.exec(node.name);
    if (!match) return;
    const marks = node.node.getChildren('HeaderMark');
    const from = match[1] === 'ATX' ? marks[0]!.to : node.from;
    const to = match[1] === 'Setext' ? marks[0]!.from : marks.length > 1 ? marks[1]!.from : node.to;
    const heading = text.slice(from, to).trim().replace(/\r?\n/g, ' ');
    found.push({ heading, level: Number(match[2]), position: { start: { offset: node.from } } });
    return false;
  } });
  return headingRanges(found, text.length);
}

export interface EditorTarget { path: string; from: number; to: number; fileHash: string; }

const headingAt = (headings: Heading[], text: string, offset: number) => sectionAt(headings, Math.min(offset, Math.max(0, text.length - 1)));

export class EditorContext {
  constructor(readonly app: App, private readonly reader: ContextReader) {}

  private active(): MarkdownFileInfo & { file: NonNullable<MarkdownFileInfo['file']>; editor: Editor } {
    const info = this.app.workspace.activeEditor ?? this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!info?.file || !info.editor) throw new Error('Open a Markdown note in editing mode first.');
    if (info instanceof MarkdownView && info.getMode() !== 'source') throw new Error('Switch this note to editing mode first.');
    return info as MarkdownFileInfo & { file: NonNullable<MarkdownFileInfo['file']>; editor: Editor };
  }

  private async captured() {
    const { file, editor } = this.active();
    const path = file.path;
    // Capture selection and content before awaiting disk/policy validation.
    const text = editor.getValue(), from = editor.posToOffset(editor.getCursor('from'));
    const to = editor.posToOffset(editor.getCursor('to')), cursor = editor.getCursor(), cursorOffset = editor.posToOffset(cursor);
    const read = await this.reader(path);
    const active = this.active();
    if (read.text !== text || editor.getValue() !== text || file.path !== path || active.editor !== editor || active.file.path !== path ||
      editor.posToOffset(editor.getCursor('from')) !== from || editor.posToOffset(editor.getCursor('to')) !== to || editor.posToOffset(editor.getCursor()) !== cursorOffset) {
      throw new Error('Editor changed while reading context. Retry with the current editor state.');
    }
    return { path, text, from, to, cursor, cursorOffset, source: read.source, mtime: read.mtime, fileHash: hash(text) };
  }

  async getSelection() {
    const captured = await this.captured();
    const { text, ...state } = captured;
    return { ...state, content: text.slice(state.from, state.to), empty: state.from === state.to, offsets: 'UTF-16' as const,
      links: contextLinks(text, state.path, this.app.metadataCache, state.from, state.to) };
  }

  async getEditorState() {
    const openMarkdownTabs = this.app.workspace.getLeavesOfType('markdown').flatMap(leaf => {
      const view = leaf.view;
      return view instanceof MarkdownView && view.file ? [{ path: view.file.path, mode: view.getMode() }] : [];
    });
    try {
      const state = await this.captured();
      const heading = headingAt(currentHeadings(state.text), state.text, state.cursorOffset);
      return { activeFile: state.path, fileHash: state.fileHash, cursor: state.cursor,
        selection: { from: state.from, to: state.to, content: state.text.slice(state.from, state.to),
          links: contextLinks(state.text, state.path, this.app.metadataCache, state.from, state.to) },
        section: heading ?? null, openMarkdownTabs, offsets: 'UTF-16', source: state.source };
    } catch (error) {
      return { activeFile: this.app.workspace.getActiveFile()?.path ?? null, cursor: null, selection: null,
        section: null, openMarkdownTabs, editorUnavailable: String(error) };
    }
  }

  async selectionTarget(): Promise<EditorTarget> {
    const c = await this.captured();
    if (c.from === c.to) throw new Error('Select text before replacing the selection.');
    return { path: c.path, from: c.from, to: c.to, fileHash: c.fileHash };
  }
  async cursorTarget(): Promise<EditorTarget> {
    const c = await this.captured(), offset = c.cursorOffset;
    return { path: c.path, from: offset, to: offset, fileHash: c.fileHash };
  }
  async sectionTarget(headingPath?: string[]): Promise<EditorTarget> {
    const c = await this.captured(), headings = currentHeadings(c.text);
    const candidates = headingPath ? headings.filter(h => sameHeading(h.path, headingPath)) : [headingAt(headings, c.text, c.cursorOffset)].filter((h): h is Heading => !!h);
    if (candidates.length !== 1 || headings.filter(h => sameHeading(h.path, candidates[0]!.path)).length !== 1) throw new Error('Section is missing or ambiguous. Use a unique heading path.');
    return { path: c.path, from: candidates[0]!.from, to: candidates[0]!.to, fileHash: c.fileHash };
  }
}
