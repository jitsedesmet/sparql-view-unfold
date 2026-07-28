import type * as RDF from '@rdfjs/types';
import { Algebra, algebraUtils } from '@traqula/algebra-transformations-1-2';
import type { TransformContext } from '../transformContext.js';
import { certainlyBoundVariables } from '../utils/certainlyBoundVars.js';
import { createFilterFalse } from '../utils/operationhelpers.js';
import { unionSets } from '../utils/setUtils.js';

/**
 * Optimization transformation that rewrites a JOIN with a VALUES clause into an
 * equality FILTER over the remaining join operands.
 *
 * ```
 * JOIN(A, VALUES(?a ?b){ (t_a t_b) })  ==  FILTER(?a = t_a && ?b = t_b, A)
 * ```
 *
 * A VALUES clause assigns a variable a *constant* value when that variable holds the same term in
 * every binding row (a single-row VALUES is the special case where every column is constant).
 * Such a constant acts as a filter in case it is JOINED with operation A that ALWAYS BINDS that
 * variable. In case the var is potentially undefined, it instead binds the var to a default value.
 * Only the constant columns are extracted; any remaining columns are kept as a residual VALUES so
 * the row multiset (and thus cardinality) is preserved.
 *
 * When two joined VALUES clauses force the same variable to two different constants the join can
 * never produce a result, so it collapses to an empty result (`FILTER(FALSE)`).
 *
 * This rewrite is weak on its own, but combines strongly with {@link pushDownRestrictors}:
 * the freshly introduced equality conjuncts can be distributed over
 * unions and pushed down next to the operands that produce the variables,
 * exposing contradictions that {@link transformFilterFalse} and {@link nullifyJoinOverIncompatibleBounds} can prune.
 *
 * @param c - The transformation context
 * @param op - The operation to transform
 * @returns The transformed operation with constant VALUES joins rewritten to FILTERs
 */
export function transformJoinValuesToFilter<T extends Algebra.Operation>(c: TransformContext, op: T): T {
  return algebraUtils.mapOperation<'unsafe', typeof op>(op, {
    [Algebra.Types.JOIN]: {
      transform: join => convertJoinValues(c, join),
    },
  });
}

/**
 * Collects the variables that a VALUES clause fixes to a constant term.
 *
 * A variable is constant when it is defined (not UNDEF) in every binding row and holds the same
 * term in all of them. This generalizes the single-row case: a single-row VALUES has every one of
 * its variables constant, while a multi-row VALUES only fixes the columns that never vary.
 *
 * @param valuesOp - The VALUES clause to inspect
 * @returns A map from constant variable name to its fixed term
 */
function constantAssignments(valuesOp: Algebra.Values): Map<string, RDF.Literal | RDF.NamedNode> {
  const constants = new Map<string, RDF.Literal | RDF.NamedNode>();
  for (const variable of valuesOp.variables) {
    let fixed: RDF.Literal | RDF.NamedNode | undefined;
    let isConstant = true;
    for (const row of valuesOp.bindings) {
      const term = row[variable.value];
      // A missing key is UNDEF: the variable is not fixed to a single term across all rows.
      if (term === undefined || (fixed !== undefined && !fixed.equals(term))) {
        isConstant = false;
        break;
      }
      fixed = term;
    }
    if (isConstant && fixed !== undefined) {
      constants.set(variable.value, fixed);
    }
  }
  return constants;
}

/**
 * Rewrites the constant VALUES operands of a JOIN into an equality FILTER over the join.
 * @param c - The transformation context
 * @param join - The JOIN operation to rewrite
 * @returns A FILTER over the (reduced) JOIN when a conversion happened, `FILTER(FALSE)` when the
 *   joined VALUES clauses contradict each other, otherwise the original JOIN
 */
function convertJoinValues(c: TransformContext, join: Algebra.Join): Algebra.Operation {
  const { AF } = c;

  const candidates: Algebra.Values[] = [];
  const nonCandidates: Algebra.Operation[] = [];
  for (const op of join.input) {
    (op.type === Algebra.Types.VALUES ? candidates : nonCandidates).push(op);
  }

  if (candidates.length === 0) {
    return join;
  }

  const candidateConstants = candidates.map(valuesOp => constantAssignments(valuesOp));

  // Two VALUES clauses that pin the same variable to different constants can never agree,
  // so the whole join is empty. Detect this before rewriting anything.
  const forcedConstants = new Map<string, RDF.Literal | RDF.NamedNode>();
  for (const constants of candidateConstants) {
    for (const [ variable, term ] of constants) {
      const existing = forcedConstants.get(variable);
      if (existing !== undefined && !existing.equals(term)) {
        return createFilterFalse(c);
      }
      forcedConstants.set(variable, term);
    }
  }

  // Only operands that stay in the join can guarantee a variable is bound.
  // Other VALUES clauses are themselves being converted, so they may no longer bind anything.
  // Mapping BINDs are trusted to bind (extendBinds), matching how the rewriting pipeline produces these joins.
  const varsBoundedByRemainingJoin = unionSets(nonCandidates.map(operand =>
    certainlyBoundVariables(operand, { extendBinds: true })));

  const equalities: Algebra.Expression[] = [];
  const keptOperands: Algebra.Operation[] = [ ...nonCandidates ];

  for (const [ index, valuesOp ] of candidates.entries()) {
    const constants = candidateConstants[index];
    const localEqualities: Algebra.Expression[] = [];
    const keptVariables: RDF.Variable[] = [];
    for (const variable of valuesOp.variables) {
      const term = constants.get(variable.value);
      // Extract a constant column only when the remaining operands guarantee the variable is bound;
      // everything else (non-constant or not-certainly-bound columns) stays in a residual VALUES.
      if (term !== undefined && varsBoundedByRemainingJoin.has(variable.value)) {
        localEqualities.push(AF.createOperatorExpression('sameTerm', [
          AF.createTermExpression(variable),
          AF.createTermExpression(term),
        ]));
      } else {
        keptVariables.push(variable);
      }
    }

    // A multi-row VALUES whose every column would be extracted still multiplies cardinality through
    // its (necessarily identical) rows, so leave it untouched instead of silently dropping those rows.
    if (keptVariables.length === 0 && valuesOp.bindings.length > 1) {
      keptOperands.push(valuesOp);
      continue;
    }

    equalities.push(...localEqualities);
    // Keep a residual VALUES for the columns that were not extracted, preserving every row.
    if (keptVariables.length > 0) {
      keptOperands.push(AF.createValues(
        keptVariables,
        valuesOp.bindings.map(row => Object.fromEntries(keptVariables
          .filter(variable => row[variable.value] !== undefined)
          .map(variable => [ variable.value, row[variable.value] ]))),
      ));
    }
  }

  if (equalities.length === 0) {
    return join;
  }

  const newInput = AF.createJoin(keptOperands, true);
  const condition = equalities.reduce((acc, expr) => AF.createOperatorExpression('&&', [ acc, expr ]));
  return AF.createFilter(newInput, condition);
}
