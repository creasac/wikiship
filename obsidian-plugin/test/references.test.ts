import { describe, expect, it } from 'vitest';
import { headingRanges, sameHeading, sectionAt } from '../src/context/references';

const heading = (heading: string, level: number, offset: number) => ({ heading, level, position: { start: { offset } } });

describe('current section ranges', () => {
  it('distinguishes equal heading names under different parents', () => {
    const text = '# A\n## Same\nfirst\n# B\n## Same\nsecond';
    const ranges = headingRanges([heading('A', 1, 0), heading('Same', 2, 4), heading('B', 1, text.indexOf('# B')), heading('Same', 2, text.lastIndexOf('## Same'))], text.length);
    expect(ranges.map(range => range.path)).toEqual([['A'], ['A', 'Same'], ['B'], ['B', 'Same']]);
    expect(sectionAt(ranges, text.indexOf('second'))?.path).toEqual(['B', 'Same']);
    expect(sectionAt(ranges, text.indexOf('# B'))?.path).toEqual(['B']);
    expect(sameHeading(ranges[1]!.path, ranges[3]!.path)).toBe(false);
  });
  it('includes nested sections until the next heading at the same or higher level', () => {
    const text = '# A\n## Part\n### Child\ncontent\n## Next\nend';
    const ranges = headingRanges([heading('A', 1, 0), heading('Part', 2, 4), heading('Child', 3, 12), heading('Next', 2, text.indexOf('## Next'))], text.length);
    expect(text.slice(ranges[1]!.from, ranges[1]!.to)).toBe('## Part\n### Child\ncontent\n');
    expect(sectionAt(ranges, text.indexOf('content'))?.path).toEqual(['A', 'Part', 'Child']);
    expect(sectionAt([], 0)).toBeUndefined();
  });
});
