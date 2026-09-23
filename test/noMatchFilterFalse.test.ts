import { QueryEngine } from '@comunica/query-sparql-file';
import type * as RDF from '@rdfjs/types';
import * as arrayifyStreamNS from 'arrayify-stream';
import { DataFactory, Store } from 'n3';
import { describe, it, vi } from 'vitest';
import { ClusterSolver } from '../lib/ClusterSolver.js';
import { mappingFromConstructQueries } from '../lib/mapping.js';
import { createQueryRewriter } from '../lib/queryRewriter.js';
import { filterFalseTransformation } from '../lib/transformations/filterFalse.js';
import { unfoldingTransformation } from '../lib/transformations/unfolding.js';

// Crazy workaround to support both CJS and ESM
const arrayifyStream =
  (<any> arrayifyStreamNS).default ?? arrayifyStreamNS;

/**
 * A triple pattern that cannot match the mapping at all is ordinary rather than exceptional: with a single
 * mapping the head pins a position, and a user pattern writing a different constant there matches nothing.
 * It has to unfold to the empty solution multiset - `FILTER(FALSE)` - instead of throwing out of the
 * rewriter. With several mappings the merged `?m_s ?m_p ?m_o` head turns the same clash into a filter, so
 * only the single-mapping path shows this.
 */
describe('a pattern that cannot match the mapping', () => {
  // The head pins the subject to <ex://a>.
  const mapping = mappingFromConstructQueries([
    'CONSTRUCT { <ex://a> ?p ?o } WHERE { ?p <ex://src> ?o }',
  ]);
  const rewriter = createQueryRewriter([
    unfoldingTransformation(mapping),
    filterFalseTransformation(),
  ]);

  it('unfolds to FILTER(FALSE) rather than throwing', async({ expect }) => {
    expect((await rewriter.rewriteQuery(
      'SELECT * { <ex://b> <ex://p> ?o1 . <ex://b> <ex://q> ?o2 }',
    )).trim()).toEqual(`SELECT ( ?uq_o1 AS ?o1 ) ( ?uq_o2 AS ?o2 ) WHERE {
  FILTER ( FALSE )
}`);
  });

  it('lets an error that is not a failed unification propagate', async({ expect }) => {
    const register = vi.spyOn(ClusterSolver.prototype, 'register').mockImplementation(() => {
      throw new TypeError('a genuine bug, not a failed unification');
    });
    try {
      await expect(rewriter.rewriteQuery('SELECT * { <ex://a> <ex://p> ?o }'))
        .rejects.toThrow('a genuine bug, not a failed unification');
    } finally {
      register.mockRestore();
    }
  });

  it('answers what the mapped graph answers, which is nothing', async({ expect }) => {
    const engine = new QueryEngine();
    const DF = DataFactory;
    const store11 = new Store([
      DF.quad(DF.namedNode('ex://p'), DF.namedNode('ex://src'), DF.namedNode('ex://o')),
    ]);
    const userQuery = 'SELECT * { <ex://b> ?p ?o }';

    // The RDF 1.2 graph the mapping denotes holds `<ex://a> <ex://p> <ex://o>` and nothing else.
    const mappedQuads: RDF.Quad[] = await arrayifyStream(await engine.queryQuads(
      'CONSTRUCT { <ex://a> ?p ?o } WHERE { ?p <ex://src> ?o }',
      { sources: [ store11 ]},
    ));
    const onMappedData: RDF.Bindings[] = await arrayifyStream(
      await engine.queryBindings(userQuery, { sources: [ new Store(mappedQuads) ]}),
    );
    expect(onMappedData).toHaveLength(0);

    const usingRewriter: RDF.Bindings[] = await arrayifyStream(await engine.queryBindings(
      await rewriter.rewriteQuery(userQuery),
      { sources: [ store11 ]},
    ));
    expect(usingRewriter).toHaveLength(0);
  });
});
