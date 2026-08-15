/**
 * Browser half of dsh-tool-memory-amem.
 *
 * Runs inside the dsh web GUI: the loader fetches `lib/client.js` from
 * `/plugins/<id>/client.js` and invokes the factory registered via
 * `window.__ModuleLoader__.load`. The factory receives the synchronous
 * `require` bound to the loader's module table and returns its
 * `module.exports` for materialization.
 *
 * v0.2.0 ships only a UI slot placeholder. v0.3.0+ will register an
 * actual memory panel at the `conversation.input.selector` slot so users
 * can inspect / search memory inside the GUI.
 *
 * The standalone HTML panel in `web/` is the immediate inspection
 * surface — point it at a DSH host that has the plugin loaded and it
 * talks to the engine via the four `memory_*` MCP tools.
 */

/**
 * Service key the host half hands to `ctx.provide()` — duplicated as a
 * literal here (instead of imported from `../invariant.ts`) so the
 * browser bundle stays free of node-only dependencies that the loader's
 * module table cannot resolve (the host re-exports of `invariant.ts`
 * pull in `uuid` and other server-only deps; tree-shaking does not
 * drop them at the CJS-bundle level).
 */
const SERVICE_KEY = 'memoryAmem'

/** Browser half entry. Receives the DSH client runtime context. */
export function apply(ctx: unknown): void {
  // Reserved for v0.2.0: register a memory panel UI slot.
  //
  // The runtime context exposes `ctx.uiSlots` (from
  // `@deepseek-ai/dsh-client-ui-slots`); a real implementation would
  // register a React component that calls the memory_* tools through
  // `ctx.connection.invoke`.
  //
  // For v0.2.0 we only emit a marker so the loader confirms the browser
  // half was reached — useful for debugging "why doesn't my UI show".
  void SERVICE_KEY
  void ctx
}
