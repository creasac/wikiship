# WikiShip MCP tools

WikiShip registers its tools on **Local REST API with MCP 5.3.0 or later**, using the package's public `getAPI(app, manifest, 3)` and `addMcpTool(definition)` APIs. Enable both plugins in the same desktop vault. WikiShip's status bar reports whether registration succeeded; the **Reconnect Local REST API** command retries registration. Unloading WikiShip unregisters its tools.

The host owns HTTP, authentication, protocol negotiation, and sessions. WikiShip does not open another network listener. Public extension API documentation: [Local REST API extension interface](https://github.com/coddingtonbear/obsidian-local-rest-api/blob/main/src/publicApi.ts).

## Recommended client connection

The host's shared MCP endpoint also exposes its own file writes and arbitrary Obsidian command execution. Its extension API does not provide a per-extension permission boundary to disable these. A direct connection therefore relies on an agent following instructions to use WikiShip mutations.

Use the included **tools-only stdio bridge** when configuring an agent for attributed work. It connects to the same host endpoint and forwards the exact 18 WikiShip tools listed below and seven inspected host read tools: `vault_list`, `vault_read`, `vault_get_document_map`, `active_file_get_path`, `search_query`, `search_simple`, and `tag_list`. This reuses the host’s reading, structure, metadata, and Obsidian search capabilities. It refuses host write tools, command execution, unknown names, and names that merely start with `wikiship_`. It exposes no host resources or prompts. Host read tools follow the host’s access policy; WikiShip’s directory exclusions govern its own context and mutation tools, not host search results. Calls through another MCP connection, shell tools, or direct filesystem access are outside this boundary and do not acquire WikiShip provenance.

After `npm install` in this repository, configure a stdio MCP server with:

```json
{
  "mcpServers": {
    "wikiship": {
      "command": "/absolute/path/to/node",
      "args": ["/absolute/path/to/wikiship/adapters/stdio-bridge.mjs"],
      "env": {
        "WIKISHIP_MCP_URL": "https://127.0.0.1:27124/mcp/",
        "WIKISHIP_API_KEY": "YOUR_LOCAL_REST_API_KEY",
        "NODE_EXTRA_CA_CERTS": "/absolute/path/to/obsidian-local-rest-api.crt"
      }
    }
  }
}
```

This JSON illustrates the common `mcpServers` format; clients with a different configuration format need the same command, argument, and environment fields. Supply the API key using your client's environment/secret configuration, never in a prompt or URL. The bridge does not log credentials.

Download the host's CA certificate using **Settings → Local REST API** and point `NODE_EXTRA_CA_CERTS` to the saved file. Node reads that environment variable when it starts. The default URL is `https://127.0.0.1:27124/mcp/`. If you explicitly enable the host's local HTTP server, `http://127.0.0.1:27123/mcp/` is also supported and does not use the CA variable. The bridge accepts loopback addresses only and refuses URL credentials, queries, fragments, and HTTP redirects. TLS verification remains enabled.

When the client lists tools, expect the installed WikiShip tools and the seven approved host read tools. `vault_write`, `command_execute`, `open_file`, and upload-URL tools must be absent. The host’s `open_file` can create a missing file, so it is deliberately excluded. Restart the client connection after changing its environment. If Obsidian restarts, reconnect the client so a new host session is negotiated.

## Context tools

Pass `{}` as the arguments for a tool with no parameters; the bridge also supplies it when a client omits arguments.

| Tool | Parameters | Result |
| --- | --- | --- |
| `wikiship_get_editor_state` | none | Active file/hash, cursor, selection offsets/content, section and open Markdown tabs; a reason when no usable editor exists. |
| `wikiship_get_selection` | none | Current selection, whole-file hash and UTF-16 offsets. |
| `wikiship_get_context` | none | Current resolved pinned items, each marked `current`, `changed` or `stale`. |
| `wikiship_context_add_selection` | none | Pin the current nonempty selection. |
| `wikiship_context_add_section` | none | Pin the section containing the current cursor. |
| `wikiship_context_add_note` | optional `path` | Pin a named UTF-8 file, or the current note. |
| `wikiship_context_remove` | `id` | Remove one pin. |
| `wikiship_context_clear` | none | Clear all pins. |

Selection responses (including `wikiship_get_editor_state.selection`) and resolved pinned items include a `links` array. Complete wikilinks/embeds and inline Markdown links within the returned passage retain their literal `raw` text. Each internal link includes `linkpath`, its original heading/block `subpath`, optional alias/label `displayText`, and the vault-relative `targetPath` returned by Obsidian's source-aware resolver. `status: "unresolved"` with `targetPath: null` means no target file was found; `resolved` confirms the file, not the existence of the heading/block. For example, `[[tmplt#Checklist|Template]]` can report `targetPath: "Templates/tmplt.md"`, `subpath: "#Checklist"`, and `displayText: "Template"` without changing the original text. These are paths, not external URLs.

Link metadata is computed when context is read; it never opens or reads linked files and does not change saved pins or journal state. Stale pins return no link targets. Code examples, escaped links, external URLs, partial links, and Markdown reference-style links are not expanded.

Selections resolve by unchanged anchored content; modified or ambiguous selections become stale. Sections resolve through a unique full heading path. Section content includes the heading and nested subsections until the next heading at the same or higher level. Stale items report a reason instead of silently returning a different passage. Pinned items persist while the human switches tabs and across plugin restarts.

## Reading mutation preconditions

`wikiship_get_file_state({path, from?, length?})` returns `exists`, `fileHash`, byte `size`, and `encoding`. UTF-8 files also return a bounded `content` excerpt, its `[from,to)` offsets, `totalLength`, and `nextOffset`. The default excerpt is 20,000 UTF-16 code units; the maximum is 100,000 per call. A missing file returns `exists: false`. Binary files return metadata/hash without their encoded content.

Use this read when the expected hash is not already available in editor state or resolved context. This is a bounded precondition/read tool for the bridge, not a second search service.

## Attributed mutation tools

All paths are vault-relative, with `/` separators. All editing offsets are zero-based **UTF-16 code units**, matching JavaScript/Obsidian, and ranges are half-open `[from,to)`. A range must not split a surrogate pair. `expectedHash` is the SHA-256 of the complete file bytes, not a selected excerpt. Read a fresh hash after each mutation.

| Tool | Required parameters | Behavior |
| --- | --- | --- |
| `wikiship_replace_range` | `path`, `expectedHash`, `from`, `to`, `content` | Replace a checked range. Equal offsets insert text. |
| `wikiship_replace_selection` | `path`, `expectedHash`, `from`, `to`, `content` | Verify the active selection still matches, then replace it. |
| `wikiship_insert_at_cursor` | `path`, `expectedHash`, `offset`, `content` | Verify the active cursor and file still match, then insert. |
| `wikiship_patch_section` | `path`, `expectedHash`, `headingPath`, `content` | Replace the unique named section in the active Markdown editor, including its heading. |
| `wikiship_create_file` | `path`, `content` | Create a UTF-8 file only if absent. |
| `wikiship_delete_file` | `path`, `expectedHash` | Preserve previous bytes in the journal, then remove the file. |
| `wikiship_move_file` | `path`, `target`, `expectedHash` | Move to an absent path. |
| `wikiship_rename_file` | `path`, `name`, `expectedHash` | Rename within the same directory; `name` cannot contain `/` or `\`. |

Every mutation also accepts optional `agent` and `session` strings. These are **self-reported labels**, not authenticated client identity. Authoritative provenance means the operation passed through a WikiShip mutation tool. The host extension callback does not provide trustworthy client/session identity.

Successful calls return the operation ID, paths, kind, status, review state, before/after hashes, and attribution labels. Full snapshots remain in the local journal for human review and recovery. A conflict, invalid argument, or write failure returns an MCP `isError` result. Do not blindly retry a failed mutation: inspect current state and the operation status first. An uncertain operation blocks subsequent writes until the human runs recovery.

Example: read `design.md`, then replace its first five UTF-16 code units using the returned hash:

```json
{"name":"wikiship_get_file_state","arguments":{"path":"design.md"}}
```

```json
{
  "name": "wikiship_replace_range",
  "arguments": {
    "path": "design.md",
    "expectedHash": "<fileHash from the preceding result>",
    "from": 0,
    "to": 5,
    "content": "Updated",
    "agent": "my-client"
  }
}
```

A section path includes every ancestor, for example `["Architecture", "Storage"]`. Selection/cursor calls deliberately require the observed offsets as well as a hash: changing selection does not change the file hash. Moves do not rewrite backlinks in other files, because those extra changes would otherwise lack recorded provenance.

## Reading the journal

`wikiship_get_changes({path?, offset?, limit?})` returns newest-first summaries, `total`, and `nextOffset`. The default limit is 20 and the maximum is 100. Supplying `path` matches either side of a move. This tool does not expose the full before/after snapshots.

Review, marking reviewed, revert, and recovery stay in the human Obsidian interface. An agent cannot approve or hide its own changes through the bridge. Revert requires the current file state to match the recorded result and refuses newer edits.

## Verified protocol behavior

`npm test` includes real MCP SDK clients over paired in-memory transports. The tests exercise the actual registered definitions and emitted schemas, pinning across files, context resolution after mutation, section edits, journal snapshots, file creation/moves/renames/deletion, safe human recovery, stale hashes, selection drift, invalid arguments, and bridge filtering.

The native acceptance harness also runs an SDK Streamable HTTP client against Local REST API 5.3.0 inside Obsidian 1.13.7. It verifies all 18 registrations, cross-note context, attributed edits and file operations, review/revert in the actual UI, persistence, and host reload. A separate stdio client starts the real bridge process, verifies its 25 allowed tools, fetches context, and confirms that command execution and `open_file` are refused. See [development and verification](development.md) for the reproducible fixture and the separate desktop-composer check.
