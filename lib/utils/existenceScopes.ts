import type { Algebra as A, Algebra } from '@traqula/algebra-transformations-1-2';
import { algebraUtils, Types } from '@traqula/algebra-transformations-1-2';
import type { PreOrderMappingReturn } from '@traqula/core';
import type { TransformationContext } from '../transformContext.js';
import { collectVariableNames } from '../utils.js';
import type { RangeContext } from './certainlyBoundVars.js';
import { cpMetaOf, joinedMeta, metaRestrictedTo, withoutCpVars } from './certainlyBoundVars.js';
import { containsExistenceExpression } from './expressionHelpers.js';

/**
 * @fileoverview Rewriting EXISTS patterns in the scope of the solution they are evaluated for.
 *
 * SPARQL 1.2 joins that solution into every group of the pattern. A pass therefore first rewrites the plan around
 * the EXISTS patterns, and then each pattern with that solution as `existenceScope`: the scope is only known once the
 * pass has placed the EXISTS.
 */

/** What {@link rewriteInExistenceScopes} reads of a {@link TransformationContext}. */
export type ExistenceScopeContext = RangeContext & Pick<TransformationContext, 'astTransformer'>;

/** A pass that leaves EXISTS patterns alone, rewriting an operation in a context. */
export type ExistenceScopedPass<C> = (context: C, op: Algebra.Operation) => Algebra.Operation;

/**
 * The traversal callback with which a pass leaves EXISTS patterns alone. Used for every expression, it skips them too,
 * which is harmless as only an EXISTS holds operations.
 */
export const leaveExistencePatterns = { preVisitor: () => ({ continue: false }) };

/**
 * The `algebraUtils.mapOperationPreOrder` callbacks that apply one callback to every operation outside EXISTS patterns.
 * @param callback - The callback for every operation
 * @returns the callbacks per type
 */
export function preOrderCallbacksOutsideExistencePatterns(
  callback: (op: Algebra.Operation) => PreOrderMappingReturn,
): Parameters<typeof algebraUtils.mapOperationPreOrder<'unsafe', Algebra.Operation>>[1] {
  return {
    ...Object.fromEntries(Object.values(Types).map(type => [ type, callback ])),
    [Types.EXPRESSION]: (expression: Algebra.Expression) => ({ newValue: expression, continue: false }),
  };
}

/**
 * Rewrites an operation with a pass, then the pattern of each EXISTS in it with the solutions it is evaluated for as
 * `existenceScope`. The result, like the tree the pass gets, holds no cached metadata.
 * @param c - The context to rewrite in
 * @param op - The operation to rewrite, which is left untouched
 * @param pass - The pass, which leaves EXISTS patterns alone
 * @returns the rewritten operation
 */
export function rewriteInExistenceScopes<C extends ExistenceScopeContext, T extends Algebra.Operation>(
  c: C,
  op: T,
  pass: ExistenceScopedPass<C>,
): T {
  return withoutCpVars(rewriteTreeInExistenceScopes(c, withoutCpVars(op), pass));
}

/**
 * {@link rewriteInExistenceScopes} on a tree of its own, keeping the metadata it computes.
 * @param c - The context to rewrite in
 * @param op - The operation to rewrite, which the pass may change
 * @param pass - The pass
 * @returns the rewritten operation
 */
function rewriteTreeInExistenceScopes<C extends ExistenceScopeContext, T extends Algebra.Operation>(
  c: C,
  op: T,
  pass: ExistenceScopedPass<C>,
): T {
  const rewritten = pass(c, op);
  const callbacks = {
    // The metadata the pass cached describes the plan before it.
    preVisitor: (operation: { metadata?: unknown }) => {
      delete operation.metadata;
      return {};
    },
    visitor: (operation: Algebra.Operation) => rewriteExistencePatternsOf(c, operation, pass),
  };
  algebraUtils.visitOperation(rewritten, {
    ...Object.fromEntries(Object.values(Types).map(type => [ type, callbacks ])),
    [Types.EXPRESSION]: leaveExistencePatterns,
  });
  return <T> rewritten;
}

/**
 * Rewrites the pattern of every EXISTS an operation evaluates, with the solutions of its input as `existenceScope`.
 * Each EXISTS gets a pattern of its own, as a pass may share one EXISTS between operations.
 * @param c - The context the operation was rewritten in
 * @param op - The operation, whose expressions are replaced
 * @param pass - The pass
 */
function rewriteExistencePatternsOf<C extends ExistenceScopeContext>(
  c: C,
  op: Algebra.Operation,
  pass: ExistenceScopedPass<C>,
): void {
  if (!expressionsEvaluatedBy(op).some(containsExistenceExpression)) {
    return;
  }
  const solutions = joinedMeta([ (<A.Single | A.Multi> op).input ].flat().map(input => cpMetaOf(c, input)));
  const rewritePatterns = (expression: Algebra.Expression): Algebra.Expression =>
    algebraUtils.mapOperationSub<'unsafe', Algebra.Expression>(expression, {}, { expression: { existence: {
      // A nested EXISTS is rewritten with the pattern holding it.
      ...leaveExistencePatterns,
      transform: (existence: Algebra.ExistenceExpression) => {
        const existenceScope = metaRestrictedTo(solutions, collectVariableNames(c.astTransformer, existence.input));
        const pattern = withoutCpVars(existence.input);
        return { ...existence, input: rewriteTreeInExistenceScopes({ ...c, existenceScope }, pattern, pass) };
      },
    }}});
  replaceExpressionsEvaluatedBy(op, rewritePatterns);
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
