import { Algebra, algebraUtils } from '@traqula/algebra-transformations-1-2';
import type { TransformContext } from '../transformContext.js';
import { createFilterFalse, isFilterFalse } from '../utils/operationhelpers.js';
import { solutionModifierChainOf } from '../utils/solutionModifierChain.js';

/**
 * @fileoverview FILTER(FALSE) simplification transformation.
 *
 * In SPARQL algebra `FILTER(FALSE)` represents the empty solution multiset, so the operations around one
 * simplify by the algebraic identities of that multiset - absorbing for JOIN, identity for UNION. The
 * traversal is bottom-up, so a rule only has to check whether an input *is* `FILTER(FALSE)`, which is
 * always kept over the empty BGP so that no engine evaluates what it discards.
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
 * Simplifies algebra by removing or propagating `FILTER(FALSE)` patterns:
 *
 * - JOIN over FILTER(FALSE) becomes FILTER(FALSE) (absorbing element)
 * - UNION over FILTER(FALSE) drops that branch (identity element)
 * - FILTER(FALSE) over anything becomes FILTER(FALSE) over the empty BGP, so no engine evaluates its input
 * - PROJECT/EXTEND/DISTINCT/etc. over FILTER(FALSE) becomes FILTER(FALSE), sub-SELECTs included
 * - MINUS/LEFT JOIN whose right operand is FILTER(FALSE) becomes its left operand
 * - GROUP and the query's own solution modifiers are left in place
 * @param c - The transformation context
 * @param op - The operation to transform
 * @returns the simplified operation
 */
export function transformFilterFalse(c: TransformContext, op: Algebra.Operation): Algebra.Operation {
  const sealed = solutionModifierChainOf(op);
  const absorbSingle = { transform: (x: Algebra.Single, original: Algebra.Operation): Algebra.Single =>
    absorbingSingle(c, x, sealed.has(original)) };
  return algebraUtils.mapOperation<'unsafe', typeof op>(
    op,
    {
      [Algebra.Types.JOIN]: { transform: join => absorbJoinOnEmptyBindings(c, join) },
      [Algebra.Types.UNION]: { transform: union => pruneUnionOfEmptyBindings(c, union) },

      [Algebra.Types.PROJECT]: absorbSingle,
      [Algebra.Types.EXTEND]: absorbSingle,
      [Algebra.Types.FROM]: absorbSingle,
      [Algebra.Types.DISTINCT]: absorbSingle,
      [Algebra.Types.FILTER]: { transform: (filter, original) => absorbFilter(c, filter, sealed.has(original)) },
      // TODO: wrong in case of silent!!!
      [Algebra.Types.SERVICE]: absorbSingle,
      [Algebra.Types.REDUCED]: absorbSingle,
      [Algebra.Types.SLICE]: absorbSingle,
      [Algebra.Types.GRAPH]: absorbSingle,
      [Algebra.Types.ORDER_BY]: absorbSingle,
      // No GROUP: an aggregate over an empty input still returns one row (`COUNT(*)` is `0`).
      [Algebra.Types.MINUS]: { transform: (minus) => {
        const [ left, right ] = minus.input;
        // If left FF → FF, if right FF → just left
        if (isFilterFalse(c, left) || isFilterFalse(c, right)) {
          return left;
        }
        return minus;
      } },
      [Algebra.Types.LEFT_JOIN]: { transform: (leftJoin) => {
        // https://www.w3.org/TR/sparql12-query/#defn_algLeftJoin
        const [ left, right ] = leftJoin.input;
        // If left FF → FF, if right FF → just left
        if (isFilterFalse(c, left) || isFilterFalse(c, right)) {
          return left;
        }
        return leftJoin;
      } },
      [Algebra.Types.VALUES]: { transform: (values) => {
        if (values.bindings.length === 0) {
          return createFilterFalse(c);
        }
        return values;
      } },
      // TODO: exists and not exists
    },
  );
}

/**
 * Handles single-input operations over `FILTER(FALSE)`: any operation over an empty input is empty.
 * @param c - The transformation context
 * @param single - A single-input operation
 * @param isSealed - Whether it is part of the query's own solution-modifier chain
 * @returns FILTER(FALSE) if the input is empty and the operation is unsealed, otherwise the operation
 */
function absorbingSingle(
  c: TransformContext,
  single: Algebra.Single,
  isSealed: boolean,
): Algebra.Single {
  // The caller reads the query's answer off a sealed operation; everything above one is sealed too.
  if (!isSealed && isFilterFalse(c, single.input)) {
    return createFilterFalse(c);
  }
  return single;
}

/**
 * Handles a FILTER: one over `FILTER(FALSE)` is empty, and so is a `FILTER(FALSE)` over anything.
 * @param c - The transformation context
 * @param filter - The FILTER operation
 * @param isSealed - Whether it is part of the query's own solution-modifier chain
 * @returns FILTER(FALSE) over the empty BGP if the filter is empty, otherwise the original filter
 */
function absorbFilter(c: TransformContext, filter: Algebra.Filter, isSealed: boolean): Algebra.Single {
  // Its input can go even where nothing above absorbs the filter: an engine may still evaluate it.
  if (isFilterFalse(c, filter)) {
    return createFilterFalse(c);
  }
  return absorbingSingle(c, filter, isSealed);
}

/**
 * JOIN is absorbing for `FILTER(FALSE)`: one empty operand makes the whole join empty.
 * @param c - The transformation context
 * @param join - The JOIN operation
 * @returns FILTER(FALSE) if any input is empty, otherwise the original JOIN
 */
function absorbJoinOnEmptyBindings(c: TransformContext, join: Algebra.Join): Algebra.Join | Algebra.Filter {
  for (const op of join.input) {
    if (isFilterFalse(c, op)) {
      return createFilterFalse(c);
    }
  }
  return join;
}

/**
 * `FILTER(FALSE)` is the identity element for UNION, so its branches are dropped.
 * @param c - The transformation context
 * @param union - The UNION operation
 * @returns FILTER(FALSE) when every branch was empty, the single remaining branch when one is left, and the
 * UNION without its empty branches otherwise
 */
function pruneUnionOfEmptyBindings(c: TransformContext, union: Algebra.Union): Algebra.Operation {
  union.input = union.input.filter(branch => !isFilterFalse(c, branch));
  if (union.input.length > 1) {
    return union;
  }
  if (union.input.length === 1) {
    return union.input[0];
  }
  // If emptyUnion, return filterFalse
  return createFilterFalse(c);
}
