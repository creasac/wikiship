# wikidiff implementation scope

## Findings (2026-10-01)

The supplied workspace was empty. Its `.git` mount initially had no repository metadata and was read-only inside the sandbox. Git initialization later succeeded with an authorized escalation, so implementation and verification commits can be recorded.

- Obsidian supplies `MarkdownView.editor`, selection/cursor offsets, metadata headings, `ItemView`, vault operations, `Vault.process`, workspace/file events, and `registerEditorExtension`. Keep Obsidian and CodeMirror external in the plugin bundle.
- Local REST API 5.3.0 provides a typed extension package. `getAPI(app, manifest, 3)` and `addMcpTool(definition)` support wikidiff tools on the existing server, complete MCP errors, lifecycle cleanup, and tool-list notifications. Re-register on `obsidian-local-rest-api:loaded`.
- The public extension interface does not remove/filter the host's mutation tools. Shared-endpoint use is cooperative; a thin, allowlisted stdio bridge is required to prevent an agent connected through that bridge from invoking unjournaled host writes. It forwards to the same server, without another network listener.

## Current milestones

1. Plugin skeleton and live context: current editor selection/cursor/file, section metadata, source-aware link resolution, and guarded editor targets.
2. MCP extension: validated tool schemas, version/load handling, authenticated host transport, allowlisted client adapter, real MCP SDK client verification.
3. Provenance: serialized operations; durable intent before mutation; before/after snapshots and hashes; guarded create/edit/delete/move; restart recovery and explicit uncertain states.
4. Review queue: auto-opening side panel, session grouping, before/after diff, staged deletion approval, guarded undo, and explicit clear that removes pending records. Never write markers into notes.
5. Client setup and acceptance: client-neutral MCP connection and live-context instructions; build/type checks; safety tests; exact six-command palette; native Obsidian smoke test where available.

## Safety decisions

- Only calls through wikidiff mutation tools receive AI attribution. Watcher events are not a source of attribution.
- Require expected file SHA-256 for edits/deletes/moves; create must assert absence. Never overwrite a destination.
- Undo requires the current file to match the recorded after hash. This may refuse unrelated later human edits, but preserves all newer work.
- Keep before/after content only in the pending review queue. Explicit undo or approval clears it; do not retain a wikidiff history after clearing. Fail closed if journal persistence fails.
- Capture current selection offsets, editor contents, and hashes; recheck them before writing. Locate sections by unique heading paths and refuse ambiguous headings.
- Block traversal, symlinks, vault configuration/internal paths, and noisy generated directories through wikidiff only. Do not edit the user's Obsidian configuration.

## Research sources

- https://github.com/obsidianmd/obsidian-api/blob/master/obsidian.d.ts
- https://docs.obsidian.md/Plugins/Editor/Editor+extensions
- https://docs.obsidian.md/Plugins/User+interface/Views
- https://github.com/coddingtonbear/obsidian-local-rest-api/blob/main/src/publicApi.ts
- https://github.com/coddingtonbear/obsidian-local-rest-api-sample-api-extension
- https://codemirror.net/docs/ref/#view.gutter
