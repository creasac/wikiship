import { describe, expect, it, vi } from 'vitest';
import type { TFile } from 'obsidian';
import { contextLinks } from '../src/context/links';

const file = (path: string) => ({ path }) as TFile;

describe('internal links in returned context', () => {
  it('delegates basename and relative resolution to Obsidian with the source path', () => {
    const metadata = { getFirstLinkpathDest: vi.fn((path: string, source: string) =>
      file(path === '../Templates/tmplt' ? 'Templates/tmplt.md' : `${source.split('/')[0]}/tmplt.md`)) };
    expect(contextLinks('[[tmplt]] [[../Templates/tmplt]]', 'Daily/source.md', metadata)).toEqual([
      { raw: '[[tmplt]]', linkpath: 'tmplt', subpath: '', targetPath: 'Daily/tmplt.md', status: 'resolved' },
      { raw: '[[../Templates/tmplt]]', linkpath: '../Templates/tmplt', subpath: '', targetPath: 'Templates/tmplt.md', status: 'resolved' },
    ]);
    expect(contextLinks('[[tmplt]]', 'Work/source.md', metadata)[0]?.targetPath).toBe('Work/tmplt.md');
    expect(metadata.getFirstLinkpathDest.mock.calls).toEqual([
      ['tmplt', 'Daily/source.md'], ['../Templates/tmplt', 'Daily/source.md'], ['tmplt', 'Work/source.md'],
    ]);
  });

  it('preserves aliases, embeds, heading/block suffixes, and same-note references', () => {
    const metadata = { getFirstLinkpathDest: vi.fn((path: string) => file(path === 'source.md' ? path : 'Templates/tmplt.md')) };
    const raw = ['[[tmplt#Checklist|Template]]', '![[tmplt#^step|Preview]]', '[[#Heading]]'];
    const links = contextLinks(raw.join(' '), 'source.md', metadata);
    expect(links.map(link => link.raw)).toEqual(raw);
    expect(links).toMatchObject([
      { linkpath: 'tmplt', subpath: '#Checklist', displayText: 'Template', targetPath: 'Templates/tmplt.md' },
      { linkpath: 'tmplt', subpath: '#^step', displayText: 'Preview', targetPath: 'Templates/tmplt.md' },
      { linkpath: '', subpath: '#Heading', targetPath: 'source.md' },
    ]);
    expect(metadata.getFirstLinkpathDest.mock.calls).toEqual([
      ['tmplt', 'source.md'], ['tmplt', 'source.md'], ['source.md', 'source.md'],
    ]);
  });

  it('handles inline Markdown destinations without treating external URLs as vault files', () => {
    const metadata = { getFirstLinkpathDest: vi.fn(() => file('Templates/My Template.md')) };
    const links = contextLinks('[Template](../Templates/My%20Template.md#Tasks) ![Preview](<My Template.md#^step> "title") [Web](https://example.com) [Mail](mailto:a@example.com) [Remote](//example.com/file)', 'Daily/source.md', metadata);
    expect(links).toMatchObject([
      { raw: '[Template](../Templates/My%20Template.md#Tasks)', linkpath: '../Templates/My Template.md', subpath: '#Tasks', displayText: 'Template' },
      { raw: '![Preview](<My Template.md#^step> "title")', linkpath: 'My Template.md', subpath: '#^step', displayText: 'Preview' },
    ]);
    expect(links).toHaveLength(2);
    expect(metadata.getFirstLinkpathDest).toHaveBeenCalledTimes(2);
  });

  it('reports a missing target explicitly without inventing a path', () => {
    const metadata = { getFirstLinkpathDest: vi.fn(() => null) };
    expect(contextLinks('[[missing#^block|Alias]]', 'source.md', metadata)).toEqual([
      { raw: '[[missing#^block|Alias]]', linkpath: 'missing', subpath: '#^block', displayText: 'Alias', targetPath: null, status: 'unresolved' },
    ]);
  });

  it('resolves only complete links in the requested range', () => {
    const text = '[[outside]] before [[inside]] after [[partial]]';
    const metadata = { getFirstLinkpathDest: vi.fn(() => file('inside.md')) };
    const from = text.indexOf('[[inside]]'), to = text.indexOf('[[partial]]') + 7;
    expect(contextLinks(text, 'source.md', metadata, from, to).map(link => link.raw)).toEqual(['[[inside]]']);
    expect(metadata.getFirstLinkpathDest.mock.calls).toEqual([['inside', 'source.md']]);
    expect(contextLinks(text, 'source.md', metadata, from, from)).toEqual([]);
  });

  it('ignores code, escapes, frontmatter and reference-style links even around a partial selection', () => {
    const text = '---\ntitle: "[[yaml]]"\n---\n`[[inline]]` \\[[escaped]]\n\n```md\n[[fenced]]\n```\n\n    [[indented]]\n\n[reference][ref]\n\n[ref]: target.md\n\n[[real]]';
    const metadata = { getFirstLinkpathDest: vi.fn(() => file('real.md')) };
    expect(contextLinks(text, 'source.md', metadata).map(link => link.raw)).toEqual(['[[real]]']);
    const start = text.indexOf('[[fenced]]');
    expect(contextLinks(text, 'source.md', metadata, start, start + '[[fenced]]'.length)).toEqual([]);
    expect(metadata.getFirstLinkpathDest.mock.calls).toEqual([['real', 'source.md']]);
  });
});
