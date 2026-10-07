import type * as RDF from '@rdfjs/types';
import type { Algebra } from '@traqula/algebra-transformations-1-2';
import type { TransformationContext } from '../transformContext.js';
import type { Access } from './assertions.js';
import { componentOf } from './assertions.js';
import { cpMetaOf } from './certainlyBoundVars.js';
import { asksBoundOfVariable, constructedTermOf, containsExistenceExpression } from './expressionHelpers.js';
import { substituteInExpression } from './partialExpressionEvaluation.js';

/**
 * @fileoverview Writing what a `BIND(e AS ?x)` constructs into an expression reading `?x`, which is what lets
 * a bind and a reader of it swap places: the pull-up lifts a bind over its reader, the filter pushdown sinks
 * a condition below the bind it reads.
 *
 * Sound almost everywhere: where `e` raises, the original leaves `?x` unbound and the reader evaluates an
 * unbound variable - an error - where the substituted one raises the same error from `e` itself. The two
 * readers telling those apart, `bound(?x)` and an `EXISTS`, are what {@link readerAdmitsConstruction} rules
 * out.
 */

/** What a reader of a bind's variable needs to know of the bind to read its construction instead. */
export interface BindConstruction {
  /** The variable the bind writes. */
  variable: RDF.Variable;
  /**
   * The term the bind's expression constructs - a term expression, or a `TRIPLE()` over constructions -
   * and `undefined` for anything else.
   */
  constructedTerm: RDF.Term | undefined;
  /** Whether every solution of the EXTEND binds the variable, its construction never failing. */
  bindsCertainly: boolean;
}

/**
 * Reads what a reader of an EXTEND's variable needs to know of it.
 * @param extend - The EXTEND to read
 * @returns its construction
 */
export function bindConstructionOf(extend: Algebra.Extend): BindConstruction {
  return {
    variable: extend.variable,
    constructedTerm: constructedTermOf(extend.expression),
    bindsCertainly: cpMetaOf(extend).cVars.has(extend.variable.value),
  };
}

/**
 * Whether a reader of the bind's variable may read its construction instead. Only a construction is written
 * in, being free to evaluate again; nothing goes into an `EXISTS`, whose pattern takes no expression; and
 * `bound(?x)` only folds for a bind that cannot fail.
 * @param reader - An expression reading the bind's variable
 * @param bind - The bind to write in
 * @returns whether {@link substituteConstruction} may rewrite the reader
 */
export function readerAdmitsConstruction(reader: Algebra.Expression, bind: BindConstruction): boolean {
  return bind.constructedTerm !== undefined &&
    !containsExistenceExpression(reader) &&
    (bind.bindsCertainly || !asksBoundOfVariable(reader, bind.variable.value));
}

/**
 * Writes the bind's construction into a reader of its variable, folding what that decides.
 * @param c - The transformation context
 * @param reader - An expression {@link readerAdmitsConstruction} admits the bind into
 * @param bind - The bind to write in
 * @param cVars - What is certainly bound where the reader is evaluated, which decides `sameTerm(?x, ?x)`
 * @returns the rewritten reader
 */
export function substituteConstruction(
  c: TransformationContext,
  reader: Algebra.Expression,
  bind: BindConstruction,
  cVars: ReadonlySet<string>,
): Algebra.Expression {
  const term = bind.constructedTerm;
  if (term === undefined) {
    return reader;
  }
  const name = bind.variable.value;
  return substituteInExpression(c, reader, {
    resolve: access => access.name === name ? readThrough(term, access, bind) : undefined,
    bound: bind.bindsCertainly ? new Set([ name ]) : new Set<string>(),
  }, cVars);
}

/**
 * The term an access reads out of a construction: the term itself for a bare variable, a position of it for
 * an accessor chain such as `SUBJECT(?x)`.
 *
 * A position is only read off a construction that cannot fail. `SUBJECT(?x)` of an unbound `?x` is an
 * error where the component would be an ordinary value, so there the whole term is written in and the
 * accessor is left to raise on it.
 * @param term - The construction
 * @param access - The reading of it the expression asks for
 * @param bind - The bind constructing it
 * @returns the term read, or `undefined` when this access is not one to decide
 */
function readThrough(term: RDF.Term, access: Access, bind: BindConstruction): RDF.Term | undefined {
  if (access.positions.length === 0) {
    return term;
  }
  if (!bind.bindsCertainly) {
    return undefined;
  }
  let component: RDF.Term | undefined = term;
  for (const position of access.positions) {
    component = component === undefined ? undefined : componentOf(component, position);
  }
  return component;
}
