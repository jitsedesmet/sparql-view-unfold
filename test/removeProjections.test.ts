import { QueryEngine } from '@comunica/query-sparql-file';
import * as arrayifyStreamNS from 'arrayify-stream';
import type { expect as Expect } from 'vitest';
import { describe, it } from 'vitest';
import { removeProjections } from '../lib/transformations/removeProjections.js';
import { queryTransform } from '../lib/transformBgp.js';
import { transformContextFromConstructs } from '../lib/transformContext.js';
import { nonTripleTermConstruct } from './queryConsts.js';

// Crazy workaround to support both CJS and ESM
const arrayifyStream =
  (<any> arrayifyStreamNS).default ?? arrayifyStreamNS;

describe('removeProjections', () => {
  // The pass through mapping leaves every pattern as it was, so the output only shows what
  // removeProjections itself did.
  function transform(query: string): string {
    return queryTransform(transformContextFromConstructs([ nonTripleTermConstruct ]), query, [ removeProjections ]);
  }

  const engine = new QueryEngine();

  async function bindings(query: string): Promise<string[]> {
    const rows: any[] = await arrayifyStream(await engine.queryBindings(query, {
      sources: [ './test/statics/multipleRdfReifiedTriples.ttl' ],
    }));
    return rows
      .map(row => [ ...row ].map(([ key, value ]: [any, any]) => `${key.value}=${value.value}`).sort().join('|'))
      .sort();
  }

  async function assertEquivalent(expect: typeof Expect, query: string): Promise<void> {
    const original = await bindings(query);
    expect(await bindings(transform(query))).toEqual(original);
    // Sanity: the query actually returns something so the test is meaningful.
    expect(original.length).toBeGreaterThan(0);
  }

  it('anonymizes the variables a subselect hides', ({ expect }) => {
    // ?p and ?o are not projected by the subselect, so they may not join with the outer ?p / ?o.
    expect(transform('SELECT ?s WHERE { ?s <ex://p> ?o { SELECT ?s WHERE { ?s ?p ?o } } }')).toContain('?v_0');
  });

  describe('deduplication with DISTINCT / REDUCED', () => {
    // Deduplication happens over the variables the projection exposes: dropping it would make
    // DISTINCT consider the anonymized variables as well, turning duplicates into distinct rows.
    it('keeps the projection of a sub-SELECT DISTINCT', ({ expect }) => {
      expect(transform('SELECT * WHERE { { SELECT DISTINCT ?s WHERE { ?s ?p ?o } } }'))
        .toContain('SELECT DISTINCT ?uq_s WHERE');
    });

    it('keeps the projection of a sub-SELECT REDUCED', ({ expect }) => {
      expect(transform('SELECT * WHERE { { SELECT REDUCED ?s WHERE { ?s ?p ?o } } }'))
        .toContain('SELECT REDUCED ?uq_s WHERE');
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
    // Dropping the projection is sound - it preserves multiplicity - but SPARQL cannot write a LIMIT
    // that is not on a SELECT, and `toAst` throws on the bare Slice it would be left holding.
    it('keeps the projection of a sub-SELECT with LIMIT', ({ expect }) => {
      expect(transform('SELECT * WHERE { { SELECT ?s WHERE { ?s ?p ?o } LIMIT 1 } }'))
        .toContain('LIMIT 1');
    });

    it('a sub-SELECT with LIMIT returns the same results', async({ expect }) => {
      await assertEquivalent(expect, 'SELECT * WHERE { { SELECT ?s WHERE { ?s ?p ?o } LIMIT 1 } }');
    });
  });
});
