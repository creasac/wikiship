import { parseLinktext, type MetadataCache } from 'obsidian';
import { parser } from '@lezer/markdown';

export interface ContextLink {
  raw: string;
  linkpath: string;
  subpath: string;
  displayText?: string;
  targetPath: string | null;
  status: 'resolved' | 'unresolved';
}

// Extend the existing Markdown parser so escaped text and code examples are not
// mistaken for links. Parse the source buffer to retain syntax around a selection.
const wikiLink = /!?\[\[([^\[\]\r\n]+)\]\]/y;
const linkParser = parser.configure({
  defineNodes: ['WikiLink'],
  parseInline: [{
    name: 'WikiLink', before: 'Link',
    parse(cx, next, pos) {
      if (next !== 91 && next !== 33) return -1;
      wikiLink.lastIndex = pos - cx.offset;
      const match = wikiLink.exec(cx.text);
      return match ? cx.addElement(cx.elt('WikiLink', pos, pos + match[0].length)) : -1;
    },
  }],
});

/** Resolve only complete links within the returned range; never read a target. */
export function contextLinks(text: string, sourcePath: string,
  metadata: Pick<MetadataCache, 'getFirstLinkpathDest'>, from = 0, to = text.length): ContextLink[] {
  const links: ContextLink[] = [];
  const frontmatterEnd = /^(?:\uFEFF)?---\r?\n[\s\S]*?\r?\n(?:---|\.\.\.)(?:\r?\n|$)/.exec(text)?.[0].length ?? 0;
  linkParser.parse(text).iterate({ enter(node) {
    if (node.to <= from || node.from >= to || node.to <= frontmatterEnd) return false;
    if (!['WikiLink', 'Link', 'Image'].includes(node.name)) return;
    if (node.from < from || node.to > to || node.from < frontmatterEnd) return false;
    const raw = text.slice(node.from, node.to);
    let linktext: string, displayText: string | undefined;
    if (node.name === 'WikiLink') {
      const inner = raw.slice(raw.startsWith('!') ? 3 : 2, -2), separator = inner.indexOf('|');
      linktext = (separator < 0 ? inner : inner.slice(0, separator)).trim();
      if (separator >= 0) displayText = inner.slice(separator + 1);
    } else {
      // Inline Markdown destinations only; reference-style links may depend on
      // definitions outside the selected context and are not expanded here.
      const url = node.node.getChild('URL');
      if (!url) return false;
      linktext = text.slice(url.from, url.to).replace(/^<|>$/g, '').replace(/\\([\\()[\]#])/g, '$1');
      try { linktext = decodeURIComponent(linktext); } catch { /* Keep literal percent signs. */ }
      const marks = node.node.getChildren('LinkMark');
      if (marks.length >= 2) displayText = text.slice(marks[0]!.to, marks[1]!.from);
    }
    // External URLs remain in the original content, not in the internal-link list.
    if (!linktext || /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(linktext)) return false;
    const { path: linkpath, subpath } = parseLinktext(linktext);
    const target = metadata.getFirstLinkpathDest(linkpath || sourcePath, sourcePath);
    links.push({ raw, linkpath, subpath, ...(displayText === undefined ? {} : { displayText }),
      targetPath: target?.path ?? null, status: target ? 'resolved' : 'unresolved' });
    return false;
  } });
  return links;
}
