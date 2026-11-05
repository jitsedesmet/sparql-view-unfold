import type * as RDF from '@rdfjs/types';
import { Algebra, algebraUtils } from '@traqula/algebra-transformations-1-2';
import type { TransformationContext } from '../transformContext.js';
import type { QueryTransformation } from '../types.js';
import type { OuterBinding } from '../utils/existenceScopes.js';
import {
  holdsExistence,
  leaveExistencePatterns,
  outerBinding,
  rewriteInExistenceScopes,
} from '../utils/existenceScopes.js';
import { groupProjectedBy } from '../utils/operationhelpers.js';
import { collectVariableNames, freshVarGenerator, markVariableNamesUsed, renameVariables } from '../utils.js';

/**
 * Transformation that removes all PROJECT operations from an algebra tree.
 *
 * A projection restricts which variables are visible outside its subtree. Simply
 * dropping it would leak the previously hidden variables, letting them accidentally
 * join with identically named variables in the surrounding query. To preserve
 * semantics, every variable that is *not* projected is first anonymized: it is
 * renamed to a fresh, guaranteed-unique variable (see {@link freshVarGenerator}).
 * Afterwards the PROJECT node is replaced by its input.
 *
 * Projections are processed bottom-up, so nested (sub-SELECT) projections are
 * removed before their enclosing ones.
 *
 * A projection directly below a DISTINCT or REDUCED is kept: those operators deduplicate over
 * exactly the variables their input exposes, so anonymizing the hidden variables instead of
 * dropping them would make the deduplication consider them too, changing the result.
 *
 * A projection directly below a SLICE is kept for a different reason: dropping it is sound - a projection
 * without a DISTINCT preserves multiplicity, so the same rows fall in the window either way - but SPARQL
 * has no way to *write* a LIMIT or OFFSET that is not on a SELECT, and `toAst` rejects the `Slice` it
 * would be left holding.
 *
 * A projection over a GROUP is kept for that same reason: a GROUP BY is only written on a SELECT, and without
 * one the grouping would be printed on the enclosing query.
 *
 * Inside an EXISTS, SPARQL 1.2 joins the outer solution into the sub-SELECT too. A hidden variable it certainly binds
 * keeps its name, and a projection hiding a variable it may bind is kept.
 *
 * @param c - The transformation context
 * @param op - The operation to transform
 * @returns The transformed operation, without the PROJECT operations it can drop
 *
 * @example
 * // Before: SELECT ?x { ?x ?y ?z }        (?y and ?z are not projected)
 * // After:  ?x ?v_0 ?v_1                  (projection removed, hidden vars anonymized)
 */
export function removeProjections<T extends Algebra.Operation>(c: TransformationContext, op: T): T {
  // Coined against every name in use, EXISTS patterns included, so fresh names never collide.
  const nextVar = freshVarGenerator(markVariableNamesUsed(c, op));
  const pass = (context: TransformationContext, operation: Algebra.Operation): Algebra.Operation =>
    removeProjectionsAroundExistence(context, operation, nextVar);
  return holdsExistence(op) ? rewriteInExistenceScopes(c, op, pass) : <T> pass(c, op);
}

/**
 * Removes the projections of an operation, leaving EXISTS patterns alone.
 * @param c - The transformation context, whose `existenceScope` is the solution of the EXISTS the operation is in
 * @param op - The operation to transform
 * @param nextVar - Coins a fresh variable
 * @returns the operation without the projections it can drop
 */
function removeProjectionsAroundExistence(
  c: TransformationContext,
  op: Algebra.Operation,
  nextVar: () => RDF.Variable,
): Algebra.Operation {
  // Filled top-down (preVisitor) before the projection itself is transformed bottom-up.
  const keptProjections = new Set<Algebra.Operation>();
  const keepProjectedInput = (operation: Algebra.Distinct | Algebra.Reduced | Algebra.Slice): object => {
    if (operation.input.type === Algebra.Types.PROJECT) {
      keptProjections.add(operation.input);
    }
    return {};
  };

  // TODO: this renames even if it has already renamed so could be optimized, but that's not a priority now.
  return algebraUtils.mapOperation<'unsafe', typeof op>(op, {
    [Algebra.Types.EXPRESSION]: leaveExistencePatterns,
    [Algebra.Types.DISTINCT]: { preVisitor: keepProjectedInput },
    [Algebra.Types.REDUCED]: { preVisitor: keepProjectedInput },
    [Algebra.Types.SLICE]: { preVisitor: keepProjectedInput },
    [Algebra.Types.PROJECT]: { preVisitor: (project) => {
      if (groupProjectedBy(project)) {
        keptProjections.add(project);
      }
      return {};
    }, transform: (project, original) => {
      if (keptProjections.has(original)) {
        return project;
      }
      const projected = new Set(project.variables.map(variable => variable.value));
      // The variables the projection hides, also in an EXISTS pattern this pass has yet to enter, where renaming
      // must reach too.
      const hidden: Record<OuterBinding, string[]> = { certain: [], maybe: [], none: []};
      for (const name of collectVariableNames(c.astTransformer, project.input)) {
        if (!projected.has(name)) {
          hidden[outerBinding(c.existenceScope, name)].push(name);
        }
      }
      if (hidden.maybe.length > 0) {
        return project;
      }
      const renames = new Map(hidden.none.map(name => [ name, nextVar().value ]));
      return renameVariables(c, project.input, renames);
    } },
  });
}

/**
 * The pipeline step removing every inner `PROJECT`, renaming what it hid to keep the scoping.
 * @returns the transformation
 */
export function removeProjectionsTransformation(): QueryTransformation {
  return removeProjections;
}
