/**
 * Maps the Skolemized BKR-star dataset to several target reification representations
 * by executing single-pattern SPARQL CONSTRUCT queries.
 *
 * Input: `BKR-star-skolem.ttl` — the blank-node-free RDF 1.2 dataset produced by
 * `skolemize.ts` from `BKR-star.ttl`.  Because the reifiers are already IRIs, the
 * outputs of every mapping are themselves free of blank nodes.
 *
 * Outputs written to the same directory as this script:
 *   BKR-Graph.trig        — named-graph representation        (mapToGraph-Q1/Q2)
 *   BKR-Reification.ttl   — RDF 1.1 reification pattern       (mapToReification-Q1/Q2)
 *   BKR-Singleton.ttl     — singleton-property pattern         (mapToSingleton-Q1/Q2)
 *   BKR-WikiData.ttl      — Wikidata-style n-ary pattern       (mapToWikiData-Q1/Q2)
 *
 * Streaming: the source is a `StreamingTurtleSource` that re-parses the input file
 * for every `match()` call rather than building an in-memory store.  Every mapping
 * query is a single triple pattern, so Comunica streams matches straight through
 * without any join buffering.  Combined with the streaming N3 `Writer`, heap usage
 * stays bounded regardless of the (multi-GiB) input size — no `--max-old-space-size`
 * bump is required.
 *
 * Prerequisite:
 *   npx tsx skolemize.ts BKR-star.ttl BKR-star-skolem.ttl
 *
 * Usage:
 *   npx tsx mapBkrStar.ts
 */

import { createWriteStream } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { QueryEngine } from '@comunica/query-sparql-file';
import type * as RDF from '@rdfjs/types';
import { Writer } from 'n3';
import { DataFactory } from 'rdf-data-factory';
import { termToString } from 'rdf-string';
import { StreamingTurtleSource, skolemizeTerm } from './StreamingTurtleSource.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const DF = new DataFactory();
const skolemDF = new DataFactory({ blankNodePrefix: '' });
const SKOLEM_PREFIX = 'urn:bkr:blank:';
const sourcePath = resolve(__dirname, 'BKR-star-skolem.ttl');

/**
 * Extension function `<internal://bnode>`.
 *
 * Given any number of RDF term arguments, returns a blank node that is:
 *  - the same blank node every time the identical combination of arguments is seen, and
 *  - a fresh blank node the first time a new combination is encountered.
 *
 * The cache is intentionally global so that a single blank node is produced per unique
 * argument combination across the entire mapping run.
 */
const bnodeCache = new Map<string, RDF.BlankNode>();
let bnodeCounter = 0;

function cachedBnode(args: RDF.Term[]): RDF.BlankNode {
  // Build a collision-resistant key from termType + value of each argument.
  const key = args.map(t => `${t.termType}\x00${termToString(t)}`).join('\x01');
  let bnode = bnodeCache.get(key);
  if (!bnode) {
    bnode = DF.blankNode(`b${bnodeCounter++}`);
    bnodeCache.set(key, bnode);
  }
  return bnode;
}

const extensionFunctions: Record<string, (args: RDF.Term[]) => Promise<RDF.Term>> = {
  'internal://bnode': async(args: RDF.Term[]): Promise<RDF.Term> => cachedBnode(args),
};

// ---------------------------------------------------------------------------

interface MappingSpec {
  name: string;
  queries: readonly string[];
  output: string;
  /** N3 Writer format string, e.g. 'text/turtle' or 'application/trig'. */
  format: string;
  context?: Record<string, unknown>;
}

const mappings: MappingSpec[] = [
  // {
  //   name: 'mapToGraph',
  //   queries: [ 'mapToGraph-Q1.rq', 'mapToGraph-Q2.rq' ],
  //   // Q1 places triples inside named graphs; TriG is required to represent them.
  //   output: 'BKR-Graph.trig',
  //   format: 'application/trig',
  // },
  {
    name: 'mapToReification',
    queries: [ 'mapToReification-Q1.rq', 'mapToReification-Q2.rq' ],
    output: 'BKR-Reification.ttl',
    format: 'text/turtle',
  },
  {
    name: 'mapToSingleton',
    queries: [ 'mapToSingleton-Q1.rq', 'mapToSingleton-Q2.rq' ],
    output: 'BKR-Singleton.ttl',
    // The input is Skolemized, so singleton properties are IRIs (not blank nodes)
    // and the output is valid plain Turtle.
    format: 'text/turtle',
  },
  {
    name: 'mapToWikiData',
    queries: [ 'mapToWikiData-Q1.rq', 'mapToWikiData-Q2.rq' ],
    output: 'BKR-WikiData.ttl',
    format: 'text/turtle',
    // Provide the <internal://bnode> extension function used in mapToWikiData-Q1.rq.
    context: { extensionFunctions },
  },
];

// ---------------------------------------------------------------------------

async function executeMapping(spec: MappingSpec, rdfjsSource: StreamingTurtleSource): Promise<void> {
  const { name, queries, output, format, context = {}} = spec;
  const outputPath = resolve(__dirname, output);
  const outStream = createWriteStream(outputPath);
  const writer = new Writer(outStream, { format });
  const engine = new QueryEngine();

  process.stdout.write(`[${name}] Starting → ${output}\n`);
  let totalQuads = 0;

  // Collect write-stream errors so they can be re-thrown at the next await point.
  let pendingStreamError: Error | undefined;
  outStream.on('error', (err: Error) => {
    pendingStreamError = err;
  });

  for (const queryFile of queries) {
    const queryPath = resolve(__dirname, queryFile);
    const query = await readFile(queryPath, 'utf-8');
    process.stdout.write(`[${name}] Executing ${queryFile}...\n`);

    const quadStream = await engine.queryQuads(query, {
      sources: [{ type: 'rdfjs', value: rdfjsSource }],
      ...context,
    });

    await new Promise<void>((res, rej) => {
      let settled = false;
      const fail = (err: unknown): void => {
        if (settled) {
          return;
        }
        settled = true;
        rej(err instanceof Error ? err : new Error(String(err)));
      };

      quadStream.on('error', fail);
      quadStream.on('data', (quad: RDF.Quad) => {
        if (settled) {
          return;
        }
        if (pendingStreamError) {
          fail(pendingStreamError);
          return;
        }
        try {
          // Skolemize blank nodes so the output files contain no blank nodes.
          // The rewriting algorithm assumes datasets are blank-node free.
          const s = skolemizeTerm(quad.subject, SKOLEM_PREFIX, skolemDF);
          const p = skolemizeTerm(quad.predicate, SKOLEM_PREFIX, skolemDF);
          const o = skolemizeTerm(quad.object, SKOLEM_PREFIX, skolemDF);
          const g = skolemizeTerm(quad.graph, SKOLEM_PREFIX, skolemDF);
          writer.addQuad(skolemDF.quad(
            <RDF.Quad_Subject>s,
            <RDF.Quad_Predicate>p,
            <RDF.Quad_Object>o,
            <RDF.Quad_Graph>g,
          ));

          if (++totalQuads % 100_000 === 0) {
            process.stdout.write(`\r[${name}] ${totalQuads.toLocaleString()} quads written...`);
          }
        } catch (err) {
          fail(err);
        }
      });
      quadStream.on('end', () => {
        if (pendingStreamError) {
          fail(pendingStreamError);
          return;
        }
        if (!settled) {
          settled = true;
          res();
        }
      });
    });
  }

  if (totalQuads >= 100_000) {
    process.stdout.write('\r');
  }

  await new Promise<void>((res, rej) => {
    if (pendingStreamError) {
      rej(pendingStreamError);
      return;
    }
    writer.end(error => (error ? rej(error) : res()));
  });

  process.stdout.write(`[${name}] Done — ${totalQuads.toLocaleString()} quads → ${output}\n`);
}

// ---------------------------------------------------------------------------
// Entry point: stream the Skolemized source through each mapping.  The source is
// re-parsed per match() call, so heap usage stays bounded and no heap bump is
// needed.
// ---------------------------------------------------------------------------

// Skolemized input contains explicit `<iri> rdf:reifies <<( s p o )>>` triples, so
// no on-the-fly Skolemization is needed here (skolemize = false).  The write loop
// still Skolemizes any blank nodes introduced by mapping queries (e.g. the WikiData
// `<internal://bnode>` extension function).
process.stdout.write(`Streaming source: ${sourcePath}\n`);
const rdfjsSource = new StreamingTurtleSource(sourcePath, 'bkr_', 'text/turtle', false, SKOLEM_PREFIX);

// Run all mappings sequentially; print the full error and exit on failure.
try {
  for (const mapping of mappings) {
    await executeMapping(mapping, rdfjsSource);
  }
} catch (err: unknown) {
  const msg = err instanceof Error ? (err.stack ?? err.message) : String(err);
  process.stderr.write(`\nFatal: ${msg}\n`);
  // eslint-disable-next-line unicorn/no-process-exit
  process.exit(1);
}

process.stdout.write('\nAll mappings complete.\n');
