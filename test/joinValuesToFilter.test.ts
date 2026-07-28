import { QueryEngine } from '@comunica/query-sparql-file';
import { toAst } from '@traqula/algebra-sparql-1-2';
import * as arrayifyStreamNS from 'arrayify-stream';
import type { expect as Expect } from 'vitest';
import { describe, it } from 'vitest';
import { transformJoinValuesToFilter } from '../lib/transformations/joinValuesToFilter.js';
import { pushDownRestrictors } from '../lib/transformations/pushDownRestrictors.js';
import type { TransformContext } from '../lib/transformContext.js';
import { createPartialContext, parseQuery } from '../lib/transformContext.js';

// Crazy workaround to support both CJS and ESM
const arrayifyStream =
  (<any> arrayifyStreamNS).default ?? arrayifyStreamNS;

describe('transformJoinValuesToFilter', () => {
  // The transformation only uses AF / astTransformer / generator / DF from the context, never the
  // mapping, so a mapping-less partial context is sufficient here.
  const c = <TransformContext> createPartialContext();

  function transform(query: string): string {
    const algebra = parseQuery(c, query);
    const transformed = transformJoinValuesToFilter(c, algebra);
    return c.generator.generate(toAst(transformed)).trim();
  }

  function expectTransform(expect: typeof Expect, query: string, expected: string): void {
    expect(transform(query)).toEqual(expected.trim());
  }

  describe('single-row VALUES over certainly-bound variables', () => {
    it('rewrites the whole VALUES into an equality conjunction over the join', ({ expect }) => {
      expectTransform(
        expect,
        'SELECT * WHERE { ?s <ex://p> ?o VALUES (?s ?o) { (<ex://a> <ex://b>) } }',
        `SELECT ?o ?s WHERE {
  ?s <ex://p> ?o .
  FILTER ( ( SAMETERM( ?s , <ex://a> ) && SAMETERM( ?o , <ex://b> ) ) )
}`,
      );
    });

    it('rewrites a single-variable VALUES into a single equality', ({ expect }) => {
      expectTransform(
        expect,
        'SELECT * WHERE { ?s <ex://p> ?o VALUES (?s) { (<ex://a>) } }',
        `SELECT ?o ?s WHERE {
  ?s <ex://p> ?o .
  FILTER ( SAMETERM( ?s , <ex://a> ) )
}`,
      );
    });

    it('treats a constant BIND as certainly bound and converts it', ({ expect }) => {
      expectTransform(
        expect,
        'SELECT * WHERE { ?s <ex://p> ?o BIND(<ex://z> AS ?b) VALUES (?b) { (<ex://z>) } }',
        `SELECT ?b ?o ?s WHERE {
  {
    ?s <ex://p> ?o .
    BIND( <ex://z> AS ?b )
  }
  FILTER ( SAMETERM( ?b , <ex://z> ) )
}`,
      );
    });

    it('extracts a column that is constant across all rows of a multi-row VALUES', ({ expect }) => {
      expectTransform(
        expect,
        'SELECT * WHERE { ?s <ex://p> ?o VALUES (?s ?o) { (<ex://a> <ex://x>) (<ex://a> <ex://y>) } }',
        `SELECT ?o ?s WHERE {
  ?s <ex://p> ?o .
  VALUES ?o {
    <ex://x>
    <ex://y>
  }
  FILTER ( SAMETERM( ?s , <ex://a> ) )
}`,
      );
    });
  });

  describe('contradicting joined VALUES', () => {
    it('collapses to an empty result when two VALUES fix the same variable to different constants', ({ expect }) => {
      expectTransform(
        expect,
        'SELECT * WHERE { ?s <ex://p> ?o VALUES (?s) { (<ex://a>) } VALUES (?s) { (<ex://b>) } }',
        `SELECT ?o ?s WHERE {
  FILTER ( FALSE )
}`,
      );
    });

    it('does not report a contradiction when a shared variable is not fixed to a single constant', ({ expect }) => {
      expectTransform(
        expect,
        'SELECT * WHERE { ?s <ex://p> ?o VALUES (?s) { (<ex://a>) } VALUES (?s ?o) { (<ex://a> <ex://x>) (<ex://b> <ex://y>) } }',
        `SELECT ?o ?s WHERE {
  ?s <ex://p> ?o .
  VALUES( ?s ?o ){
    ( <ex://a> <ex://x> )
    ( <ex://b> <ex://y> )
  }
  FILTER ( SAMETERM( ?s , <ex://a> ) )
}`,
      );
    });
  });

  describe('soundness guards (keep VALUES when not certainly bound)', () => {
    it('keeps a variable that the remaining operands do not bind in a residual VALUES', ({ expect }) => {
      expectTransform(
        expect,
        'SELECT * WHERE { ?s <ex://p> ?o VALUES (?s ?x) { (<ex://a> <ex://b>) } }',
        `SELECT ?o ?s ?x WHERE {
  ?s <ex://p> ?o .
  VALUES ?x {
    <ex://b>
  }
  FILTER ( SAMETERM( ?s , <ex://a> ) )
}`,
      );
    });

    it('leaves a multi-row VALUES untouched', ({ expect }) => {
      expectTransform(
        expect,
        'SELECT * WHERE { ?s <ex://p> ?o VALUES (?s) { (<ex://a>) (<ex://c>) } }',
        `SELECT ?o ?s WHERE {
  ?s <ex://p> ?o .
  VALUES ?s {
    <ex://a>
    <ex://c>
  }
}`,
      );
    });
  });

  describe('combination with pushDownRestrictors', () => {
    it('pushes the equalities produced from VALUES into every UNION branch', ({ expect }) => {
      const algebra = parseQuery(
        c,
        'SELECT * WHERE { { { ?s <ex://a> ?o } UNION { ?s <ex://b> ?o } } VALUES (?s) { (<ex://x>) } }',
      );
      const transformed = pushDownRestrictors(c, transformJoinValuesToFilter(c, algebra));
      expect(c.generator.generate(toAst(transformed)).trim()).toEqual(`SELECT ?o ?s WHERE {
  {
    {
      ?s <ex://a> ?o .
      FILTER ( SAMETERM( ?s , <ex://x> ) )
    }
  }
  UNION {
    {
      ?s <ex://b> ?o .
      FILTER ( SAMETERM( ?s , <ex://x> ) )
    }
  }
}`);
    });
  });

  describe('idempotence', () => {
    it('applying the transformation twice yields the same result as once', ({ expect }) => {
      const query = 'SELECT * WHERE { ?s <ex://p> ?o VALUES (?s ?o) { (<ex://a> <ex://b>) } }';
      const once = transform(query);
      const algebra = parseQuery(c, query);
      const twiceOp = transformJoinValuesToFilter(c, transformJoinValuesToFilter(c, algebra));
      const twice = c.generator.generate(toAst(twiceOp)).trim();
      expect(twice).toEqual(once);
    });
  });

  describe('semantic equivalence (evaluation)', () => {
    const engine = new QueryEngine();

    async function bindings(query: string): Promise<string[]> {
      const stream = await engine.queryBindings(query, {
        sources: [ './test/statics/multipleRdfReifiedTriples.ttl' ],
      });
      const rows: any[] = await arrayifyStream(stream);
      return rows
        .map(row => [ ...row ].map(([ k, v ]: [any, any]) => `${k.value}=${v.value}`).sort().join('|'))
        .sort();
    }

    async function assertEquivalent(expect: typeof Expect, query: string): Promise<void> {
      const original = await bindings(query);
      const transformed = await bindings(transform(query));
      expect(transformed).toEqual(original);
      // Sanity: the query actually returns something so the test is meaningful.
      expect(original.length).toBeGreaterThan(0);
    }

    it('single-row VALUES over a bound variable produces identical results', async({ expect }) => {
      await assertEquivalent(expect, `PREFIX : <ex://>
        SELECT * WHERE {
          ?s :knows ?o
          VALUES (?s) { (:alice) }
        }`);
    });

    it('single-row VALUES over multiple bound variables produces identical results', async({ expect }) => {
      await assertEquivalent(expect, `PREFIX : <ex://>
        SELECT * WHERE {
          ?s :knows ?o
          VALUES (?s ?o) { (:alice :bob) }
        }`);
    });

    it('residual VALUES over an unbound variable produces identical results', async({ expect }) => {
      await assertEquivalent(expect, `PREFIX : <ex://>
        SELECT * WHERE {
          ?s :knows ?o
          VALUES (?s ?x) { (:alice :bob) }
        }`);
    });
  });
});
