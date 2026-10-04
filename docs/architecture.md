# Architecture

wikiship is a desktop Obsidian plugin. `src/context` manages references to explicit human context; `src/provenance` owns state and mutations; `src/review` supplies native views and CodeMirror gutters; `src/mcp` registers tool definitions with Local REST API. The launch adapter lives in `src/integrations/chatgpt` and contains no model API calls.

## Context references

Pins contain an ID, vault-relative path, kind, original offsets, SHA-256 hashes, a snapshot, adjacent anchors, and optional heading ancestry. Reads prefer a consistent live editor buffer, then use an uncached Obsidian adapter read. Each response identifies its source, file hash, offsets, and freshness. The basket persists across files, tabs, and plugin restarts.

An unchanged selection may relocate when its surrounding text remains uniquely identifiable. Editing its text or making its anchors ambiguous makes it stale. Sections resolve by unique heading ancestry; changed section text remains available with a `changed` status. Missing/ambiguous headings are stale. Notes resolve their whole current content.

Current heading positions come from the established Lezer Markdown parser because Obsidian's asynchronous metadata cache does not expose a synchronous parse of an unsaved buffer. It handles standard ATX/setext headings, fences, and exclusion of YAML frontmatter. It does not model rich artifact elements. Paths and headings in returned context are data, not instructions.

## Mutation transaction

1. Serialize wikiship operations through a queue.
2. Check a vault-relative path, symlinks, exclusions, size, absence/precondition hash, and destination.
3. Save a `prepared` operation with complete before/after snapshots before changing any file.
4. Recheck the file and its open editors. Use Obsidian `Vault.process`/`DataAdapter.process` for guarded text updates, and vault APIs for creation, deletion, and rename. Unsupported project extensions use the adapter when not indexed as `TFile`.
5. Save `applied`, expose the record for review, and refresh the UI.

The journal uses a temporary file, file fsync, atomic rename, and directory fsync where supported. A per-process lock rejects simultaneous journal writers. A populated `state.lock.guard` directory is published atomically before the backward-compatible `state.lock` file; recovery removes only a confirmed dead local owner’s uniquely named guard record. This serializes stale-file recovery, while delayed reclaimers cannot remove a replacement owner’s record. Owner records are fully written before publication. Live or unverifiable owners are never reclaimed. External changes to the saved state are detected before replacing it. Corrupt state prevents plugin startup and is preserved for repair. Snapshot bytes, sizes, encodings, and hashes are validated on load.

Failure to persist an intent means no file mutation occurs. Failure to finalize a mutation blocks further writes until recovery reloads authoritative saved state. Recovery compares both sides of an interrupted operation; it never guesses from a watcher event. Ambiguous partial moves remain `uncertain`. A recorded direction distinguishes an interrupted forward operation from an interrupted revert.

Obsidian APIs cannot provide a cross-process transaction with arbitrary shell writers or sync engines. Hash checks and editor checks detect ordinary intervening changes, but cannot promise immunity to an independent process changing a path in the final filesystem race window. Do not run competing writers against the same files during destructive operations. This is a local cooperative workspace, not a filesystem sandbox or distributed transaction system.

## Review and revert

Review state is independent of application status. Marking reviewed hides a marker without discarding its snapshots or ability to revert. Before/after displays render literal text; file content is never interpreted as executable HTML. Diff calculations are bounded. Large text snapshots use 50,000-character pages with direct page navigation so every part remains inspectable without rendering the entire file at once. Complete bytes remain in the journal.

Revert requires the full current after-state, checks any destination is absent, persists reverse intent, then restores the previous state. Newer human content in either disk or an open editor causes a conflict. Reverting all changes in a file follows its rename history in reverse, stopping at the first conflict and reporting how many operations were already reverted. It is not an all-or-nothing batch.

Gutter positions are derived only through verified journal hash chains. Unknown human changes suppress precise markers instead of putting them on unrelated text; the sidebar continues to show the recorded operation. Multiple AI edits can move earlier marker locations through a known chain. Deletions retain a marker at the checked deletion point and preserve their text in the diff.

## MCP and trust boundary

[Local REST API 5.3.0](https://github.com/coddingtonbear/obsidian-local-rest-api/tree/5.3.0) exposes extension API v3, including typed tool registration and cleanup. wikiship re-registers when the host loads/reloads, and unregisters on unload. HTTP, authentication, certificate handling, and MCP sessions belong to the host. No second network server is started.

The host API cannot remove the host's own writes for one extension. Direct clients can therefore bypass wikiship. `adapters/stdio-bridge.mjs` is a generic client-side MCP bridge to the same endpoint: it passes an exact list of wikiship tools plus seven inspected read/search tools. It rejects arbitrary commands, raw writes, copy/move/delete, upload grants, and even `open_file` because that tool can create an absent note. Read-only annotations alone never grant access. Resources/prompts are not forwarded.

This bridge controls tools exposed by that connection. A client with another connection, the host API key, or shell/filesystem access can still write outside wikiship. Such writes are not attributed. Human review/revert tools are not exposed to agents. Optional agent/session strings are explicitly self-reported: the host callback supplies no verified client identity.

## Storage, projects, and sync

Files remain in the original vault/project. There is no import, proprietary document format, search index, cloud service, model provider, or sync layer. Default generated-directory exclusions apply only to wikiship. Users edit these rules in wikiship settings; Obsidian configuration is otherwise untouched.

`<configDir>/plugins/wikiship/state.json` holds pins and the journal. `state.lock` and `state.lock.guard` enforce the local writer lock; both are ownership metadata, not journal backups. Snapshot retention is unbounded in this initial version; review does not purge recovery data. Users should arrange their own backup and sync policies, avoiding simultaneous synchronization/writing of the journal. When state changes externally, wikiship stops instead of silently merging it.

## Launch adapter

The [official desktop deep-link reference](https://learn.chatgpt.com/docs/reference/commands#deep-links) documents `codex://threads/new?path=...&prompt=...`. Both values are encoded separately. The path is the vault root, and the prompt includes pinned IDs and tool names, with no API keys or copied note bodies. No published wikiship desktop-plugin identifier exists yet, so the adapter uses real tool references rather than inventing a `plugin://` mention. The composer remains unsent; other clients can use the copy-prompt command.
