# wikiship implementation scope

## Current architecture

- Obsidian supplies editor state, vault APIs, `Vault.process`, workspace views, and editor extensions. Keep Obsidian and CodeMirror external in the plugin bundle.
- wikiship bundles the MCP SDK and starts its own Streamable HTTP server on loopback. A generated bearer token authenticates the endpoint. The exposed list is limited to wikiship's six read/search tools and journal-backed mutations.
- No companion plugin, external bridge, user-installed Node.js runtime, public endpoint, or cloud service is required. Codex setup is a copy/paste of the endpoint and token into its local MCP config.

## Current milestones

1. Plugin skeleton and live context: current editor selection/cursor/file, section metadata, source-aware link resolution, and guarded editor targets.
2. Standalone MCP server: validated tool schemas, loopback-only HTTP listener, token authentication, Obsidian-backed read tools, and real MCP SDK client verification.
3. Provenance: serialized operations; durable intent before mutation; before/after snapshots and hashes; guarded create/edit/delete/move; restart recovery and explicit uncertain states.
4. Review queue: auto-opening side panel, session grouping, before/after diff, staged deletion approval, guarded undo, and explicit clear that removes pending records. Never write markers into notes.
5. Client setup and acceptance: one-copy Codex setup and generic HTTP MCP instructions; build/type checks; safety tests; exact six-command palette; native Obsidian smoke test where available.

## Safety decisions

- Require expected file SHA-256 for edits/deletes/moves; create must assert absence. Never overwrite a destination.
- Undo requires the current file to match the recorded after hash. This may refuse unrelated later human edits, but preserves all newer work.
- Keep before/after content only in the pending review queue. Explicit undo or approval clears it; do not retain a wikiship history after clearing. Fail closed if journal persistence fails.
- Capture current selection offsets, editor contents, and hashes; recheck them before writing. Locate sections by unique heading paths and refuse ambiguous headings.
- Block traversal, symlinks, vault configuration/internal paths, and noisy generated directories through wikiship only. Do not edit the user's Obsidian configuration.

## Research sources

- https://github.com/obsidianmd/obsidian-api/blob/master/obsidian.d.ts
- https://docs.obsidian.md/Plugins/Editor/Editor+extensions
- https://docs.obsidian.md/Plugins/User+interface/Views
- https://codemirror.net/docs/ref/#view.gutter
