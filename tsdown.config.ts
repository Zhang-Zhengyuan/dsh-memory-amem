/**
 * tsdown config for dsh-tool-memory-amem.
 *
 * Bundles the host half (lib/index.js) and the browser half (lib/client.js)
 * following the same pattern as the official dsh-web-ui family.
 *
 * Build pipeline:
 *   `tsc -p tsconfig.build.json` emits `lib/types/*.d.ts`;
 *   `tsdown` produces `lib/index.js` + `lib/client.js` from src/.
 */

import { builtinModules } from 'node:module'
import type { UserConfig } from 'tsdown'

const HOST_EXTERNALS = [
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-system-prompt',
  '@deepseek-ai/dsh-tools',
  '@deepseek-ai/dsh-session',
  '@deepseek-ai/dsh-llm',
  '@deepseek-ai/dsh-attachment',
  '@deepseek-ai/dsh-credentials',
  '@deepseek-ai/dsh-launch-environment',
  '@deepseek-ai/dsh-settings',
  ...builtinModules.map((m) => `node:${m}`),
]

const CLIENT_EXTERNALS = [
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-runtime',
  '@deepseek-ai/dsh-client-connection',
  '@deepseek-ai/dsh-client-ui-conversation',
  '@deepseek-ai/dsh-client-ui-settings',
  ...builtinModules.map((m) => `node:${m}`),
]

const PLUGIN_ID = '@zhang-zhengyuan/dsh-tool-memory-amem'

// Browser bundle must wrap its body in `window.__ModuleLoader__.load({ id,
// factory })` so the DSH web Loader registers the plugin factory after
// fetching lib/client.js — see
// `@deepseek-ai/deepseek-harness/packages/client/tsdown.client.ts` lines
// 269–271 for the canonical form. The bare `id` (package name) is stamped
// into the handoff; the factory closure receives the host-injected
// synchronous `require` (the loader's module table) and must return its
// `module.exports` for materialization. The source file itself just
// `export function apply(ctx)` like every in-tree client plugin; the
// wrapper is build-time decoration only.
const clientBundleWrapper = {
  banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(PLUGIN_ID)}, factory: (require) => {`,
  footer: 'return module.exports; } });',
  intro: 'var module = { exports: {} }; var exports = module.exports;',
} as const

const hostConfig: UserConfig = {
  name: PLUGIN_ID,
  entry: { index: 'src/index.ts' },
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2022',
  dts: false,
  sourcemap: true,
  clean: false,
  external: HOST_EXTERNALS,
  outputOptions: { entryFileNames: 'index.js' },
}

const clientConfig: UserConfig = {
  name: `${PLUGIN_ID}/client`,
  entry: { client: 'src/client/index.ts' },
  outDir: 'lib',
  // CJS (not ESM): the bundle body is wrapped in a factory closure, so it
  // needs a `module.exports` sink — ESM has no equivalent. The intro below
  // materializes a fake module/exports pair for the body to write to.
  format: 'cjs',
  platform: 'browser',
  target: 'es2022',
  dts: false,
  sourcemap: true,
  clean: false,
  external: CLIENT_EXTERNALS,
  // The web GUI fetches this bundle and resolves externals through its own
  // loader module table; define guards keep zustand-style probes from
  // throwing ReferenceError on `import.meta.env`.
  define: {
    'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
    'import.meta.env.MODE': JSON.stringify(process.env.NODE_ENV ?? 'production'),
    'import.meta.env': JSON.stringify({ MODE: process.env.NODE_ENV ?? 'production' }),
  },
  outputOptions: {
    entryFileNames: 'client.js',
    ...clientBundleWrapper,
  },
}

export default [hostConfig, clientConfig]
