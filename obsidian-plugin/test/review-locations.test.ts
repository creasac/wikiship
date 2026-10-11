import { describe, expect, it } from 'vitest';
import { locationsForFile } from '../src/review/changes';
import { textSnapshot, type Operation } from '../src/model';

function edit(id: string, before: string, after: string): Operation {
  return { id, timestamp: new Date().toISOString(), kind: 'edit', path: 'note.md', before: textSnapshot(before), after: textSnapshot(after), status: 'applied' };
}

describe('trusted AI gutter locations', () => {
  it('maps earlier insertions across a verified later edit', () => {
    const first = edit('first', 'start\nend\n', 'start\nAI one\nend\n');
    const second = edit('second', first.after!.data, 'prefix\nstart\nAI one\nend\n');
    const locations = locationsForFile([first, second], 'note.md', second.after!.data);
    expect(locations.find(loc => loc.operationId === 'first')).toMatchObject({ from: 13, to: 20, kind: 'inserted' });
    expect(locations.find(loc => loc.operationId === 'second')).toMatchObject({ from: 0, to: 7 });
  });
  it('retains a deletion anchor with no surviving deleted text', () => {
    const op = edit('delete-text', 'first\nremoved\nlast', 'first\nlast');
    expect(locationsForFile([op], 'note.md', op.after!.data)).toEqual([{ operationId: op.id, from: 6, to: 6, kind: 'deleted' }]);
  });
  it('hides locations after unknown human edits and keeps operations available for review', () => {
    const op = edit('ai', 'first\n', 'first\nAI\n');
    expect(locationsForFile([op], 'note.md', 'first\nAI edited by human\n')).toEqual([]);
    expect(op.status).toBe('applied');
  });
  it('does not mark text that a later recorded edit completely replaced', () => {
    const first = edit('first', 'a\nb\n', 'a\nAI\nb\n');
    const second = edit('second', first.after!.data, 'a\nnew\nb\n');
    expect(locationsForFile([first, second], 'note.md', second.after!.data).map(loc => loc.operationId)).toEqual(['second']);
  });
  it('follows recorded moves while changes remain queued', () => {
    const first = edit('first', 'start', 'start AI');
    const moved: Operation = { ...first, id: 'move', kind: 'move', target: 'renamed.md', before: first.after, after: first.after };
    expect(locationsForFile([first, moved], 'renamed.md', moved.after!.data)).toEqual([
      { operationId: 'move', from: 0, to: 0, kind: 'modified' },
      { operationId: 'first', from: 5, to: 8, kind: 'inserted' },
    ]);
  });
});
