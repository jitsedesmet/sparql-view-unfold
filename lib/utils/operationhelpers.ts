import { Algebra, algebraUtils } from '@traqula/algebra-transformations-1-2';
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

/**
 * Whether a property path can match zero steps, and so relate a term to itself.
 * @param path - The property path to check
 * @returns whether the path can match zero steps; `true` for a path type this does not know, to stay safe
 */
export function canMatchZeroLength(path: Algebra.PropertyPathSymbol): boolean {
  const canMatch = (operand: unknown): boolean => operand !== false;
  // Bottom-up, so every operand has already been replaced by whether it can match zero steps, and a path
  // type without a callback is left an object, which `canMatch` takes as able to.
  return canMatch(algebraUtils.mapOperation(path, {
    [Algebra.Types.LINK]: { transform: () => false },
    [Algebra.Types.NPS]: { transform: () => false },
    [Algebra.Types.ZERO_OR_ONE_PATH]: { transform: () => true, preVisitor: () => ({ continue: false }) },
    [Algebra.Types.ZERO_OR_MORE_PATH]: { transform: () => true, preVisitor: () => ({ continue: false }) },
    [Algebra.Types.INV]: { transform: copy => canMatch(copy.path) },
    [Algebra.Types.ONE_OR_MORE_PATH]: { transform: copy => canMatch(copy.path) },
    [Algebra.Types.SEQ]: { transform: copy => (<unknown[]> copy.input).every(canMatch) },
    [Algebra.Types.ALT]: { transform: copy => (<unknown[]> copy.input).some(canMatch) },
  }));
}
