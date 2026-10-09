import { describe, it } from 'vitest';
import { mappingFromConstructQueries } from '../lib/mapping.js';
import { createQueryRewriter } from '../lib/queryRewriter.js';
import { rewriteNonRecursivePathsTransformation } from '../lib/transformations/pathTransformation.js';
import { unfoldingTransformation } from '../lib/transformations/unfolding.js';

/**
 * The restrictions of {@link userQueryRestrictions!assertUserQueryIsSupported}, over the pass-through
 * mapping: what these check is what the rewriter refuses to be handed, not what any mapping does with it.
 */
describe('the restrictions on a user query', () => {
  const rewriter = createQueryRewriter([
    rewriteNonRecursivePathsTransformation(),
    unfoldingTransformation(mappingFromConstructQueries([ 'CONSTRUCT WHERE { ?s ?p ?o }' ])),
  ]);

  describe('a recursive property path', () => {
    it('is rejected when it is `+`, naming the operator', async({ expect }) => {
      await expect(rewriter.rewriteQuery('SELECT * { ?s <ex://p>+ ?o }'))
        .rejects.toThrow('A recursive property path (+) is not supported');
    });

    it('is rejected when it is `*`, naming the operator', async({ expect }) => {
      await expect(rewriter.rewriteQuery('SELECT * { ?s <ex://p>* ?o }'))
        .rejects.toThrow('A recursive property path (*) is not supported');
    });

    it('is rejected inside a larger path', async({ expect }) => {
      await expect(rewriter.rewriteQuery('SELECT * { ?s <ex://p>/<ex://q>+ ?o }'))
        .rejects.toThrow('A recursive property path (+) is not supported');
    });
  });

  describe('a non-recursive property path', () => {
    for (const [ operator, query ] of <const>[
      [ '?', 'SELECT * { ?s <ex://p>? ?o }' ],
      [ '|', 'SELECT * { ?s <ex://p>|<ex://q> ?o }' ],
      [ '/', 'SELECT * { ?s <ex://p>/<ex://q> ?o }' ],
      [ '^', 'SELECT * { ?s ^<ex://p> ?o }' ],
      [ '!', 'SELECT * { ?s !(<ex://p>|<ex://q>) ?o }' ],
    ]) {
      it(`is accepted when it is \`${operator}\``, async({ expect }) => {
        await expect(rewriter.rewriteQuery(query)).resolves.toBeTypeOf('string');
      });
    }
  });

  it('rejects a GRAPH, whose semantics under unfolding are not settled', async({ expect }) => {
    await expect(rewriter.rewriteQuery('SELECT * { GRAPH ?g { ?s <ex://p> ?o } }'))
      .rejects.toThrow('Querying a named graph (GRAPH) is not supported');
  });

  // An update parses in quad mode, the only mode it has an algebra in, so its GRAPH is the graph component
  // of a pattern rather than an operation of its own.
  it('rejects a GRAPH an update names as the graph of a pattern', async({ expect }) => {
    await expect(rewriter.rewriteQuery('DELETE { ?s <ex://p> ?o } WHERE { GRAPH ?g { ?s <ex://p> ?o } }'))
      .rejects.toThrow('Querying a named graph (GRAPH) is not supported');
  });

  describe('a SERVICE, whose semantics under unfolding are not settled', () => {
    for (const [ placement, query ] of <const>[
      [ 'at the top', 'SELECT * { SERVICE <ex://endpoint> { ?s <ex://p> ?o } }' ],
      [ 'under an OPTIONAL', 'SELECT * { ?s <ex://p> ?o OPTIONAL { SERVICE <ex://endpoint> { ?o <ex://q> ?x } } }' ],
      [ 'inside an EXISTS', 'SELECT * { ?s <ex://p> ?o FILTER EXISTS { SERVICE <ex://endpoint> { ?o <ex://q> ?x } } }' ],
      [ 'in the WHERE of an update', 'DELETE { ?s <ex://p> ?o } WHERE { SERVICE <ex://endpoint> { ?s <ex://p> ?o } }' ],
    ]) {
      it(`is rejected ${placement}`, async({ expect }) => {
        await expect(rewriter.rewriteQuery(query))
          .rejects.toThrow('Querying a remote endpoint (SERVICE) is not supported');
      });
    }
  });

  it('accepts a SERVICE in the mapping body, which the restrictions on a user query do not read', async({ expect }) => {
    const serviceRewriter = createQueryRewriter([
      unfoldingTransformation(mappingFromConstructQueries([
        'CONSTRUCT { ?s ?p ?o } WHERE { SERVICE <ex://endpoint> { ?s ?p ?o } }',
      ])),
    ]);
    await expect(serviceRewriter.rewriteQuery('SELECT * { ?s <ex://p> ?o }')).resolves.toContain('SERVICE');
  });
});
