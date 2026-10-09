import { describe, it } from 'vitest';
import { mappingFromConstructQueries } from '../lib/mapping.js';
import { createDefaultTransformationPipeline, createQueryRewriter } from '../lib/queryRewriter.js';
import type { QueryRewriter } from '../lib/queryRewriter.js';

/**
 * `nullifyJoinOverIncompatibleBounds` reads each join operand's top-level `EXTEND` chain and its recursion
 * halts at a `PROJECT`, so a bind still inside a sub-SELECT is invisible to it. That is why the default
 * pipeline runs it after `removeProjections` and `pullUpExtends`, and the query below is what shows it.
 */
describe('the default pipeline', () => {
  // The two mappings pin the subject to two different terms, each under its own predicate.
  const rewriter = createQueryRewriter(createDefaultTransformationPipeline(mappingFromConstructQueries([
    'CONSTRUCT { <ex://a> <ex://p> ?o } WHERE { ?o <ex://src1> ?x }',
    'CONSTRUCT { <ex://b> <ex://q> ?o } WHERE { ?o <ex://src2> ?x }',
  ])));

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
  ?v_1 <ex://q> ?v_2 .
  BIND( ?v_1 AS ?uq_s )
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
    // `?v_1` is read from an object position, which holds literals and triple terms as well.
    expect((await rewriter.rewriteQuery('SELECT * { ?a <ex://p> ?b }')).trim())
      .toEqual(`SELECT ( ?uq_a AS ?a ) ( ?uq_b AS ?b ) WHERE {
  {
    ?v_0 <ex://q> ?v_1 .
    FILTER ( ( ISIRI( ?v_1 ) || ISBLANK( ?v_1 ) ) )
  }
  BIND( ?v_1 AS ?uq_a )
  BIND( ?v_0 AS ?uq_b )
}`);
  });

  it('drops the type test once a clique puts the variable in a subject position', async({ expect }) => {
    // `sameTerm(?a, ?b)` equates the body's object with its subject, and a pattern binds its subject to an IRI or
    // a blank node only: the pattern decides the test.
    expect((await rewriter.rewriteQuery('SELECT * { ?a <ex://p> ?b FILTER(sameTerm(?a, ?b)) }')).trim())
      .toEqual(`SELECT ( ?uq_a AS ?a ) ( ?uq_b AS ?b ) WHERE {
  ?v_0 <ex://q> ?v_0 .
  BIND( ?v_0 AS ?uq_a )
  BIND( ?v_0 AS ?uq_b )
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
    // The two tests are one assertion about `?v_1`, holding the term types both of them admit.
    expect((await rewriter.rewriteQuery('SELECT * { ?a <ex://p> ?b FILTER(isIRI(?a)) }')).trim())
      .toEqual(`SELECT ( ?uq_a AS ?a ) ( ?uq_b AS ?b ) WHERE {
  {
    ?v_0 <ex://q> ?v_1 .
    FILTER ( ISIRI( ?v_1 ) )
  }
  BIND( ?v_1 AS ?uq_a )
  BIND( ?v_0 AS ?uq_b )
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
  ?v_0 <ex://q> ?v_1 .
  BIND( ?v_1 AS ?uq_a )
  BIND( ?v_0 AS ?uq_b )
}`);
    expect((await generalized.rewriteQuery('SELECT * { ?a <ex://p> ?b FILTER(isLITERAL(?a)) }')).trim())
      .toEqual(`SELECT ( ?uq_a AS ?a ) ( ?uq_b AS ?b ) WHERE {
  {
    ?v_0 <ex://q> ?v_1 .
    FILTER ( ISLITERAL( ?v_1 ) )
  }
  BIND( ?v_1 AS ?uq_a )
  BIND( ?v_0 AS ?uq_b )
}`);
  });
});

describe('the default pipeline over a generalized RDF view', () => {
  /**
   * The rewriter of the default pipeline over the generalized RDF view one CONSTRUCT query denotes.
   * @param construct - The CONSTRUCT query of the mapping
   * @returns the rewriter
   */
  function generalizedRdfViewRewriter(construct: string): QueryRewriter {
    return createQueryRewriter(createDefaultTransformationPipeline(
      mappingFromConstructQueries([ construct ], { generalizedRdfView: true }),
    ));
  }

  it('unifies a variable in two positions with the literal the head writes', async({ expect }) => {
    // The view holds `"lit" <ex://p> "lit"`: a rewrite holding `?x` to the subjects RDF admits empties the query.
    const rewriter = generalizedRdfViewRewriter('CONSTRUCT { ?o <ex://p> "lit" } WHERE { ?s <ex://q> ?o }');
    expect((await rewriter.rewriteQuery('SELECT * { ?x <ex://p> ?x }')).trim())
      .toEqual(`SELECT ( ?uq_x AS ?x ) WHERE {
  ?v_0 <ex://q> "lit" .
  BIND( "lit" AS ?uq_x )
}`);
  });

  it('keeps the type test inside a triple term the head writes', async({ expect }) => {
    // A triple term stays an RDF triple: `TRIPLE` raises for a literal subject, which would leave `?t` unbound.
    const rewriter = generalizedRdfViewRewriter(
      'CONSTRUCT { ?s <ex://p> <<( ?o <ex://q> ?s )>> } WHERE { ?s <ex://q> ?o }',
    );
    expect((await rewriter.rewriteQuery('SELECT * { ?s <ex://p> ?t }')).trim())
      .toEqual(`SELECT ( ?uq_s AS ?s ) ( ?uq_t AS ?t ) WHERE {
  {
    ?v_0 <ex://q> ?v_1 .
    FILTER ( ( ISIRI( ?v_1 ) || ISBLANK( ?v_1 ) ) )
  }
  BIND( ?v_0 AS ?uq_s )
  BIND( <<( ?v_1 <ex://q> ?v_0 )>> AS ?uq_t )
}`);
  });
});
