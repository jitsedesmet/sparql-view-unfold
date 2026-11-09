import { QueryEngine } from '@comunica/query-sparql-file';
import * as arrayifyStreamNS from 'arrayify-stream';
import { Parser, Store } from 'n3';
import type { expect as Expect } from 'vitest';
import { describe, it } from 'vitest';
import { removeProjectionsTransformation } from '../lib/transformations/removeProjections.js';
import { createValidatingQueryRewriter } from './validQuery.js';

// Crazy workaround to support both CJS and ESM
const arrayifyStream =
  (<any> arrayifyStreamNS).default ?? arrayifyStreamNS;

describe('removeProjections', () => {
  // The pass through mapping leaves every pattern as it was, so the output only shows what
  // removeProjections itself did.
  async function transform(query: string): Promise<string> {
    return createValidatingQueryRewriter([ removeProjectionsTransformation() ]).rewriteQuery(query);
  }

  const engine = new QueryEngine();

  async function bindings(
    query: string,
    source: string | Store = './test/statics/multipleRdfReifiedTriples.ttl',
  ): Promise<string[]> {
    const rows: any[] = await arrayifyStream(await engine.queryBindings(query, { sources: [ source ]}));
    return rows
      .map(row => [ ...row ].map(([ key, value ]: [any, any]) => `${key.value}=${value.value}`).sort().join('|'))
      .sort();
  }

  /**
   * Asserts that a query answers the same once its projections are removed.
   * @param expect - The assertion API of the running test
   * @param query - The query
   * @param source - The data to run it over
   * @returns the rewritten query
   */
  async function assertEquivalent(expect: typeof Expect, query: string, source?: string | Store): Promise<string> {
    const rewritten = await transform(query);
    const original = await bindings(query, source);
    expect(await bindings(rewritten, source)).toEqual(original);
    // Sanity: the query actually returns something so the test is meaningful.
    expect(original.length).toBeGreaterThan(0);
    return rewritten;
  }

  it('anonymizes the variables a subselect hides', async({ expect }) => {
    // ?p and ?o are not projected by the subselect, so they may not join with the outer ?p / ?o.
    expect(await transform('SELECT ?s WHERE { ?s <ex://p> ?o { SELECT ?s WHERE { ?s ?p ?o } } }')).toContain('?v_0');
  });

  describe('deduplication with DISTINCT / REDUCED', () => {
    // Deduplication happens over the variables the projection exposes: dropping it would make
    // DISTINCT consider the anonymized variables as well, turning duplicates into distinct rows.
    it('keeps the projection of a sub-SELECT DISTINCT', async({ expect }) => {
      expect(await transform('SELECT * WHERE { { SELECT DISTINCT ?s WHERE { ?s ?p ?o } } }'))
        .toContain('SELECT DISTINCT ?s WHERE');
    });

    it('keeps the projection of a sub-SELECT REDUCED', async({ expect }) => {
      expect(await transform('SELECT * WHERE { { SELECT REDUCED ?s WHERE { ?s ?p ?o } } }'))
        .toContain('SELECT REDUCED ?s WHERE');
    });

    it('a sub-SELECT DISTINCT returns the same results', async({ expect }) => {
      await assertEquivalent(expect, 'SELECT * WHERE { { SELECT DISTINCT ?s WHERE { ?s ?p ?o } } }');
    });

    it('a top level DISTINCT returns the same results', async({ expect }) => {
      await assertEquivalent(expect, 'SELECT DISTINCT ?s WHERE { ?s ?p ?o }');
    });

    it('still removes projections that no deduplication depends on', async({ expect }) => {
      await assertEquivalent(
        expect,
        'SELECT ?s WHERE { ?s <ex://knows> ?o { SELECT ?s WHERE { ?s ?p ?o2 } } }',
      );
    });
  });

  describe('a SLICE (LIMIT / OFFSET) below a projection', () => {
    // SPARQL only writes a LIMIT on a SELECT, so dropping the projection would gain no flatter query.
    it('keeps the projection of a sub-SELECT with LIMIT', async({ expect }) => {
      expect(await transform('SELECT * WHERE { { SELECT ?s WHERE { ?s ?p ?o } LIMIT 1 } }'))
        .toContain('LIMIT 1');
    });

    it('a sub-SELECT with LIMIT returns the same results', async({ expect }) => {
      await assertEquivalent(expect, 'SELECT * WHERE { { SELECT ?s WHERE { ?s ?p ?o } LIMIT 1 } }');
    });
  });

  describe('a GROUP below a projection', () => {
    // SPARQL only writes a GROUP BY on a SELECT, so dropping the projection would gain no flatter query.
    it('keeps the projection of a grouped sub-SELECT', async({ expect }) => {
      expect(await transform('SELECT * WHERE { { SELECT ?s WHERE { ?s ?p ?o } GROUP BY ?s } OPTIONAL { ?s ?q ?r } }'))
        .toMatch(/\{\s*SELECT \?s WHERE/u);
    });

    it('keeps the projection of a grouped sub-SELECT with a trailing VALUES', async({ expect }) => {
      expect(await transform('SELECT * WHERE { { SELECT ?s WHERE { ?s ?p ?o } GROUP BY ?s VALUES ?s { <ex:a> } } }'))
        .not.toMatch(/\?v_\d/u);
    });

    it('a grouped sub-SELECT returns the same results', async({ expect }) => {
      await assertEquivalent(
        expect,
        'SELECT * WHERE { { SELECT ?s WHERE { ?s ?p ?o } GROUP BY ?s } OPTIONAL { ?s ?q ?r } }',
      );
    });
  });

  describe('a sub-SELECT inside an EXISTS', () => {
    // SPARQL 1.2 joins the solution the EXISTS is evaluated for into the sub-SELECT too.
    const chain = new Store(new Parser().parse('@prefix : <ex://> . :a :p :b . :b :p :c . :c :p :d .'));

    const prefixes = 'PREFIX : <ex://>\n';

    it('keeps the name of a hidden variable the solution certainly binds', async({ expect }) => {
      const rewritten = await assertEquivalent(
        expect,
        `${prefixes}SELECT * { ?s :p ?o FILTER EXISTS { SELECT ?x { ?o :p ?x } } }`,
        chain,
      );
      expect(rewritten).not.toContain('SELECT ?x');
      expect(rewritten).toMatch(/\?o <ex:\/\/p> \?x/u);
    });

    it('keeps the projection hiding a variable the solution may bind', async({ expect }) => {
      const rewritten = await assertEquivalent(
        expect,
        `${prefixes}SELECT * { ?s :p ?o OPTIONAL { ?o :p ?z } FILTER EXISTS { SELECT ?x { ?z :p ?x } } }`,
        chain,
      );
      expect(rewritten).toContain('SELECT ?x');
    });

    it('renames a hidden variable the solution does not bind', async({ expect }) => {
      const rewritten = await assertEquivalent(
        expect,
        `${prefixes}SELECT * { ?s :p ?o FILTER EXISTS { { SELECT ?x { ?y :p ?x } } ?y :p ?o } }`,
        chain,
      );
      expect(rewritten).not.toContain('SELECT ?x');
      expect(rewritten).toMatch(/\?v_\d+ <ex:\/\/p> \?x/u);
    });
  });
});
