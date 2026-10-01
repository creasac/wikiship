# WikiShip v1 implementation plan

## Findings (2026-10-01)

The supplied workspace was empty. Its `.git` mount initially had no repository metadata and was read-only inside the sandbox. Git initialization later succeeded with an authorized escalation, so implementation and verification commits can be recorded.

- Obsidian supplies `MarkdownView.editor`, selection/cursor offsets, metadata headings, `ItemView`, vault operations, `Vault.process`, workspace/file events, and `registerEditorExtension`. Keep Obsidian and CodeMirror external in the plugin bundle.
- Local REST API 5.3.0 provides a typed extension package. `getAPI(app, manifest, 3)` and `addMcpTool(definition)` support WikiShip tools on the existing server, complete MCP errors, lifecycle cleanup, and tool-list notifications. Re-register on `obsidian-local-rest-api:loaded`.
- The public extension interface does not remove/filter the host's mutation tools. Shared-endpoint use is cooperative; a thin, allowlisted stdio bridge is required to prevent an agent connected through that bridge from invoking unjournaled host writes. It forwards to the same server, without another network listener.
- Codex launch URL parameters require verification against current documentation/source. Keep the adapter isolated and provide a copy-prompt fallback if platform support is unavailable. Never simulate typing or submission.

## Milestones

1. Plugin skeleton and context basket: persisted note/section/selection references; live editor state; stale detection; native commands and context menus.
2. MCP extension: validated tool schemas, version/load handling, authenticated host transport, allowlisted client adapter, real MCP SDK client verification.
3. Provenance: serialized operations; durable intent before mutation; before/after snapshots and hashes; guarded create/edit/delete/move; restart recovery and explicit uncertain states.
4. Review: sidebar, before/after diff, review state, conservative revert and file-wide revert; subtle interactive CodeMirror gutter markers. Never write markers into notes.
5. Handoff and acceptance: isolated Codex adapter, folder path and context instructions; build/type checks; safety tests; MCP workflow; native Obsidian smoke test where available.

## Safety decisions

- Only calls through WikiShip mutation tools receive AI attribution. Watcher events only refresh references/UI.
- Require expected file SHA-256 for edits/deletes/moves; create must assert absence. Never overwrite a destination.
- For v1, reverting an edit requires the entire file to match the recorded after hash. This may refuse unrelated later human edits, but preserves all newer work.
- Persist full snapshots locally in plugin data; do not prune unreviewed or recoverable records automatically. Fail closed if journal persistence fails.
- Keep selections anchored by original offsets plus surrounding text/hash; ambiguous or modified selections are stale. Resolve sections by unique heading path and invalidate ambiguous headings.
- Block traversal, symlinks, vault configuration/internal paths, and noisy generated directories through WikiShip only. Do not edit the user's Obsidian configuration.

## Research sources

- https://github.com/obsidianmd/obsidian-api/blob/master/obsidian.d.ts
- https://docs.obsidian.md/Plugins/Editor/Editor+extensions
- https://docs.obsidian.md/Plugins/User+interface/Views
- https://github.com/coddingtonbear/obsidian-local-rest-api/blob/main/src/publicApi.ts
- https://github.com/coddingtonbear/obsidian-local-rest-api-sample-api-extension
- https://codemirror.net/docs/ref/#view.gutter
- https://learn.chatgpt.com/docs/developer-commands
