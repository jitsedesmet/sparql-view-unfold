import { Algebra, algebraUtils } from '@traqula/algebra-transformations-1-2';
import type { TransformContext } from '../transformContext.js';

/**
 * TODO: Optimization transformation that extracts constant assignments a variable in a VALUES with a
 * sameTerm filter in case the VALUES are JOINED with other branches.
 *
 * TODO: what if other unary variables are on the join.
 */
export function transformJoinValuesToFilter<T extends Algebra.Operation>(c: TransformContext, op: T): T {
  return algebraUtils.mapOperation<'unsafe', typeof op>(op, {
    [Algebra.Types.JOIN]: {
      // Transform: join => convertJoinValues(c, join),
    },
  });
}
