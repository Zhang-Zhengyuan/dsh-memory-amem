# MCP Server for dsh-memory-amem

This directory contains an MCP (Model Context Protocol) server that wraps the
A-MEM engine so DeepSeek Harness can consume it via the official
`@deepseek-ai/dsh-mcp-client` integration — the same path documented in
[`deepseek-harness/examples/mcp-memory/`](https://github.com/deepseek-ai/deepseek-harness/tree/main/examples/mcp-memory).

## Why an MCP wrapper?

DeepSeek Harness is plugin-based and its official integration surface for
*external* memory systems is MCP. The native `@yourname/dsh-memory-amem`
plugin (this repo's `src/`) is the upstream TypeScript implementation;
this `mcp/` directory packages it as an MCP server so any DSH install —
including the headless CLI and the web UI — can use it without dragging
the plugin source into the DSH monorepo.

## Installation

```sh
cd dsh-memory-amem/mcp
npm install
pnpm run build
```

This produces `build/index.js` — a runnable stdio MCP server.

## Running standalone

```sh
# Provide a DeepSeek key for the A-MEM analysis LLM calls
export DEEPSEEK_API_KEY=sk-...
node build/index.js
```

The server listens on stdio and exposes the same `memory_*` tools as the
native plugin: `memory_search`, `memory_add`, `memory_recent`,
`memory_stats`.

## Wiring into DSH

Copy `cordis-mcp.cordis.yml` into your DSH config or run:

```sh
dsh web --patch "$PWD/dsh-memory-amem/cordis-mcp.cordis.yml"
```

The patch loads `@deepseek-ai/dsh-mcp-client` and points it at this server.
The MCP client handles discovery, lifecycle, and tool registration —
this server only needs to expose the four `memory_*` tools over JSON-RPC.
