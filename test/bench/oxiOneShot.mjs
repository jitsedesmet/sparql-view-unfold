/**
 * @fileoverview One-shot Oxigraph query worker.
 *
 * Loads a single Turtle dataset file, reads one SPARQL SELECT query from stdin,
 * executes it, and prints `{ durationMs, count, rows }` as JSON on stdout, where
 * `rows` are canonicalized the same way as {@link ../bench/engines.ts}
 * `bindingToString` so results are comparable across engines.
 *
 * Run in a child process (see {@link OxigraphEngine}) so the parent can enforce a
 * hard timeout by killing it — Oxigraph's `Store.query` is synchronous and cannot
 * otherwise be interrupted.
 *
 * Usage:  node oxiOneShot.mjs <dataset.ttl>   (query on stdin)
 */
import { readFileSync } from 'node:fs';
import oxigraph from 'oxigraph';

const file = process.argv[2];
if (!file) {
  process.stderr.write('usage: node oxiOneShot.mjs <dataset.ttl>  (query on stdin)\n');
  process.exit(2);
}
const query = readFileSync(0, 'utf8');

const store = new oxigraph.Store();
store.load(readFileSync(file, 'utf8'), { format: 'text/turtle' });

/** Canonicalize an Oxigraph solution (Map<name, Term>) to a stable string. */
function canonical(solution) {
  const entries = [];
  for (const [ name, term ] of solution) {
    entries.push(`${name}=${term.termType}:${term.value}`);
  }
  return `{${entries.sort().join(',')}}`;
}

const start = performance.now();
const solutions = store.query(query);
const durationMs = performance.now() - start;

const rows = solutions.map(canonical).sort();
process.stdout.write(JSON.stringify({ durationMs, count: rows.length, rows }));
