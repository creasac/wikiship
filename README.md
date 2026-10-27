# wikiship

An Obsidian desktop plugin for live editor context and reviewable changes from external agents. Open an ordinary notes folder or project directory as a vault; the files remain canonical.

wikiship adds live selection and cursor context, controlled MCP mutations, a local operation journal, and a native machine minds' changes view. Your choice of agent, model, and sync tool stays yours.

## Install

Requires **Obsidian 1.13.7+ desktop**. wikiship includes its own authenticated MCP server; no companion plugin, Node.js installation, bridge, cloud account, or hosted service is needed.

Install wikiship from **Settings → Community plugins → Browse** when it is published. For development, build it and copy `main.js`, `manifest.json`, and `styles.css` from `obsidian-plugin/` into `<vault>/.obsidian/plugins/wikiship/`.

```sh
npm ci
npm run check
```

Enable wikiship. Its local MCP server starts automatically when the plugin loads. To connect the ChatGPT desktop app, choose **Copy Codex config** in Obsidian under **Settings → wikiship → Connect Codex**. In the desktop app, open **Settings → Configuration → Open config.toml**. Replace any existing `[mcp_servers.wikiship]` entry (including old `command`, `args`, or `env` settings) with the copied block, then save. Open **Settings → MCP servers** and select **Restart**. This uses the desktop app's own settings; no CLI or terminal is needed. Other local MCP clients can use the same URL and bearer token. See the [client connection guide](docs/mcp-tools.md).

## First workflow

1. Select text in the current note, or place the cursor in a section. The agent calls `wikiship_get_editor_state` to read the active file, selected text, cursor, section metadata, and hashes.
2. If needed, the agent reads a bounded saved-file excerpt with `wikiship_get_file_state`. Section metadata contains offsets and heading paths, not the section body. If disk and editor hashes differ, save or resolve that difference before editing.
3. Let the agent edit using a `wikiship_*` mutation tool. The **machine minds' changes** panel opens when the first change arrives and lists changes by session and file.
4. Review the net diff for each file, or expand its operation history for individual steps. **Undo file** restores its earlier state; **Approve session** keeps approved edits and clears wikiship's review data. A staged deletion leaves the file in place until approval, then moves it to trash.

Start your conversation in your configured local MCP client. See the [client setup and tool guide](docs/mcp-tools.md) for connection and safe-edit instructions.

The wikiship icon, right-panel tab, and clickable status bar open **machine minds' changes**. The command palette contains these six wikiship commands:

- **Show machine minds' changes**
- **Review next file**
- **Approve all changes**
- **Undo all machine minds' changes**
- **Recover interrupted operations**
- **Restart wikiship MCP server**

## What v1 guarantees

- Pending changes keep before/after content and hashes locally so you can inspect or undo them. Approval clears that review data. Deletion is staged; approval moves the file to trash.
- Live reads validate the editor, selection, and cursor across asynchronous reads. Section edits require a unique full heading path; changed targets are refused.
- File edits use Obsidian's atomic `process` API and recheck disk content and open editor buffers. Reverting is deliberately conservative: the entire file must match the recorded result.
- Journal metadata stays in the wikiship plugin directory. No provenance syntax is inserted into Markdown.

wikiship exposes only its own read tools and journal-backed mutations on a loopback-only HTTP endpoint. A client's separate shell or filesystem access can still modify vault files outside the journal. See [the exact provenance boundary](docs/architecture.md).

## Scope and limits

wikiship v1 supports local desktop vaults and files up to 5 MiB. Text editing requires valid UTF-8; binary files can be moved and staged for deletion. Approved deletions move to trash. Parent directories must already exist. wikiship skips configured generated directories, vault configuration, `.git`, `.trash`, and symlinks. These are wikiship access rules, not changes to Obsidian settings.

The local MCP server uses the fixed loopback port `27126` while wikiship is enabled. Only one wikiship vault can serve MCP on this computer at a time. If another program or another vault already uses the port, Obsidian reports that the MCP server is unavailable; wikiship does not switch ports automatically. Free the port, then run **Restart wikiship MCP server** from Obsidian's command palette. The rest of wikiship's Obsidian review features remain available while MCP is unavailable.

Undo refuses newer edits too; v1 does not attempt an automatic merge. Moves do not rewrite backlinks. Markdown headings use a standard parser against the current buffer; selection and cursor mutations recheck the observed target before writing. Rich artifact element selection, semantic wiki generation, Git integration, and sync are future work.

While changes await review, wikiship retains their recorded content in the vault's plugin data. **Undo** or **Approve** removes it; after approval, wikiship cannot restore those changes. Keep the journal out of concurrent multi-device writes; configure your own sync/backup exclusions if appropriate. wikiship does not configure sync or resolve journal sync conflicts.

- [Architecture and data safety](docs/architecture.md)
- [Development and verification](docs/development.md)
- [MCP tools and client setup](docs/mcp-tools.md)
- [Implementation scope and sources](docs/implementation-plan.md)
