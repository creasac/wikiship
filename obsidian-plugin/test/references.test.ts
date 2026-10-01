import { describe, expect, it } from 'vitest';
import { headingRanges, pin, resolve, sectionAt } from '../src/context/references';
import { MAX_FILE_BYTES } from '../src/model';

const heading = (heading: string, level: number, offset: number) => ({ heading, level, position: { start: { offset } } });

describe('explicit current context references', () => {
  it('retains a selection across tabs and returns its exact current text', () => {
    const noteA = '# A\n\nFirst paragraph.\n\nSecond paragraph.\n\nOther text.';
    const from = noteA.indexOf('First'), to = noteA.indexOf('\n\nOther');
    const selection = pin('selection', 'a.md', noteA, from, to);
    const noteB = '# B\n\n## Storage\nCurrent design.\n\n## Later\nFuture.';
    const ranges = headingRanges([heading('B', 1, 0), heading('Storage', 2, noteB.indexOf('## Storage')), heading('Later', 2, noteB.indexOf('## Later'))], noteB.length);
    const storage = ranges[1]!, section = pin('section', 'b.md', noteB, storage.from, storage.to, storage.path);
    expect(resolve(selection, noteA)).toMatchObject({ path: 'a.md', status: 'current', content: 'First paragraph.\n\nSecond paragraph.' });
    expect(resolve(section, noteB, ranges)).toMatchObject({ path: 'b.md', status: 'current', content: '## Storage\nCurrent design.\n\n' });
  });
  it('resolves updated section content through its unique heading path', () => {
    const text = '# Project\n## Storage\nOld text\n## Sync\nOther';
    const ranges = headingRanges([heading('Project', 1, 0), heading('Storage', 2, 10), heading('Sync', 2, text.indexOf('## Sync'))], text.length);
    const original = ranges[1]!, item = pin('section', 'a.md', text, original.from, original.to, original.path);
    const changed = text.replace('Old text', 'New current content');
    const updated = headingRanges([heading('Project', 1, 0), heading('Storage', 2, 10), heading('Sync', 2, changed.indexOf('## Sync'))], changed.length);
    expect(resolve(item, changed, updated)).toMatchObject({ status: 'changed', content: '## Storage\nNew current content\n' });
  });
  it('marks renamed or duplicate headings stale', () => {
    const text = '## Topic\ntext', ranges = headingRanges([heading('Topic', 2, 0)], text.length);
    const item = pin('section', 'a.md', text, 0, text.length, ['Topic']);
    expect(resolve(item, text, [])).toMatchObject({ status: 'stale' });
    expect(resolve(item, text, [...ranges, ...ranges])).toMatchObject({ status: 'stale' });
    expect(resolve(item, text, [{ ...ranges[0]!, path: ['Renamed'] }])).toMatchObject({ status: 'stale' });
  });
  it('distinguishes equal heading names under different parents', () => {
    const text = '# A\n## Same\nfirst\n# B\n## Same\nsecond';
    const ranges = headingRanges([heading('A', 1, 0), heading('Same', 2, 4), heading('B', 1, text.indexOf('# B')), heading('Same', 2, text.lastIndexOf('## Same'))], text.length);
    expect(ranges.map(range => range.path)).toEqual([['A'], ['A', 'Same'], ['B'], ['B', 'Same']]);
    expect(sectionAt(ranges, text.indexOf('second'))?.path).toEqual(['B', 'Same']);
    expect(sectionAt(ranges, text.indexOf('# B'))?.path).toEqual(['B']);
  });
  it('relocates a selection only when its exact surrounding anchors are unique', () => {
    const prefix = 'a'.repeat(80), suffix = 'b'.repeat(80), text = prefix + 'selected' + suffix;
    const item = pin('selection', 'a.md', text, 80, 88);
    expect(resolve(item, 'inserted elsewhere\n' + text)).toMatchObject({ status: 'current', from: 99, to: 107, content: 'selected' });
    expect(resolve(item, text.replace('selected', 'human edit'))).toMatchObject({ status: 'stale' });
    expect(resolve(item, text + '\n' + text)).toMatchObject({ status: 'stale' });
    expect(resolve(item, prefix + 'selected' + 'c'.repeat(80))).toMatchObject({ status: 'stale' });
  });
  it('never trusts unchanged offsets when unrelated text occupies them', () => {
    const item = pin('selection', 'a.md', 'before selected after', 7, 15);
    expect(resolve(item, 'before replaced after')).toMatchObject({ status: 'stale' });
    expect(resolve(item, 'before replaced after')).not.toHaveProperty('content');
  });
  it('returns whole note current content with changed status', () => {
    const item = pin('note', 'a.md', 'before');
    expect(resolve(item, 'after')).toMatchObject({ status: 'changed', content: 'after', from: 0, to: 5 });
  });
  it('rejects empty selections, split emoji, incomplete note ranges and oversized pins', () => {
    expect(() => pin('selection', 'a.md', 'text', 0, 0)).toThrow('Select some text');
    expect(() => pin('selection', 'a.md', '🚢', 1, 2)).toThrow('Unicode');
    expect(() => pin('note', 'a.md', 'text', 1, 2)).toThrow('entire file');
    expect(() => pin('section', 'a.md', 'text')).toThrow('heading path');
    expect(() => pin('note', 'a.md', 'x'.repeat(MAX_FILE_BYTES + 1))).toThrow('5 MiB');
  });
});
