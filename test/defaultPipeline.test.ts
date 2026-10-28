import { describe, it } from 'vitest';
import {
  createDefaultTransformationPipeline,
  createQueryRewriter,
  filterFalseTransformation,
  mappingFromConstructQueries,
  nullifyJoinOverIncompatibleBoundsTransformation,
  pullUpExtendsTransformation,
  pushDownAssertionsTransformation,
  removeProjectionsTransformation,
  unfoldingTransformation,
} from '../lib/index.js';

/**
 * `nullifyJoinOverIncompatibleBounds` reads each join operand's top-level `EXTEND` chain and its recursion
 * halts at a `PROJECT`, so a bind still inside a sub-SELECT is invisible to it. The default pipeline keeps the
 * sub-SELECTs, so the pass needs `removeProjections` before it, and the query below is what shows it.
 */
describe('nullifyJoinOverIncompatibleBounds after removeProjections', () => {
  // The two mappings pin the subject to two different terms, each under its own predicate.
  const mapping = mappingFromConstructQueries([
    'CONSTRUCT { <ex://a> <ex://p> ?o } WHERE { ?o <ex://src1> ?x }',
    'CONSTRUCT { <ex://b> <ex://q> ?o } WHERE { ?o <ex://src2> ?x }',
  ]);
  const rewriter = createQueryRewriter([
    unfoldingTransformation(mapping),
    filterFalseTransformation(),
    pushDownAssertionsTransformation(),
    filterFalseTransformation(),
    pullUpExtendsTransformation(),
    filterFalseTransformation(),
    removeProjectionsTransformation(),
    nullifyJoinOverIncompatibleBoundsTransformation(),
    filterFalseTransformation(),
  ]);

  it('collapses a join of two patterns that pin one variable to different terms', async({ expect }) => {
    // `?s` would have to be <ex://a> for the first pattern and <ex://b> for the second.
    expect((await rewriter.rewriteQuery('SELECT * { ?s <ex://p> ?o1 . ?s <ex://q> ?o2 }')).trim())
      .toEqual(`SELECT ( ?uq_o1 AS ?o1 ) ( ?uq_o2 AS ?o2 ) ( ?uq_s AS ?s ) WHERE {
  FILTER ( FALSE )
}`);
  });

  it('leaves a join whose patterns agree on that variable alone', async({ expect }) => {
    // Sanity: the collapse above is about the conflict, not about the shape of the query.
    expect(await rewriter.rewriteQuery('SELECT * { ?s <ex://p> ?o1 . ?s <ex://p> ?o2 }'))
      .not.toContain('FILTER ( FALSE )');
  });
});

describe('the default pipeline over an OPTIONAL', () => {
  // The first mapping pins the object to "1", the second maps a predicate straight through.
  const rewriter = createQueryRewriter(createDefaultTransformationPipeline(mappingFromConstructQueries([
    'CONSTRUCT { ?s <ex://p> "1" } WHERE { ?s <ex://q> ?y }',
    'CONSTRUCT { ?s <ex://r> ?x } WHERE { ?s <ex://t> ?x }',
  ])));

  it('drops an OPTIONAL whose condition the pushdown folds to FALSE', async({ expect }) => {
    // The outer filter pins `?o` to "1", which substituted into the OPTIONAL's condition asks "1" to be "2".
    expect((await rewriter.rewriteQuery(
      'SELECT * { ?s <ex://p> ?o FILTER(SAMETERM(?o, "1")) OPTIONAL { ?s <ex://r> ?x FILTER(SAMETERM(?o, "2")) } }',
    )).trim()).toEqual(`SELECT ( ?uq_o AS ?o ) ( ?uq_s AS ?s ) ( ?uq_x AS ?x ) WHERE {
  {
    SELECT ( ?mi_s AS ?uq_s ) WHERE {
      SELECT ?mi_s WHERE {
        ?mi_s <ex://q> ?mi_y .
      }
    }
  }
  BIND( "1" AS ?uq_o )
}`);
  });

  it('keeps an OPTIONAL whose condition the pushdown folds to TRUE', async({ expect }) => {
    // Sanity: the drop above is about the condition, not about the shape of the query.
    expect(await rewriter.rewriteQuery(
      'SELECT * { ?s <ex://p> ?o FILTER(SAMETERM(?o, "1")) OPTIONAL { ?s <ex://r> ?x FILTER(SAMETERM(?o, "1")) } }',
    )).toContain('OPTIONAL');
  });
});

describe('the default pipeline over a mapping that types its head', () => {
  // The head writes the body's object into its subject position, where a literal or a triple term makes no
  // triple, so the mapping body tests it for an IRI or a blank node.
  const construct = 'CONSTRUCT { ?o <ex://p> ?s } WHERE { ?s <ex://q> ?o }';
  const rewriter = createQueryRewriter(createDefaultTransformationPipeline(mappingFromConstructQueries([ construct ])));

  it('keeps the type test where nothing guarantees it', async({ expect }) => {
    // `?mi_o` is read from an object position, which holds literals and triple terms as well.
    expect((await rewriter.rewriteQuery('SELECT * { ?a <ex://p> ?b }')).trim())
      .toEqual(`SELECT ( ?uq_a AS ?a ) ( ?uq_b AS ?b ) WHERE {
  SELECT ( ?mi_o AS ?uq_a ) ( ?mi_s AS ?uq_b ) WHERE {
    ?mi_s <ex://q> ?mi_o .
    FILTER ( ( ISIRI( ?mi_o ) || ISBLANK( ?mi_o ) ) )
  }
}`);
  });

  it('drops the type test once a clique puts the variable in a subject position', async({ expect }) => {
    // `sameTerm(?a, ?b)` equates the body's object with its subject, and a pattern binds its subject to an IRI or
    // a blank node only: the pattern decides the test.
    expect((await rewriter.rewriteQuery('SELECT * { ?a <ex://p> ?b FILTER(sameTerm(?a, ?b)) }')).trim())
      .toEqual(`SELECT ( ?uq_a AS ?a ) ( ?uq_b AS ?b ) WHERE {
  SELECT ( ?mi_o AS ?uq_a ) ( ?mi_o AS ?uq_b ) WHERE {
    ?mi_o <ex://q> ?mi_o .
  }
}`);
  });

  it('empties the query when a user type test contradicts the mapping\'s', async({ expect }) => {
    // No triple of the view has a literal subject.
    expect((await rewriter.rewriteQuery('SELECT * { ?a <ex://p> ?b FILTER(isLITERAL(?a)) }')).trim())
      .toEqual(`SELECT ( ?uq_a AS ?a ) ( ?uq_b AS ?b ) WHERE {
  FILTER ( FALSE )
}`);
  });

  it('narrows the mapping\'s type test to a narrower one of the user', async({ expect }) => {
    // The two tests are one assertion about `?mi_o`, holding the term types both of them admit.
    expect((await rewriter.rewriteQuery('SELECT * { ?a <ex://p> ?b FILTER(isIRI(?a)) }')).trim())
      .toEqual(`SELECT ( ?uq_a AS ?a ) ( ?uq_b AS ?b ) WHERE {
  SELECT ( ?mi_o AS ?uq_a ) ( ?mi_s AS ?uq_b ) WHERE {
    ?mi_s <ex://q> ?mi_o .
    FILTER ( ISIRI( ?mi_o ) )
  }
}`);
  });

  it('writes no type test for a generalized RDF view', async({ expect }) => {
    // The view keeps the triples with a literal subject, so the body is read as it stands, and a user isLITERAL is
    // a condition on it rather than a contradiction.
    const generalized = createQueryRewriter(createDefaultTransformationPipeline(
      mappingFromConstructQueries([ construct ], { generalizedRdfView: true }),
    ));
    expect((await generalized.rewriteQuery('SELECT * { ?a <ex://p> ?b }')).trim())
      .toEqual(`SELECT ( ?uq_a AS ?a ) ( ?uq_b AS ?b ) WHERE {
  SELECT ( ?mi_o AS ?uq_a ) ( ?mi_s AS ?uq_b ) WHERE {
    ?mi_s <ex://q> ?mi_o .
  }
}`);
    expect((await generalized.rewriteQuery('SELECT * { ?a <ex://p> ?b FILTER(isLITERAL(?a)) }')).trim())
      .toEqual(`SELECT ( ?uq_a AS ?a ) ( ?uq_b AS ?b ) WHERE {
  SELECT ( ?mi_o AS ?uq_a ) ( ?mi_s AS ?uq_b ) WHERE {
    ?mi_s <ex://q> ?mi_o .
    FILTER ( ISLITERAL( ?mi_o ) )
  }
}`);
  });
});
