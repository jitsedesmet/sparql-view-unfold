import { Algebra, algebraUtils } from '@traqula/algebra-transformations-1-2';
import type { TransformContext } from '../transformContext.js';
import { createFilterFalse, isFilterFalse, termFalse } from '../utils/operationhelpers.js';

/**
 * @fileoverview FILTER(FALSE) simplification transformation.
 *
 * In SPARQL algebra, FILTER(FALSE) represents an empty result set.
 * This module provides transformations that simplify algebra expressions
 * containing FILTER(FALSE) based on algebraic identities:
 *
 * - **UNION identity**: FILTER(FALSE) can be removed from unions
 * - **JOIN absorbing**: Any JOIN containing FILTER(FALSE) is FILTER(FALSE)
 * - **Single operations**: Operations over FILTER(FALSE) propagate emptiness
 *
 * @see https://www.w3.org/TR/sparql11-query/#sparqlSimplification
 */

/**
 * Simplifies algebra by removing or propagating FILTER(FALSE) patterns.
 *
 * This transformation applies the following rules:
 * - JOIN over FILTER(FALSE) → FILTER(FALSE) (absorbing element)
 * - UNION over FILTER(FALSE) → removes that branch (identity element)
 * - EXTEND/DISTINCT/etc. over FILTER(FALSE) → FILTER(FALSE)
 * - MINUS/LEFTJOIN where right is FILTER(FALSE) → left operand
 *
 * @param c - The transformation context
 * @param op - The operation to transform
 * @returns The simplified operation
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
      // TODO: the projection of an empty query is the empty query (if not outer project)
      // TODO: expression, minus, leftjoin, group? of empty is empty
      // TODO: exists and not exists
    },
  );
}

/**
 * Handles single-input operations over FILTER(FALSE).
 * Any operation over an empty input produces an empty result.
 * @param c - The transformation context
 * @param single - A single-input operation
 * @returns FILTER(FALSE) if input is empty, otherwise the original operation
 */
export function absorbingSingle(
  c: TransformContext,
  single: Algebra.Single,
): Algebra.Single {
  if (isFilterFalse(c, single.input)) {
    return createFilterFalse(c);
  }
  return single;
}

/**
 * JOIN is an absorbing operation for FILTER(FALSE).
 * If any operand is FILTER(FALSE), the entire JOIN is FILTER(FALSE).
 * @param c - The transformation context
 * @param join - The JOIN operation
 * @returns FILTER(FALSE) if any input is empty, otherwise the original JOIN
 */
export function absorbJoinOnEmptyBindings(c: TransformContext, join: Algebra.Join): Algebra.Join | Algebra.Filter {
  for (const op of join.input) {
    if (isFilterFalse(c, op)) {
      return createFilterFalse(c);
    }
  }
  return join;
}

/**
 * Type guard for checking if a value is an Algebra operation of a specific type.
 */
function isAlgebraTyped<T extends string>(val: { type: unknown }, type: T):
val is Extract<Algebra.Operation, { type: T }> extends object ?
  Extract<Algebra.Operation, { type: T }> : (T extends Algebra.Operation['type'] ? never : { type: T }) {
  return val.type === type;
}

/**
 * FILTER(FALSE) is the identity element for UNION.
 * Removes FILTER(FALSE) branches from unions and handles edge cases.
 *
 * @param c - The transformation context
 * @param union - The UNION operation
 * @returns Simplified operation:
 *   - If all branches are FILTER(FALSE): returns FILTER(FALSE)
 *   - If one branch remains: returns that branch
 *   - Otherwise: returns UNION with empty branches removed
 */
export function pruneUnionOfEmptyBindings(c: TransformContext, union: Algebra.Union): Algebra.Operation {
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
