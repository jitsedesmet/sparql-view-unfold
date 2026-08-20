import { Algebra } from '@traqula/algebra-transformations-1-2';
import type { TransformContext } from '../transformContext.js';
import { datatypeBoolean, DF } from './rdfDatatypes.js';

/** The literal `false` with xsd:boolean datatype, used for FILTER(FALSE) patterns */
export const termFalse = DF.literal('false', datatypeBoolean);

/** The literal `true` with xsd:boolean datatype, the condition of a filter that constrains nothing */
export const termTrue = DF.literal('true', datatypeBoolean);

/** Whether an operation is the `FILTER(FALSE)` sentinel for a pattern that never matches. */
export function isFilterFalse(c: TransformContext, op: Algebra.Operation): boolean {
  return op.type === Algebra.Types.FILTER && op.expression.subType === Algebra.ExpressionTypes.TERM &&
        op.expression.term.equals(termFalse);
}

/**
 * Creates the `FILTER(FALSE)` over `op` (an empty BGP by default) that represents an empty result set:
 * in SPARQL algebra it is the empty multiset, absorbing for JOIN and identity for UNION.
 */
export function createFilterFalse(c: TransformContext, op?: Algebra.Operation): Algebra.Filter {
  return c.AF.createFilter(op ?? c.AF.createBgp([]), c.AF.createTermExpression(termFalse));
}
