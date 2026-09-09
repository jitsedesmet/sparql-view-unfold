/**
 * @fileoverview One-shot Comunica query worker.
 *
 * Streams a single Turtle dataset file into an in-memory N3 store, reads one SPARQL
 * SELECT query from stdin, executes it, and prints `{ durationMs, count, rows }` as JSON
 * on stdout, where `rows` are canonicalized exactly like {@link ./engines.ts}
 * `bindingToString` so results stay comparable across engines. Only the query is timed;
 * loading the store is not.
 *
 * Run in a child process (see `ComunicaEngine`) so that a query which exhausts the heap
 * kills only this worker. Comunica evaluates in-process and buffers its own join state,
 * which no cap on the *output* stream can bound: on this corpus `reification/F-Q3` grows
 * past a 12GB heap and dies as `FATAL ERROR: Reached heap limit`, which is not a
 * catchable exception. Run inline, that ends the whole sweep — it did so twice, once
 * 16.5 hours in. Isolated here, it costs one `error` row.
 *
 * Usage:  node comunicaOneShot.mjs <dataset.ttl>   (query on stdin)
 */
import { createReadStream, readFileSync } from 'node:fs';
import { QueryEngine } from '@comunica/query-sparql-file';
import { StreamParser, Store } from 'n3';

/** Mirrors `MAX_BINDINGS` in `engines.ts`; see there for why the cap exists. */
const MAX_BINDINGS = 2_000_000;

const file = process.argv[2];
if (!file) {
  process.stderr.write('usage: node comunicaOneShot.mjs <dataset.ttl>  (query on stdin)\n');
  process.exit(2);
}
const query = readFileSync(0, 'utf8');

/** Streams the dataset into an in-memory store, with read backpressure. */
async function loadStore() {
  const store = new Store();
  await new Promise((resolve, reject) => {
    const parser = new StreamParser();
    const input = createReadStream(file, { highWaterMark: 1 << 20 });
    parser.on('data', quad => store.addQuad(quad));
    parser.on('end', resolve);
    parser.on('error', reject);
    input.on('error', reject);
    input.pipe(parser);
  });
  return store;
}

/** Canonicalize an RDF/JS Bindings to a stable string (must match `bindingToString`). */
function canonical(binding) {
  const entries = [ ...binding ]
    .map(([ variable, term ]) => `${variable.value}=${term.termType}:${term.value}`)
    .sort()
    .join(',');
  return `{${entries}}`;
}

const store = await loadStore();
const engine = new QueryEngine();

const start = performance.now();
const bindingsStream = await engine.queryBindings(query, { sources: [ store ]});
const rows = await new Promise((resolve, reject) => {
  const collected = [];
  bindingsStream.on('data', (binding) => {
    if (collected.length >= MAX_BINDINGS) {
      bindingsStream.destroy();
      reject(new Error(`over ${MAX_BINDINGS} solutions — abandoning the query`));
      return;
    }
    collected.push(canonical(binding));
  });
  bindingsStream.on('error', reject);
  bindingsStream.on('end', () => resolve(collected));
});
const durationMs = performance.now() - start;

rows.sort();
process.stdout.write(JSON.stringify({ durationMs, count: rows.length, rows }));
