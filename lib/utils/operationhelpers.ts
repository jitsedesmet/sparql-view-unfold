import type * as RDF from '@rdfjs/types';
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
 * Projects an operation onto variables, or onto a coined variable it never binds when there are none, standing in for
 * the empty projection SPARQL lacks.
 * @param c - Object containing the factories and the existence variable generator
 * @param operation - The operation to project
 * @param variables - The variables to project onto
 * @returns the projection
 */
export function projectOntoVariablesOrExistence(
  c: Pick<TransformationContext, 'AF' | 'coinExistenceVariable'>,
  operation: Algebra.Operation,
  variables: RDF.Variable[] = [],
): Algebra.Project {
  return c.AF.createProject(operation, variables.length === 0 ? [ c.coinExistenceVariable() ] : variables);
}

/**
 * Finds the GROUP a projection writes its GROUP BY on: its input, below the binds of its aggregates, its HAVING, its
 * ORDER BY and the join with a trailing VALUES.
 * @param project - The projection to read
 * @returns the GROUP, or `undefined` when the projection groups nothing
 */
export function groupProjectedBy(project: Algebra.Project): Algebra.Group | undefined {
  let input = project.input;
  while (input.type === Algebra.Types.EXTEND || input.type === Algebra.Types.FILTER ||
    input.type === Algebra.Types.ORDER_BY || isJoinWithTrailingValues(input)) {
    input = input.type === Algebra.Types.JOIN ? input.input[0] : input.input;
  }
  return input.type === Algebra.Types.GROUP ? input : undefined;
}

/**
 * Whether an operation is the join a VALUES after the WHERE clause writes, which comes after the GROUP and its HAVING.
 * @param operation - The operation to read
 * @returns whether it joins one operation with a VALUES
 */
function isJoinWithTrailingValues(operation: Algebra.Operation): operation is Algebra.Join {
  return operation.type === Algebra.Types.JOIN && operation.input.length === 2 &&
    operation.input[1].type === Algebra.Types.VALUES;
}
