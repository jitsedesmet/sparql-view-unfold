import { Algebra, algebraUtils } from '@traqula/algebra-transformations-1-2';
import type { PreOrderMappingReturn } from '@traqula/core';
import { forEveryNodeType } from '@traqula/core';
import type { RangeContext } from './certainlyBoundVars.js';
import { leaveExistencePatternsPreOrder, rewriteInExistenceScopes } from './existenceScopes.js';

/**
 * @fileoverview The top-down traversal the pushdowns share: a callback per operation type moves something one
 * level down, and the traversal carries it on through whatever that callback put in place.
 */

/** Metadata is a cache to carry along, never a tree to iterate into: its sets do not survive that. */
export const keepMetadata = { shallowKeys: new Set([ 'metadata' ]) };

/** A pre-order callback for one operation type. */
export type PreOrderCallback = (copy: any) => PreOrderMappingReturn;

/** What a pushdown hands the traversal per operation type. */
export type PreOrderCallbacks = Partial<Record<Algebra.Types, PreOrderCallback>>;

/**
 * Hands a value to the traversal, keeping the metadata of everything in it intact.
 * @param newValue - What to put in place of the operation
 * @returns the traversal's instruction, to iterate into the descendants of the value
 */
export function keep(newValue: Algebra.Operation): PreOrderMappingReturn {
  return { ...keepMetadata, newValue };
}

/**
 * Rewrites a tree top-down, then each EXISTS pattern in it in the scope of its outer solution.
 * @param c - The context to rewrite in
 * @param op - The tree to rewrite, which is left untouched
 * @param callbacksIn - The callbacks per operation type, given the context of the tree or pattern they rewrite
 * @param fallbackIn - The callback for every other operation type, {@link keep} by default
 * @returns the rewritten tree, without cached metadata
 */
export function mapPreOrderInExistenceScopes<C extends RangeContext, T extends Algebra.Operation>(
  c: C,
  op: T,
  callbacksIn: (context: C) => PreOrderCallbacks,
  fallbackIn: (context: C) => PreOrderCallback = () => keep,
): T {
  return rewriteInExistenceScopes(c, op, (context, operation) => {
    const callbacks = forEveryNodeType(fallbackIn(context), {
      ...callbacksIn(context),
      [Algebra.Types.EXPRESSION]: leaveExistencePatternsPreOrder,
    });
    return algebraUtils.mapOperationPreOrder<'unsafe', Algebra.Operation>(operation, callbacks);
  });
}
