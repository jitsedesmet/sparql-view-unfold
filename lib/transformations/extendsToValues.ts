import type * as RDF from '@rdfjs/types';
import { Algebra, algebraUtils } from '@traqula/algebra-transformations-1-2';
import type { TransformContext } from '../transformContext.js';

/**
 * Transforms binds around the empty BGP or around a VALUES to be a VALUES itself.
 *
 * Only a *ground* term: a VALUES row holds terms, so `BIND(?o AS ?s)` - which the assertion pushdown emits
 * for every variable it unified away - would turn into the nonsense `VALUES ?s { ?o }`.
 */
export function transformExtendsToValues(c: TransformContext, op: Algebra.Operation): Algebra.Operation {
  const { AF } = c;
  function transformExtend(op: Algebra.Extend): Algebra.Extend | Algebra.Values {
    if (op.input.type === Algebra.Types.BGP && op.input.patterns.length === 0 &&
     op.expression.subType === Algebra.ExpressionTypes.TERM && op.expression.term.termType !== 'Variable'
    ) {
      return AF.createValues([ op.variable ], [{
        [op.variable.value]: <RDF.Literal | RDF.NamedNode> op.expression.term,
      }]);
    }
    if (op.input.type === Algebra.Types.VALUES && op.expression.subType === Algebra.ExpressionTypes.TERM &&
      op.expression.term.termType !== 'Variable') {
      const termExpr = <RDF.Literal | RDF.NamedNode> op.expression.term;
      return AF.createValues([ ...op.input.variables, op.variable ], op.input.bindings.map(x => ({
        ...x,
        [op.variable.value]: termExpr,
      })));
    }
    return op;
  }
  return algebraUtils.mapOperation<'unsafe', typeof op>(
    op,
    {
      [Algebra.Types.EXTEND]: { transform: transformExtend },
    },
  );
}
