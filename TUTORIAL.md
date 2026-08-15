# dsh-memory-amem setup and verification

## 1. Prerequisites

- Node.js 22.19+ or 24+
- A working DeepSeek Harness checkout
- pnpm 11 (`corepack pnpm` works when `pnpm` is not on `PATH`)

On Windows, if neither `dsh` nor `pnpm` is a global command, run DSH through
its source checkout. Do not run `dsh ...` from `C:\Users\...` unless you have
explicitly installed a global `dsh` executable.

## 2. Build the plugin

PowerShell:

```powershell
Set-Location D:\path\to\dsh-memory-amem
corepack pnpm install
corepack pnpm build
corepack pnpm test
```

The build output is `lib/`; there is no `dist/` or `build/` directory.

## 3. Install into DSH

Use `file:`, not `link:`. A file dependency installs `uuid` and the other
package-owned dependencies into the profile; a bare link may not.

```powershell
Set-Location D:\path\to\deepseek-harness
corepack pnpm dsh plugin --profile web add "file:D:\path\to\dsh-memory-amem"
```

The plugin package already contributes `cordis.patch.yml` through
`dsh.bundle.patch`. Do not also start DSH with that patch explicitly, because
the loader would receive two rows with id `tool-memory-amem`.

Verify composition:

```powershell
corepack pnpm dsh --profile web --dump-config | Select-String -Pattern "tool-memory-amem" -Context 0,1
```

Start the web profile:

```powershell
corepack pnpm dsh --profile web
```

## 4. Functional smoke test

1. Send: `请记住，我偏好 SQLite 数据库。`
2. Wait briefly, then ask: `你记得我的数据库偏好吗？`
3. Start a new session and ask the same question when `memoryScope` is
   `global` (the default).
4. Ask the model to call `memory_stats` and verify the note count increased.
5. Search `苹果香蕉`; if no note contains it, `memory_search` should return
   zero results rather than arbitrary memories.

Stored notes are under `~/.dsh/memory-amem/notes/` by default. On Windows,
`~` is resolved through Node's system home directory (`os.homedir()`).

## 5. Privacy and safety settings

```yaml
- id: tool-memory-amem
  config:
    memoryScope: session
    enableAutoCapture: true
    enablePromptInjection: true
    maxMemoryChars: 12000
    promptMaxChars: 4000
```

- `memoryScope: session` prevents tools and prompt recall from reading another
  session's notes.
- Auto-capture accepts only real DSH messages with `source.kind: user`; plugin
  context and tool-result messages are ignored.
- Retrieved text is bounded and marked as untrusted historical data. It must
  never be treated as instructions.

## 6. LLM behavior

The native plugin calls DSH's public `ctx.llm.stream()` API. With
`llmModel: auto`, it selects the first registered provider/model. You can use
`provider:model` for an explicit route. If no provider is available, note
creation falls back to deterministic multilingual keyword/context extraction
and skips evolution.

The standalone MCP wrapper uses `DEEPSEEK_API_KEY` when present and the same
deterministic fallback when it is absent:

```powershell
corepack pnpm build
node mcp\index.js
```

Set `DSH_MEMORY_AMEM_DIR` to an exact alternate storage directory.

## 7. Uninstall or refresh

```powershell
Set-Location D:\path\to\deepseek-harness
corepack pnpm dsh plugin --profile web remove @zhang-zhengyuan/dsh-tool-memory-amem
```

After local changes, rebuild and re-run the `plugin ... add file:...` command
to refresh the profile copy.
