/**
 * Schema-shape smoke tests for the four tool output schemas registered by
 * the plugin. DSH runs every `output.schema` and `parameters` through the
 * `@deepseek-ai/dsh-tools` schema compilers before the tool reaches the
 * wire:
 *
 *   - `valueSchemaSpecToJsonSchema(output.schema)` for the structured
 *     output shape, and
 *   - `parameterSchemaSpecToJsonSchema(parameters)` for the model's
 *     argument schema.
 *
 * Both compilers share one rule (verified empirically — see the
 * comment blocks in `src/index.ts` for the rationale):
 *
 *   per-property `required: true` is accepted and lifted to a top-level
 *   `required: [...]` array on the compiled schema;
 *   per-property `required: false` is rejected (`parameters.<name>.required
 *   must be true when present`); to mark an optional field, OMIT the
 *   `required` field entirely;
 *   a top-level `required: [...]` is rejected on `output.schema` (it's the
 *   parameters-only compile path that produces one).
 *
 * The describe-image plugin (zhu1090093659/dsh-web-ui/packages/
 * dsh-tool-describe-image/src/index.ts) is the canonical DSH reference for
 * the shape — `text: { type: 'string', required: true }` on the output
 * side, `prompt: { type: 'string', description: '...' }` (no `required`)
 * on the parameter side.
 *
 * These tests directly import the DSH compiler and feed it the four
 * extracted schemas + a parameter table — any shape that fails the
 * runtime validator fails the test before the harness can boot. The
 * first shape bug (`required: false` on parameters, top-level `required`
 * on output) surfaced as the user-visible mid-turn error
 * `Invalid schema for function 'memory_add': schema must be a JSON Schema
 *  of 'type: "object"', got 'type: null'`; the harness's validators are
 * the only thing that catches that shape early.
 *
 * Run with:
 *   node --import tsx --test test/schema.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  valueSchemaSpecToJsonSchema,
  parameterSchemaSpecToJsonSchema,
} from '@deepseek-ai/dsh-tools';

const SRC_PATH = join(import.meta.dirname, '..', 'src', 'index.ts');

/**
 * Extract every `*OutputSchema()` return literal from src/index.ts. Each
 * helper is a top-level `function NAME() { return { ... } as const satisfies
 * ValueSchemaSpec; }` — we walk braces from the `return {` line until
 * balanced, stripping the trailing `as const satisfies ...` so the shim
 * compiles. The host half's tool factories depend on `ctx.tools`, which
 * is Cordis-only; the source text is the simplest authoritative surface
 * for shape assertions.
 */
function extractSchemasFromSource(): Record<string, unknown> {
  const src = readFileSync(SRC_PATH, 'utf8');
  const names = ['searchOutputSchema', 'simpleNoteOutputSchema', 'statsOutputSchema', 'recentOutputSchema'];
  const out: Record<string, unknown> = {};
  for (const name of names) {
    const header = src.indexOf(`function ${name}()`);
    assert.ok(header >= 0, `src/index.ts must export ${name}()`);
    const bodyStart = src.indexOf('return {', header);
    assert.ok(bodyStart >= 0, `${name} must return an object literal`);
    let depth = 0;
    let i = bodyStart + 'return '.length;
    let bodyEnd = -1;
    for (; i < src.length; i++) {
      const ch = src[i];
      if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) { bodyEnd = i; break; }
      }
    }
    assert.ok(bodyEnd > 0, `${name} must have a balanced object body`);
    const body = src.slice(bodyStart + 'return '.length, bodyEnd + 1);
    // eslint-disable-next-line no-new-func
    out[name] = new Function(`return (${body});`)();
  }
  return out;
}

const schemas = extractSchemasFromSource();

test('every output schema compiles via valueSchemaSpecToJsonSchema', () => {
  // valueSchemaSpecToJsonSchema is the runtime path for `output.schema`:
  // it compiles the author-facing DSL into raw JSON Schema and asserts
  // the result is supported. This is the exact call the harness makes
  // before registering the tool with the model provider, so a failure
  // here would crash the LLM turn (see file header).
  for (const [name, schema] of Object.entries(schemas)) {
    assert.doesNotThrow(
      () => valueSchemaSpecToJsonSchema(schema),
      `${name} must be a valid value schema — the runtime path is valueSchemaSpecToJsonSchema → assertSupportedJsonSchema`,
    );
  }
});

test('every compiled output schema is type:"object" with non-empty properties and a top-level required array', () => {
  // The wire-format schema the runtime ships to the model provider must
  // be `{ type: 'object', properties: {…}, required: […] }` with at least
  // one declared property. The describe-image plugin is the reference:
  // per-property `required: true` is lifted into the top-level array by
  // the value-schema compiler.
  for (const [name, schema] of Object.entries(schemas)) {
    const compiled = valueSchemaSpecToJsonSchema(schema);
    assert.equal(compiled.type, 'object', `${name} compiles to type:"object"`);
    assert.ok(
      compiled.properties && typeof compiled.properties === 'object' && Object.keys(compiled.properties).length > 0,
      `${name} must declare at least one property at the root`,
    );
    assert.ok(
      Array.isArray(compiled.required) && compiled.required.length > 0,
      `${name} must declare at least one required entry (lifted from per-property required: true)`,
    );
  }
});

test('output schemas must NOT carry a top-level required in the source (parameters-only DSL)', () => {
  // The author DSL puts `required` per-property; the compiler lifts it
  // to top-level. A literal top-level `required: [...]` in the source is
  // a leftover from the parameters-only compile path and would be
  // rejected by `valueSchemaSpecToJsonSchema`.
  for (const [name, body] of Object.entries(schemas)) {
    assert.ok(
      !Object.hasOwn(body, 'required'),
      `${name} must not declare top-level "required" in the source — the value-schema compiler lifts it from per-property required: true`,
    );
  }
});

test('parameters for memory_add / memory_search / memory_recent / memory_stats pass parameterSchemaSpecToJsonSchema', () => {
  // Parameters walk `parameterSchemaSpecToJsonSchema`, which accepts
  // `required: true` per-property and lifts them into a top-level
  // `required: [...]` array. The four tools declared in src/index.ts
  // are: memory_search (query:string required, k:integer optional),
  // memory_add (content:string required), memory_recent
  // (limit:integer optional), memory_stats (no params).
  const cases = [
    { name: 'memory_search', params: { query: { type: 'string', required: true }, k: { type: 'integer' } }, expectedRequired: ['query'] },
    { name: 'memory_add', params: { content: { type: 'string', required: true } }, expectedRequired: ['content'] },
    { name: 'memory_recent', params: { limit: { type: 'integer' } }, expectedRequired: undefined },
    { name: 'memory_stats', params: {}, expectedRequired: undefined },
  ];
  for (const { name, params, expectedRequired } of cases) {
    const compiled = parameterSchemaSpecToJsonSchema(params);
    assert.equal(compiled.type, 'object', `${name} parameters compile to type:"object"`);
    assert.deepEqual(compiled.required, expectedRequired, `${name} parameters.required is built from per-property required:true`);
  }
});

test('no source line uses the forbidden `required: false` shorthand', () => {
  // Both the value-schema compiler and the parameter-schema compiler
  // reject `required: false` outright
  // (`parameters.<name>.required must be true when present`); optional
  // fields are declared by omitting the `required` field entirely.
  // Sweep the whole source (comments stripped) so a regression surfaces
  // here rather than as a mid-turn wire-format rejection.
  const src = readFileSync(SRC_PATH, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
  const matches = src.match(/required:\s*false\b/g) ?? [];
  assert.equal(
    matches.length,
    0,
    `src/index.ts must not use the forbidden \`required: false\` shorthand — omit the field for optional fields, got ${matches.length} occurrence(s)`,
  );
});