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
