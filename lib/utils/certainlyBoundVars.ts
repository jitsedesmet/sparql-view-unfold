import type * as RDF from '@rdfjs/types';
import { ExpressionTypes, Types } from '@traqula/algebra-transformations-1-2';
import type { Algebra as A } from '@traqula/algebra-transformations-1-2';

// TODO: upstream this into TRAQULA

/**
 * Options controlling how {@link certainlyBoundVariables} decides whether a variable is certainly
 * bound.
 */
export interface BoundVariablesOptions {
  /**
   * When `true`, an EXTEND (BIND) is treated as binding its target variable, but only when the bound
   * expression is a plain term whose own variables are all certainly bound.
   *
   * This is sound: a constant term never raises an evaluation error, and a bare variable reference
   * never raises one either (it simply leaves the target unbound when its source is unbound).
   * Triple-term (quoted-triple) constructions are deliberately excluded: building one can raise an
   * evaluation error (e.g. a literal in the subject or predicate position is not a well-formed RDF
   * triple per SPARQL 1.2), so its target cannot be assumed to be bound. BINDs of arbitrary
   * (possibly erroring) expressions are always ignored.
   *
   * When `false` (the default), EXTEND is ignored entirely - matching the classic `safeVars`
   * definition of Schmidt et al. (https://arxiv.org/pdf/0812.3788, Definition 5), where a BIND may
   * raise an evaluation error and therefore leave its variable unbound.
   *
   * @defaultValue false
   */
  extendBinds?: boolean;
}

/**
 * Computes a sound under-approximation of the variables that are *certainly bound* (a.k.a. "must be
 * bound") after evaluating `op` on any dataset - i.e. the variables guaranteed to have a value in
 * every produced solution.
 *
 * This differs from {@link inScopeVariables}, which computes the (over-approximating) set of
 * *in-scope* variables that *may* be bound. Any variable that cannot be proven to be certainly
 * bound is left out, keeping the result a safe under-approximation. This is the notion required to
 * soundly push a FILTER onto a JOIN operand (SJPush of Schmidt et al.) or to rewrite a single-row
 * VALUES join into an equality FILTER.
 *
 * @param op - The operation whose certainly-bound variables are computed
 * @param options - Options tuning the approximation (see {@link BoundVariablesOptions})
 * @returns The set of certainly-bound variable names
 */
export function certainlyBoundVariables(op: A.Operation, options: BoundVariablesOptions = {}): Set<string> {
  switch (op.type) {
    case Types.BGP:
      return unionSets(op.patterns.map(pattern => patternVars(pattern)));
    case Types.PATTERN:
      return patternVars(op);
    case Types.PATH:
      return unionSets([ termVars(op.subject), termVars(op.object) ]);
    case Types.JOIN:
      return unionSets(op.input.map(input => certainlyBoundVariables(input, options)));
    case Types.UNION:
      return intersectSets(op.input.map(input => certainlyBoundVariables(input, options)));
    case Types.MINUS:
    case Types.LEFT_JOIN:
      // MINUS / OPTIONAL only certainly bind whatever their left-hand (required) side binds.
      return certainlyBoundVariables(op.input[0], options);
    case Types.PROJECT: {
      const projected = new Set(op.variables.map(variable => variable.value));
      return intersectSets([ certainlyBoundVariables(op.input, options), projected ]);
    }
    case Types.GROUP:
      return new Set(op.variables.map(variable => variable.value));
    case Types.VALUES:
      // A VALUES variable is certainly bound only if every row provides a value for it.
      return new Set(op.variables
        .filter(variable => op.bindings.every(binding => binding[variable.value] !== undefined))
        .map(variable => variable.value));
    case Types.EXTEND: {
      const inputBound = certainlyBoundVariables(op.input, options);
      if (options.extendBinds &&
                op.expression.subType === ExpressionTypes.TERM &&
                // A triple-term construction may raise an evaluation error, so it is not certainly bound.
                op.expression.term.termType !== 'Quad' &&
                isSubsetOf(termVars(op.expression.term), inputBound)) {
        inputBound.add(op.variable.value);
      }
      return inputBound;
    }
    case Types.GRAPH:
    case Types.FILTER:
    case Types.SERVICE:
    case Types.DISTINCT:
    case Types.REDUCED:
    case Types.SLICE:
    case Types.ORDER_BY:
    case Types.FROM:
      return certainlyBoundVariables((<A.Single> op).input, options);
    default:
      return new Set<string>();
  }
}

/**
 * Decides whether a single variable is *certainly bound* after evaluating `op`.
 *
 * @param op - The operation to inspect
 * @param variable - The variable (or its name) to test
 * @param options - Options tuning the approximation (see {@link BoundVariablesOptions})
 * @returns `true` when the variable is guaranteed to be bound in every produced solution
 */
export function isVariableCertainlyBound(
  op: A.Operation,
  variable: string | RDF.Variable,
  options: BoundVariablesOptions = {},
): boolean {
  const name = typeof variable === 'string' ? variable : variable.value;
  return certainlyBoundVariables(op, options).has(name);
}

/**
 * Collects the variables appearing in a single triple/quad pattern (including nested quoted triples).
 */
function patternVars(pattern: A.Pattern): Set<string> {
  return unionSets([
    termVars(pattern.subject),
    termVars(pattern.predicate),
    termVars(pattern.object),
    termVars(pattern.graph),
  ]);
}

/**
 * Collects the variables in an RDF term, recursing into quoted triples.
 */
function termVars(term: RDF.Term): Set<string> {
  if (term.termType === 'Variable') {
    return new Set([ term.value ]);
  }
  if (term.termType === 'Quad') {
    return unionSets([ termVars(term.subject), termVars(term.predicate), termVars(term.object) ]);
  }
  return new Set<string>();
}

/**
 * Tests whether every element of `subset` is contained in `superset`.
 */
function isSubsetOf(subset: Set<string>, superset: Set<string>): boolean {
  for (const value of subset) {
    if (!superset.has(value)) {
      return false;
    }
  }
  return true;
}

function unionSets(sets: Set<string>[]): Set<string> {
  const result = new Set<string>();
  for (const set of sets) {
    for (const value of set) {
      result.add(value);
    }
  }
  return result;
}

function intersectSets(sets: Set<string>[]): Set<string> {
  if (sets.length === 0) {
    return new Set<string>();
  }
  return sets.reduce((acc, set) => new Set([ ...acc ].filter(value => set.has(value))));
}
