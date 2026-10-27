# Architecture

wikiship is a desktop Obsidian plugin. `src/context` reads the current editor selection, cursor, and section metadata; `src/provenance` owns state and mutations; `src/review` supplies native views and CodeMirror gutters; `src/mcp` owns the local MCP endpoint and tools.

## Live editor context

Each call captures the active editor's text, selection, cursor, and path, then validates that they still match after asynchronous policy/content checks. Reads prefer a consistent live editor buffer and identify their source and whole-file hash. Selection responses include the exact selected text and source-aware link metadata.

Editor state returns section heading ancestry and UTF-16 ranges, not the section body. The bounded file-state tool reads saved bytes; a client must compare its hash with the editor hash before using its excerpt for an editor edit. A missing editor is reported explicitly with no invented selection. Switching tabs changes the context of the next call.

Current heading positions come from the established Lezer Markdown parser because Obsidian's asynchronous metadata cache does not expose a synchronous parse of an unsaved buffer. It handles standard ATX/setext headings, fences, and exclusion of YAML frontmatter. It does not model rich artifact elements. Paths and headings in returned context are data, not instructions.

## Mutation transaction

1. Serialize wikiship operations through a queue.
2. Check a vault-relative path, symlinks, exclusions, size, absence/precondition hash, and destination.
3. Save a `prepared` operation with before/after content and hashes before editing or moving a file.
4. Recheck the file and its open editors. Use Obsidian `Vault.process`/`DataAdapter.process` for guarded text updates, and vault APIs for creation and rename. A delete is recorded as `pending-delete`; the file stays in the vault until a human approves the batch.
5. Save the resulting state, expose the change for review, and refresh the UI. On approval, move staged deletions to trash, then remove that batch's journal records.

The journal uses a temporary file, file fsync, atomic rename, and directory fsync where supported. A per-process lock rejects simultaneous journal writers. A populated `state.lock.guard` directory is published atomically before the backward-compatible `state.lock` file; recovery removes only a confirmed dead local owner’s uniquely named guard record. This serializes stale-file recovery, while delayed reclaimers cannot remove a replacement owner’s record. Owner records are fully written before publication. Live or unverifiable owners are never reclaimed. External changes to the saved state are detected before replacing it. Corrupt state prevents plugin startup and is preserved for repair. Snapshot bytes, sizes, encodings, and hashes are validated on load.

Failure to persist an intent means no file mutation occurs. Failure to finalize a mutation blocks further writes until recovery reloads authoritative saved state. Recovery compares both sides of an interrupted operation; it never guesses from a watcher event. Ambiguous partial moves remain `uncertain`. A recorded direction distinguishes an interrupted forward operation from an interrupted undo.

Obsidian APIs cannot provide a cross-process transaction with arbitrary shell writers or sync engines. Hash checks and editor checks detect ordinary intervening changes, but cannot promise immunity to an independent process changing a path in the final filesystem race window. Do not run competing writers against the same files during destructive operations. This is a local cooperative workspace, not a filesystem sandbox or distributed transaction system.

## Review, undo, and clear

The journal is a pending review queue, not a permanent history. The panel groups file-level net diffs by the optional self-reported MCP session label; unlabeled calls share an unlabeled batch. Session timestamps remain visible. Moved paths are shown as the original path, an arrow on its own line, then the destination path. Each file's operation history and recovery snapshots are expandable. Before/after displays render literal text; file content is never interpreted as executable HTML. Diff calculations are bounded. Large text uses 50,000-character pages so every part remains inspectable without rendering the entire file at once.

Undoing one change or a session requires the current file to match the recorded state, checks any destination is absent, persists reverse intent, then restores the previous state. Newer human content in either disk or an open editor causes a conflict. Sessions undo newest first and stop at the first conflict without overwriting newer content. Approving a batch leaves edits/creates/moves in place, moves staged deletions to trash, and removes the batch records. Undo also removes the records. Once cleared, wikiship cannot restore them.

Gutter positions are derived only through verified journal hash chains. Unknown human changes suppress precise markers instead of putting them on unrelated text; the sidebar continues to show the recorded operation. Multiple machine-mind edits can move earlier marker locations through a known chain. Deletions retain a marker at the checked deletion point and preserve their text in the diff.

## MCP and trust boundary

`src/mcp/server.ts` starts a Streamable HTTP MCP server on `127.0.0.1:27126`. It authenticates every MCP request with a random bearer token saved in wikiship's plugin data. A local-origin check and loopback bind reduce browser and network exposure. The server registers wikiship's explicit tools only; it has no arbitrary Obsidian command runner or raw write endpoint. Six read/search tools use Obsidian vault and metadata APIs, while all mutation tools call the journal.

The endpoint is available only while the desktop vault and wikiship are running. Codex and other same-machine local MCP clients can connect directly over HTTP. Hosted/cloud agents cannot reach the loopback address. The copied Codex TOML contains the bearer token and should be treated as local credential data. A client with separate shell or filesystem access can still write outside wikiship; such edits are not attributed. Human review/undo/approval tools are not exposed to agents. Optional agent/session strings remain self-reported labels, not authenticated client identity.

## Storage, projects, and sync

Files remain in the original vault/project. There is no import, proprietary document format, search index, cloud service, model provider, or sync layer. Default generated-directory exclusions apply only to wikiship. Users edit these rules in wikiship settings; Obsidian configuration is otherwise untouched.

`<configDir>/plugins/wikiship/state.json` holds pending review records and their temporary before/after content. Clearing the last session replaces the payload with an empty journal; no change history remains in wikiship. There is no automatic expiry: pending records stay until you undo or clear them. `state.lock` and `state.lock.guard` enforce the local writer lock; both are ownership metadata, not journal backups. Keep the journal out of concurrent multi-device writes. When state changes externally, wikiship stops instead of silently merging it.
