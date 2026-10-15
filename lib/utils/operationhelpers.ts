import { Algebra } from '@traqula/algebra-transformations-1-2';
import type { TransformationContext } from '../transformContext.js';
import { datatypeBoolean, DF } from './rdfDatatypes.js';

/** The literal `false` with xsd:boolean datatype, used for FILTER(FALSE) patterns */
export const termFalse = DF.literal('false', datatypeBoolean);

/** The literal `true` with xsd:boolean datatype, the condition of a filter that constrains nothing */
export const termTrue = DF.literal('true', datatypeBoolean);

/**
 * Whether an operation is the `FILTER(FALSE)` sentinel for a pattern that never matches.
 * @param c - The transformation context
 * @param op - The operation to check
 * @returns whether it is that sentinel
 */
export function isFilterFalse(c: TransformationContext, op: Algebra.Operation): boolean {
  return op.type === Algebra.Types.FILTER && isExpressionFalse(c, op.expression);
}

/**
 * Whether an expression is the `FALSE` term, the condition of `FILTER(FALSE)` or of a LEFT JOIN that never matches.
 * @param c - The transformation context
 * @param op - The expression to check
 * @returns whether it is the `FALSE` term
 */
export function isExpressionFalse(c: TransformationContext, op: Algebra.Expression): boolean {
  return op.subType === Algebra.ExpressionTypes.TERM && op.term.equals(termFalse);
}

/**
 * Creates the `FILTER(FALSE)` that represents an empty result set: in SPARQL algebra the empty multiset,
 * absorbing for JOIN and identity for UNION.
 * @param c - The transformation context
 * @param op - The operation it replaces, kept as its input so that the node carries that operation's
 * `pVars`; an empty BGP by default, which carries none
 * @returns the filter
 */
export function createFilterFalse(c: TransformationContext, op?: Algebra.Operation): Algebra.Filter {
  return c.AF.createFilter(op ?? c.AF.createBgp([]), c.AF.createTermExpression(termFalse));
}

/**
 * Projects an operation onto a coined variable it never binds, keeping one empty solution per solution.
 * Stands in for the empty projection SPARQL lacks.
 * @param c - Object containing the factories and the existence variable generator
 * @param operation - The operation to ask about
 * @returns the projection
 */
export function projectSolutionExistence(
  c: Pick<TransformationContext, 'AF' | 'coinExistenceVariable'>,
  operation: Algebra.Operation,
): Algebra.Project {
  return c.AF.createProject(operation, [ c.coinExistenceVariable() ]);
}
