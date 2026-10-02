/**
 * @fileoverview Measures what it costs each engine to materialise the LUBM and OAEI views itself: the price
 * the `materialized` approach pays up front and the rewriting does not, in time and in disk space.
 *
 * Each engine is timed on its own terms, in the ways it offers:
 *  - `construct-load`: every view's CONSTRUCT over the source store, the output written to one N-Triples
 *    file, then loaded into a fresh store the way the engine loads data fastest: `oxigraph load`,
 *    `tdb2.tdbloader --loader=parallel`, QLever's index builder; for Comunica, which cannot write, `rdf2hdt`
 *    and the HDT index Comunica builds when it first opens the file.
 *  - `insert`: one `INSERT { GRAPH <urn:bench:views> { ... } } WHERE { ... }` per view, into a copy of the
 *    source store (Oxigraph, Jena and QLever).
 * The views' output overlaps, but a store is a set, so nothing is deduplicated by hand. Starting a server on
 * the source store is not timed: the rewriting needs that server too. Everything after it is, once, as a
 * one-off materialisation would pay it.
 *
 * With `--break-even <results.json>` it instead reads its earlier measurements and works out, per engine,
 * after how many queries building the views (the faster way) and querying them costs less than running
 * `pullUpExtends` over the source: the build time over the average per-query saving, on the queries where
 * neither approach errored. A timed-out row counts at its budget. Where the rewriting timed out the saving is
 * understated, so the count is an upper bound (`rewritingCensored`); where the materialised query did, the
 * saving is overstated and the count a lower bound (`materializedCensored`). With both, it is neither.
 *
 * Comunica's materialisation of LUBM's larger scales is skipped unless asked for with `--include-slow`: it
 * took 4 hours at `u50` and over 13 at `u100` (2026-09-30), where the other engines need minutes, and the
 * measurements are kept in the output file.
 *
 * Usage: npx tsx test/bench/timeMaterialization.ts [--engines oxigraph,jena,qlever,comunica]
 *   [--workloads lubm,oaei] [--scales u1,u10,...] [--methods construct-load,insert] [--include-slow]
 *   [--out file.json]
 *        npx tsx test/bench/timeMaterialization.ts --break-even results.json [--out file.json]
 * (with the benchmark's engines set up, and the workloads' `prepare.sh` run first)
 */
import { execFileSync } from 'node:child_process';
import { createWriteStream, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadViews, runsAt, WORKLOADS, workloadSources } from './config.js';
import type { EngineSource, ManagedServerEngine } from './engines.js';
import { ComunicaEngine, JenaEngine, OxigraphEngine, QLeverEngine, runTool } from './engines.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const VIEWS_GRAPH = 'urn:bench:views';

/** Materialisations that take hours, run only with `--include-slow`: `engine workload scale`. */
const SLOW = new Set([ 'comunica lubm u50', 'comunica lubm u100' ]);

interface Measurement {
  engine: string;
  workload: string;
  scale: string;
  method: 'construct-load' | 'insert';
  views: number;
  /** Time to run the views: every CONSTRUCT, or every INSERT. */
  runMs: number;
  /** Time to load the CONSTRUCTs' output into a fresh store; 0 for `insert`. */
  loadMs: number;
  totalMs: number;
  /** Triples the CONSTRUCTs emitted, duplicates included; null for `insert`. */
  emittedTriples: number | null;
  /** Disk the materialised views take: the new store, or what the INSERTs added to the copy. */
  storeBytes: number;
  /** Distinct triples the INSERTs left in the views graph, read back; only for `insert`. */
  insertedTriples?: number;
}

interface ResultRow {
  engine: string;
  scheme: string;
  scale: string;
  caseId: string;
  approach: string;
  status: 'ok' | 'timeout' | 'error';
  medianMs: number;
  timeoutMs: number;
}

function option(name: string, fallback: string): string {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

/** Disk actually allocated to `path`: TDB2 preallocates sparse files ten times the size of what they hold. */
function diskBytes(path: string): number {
  return Number(execFileSync('du', [ '-s', '-B1', path ], { encoding: 'utf8' }).split('\t')[0]);
}

function lines(file: string): number {
  return Number(execFileSync('sh', [ '-c', `wc -l < "${file}"` ], { encoding: 'utf8' }).trim());
}

/** `CONSTRUCT { T } WHERE { B }` as `INSERT { GRAPH <views> { T } } WHERE { B }`. */
function asInsert(view: string): string {
  const match = /CONSTRUCT\s*\{([^{}]*)\}\s*WHERE/u.exec(view);
  if (!match) {
    throw new Error(`Cannot turn this view into an INSERT:\n${view}`);
  }
  return view.replace(match[0], `INSERT { GRAPH <${VIEWS_GRAPH}> {${match[1]}} } WHERE`);
}

async function closed(out: ReturnType<typeof createWriteStream>): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    out.end(resolve);
    out.on('error', reject);
  });
}

/** CONSTRUCT every view on a server engine, then bulk-load the output into a fresh store. */
async function constructLoad(engine: ManagedServerEngine, views: string[], source: EngineSource, work: string):
Promise<Omit<Measurement, 'engine' | 'workload' | 'scale' | 'method' | 'views'>> {
  const raw = join(work, 'views.nt');
  engine.storeFor(source.file!);
  const out = createWriteStream(raw);
  // The server is started, untimed, by a first query: the rewriting pays for that too.
  await engine.runSelect('SELECT ?s WHERE { ?s ?p ?o } LIMIT 1', source);
  let start = performance.now();
  for (const view of views) {
    await engine.constructInto(view, source, out);
  }
  await closed(out);
  const runMs = performance.now() - start;
  await engine.dispose();
  const store = join(work, 'store');
  start = performance.now();
  engine.loadStore(raw, store);
  const loadMs = performance.now() - start;
  return { runMs, loadMs, totalMs: runMs + loadMs, emittedTriples: lines(raw), storeBytes: diskBytes(store) };
}

/** INSERT every view into a copy of the source store. */
async function insert(engine: ManagedServerEngine, views: string[], source: EngineSource, work: string):
Promise<Omit<Measurement, 'engine' | 'workload' | 'scale' | 'method' | 'views'>> {
  const copy = join(work, 'copy');
  execFileSync('cp', [ '-r', engine.storeFor(source.file!), copy ]);
  const before = diskBytes(copy);
  // Started, untimed, by a first update that changes nothing.
  await engine.runUpdate(`INSERT DATA { GRAPH <${VIEWS_GRAPH}> {} }`, copy);
  const start = performance.now();
  for (const view of views) {
    await engine.runUpdate(asInsert(view), copy);
  }
  const runMs = performance.now() - start;
  // Read back, so an INSERT that silently did nothing cannot pass for a fast one.
  const count = await engine.selectOnWritable(
    `SELECT (COUNT(*) AS ?n) WHERE { GRAPH <${VIEWS_GRAPH}> { ?s ?p ?o } }`,
    copy,
  );
  await engine.dispose();
  const insertedTriples = Number(/[=]Literal:(\d+)/u.exec(count.rows[0] ?? '')?.[1] ?? Number.NaN);
  const storeBytes = diskBytes(copy) - before;
  return { runMs, loadMs: 0, totalMs: runMs, emittedTriples: null, storeBytes, insertedTriples };
}

/** CONSTRUCT every view in Comunica's worker over the HDT source, then build an HDT file and its index. */
async function comunicaConstructLoad(views: string[], source: EngineSource, work: string):
Promise<Omit<Measurement, 'engine' | 'workload' | 'scale' | 'method' | 'views'>> {
  const comunica = new ComunicaEngine('comunica');
  const raw = join(work, 'views.nt');
  writeFileSync(raw, '');
  try {
    await comunica.runSelect('SELECT ?s WHERE { ?s ?p ?o } LIMIT 1', source);
    let start = performance.now();
    for (const view of views) {
      await comunica.constructToFile(view, source, raw);
    }
    const runMs = performance.now() - start;
    await comunica.dispose();
    const hdt = join(work, 'views.hdt');
    start = performance.now();
    runTool(process.env.RDF2HDT ?? 'rdf2hdt', [ '-f', 'ntriples', '-B', 'urn:bench:views', raw, hdt ]);
    // Comunica's HDT library writes the index beside the file the first time it opens it.
    await comunica.runSelect('SELECT ?s WHERE { ?s ?p ?o } LIMIT 1', { name: 'views', file: hdt, hdtFile: hdt });
    const loadMs = performance.now() - start;
    return {
      runMs,
      loadMs,
      totalMs: runMs + loadMs,
      emittedTriples: lines(raw),
      storeBytes: statSync(hdt).size + statSync(`${hdt}.index.v1-1`).size,
    };
  } finally {
    await comunica.dispose();
  }
}

function makeServer(name: string): ManagedServerEngine {
  switch (name) {
    case 'oxigraph': return new OxigraphEngine();
    case 'jena': return new JenaEngine();
    case 'qlever': return new QLeverEngine();
    default: throw new Error(`Unknown engine '${name}'`);
  }
}

async function measure(): Promise<void> {
  const engines = option('engines', 'oxigraph,jena,qlever,comunica').split(',');
  const workloads = option('workloads', 'lubm,oaei').split(',');
  const scales = process.argv.includes('--scales') ? option('scales', '').split(',') : undefined;
  const methods = option('methods', 'construct-load,insert').split(',');
  const outFile = option('out', join(HERE, 'results', 'materialization.json'));
  const measurements: Measurement[] = existsSync(outFile) ?
    <Measurement[]> JSON.parse(readFileSync(outFile, 'utf8')) :
      [];

  for (const workloadName of workloads) {
    const workload = WORKLOADS[workloadName];
    const views = loadViews(workload.viewsFile);
    for (const scale of Object.keys(workload.scales).filter(s => !scales || scales.includes(s))) {
      const { source } = workloadSources(workload, scale);
      for (const engineName of engines) {
        for (const method of <Measurement['method'][]> methods) {
          if ((engineName === 'comunica' && method === 'insert') || !runsAt(workload, scale, engineName)) {
            continue;
          }
          if (SLOW.has(`${engineName} ${workloadName} ${scale}`) && !process.argv.includes('--include-slow')) {
            process.stderr.write(`${engineName} ${workloadName} ${scale}: skipped, takes hours (--include-slow)\n`);
            continue;
          }
          // Beside the data, so the store lands on the disk it would be used from.
          const work = mkdtempSync(join(dirname(source.file!), `.materialize-${engineName}-`));
          process.stderr.write(`${engineName} ${workloadName} ${scale} ${method}\n`);
          try {
            let measured: Omit<Measurement, 'engine' | 'workload' | 'scale' | 'method' | 'views'>;
            if (engineName === 'comunica') {
              measured = await comunicaConstructLoad(views, source, work);
            } else {
              const engine = makeServer(engineName);
              try {
                measured = method === 'insert' ?
                  await insert(engine, views, source, work) :
                  await constructLoad(engine, views, source, work);
              } finally {
                await engine.dispose();
              }
            }
            const index = measurements.findIndex(m => m.engine === engineName && m.workload === workloadName &&
              m.scale === scale && m.method === method);
            const row = { engine: engineName, workload: workloadName, scale, method, views: views.length, ...measured };
            measurements.splice(index >= 0 ? index : measurements.length, index >= 0 ? 1 : 0, row);
            process.stderr.write(`  ${Math.round(measured.totalMs)} ms, ${measured.storeBytes} bytes\n`);
            writeFileSync(outFile, `${JSON.stringify(measurements, null, 2)}\n`);
          } catch (error: unknown) {
            process.stderr.write(`  failed: ${error instanceof Error ? error.message : String(error)}\n`);
          } finally {
            rmSync(work, { recursive: true, force: true });
          }
        }
      }
    }
  }
}

/** Queries after which building the views once and querying them beats `pullUpExtends`, or null if never. */
function breakEven(rows: ResultRow[], buildMs: number): {
  queries: number | null;
  rewritingCensored: boolean;
  materializedCensored: boolean;
} {
  const byCase = new Map<string, Record<string, ResultRow>>();
  for (const row of rows) {
    byCase.set(row.caseId, { ...byCase.get(row.caseId), [row.approach]: row });
  }
  const time = (row: ResultRow): number => row.status === 'ok' ? row.medianMs : row.timeoutMs;
  let saving = 0;
  let queries = 0;
  let rewritingCensored = false;
  let materializedCensored = false;
  for (const approaches of byCase.values()) {
    const materialized = approaches.materialized;
    const rewriting = approaches['rewriting+pullUpExtends'];
    if (!materialized || !rewriting || materialized.status === 'error' || rewriting.status === 'error') {
      continue;
    }
    rewritingCensored ||= rewriting.status === 'timeout';
    materializedCensored ||= materialized.status === 'timeout';
    saving += time(rewriting) - time(materialized);
    queries++;
  }
  return {
    queries: saving > 0 ? Math.ceil(buildMs / (saving / queries)) : null,
    rewritingCensored,
    materializedCensored,
  };
}

function analyse(resultsFile: string): void {
  const outFile = option('out', join(HERE, 'results', 'materialization.json'));
  const measurements = <Measurement[]> JSON.parse(readFileSync(outFile, 'utf8'));
  const results = <ResultRow[]> JSON.parse(readFileSync(resultsFile, 'utf8'));
  const cells = new Map<string, Measurement[]>();
  for (const m of measurements) {
    const key = `${m.engine} ${m.workload} ${m.scale}`;
    cells.set(key, [ ...cells.get(key) ?? [], m ]);
  }
  const analysis = [ ...cells.values() ].map((ways) => {
    const fastest = ways.reduce((a, b) => a.totalMs <= b.totalMs ? a : b);
    const rows = results.filter(r => r.engine === fastest.engine && r.scheme === fastest.workload &&
      r.scale === fastest.scale);
    return {
      engine: fastest.engine,
      workload: fastest.workload,
      scale: fastest.scale,
      fastestMethod: fastest.method,
      buildMs: Math.round(fastest.totalMs),
      storeBytes: fastest.storeBytes,
      breakEven: breakEven(rows, fastest.totalMs),
    };
  });
  process.stdout.write(`${JSON.stringify(analysis, null, 2)}\n`);
}

const breakEvenResults = process.argv.includes('--break-even') ? option('break-even', '') : undefined;
(breakEvenResults ? Promise.resolve(analyse(breakEvenResults)) : measure()).catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
