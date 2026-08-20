import { Algebra, algebraUtils } from '@traqula/algebra-transformations-1-2';
import type { PreOrderMappingReturn } from '@traqula/core';
import type { TransformContext } from '../transformContext.js';
import { withCpVars, withoutCpVars } from '../utils/certainlyBoundVars.js';
import { createFilterFalse } from '../utils/operationhelpers.js';

/**
 * @fileoverview Nullification of operations their own ranges prove empty.
 *
 * A variable in `cVars` is bound in *every* solution of the operation. A variable whose range is empty can
 * be bound to no term at all. One that is both leaves the operation nowhere to put a value it has to
 * produce, so it has no solutions - and the pair is the only thing this pass looks for.
 *
 * The proof is a *type* one, which is what it adds over the term-level checks elsewhere:
 * {@link nullifyJoinOverIncompatibleBounds} sees two branches binding a variable to two different terms,
 * where this sees one binding it to a Literal and another to a NamedNode without either naming a term.
 * The cases it decides are the ones the ranges already compute:
 *
 * - a join whose operands certainly bind a variable to incompatible term *types*;
 * - a `GRAPH ?g` over a pattern certainly binding `?g` to something no graph is named by;
 * - a `VALUES` with no rows, whose columns are all vacuously certain and hold nothing;
 * - `FILTER(bound(?x))` over an operation that cannot bind `?x`, which is (FBndII).
 *
 * The replacement wraps the operation rather than dropping it - `pVars(Empty_S) := S`, never `∅`, or
 * `SELECT *` scoping changes silently - and {@link transformFilterFalse} does the structural normalisation
 * afterwards (`Empty ∪ A ≡ A`, a join absorbing it, and so on).
 */

/** Metadata is a cache to carry along, never a tree to iterate into: its sets do not survive that. */
const keepMetadata = { shallowKeys: new Set([ 'metadata' ]) };

/**
 * Replaces every operation whose ranges prove it has no solutions by the empty solution multiset.
 *
 * @example
 * // Before: SELECT * WHERE { GRAPH ?g { { VALUES ?g { "l" } } } }
 * // After:  the GRAPH replaced by FILTER(false), since no graph is named by a literal.
 *
 * @param c - The transformation context
 * @param op - The operation to transform
 * @returns The operation with every provably empty subtree nullified
 */
export function nullifyUnbindableVars<T extends Algebra.Operation>(c: TransformContext, op: T): T {
  const callbacks: Parameters<typeof algebraUtils.mapOperationPreOrder<'unsafe', T>>[1] = Object.fromEntries(
    Object.values(Algebra.Types).map(type => [ type, (copy: Algebra.Operation) => nullifyIfProvenEmpty(c, copy) ]),
  );
  // Starting from a copy without metadata gives us both a tree of our own to rewrite and the guarantee
  // that what `withCpVars` hands us describes the plan as it is now - and clearing it again on the way
  // out, since what the traversal cached describes the plan as this pass found it.
  return withoutCpVars(algebraUtils.mapOperationPreOrder<'unsafe', T>(withoutCpVars(op), callbacks));
}

/**
 * The operation, or the empty solution multiset in its place when it certainly binds a variable that can
 * take no term.
 *
 * Pre-order, and it stops descending once it has replaced something: nothing under an operation without
 * solutions can contribute any.
 */
function nullifyIfProvenEmpty(c: TransformContext, op: Algebra.Operation): PreOrderMappingReturn {
  const { cVars, vRanges } = withCpVars(op).metadata;
  for (const name of cVars) {
    if (vRanges.neverBinds(name)) {
      return { ...keepMetadata, newValue: createFilterFalse(c, op), continue: false };
    }
  }
  return { ...keepMetadata, newValue: op };
}
