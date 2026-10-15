import { QueryEngine } from '@comunica/query-sparql-file';
import { describe, it } from 'vitest';
import { DT_INTERNAL_BNODE } from '../lib/consts.js';
import { mappingFromConstructQueries } from '../lib/mapping.js';
import { createDefaultTransformationPipeline, createQueryRewriter } from '../lib/queryRewriter.js';
import {
  internalBnodeAsSpecialIriTransformation,
  internalBnodeAsSpecialLiteral,
} from '../lib/transformations/bnodeMapAsLiteral.js';
import { createTransformationContext } from '../lib/transformContext.js';

describe('bnode skolem', () => {
  const c = createTransformationContext();
  const AF = c.AF;
  const DF = c.DF;

  it('skolem to literal no params', async({ expect }) => {
    const bnodeNoParams = AF.createNamedExpression(DF.namedNode('internal://blank'), []);
    expect(internalBnodeAsSpecialLiteral(c, bnodeNoParams))
      .toEqual(AF.createOperatorExpression('strdt', [
        AF.createOperatorExpression('struuid', []),
        AF.createTermExpression(DF.namedNode(DT_INTERNAL_BNODE)),
      ]));
  });

  it.skip('skolem to literal one var param', async({ expect }) => {
    const bnodeNoParams = AF.createNamedExpression(DF.namedNode('internal://blank'), [
      AF.createTermExpression(DF.variable('myVar')),
    ]);
    expect(internalBnodeAsSpecialLiteral(c, bnodeNoParams))
      .toEqual(AF.createOperatorExpression('strdt', [
        AF.createOperatorExpression('struuid', []),
        AF.createTermExpression(DF.namedNode(DT_INTERNAL_BNODE)),
      ]));
  });

  it('constructs the same node in every pattern it is unfolded into', async({ expect }) => {
    const rewriter = createQueryRewriter([ ...createDefaultTransformationPipeline(mappingFromConstructQueries([
      `CONSTRUCT { ?node <ex://first> ?first . ?node <ex://second> ?second } WHERE {
        ?subject <ex://p1> ?first . ?subject <ex://p2> ?second .
        BIND(<internal://blank>(?subject, ?first, ?second) AS ?node)
      }`,
    ])), internalBnodeAsSpecialIriTransformation() ]);
    const query = await rewriter.rewriteQuery('SELECT * WHERE { ?node <ex://first> ?first . ?node <ex://second> ?second }');
    const bindings = await new QueryEngine().queryBindings(query, { sources: [ './test/statics/data01.ttl' ]});

    await expect(bindings.toArray()).resolves.toHaveLength(1);
  });

  describe('with an argument an OPTIONAL leaves unbound', () => {
    const rewriter = createQueryRewriter([ ...createDefaultTransformationPipeline(mappingFromConstructQueries([
      `CONSTRUCT { ?node <ex://name> ?name } WHERE {
        ?person <ex://name> ?name .
        OPTIONAL { ?person <ex://nick> ?nick }
        BIND(<internal://blank>(?name, ?nick) AS ?node)
      }`,
    ])), internalBnodeAsSpecialIriTransformation() ]);

    async function constructedNodes(): Promise<(string | undefined)[]> {
      const query = await rewriter.rewriteQuery('SELECT ?node WHERE { ?node <ex://name> "Ann" }');
      const bindings = await new QueryEngine()
        .queryBindings(query, { sources: [ './test/statics/optionalBlankNodeArgument.ttl' ]});
      return (await bindings.toArray()).map(binding => binding.get('node')?.value);
    }

    it('still constructs a node for the solution leaving it unbound', async({ expect }) => {
      const nodes = await constructedNodes();
      expect(nodes).toHaveLength(2);
      expect(nodes).not.toContain(undefined);
    });

    it('constructs a different node than for the solution binding it', async({ expect }) => {
      expect(new Set(await constructedNodes()).size).toBe(2);
    });
  });
});
