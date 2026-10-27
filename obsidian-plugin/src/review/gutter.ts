import { RangeSetBuilder, StateEffect, type Extension } from '@codemirror/state';
import { EditorView, gutter, GutterMarker, ViewPlugin, type ViewUpdate } from '@codemirror/view';
import { editorInfoField } from 'obsidian';
import type { Journal } from '../provenance/journal';
import { locationsForFile, type ChangeLocation } from './changes';

const refresh = StateEffect.define<null>();

class ChangeMarker extends GutterMarker {
  constructor(readonly locations: ChangeLocation[]) { super(); }
  eq(other: ChangeMarker) { return this.locations.map(l => l.operationId + l.kind).join() === other.locations.map(l => l.operationId + l.kind).join(); }
  toDOM(view: EditorView) {
    const marker = view.dom.createEl('button');
    marker.detach();
    const first = this.locations[0]!;
    marker.className = `wikiship-gutter-marker wikiship-gutter-${first.kind}`;
    marker.type = 'button';
    marker.textContent = first.kind === 'inserted' ? '+' : first.kind === 'deleted' ? '−' : '◆';
    const label = `Inspect ${this.locations.length > 1 ? this.locations.length + " queued machine minds' changes" : "queued machine minds' change"}`;
    marker.setAttribute('aria-label', label);
    marker.dataset.wikishipOperation = first.operationId;
    return marker;
  }
}

export function createReviewExtension(journal: Journal, inspect: (operationId: string) => void): { extension: Extension; destroy(): void } {
  let operations = journal.state.operations, disposed = false;
  const views = new Set<EditorView>();
  const unsubscribe = journal.subscribe(() => {
    operations = journal.state.operations;
    // Journal writes can complete inside an editor update. Dispatch on the next microtask.
    queueMicrotask(() => {
      if (!disposed) for (const view of views) view.dispatch({ effects: refresh.of(null) });
    });
  });
  function build(view: EditorView) {
    const builder = new RangeSetBuilder<GutterMarker>();
    const path = view.state.field(editorInfoField, false)?.file?.path;
    if (!path) return builder.finish();
    const positions = new Map<number, ChangeLocation[]>();
    for (const location of locationsForFile(operations, path, view.state.doc.toString())) {
      const from = Math.min(view.state.doc.length, location.from), to = Math.min(view.state.doc.length, location.to);
      let line = view.state.doc.lineAt(from);
      const last = view.state.doc.lineAt(to > from ? to - 1 : from).number;
      for (;;) {
        const group = positions.get(line.from) ?? [];
        group.push(location); positions.set(line.from, group);
        if (line.number >= last) break;
        line = view.state.doc.line(line.number + 1);
      }
    }
    for (const [position, locations] of [...positions].sort(([a], [b]) => a - b)) builder.add(position, position, new ChangeMarker(locations));
    return builder.finish();
  }
  const plugin = ViewPlugin.fromClass(class {
    markers;
    private path?: string;
    constructor(private view: EditorView) {
      views.add(view); this.markers = build(view); this.path = view.state.field(editorInfoField, false)?.file?.path;
    }
    update(update: ViewUpdate) {
      const path = update.state.field(editorInfoField, false)?.file?.path;
      if (update.docChanged || update.transactions.some(t => t.effects.some(effect => effect.is(refresh))) ||
        this.path !== path) this.markers = build(update.view);
      this.path = path;
    }
    destroy() { views.delete(this.view); }
  });
  const operationForEvent = (event: Event) => {
    const target = event.target as Element | null;
    return typeof target?.closest === 'function' ? target.closest<HTMLElement>('[data-wikiship-operation]')?.dataset.wikishipOperation : undefined;
  };
  // Use CodeMirror's persistent gutter event surface. Obsidian may replace marker
  // DOM while changing focus; operation attributes survive that replacement.
  const preserveEditor = (_view: EditorView, _line: unknown, event: Event) => {
    if (!operationForEvent(event)) return false;
    event.stopPropagation(); return true;
  };
  return {
    extension: [plugin, gutter({
      class: 'wikiship-gutter', markers: view => view.plugin(plugin)?.markers ?? [],
      domEventHandlers: {
        pointerdown: preserveEditor, mousedown: preserveEditor,
        click: (_view, _line, event) => {
          const operationId = operationForEvent(event);
          if (!operationId) return false;
          event.stopPropagation(); inspect(operationId); return true;
        },
      },
    })],
    destroy() { disposed = true; unsubscribe(); views.clear(); },
  };
}
