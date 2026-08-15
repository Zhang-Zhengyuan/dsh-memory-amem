# MCP Server for dsh-memory-amem

This directory contains an MCP (Model Context Protocol) server that wraps the
A-MEM engine so DeepSeek Harness can consume it via the official
`@deepseek-ai/dsh-mcp-client` integration — the same path documented in
[`deepseek-harness/examples/mcp-memory/`](https://github.com/deepseek-ai/deepseek-harness/tree/main/examples/mcp-memory).

## Why an MCP wrapper?

DeepSeek Harness is plugin-based and its official integration surface for
*external* memory systems is MCP. The native `@zhang-zhengyuan/dsh-memory-amem`
plugin (this repo's `src/`) is the upstream TypeScript implementation;
this `mcp/` directory packages it as an MCP server so any DSH install —
including the headless CLI and the web UI — can use it without dragging
the plugin source into the DSH monorepo.

## Installation

Build the parent package once with `pnpm build`. The MCP wrapper has no
additional dependencies and runs directly from `mcp/index.js`.

## Running standalone

```sh
# Provide a DeepSeek key for the A-MEM analysis LLM calls
export DEEPSEEK_API_KEY=sk-...
node mcp/index.js
```

The server listens on stdio and exposes the same `memory_*` tools as the
native plugin: `memory_search`, `memory_add`, `memory_recent`,
`memory_stats`.

## Wiring into DSH

The MCP client integration is documented in
[`deepseek-harness/examples/mcp-memory/`](https://github.com/deepseek-ai/deepseek-harness/tree/main/examples/mcp-memory)
— the canonical recipe loads `@deepseek-ai/dsh-mcp-client` and points it
at this server. The MCP client handles discovery, lifecycle, and tool
registration — this server only needs to expose the four `memory_*`
tools over JSON-RPC.

For local testing:

```sh
dsh web --patch "$PWD/dsh-memory-amem/mcp/example.cordis.yml"
# (or your own cordis patch that adds @deepseek-ai/dsh-mcp-client
#  pointing at this server's stdio entry)
```

If you want a fully self-contained DSH installation, prefer the native
plugin (`src/`) — it's loaded as a bundle layer inside the DSH loader,
no separate MCP server / patch overlay required. Reach for the MCP
wrapper only when you need to integrate with a host tool runtime that
MCP is the only admission path.
