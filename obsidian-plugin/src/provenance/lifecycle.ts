// Obsidian can evaluate a fresh plugin module before the previous instance has
// finished unloading. Keep only pending shutdowns on the renderer global so the
// barrier survives that reload. The on-disk writer lock remains authoritative.
const key = Symbol.for('wikiship.journal-shutdowns');
const scope = globalThis as typeof globalThis & { [key]?: Map<string, Promise<void>> };
const shutdowns = scope[key] ??= new Map<string, Promise<void>>();

export function waitForJournalShutdown(directory: string): Promise<void> {
  return shutdowns.get(directory) ?? Promise.resolve();
}

export function trackJournalShutdown(directory: string, shutdown: Promise<void>): Promise<void> {
  const pending = shutdown.finally(() => {
    // A second disable during startup can already have registered its own wait.
    if (shutdowns.get(directory) === pending) shutdowns.delete(directory);
  });
  shutdowns.set(directory, pending);
  return pending;
}
