import { Algebra, algebraUtils } from '@traqula/algebra-transformations-1-2';

/**
 * @fileoverview What a user query may not ask, checked once before the pipeline runs.
 *
 *
 * // TODO: no need to specify how things used to work. Simply describe what is now.
 *      This holds anywhere, please check your diff.
 * The first two restrictions below used to produce a **silently wrong** query rather than an error, which
 * is the reason this check exists at all rather than living in the passes that trip over them:
 *
 * - A recursive path (`+`, `*`) is the one path
 *   {@link transformations/pathTransformation!rewriteNonRecursivePaths} cannot expand into triple patterns,
 *   so it reaches the unfolding un-expanded, is left alone, and ends up querying the RDF 1.1 data directly -
 *   bypassing the mapping entirely.
 * - A `GRAPH` loses its graph on the way through, leaving a query that projects a graph variable nothing
 *   binds. What unfolding a mapping *inside* a named graph should mean is not settled, and rejecting is the
 *   honest answer until it is.
 * - An update reads and writes rather than answers, and the rewriting is defined over queries.
 *
 * The mapping-side restrictions live in {@link mapping!mappingFromConstructQueries}, which can check them
 * once, when the mapping is built.
 */

/** Where the restrictions are written out for a reader. */
const restrictionsDocumentation = 'see the "Restrictions" section of the README';

// TODO: just to be sure, updates are simply allowed,
//  rather it should be specified that the where is rewritten over
//  the mapping but that the template instantiation happens as is. Over the original source instead
//  since the view source is only virtual.
/** The operations that write rather than answer; an update is one of them, at the root of the algebra. */
const updateOperationTypes = new Set<string>([
  Algebra.Types.COMPOSITE_UPDATE,
  Algebra.Types.DELETE_INSERT,
  Algebra.Types.LOAD,
  Algebra.Types.CLEAR,
  Algebra.Types.CREATE,
  Algebra.Types.DROP,
  Algebra.Types.ADD,
  Algebra.Types.MOVE,
  Algebra.Types.COPY,
]);

/**
 * Asserts that the rewriting is defined for this user query.
 * @param operation - The parsed user query
 * @throws Error naming the restriction the query violates
 */
export function assertUserQueryIsSupported(operation: Algebra.Operation): void {
  if (updateOperationTypes.has(operation.type)) {
    throw new Error(`An update (${operation.type}) cannot be rewritten: the rewriting is defined over queries (${restrictionsDocumentation}).`);
  }

  function rejectRecursivePath(pathOperator: string): never {
    throw new Error(`A recursive property path (${pathOperator}) is not supported: it cannot be expanded into triple patterns, so the mapping cannot be unfolded into it (${restrictionsDocumentation}).`);
  }

  algebraUtils.visitOperation(operation, {
    [Algebra.Types.ZERO_OR_MORE_PATH]: { visitor: () => rejectRecursivePath('*') },
    [Algebra.Types.ONE_OR_MORE_PATH]: { visitor: () => rejectRecursivePath('+') },
    [Algebra.Types.GRAPH]: { visitor: () => {
      throw new Error(`Querying a named graph (GRAPH) is not supported: what unfolding a mapping inside one means is not settled (${restrictionsDocumentation}).`);
    } },
  });
}
