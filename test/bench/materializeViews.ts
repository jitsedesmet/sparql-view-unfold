/**
 * @fileoverview Materialises a workload's views: runs every CONSTRUCT over the source data and writes the
 * union of what they build, which is the virtual graph the rewriter answers over, as one N-Triples file.
 *
 * The original query over this file is the reference answer for the workloads that have no hand-written
 * query over their source data (LUBM, OAEI): it is what the query means, computed without the rewriter.
 * Jena builds the graph. Because the file then grades every rewritten variant, each view's result is
 * cross-checked against Oxigraph, an independent implementation, and the file is written only when the two
 * agree on every view's triple count. A graph is a set, so the union is deduplicated.
 *
 * Usage: npx tsx test/bench/materializeViews.ts <views.rq> <source.nt> <out.nt>
 * (with `JENA_FUSEKI_JAR` set, as for the benchmark itself)
 */
import { readFileSync, writeFileSync } from 'node:fs';
import oxigraph from 'oxigraph';
import { loadViews } from './config.js';
import { JenaEngine } from './engines.js';

async function main(): Promise<void> {
  const [ viewsFile, sourceFile, outFile ] = process.argv.slice(2);
  if (!outFile) {
    throw new Error('usage: materializeViews.ts <views.rq> <source.nt> <out.nt>');
  }
  const views = loadViews(viewsFile);

  const store = new oxigraph.Store();
  store.load(readFileSync(sourceFile, 'utf8'), { format: 'application/n-triples' });

  const jena = new JenaEngine('jena');
  const graph = new Set<string>();
  const disagreements: string[] = [];
  try {
    for (const [ index, view ] of views.entries()) {
      const jenaTriples = new Set((await jena.runConstruct(view, { name: 'source', file: sourceFile }))
        .split('\n')
        .filter(line => line.trim().length > 0));
      const oxigraphTriples = new Set((<oxigraph.Quad[]> store.query(view)).map(quad => quad.toString()));
      if (jenaTriples.size !== oxigraphTriples.size) {
        disagreements.push(`view ${index}: jena ${jenaTriples.size}, oxigraph ${oxigraphTriples.size}`);
      }
      for (const triple of jenaTriples) {
        graph.add(triple);
      }
      process.stderr.write(`  view ${index}: ${jenaTriples.size} triples\n`);
    }
  } finally {
    await jena.dispose();
  }

  if (disagreements.length > 0) {
    throw new Error(`Jena and Oxigraph disagree on ${disagreements.length} views:\n  ${disagreements.join('\n  ')}`);
  }
  writeFileSync(outFile, `${[ ...graph ].sort().join('\n')}\n`);
  process.stderr.write(`${outFile}: ${graph.size} triples from ${views.length} views\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
