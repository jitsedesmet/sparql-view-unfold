import type { Algebra as A, Algebra } from '@traqula/algebra-transformations-1-2';
import { algebraUtils, ExpressionTypes, Types } from '@traqula/algebra-transformations-1-2';
import type { PreOrderMappingReturn } from '@traqula/core';
import { forEveryNodeType } from '@traqula/core';
import type { CPMeta, RangeContext } from './certainlyBoundVars.js';
import { cpMetaOf, dropCachedMetadata, joinedMeta, operationTransformer, withoutCpVars } from './certainlyBoundVars.js';
import { containsExistenceExpression, holdsExpression } from './expressionHelpers.js';

/**
 * @fileoverview Rewriting EXISTS patterns in the scope of the solution they are evaluated for.
 *
 * SPARQL 1.2 joins that solution into every group of the pattern. A pass therefore first rewrites the plan around
 * the EXISTS patterns, and then each pattern with that solution as `existenceScope`: the scope is only known once the
 * pass has placed the EXISTS. A pass that places no EXISTS, such as the unfolding, can rewrite the patterns first.
 */

/** A pass that leaves EXISTS patterns alone, rewriting an operation in a context. */
export type ExistenceScopedPass<C> = (context: C, op: Algebra.Operation) => Algebra.Operation;

/**
 * The traversal callback with which a pass leaves EXISTS patterns alone. Used for every expression, it skips them too,
 * which is harmless as only an EXISTS holds operations.
 */
export const leaveExistencePatterns = { preVisitor: () => ({ continue: false }) };

/**
 * The `algebraUtils.mapOperationPreOrder` callback with which a pass leaves EXISTS patterns alone.
 * @param expression - The expression to leave as it is
 * @returns the instruction not to descend into it
 */
export function leaveExistencePatternsPreOrder(expression: Algebra.Expression): PreOrderMappingReturn {
  return { newValue: expression, continue: false };
}

/**
 * Rewrites an operation with a pass, then the pattern of each EXISTS in it with the solution it is evaluated for as
 * `existenceScope`. The pass gets a copy without cached metadata, and the result holds none either.
 * @param c - The context to rewrite in
 * @param op - The operation to rewrite, which is left untouched
 * @param pass - The pass, which leaves EXISTS patterns alone
 * @returns the rewritten operation
 */
export function rewriteInExistenceScopes<C extends RangeContext, T extends Algebra.Operation>(
  c: C,
  op: T,
  pass: ExistenceScopedPass<C>,
): T {
  const entered = withoutCpVars(op);
  const rewriteTree: ExistenceScopedPass<C> = (context, tree) =>
    rewriteExistencePatternsOf(context, pass(context, tree), rewriteTree, true);
  // A plan without EXISTS, the common case, skips the walk over the plan.
  return <T> withoutCpVars(holdsExistence(entered) ? rewriteTree(c, entered) : pass(c, entered));
}

/**
 * Rewrites the pattern of each EXISTS in an operation where it sits, with the solution it is evaluated for as
 * `existenceScope`, then the operation with a pass. For a pass that moves no EXISTS and adds operations not to rewrite,
 * such as mapping bodies. A `SERVICE` is left as it stands.
 * @param c - The context to rewrite in
 * @param op - The operation to rewrite, which is left untouched
 * @param pass - The pass, which leaves EXISTS patterns alone
 * @returns the rewritten operation
 */
export function rewriteInExistenceScopesBeforePass<C extends RangeContext, T extends Algebra.Operation>(
  c: C,
  op: T,
  pass: ExistenceScopedPass<C>,
): T {
  const entered = withoutCpVars(op);
  if (!holdsExistence(entered)) {
    // Nothing caches metadata then, so the result, holding the mapping bodies, needs no copy without it.
    return <T> pass(c, entered);
  }
  const rewriteTree: ExistenceScopedPass<C> = (context, tree) =>
    pass(context, rewriteExistencePatternsOf(context, tree, rewriteTree, false));
  return <T> withoutCpVars(rewriteTree(c, entered));
}

/** How the solution an EXISTS is evaluated for binds a variable. */
export type OuterBinding = 'certain' | 'maybe' | 'none';

/**
 * How the solution an EXISTS is evaluated for binds a variable.
 * @param scope - The `existenceScope`, undefined outside an EXISTS
 * @param name - The name of the variable
 * @returns whether it binds it certainly, maybe, or not at all
 */
export function outerBinding(scope: CPMeta | undefined, name: string): OuterBinding {
  if (scope?.cVars.has(name)) {
    return 'certain';
  }
  return scope?.vRanges.canBind(name) ? 'maybe' : 'none';
}

/**
 * Whether an operation holds an EXISTS.
 * @param op - The operation to read
 * @returns whether it does
 */
export function holdsExistence(op: Algebra.Operation): boolean {
  return holdsExpression(op, expression => expression.subType === ExpressionTypes.EXISTENCE);
}

/**
 * Rewrites the pattern of each EXISTS in an operation, with the solution it is evaluated for as `existenceScope`.
 * @param c - The context the operation is in
 * @param op - The operation, without cached metadata
 * @param rewritePattern - The rewrite of one pattern, without cached metadata, in its scope
 * @param enterServices - Whether to rewrite the patterns inside a `SERVICE` too
 * @returns the rewritten operation, a new tree
 */
function rewriteExistencePatternsOf<C extends RangeContext>(
  c: C,
  op: Algebra.Operation,
  rewritePattern: ExistenceScopedPass<C>,
  enterServices: boolean,
): Algebra.Operation {
  const skipped = enterServices ? {} : { [Types.SERVICE]: { preVisitor: () => ({ continue: false }) }};
  return operationTransformer.transformNode<'unsafe', Algebra.Operation>(
    op,
    forEveryNodeType(
      { transform: (copy: Algebra.Operation) => withExistencePatternsRewritten(c, copy, rewritePattern) },
      { [Types.EXPRESSION]: leaveExistencePatterns, ...skipped },
    ),
  );
}

/**
 * Rewrites the pattern of every EXISTS an operation evaluates, with the solution it is evaluated for as
 * `existenceScope`. Each EXISTS gets a pattern of its own, as a pass may share one EXISTS between operations.
 * @param c - The context the operation is in
 * @param copy - A copy of the operation, whose cached metadata may be stale
 * @param rewritePattern - The rewrite of one pattern, in its scope
 * @returns the copy, without metadata and with its expressions replaced
 */
function withExistencePatternsRewritten<C extends RangeContext>(
  c: C,
  copy: Algebra.Operation,
  rewritePattern: ExistenceScopedPass<C>,
): Algebra.Operation {
  return rewriteExistenceExpressionsOf(c, dropCachedMetadata(copy), (context, existence) =>
    ({ ...existence, input: rewritePattern(context, withoutCpVars(existence.input)) }));
}

/**
 * Replaces every EXISTS an operation evaluates, with the solution it is evaluated for as `existenceScope`.
 * @param c - The context the operation is in
 * @param op - The operation, changed in place, whose operands give that solution
 * @param rewriteExistence - The replacement of one EXISTS, in its scope
 * @returns the operation
 */
export function rewriteExistenceExpressionsOf<C extends RangeContext, T extends Algebra.Operation>(
  c: C,
  op: T,
  rewriteExistence: (context: C, existence: Algebra.ExistenceExpression) => Algebra.Expression,
): T {
  if (!expressionsEvaluatedBy(op).some(containsExistenceExpression)) {
    return op;
  }
  const inputs = [ (<A.Single | A.Multi> op).input ].flat();
  const patternContext = { ...c, existenceScope: joinedMeta(inputs.map(input => cpMetaOf(c, input))) };
  replaceExpressionsEvaluatedBy(op, expression =>
    algebraUtils.mapOperationSub<'unsafe', Algebra.Expression>(expression, {}, { expression: { existence: {
      // A nested EXISTS is rewritten with the pattern holding it.
      ...leaveExistencePatterns,
      transform: (existence: Algebra.ExistenceExpression) => rewriteExistence(patternContext, existence),
    }}}));
  return op;
}

/**
 * The expressions an operation evaluates per solution of its input, or of its joined inputs for an OPTIONAL.
 * @param op - The operation to read
 * @returns its expressions
 */
function expressionsEvaluatedBy(op: Algebra.Operation): Algebra.Expression[] {
  switch (op.type) {
    case Types.FILTER:
    case Types.EXTEND: {
      return [ op.expression ];
    }
    case Types.LEFT_JOIN: {
      return op.expression === undefined ? [] : [ op.expression ];
    }
    case Types.ORDER_BY: {
      return op.expressions;
    }
    case Types.GROUP: {
      return op.aggregates;
    }
    default: {
      return [];
    }
  }
}

/**
 * Replaces each expression an operation evaluates per solution of its input.
 * @param op - The operation, changed in place
 * @param replace - Gives the replacement of one expression
 */
function replaceExpressionsEvaluatedBy(
  op: Algebra.Operation,
  replace: (expression: Algebra.Expression) => Algebra.Expression,
): void {
  switch (op.type) {
    case Types.FILTER:
    case Types.EXTEND: {
      op.expression = replace(op.expression);
      break;
    }
    case Types.LEFT_JOIN: {
      op.expression = op.expression === undefined ? undefined : replace(op.expression);
      break;
    }
    case Types.ORDER_BY: {
      op.expressions = op.expressions.map(replace);
      break;
    }
    case Types.GROUP: {
      op.aggregates = op.aggregates.map(aggregate => <Algebra.BoundAggregate> replace(aggregate));
      break;
    }
    default:
  }
}
