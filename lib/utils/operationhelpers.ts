import { Algebra } from '@traqula/algebra-transformations-1-2';
import type { TransformationContext } from '../transformContext.js';
import { conjunctionOf } from './expressionHelpers.js';
import { datatypeBoolean, DF } from './rdfDatatypes.js';
import { differenceSets } from './setUtils.js';

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
 * Copies an operation over new input, leaving out the metadata cached on the original.
 * @param op - The operation to copy
 * @param input - Its new input, or inputs
 * @returns the copy, keeping every other field, such as the `graphScopeVar` of a MINUS
 */
export function withInput<T extends Algebra.Single | Algebra.Multi>(op: T, input: T['input']): T {
  return { ...withoutMetadata(op), input };
}

/**
 * Copies an object without its `metadata` key. Unlike `delete`, this keeps the copy in V8's fast mode.
 * @param object - The object to copy
 * @returns the shallow copy, without `metadata`
 */
export function withoutMetadata<T extends object>(object: T): T {
  const { metadata: _metadata, ...rest } = <T & { metadata?: unknown }> object;
  return <T> rest;
}

/**
 * Filters an operation by the conjunction of conditions.
 * @param c - The transformation context
 * @param op - The operation to filter
 * @param conditions - The conditions to filter by
 * @returns the filter, or `op` itself without conditions
 */
export function filterByConjunction(
  c: Pick<TransformationContext, 'AF'>,
  op: Algebra.Operation,
  conditions: Algebra.Expression[],
): Algebra.Operation {
  return conditions.length === 0 ? op : c.AF.createFilter(op, conjunctionOf(c, conditions));
}

/**
 * Whether an operation is a GROUP, or a HAVING, select expression, ORDER BY or trailing VALUES over one. Its solutions
 * hold only the group keys and aggregates, not the solution an EXISTS is evaluated for, which SPARQL 1.2 joins into
 * groups only.
 * @param op - The operation to read
 * @returns whether it aggregates
 */
export function aggregatesOver(op: Algebra.Operation): boolean {
  switch (op.type) {
    case Algebra.Types.GROUP: {
      return true;
    }
    case Algebra.Types.FILTER:
    case Algebra.Types.EXTEND:
    case Algebra.Types.ORDER_BY: {
      return aggregatesOver(op.input);
    }
    // A trailing VALUES joins in after the grouping, also once a filter is pushed onto it.
    case Algebra.Types.JOIN: {
      const [ first, second ] = op.input;
      return op.input.length === 2 &&
        (isValuesBelowFilters(first) ? aggregatesOver(second) : isValuesBelowFilters(second) && aggregatesOver(first));
    }
    default: {
      return false;
    }
  }
}

/**
 * Whether an operation is a VALUES, possibly under filters.
 * @param op - The operation to read
 * @returns whether it is
 */
function isValuesBelowFilters(op: Algebra.Operation): boolean {
  let current = op;
  while (current.type === Algebra.Types.FILTER) {
    current = current.input;
  }
  return current.type === Algebra.Types.VALUES;
}

/**
 * The variables a GROUP groups on and passes through: its keys, except one an aggregate writes over.
 * @param group - The grouping
 * @returns the names of those keys
 */
export function groupingKeysOf(group: Algebra.Group): Set<string> {
  return differenceSets(
    new Set(group.variables.map(variable => variable.value)),
    new Set(group.aggregates.map(agg => agg.variable.value)),
  );
}

/**
 * Whether a property path can match zero steps, and so relate a term to itself.
 * @param path - The property path to check
 * @returns whether the path can match zero steps
 */
export function canMatchZeroLength(path: Algebra.PropertyPathSymbol): boolean {
  switch (path.type) {
    case Algebra.Types.LINK:
    case Algebra.Types.NPS:
      return false;
    case Algebra.Types.INV:
    case Algebra.Types.ONE_OR_MORE_PATH:
      return canMatchZeroLength(path.path);
    case Algebra.Types.SEQ:
      return path.input.every(canMatchZeroLength);
    case Algebra.Types.ALT:
      return path.input.some(canMatchZeroLength);
    // `?` and `*`, and, to stay safe, any path this does not know.
    default:
      return true;
  }
}
