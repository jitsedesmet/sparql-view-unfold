import type { Algebra as Alg } from '@traqula/algebra-transformations-1-2';
import { Algebra, algebraUtils } from '@traqula/algebra-transformations-1-2';

/**
 * @fileoverview What a user query may not ask, checked once per query part before the pipeline runs over it.
 *
 * Both restrictions below would otherwise produce a **silently wrong** query rather than an error, which is
 * why they are checked here rather than left to the passes that trip over them:
 *
 * - A recursive path (`+`, `*`) is the one path
 *   {@link transformations/pathTransformation!rewriteNonRecursivePaths} cannot expand into triple patterns,
 *   so it reaches the unfolding un-expanded, is left alone, and ends up querying the RDF 1.1 data directly -
 *   bypassing the mapping entirely.
 * - A named graph loses its graph on the way through, the unfolding replacing a pattern by a sub-SELECT that
 *   has no graph slot to carry one. What unfolding a mapping *inside* a named graph should mean is not
 *   settled, and rejecting is the honest answer until it is.
 *
 * A query names its graphs with a `GRAPH` operation and an update - which has an algebra only in quad mode -
 * with the graph component of a pattern, so both spellings are rejected.
 *
 * The mapping-side restrictions live in {@link mapping!mappingFromConstructQueries}, which can check them
 * once, when the mapping is built.
 */

/** Where the restrictions are written out for a reader. */
const restrictionsDocumentation = 'see the "Restrictions" section of the README';

/**
 * Asserts that the rewriting is defined for this query part - the pattern of a query, the `WHERE` of an
 * update.
 * @param queryPart - The operation the pipeline is about to run over
 * @throws Error naming the restriction it violates
 */
export function assertUserQueryIsSupported(queryPart: Algebra.Operation): void {
  function rejectRecursivePath(pathOperator: string): never {
    throw new Error(`A recursive property path (${pathOperator}) is not supported: it cannot be expanded into triple patterns, so the mapping cannot be unfolded into it (${restrictionsDocumentation}).`);
  }

  function rejectNamedGraph(): never {
    throw new Error(`Querying a named graph (GRAPH) is not supported: what unfolding a mapping inside one means is not settled (${restrictionsDocumentation}).`);
  }

  algebraUtils.visitOperation(queryPart, {
    [Algebra.Types.ZERO_OR_MORE_PATH]: { visitor: () => rejectRecursivePath('*') },
    [Algebra.Types.ONE_OR_MORE_PATH]: { visitor: () => rejectRecursivePath('+') },
    [Algebra.Types.GRAPH]: { visitor: () => rejectNamedGraph() },
    [Algebra.Types.PATTERN]: { visitor: (pattern: Alg.Pattern) => {
      if (pattern.graph.termType !== 'DefaultGraph') {
        rejectNamedGraph();
      }
    } },
  });
}
