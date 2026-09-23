import { Algebra, algebraUtils } from '@traqula/algebra-transformations-1-2';
import type { TransformationContext } from '../transformContext.js';
import type { QueryTransformation } from '../types.js';
import { createFilterFalse } from '../utils/operationhelpers.js';
import { termIsStaticTerm } from '../utils/typeGuards.js';
import { directExtensions } from '../utils.js';
import { VariableSet } from './variableSet.js';

// TODO: implement this check to not only check static bind equality but also static term/iri equality in a filter.

/**
 * Optimization transformation that detects and eliminates incompatible join branches.
 *
 * After query rewriting, a JOIN may contain UNION branches where different alternatives
 * bind variables to incompatible values. This transformation:
 *
 * 1. Analyzes variable bindings across JOIN operands
 * 2. Computes the intersection of possible values for each variable
 * 3. Replaces EXTEND operations with incompatible values with FILTER(FALSE)
 *
 * It reads each join operand's top-level `EXTEND` chain and its recursion halts at a `PROJECT`, so a bind
 * still inside a sub-SELECT is invisible to it. That is why the default pipeline runs it *after*
 * `removeProjections` and `pullUpExtends`, and why it is inert anywhere earlier.
 *
 * @example
 * // Given query: SELECT * { ?s ?p ?o . <ex://a> ?p ?o }
 * // With mappings: CONSTRUCT WHERE { <ex://a> <ex://a> ?o }
 * //                CONSTRUCT WHERE { <ex://b> <ex://b> ?o }
 * //
 * // The first pattern creates a UNION binding ?s to <ex://a> or <ex://b>
 * // The second pattern requires subject <ex://a>, constraining ?p
 * // Since ?p from the <ex://b> mapping (value <ex://b>) doesn't match
 * // the ?p from the second pattern (which works with <ex://a>),
 * // the <ex://b> branch is eliminated.
 *
 * @example
 * // With 3 mappings where the third has subject <ex://b>:
 * // CONSTRUCT WHERE { <ex://a> <ex://a> ?o }
 * // CONSTRUCT WHERE { <ex://a> <ex://b> ?o }
 * // CONSTRUCT WHERE { <ex://b> <ex://c> ?o }
 * //
 * // The third mapping would bind ?s = <ex://b>, but the second pattern
 * // in the query has subject <ex://a>. Since these are incompatible,
 * // only the first two mappings (both with ?s = <ex://a>) survive.
 *
 * @param c - The transformation context
 * @param op - The operation to transform
 * @returns The transformed operation with incompatible branches eliminated
 */
export function nullifyJoinOverIncompatibleBounds<T extends Algebra.Operation>(
  c: TransformationContext,
  op: T,
): T {
  return algebraUtils.mapOperation<'unsafe', typeof op>(
    op,
    { join: {
      transform: (join) => {
        // Find for each member of the join whether variables are bound to known terms
        const varSets = variableExtensionsOverJoin(join);

        // Iterate the extends and unions below: an extend binding a variable to a term no other operand
        // can bind it to is replaced by FILTER(FALSE), which then absorbs the whole join.
        restrictOperations(c, join, varSets);

        return join;
      },
    }},
  );
}

/**
 * Replaces every EXTEND of a JOIN operand whose term no operand can bind the variable to by FILTER(FALSE).
 * @param c - The transformation context
 * @param join - The JOIN to modify
 * @param varSets - Map of variable names to their possible values
 */
function restrictOperations(
  c: TransformationContext,
  join: Algebra.Join,
  varSets: Record<string, VariableSet>,
): void {
  const recurse = (op: Algebra.Operation): Algebra.Operation => {
    if (op.type === Algebra.Types.EXTEND) {
      if (op.expression.subType === Algebra.ExpressionTypes.TERM && varSets[op.variable.value] &&
        !varSets[op.variable.value].termIsCompatible(op.expression.term)) {
        return createFilterFalse(c, op);
      }
      op.input = recurse(op.input);
    } else if (op.type === Algebra.Types.UNION) {
      op.input = op.input.map(x => recurse(x));
    }
    // A PROJECT ends the descent: what it hides is out of scope here, which is why this pass wants
    // `removeProjections` to have run first.
    return op;
  };
  join.input = join.input.map(x => recurse(x));
}

function variableExtensionsOverJoin(join: Algebra.Join): Record<string, VariableSet> {
  const head = join.input[0];
  // Not knowing the variable makes it be noFixed, and that is identity of disjuntion
  const varSets: Record<string, VariableSet> = directExtensionOverUnionsAndMore(head);

  for (const op of join.input.slice(1)) {
    for (const [ var_, varSet ] of Object.entries(directExtensionOverUnionsAndMore(op))) {
      if (varSets[var_]) {
        varSets[var_] = varSets[var_].disjunct(varSet);
      } else {
        varSets[var_] = varSet;
      }
    }
  }

  return varSets;
}

function directExtensionOverUnionsAndMore(op: Algebra.Operation): Record<string, VariableSet> {
  const varSets: Record<string, VariableSet> = {};
  const traverse = (op: Algebra.Operation): void => {
    if (op.type === Algebra.Types.EXTEND) {
      if (op.expression.subType === Algebra.ExpressionTypes.TERM && termIsStaticTerm(op.expression.term)) {
        varSets[op.variable.value] = new VariableSet(op.expression.term);
      }
      traverse(op.input);
    } else if (op.type === Algebra.Types.UNION) {
      Object.assign(varSets, directExtensionOverUnions(op));
    }
  };

  traverse(op);
  return varSets;
}

function directExtensionOverUnions(union: Algebra.Union): Record<string, VariableSet> {
  const head = union.input[0];
  // Not knowing the variable makes it be noFixed, which is absorbing element under union
  const varSets: Record<string, VariableSet> = Object.fromEntries(Object.entries(directExtensions(head))
    .map(([ var_, term ]) => [ var_, new VariableSet((term)) ]));
  for (const op of union.input.slice(1)) {
    let trackedVars = Object.keys(varSets);
    for (const [ var_, term ] of Object.entries(directExtensions(op))) {
      // Register you saw this var
      trackedVars = trackedVars.filter(x => x !== var_);
      if (varSets[var_]) {
        varSets[var_] = varSets[var_].union(new VariableSet(term));
      } else {
        varSets[var_] = VariableSet.createNoFixed();
      }
    }
    // All vars not visited are noFixed:
    for (const var_ of trackedVars) {
      varSets[var_] = VariableSet.createNoFixed();
    }
  }
  return varSets;
}

/**
 * The pipeline step replacing a join whose branches bind one variable to incompatible terms by `FILTER(FALSE)`.
 * @returns the transformation
 */
export function nullifyJoinOverIncompatibleBoundsTransformation(): QueryTransformation {
  return nullifyJoinOverIncompatibleBounds;
}
