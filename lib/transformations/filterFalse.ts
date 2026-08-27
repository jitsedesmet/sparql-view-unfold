import { Algebra, algebraUtils } from '@traqula/algebra-transformations-1-2';
import type { TransformContext } from '../transformContext.js';
import { createFilterFalse, isFilterFalse, termFalse } from '../utils/operationhelpers.js';

/**
 * @fileoverview FILTER(FALSE) simplification transformation.
 *
 * In SPARQL algebra `FILTER(FALSE)` represents the empty solution multiset, so the operations around one
 * simplify by the algebraic identities of that multiset - absorbing for JOIN, identity for UNION.
 */

/**
 * Simplifies algebra by removing or propagating `FILTER(FALSE)` patterns:
 *
 * - JOIN over FILTER(FALSE) becomes FILTER(FALSE) (absorbing element)
 * - UNION over FILTER(FALSE) drops that branch (identity element)
 * - EXTEND/DISTINCT/etc. over FILTER(FALSE) becomes FILTER(FALSE)
 * - MINUS/LEFT JOIN whose right operand is FILTER(FALSE) becomes its left operand
 * @param c - The transformation context
 * @param op - The operation to transform
 * @returns the simplified operation
 */
export function transformFilterFalse(c: TransformContext, op: Algebra.Operation): Algebra.Operation {
  const absorbSingle = { transform: (x: Algebra.Single): Algebra.Single => absorbingSingle(c, x) };
  return algebraUtils.mapOperation<'unsafe', typeof op>(
    op,
    {
      [Algebra.Types.JOIN]: { transform: join => absorbJoinOnEmptyBindings(c, join) },
      [Algebra.Types.UNION]: { transform: union => pruneUnionOfEmptyBindings(c, union) },

      [Algebra.Types.EXTEND]: absorbSingle,
      [Algebra.Types.FROM]: absorbSingle,
      [Algebra.Types.DISTINCT]: absorbSingle,
      [Algebra.Types.FILTER]: absorbSingle,
      // TODO: wrong in case of silent!!!
      [Algebra.Types.SERVICE]: absorbSingle,
      [Algebra.Types.REDUCED]: absorbSingle,
      [Algebra.Types.SLICE]: absorbSingle,
      [Algebra.Types.GRAPH]: absorbSingle,
      [Algebra.Types.ORDER_BY]: absorbSingle,
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
      // TODO: the projection of an empty query is the empty query (if not outer project)
      // TODO: exists and not exists
    },
  );
}

/**
 * Handles single-input operations over `FILTER(FALSE)`: any operation over an empty input is empty.
 * @param c - The transformation context
 * @param single - A single-input operation
 * @returns FILTER(FALSE) if the input is empty, otherwise the original operation
 */
function absorbingSingle(
  c: TransformContext,
  single: Algebra.Single,
): Algebra.Single {
  if (isFilterFalse(c, single.input)) {
    return createFilterFalse(c);
  }
  return single;
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
 * Type guard for checking if a value is an Algebra operation of a specific type.
 * @returns whether it has that type
 */
function isAlgebraTyped<T extends string>(val: { type: unknown }, type: T):
val is Extract<Algebra.Operation, { type: T }> extends object ?
  Extract<Algebra.Operation, { type: T }> : (T extends Algebra.Operation['type'] ? never : { type: T }) {
  return val.type === type;
}

/**
 * `FILTER(FALSE)` is the identity element for UNION, so its branches are dropped.
 * @param c - The transformation context
 * @param union - The UNION operation
 * @returns FILTER(FALSE) when every branch was empty, the single remaining branch when one is left, and the
 * UNION without its empty branches otherwise
 */
function pruneUnionOfEmptyBindings(c: TransformContext, union: Algebra.Union): Algebra.Operation {
  // Filter out filterFalse
  union.input = union.input.filter((maybeFilter: Algebra.Operation | { type: string }) => {
    if (isAlgebraTyped(maybeFilter, Algebra.Types.FILTER) &&
      maybeFilter.expression.subType === Algebra.ExpressionTypes.TERM) {
      return !maybeFilter.expression.term.equals(termFalse);
    }
    return true;
  });
  if (union.input.length > 1) {
    return union;
  }
  if (union.input.length === 1) {
    return union.input[0];
  }
  // If emptyUnion, return filterFalse
  return createFilterFalse(c);
}
