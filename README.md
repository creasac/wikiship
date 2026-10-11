# wikiship

An Obsidian desktop plugin for live editor context and reviewable changes from external agents. Open an ordinary notes folder or project directory as a vault; the files remain canonical.

wikiship adds live selection and cursor context, controlled MCP mutations, a local operation journal, and a native AI Changes view. Your choice of agent, model, and sync tool stays yours.

## Install for development

Requires **Obsidian 1.13.1+**, **Local REST API with MCP 5.3.0+**, and Node.js 22+ for development/the optional MCP bridge.

```sh
npm ci
npm run check
```

Copy these three files into `<your vault>/.obsidian/plugins/wikiship/` (use your vault's configured configuration directory if different):

- `obsidian-plugin/main.js`
- `obsidian-plugin/manifest.json`
- `obsidian-plugin/styles.css`

Enable **wikiship** and **Local REST API with MCP** under Community plugins. wikiship's review UI works without an agent connection. The status bar reports its MCP registration. Configure your external client using [the MCP connection guide](docs/mcp-tools.md).

## First workflow

1. Select text in the current note, or place the cursor in a section. The agent calls `wikiship_get_editor_state` to read the active file, selected text, cursor, section metadata, and hashes.
2. If needed, the agent reads a bounded saved-file excerpt with `wikiship_get_file_state`. Section metadata contains offsets and heading paths, not the section body. If disk and editor hashes differ, save or resolve that difference before editing.
3. Let the agent edit using a `wikiship_*` mutation tool. The edit appears immediately; a subtle gutter marker and the **AI Changes** sidebar identify the unreviewed operation.
4. Click the marker or sidebar change to inspect its diff. **Mark reviewed** dismisses its marker; **Revert this change** remains available afterward. Revert refuses newer file or editor content.

Start your conversation in your configured MCP client. See the [client setup and tool guide](docs/mcp-tools.md) for connection and safe-edit instructions.

The ribbon opens **AI Changes**. The command palette contains these six wikiship commands:

- **Show AI Changes**
- **Next unreviewed AI change**
- **Mark all AI changes reviewed**
- **Revert all AI changes in current file**
- **Recover interrupted operations**
- **Reconnect Local REST API**

## What v1 guarantees

- Only calls through wikiship's mutation interface receive AI attribution. Human typing, sync events, and external filesystem writes never become AI changes just because a watcher observed them.
- Edits, creates, deletions, and moves record durable before/after snapshots and SHA-256 hashes. Deleted binary files retain their original bytes for restoration.
- Live reads validate the editor, selection, and cursor across asynchronous reads. Section edits require a unique full heading path; changed targets are refused.
- File edits use Obsidian's atomic `process` API and recheck disk content and open editor buffers. Reverting is deliberately conservative: the entire file must match the recorded result.
- Journal metadata stays in the wikiship plugin directory. No provenance syntax is inserted into Markdown.

The host's shared MCP endpoint also contains untracked writes. The included stdio bridge exposes a fixed list of wikiship tools and inspected host read/search tools; all write tools exposed by that bridge go through the journal. It does not restrict a client's separate shell or filesystem tools. See [the exact provenance boundary](docs/architecture.md).

## Scope and limits

wikiship v1 supports local desktop vaults and files up to 5 MiB. Text editing requires valid UTF-8; binary files can be moved, deleted, and restored. Parent directories must already exist. wikiship skips configured generated directories, vault configuration, `.git`, `.trash`, and symlinks. These are wikiship access rules, not changes to Obsidian settings.

Revert rejects unrelated newer edits too; v1 does not attempt an automatic merge. Moves do not rewrite backlinks. Markdown headings use a standard parser against the current buffer; selection and cursor mutations recheck the observed target before writing. Rich artifact element selection, semantic wiki generation, Git integration, and sync are future work.

Full snapshots may contain sensitive or deleted content and accumulate until deliberately removed outside the running plugin. Keep the journal out of concurrent multi-device writes; configure your own sync/backup exclusions if appropriate. wikiship does not configure sync or resolve journal sync conflicts.

- [Architecture and data safety](docs/architecture.md)
- [Development and verification](docs/development.md)
- [MCP tools and client setup](docs/mcp-tools.md)
- [Implementation scope and sources](docs/implementation-plan.md)
