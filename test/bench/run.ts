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
 * It also checks every approach against a ground-truth answer for the case: the
 * hand-written `materialized` baseline, which is plain SPARQL 1.1 over plain RDF 1.1
 * and so is the one query in the set no engine's RDF 1.2 support can get wrong. Only
 * when a case has no baseline, or the baseline itself fails, does it fall back to the
 * `rewriting` result; `referenceApproach` on every row records which was used, and the
 * row that *is* the reference carries `correct: null` rather than a self-comparison.
 * This is not hypothetical: an ARQ bug in Fuseki 6.2.0 and earlier dropped triple-term
 * bindings across certain sub-`SELECT` joins, so `rewriting` answered 0 rows there with an
 * `ok` status. Against the baseline that showed up as `rewriting` being marked incorrect,
 * which was the truth; against `rewriting` as its own oracle it showed up as every
 * *working* variant being marked incorrect. Fixed in the build the benchmark now runs
 * (see README.md, "Adding Jena / Fuseki"), and the reference stays the baseline because
 * the next such bug will not announce itself either.
 *
 * Engines:
 *   - `comunica`: a long-lived worker process per dataset (loaded and indexed once) —
 *     Comunica's join state can outgrow any heap, and inline that takes the sweep with it.
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
import { fileURLToPath } from 'node:url';
import { StreamParser } from 'n3';
import { buildCases, PATTERNS } from './config.js';
import { BenchTimeoutError, ComunicaEngine, JenaEngine, OxigraphEngine } from './engines.js';
import type { BenchEngine, EngineSource, SelectResult } from './engines.js';
import { rewriteToSparql11, sameSolutions } from './runner.js';

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
  /** Size of the dataset subset, in quads. Measured per file and shared by every engine. */
  quads: number;
  caseId: string;
  approach: 'rewriting' | 'rewriting+removeProjections' | 'rewriting+pushDownAssertions' | 'rewriting+pullUpExtends' |
  'materialized';
  status: 'ok' | 'timeout' | 'error';
  medianMs: number;
  minMs: number;
  count: number;
  /**
   * Whether this approach's result matched the case's reference answer. `null` when
   * unknown — the run produced no result, no reference could be computed, or this row
   * *is* the reference (see {@link ResultRow.referenceApproach}).
   */
  correct: boolean | null;
  /** Which approach supplied the ground truth `correct` was judged against. */
  referenceApproach: ResultRow['approach'] | null;
  /** The per-query time budget this row was run under; a `timeout` row is censored at it. */
  timeoutMs: number;
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

/**
 * Number of quads in a subset file, counted by streaming it through the parser without
 * building a store. Cached per file: the count is a property of the dataset, not of the
 * engine reading it, and every engine's rows need it as the x-axis of the scaling plot.
 */
const quadCounts = new Map<string, number>();

async function countQuads(file: string): Promise<number> {
  const cached = quadCounts.get(file);
  if (cached !== undefined) {
    return cached;
  }
  const count = await new Promise<number>((resolve, reject) => {
    let quads = 0;
    const parser = new StreamParser();
    const input = createReadStream(file, { highWaterMark: 1 << 20 });
    parser.on('data', () => quads++);
    parser.on('end', () => resolve(quads));
    parser.on('error', reject);
    input.on('error', reject);
    input.pipe(parser);
  });
  quadCounts.set(file, count);
  return count;
}

function median(values: number[]): number {
  const sorted = [ ...values ].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
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
  // The trailing newline keeps the committed results file lint-clean (`style/eol-last`).
  const flush = (): void => writeFileSync(opts.out, `${JSON.stringify(rows, null, 2)}\n`);

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

/**
 * Fills in `correct`/`referenceApproach` for one case's rows, once every approach has
 * run. Ground truth is the hand-written `materialized` baseline — plain SPARQL 1.1 over
 * plain RDF 1.1, the one query in the set that no engine's RDF 1.2 support can get wrong
 * — falling back to `rewriting` only when the baseline produced nothing. The reference
 * row itself keeps `correct: null`: comparing it to itself would report agreement it
 * cannot testify to.
 */
interface CaseRow {
  row: ResultRow;
  result?: SelectResult;
}

function grade(caseRows: CaseRow[]): void {
  let reference: (CaseRow & { result: SelectResult }) | undefined;
  for (const approach of <const>[ 'materialized', 'rewriting' ]) {
    const candidate = caseRows.find(r => r.row.approach === approach);
    if (candidate?.result) {
      reference = { ...candidate, result: candidate.result };
      break;
    }
  }
  if (!reference) {
    return;
  }
  for (const { row, result } of caseRows) {
    row.referenceApproach = reference.row.approach;
    row.correct = row === reference.row || !result ? null : sameSolutions(result, reference.result);
  }
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

      // Every engine now loads the subset inside its own worker (Comunica and Oxigraph
      // per query, Fuseki once per dataset), so this process only needs the dataset
      // *size*: it is the x-axis of the scaling plot, and a plot whose x-axis is 0 for
      // every scale collapses to a single point.
      let quads: number;
      try {
        quads = await countQuads(file);
        process.stderr.write(`  ${quads} quads\n`);
      } catch (error: unknown) {
        process.stderr.write(`  load failed: ${error instanceof Error ? error.message : String(error)}\n`);
        continue;
      }
      const source: EngineSource = { name: `${scheme}-${scale}`, file };

      for (const benchCase of cases) {
        const rewritten = await rewriteToSparql11(benchCase.mappers, benchCase.userQuery12);
        const rewrittenAnon = await rewriteToSparql11(
          benchCase.mappers,
          benchCase.userQuery12,
          'removeProjections',
        );
        const rewrittenPushDown = await rewriteToSparql11(
          benchCase.mappers,
          benchCase.userQuery12,
          'pushDownAssertions',
        );
        const rewrittenPullUp = await rewriteToSparql11(
          benchCase.mappers,
          benchCase.userQuery12,
          'pullUpExtends',
        );
        const approaches: { approach: ResultRow['approach']; query: string }[] = [
          { approach: 'rewriting', query: rewritten },
          { approach: 'rewriting+removeProjections', query: rewrittenAnon },
          { approach: 'rewriting+pushDownAssertions', query: rewrittenPushDown },
          { approach: 'rewriting+pullUpExtends', query: rewrittenPullUp },
        ];
        if (benchCase.baselineQuery !== undefined) {
          // Run the baseline first so it is available as the reference for everything
          // else, and so a case whose rewritings all time out still gets a ground truth.
          approaches.unshift({ approach: 'materialized', query: benchCase.baselineQuery });
        }

        // Rows go in as they are measured (each one flushed, so a run killed halfway
        // still leaves usable JSON) and are graded once the whole case is in — the
        // reference is whichever of `materialized`/`rewriting` actually produced an
        // answer, which is not known until both have run.
        const caseRows: CaseRow[] = [];
        for (const { approach, query } of approaches) {
          const run = await timedRun(engine, query, source, opts.reps, opts.timeoutMs);
          const row: ResultRow = {
            engine: engineName,
            scheme,
            scale,
            quads,
            caseId: benchCase.id,
            approach,
            status: run.status,
            medianMs: run.durations.length > 0 ? Math.round(median(run.durations)) : -1,
            minMs: run.durations.length > 0 ? Math.round(Math.min(...run.durations)) : -1,
            count: run.result?.count ?? -1,
            correct: null,
            referenceApproach: null,
            timeoutMs: opts.timeoutMs,
            error: run.error,
          };
          rows.push(row);
          caseRows.push({ row, result: run.result });
          process.stderr.write(
              `  ${benchCase.id.padEnd(22)} ${approach.padEnd(30)} ${run.status.padEnd(7)} ` +
              `${run.durations.length > 0 ? `${Math.round(median(run.durations))}ms` : '-'} ` +
              `rows=${run.result?.count ?? '-'}\n`,
          );
          flush();
        }
        grade(caseRows);
        flush();
      }
    }
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
