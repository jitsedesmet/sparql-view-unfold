/**
 * @fileoverview Benchmark orchestration for StarBench (the BKR reification benchmark) and the LUBM and
 * OAEI Conference workloads.
 *
 * For every engine, scheme and dataset scale it measures five ways of answering each
 * benchmark query. On StarBench all five run on the SAME materialized RDF 1.1 data:
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
 * (see README.md, "Setting up the engines"), and the reference stays the baseline because
 * the next such bug will not announce itself either.
 *
 * The LUBM and OAEI workloads (`--schemes lubm,oaei`; see `config.ts`'s `WorkloadConfig`) have no
 * hand-written query over their source data. There `materialized` is the original query run over the
 * materialised views (`materializeViews.ts`), which is both the alternative a user has - compute the
 * views ahead of time - and the reference every rewriting is graded against. Because that is a second
 * dataset, a block runs all its references first and all its rewritings after, rather than switching
 * datasets twice per case: every engine restarts on a switch. Rows also carry `correctAsSet`, since
 * the rewriting runs without `preserveCardinality` and the materialised graph is a set.
 *
 * Engines:
 *   - `comunica`: a long-lived worker process per dataset (loaded and indexed once) —
 *     Comunica's join state can outgrow any heap, and inline that takes the sweep with it.
 *   - `oxigraph`, `jena`, `qlever`, `blazegraph`, `virtuoso` and `graphdb`: each engine's native server over
 *     an on-disk store it bulk-loads once per data file (see `ManagedServerEngine` in engines.ts, and
 *     README.md for setup). QLever, Blazegraph, Virtuoso and GraphDB have no RDF 1.2 support, so they run
 *     the LUBM and OAEI workloads only.
 *
 * Results are written as JSON for the plotting script (`plot.mjs`).
 *
 * Usage:
 *   npx tsx test/bench/run.ts [--engines comunica,oxigraph,jena,qlever,blazegraph,virtuoso,graphdb]
 *     [--schemes reification,singleton,lubm,oaei] [--scales xs,s,m,u1,u10,u50,u100,u250,u500,d100,eswc] [--reps 1]
 *     [--reps-below 10000] [--approaches materialized,rewriting,...] [--cases lubm/Q06,...]
 *     [--preserve-cardinality | --paired-cardinality] [--rdf-views generalized,standard] [--changed-only]
 *     [--timeout 60000] [--out results.json]
 * `--scales` keeps, of each scheme's own scales, those it lists; without it StarBench runs xs,s,m and
 * the workloads run all of theirs.
 */
import { createReadStream, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { StreamParser } from 'n3';
import { buildCases, buildWorkloadCases, PATTERNS, runsAt, WORKLOADS, workloadSources } from './config.js';
import {
  BenchTimeoutError,
  BlazegraphEngine,
  ComunicaEngine,
  GraphDBEngine,
  JenaEngine,
  OxigraphEngine,
  QLeverEngine,
  VirtuosoEngine,
} from './engines.js';
import type { BenchEngine, EngineSource, SelectResult } from './engines.js';
import type { BenchCase, RewriteVariant } from './runner.js';
import { rewriteToSparql11, sameSolutions } from './runner.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const SUBSET_DIR = join(HERE, 'subsets');
const RESULTS_DIR = join(HERE, 'results');

interface RunOptions {
  engines: string[];
  /** StarBench reification schemes (`reification`, `singleton`) and workloads (`lubm`, `oaei`). */
  schemes: string[];
  /** Scales to run, of those each scheme has; `undefined` runs each scheme's defaults. */
  scales: string[] | undefined;
  /** Approaches to run; `undefined` runs all five. */
  approaches: string[] | undefined;
  /** Cases to run, by id (`lubm/Q06`); `undefined` runs them all. */
  cases: string[] | undefined;
  /**
   * With which `preserveCardinality` settings the rewritings run (`true` counts each triple of the views
   * once). Given both, each rewriting runs under both, back to back, like {@link rdfViews}.
   */
  cardinalities: boolean[];
  /**
   * How the mappings read the views: `generalized` keeps head terms a standard graph would not admit,
   * `standard` filters them out (`generalizedRdfView: false`). Given both, each rewriting runs under both,
   * back to back.
   */
  rdfViews: RdfView[];
  /** With both {@link rdfViews}, whether to skip the rewritings that come out the same under both. */
  changedOnly: boolean;
  reps: number;
  /** Repeats a query only while its first run took less than this; `undefined` always runs all `reps`. */
  repsBelowMs: number | undefined;
  timeoutMs: number;
  out: string;
}

/** How a run reads the views; see {@link RunOptions.rdfViews}. */
type RdfView = 'generalized' | 'standard';

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
  /**
   * Whether the *distinct* rows match the reference's. Differs from {@link correct} only when an answer
   * repeats a row the reference holds fewer times - which is expected while the rewriting runs without
   * `preserveCardinality` and the reference is a set-valued graph (the materialised views of LUBM/OAEI).
   */
  correctAsSet: boolean | null;
  /** Which approach supplied the ground truth `correct` was judged against. */
  referenceApproach: ResultRow['approach'] | null;
  /** The per-query time budget this row was run under; a `timeout` row is censored at it. */
  timeoutMs: number;
  /** Set when the rewritings ran with `preserveCardinality`; absent otherwise. */
  preserveCardinality?: true;
  /** Set when the mappings ran as standard RDF views (`generalizedRdfView: false`); absent otherwise. */
  generalizedRdfView?: false;
  error?: string;
}

function parseArgs(argv: string[]): RunOptions {
  const opts: RunOptions = {
    engines: [ 'comunica', 'oxigraph' ],
    schemes: [ 'reification' ],
    scales: undefined,
    approaches: undefined,
    cases: undefined,
    cardinalities: [ false ],
    rdfViews: [ 'generalized' ],
    changedOnly: false,
    reps: 1,
    repsBelowMs: undefined,
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
      case '--approaches':
        opts.approaches = next().split(',');
        break;
      case '--cases':
        opts.cases = next().split(',');
        break;
      case '--preserve-cardinality':
        opts.cardinalities = [ true ];
        break;
      case '--paired-cardinality':
        opts.cardinalities = [ false, true ];
        break;
      case '--rdf-views':
        opts.rdfViews = next().split(',').map((view) => {
          if (view !== 'generalized' && view !== 'standard') {
            throw new Error(`Unknown RDF view '${view}'`);
          }
          return view;
        });
        break;
      case '--changed-only':
        opts.changedOnly = true;
        break;
      case '--reps':
        opts.reps = Number.parseInt(next(), 10);
        break;
      case '--reps-below':
        opts.repsBelowMs = Number.parseInt(next(), 10);
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
    case 'jena': return new JenaEngine('jena');
    case 'qlever': return new QLeverEngine('qlever');
    case 'blazegraph': return new BlazegraphEngine('blazegraph');
    case 'virtuoso': return new VirtuosoEngine('virtuoso');
    case 'graphdb': return new GraphDBEngine('graphdb');
    default: throw new Error(`Unknown engine '${name}'`);
  }
}

/**
 * Runs a query `reps` times, returning timings + last result or a failure status. With `repsBelowMs`, a
 * query whose first run took that long or longer runs once: repeating it costs much and buys little,
 * since its run-to-run noise is a small share of its time.
 */
async function timedRun(
  engine: BenchEngine,
  query: string,
  source: EngineSource,
  reps: number,
  timeoutMs: number,
  repsBelowMs?: number,
): Promise<{ status: 'ok' | 'timeout' | 'error'; durations: number[]; result?: SelectResult; error?: string }> {
  const durations: number[] = [];
  let result: SelectResult | undefined;
  for (let rep = 0; rep < reps; rep++) {
    try {
      result = await engine.runSelect(query, source, timeoutMs);
      durations.push(result.durationMs);
      if (repsBelowMs !== undefined && durations[0] >= repsBelowMs) {
        break;
      }
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
  const referenceSet = distinct(reference.result.rows);
  for (const { row, result } of caseRows) {
    row.referenceApproach = reference.row.approach;
    const judged = row !== reference.row && result !== undefined;
    row.correct = judged ? sameSolutions(result, reference.result) : null;
    row.correctAsSet = judged ? sameRowSet(distinct(result.rows), referenceSet) : null;
  }
}

function distinct(rows: string[]): Set<string> {
  return new Set(rows);
}

function sameRowSet(a: Set<string>, b: Set<string>): boolean {
  return a.size === b.size && [ ...a ].every(row => b.has(row));
}

/** StarBench's default scales, as before the other workloads were added. */
const STARBENCH_SCALES = [ 'xs', 's', 'm' ];

/** One dataset block of a scheme: the cases and the data they run over at one scale. */
interface ScaleBlock {
  scale: string;
  /** The data the rewritings run over. */
  source: EngineSource;
  /** The data the `materialized` approach runs over: the source for StarBench, the materialised views otherwise. */
  baselineSource: EngineSource;
}

/** The cases of a scheme, the dataset blocks to run them over, and whether its scales nest. */
function schemePlan(scheme: string, scales: string[] | undefined): {
  cases: BenchCase[];
  blocks: ScaleBlock[];
  nestedScales: boolean;
} {
  const workload = WORKLOADS[scheme];
  if (workload) {
    const blocks = Object.keys(workload.scales)
      .filter(scale => !scales || scales.includes(scale))
      .map((scale) => {
        const { source, views } = workloadSources(workload, scale);
        return { scale, source, baselineSource: views };
      });
    return { cases: buildWorkloadCases(workload), blocks, nestedScales: workload.nestedScales };
  }
  if (!(scheme in PATTERNS)) {
    throw new Error(`Unknown scheme '${scheme}'`);
  }
  const blocks = (scales ?? STARBENCH_SCALES).map((scale) => {
    const source = { name: `${scheme}-${scale}`, file: join(SUBSET_DIR, `${PATTERNS[scheme].name}-${scale}.ttl`) };
    return { scale, source, baselineSource: source };
  });
  return { cases: buildCases(scheme), blocks, nestedScales: false };
}

/**
 * The four rewrites of a case depend on neither engine nor scale, and on LUBM a single one takes up to a
 * minute, so each is computed once per run.
 */
const rewrites = new Map<string, Promise<string>>();

function rewrite(
  benchCase: BenchCase,
  variant: RewriteVariant,
  preserveCardinality: boolean,
  view: RdfView,
): Promise<string> {
  const generalizedRdfView = view === 'generalized';
  const key = `${benchCase.id}\n${variant}\n${preserveCardinality}\n${view}`;
  let rewritten = rewrites.get(key);
  if (!rewritten) {
    rewritten = rewriteToSparql11(
      benchCase.mappers,
      benchCase.userQuery12,
      variant,
      { preserveCardinality },
      { generalizedRdfView },
    );
    rewrites.set(key, rewritten);
  }
  return rewritten;
}

async function runEngine(
  engine: BenchEngine,
  engineName: string,
  opts: RunOptions,
  rows: ResultRow[],
  flush: () => void,
): Promise<void> {
  for (const scheme of opts.schemes) {
    // StarBench's rewrites still build and compare triple terms; the workloads are plain RDF 1.1.
    if (!engine.supportsSparql12 && !WORKLOADS[scheme]) {
      process.stderr.write(`skip: ${engineName} / ${scheme} (needs SPARQL 1.2)\n`);
      continue;
    }
    const plan = schemePlan(scheme, opts.scales);
    const { blocks, nestedScales } = plan;
    const cases = plan.cases.filter(benchCase => !opts.cases || opts.cases.includes(benchCase.id));
    // Cells that timed out at an earlier scale of a nested workload: `caseId approach` -> that scale.
    const timedOut = new Map<string, string>();
    for (const { scale, source, baselineSource } of blocks) {
      if (WORKLOADS[scheme] && !runsAt(WORKLOADS[scheme], scale, engineName)) {
        continue;
      }
      const file = source.file!;
      if (!existsSync(file) || !existsSync(baselineSource.file!)) {
        process.stderr.write(`skip: ${file} (not generated)\n`);
        continue;
      }
      process.stderr.write(`\n== ${engineName} / ${scheme} / ${scale} ==\n`);

      // Every engine loads the data itself (Comunica in its worker, the servers into their stores), so this
      // process only needs the dataset *size*: it is the x-axis of the scaling plot, and a plot whose x-axis
      // is 0 for every scale collapses to a single point.
      let quads: number;
      try {
        quads = await countQuads(file);
        process.stderr.write(`  ${quads} quads\n`);
      } catch (error: unknown) {
        process.stderr.write(`  load failed: ${error instanceof Error ? error.message : String(error)}\n`);
        continue;
      }

      interface Job {
        benchCase: BenchCase;
        approach: ResultRow['approach'];
        query: string;
        source: EngineSource;
        view?: RdfView;
        preserveCardinality?: boolean;
      }
      const references: Job[] = [];
      const rewritings: Job[] = [];
      for (const [ caseIndex, benchCase ] of cases.entries()) {
        if (benchCase.baselineQuery !== undefined) {
          references.push({
            benchCase,
            approach: 'materialized',
            query: benchCase.baselineQuery,
            source: baselineSource,
          });
        }
        for (const [ approach, variant ] of <const>[
          [ 'rewriting', 'standard' ],
          [ 'rewriting+removeProjections', 'removeProjections' ],
          [ 'rewriting+pushDownAssertions', 'pushDownAssertions' ],
          [ 'rewriting+pullUpExtends', 'pullUpExtends' ],
        ]) {
          const pair: Job[] = [];
          for (const view of opts.rdfViews) {
            for (const preserveCardinality of opts.cardinalities) {
              const query = await rewrite(benchCase, variant, preserveCardinality, view);
              pair.push({ benchCase, approach, query, source, view, preserveCardinality });
            }
          }
          if (opts.changedOnly && pair.length > 1 && pair.every(job => job.query === pair[0].query)) {
            continue;
          }
          // Each case starts the pair one configuration further along, so that at every step no configuration
          // is always the one running on caches the near-identical query before it warmed.
          const shift = caseIndex % pair.length;
          rewritings.push(...pair.slice(shift), ...pair.slice(0, shift));
        }
      }
      // Where the reference runs on data of its own (the materialised views), every reference goes first
      // and every rewriting after: alternating per case would switch datasets twice a case, and every engine
      // restarts on a switch, so each query would run on a freshly started engine. Where it
      // shares the rewritings' data (StarBench), each case's baseline still runs just before its rewritings.
      const jobs = (baselineSource.file === source.file ?
        cases.flatMap(benchCase => [ ...references, ...rewritings ].filter(job => job.benchCase === benchCase)) :
          [ ...references, ...rewritings ]).filter(job => !opts.approaches || opts.approaches.includes(job.approach));

      // Rows go in as they are measured (each one flushed, so a run killed halfway still leaves usable
      // JSON) and are graded once the whole block is in — the reference is whichever of
      // `materialized`/`rewriting` actually produced an answer, which is not known until both have run.
      const caseRows = new Map<string, CaseRow[]>();
      for (const { benchCase, approach, query, source: jobSource, view, preserveCardinality } of jobs) {
        const cell = `${benchCase.id} ${approach} ${view} ${preserveCardinality}`;
        // A nested scale's data contains the earlier one's, so a query that timed out there would here too.
        const earlierTimeout = nestedScales ? timedOut.get(cell) : undefined;
        const run = earlierTimeout === undefined ?
          await timedRun(engine, query, jobSource, opts.reps, opts.timeoutMs, opts.repsBelowMs) :
            { status: <const> 'timeout', durations: [], error: `skipped: timed out at ${earlierTimeout}` };
        if (run.status === 'timeout' && !timedOut.has(cell)) {
          timedOut.set(cell, scale);
        }
        const result = 'result' in run ? run.result : undefined;
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
          count: result?.count ?? -1,
          correct: null,
          correctAsSet: null,
          referenceApproach: null,
          timeoutMs: opts.timeoutMs,
          error: run.error,
          ...preserveCardinality ? { preserveCardinality: <const> true } : {},
          ...view === 'standard' ? { generalizedRdfView: <const> false } : {},
        };
        rows.push(row);
        if (!caseRows.has(benchCase.id)) {
          caseRows.set(benchCase.id, []);
        }
        caseRows.get(benchCase.id)!.push({ row, result });
        process.stderr.write(
            `  ${benchCase.id.padEnd(22)} ${approach.padEnd(30)} ${view === 'standard' ? 'std ' : ''}${preserveCardinality ? 'pc ' : ''}${run.status.padEnd(7)} ` +
            `${run.durations.length > 0 ? `${Math.round(median(run.durations))}ms` : '-'} ` +
            `rows=${result?.count ?? '-'}\n`,
        );
        flush();
      }
      for (const graded of caseRows.values()) {
        grade(graded);
      }
      flush();
    }
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
