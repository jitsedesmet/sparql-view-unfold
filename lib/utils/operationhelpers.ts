import { Algebra } from '@traqula/algebra-transformations-1-2';
import type { TransformContext } from '../transformContext.js';
import { datatypeBoolean, DF } from './rdfDatatypes.js';

/** The literal `false` with xsd:boolean datatype, used for FILTER(FALSE) patterns */
export const termFalse = DF.literal('false', datatypeBoolean);

/**
 * Checks if an operation is a FILTER(FALSE) pattern.
 * FILTER(FALSE) is used as a sentinel to represent patterns that will never match.
 * @param c - Transform context
 * @param op - The operation to check
 * @returns True if the operation is FILTER(FALSE)
 */
export function isFilterFalse(c: TransformContext, op: Algebra.Operation): boolean {
  return op.type === Algebra.Types.FILTER && op.expression.subType === Algebra.ExpressionTypes.TERM &&
        op.expression.term.equals(termFalse);
}

/**
 * Creates a FILTER(FALSE) operation, used to represent an empty result set.
 * In SPARQL algebra, FILTER(FALSE) is equivalent to the empty multiset
 * and is absorbing for JOIN and identity for UNION.
 * @param c - Transform context
 * @param op - Optional input operation (defaults to empty BGP)
 * @returns A Filter operation with FALSE as the condition
 */
export function createFilterFalse(c: TransformContext, op?: Algebra.Operation): Algebra.Filter {
  return c.AF.createFilter(op ?? c.AF.createBgp([]), c.AF.createTermExpression(termFalse));
}
