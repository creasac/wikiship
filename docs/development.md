# Development and verification

## Build

Use Node.js 22+ and npm:

```sh
npm ci
npm run typecheck
npm test
npm run build
```

`npm run check` runs those final three checks together. `npm run dev -w obsidian-plugin` watches the plugin source. Reload the plugin in Obsidian after a build. The production bundle externalizes Obsidian and CodeMirror; bundling a second CodeMirror instance would break editor extensions.

The Local REST API npm package supplies only its small extension helper and public types; users install the actual host plugin separately. The repository pins compatible Obsidian/CodeMirror types and includes the npm lockfile. Host 5.3.0 requires Obsidian 1.13.1 or later, which is also wikiship's declared minimum.

## Automated checks

The tests cover:

- Live selections, source-aware links, unique section ancestry, real Markdown heading parsing, and editor-state races.
- Opaque legacy pin/state preservation through load, edits, review, revert, and restart; removed MCP names rejected by both plugin and bridge.
- MCP schema publication and calls through an actual MCP SDK client, plus the bridge's fixed allowlist and rejection of untracked writes.
- Write-ahead intent, concurrent mutation serialization, snapshot integrity, deletion recovery, binary preservation, and safe inverse operations.
- Persistence failures before/after file writes, restart recovery, uncertain partial moves, inverse recovery direction, shutdown drain, and corrupted saved state.
- Path traversal, symlinks, journal writer locks, external journal changes, and actual atomic store persistence in temporary directories.
- Full process exit and forced termination, recovery of interrupted mutation intent, six simultaneous dead-owner reclaimers, delayed reclaimers, old-plugin contention, and preservation of live/foreign/unverifiable locks in synthetic subprocess fixtures.
- Rapid plugin disable/re-enable across module reloads, accepted-write draining, cancellation during startup, and preservation of live locks when startup or cleanup fails (synthetic vaults, mocked desktop UI).
- Gutter positions through verified edit/move chains and suppression after unknown edits; complete snapshot paging without splitting Unicode characters or CRLF pairs.
- Registration of exactly the six supported review/recovery/connection commands; no pin or agent-launch commands.

Unit tests use a small Obsidian stub because the npm package contains public declarations rather than the desktop runtime. They do not claim to prove desktop integration by themselves.

## Native acceptance harness

`scripts/obsidian-smoke.mjs` runs against the real Obsidian application and the official Local REST API plugin, using a fresh temporary vault/profile and an SDK Streamable HTTP MCP client. It does not use a personal vault or edit the installed app. It writes a verification report and screenshot under `artifacts/`.

The current fixture targets Obsidian **1.13.7** and Local REST API **5.3.0**. Obtain the desktop runtime and `obsidian-1.13.7.asar.gz` from the [official Obsidian release](https://github.com/obsidianmd/obsidian-releases/releases/tag/v1.13.7). Put the compressed ASAR in a temporary downloads directory. From the [official Local REST API release](https://github.com/coddingtonbear/obsidian-local-rest-api/releases/tag/5.3.0), save `main.js` there as `rest-main.js` and `manifest.json` as `rest-manifest.json`. Use a compatible desktop runtime; loading the newer ASAR into an old Electron installer is insufficient.

```sh
npm run build
WIKISHIP_OBSIDIAN_EXECUTABLE=/absolute/path/to/obsidian \
WIKISHIP_SMOKE_DOWNLOADS=/absolute/path/to/downloads \
xvfb-run -a node scripts/obsidian-smoke.mjs
```

The default fixture HTTP port is `29123`; set `WIKISHIP_SMOKE_PORT` if it is already in use. Production Electron disables the main-process inspector used by Playwright's Electron launcher, so the harness attaches to the disposable app's Chromium DevTools endpoint. It verifies actual commands, editor content, sidebar controls, and MCP calls rather than relying on mocked Obsidian classes.

The fixture uses local HTTP with a randomly generated API key solely inside the disposable test profile. Normal client setup defaults to the host's authenticated HTTPS endpoint with a trusted certificate. The test's short polling loops wait for actual editor, server, or persistence state.

### Earlier native baseline — 2026-10-01

The pre-removal baseline passed TypeScript, 87 tests, a production build, and 10 native grouped checks on Obsidian 1.13.7 / Electron 43.3.0 with Local REST API 5.3.0. It had no captured renderer errors. That result applies to the former pin-based workflow and does not verify the current live-context revision.

The updated harness now checks live selection and section metadata, absence of pin commands/tools/sidebar, exact editor updates, gutter and diff review, conflict-safe revert, file operations, paged snapshot review, legacy data and journal persistence, host reload, the 19-tool bridge, and the exact six-command palette. Run it in a disposable profile before claiming native verification for this revision.

The harness writes `artifacts/obsidian-acceptance.json` and `artifacts/obsidian-acceptance.png`. Generated local artifacts are not committed.

## Manual desktop acceptance

Use a disposable ordinary project folder containing Markdown and source files. Install both plugins and connect an MCP client using the bridge guide.

1. Select two paragraphs in note A. Fetch live editor state and verify the exact selection, offsets, hash, and link metadata. Switch to note B; the next read must describe B.
2. Put the cursor in a section in B. Verify its heading path/range; read its saved body with `wikiship_get_file_state` and compare hashes. Move the selection/cursor after reading and verify a mutation using the old target is refused.
3. Change B through a wikiship tool. Verify immediate editor update, subtle gutter marker, sidebar entry, and literal before/after diff.
4. Mark reviewed, then revert. Confirm review status does not prevent a safe revert.
5. Repeat an AI edit, then type a human change before reverting. Verify a conflict and preservation of the human edit.
6. Create, move, rename, and delete a file through MCP; inspect and restore it. Repeat delete/restore with a binary file within the 5 MiB limit.
7. Verify ordinary typing and direct external writes create no AI journal entry.
8. Disable/re-enable the host and wikiship in either order. Verify tools are cleaned up and registered once, and journal plus any legacy pin data survives. Confirm that pin commands, basket tools, and the basket sidebar are absent.
9. Verify the palette contains exactly the six commands listed in the [README](../README.md), with no pin or agent-launch commands. Use your configured MCP client directly.

## Operational notes

If a mutation reports finalization failure, do not repeat it blindly. Inspect **AI Changes** and run **Recover interrupted operations**. If recovery reports uncertainty, inspect the saved before/after states and resolve the filesystem state before retrying. Recovery never overwrites files.

During disable/re-enable in the same Obsidian renderer, startup waits for the previous wikiship instance to finish accepted operations and release its own journal lock. This wait survives plugin module reloads and does not delay other vaults. Disabling a still-starting instance cancels further setup and waits for any in-flight lock acquisition before cleanup. This in-process wait is separate from the dead-owner recovery below.

If plugin startup rejects `state.json`, preserve it and repair from a known backup; do not replace it with an empty object. After a process exits before asynchronous cleanup finishes, wikiship automatically recovers a lock only when its record names this host and the OS reports that its PID no longer exists. A recovery guard serializes competing reclaimers; live PIDs (including possibly reused PIDs), foreign hosts, permission errors, corrupt records, and symlinks fail closed. Preserve unverifiable locks for inspection. Never delete a lock while another instance may be using it. Keep the journal and its locks local to one host; synchronization of plugin state is unsupported. Filesystems without the required exclusive hard-link/directory operations fail closed.

The journal retains complete snapshots, including deleted content. There is no automatic pruning or journal sync merge in v1. A later retention/export feature should preserve recovery data until the user explicitly discards it.
