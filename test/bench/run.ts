/**
 * @fileoverview Benchmark orchestration for the BKR reification benchmark.
 *
 * For every engine, reification scheme and dataset-size subset it measures five
 * ways of answering each SPARQL 1.2 benchmark query on the SAME materialized
 * RDF 1.1 data:
 *   - `rewriting`                  : the SPARQL 1.2 query rewritten to SPARQL 1.1
 *     with the standard pipeline (this library),
 *   - `rewriting+removeProjections`: the same, with the `removeProjections`
 *     transformation additionally applied (flattens the nested sub-`SELECT`s the
 *     standard pipeline wraps each mapper branch in),
 *   - `rewriting+pushDownAssertions`: the same, with `pushDownAssertions` additionally
 *     applied (assertion pushdown — pushes `FILTER(sameTerm(?x, c))` constraints down
 *     into the triple patterns that use ?x, instead of matching generically and
 *     filtering afterwards),
 *   - `rewriting+pullUpExtends`    : the pushdown pipeline plus `pullUpExtends`, applied
 *     once right after the pushdown and once more after `removeProjections` (see
 *     `runner.ts`'s pipeline comment for why twice) — floats the `BIND`s the pushdown
 *     leaves at every leaf back up to where they cost less, or drops them outright,
 *   - `materialized`               : the hand-written baseline query (BKR-R / BKR-S).
 * It also checks that the rewriting variants and the materialized baseline return
 * identical results to the standard `rewriting` approach (used as the reference,
 * when it succeeds). CAVEAT (see README.md, "Adding Jena as a third engine"): on
 * Jena specifically, `rewriting` can return a wrong-but-`ok`-status result (a known
 * Fuseki 6.2.0 ARQ bug drops triple-term-valued bindings across certain sub-`SELECT`
 * joins), which makes this reference choice actively misleading for that engine —
 * cross-check against `materialized`/`pushDownAssertions` rather than trusting
 * `correct` at face value there.
 *
 * Engines:
 *   - `comunica`: in-process; the store is loaded once per scale (async, queries
 *     are cancelled on timeout).
 *   - `oxigraph`: each query runs in a short-lived child process that is killed
 *     on timeout (Oxigraph's query call is synchronous).
 *   - `jena`: HTTP, via a long-lived `fuseki-server.jar` child process managed by
 *     `JenaEngine` (see engines.ts and README.md for setup — needs `JENA_FUSEKI_JAR`).
 *
 * Results are written as JSON for the plotting script (`plot.mjs`).
 *
 * Usage:
 *   npx tsx test/bench/run.ts [--engines comunica,oxigraph,jena]
 *     [--schemes reification,singleton] [--scales xs,s,m] [--reps 1]
 *     [--timeout 60000] [--out results.json]
 */
import { createReadStream, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import type * as RDF from '@rdfjs/types';
import { StreamParser, Store } from 'n3';
import { buildCases, PATTERNS } from './config.js';
import { BenchTimeoutError, ComunicaEngine, JenaEngine, OxigraphEngine } from './engines.js';
import type { BenchEngine, EngineSource, SelectResult } from './engines.js';
import { rewriteToSparql11 } from './runner.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const SUBSET_DIR = join(HERE, 'subsets');
const RESULTS_DIR = join(HERE, 'results');

interface RunOptions {
  engines: string[];
  schemes: (keyof typeof PATTERNS)[];
  scales: string[];
  reps: number;
  timeoutMs: number;
  out: string;
}

/** One measurement row written to the results JSON. */
interface ResultRow {
  engine: string;
  scheme: string;
  scale: string;
  quads: number;
  loadMs: number;
  caseId: string;
  approach: 'rewriting' | 'rewriting+removeProjections' | 'rewriting+pushDownAssertions' | 'rewriting+pullUpExtends' |
  'materialized';
  status: 'ok' | 'timeout' | 'error';
  medianMs: number;
  minMs: number;
  count: number;
  /** Whether this approach's result matched the rewriting reference (null if unknown). */
  correct: boolean | null;
  error?: string;
}

function parseArgs(argv: string[]): RunOptions {
  const opts: RunOptions = {
    engines: [ 'comunica', 'oxigraph' ],
    schemes: [ 'reification' ],
    scales: [ 'xs', 's', 'm' ],
    reps: 1,
    timeoutMs: 60_000,
    out: join(RESULTS_DIR, 'results.json'),
  };
  for (let i = 0; i < argv.length; i++) {
    const next = (): string => {
      const v = argv[++i];
      if (v === undefined) {
        throw new Error(`Missing value for ${argv[i - 1]}`);
      }
      return v;
    };
    switch (argv[i]) {
      case '--engines':
        opts.engines = next().split(',');
        break;
      case '--schemes':
        opts.schemes = next().split(',');
        break;
      case '--scales':
        opts.scales = next().split(',');
        break;
      case '--reps':
        opts.reps = Number.parseInt(next(), 10);
        break;
      case '--timeout':
        opts.timeoutMs = Number.parseInt(next(), 10);
        break;
      case '--out':
        opts.out = next();
        break;
      default:
        throw new Error(`Unknown argument: ${argv[i]}`);
    }
  }
  return opts;
}

/** Streams a Turtle file into an in-memory N3 store, with read backpressure. */
async function loadStore(file: string): Promise<{ store: Store; loadMs: number }> {
  const start = performance.now();
  const store = new Store();
  await new Promise<void>((resolve, reject) => {
    const parser = new StreamParser();
    const input = createReadStream(file, { highWaterMark: 1 << 20 });
    parser.on('data', (quad: RDF.Quad) => store.addQuad(quad));
    parser.on('end', () => resolve());
    parser.on('error', reject);
    input.on('error', reject);
    input.pipe(parser);
  });
  return { store, loadMs: performance.now() - start };
}

function median(values: number[]): number {
  const sorted = [ ...values ].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function sameResult(a: SelectResult, b: SelectResult): boolean {
  return a.count === b.count && a.rows.every((row, i) => row === b.rows[i]);
}

function makeEngine(name: string): BenchEngine {
  switch (name) {
    case 'comunica': return new ComunicaEngine('comunica');
    case 'oxigraph': return new OxigraphEngine('oxigraph');
    // Manages its own fuseki-server.jar child process — see JenaEngine's doc
    // comment and README.md for setup (JENA_FUSEKI_JAR, a Java 21+ runtime).
    case 'jena': return new JenaEngine('jena');
    default: throw new Error(`Unknown engine '${name}'`);
  }
}

/** Runs a query `reps` times, returning timings + last result or a failure status. */
async function timedRun(
  engine: BenchEngine,
  query: string,
  source: EngineSource,
  reps: number,
  timeoutMs: number,
): Promise<{ status: 'ok' | 'timeout' | 'error'; durations: number[]; result?: SelectResult; error?: string }> {
  const durations: number[] = [];
  let result: SelectResult | undefined;
  for (let rep = 0; rep < reps; rep++) {
    try {
      result = await engine.runSelect(query, source, timeoutMs);
      durations.push(result.durationMs);
    } catch (error: unknown) {
      if (error instanceof BenchTimeoutError) {
        return { status: 'timeout', durations, error: `timeout>${timeoutMs}ms` };
      }
      return { status: 'error', durations, error: error instanceof Error ? error.message : String(error) };
    }
  }
  return { status: 'ok', durations, result };
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  mkdirSync(RESULTS_DIR, { recursive: true });
  const rows: ResultRow[] = [];
  const flush = (): void => writeFileSync(opts.out, JSON.stringify(rows, null, 2));

  for (const engineName of opts.engines) {
    const engine = makeEngine(engineName);
    try {
      await runEngine(engine, engineName, opts, rows, flush);
    } finally {
      // Best-effort: releases resources engines like JenaEngine own across calls
      // (a Fuseki child process) so the port is free for the next engine/run.
      await engine.dispose?.();
    }
  }

  flush();
  process.stderr.write(`\nWrote ${rows.length} rows to ${opts.out}\n`);
}

async function runEngine(
  engine: BenchEngine,
  engineName: string,
  opts: RunOptions,
  rows: ResultRow[],
  flush: () => void,
): Promise<void> {
  for (const scheme of opts.schemes) {
    const cases = buildCases(scheme);
    for (const scale of opts.scales) {
      const file = join(SUBSET_DIR, `${PATTERNS[scheme].name}-${scale}.ttl`);
      if (!existsSync(file)) {
        process.stderr.write(`skip: ${file} (not generated)\n`);
        continue;
      }
      process.stderr.write(`\n== ${engineName} / ${scheme} / ${scale} ==\n`);

      // Comunica shares one in-memory store across all queries of this scale;
      // Oxigraph loads per query in its child process, so only needs the file.
      let store: Store | undefined;
      let loadMs = 0;
      let quads = 0;
      if (engineName === 'comunica') {
        try {
          const loaded = await loadStore(file);
          store = loaded.store;
          loadMs = Math.round(loaded.loadMs);
          quads = store.size;
          process.stderr.write(`  loaded ${quads} quads in ${(loadMs / 1000).toFixed(1)}s\n`);
        } catch (error: unknown) {
          process.stderr.write(`  load failed: ${error instanceof Error ? error.message : String(error)}\n`);
          continue;
        }
      }
      const source: EngineSource = { name: `${scheme}-${scale}`, store, file };

      for (const benchCase of cases) {
        const rewritten = rewriteToSparql11(benchCase.mappers, benchCase.userQuery12);
        const rewrittenAnon = rewriteToSparql11(benchCase.mappers, benchCase.userQuery12, 'removeProjections');
        const rewrittenPushDown = rewriteToSparql11(benchCase.mappers, benchCase.userQuery12, 'pushDownAssertions');
        const rewrittenPullUp = rewriteToSparql11(benchCase.mappers, benchCase.userQuery12, 'pullUpExtends');
        const approaches: { approach: ResultRow['approach']; query: string }[] = [
          { approach: 'rewriting', query: rewritten },
          { approach: 'rewriting+removeProjections', query: rewrittenAnon },
          { approach: 'rewriting+pushDownAssertions', query: rewrittenPushDown },
          { approach: 'rewriting+pullUpExtends', query: rewrittenPullUp },
        ];
        if (benchCase.baselineQuery !== undefined) {
          approaches.push({ approach: 'materialized', query: benchCase.baselineQuery });
        }

        let reference: SelectResult | undefined;
        for (const { approach, query } of approaches) {
          const run = await timedRun(engine, query, source, opts.reps, opts.timeoutMs);
          if (approach === 'rewriting' && run.result) {
            reference = run.result;
          }
          const correct = run.result && reference ? sameResult(run.result, reference) : null;
          rows.push({
            engine: engineName,
            scheme,
            scale,
            quads,
            loadMs,
            caseId: benchCase.id,
            approach,
            status: run.status,
            medianMs: run.durations.length > 0 ? Math.round(median(run.durations)) : -1,
            minMs: run.durations.length > 0 ? Math.round(Math.min(...run.durations)) : -1,
            count: run.result?.count ?? -1,
            correct,
            error: run.error,
          });
          process.stderr.write(
              `  ${benchCase.id.padEnd(22)} ${approach.padEnd(12)} ${run.status.padEnd(7)} ` +
              `${run.durations.length > 0 ? `${Math.round(median(run.durations))}ms` : '-'} ` +
              `rows=${run.result?.count ?? '-'}\n`,
          );
          flush();
        }
      }
      store = undefined;
      if (globalThis.gc) {
        globalThis.gc();
      }
    }
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
