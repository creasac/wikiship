import { describe, expect, it } from 'vitest';
import { snapshotPage, SNAPSHOT_PAGE_SIZE } from '../src/review/paging';

describe('complete bounded snapshot inspection', () => {
  it('reaches an edit near EOF beyond the old preview limit while bounding each page', () => {
    const text = 'x'.repeat(250_000) + '\n<b>literal late change</b>\n';
    const pages = Array.from({ length: snapshotPage(text).pageCount }, (_, page) => snapshotPage(text, page));
    expect(pages.at(-1)!.text).toContain('<b>literal late change</b>');
    expect(pages.every(page => page.text.length <= SNAPSHOT_PAGE_SIZE + 1)).toBe(true);
    expect(pages.map(page => page.text).join('')).toBe(text);
  });
  it('does not split Unicode surrogate pairs or CRLF across pages', () => {
    const text = 'abc😀xy\r\nMore text';
    const pages = Array.from({ length: snapshotPage(text, 0, 4).pageCount }, (_, page) => snapshotPage(text, page, 4));
    expect(pages.map(page => page.text).join('')).toBe(text);
    for (const page of pages) {
      expect(page.text).not.toMatch(/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/);
      expect(page.text.startsWith('\n')).toBe(false);
      expect(page.text.endsWith('\r')).toBe(false);
    }
  });
  it('clamps requested page numbers and provides one page for an empty file', () => {
    expect(snapshotPage('', 200)).toEqual({ page: 0, pageCount: 1, from: 0, to: 0, text: '' });
    expect(snapshotPage('abcdef', -4, 2).text).toBe('ab');
    expect(snapshotPage('abcdef', 400, 2).text).toBe('ef');
    expect(snapshotPage('abcdef', Number.NaN, 2).text).toBe('ab');
  });
});
