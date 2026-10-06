import { Algebra, algebraUtils } from '@traqula/algebra-transformations-1-2';
import type { PreOrderMappingReturn } from '@traqula/core';
import { withoutCpVars } from './certainlyBoundVars.js';

/**
 * @fileoverview The top-down traversal the pushdowns share: a callback per operation type moves something one
 * level down, and the traversal carries it on through whatever that callback put in place.
 */

/** Metadata is a cache to carry along, never a tree to iterate into: its sets do not survive that. */
export const keepMetadata = { shallowKeys: new Set([ 'metadata' ]) };

/** What a pushdown hands the traversal for one operation type. */
export type PreOrderCallbacks = Partial<Record<Algebra.Types, (copy: any) => PreOrderMappingReturn>>;

/**
 * Hands a value to the traversal, keeping the metadata of everything in it intact.
 * @param newValue - What to put in place of the operation
 * @returns the traversal's instruction, to iterate into the descendants of the value
 */
export function keep(newValue: Algebra.Operation): PreOrderMappingReturn {
  return { ...keepMetadata, newValue };
}

/**
 * Rewrites a tree top-down, keeping every operation without a callback as it is.
 *
 * The tree is entered and left without metadata: entering gives a tree of its own to rewrite, on which what
 * {@link utils/certainlyBoundVars!withCpVars} caches describes the plan as it stands, and leaving clears what
 * the rewrites have since invalidated. The pattern of an EXISTS is never entered: the solution it is asked
 * about is substituted into it, so a variable it never binds itself may well be bound there.
 * @param rootOp - The tree to rewrite
 * @param callbacks - The rewrite per operation type
 * @returns the rewritten tree
 */
export function mapOperationPreOrderKeepingMetadata<T extends Algebra.Operation>(
  rootOp: T,
  callbacks: PreOrderCallbacks,
): T {
  const everyCallback: Parameters<typeof algebraUtils.mapOperationPreOrder<'unsafe', T>>[1] = {
    ...Object.fromEntries(Object.values(Algebra.Types).map(type => [ type, (copy: Algebra.Operation) => keep(copy) ])),
    ...callbacks,
    [Algebra.Types.EXPRESSION]: (expression: Algebra.Expression) =>
      ({ ...keepMetadata, newValue: expression, continue: false }),
  };
  return withoutCpVars(algebraUtils.mapOperationPreOrder<'unsafe', T>(withoutCpVars(rootOp), everyCallback));
}
