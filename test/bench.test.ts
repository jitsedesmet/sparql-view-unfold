import { QueryEngine } from '@comunica/query-sparql-file';
import type * as RDF from '@rdfjs/types';
import * as arrayifyStreamNS from 'arrayify-stream';
import { Store } from 'n3';
import { describe, it } from 'vitest';
import { buildCases, listStarQueryFiles, PATTERNS } from './bench/config.js';
import { ComunicaEngine } from './bench/engines.js';
import { rewriteToSparql11, runBenchmark } from './bench/runner.js';
import type { BenchCase } from './bench/runner.js';
import { nonTripleTermConstruct, tripleTermConstruct } from './queryConsts.js';

const arrayifyStream: <T>(stream: unknown) => Promise<T[]> =
  (<any> arrayifyStreamNS).default ?? arrayifyStreamNS;

/**
 * Validates the benchmark harness (engine adapters, case building, runner) on the
 * small in-memory reification dataset. The heavy BKR datasets are exercised
 * separately via `test/bench/run.ts`; here we only prove the machinery is correct.
 */

/** A SPARQL 1.2 query in reifier syntax — the shape the BKR-star query files use. */
const starQuery = `PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
PREFIX : <ex://>
SELECT ?s ?p ?o WHERE { << ?s ?p ?o >> :statedBy :wikipedia . }`;
describe('benchmark harness', () => {
  const engine = new QueryEngine();
  const mappers = [ tripleTermConstruct, nonTripleTermConstruct ];
  const dataFile = './test/statics/multipleRdfReifiedTriples.ttl';

  async function loadStore(file: string): Promise<Store> {
    const quads = await arrayifyStream<RDF.Quad>(
      await engine.queryQuads('CONSTRUCT WHERE { ?s ?p ?o }', { sources: [ file ]}),
    );
    return new Store(quads);
  }

  /** Materialize the RDF 1.2 view of a store by applying every CONSTRUCT mapper. */
  async function toRdf12Store(store11: Store): Promise<Store> {
    const result = new Store();
    for (const mapper of mappers) {
      const quads = await arrayifyStream<RDF.Quad>(
        await engine.queryQuads(mapper, { sources: [ store11 ]}),
      );
      result.addAll(quads);
    }
    return result;
  }

  describe('rewriteToSparql11', () => {
    it('turns a reifier-syntax SPARQL 1.2 query into SPARQL 1.1', ({ expect }) => {
      const rewritten = rewriteToSparql11(mappers, starQuery);
      expect(rewritten).toContain('SELECT');
      // The rewriter replaces triple *patterns* matching against RDF 1.2 triple
      // terms with plain RDF 1.1 triple patterns over the materialized data; it may
      // still construct triple-term *values* (e.g. `BIND(<<( ... )>> AS ?x)`) to
      // compare against via SUBJECT()/PREDICATE()/OBJECT(), which is why engines
      // running this query still need SPARQL 1.2 support. What must be gone is the
      // old RDF-star subject-position syntax `<< ?s ...`.
      expect(rewritten).not.toMatch(/<<\s*\?s/u);
    });
  });

  describe('comunicaEngine', () => {
    it('runs a SELECT and returns canonicalized rows', async({ expect }) => {
      const eng = new ComunicaEngine();
      const result = await eng.runSelect(
        'SELECT ?s WHERE { ?s ?p ?o } LIMIT 1',
        { name: 'test', file: dataFile },
      );
      expect(result.count).toBe(1);
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
    });
  });

  describe('bKR config', () => {
    it('lists BKR-star SELECT query files', ({ expect }) => {
      const files = listStarQueryFiles();
      expect(files.length).toBeGreaterThan(0);
      expect(files.every(f => f.startsWith('BKR-star_') && f.endsWith('.rq'))).toBe(true);
    });

    it('builds runnable cases whose queries the rewriter accepts', ({ expect }) => {
      const cases = buildCases('reification');
      expect(cases.length).toBeGreaterThan(0);
      for (const benchCase of cases) {
        expect(benchCase.mappers).toBe(PATTERNS.reification.mappers);
        // Every case query must survive rewriting to SPARQL 1.1.
        expect(() => rewriteToSparql11(benchCase.mappers, benchCase.userQuery12)).not.toThrow();
      }
    });
  });

  describe('end-to-end runner', () => {
    it('rewriting over RDF 1.1 matches native SPARQL 1.2 over RDF 1.2', async({ expect }) => {
      const store11 = await loadStore(dataFile);
      const store12 = await toRdf12Store(store11);

      const benchCase: BenchCase = {
        id: 'reification/test',
        pattern: 'reification',
        mappers,
        userQuery12: starQuery,
        materialized: { name: 'store11', store: store11 },
        native12: { name: 'store12', store: store12 },
      };

      const engines = [ new ComunicaEngine() ];
      const records = await runBenchmark([ benchCase ], engines, engines[0]);

      // Expect both a rewriting record and a native record, both correct. This case
      // carries no hand-written baseline, so the reference falls back to the rewriting
      // result — which is what makes `native` agreeing with it the real assertion here:
      // rewriting to SPARQL 1.1 over RDF 1.1 answers what SPARQL 1.2 over RDF 1.2 does.
      const rewriting = records.find(r => r.approach === 'rewriting');
      const native = records.find(r => r.approach === 'native');
      expect(rewriting?.correct).toBe(true);
      expect(native?.correct).toBe(true);
      expect(rewriting?.count).toBe(native?.count);
      expect(rewriting?.count).toBeGreaterThan(0);
    });
  });
});
