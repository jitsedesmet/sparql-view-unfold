import { describe, it } from 'vitest';
import { mappingFromConstructQueries } from '../lib/mapping.js';
import { createQueryRewriter } from '../lib/queryRewriter.js';
import { rewriteNonRecursivePathsTransformation } from '../lib/transformations/pathTransformation.js';
import { unfoldingTransformation } from '../lib/transformations/unfolding.js';
import { createTransformationContext, parseQuery } from '../lib/transformContext.js';

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

  // TODO: again, should be allowed bot the cods should be clear on what it means.
  //   Where clause retargetting, destination retarget.
  describe('an update, the rewriting being defined over queries', () => {
    const update = 'INSERT DATA { <ex://s> <ex://p> <ex://o> }';

    it('is rejected as a query string', async({ expect }) => {
      // The parse itself refuses it - an update only has an algebra in quad mode - so the precheck
      // never sees this one.
      await expect(rewriter.rewriteQuery(update)).rejects.toThrow();
    });

    it('is rejected as an algebra a caller hands in', async({ expect }) => {
      const parsedUpdate = parseQuery(createTransformationContext(), update, true);
      await expect(rewriter.rewriteOperation(parsedUpdate)).rejects.toThrow('cannot be rewritten');
    });
  });
});
