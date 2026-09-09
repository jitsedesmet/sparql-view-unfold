/**
 * @fileoverview Long-lived Comunica query worker.
 *
 * Streams a single Turtle dataset file into an in-memory N3 store *once*, then answers
 * queries over it until stdin closes. Requests and responses are newline-delimited JSON
 * on stdin/stdout:
 *
 *   -> {"query": "SELECT ...", "timeoutMs": 300000}
 *   <- {"status":"ok","durationMs":123,"count":3,"rows":["{...}"]}
 *      {"status":"timeout"}  |  {"status":"error","message":"..."}
 *
 * `rows` are canonicalized exactly like {@link ./engines.ts} `bindingToString`, so results
 * stay comparable across engines. Only query evaluation is timed; loading is not.
 *
 * **Why a worker and not an in-process engine.** Comunica buffers its own join state
 * while evaluating, which no cap on the output stream can bound: on this corpus
 * `reification/F-Q3` — a quadratic self-join whose answer Jena reports as 268MB of JSON —
 * grows past a 12GB heap and dies as `FATAL ERROR: Reached heap limit`. That is a process
 * abort, not a catchable exception, so evaluated inline it ends the whole sweep, as it did
 * twice (once 16.5 hours in). Here it kills only the worker, and `ComunicaEngine` records
 * an `error` row and starts a fresh one.
 *
 * **Why long-lived and not one-shot.** The store is loaded and indexed once per dataset and
 * the engine stays warm across queries, which is both how Comunica is actually used and
 * what keeps the fast baseline rows comparable — respawning per query left them measurably
 * slower (~300ms vs ~170ms on `A-Q2 materialized`) purely from cold JIT. A timeout is
 * handled in here, by cancelling the stream, so a slow query costs the run its budget but
 * not its warm store.
 *
 * Usage:  node comunicaWorker.mjs <dataset.ttl>
 */
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { QueryEngine } from '@comunica/query-sparql-file';
import { StreamParser, Store } from 'n3';

const file = process.argv[2];
if (!file) {
  process.stderr.write('usage: node comunicaWorker.mjs <dataset.ttl>\n');
  process.exit(2);
}

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

/** A sentinel distinguishing "we cancelled it" from a genuine evaluation error. */
const TIMED_OUT = Symbol('timed out');

async function runQuery(engine, store, query, timeoutMs) {
  const start = performance.now();
  const bindingsStream = await engine.queryBindings(query, { sources: [ store ]});
  let timer;
  try {
    const rows = await new Promise((resolve, reject) => {
      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          // Cancel the underlying Comunica work so it stops consuming CPU.
          bindingsStream.destroy();
          reject(TIMED_OUT);
        }, timeoutMs);
      }
      const collected = [];
      bindingsStream.on('data', binding => collected.push(canonical(binding)));
      bindingsStream.on('error', reject);
      bindingsStream.on('end', () => resolve(collected));
    });
    const durationMs = performance.now() - start;
    rows.sort();
    return { status: 'ok', durationMs, count: rows.length, rows };
  } catch (error) {
    if (error === TIMED_OUT) {
      return { status: 'timeout' };
    }
    return { status: 'error', message: error instanceof Error ? error.message : String(error) };
  } finally {
    clearTimeout(timer);
  }
}

const store = await loadStore();
const engine = new QueryEngine();
process.stdout.write(`${JSON.stringify({ status: 'ready', quads: store.size })}\n`);

// Queries are answered strictly in order: `readline` keeps emitting lines while an earlier
// one is still being awaited, so without this chain two queries would evaluate at once and
// contend for the same heap the crash isolation exists to bound.
let queue = Promise.resolve();
const input = createInterface({ input: process.stdin });
input.on('line', (line) => {
  if (line.trim() === '') {
    return;
  }
  queue = queue.then(async() => {
    const { query, timeoutMs } = JSON.parse(line);
    const response = await runQuery(engine, store, query, timeoutMs ?? 0);
    process.stdout.write(`${JSON.stringify(response)}\n`);
  });
});
input.on('close', () => {
  queue.then(() => process.exit(0), () => process.exit(1));
});
