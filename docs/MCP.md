# MCP server

Built on the maintained `@modelcontextprotocol/sdk`. Two transports, same tools.

## stdio (local agents)

Claude Code:
```bash
claude mcp add visual-intelligence -- node /ABS/PATH/visualintelligence-engine/bin/visualintelligence.mjs mcp
```
Codex (`~/.codex/config.toml`):
```toml
[mcp_servers.visual-intelligence]
command = "node"
args = ["/ABS/PATH/visualintelligence-engine/bin/visualintelligence.mjs", "mcp"]
```
Any other client: command `node`, args `[".../bin/visualintelligence.mjs", "mcp"]`. Antigravity: `agy mcp add` with the same command.
Set `VIE_MCP_READONLY=1` in the client's env to register **no** write tools at all.

## HTTP (server edition)

`POST https://your-host/mcp`, stateless Streamable HTTP, `Authorization: Bearer <VIE_MCP_TOKEN>`.
Disabled (403) until `VIE_MCP_TOKEN` is set on the server. **Read-only** unless `VIE_MCP_REMOTE_WRITE=1`.
The token is separate from the dashboard token and from collector tokens. Put TLS in front when it leaves your LAN.
```bash
claude mcp add --transport http visual-intelligence http://192.168.1.50:3100/mcp --header "Authorization: Bearer $VIE_MCP_TOKEN"
```

## Tools

Read-only (`readOnlyHint`): `list_videos`, `search_videos`, `get_video`, `get_thumbnail`, `get_frames` (≤8 JPEG frames, CPU only),
`list_sessions`, `get_session`, `get_overview`, `get_storage_stats`, `get_taxonomy`, `inspect_classifications`,
`list_analysis_jobs`, `get_analysis_job`, `get_analysis_result`, `list_providers`, `estimate_analysis`, `export_research`.

Write/action (absent in read-only mode): `bookmark_videos`, `tag_videos`, `set_notes`, `correct_classification`,
`set_research_verdict` (curated data only; agent output is never overwritten), `create_analysis_job`
(**spends agent quota**: needs explicit ids and `confirm: true`), `cancel_analysis_job`.

Resources: `vie://taxonomy`, `vie://video/{uid}/metadata`, `vie://video/{uid}/thumbnail`.

Deliberately absent: shell execution, arbitrary file reads, deletion of any kind, settings changes, network binding changes.
Every tool validates its input schema; errors come back as `isError` results.
