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
  /**
   * The callback pruning an operation of some type: by its ranges, or else by the rule of that type.
   * @param rule - The rule, given the operation with its operands and EXISTS patterns pruned
   * @returns the callback
   */
  function pruneBy<T extends Algebra.Operation>(
    rule: (operation: T, original: Algebra.Operation) => Algebra.Operation,
  ): { transform: typeof rule } {
    return { transform: (copy, original) => {
      // Earlier passes leave metadata, which the copy carries too, stale once the operands are pruned.
      const operation = rewriteExistenceExpressionsOf(c, dropCachedMetadata(copy), pruneExistencePattern);
      return !sealed.has(original) && certainlyBindsUnbindableVariable(c, operation) ?
        createFilterFalse(c) :
        rule(operation, original);
    } };
  }
  const absorbSingle = pruneBy((single: Algebra.Operation & Algebra.Single, original) =>
    absorbingSingle(c, single, sealed.has(original)));
  return operationTransformer.transformNodeSpecific<'unsafe', Algebra.Operation>(
    op,
    {
      // A closed list of the operation types, as the traversal also meets typed nodes outside the algebra, like the
      // wildcard of `COUNT(*)`. A pattern is no operand of its BGP, which is checked instead.
      ...Object.fromEntries(Object.values(Algebra.Types)
        .filter(type => type !== Algebra.Types.PATTERN && type !== Algebra.Types.EXPRESSION)
        .map(type => [ type, pruneBy(operation => operation) ])),
      [Algebra.Types.PATTERN]: { transform: dropCachedMetadata },

      [Algebra.Types.JOIN]: pruneBy((join: Algebra.Join) => absorbJoinOnEmptyBindings(c, join)),
      [Algebra.Types.UNION]: pruneBy((union: Algebra.Union) => pruneUnionOfEmptyBindings(c, union)),

      [Algebra.Types.PROJECT]: absorbSingle,
      [Algebra.Types.EXTEND]: absorbSingle,
      [Algebra.Types.FROM]: absorbSingle,
      [Algebra.Types.DISTINCT]: absorbSingle,
      [Algebra.Types.FILTER]: pruneBy((filter: Algebra.Filter, original) =>
        absorbFilter(c, filter, sealed.has(original))),
      // A SILENT service whose endpoint fails yields one empty solution, whatever its pattern.
      [Algebra.Types.SERVICE]: pruneBy((service: Algebra.Service, original) =>
        service.silent ? service : absorbingSingle(c, service, sealed.has(original))),
      [Algebra.Types.REDUCED]: absorbSingle,
      [Algebra.Types.SLICE]: absorbSingle,
      [Algebra.Types.GRAPH]: absorbSingle,
      [Algebra.Types.ORDER_BY]: absorbSingle,
      // No GROUP: an aggregate over an empty input still returns one row (`COUNT(*)` is `0`).
      [Algebra.Types.MINUS]: pruneBy((minus: Algebra.Minus) => {
        const [ left, right ] = minus.input;
        // If left FF → FF, if right FF → just left
        if (isFilterFalse(c, left) || isFilterFalse(c, right)) {
          return left;
        }
        return minus;
      }),
      [Algebra.Types.LEFT_JOIN]: pruneBy((leftJoin: Algebra.LeftJoin) => {
        // https://www.w3.org/TR/sparql12-query/#defn_algLeftJoin
        const [ left, right ] = leftJoin.input;
        // If left FF → FF, if right FF → just left
        if (isFilterFalse(c, left) || isFilterFalse(c, right) ||
          (leftJoin.expression && isExpressionFalse(c, leftJoin.expression))) {
          return left;
        }
        return leftJoin;
      }),
      // Only `VALUES () {}`: one with columns and no rows certainly binds them, with empty ranges.
      [Algebra.Types.VALUES]: pruneBy((values: Algebra.Values) => {
        if (values.bindings.length === 0) {
          return createFilterFalse(c);
        }
        return values;
      }),
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
 * Handles single-input operations over `FILTER(FALSE)`: any operation over an empty input is empty.
 * @param c - The transformation context
 * @param single - A single-input operation
 * @param isSealed - Whether it is part of the query's own solution-modifier chain
 * @returns FILTER(FALSE) if the input is empty and the operation is unsealed, otherwise the operation
 */
function absorbingSingle<T extends Algebra.Operation & Algebra.Single>(
  c: TransformationContext,
  single: T,
  isSealed: boolean,
): T | Algebra.Filter {
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
function absorbFilter(c: TransformationContext, filter: Algebra.Filter, isSealed: boolean): Algebra.Filter {
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
function absorbJoinOnEmptyBindings(c: TransformationContext, join: Algebra.Join): Algebra.Join | Algebra.Filter {
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
