import { Algebra } from '@traqula/algebra-transformations-1-2';
import type { TransformationContext } from '../transformContext.js';
import type { QueryTransformation } from '../types.js';
import { cpMetaOf, dropCachedMetadata, operationTransformer, withoutCpVars } from '../utils/certainlyBoundVars.js';
import { leaveExistencePatterns, rewriteExistenceExpressionsOf } from '../utils/existenceScopes.js';
import {
  createFilterFalse,
  isExpressionFalse,
  isFilterFalse,
  termFalse,
  termTrue,
} from '../utils/operationhelpers.js';
import { querySolutionModifiersOf } from '../utils/solutionModifierChain.js';

/**
 * @fileoverview Pruning of empty results, bottom-up.
 *
 * In SPARQL algebra `FILTER(FALSE)` represents the empty solution multiset. Each operation is checked once its
 * operands, and the EXISTS patterns it evaluates, are pruned. It has no solutions when it certainly binds a variable
 * whose range is empty, such as a join over incompatible term types; otherwise the rules below apply.
 *
 * Dropping an empty operation drops its scope too, which is sound: nothing in it is bound, and SPARQL's
 * scope rules only forbid a variable already in scope (`BIND(… AS ?v)`), so removing variables breaks none.
 * The replacement must be a *fresh* `FILTER(FALSE)`, though: the pushdown's one stands over the operation
 * it replaced, and lifting that out of a sub-SELECT would bring hidden variables back into scope.
 *
 * Scope is only observable in the query's own answer, so its solution modifiers are sealed
 * ({@link utils/solutionModifierChain!solutionModifierChainOf}): an empty `SELECT DISTINCT ?a LIMIT 10`
 * handed to this pass stays one.
 */

/**
 * The node types to prune: every operation but a pattern, which is no operand of its BGP. A closed list, as the
 * traversal also meets typed nodes outside the algebra, like the wildcard of `COUNT(*)`.
 */
const prunedOperationTypes = Object.values(Algebra.Types)
  .filter(type => type !== Algebra.Types.PATTERN && type !== Algebra.Types.EXPRESSION);

/**
 * Replaces every operation that provably has no solutions by `FILTER(FALSE)` over the empty BGP, so that no engine
 * evaluates what it discards:
 *
 * - an operation that certainly binds a variable whose range is empty becomes FILTER(FALSE)
 * - JOIN over FILTER(FALSE) becomes FILTER(FALSE) (absorbing element)
 * - UNION over FILTER(FALSE) drops that branch (identity element)
 * - FILTER(FALSE) over anything becomes FILTER(FALSE)
 * - PROJECT/EXTEND/DISTINCT/SERVICE/etc. over FILTER(FALSE) becomes FILTER(FALSE), sub-SELECTs included
 * - MINUS/LEFT JOIN whose right operand is FILTER(FALSE) becomes its left operand
 * - LEFT JOIN whose condition is `FALSE` becomes its left operand: no right solution can satisfy it
 * - `EXISTS { FILTER(FALSE) }` becomes `FALSE`, and `NOT EXISTS { FILTER(FALSE) }` becomes `TRUE`
 * - GROUP, a SILENT SERVICE, and the query's own solution modifiers are left in place
 * @param c - The transformation context
 * @param op - The operation to transform, which is left untouched
 * @returns the pruned operation, without cached metadata
 */
export function transformFilterFalse(c: TransformationContext, op: Algebra.Operation): Algebra.Operation {
  return withoutCpVars(pruneEmptyResults(c, op));
}

/**
 * Prunes an operation bottom-up, each EXISTS pattern where the operation evaluating it is met.
 * @param c - The transformation context, whose `existenceScope` is the solution of the EXISTS the operation is in
 * @param op - The operation to prune
 * @returns the pruned operation, with metadata cached on its nodes
 */
function pruneEmptyResults(c: TransformationContext, op: Algebra.Operation): Algebra.Operation {
  const sealed = querySolutionModifiersOf(c, op);
  const pruneOperation = { transform: (copy: Algebra.Operation, original: Algebra.Operation): Algebra.Operation => {
    // Earlier passes leave metadata, which the copy carries too, stale once the operands are pruned.
    const operation = rewriteExistenceExpressionsOf(c, dropCachedMetadata(copy), pruneExistencePattern);
    if (sealed.has(original)) {
      return operation;
    }
    return certainlyBindsUnbindableVariable(c, operation) ?
      createFilterFalse(c) :
      pruneOverEmptyOperands(c, operation);
  } };
  return operationTransformer.transformNodeSpecific<'unsafe', Algebra.Operation>(
    op,
    {
      ...Object.fromEntries(prunedOperationTypes.map(type => [ type, pruneOperation ])),
      [Algebra.Types.PATTERN]: { transform: dropCachedMetadata },
    },
    { [Algebra.Types.EXPRESSION]: { [Algebra.ExpressionTypes.EXISTENCE]: leaveExistencePatterns }},
  );
}

/**
 * Prunes the pattern of an EXISTS, which is `FALSE` once its pattern is empty, or `TRUE` for a NOT EXISTS.
 * @param c - The transformation context, whose `existenceScope` is the solution the EXISTS is evaluated for
 * @param existence - The EXISTS
 * @returns the EXISTS with its pattern pruned, or the term it evaluates to
 */
function pruneExistencePattern(
  c: TransformationContext,
  existence: Algebra.ExistenceExpression,
): Algebra.Expression {
  const pattern = pruneEmptyResults(c, existence.input);
  return isFilterFalse(c, pattern) ?
    c.AF.createTermExpression(existence.not ? termTrue : termFalse) :
      { ...existence, input: pattern };
}

/**
 * Whether an operation certainly binds a variable whose range is empty, which no solution can do.
 * @param c - The transformation context
 * @param op - The operation, whose operands are pruned
 * @returns whether it has no solutions
 */
function certainlyBindsUnbindableVariable(c: TransformationContext, op: Algebra.Operation): boolean {
  const { cVars, vRanges } = cpMetaOf(c, op);
  return [ ...cVars ].some(name => vRanges.neverBinds(name));
}

/**
 * Applies the identity of the empty solution multiset that an operation over pruned operands matches.
 * @param c - The transformation context
 * @param op - The operation, outside the query's solution modifiers
 * @returns FILTER(FALSE), an operand, or the operation itself
 */
function pruneOverEmptyOperands(c: TransformationContext, op: Algebra.Operation): Algebra.Operation {
  switch (op.type) {
    case Algebra.Types.JOIN: {
      return op.input.some(input => isFilterFalse(c, input)) ? createFilterFalse(c) : op;
    }
    case Algebra.Types.UNION: {
      return pruneUnionOfEmptyBindings(c, op);
    }
    case Algebra.Types.FILTER: {
      // Its input can go even where nothing above absorbs the filter: an engine may still evaluate it.
      return isFilterFalse(c, op) || isFilterFalse(c, op.input) ? createFilterFalse(c) : op;
    }
    case Algebra.Types.SERVICE: {
      // A SILENT service whose endpoint fails yields one empty solution, whatever its pattern.
      return !op.silent && isFilterFalse(c, op.input) ? createFilterFalse(c) : op;
    }
    case Algebra.Types.PROJECT:
    case Algebra.Types.EXTEND:
    case Algebra.Types.FROM:
    case Algebra.Types.DISTINCT:
    case Algebra.Types.REDUCED:
    case Algebra.Types.SLICE:
    case Algebra.Types.GRAPH:
    case Algebra.Types.ORDER_BY: {
      return isFilterFalse(c, op.input) ? createFilterFalse(c) : op;
    }
    case Algebra.Types.MINUS: {
      const [ left, right ] = op.input;
      return isFilterFalse(c, left) || isFilterFalse(c, right) ? left : op;
    }
    case Algebra.Types.LEFT_JOIN: {
      // https://www.w3.org/TR/sparql12-query/#defn_algLeftJoin
      const [ left, right ] = op.input;
      const conditionIsFalse = op.expression !== undefined && isExpressionFalse(c, op.expression);
      return isFilterFalse(c, left) || isFilterFalse(c, right) || conditionIsFalse ? left : op;
    }
    case Algebra.Types.VALUES: {
      // Only `VALUES () {}`: one with columns and no rows certainly binds them, with empty ranges.
      return op.bindings.length === 0 ? createFilterFalse(c) : op;
    }
    default: {
      // No GROUP: an aggregate over an empty input still returns one row (`COUNT(*)` is `0`).
      return op;
    }
  }
}

/**
 * `FILTER(FALSE)` is the identity element for UNION, so its branches are dropped.
 * @param c - The transformation context
 * @param union - The UNION operation
 * @returns FILTER(FALSE) when every branch was empty, the single remaining branch when one is left, and a
 * UNION of the other branches otherwise
 */
function pruneUnionOfEmptyBindings(c: TransformationContext, union: Algebra.Union): Algebra.Operation {
  const branches = union.input.filter(branch => !isFilterFalse(c, branch));
  if (branches.length === 0) {
    return createFilterFalse(c);
  }
  if (branches.length === 1) {
    return branches[0];
  }
  // A new UNION, as the metadata cached on this one counts the dropped branches.
  return branches.length === union.input.length ? union : c.AF.createUnion(branches, false);
}

/**
 * The pipeline step replacing every operation that provably has no solutions by `FILTER(FALSE)`.
 * @returns the transformation
 */
export function filterFalseTransformation(): QueryTransformation {
  return transformFilterFalse;
}
