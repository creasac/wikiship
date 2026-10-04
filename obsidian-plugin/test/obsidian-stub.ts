// Minimal host boundary for service unit tests. Desktop integration uses Obsidian.
export class MarkdownView {}
// Host API boundary used by context-link tests (path plus heading/block suffix).
export function parseLinktext(linktext: string) {
  const at = linktext.indexOf('#');
  return { path: at < 0 ? linktext : linktext.slice(0, at), subpath: at < 0 ? '' : linktext.slice(at) };
}
