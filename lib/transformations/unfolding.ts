import { Algebra, algebraUtils } from '@traqula/algebra-transformations-1-2';
import { withDeduplicatedBody } from '../mapping.js';
import type { TransformationContext } from '../transformContext.js';
import type { Mapping, QueryTransformation } from '../types.js';
import { rewriteSinglePattern } from './rewriteSinglePattern.js';

/**
 * @fileoverview The unfolding itself: every triple pattern of the user query replaced by the mapping body
 * that produces the triples it could match.
 *
 * This is the one pass that needs something besides the query, namely the mapping, and the only reason
 * {@link unfoldingTransformation} is a factory taking an argument where every other one takes `()`. The
 * mapping travels in the closure rather than in the {@link TransformationContext}, so that two rewriters
 * over two mappings cannot read each other's.
 *
 * **Sibling patterns need no namespacing of their own.** Each is rewritten into a sub-SELECT projecting
 * only the pattern's own variables, which are the user query's, so the mapping variables of two patterns
 * sit in two scopes and cannot be unified by accident: the `uq_` prefix keeps a mapping variable apart from
 * the user query, and the projection keeps it apart from the other patterns. The only internal variable
 * that *does* leave a sub-SELECT is the existence variable a pattern binding nothing projects in place of
 * an empty projection, and {@link rewriteSinglePattern} names that one after the pattern.
 */

/** What an unfolding may be configured with. */
export interface UnfoldingOptions {
  /**
   * Whether the unfolded query counts a triple two solutions of the mapping body both produce once, the way
   * the mapped graph - a set - does, rather than twice. **Hugely costly**: it deduplicates the whole body
   * of every unfolded pattern, where the unfolding otherwise streams. Off by default, so turn it on only
   * when the multiplicity of a solution is part of the answer you need.
   */
  preserveCardinality?: boolean;
}

/**
 * Rewrites every BGP of an operation into a join of its patterns unfolded against the mapping.
 * @param c - The transformation context
 * @param mapping - The mapping to unfold
 * @param input - The operation to rewrite
 * @returns the rewritten operation
 */
export function unfoldTriplePatternsAgainstMapping(
  c: TransformationContext,
  mapping: Mapping,
  input: Algebra.Operation,
): Algebra.Operation {
  return algebraUtils.mapOperation<'unsafe', typeof input>(
    input,
    { [Algebra.Types.BGP]: { transform: input =>
      c.AF.createJoin(
        input.patterns.map(pattern => rewriteSinglePattern(c, pattern, mapping)),
        true,
      ),
    }},
  );
}

/**
 * The pipeline step replacing every triple pattern of the user query by the mapping body producing the
 * triples it could match.
 * @param mapping - The mapping to unfold, from {@link mapping!mappingFromConstructQueries}
 * @param options - What to configure the unfolding with
 * @returns the transformation
 */
export function unfoldingTransformation(mapping: Mapping, options: UnfoldingOptions = {}): QueryTransformation {
  return (context, operation) => unfoldTriplePatternsAgainstMapping(
    context,
    options.preserveCardinality === true ? withDeduplicatedBody(context, mapping) : mapping,
    operation,
  );
}
