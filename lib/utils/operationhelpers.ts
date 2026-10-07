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

/**
 * Rebuilds a MINUS over new operands, keeping the graph-scope marker that tells an engine which `?g`, bound
 * outside the MINUS, its disjointness test ignores.
 * @param c - The transformation context
 * @param minus - The MINUS to rebuild
 * @param left - Its new left operand
 * @param right - Its new right operand
 * @returns the rebuilt MINUS
 */
export function rebuildMinus(
  c: TransformationContext,
  minus: Algebra.Minus,
  left: Algebra.Operation,
  right: Algebra.Operation,
): Algebra.Minus {
  const rebuilt = c.AF.createMinus(left, right);
  if (minus.graphScopeVar !== undefined) {
    rebuilt.graphScopeVar = minus.graphScopeVar;
  }
  return rebuilt;
}

/** The operations of one input a rewrite rebuilds over a new input, everything else about them unchanged. */
export type SingleInputOperation = Algebra.Distinct | Algebra.Reduced | Algebra.OrderBy | Algebra.From |
  Algebra.Slice | Algebra.Project | Algebra.Group | Algebra.Graph;

/**
 * Rebuilds a single-input operation over a new input, through the factory so that no cached metadata comes
 * along.
 * @param c - The transformation context
 * @param op - The operation to rebuild
 * @param input - Its new input
 * @returns the rebuilt operation
 */
export function rebuildOverInput(
  c: TransformationContext,
  op: SingleInputOperation,
  input: Algebra.Operation,
): Algebra.Operation {
  switch (op.type) {
    case Algebra.Types.DISTINCT:
      return c.AF.createDistinct(input);
    case Algebra.Types.REDUCED:
      return c.AF.createReduced(input);
    case Algebra.Types.ORDER_BY:
      return c.AF.createOrderBy(input, op.expressions);
    case Algebra.Types.FROM:
      return c.AF.createFrom(input, op.default, op.named);
    case Algebra.Types.SLICE:
      return c.AF.createSlice(input, op.start, op.length);
    case Algebra.Types.PROJECT:
      return c.AF.createProject(input, op.variables);
    case Algebra.Types.GROUP:
      return c.AF.createGroup(input, op.variables, op.aggregates);
    case Algebra.Types.GRAPH:
      return c.AF.createGraph(input, op.name);
  }
}

/**
 * The variables a GROUP groups on and passes through: its keys, except one an aggregate writes over.
 * @param group - The grouping
 * @returns the names of those keys
 */
export function groupingKeysOf(group: Algebra.Group): Set<string> {
  const keys = new Set(group.variables.map(variable => variable.value));
  for (const aggregate of group.aggregates) {
    keys.delete(aggregate.variable.value);
  }
  return keys;
}
