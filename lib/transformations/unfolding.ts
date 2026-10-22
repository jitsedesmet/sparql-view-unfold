import { Algebra, algebraUtils } from '@traqula/algebra-transformations-1-2';
import { AstTransformer } from '@traqula/rules-sparql-1-2';
import { VAR_PREFIX_MAPPING } from '../consts.js';
import { withDeduplicatedBody } from '../mapping.js';
import type { TransformationContext } from '../transformContext.js';
import type { Mapping, QueryTransformation } from '../types.js';
import { claimVariableName, collectVariableNames, markVariableNamesUsed, renameVariables } from '../utils.js';
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
 * **A mapping variable whose name is in use is renamed** under {@link VAR_PREFIX_MAPPING}, since the mapping
 * body shares a scope with the binds of the pattern's variables.
 *
 * **Sibling patterns need no namespacing of their own.** Each is rewritten into a sub-SELECT projecting
 * only the pattern's own variables, which are the user query's, so the mapping variables of two patterns
 * sit in two scopes and cannot be unified by accident. The only internal variable that *does* leave a
 * sub-SELECT is the existence variable a pattern binding nothing projects in place of an empty projection,
 * which the context coins apart from every name in use.
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
 * Rewrites every non-empty BGP of an operation outside a `SERVICE` into a join of its patterns unfolded against
 * the mapping.
 * @param c - The transformation context
 * @param mapping - The mapping to unfold, its variables named apart from the operation's
 * @param input - The operation to rewrite
 * @param inExistence - Whether the operation is in the pattern of an EXISTS
 * @returns the rewritten operation
 */
function unfoldTriplePatternsAgainstMapping(
  c: TransformationContext,
  mapping: Mapping,
  input: Algebra.Operation,
  inExistence = false,
): Algebra.Operation {
  return algebraUtils.mapOperation<'unsafe', typeof input>(
    input,
    {
      // An empty BGP has no pattern to unfold and is already the join identity.
      [Algebra.Types.BGP]: { transform: input => input.patterns.length === 0 ?
        input :
        c.AF.createJoin(
          input.patterns.map(pattern => rewriteSinglePattern(c, pattern, mapping, inExistence)),
          true,
        ),
      },
      [Algebra.Types.SERVICE]: { preVisitor: () => ({ continue: false }) },
      // The pattern of an EXISTS is unfolded here, knowing it is one.
      [Algebra.Types.EXPRESSION]: {
        preVisitor: expression => expression.subType === Algebra.ExpressionTypes.EXISTENCE ? { continue: false } : {},
        transform: (expression) => {
          if (expression.subType === Algebra.ExpressionTypes.EXISTENCE) {
            expression.input = unfoldTriplePatternsAgainstMapping(c, mapping, expression.input, true);
          }
          return expression;
        },
      },
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
  // Sorted, so that which name gets which suffix does not depend on where the mapping writes it.
  const mappingVariableNames = [ ...collectVariableNames(new AstTransformer(), mapping) ].sort();
  return (context, operation) => {
    const usedNames = markVariableNamesUsed(context, operation);
    const mappingApart = renameMappingApart(context, mapping, mappingVariableNames, usedNames);
    return unfoldTriplePatternsAgainstMapping(
      context,
      options.preserveCardinality === true ? withDeduplicatedBody(context, mappingApart) : mappingApart,
      operation,
    );
  };
}

/**
 * Renames every mapping variable whose name is in use under {@link VAR_PREFIX_MAPPING}, and marks the
 * mapping's names as used.
 * @param c - The transformation context
 * @param mapping - The mapping to rename
 * @param mappingVariableNames - The names of the variables of the mapping
 * @param usedNames - The names in use in the rewrite
 * @returns the mapping, renamed apart from the names in use
 */
function renameMappingApart(
  c: TransformationContext,
  mapping: Mapping,
  mappingVariableNames: readonly string[],
  usedNames: Set<string>,
): Mapping {
  const collidingNames = mappingVariableNames.filter(name => usedNames.has(name));
  for (const name of mappingVariableNames) {
    usedNames.add(name);
  }
  const renames = new Map(collidingNames
    .map(name => [ name, claimVariableName(`${VAR_PREFIX_MAPPING}${name}`, usedNames) ]));
  return collidingNames.length === 0 ? mapping : renameVariables(c, mapping, renames);
}
