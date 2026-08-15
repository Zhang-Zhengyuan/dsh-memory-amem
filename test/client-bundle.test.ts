/**
 * Client-bundle smoke tests for `lib/client.js`.
 *
 * The DSH web Loader fetches `lib/client.js` from
 * `/plugins/<id>/client.js` and expects the script to register a factory
 * via `window.__ModuleLoader__.load({ id, factory })`. The wrapper is a
 * tsdown banner/footer decoration around the source — if either the
 * `load` call or the id is missing, the page boots with
 * `client-modules: bundle … loaded without registering "<id>" via __ModuleLoader__.load`
 * and the entire plugin (host half too, since it's a sibling graph row)
 * is unusable from the UI. These tests re-derive the wrapper contract
 * from the compiled bundle so a regression in `tsdown.config.ts` or
 * `src/client/index.ts` surfaces here instead of at browser boot.
 *
 * Run with:
 *   node --import tsx --test test/client-bundle.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const PLUGIN_ID = '@zhang-zhengyuan/dsh-tool-memory-amem';
const CLIENT_JS = join(import.meta.dirname, '..', 'lib', 'client.js');
const PACKAGE_JSON = join(import.meta.dirname, '..', 'package.json');

/** Read the bundle source and extract the body inside the `factory: (require) => { … }` arrow. */
function extractFactoryBody(source: string): string {
  // The wrapper shape (set in tsdown.config.ts `clientBundleWrapper`) is:
  //   window.__ModuleLoader__.load({ id: "<id>", factory: (require) => { ...return module.exports; } });
  // We just look for the canonical fragments; full brace-balancing isn't
  // needed for the structural assertions this suite covers.
  const loadCall = /window\.__ModuleLoader__\.load\(\s*\{[^}]*id:\s*"([^"]+)"[^}]*factory:\s*\(require\)\s*=>\s*\{/;
  const match = source.match(loadCall);
  if (match === null) {
    throw new Error(
      `lib/client.js must wrap its body in window.__ModuleLoader__.load({ id: "${PLUGIN_ID}", factory: (require) => { ... } }); `
      + 'a regression in tsdown.config.ts (banner/footer/intro) will surface here',
    );
  }
  return match[1]!;
}

test('client bundle exists and registers via window.__ModuleLoader__.load with the correct id', () => {
  assert.ok(existsSync(CLIENT_JS), 'lib/client.js must exist after pnpm run build');
  const source = readFileSync(CLIENT_JS, 'utf8');
  const id = extractFactoryBody(source);
  assert.equal(id, PLUGIN_ID, `client bundle id must be "${PLUGIN_ID}" (must match the loader graph row's id)`);
});

test('client bundle uses CJS module.exports wrapper (banner/intro/footer)', () => {
  const source = readFileSync(CLIENT_JS, 'utf8');
  // The intro declares `module = { exports: {} }` and `exports = module.exports`.
  assert.ok(
    /var module = \{ exports: \{\} \};/.test(source),
    'client bundle must declare `var module = { exports: {} }` so the body can write exports',
  );
  // The footer closes the factory with `return module.exports; } });`.
  assert.ok(
    /return module\.exports;\s*\}\s*\}\);/.test(source),
    'client bundle must end with `return module.exports; } });` (factory closure + load call)',
  );
  // And the wrapper must be format=cjs (the rolldown [CJS] tag in the build log), not ESM.
  // ESM bundles won't have the module/exports sink the body writes to.
  assert.ok(!/^export\s/m.test(source), 'client bundle must NOT use ESM `export` (the factory closure owns the module.exports sink)');
});

test('client bundle does not require non-platform modules (no uuid, no fs, etc.)', () => {
  const source = readFileSync(CLIENT_JS, 'utf8');
  // The loader module table resolves @deepseek-ai/cordis and platform
  // packages via the synchronous `require` it hands the factory. Anything
  // outside that table is a guaranteed runtime throw inside the factory.
  const requireCalls = [...source.matchAll(/require\("([^"]+)"\)/g)].map((m) => m[1]);
  assert.deepEqual(requireCalls, [], `client bundle must not contain require() calls (the loader table owns all resolution); found: ${requireCalls.join(', ')}`);
});

test('client bundle exports `apply` (the registered half)', () => {
  const source = readFileSync(CLIENT_JS, 'utf8');
  assert.ok(/exports\.apply\s*=\s*apply/.test(source), 'client bundle must set exports.apply for the host-side require to find');
});

test('client source (src/client/index.ts) does not re-import the host half via invariant.ts', () => {
  // The host half's invariant.ts re-exports name/version from src/index.ts,
  // which pulls in uuid and other server-only deps that the loader module
  // table cannot answer. A naive `import { SERVICE_KEY } from '../invariant.ts'`
  // in the browser half would let rolldown drag the host chain into the
  // client bundle. The browser half inlines the literal directly.
  const src = readFileSync(join(import.meta.dirname, '..', 'src', 'client', 'index.ts'), 'utf8');
  assert.ok(
    !/from\s+['"]\.\.\/invariant(?:\.ts)?['"]/.test(src),
    "src/client/index.ts must not import from '../invariant.ts' (host-only chain would be bundled in); inline the SERVICE_KEY literal instead",
  );
});

test('package.json declares the dsh.client platform field', () => {
  // The Node Loader only loads the browser half if the package declares
  // a `dsh.client` block under the platform manifest; without it the
  // client graph row never appears and the loader never fetches
  // lib/client.js (so the user sees no UI complaints at all — worse than
  // the explicit __ModuleLoader__.load error).
  const pkg = JSON.parse(readFileSync(PACKAGE_JSON, 'utf8')) as { dsh?: { client?: { platform?: string } } };
  assert.ok(pkg.dsh !== undefined, 'package.json must declare a "dsh" block');
  assert.ok(pkg.dsh.client !== undefined, 'package.json must declare "dsh.client"');
  assert.equal(pkg.dsh.client.platform, 'web', 'dsh.client.platform must be "web" so the Node Loader builds the client graph row');
});
