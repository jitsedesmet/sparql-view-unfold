/**
 * @fileoverview Materialises a workload's views: runs every CONSTRUCT over the source data and writes the
 * union of what they build, which is the virtual graph the rewriter answers over, as one N-Triples file.
 *
 * The original query over this file is the reference answer for the workloads that have no hand-written
 * query over their source data (LUBM, OAEI): it is what the query means, computed without the rewriter.
 * Jena builds the graph. Because the file then grades every rewritten variant, each view's result is
 * cross-checked against an independent implementation, and the file is written only when the two agree on
 * every view's number of distinct triples. The check is Oxigraph's by default; `--check qlever` uses QLever,
 * which runs the views in minutes where Oxigraph takes hours at LUBM's largest scales. A graph is a set, so
 * the union is deduplicated.
 *
 * Every view's output is streamed to disk, gzipped, and counted and merged with `sort -u`, so nothing the size
 * of the graph is held in memory or written out uncompressed before the result: at LUBM's 250 universities
 * the views build 45 million distinct triples.
 *
 * Usage: npx tsx test/bench/materializeViews.ts <views.rq> <source.nt> <out.nt> [--check oxigraph|qlever]
 * (with `JENA_FUSEKI_JAR` set, and the checking engine set up as for the benchmark)
 */
import { execFileSync } from 'node:child_process';
import { createWriteStream, mkdtempSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Writable } from 'node:stream';
import { createGzip } from 'node:zlib';
import { loadViews } from './config.js';
import type { EngineSource, ManagedServerEngine } from './engines.js';
import { JenaEngine, OxigraphEngine, QLeverEngine } from './engines.js';

/** Writes what `view` builds over `source`, one triple per line, to `file`, gzipped if it ends in `.gz`. */
async function construct(engine: ManagedServerEngine, view: string, source: EngineSource, file: string):
Promise<void> {
  const out = createWriteStream(file);
  const finished = new Promise<void>((resolve, reject) => {
    out.on('finish', resolve);
    out.on('error', reject);
  });
  let sink: Writable = out;
  if (file.endsWith('.gz')) {
    const gzip = createGzip();
    gzip.pipe(out);
    sink = gzip;
  }
  await engine.constructInto(view, source, sink);
  sink.end();
  await finished;
}

/** Distinct lines of `file` (gzipped if it ends in `.gz`), sorted in the C locale as N-Triples compare. */
function distinctLines(file: string): number {
  const read = file.endsWith('.gz') ? `gzip -dc "${file}"` : `cat "${file}"`;
  return Number(execFileSync('sh', [ '-c', `${read} | LC_ALL=C sort -u -S 4G -T "${dirname(file)}" | wc -l` ], {
    encoding: 'utf8',
  }).trim());
}

async function main(): Promise<void> {
  const [ viewsFile, sourceFile, outFile ] = process.argv.slice(2);
  if (!outFile) {
    throw new Error('usage: materializeViews.ts <views.rq> <source.nt> <out.nt> [--check oxigraph|qlever]');
  }
  const checkIndex = process.argv.indexOf('--check');
  const checkName = checkIndex >= 0 ? process.argv[checkIndex + 1] : 'oxigraph';
  const views = loadViews(viewsFile);
  const source = { name: 'source', file: sourceFile };
  // Beside the output, on the disk it is written to, rather than in a possibly smaller /tmp.
  const work = mkdtempSync(join(dirname(outFile), '.materialize-views-'));
  const jena = new JenaEngine('jena');
  const check = checkName === 'qlever' ? new QLeverEngine('qlever') : new OxigraphEngine('oxigraph');
  const disagreements: string[] = [];
  const jenaFiles: string[] = [];
  try {
    for (const [ index, view ] of views.entries()) {
      const jenaFile = join(work, `${index}.jena.nt.gz`);
      const checkFile = join(work, `${index}.${checkName}.nt.gz`);
      await construct(jena, view, source, jenaFile);
      await construct(check, view, source, checkFile);
      const [ jenaCount, checkCount ] = [ distinctLines(jenaFile), distinctLines(checkFile) ];
      if (jenaCount !== checkCount) {
        disagreements.push(`view ${index}: jena ${jenaCount}, ${checkName} ${checkCount}`);
      }
      rmSync(checkFile);
      jenaFiles.push(jenaFile);
      process.stderr.write(`  view ${index}: ${jenaCount} triples\n`);
    }
    await jena.dispose();
    await check.dispose();
    if (disagreements.length > 0) {
      throw new Error(`Jena and ${checkName} disagree on ${disagreements.length} views:\n  ${
        disagreements.join('\n  ')}`);
    }
    execFileSync('sh', [ '-c', `gzip -dc "$@" | LC_ALL=C sort -u -S 8G --compress-program=gzip -T "${work}" ` +
      `-o "${outFile}"`, 'sh', ...jenaFiles ]);
    process.stderr.write(`${outFile}: ${distinctLines(outFile)} triples from ${views.length} views\n`);
  } finally {
    await jena.dispose();
    await check.dispose();
    rmSync(work, { recursive: true, force: true });
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
