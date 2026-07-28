import { describe, it } from 'vitest';
import { DT_INTERNAL_BNODE } from '../lib/consts.js';
import { internalBnodeAsSpecialLiteral } from '../lib/transformations/bnodeMapAsLiteral.js';
import { type TransformContext, transformContextFromConstructs } from '../lib/transformContext.js';

describe('bnode skolem', () => {
  const c: TransformContext = transformContextFromConstructs([ 'CONSTRUCT WHERE {?s ?p ?o}' ]);
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

  it('skolem to literal two vars param', async({ expect }) => {
    const bnodeNoParams = AF.createNamedExpression(DF.namedNode('internal://blank'), [
      AF.createTermExpression(DF.variable('myVarA')),
      AF.createTermExpression(DF.variable('myVarB')),
    ]);
    const bnodeNoParams2 = AF.createNamedExpression(DF.namedNode('internal://blank'), [
      AF.createTermExpression(DF.variable('myVarB')),
      AF.createTermExpression(DF.variable('myVarA')),
    ]);

    const res1 = internalBnodeAsSpecialLiteral(c, bnodeNoParams);
    const res2 = internalBnodeAsSpecialLiteral(c, bnodeNoParams2);
    expect(res1).toEqual(res2);
  });
});
