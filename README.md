# wikiship

An Obsidian desktop plugin that connects local MCP clients to vault content and records file changes for review.

## Requirements

- Obsidian desktop 1.13.7 or later
- An MCP client running on the same computer

## Install and connect

1. In Obsidian, open **Settings → Community plugins → Browse**, install **wikiship**, and enable it.
2. In **Settings → wikiship → Connect Codex**, select **Copy Codex config**.
3. In the ChatGPT desktop app, open **Settings → Configuration → Open config.toml**. Replace the existing `[mcp_servers.wikiship]` entry with the copied configuration, save, then select **Restart** under **Settings → MCP servers**.

Other local MCP clients can connect using the endpoint and bearer token in the copied configuration. See the [client setup guide](docs/mcp-tools.md).

wikiship includes its own authenticated MCP server. No companion plugin, separate Node.js installation, or hosted service is required.

## Use

1. Select text or place the cursor in a note.
2. Ask the connected agent to read the editor context and make a change through a wikiship tool.
3. Review the change in **machine minds' changes**. Undo it to restore the previous content, or approve it to keep the change and clear its review data.

File deletions remain staged until approval. After approval, wikiship clears the saved change data and cannot undo the change.

## Limitations

- The MCP server is available only to clients on the same computer. It uses port `27126`; only one vault can serve at a time.
- Pending review data is stored in Obsidian's wikiship plugin data. Concurrent sync of this data between devices is unsupported.
- wikiship records changes made through its MCP tools. Separate shell or filesystem tools can change vault files without appearing in its review panel.

See [architecture and data safety](docs/architecture.md) for details.

## Development

Requires Node.js 22 or later.

```sh
npm ci
npm run check
```

See [development and verification](docs/development.md) for build and native acceptance instructions.
