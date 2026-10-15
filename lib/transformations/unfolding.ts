import type * as RDF from '@rdfjs/types';
import { Algebra, algebraUtils } from '@traqula/algebra-transformations-1-2';
import { VAR_PREFIX_MAPPING } from '../consts.js';
import { withDeduplicatedBody } from '../mapping.js';
import type { TransformationContext } from '../transformContext.js';
import type { Mapping, QueryTransformation } from '../types.js';
import { claimVariableName, collectVariableNames, renameVariables } from '../utils.js';
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
 * **The mapping is renamed apart from the user query, and only where the two collide.** A mapping
 * variable whose name the user query also uses is renamed under {@link VAR_PREFIX_MAPPING}; every other
 * variable keeps the name it was written with. Nothing is told apart by its name: the unfolding knows which
 * side of the unification a variable is on. The names only have to differ because the mapping body and
 * the binds of the pattern's variables share one scope.
 *
 * **Sibling patterns need no namespacing of their own.** Each is rewritten into a sub-SELECT projecting
 * only the pattern's own variables, which are the user query's, so the mapping variables of two patterns
 * sit in two scopes and cannot be unified by accident. The only internal variable that *does* leave a
 * sub-SELECT is the existence variable a pattern binding nothing projects in place of an empty projection,
 * which the context coins apart from every name of the query and the mapping.
 *
 * **A `SERVICE` is left as it stands.** Its endpoint evaluates the pattern over its own data, which the mapping
 * does not describe, and that answer does not depend on the data the rest of the query is unfolded over.
 */

/** What an unfolding may be configured with. */
export interface UnfoldingOptions {
  /**
   * Whether the unfolded query counts a triple two solutions of the mapping body both produce once, the way
   * the mapped graph - a set - does, rather than twice. **Potentially expensive**: it deduplicates the whole
   * body of every unfolded pattern, where the unfolding otherwise streams. Where the mapping body produces
   * many duplicate triples, it can instead speed the query up, since the joins then combine fewer
   * solutions. Off by default.
   */
  preserveCardinality?: boolean;
}

/**
 * Rewrites every BGP of an operation outside a `SERVICE` into a join of its patterns unfolded against the
 * mapping.
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
    {
      [Algebra.Types.BGP]: { transform: input =>
        c.AF.createJoin(
          input.patterns.map(pattern => rewriteSinglePattern(c, pattern, mapping)),
          true,
        ),
      },
      [Algebra.Types.SERVICE]: { preVisitor: () => ({ continue: false }) },
    },
  );
}

/**
 * The pipeline step replacing every triple pattern of the user query outside a `SERVICE` by the mapping body
 * producing the triples it could match.
 * @param mapping - The mapping to unfold, from {@link mapping!mappingFromConstructQueries}
 * @param options - What to configure the unfolding with
 * @returns the transformation
 */
export function unfoldingTransformation(mapping: Mapping, options: UnfoldingOptions = {}): QueryTransformation {
  return (context, operation) => {
    const mappingApart = renameMappingApart(context, mapping, collectVariableNames(context.astTransformer, operation));
    context.reserveVariableNames(collectVariableNames(context.astTransformer, mappingApart));
    return unfoldTriplePatternsAgainstMapping(
      context,
      options.preserveCardinality === true ? withDeduplicatedBody(context, mappingApart) : mappingApart,
      operation,
    );
  };
}

/**
 * Renames every mapping variable whose name the query uses, under {@link VAR_PREFIX_MAPPING}.
 *
 * Always hands back a copy, even where nothing collides: the mapping lives in the closure of the
 * transformation and so is shared by every rewrite that transformation runs.
 * @param c - The transformation context
 * @param mapping - The mapping to rename
 * @param queryVariableNames - The names of the variables of the query the mapping is unfolded into
 * @returns the renamed mapping
 */
function renameMappingApart(
  c: TransformationContext,
  mapping: Mapping,
  queryVariableNames: ReadonlySet<string>,
): Mapping {
  const mappingVariableNames = collectVariableNames(c.astTransformer, mapping);
  const taken = new Set([ ...queryVariableNames, ...mappingVariableNames ]);
  const renames: Record<string, RDF.Variable> = {};
  // Sorted, so that which name gets which suffix does not depend on where the mapping writes it.
  for (const name of [ ...mappingVariableNames ].sort()) {
    if (queryVariableNames.has(name)) {
      renames[name] = c.DF.variable(claimVariableName(`${VAR_PREFIX_MAPPING}${name}`, taken));
    }
  }
  return renameVariables(c, mapping, renames);
}
