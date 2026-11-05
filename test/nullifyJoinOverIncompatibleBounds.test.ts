import type { Algebra } from '@traqula/algebra-transformations-1-2';
import { describe, it } from 'vitest';
import { nullifyJoinOverIncompatibleBounds } from '../lib/transformations/nullifyJoinOverIncompatibleBounds.js';
import { createTransformationContext } from '../lib/transformContext.js';

describe('nullifyJoinOverIncompatibleBounds', () => {
  const c = createTransformationContext();

  it('leaves a join of no operands as it stands', ({ expect }) => {
    // A join of no operands is the join identity, as an empty BGP is.
    expect(nullifyJoinOverIncompatibleBounds(c, c.AF.createJoin([]))).toEqual(c.AF.createJoin([]));
  });

  it('leaves a join over a union of no operands as it stands', ({ expect }) => {
    const join = (): Algebra.Join => c.AF.createJoin([ c.AF.createUnion([]), c.AF.createBgp([]) ], false);
    expect(nullifyJoinOverIncompatibleBounds(c, join())).toEqual(join());
  });
});
