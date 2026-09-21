# MCP Extension

Connect external [MCP (Model Context Protocol)](https://modelcontextprotocol.io) servers and expose their tools to the agent.

Each server's tools are registered as `mcp_<server>_<tool>`, plus a read-only
`mcp_<server>_read_resource` helper. Supported transports: **stdio** (spawned
subprocess) and **streamable HTTP/SSE**.

## Configuration

The extension reads, in order of precedence:

1. The `PI_MCP_SERVERS` environment variable (a JSON string), or
2. `~/.pi/agent/mcp-servers.json`

If neither is present, the extension does nothing (no error).

### Example

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/path/to/allowed/dir"]
    },
    "github": {
      "type": "http",
      "url": "https://api.githubcopilot.com/mcp/",
      "headers": { "Authorization": "Bearer <token>" }
    }
  }
}
```

The `mcpServers` key is the format used by Claude Desktop, Cursor and VS Code, so
configs copied from a server's README work verbatim. `servers` is also accepted
for backwards compatibility.

Field reference:

- **stdio** — `command` (required), `args` (optional string array), `env` (optional string map added to the child environment).
- **http** — `url` (required), `headers` (optional string map).
- **type** — optional. It is inferred: a `command` means stdio, a `url` means HTTP.

## Installation

From the repository root:

```bash
mkdir -p ~/.pi/agent/extensions/mcp
ln -sf "$(pwd)/packages/coding-agent/examples/extensions/mcp/index.ts" ~/.pi/agent/extensions/mcp/index.ts
ln -sf "$(pwd)/packages/coding-agent/examples/extensions/mcp/mcp-client.ts" ~/.pi/agent/extensions/mcp/mcp-client.ts
ln -sf "$(pwd)/packages/coding-agent/examples/extensions/mcp/config.ts" ~/.pi/agent/extensions/mcp/config.ts
```

Or load it directly with `-e`:

```bash
pi -e packages/coding-agent/examples/extensions/mcp/index.ts
```

## Usage

- The registered tools are available to the LLM automatically (e.g. "list the
  files the filesystem server exposes").
- `/mcp` lists connected servers, tool counts, and connection state.

## Security

MCP servers run arbitrary code. This extension only reads **user-level** config
(`~/.pi/agent/mcp-servers.json`); it does not load project-local `.pi/` MCP
config, so a repository cannot silently register a server.

## Limitations

- Only `tools/list`, `tools/call`, and `resources/read` are implemented (no
  `prompts/*`).
- On a failed tool call the client reconnects and retries once; otherwise errors
  are surfaced to the agent as tool failures.
