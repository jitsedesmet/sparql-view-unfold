/**
 * @fileoverview Materialises a workload's views: runs every CONSTRUCT over the source data and writes the
 * union of what they build, which is the virtual graph the rewriter answers over, as one N-Triples file.
 *
 * The original query over this file is the reference answer for the workloads that have no hand-written
 * query over their source data (LUBM, OAEI): it is what the query means, computed without the rewriter.
 * Jena builds the graph. Because the file then grades every rewritten variant, each view's result is
 * cross-checked against Oxigraph, an independent implementation, and the file is written only when the two
 * agree on every view's number of distinct triples. A graph is a set, so the union is deduplicated.
 *
 * Every view's output is streamed to disk and counted and merged with `sort -u`, so nothing the size of the
 * graph is held in memory: at LUBM's 100 universities the views build 17 million triples.
 *
 * Usage: npx tsx test/bench/materializeViews.ts <views.rq> <source.nt> <out.nt>
 * (with `JENA_FUSEKI_JAR` set and `oxigraph` on `PATH` or named by `OXIGRAPH_BIN`, as for the benchmark)
 */
import { execFileSync } from 'node:child_process';
import { createWriteStream, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { loadViews } from './config.js';
import type { EngineSource, ManagedServerEngine } from './engines.js';
import { JenaEngine, OxigraphEngine } from './engines.js';

/** Runs `sort` in the C locale, the order and equality N-Triples lines are compared by. */
function sort(args: string[]): string {
  return execFileSync('sort', [ '-S', '2G', ...args ], { env: { ...process.env, LC_ALL: 'C' }, encoding: 'utf8' });
}

/** Writes what `view` builds over `source`, one triple per line, to `file`. */
async function construct(engine: ManagedServerEngine, view: string, source: EngineSource, file: string):
Promise<void> {
  const out = createWriteStream(file);
  await engine.constructInto(view, source, out);
  await new Promise<void>((resolve, reject) => {
    out.end(resolve);
    out.on('error', reject);
  });
}

function distinctLines(file: string): number {
  return Number(execFileSync('sh', [ '-c', `LC_ALL=C sort -u -S 2G "${file}" | wc -l` ], { encoding: 'utf8' }).trim());
}

async function main(): Promise<void> {
  const [ viewsFile, sourceFile, outFile ] = process.argv.slice(2);
  if (!outFile) {
    throw new Error('usage: materializeViews.ts <views.rq> <source.nt> <out.nt>');
  }
  const views = loadViews(viewsFile);
  const source = { name: 'source', file: sourceFile };
  const work = mkdtempSync(join(tmpdir(), 'materialize-'));
  const jena = new JenaEngine('jena');
  const oxigraph = new OxigraphEngine('oxigraph');
  const disagreements: string[] = [];
  const jenaFiles: string[] = [];
  try {
    for (const [ index, view ] of views.entries()) {
      const jenaFile = join(work, `${index}.jena.nt`);
      const oxigraphFile = join(work, `${index}.oxigraph.nt`);
      await construct(jena, view, source, jenaFile);
      await construct(oxigraph, view, source, oxigraphFile);
      const [ jenaCount, oxigraphCount ] = [ distinctLines(jenaFile), distinctLines(oxigraphFile) ];
      if (jenaCount !== oxigraphCount) {
        disagreements.push(`view ${index}: jena ${jenaCount}, oxigraph ${oxigraphCount}`);
      }
      rmSync(oxigraphFile);
      jenaFiles.push(jenaFile);
      process.stderr.write(`  view ${index}: ${jenaCount} triples\n`);
    }
    await jena.dispose();
    await oxigraph.dispose();
    if (disagreements.length > 0) {
      throw new Error(`Jena and Oxigraph disagree on ${disagreements.length} views:\n  ${disagreements.join('\n  ')}`);
    }
    sort([ '-u', '-T', dirname(outFile), '-o', outFile, ...jenaFiles ]);
    process.stderr.write(`${outFile}: ${distinctLines(outFile)} triples from ${views.length} views\n`);
  } finally {
    await jena.dispose();
    await oxigraph.dispose();
    rmSync(work, { recursive: true, force: true });
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
