export interface Heading { path: string[]; from: number; to: number; level: number; }
// Build full heading paths and section ranges from the current buffer parse.
export function headingRanges(headings: { heading: string; level: number; position: { start: { offset: number } } }[], length: number): Heading[] {
  const stack: { name: string; level: number }[] = [];
  return headings.map((h, i) => {
    while (stack.length && stack[stack.length - 1]!.level >= h.level) stack.pop();
    stack.push({ name: h.heading, level: h.level });
    return {
      path: stack.map(s => s.name), from: h.position.start.offset,
      to: headings.slice(i + 1).find(next => next.level <= h.level)?.position.start.offset ?? length, level: h.level,
    };
  });
}
export const sameHeading = (a: string[], b: string[]) => JSON.stringify(a) === JSON.stringify(b);
export function sectionAt(headings: Heading[], offset: number): Heading | undefined {
  return headings.filter(h => h.from <= offset && h.to > offset).at(-1);
}
