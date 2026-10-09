import type { Algebra as Alg } from '@traqula/algebra-transformations-1-2';
import { Algebra, algebraUtils } from '@traqula/algebra-transformations-1-2';

/**
 * @fileoverview What a user query may not ask, checked once per query part before the pipeline runs over it.
 *
 * Every restriction below would otherwise produce a **silently wrong** query rather than an error, which is
 * why they are checked here rather than left to the passes that trip over them:
 *
 * - A recursive path (`+`, `*`) is the one path
 *   {@link transformations/pathTransformation!rewriteNonRecursivePaths} cannot expand into triple patterns,
 *   so it reaches the unfolding un-expanded, is left alone, and ends up querying the RDF 1.1 data directly -
 *   bypassing the mapping entirely.
 * - A named graph loses its graph on the way through, the unfolding replacing a pattern by a sub-SELECT that
 *   has no graph slot to carry one. What unfolding a mapping *inside* a named graph should mean is not
 *   settled, and rejecting is the honest answer until it is.
 * - A `SERVICE` asks a remote endpoint, whose data the mapping is not defined over. Unfolding into it reads
 *   that endpoint through the mapping, leaving it alone reads it as it is, and which of the two a query
 *   means is not settled either.
 *
 * A query names its graphs with a `GRAPH` operation and an update - which has an algebra only in quad mode -
 * with the graph component of a pattern, so both spellings are rejected.
 *
 * The mapping-side restrictions live in {@link mapping!mappingFromConstructQueries}, which can check them
 * once, when the mapping is built. A `SERVICE` in a mapping body is no restriction: there it is part of how
 * the mapping finds its triples.
 */

/** Where the restrictions are written out for a reader. */
const restrictionsDocumentation = 'see the "Restrictions" section of the README';

/** Why a construct scoping the patterns inside it to other data is rejected. */
const unsettledUnfoldingInside = 'what unfolding a mapping inside one means is not settled';

/**
 * Throws the error for something a user query asks that the rewriting is not defined for.
 * @param construct - What the query asks, as the error names it
 * @param reason - Why the rewriting is not defined for it
 * @throws Error naming the construct, the reason, and where the restrictions are documented
 */
function rejectUnsupported(construct: string, reason: string): never {
  throw new Error(`${construct} is not supported: ${reason} (${restrictionsDocumentation}).`);
}

/**
 * Asserts that the rewriting is defined for this query part - the pattern of a query, the `WHERE` of an
 * update.
 * @param queryPart - The operation the pipeline is about to run over
 * @throws Error naming the restriction it violates
 */
export function assertUserQueryIsSupported(queryPart: Algebra.Operation): void {
  const rejectRecursivePath = (pathOperator: string): never => rejectUnsupported(
    `A recursive property path (${pathOperator})`,
    'it cannot be expanded into triple patterns, so the mapping cannot be unfolded into it',
  );
  const rejectNamedGraph = (): never =>
    rejectUnsupported('Querying a named graph (GRAPH)', unsettledUnfoldingInside);
  const rejectService = (): never =>
    rejectUnsupported('Querying a remote endpoint (SERVICE)', unsettledUnfoldingInside);

  algebraUtils.visitOperation(queryPart, {
    [Algebra.Types.ZERO_OR_MORE_PATH]: { visitor: () => rejectRecursivePath('*') },
    [Algebra.Types.ONE_OR_MORE_PATH]: { visitor: () => rejectRecursivePath('+') },
    [Algebra.Types.GRAPH]: { visitor: rejectNamedGraph },
    [Algebra.Types.SERVICE]: { visitor: rejectService },
    [Algebra.Types.PATTERN]: { visitor: (pattern: Alg.Pattern) => {
      if (pattern.graph.termType !== 'DefaultGraph') {
        rejectNamedGraph();
      }
    } },
  });
}
