import { describe, it } from 'vitest';
import { mappingFromConstructQueries } from '../lib/mapping.js';
import { createDefaultTransformationPipeline, createQueryRewriter } from '../lib/queryRewriter.js';

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
      .toEqual(`SELECT ?o1 ?o2 ?s WHERE {
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
    )).trim()).toEqual(`SELECT ( "1" AS ?o ) ?s ?x WHERE {
  ?v_1 <ex://q> ?v_2 .
  BIND( ?v_1 AS ?s )
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
      .toEqual(`SELECT ?a ?b WHERE {
  {
    ?v_0 <ex://q> ?v_1 .
    FILTER ( ( ISIRI( ?v_1 ) || ISBLANK( ?v_1 ) ) )
  }
  BIND( ?v_1 AS ?a )
  BIND( ?v_0 AS ?b )
}`);
  });

  it('drops the type test once a clique puts the variable in a subject position', async({ expect }) => {
    // `sameTerm(?a, ?b)` equates the body's object with its subject, and a pattern binds its subject to an IRI or
    // a blank node only: the pattern decides the test.
    expect((await rewriter.rewriteQuery('SELECT * { ?a <ex://p> ?b FILTER(sameTerm(?a, ?b)) }')).trim())
      .toEqual(`SELECT ?a ( ?a AS ?b ) WHERE {
  ?v_0 <ex://q> ?v_0 .
  BIND( ?v_0 AS ?a )
}`);
  });

  it('empties the query when a user type test contradicts the mapping\'s', async({ expect }) => {
    // No triple of the view has a literal subject.
    expect((await rewriter.rewriteQuery('SELECT * { ?a <ex://p> ?b FILTER(isLITERAL(?a)) }')).trim())
      .toEqual(`SELECT ?a ?b WHERE {
  FILTER ( FALSE )
}`);
  });

  it('narrows the mapping\'s type test to a narrower one of the user', async({ expect }) => {
    // The two tests are one assertion about `?v_1`, holding the term types both of them admit.
    expect((await rewriter.rewriteQuery('SELECT * { ?a <ex://p> ?b FILTER(isIRI(?a)) }')).trim())
      .toEqual(`SELECT ?a ?b WHERE {
  {
    ?v_0 <ex://q> ?v_1 .
    FILTER ( ISIRI( ?v_1 ) )
  }
  BIND( ?v_1 AS ?a )
  BIND( ?v_0 AS ?b )
}`);
  });

  it('writes no type test for a generalized RDF view', async({ expect }) => {
    // The view keeps the triples with a literal subject, so the body is read as it stands, and a user isLITERAL is
    // a condition on it rather than a contradiction.
    const generalized = createQueryRewriter(createDefaultTransformationPipeline(
      mappingFromConstructQueries([ construct ], { generalizedRdfView: true }),
    ));
    expect((await generalized.rewriteQuery('SELECT * { ?a <ex://p> ?b }')).trim())
      .toEqual(`SELECT ?a ?b WHERE {
  ?v_0 <ex://q> ?v_1 .
  BIND( ?v_1 AS ?a )
  BIND( ?v_0 AS ?b )
}`);
    expect((await generalized.rewriteQuery('SELECT * { ?a <ex://p> ?b FILTER(isLITERAL(?a)) }')).trim())
      .toEqual(`SELECT ?a ?b WHERE {
  {
    ?v_0 <ex://q> ?v_1 .
    FILTER ( ISLITERAL( ?v_1 ) )
  }
  BIND( ?v_1 AS ?a )
  BIND( ?v_0 AS ?b )
}`);
  });
});

describe('the default pipeline over an empty group', () => {
  const rewriter = createQueryRewriter(createDefaultTransformationPipeline(mappingFromConstructQueries([
    'CONSTRUCT { ?s <ex://p> ?o } WHERE { ?s <ex://q> ?o }',
  ])));

  // A zero-length path between equal terms expands to an empty group as well.
  it.for([ 'SELECT * {}', 'SELECT * { <ex://a> <ex://p>? <ex://a> }' ])(
    'keeps the empty group of %s as it stands',
    async(query, { expect }) => {
      expect((await rewriter.rewriteQuery(query)).trim()).toEqual(`SELECT * WHERE {
}`);
    },
  );

  it('keeps an empty group beside an unfolded pattern', async({ expect }) => {
    expect((await rewriter.rewriteQuery('SELECT * { { } UNION { ?s <ex://p> ?o } }')).trim())
      .toEqual(`SELECT ?o ?s WHERE {
  {
  }
  UNION {
    {
      ?v_0 <ex://q> ?v_1 .
      BIND( ?v_1 AS ?o )
      BIND( ?v_0 AS ?s )
    }
  }
}`);
  });
});

describe('the default pipeline over a head variable the pattern writes a triple term into', () => {
  // The body builds the triple term with a subject read from an object position, so it is type tested.
  const rewriter = createQueryRewriter(createDefaultTransformationPipeline(mappingFromConstructQueries([
    'CONSTRUCT { <ex://all> <ex://p> ?o } WHERE { ?x <ex://r> ?s BIND(TRIPLE(?s, <ex://q>, ?x) AS ?o) }',
  ])));

  it('reads the components from the body once the type test makes the construction infallible', async({ expect }) => {
    expect((await rewriter.rewriteQuery('SELECT * { <ex://all> <ex://p> <<( ?a <ex://q> ?b )>> }')).trim())
      .toEqual(`SELECT ?a ?b WHERE {
  {
    {
      ?v_0 <ex://r> ?v_1 .
      FILTER ( ( ISIRI( ?v_1 ) || ISBLANK( ?v_1 ) ) )
    }
    FILTER ( TRUE )
  }
  BIND( ?v_1 AS ?a )
  BIND( ?v_0 AS ?b )
}`);
  });
});
