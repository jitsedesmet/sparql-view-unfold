import { Algebra } from '@traqula/algebra-transformations-1-2';

/**
 * @fileoverview The chain of solution modifiers at the top of a query.
 *
 * The `PROJECT`, `DISTINCT`, `LIMIT`, … between a query's root and its pattern decide its answer, so passes
 * leave them alone: {@link transformations/pullUpExtends!pullUpExtends} floats nothing into them, and
 * {@link transformations/filterFalse!transformFilterFalse} collapses none of them.
 */

/**
 * The operations that say what a query *answers with*. Exactly one of them is the query's own and it ends
 * the chain: a `PROJECT` below it is a sub-SELECT, part of the pattern.
 */
export const queryFormTypes = new Set<string>([
  Algebra.Types.PROJECT,
  Algebra.Types.ASK,
  Algebra.Types.CONSTRUCT,
  Algebra.Types.DESCRIBE,
]);

/**
 * The operation types that make up a query's solution-modifier chain. `ORDER_BY` stands below the
 * projection, inside the pattern, so it is not one of them.
 */
export const solutionModifierTypes = new Set<string>([
  ...queryFormTypes,
  Algebra.Types.DISTINCT,
  Algebra.Types.REDUCED,
  Algebra.Types.SLICE,
  Algebra.Types.FROM,
]);

/**
 * The nodes of the solution-modifier chain at the top of `root`.
 * @param root - The root of the tree the traversal is about to run over
 * @returns those nodes, by identity, so that a callback can recognise its own original
 */
export function solutionModifierChainOf(root: Algebra.Operation): Set<Algebra.Operation> {
  const sealed = new Set<Algebra.Operation>();
  let current = root;
  while (solutionModifierTypes.has(current.type)) {
    sealed.add(current);
    current = (<Algebra.Single> current).input;
  }
  return sealed;
}
