import { describe, it } from 'vitest';
import { removeProjectionsTransformation } from '../lib/transformations/removeProjections.js';
import { createValidatingQueryRewriter } from './validQuery.js';

/**
 * `toAst` writes a bind of a group key directly below its group as `GROUP BY (expr AS ?key)`, a variable Jena and
 * Oxigraph do not bind where aggregates read, so the rewriter has its aggregates read what the key is bound to.
 */
describe('a group key an aggregate reads', () => {
  const identityRewriter = createValidatingQueryRewriter([]);

  it('is read through the variable it is renamed from when removeProjections drops a sub-SELECT', async({ expect }) => {
    const rewriter = createValidatingQueryRewriter([ removeProjectionsTransformation() ]);
    expect((await rewriter.rewriteQuery(
      'SELECT ?c (COUNT(?c) AS ?n) WHERE { { SELECT ?c WHERE { ?i <ex://q> ?x BIND(?x AS ?c) } } } GROUP BY ?c',
    )).trim()).toEqual(`SELECT ?c ( COUNT( ?v_0 ) AS ?n ) WHERE {
  ?v_1 <ex://q> ?v_0 .
}
GROUP BY ( ?v_0 AS ?c )`);
  });

  it('is read through a fresh variable binding its expression', async({ expect }) => {
    expect((await identityRewriter.rewriteQuery(
      'SELECT ?c (COUNT(?c) AS ?n) WHERE { ?s ?p ?o BIND(STR(?o) AS ?c) } GROUP BY ?c',
    )).trim()).toEqual(`SELECT ?c ( COUNT( ?v_0 ) AS ?n ) WHERE {
  ?s ?p ?o .
  BIND( STR( ?o ) AS ?v_0 )
}
GROUP BY ( ?v_0 AS ?c )`);
  });

  it('is read through that fresh variable in BOUND too, where no expression can stand', async({ expect }) => {
    expect((await identityRewriter.rewriteQuery(
      'SELECT ?c (SUM(IF(BOUND(?c), 1, 0)) AS ?n) WHERE { ?s ?p ?o BIND(STR(?o) AS ?c) } GROUP BY ?c',
    )).trim()).toEqual(`SELECT ?c ( SUM( IF( BOUND( ?v_0 ) , "1"^^<http://www.w3.org/2001/XMLSchema#integer> , \
"0"^^<http://www.w3.org/2001/XMLSchema#integer> ) ) AS ?n ) WHERE {
  ?s ?p ?o .
  BIND( STR( ?o ) AS ?v_0 )
}
GROUP BY ( ?v_0 AS ?c )`);
  });

  it('is read through a fresh variable when bound to another key, possibly a condition itself', async({ expect }) => {
    expect((await identityRewriter.rewriteQuery(
      'SELECT ?a (COUNT(?a) AS ?n) WHERE { ?s ?p ?o } GROUP BY (STR(?o) AS ?b) (?b AS ?a)',
    )).trim()).toEqual(`SELECT ?a ( COUNT( ?v_0 ) AS ?n ) WHERE {
  ?s ?p ?o .
  BIND( STR( ?o ) AS ?b )
  BIND( ?b AS ?v_0 )
}
GROUP BY ?b ( ?v_0 AS ?a )`);
  });

  it('is read through a fresh variable when the variable it is bound to occurs in an aggregate', async({ expect }) => {
    // Renamed onto ?o, the ?c of the sub-SELECT would join the ?o it hides.
    expect(await identityRewriter.rewriteQuery(`SELECT ?c (SUM(IF(EXISTS { SELECT ?z WHERE { ?c <ex://q> ?z . ?z <ex://r> ?o } },
      1, 0)) AS ?n) WHERE { ?s ?p ?o } GROUP BY (?o AS ?c)`)).toContain(`?v_0 <ex://q> ?z .
      ?z <ex://r> ?o .`);
  });

  it('leaves a key no aggregate reads a GROUP BY condition', async({ expect }) => {
    expect((await identityRewriter.rewriteQuery(
      'SELECT ?c (COUNT(*) AS ?n) WHERE { ?s ?p ?o BIND(STR(?o) AS ?c) } GROUP BY ?c',
    )).trim()).toEqual(`SELECT ?c ( COUNT( * ) AS ?n ) WHERE {
  ?s ?p ?o .
}
GROUP BY ( STR( ?o ) AS ?c )`);
  });
});
