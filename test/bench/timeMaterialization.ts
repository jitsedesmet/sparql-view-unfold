/**
 * @fileoverview Measures what it costs to materialise the LUBM and OAEI views with Jena, the price the
 * `materialized` approach pays up front and the rewriting does not: the time to build the views, and the
 * space the result takes.
 *
 * Per workload scale it starts Fuseki on the source data, then runs every view's CONSTRUCT in a row, several
 * times. Loading the source is timed apart and left out of the build time, because the rewriting has to
 * load the same source. The first pass is what a one-off materialisation pays; the later ones show the warm
 * cost. The views' output overlaps, so the union is deduplicated and written, as `materializeViews.ts` does,
 * and that step is timed too. Sizes and triple counts are read from the files `prepare.sh` left in `data/`.
 *
 * With a results JSON at hand, it also works out after how many queries building the views and querying them
 * costs less than running `pullUpExtends` over the source, per engine. That is the build time over the average
 * per-query saving, on the queries where neither approach errored. A timed-out row counts at its budget, so
 * where one is involved the saving is a lower bound and the count an upper bound (`upperBound: true`).
 *
 * Usage: npx tsx test/bench/timeMaterialization.ts [--passes 3] [--results results.json] [--out file.json]
 * (with `JENA_FUSEKI_JAR` set, and the workloads' `prepare.sh` run first)
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadViews, WORKLOADS, workloadSources } from './config.js';
import { JenaEngine } from './engines.js';

const HERE = dirname(fileURLToPath(import.meta.url));

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

interface BreakEven {
  queries: number;
  upperBound: boolean;
}

function option(name: string, fallback: string): string {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

function countLines(file: string): number {
  const buffer = readFileSync(file);
  let lines = 0;
  for (const byte of buffer) {
    if (byte === 0x0A) {
      lines++;
    }
  }
  return lines;
}

/** Queries after which building the views once and querying them beats `pullUpExtends`, or null if never. */
function breakEven(rows: ResultRow[], buildMs: number): BreakEven | null {
  const byCase = new Map<string, Record<string, ResultRow>>();
  for (const row of rows) {
    byCase.set(row.caseId, { ...byCase.get(row.caseId), [row.approach]: row });
  }
  const time = (row: ResultRow): number => row.status === 'ok' ? row.medianMs : row.timeoutMs;
  let saving = 0;
  let queries = 0;
  let upperBound = false;
  for (const approaches of byCase.values()) {
    const materialized = approaches.materialized;
    const rewriting = approaches['rewriting+pullUpExtends'];
    if (!materialized || !rewriting || materialized.status === 'error' || rewriting.status === 'error') {
      continue;
    }
    upperBound ||= materialized.status === 'timeout' || rewriting.status === 'timeout';
    saving += time(rewriting) - time(materialized);
    queries++;
  }
  return saving > 0 ? { queries: Math.ceil(buildMs / (saving / queries)), upperBound } : null;
}

async function main(): Promise<void> {
  const passes = Number(option('passes', '3'));
  const resultsFile = option('results', join(HERE, 'results', 'results.json'));
  const outFile = option('out', join(HERE, 'results', 'materialization.json'));
  const results = existsSync(resultsFile) ? <ResultRow[]> JSON.parse(readFileSync(resultsFile, 'utf8')) : [];
  const scratch = mkdtempSync(join(tmpdir(), 'materialization-'));

  const measurements: unknown[] = [];
  try {
    for (const workload of Object.values(WORKLOADS)) {
      const views = loadViews(workload.viewsFile);
      for (const scale of Object.keys(workload.scales)) {
        const { source, views: materialized } = workloadSources(workload, scale);
        const jena = new JenaEngine('jena');
        try {
          let start = performance.now();
          await jena.runConstruct('CONSTRUCT WHERE { ?s ?p ?o } LIMIT 1', source);
          const loadMs = performance.now() - start;

          const buildMs: number[] = [];
          let graph = new Set<string>();
          let emittedTriples = 0;
          for (let pass = 0; pass < passes; pass++) {
            graph = new Set();
            emittedTriples = 0;
            start = performance.now();
            for (const view of views) {
              for (const line of (await jena.runConstruct(view, source)).split('\n')) {
                if (line.trim().length > 0) {
                  graph.add(line);
                  emittedTriples++;
                }
              }
            }
            buildMs.push(performance.now() - start);
            process.stderr.write(`${workload.name} ${scale} pass ${pass}: ${Math.round(buildMs.at(-1)!)} ms\n`);
          }
          start = performance.now();
          writeFileSync(join(scratch, 'views.nt'), `${[ ...graph ].sort().join('\n')}\n`);
          const writeMs = performance.now() - start;

          const hdtFile = materialized.hdtFile!;
          const engines = [ 'jena', 'oxigraph', 'comunica' ];
          measurements.push({
            workload: workload.name,
            scale,
            views: views.length,
            sourceTriples: countLines(source.file!),
            sourceBytes: statSync(source.file!).size,
            viewTriples: graph.size,
            emittedTriples,
            viewBytes: statSync(materialized.file!).size,
            viewHdtBytes: statSync(hdtFile).size + statSync(`${hdtFile}.index.v1-1`).size,
            loadMs: Math.round(loadMs),
            buildMs: buildMs.map(ms => Math.round(ms)),
            writeMs: Math.round(writeMs),
            breakEven: Object.fromEntries(engines.map(engine => [ engine, breakEven(
              results.filter(row => row.scheme === workload.name && row.scale === scale && row.engine === engine),
              buildMs[0],
            ) ])),
          });
        } finally {
          await jena.dispose();
        }
      }
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  writeFileSync(outFile, `${JSON.stringify(measurements, null, 2)}\n`);
  process.stderr.write(`wrote ${outFile}\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
