import type * as RDF from '@rdfjs/types';
import { Algebra, algebraUtils } from '@traqula/algebra-transformations-1-2';
import type { TransformationContext } from '../transformContext.js';
import type { QueryTransformation } from '../types.js';
import { termIsDataBlockValue } from '../utils/typeGuards.js';

/**
 * Transforms binds around the empty BGP or around a VALUES to be a VALUES itself.
 *
 * Only a term a VALUES row can hold: `BIND(?o AS ?s)` - which the assertion pushdown emits for every variable it
 * unified away - would turn into the nonsense `VALUES ?s { ?o }`, and a bind that fails, like that of
 * `<<( "x" :p :o )>>`, into a row that binds.
 */
export function transformExtendsToValues(c: TransformationContext, op: Algebra.Operation): Algebra.Operation {
  const { AF } = c;
  function transformExtend(op: Algebra.Extend): Algebra.Extend | Algebra.Values {
    if (op.expression.subType !== Algebra.ExpressionTypes.TERM || !termIsDataBlockValue(op.expression.term)) {
      return op;
    }
    // A triple term is a VALUES term in SPARQL 1.2, which the type of a row does not know.
    const term = <RDF.Literal | RDF.NamedNode> op.expression.term;
    if (op.input.type === Algebra.Types.BGP && op.input.patterns.length === 0) {
      return AF.createValues([ op.variable ], [{ [op.variable.value]: term }]);
    }
    if (op.input.type === Algebra.Types.VALUES) {
      return AF.createValues([ ...op.input.variables, op.variable ], op.input.bindings.map(x => ({
        ...x,
        [op.variable.value]: term,
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

/**
 * The pipeline step rewriting a `BIND` of a ground term over the empty BGP, or over a VALUES, into a VALUES itself.
 * @returns the transformation
 */
export function extendsToValuesTransformation(): QueryTransformation {
  return transformExtendsToValues;
}
