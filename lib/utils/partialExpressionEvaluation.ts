import type * as RDF from '@rdfjs/types';
import { Algebra } from '@traqula/algebra-transformations-1-2';
import type { TriplePosition } from '../datastructures/TermClusterSet.js';
import { objectRange, predicateRange, subjectRange } from '../RangeSet.js';
import type { RangeSet } from '../RangeSet.js';
import type { TransformContext } from '../transformContext.js';
import type { Access } from './assertions.js';
import { asAccess, componentOf, isAssertableTerm, rangeOfTermType, asAssertableTermType } from './assertions.js';
import { booleanConstantOf, createBooleanExpression, isIriExpression } from './expressionHelpers.js';
import { DF } from './rdfDatatypes.js';
import { unionSets } from './setUtils.js';

/**
 * What an {@link utils/assertionConjunction!AssertionConjunction} decides about the expressions it is substituted into.
 *
 * A *view* rather than a map of terms, because a conjunction knows things no map can hold: `SUBJECT(?o)`
 * may be decided where `?o` is not, and `?o` may be known to be a triple term without any term for it being
 * known at all. It stays a view of *terms* though - an open shape may never be substituted into an
 * expression (S3), the positions nobody named having no variable to write.
 */
export interface AssertionView {
  /** The term the access is fixed to, or the variable that reads its value most directly. */
  resolve: (access: Access) => RDF.Term | undefined;
  /**
   * The term types left to the access, when the access is proven bound - `undefined` otherwise, and absent
   * altogether for a view that decides no kinds of term at all.
   *
   * Boundedness is what makes both directions of `isIRI(a)` foldable: it is `false` of a bound term of
   * another kind, but an *error* of an unbound one, and an error is not `false` in every context.
   */
  typeRange?: (access: Access) => RangeSet | undefined;
  /** The variables proven bound, which is what makes `bound(?x)` and `sameTerm(?x, ?x)` decidable. */
  bound: ReadonlySet<string>;
}

/**
 * Substitutes assertions (theta) into an expression and folds what becomes constant: `simplify(R[theta])`.
 *
 * Substitution is *not* uniform textual replacement: `BOUND` is the only SPARQL built-in whose grammar
 * takes a bare `Var` instead of an `Expression`, so `bound(?x)` becomes `true` rather than the
 * ungrammatical `BOUND(<ex://p>)`.
 * @param c - The transformation context
 * @param expression - The expression to substitute into
 * @param assertions - What the conjunction decides about it
 * @param cVars - The variables certainly bound where the expression is evaluated, which is the only thing
 * that decides `sameTerm(?x, ?x)`; the conjunction proves a few more of them by itself
 * @returns the substituted, folded expression
 */
export function substituteInExpression(
  c: TransformContext,
  expression: Algebra.Expression,
  assertions: AssertionView,
  cVars: ReadonlySet<string>,
): Algebra.Expression {
  return substitute(c, expression, assertions, unionSets([ cVars, assertions.bound ]));
}

/**
 * The recursive half of {@link substituteInExpression}, over an expression tree.
 * @param c - The transformation context
 * @param expression - The expression to substitute into
 * @param assertions - What the conjunction decides about it
 * @param boundVariables - The variables known to be bound here
 * @returns the substituted, folded expression
 */
function substitute(
  c: TransformContext,
  expression: Algebra.Expression,
  assertions: AssertionView,
  boundVariables: ReadonlySet<string>,
): Algebra.Expression {
  // Only the folds the pushdown depends on are done here, synchronously. Evaluating arbitrary static
  // operators (`1 + 2`, `CONCAT(...)`, ...) is handled separately by the asynchronous
  // {@link utils/staticExpressionEvaluation!simplifyStaticExpressions} pass, which hands them to the
  // Comunica Expression Evaluator.
  const { AF } = c;
  switch (expression.subType) {
    case Algebra.ExpressionTypes.TERM: {
      const assertedValue = substitutedTerm(expression.term, assertions);
      return assertedValue === undefined ? expression : AF.createTermExpression(assertedValue);
    }
    case Algebra.ExpressionTypes.OPERATOR: {
      // MANDATORY, not cosmetic: the grammar of BOUND takes a Var, so the term may not be substituted.
      if (expression.operator === 'bound' &&
        expression.args.length === 1 &&
        expression.args[0].subType === Algebra.ExpressionTypes.TERM &&
        expression.args[0].term.termType === 'Variable' &&
        assertions.bound.has(expression.args[0].term.value)) {
        return createBooleanExpression(c, true);
      }
      // An accessor chain is read *before* its argument is substituted into: `SUBJECT(?o)` may be decided
      // where `?o` is not, the shape of `?o` having a term in that position and none in the others. What
      // the chain reads is a term here, never an open shape (S3).
      const decided = decidedByAccess(c, expression, assertions);
      if (decided !== undefined) {
        return decided;
      }
      return constantFoldOperator(c, expression.operator, expression.args
        .map(arg => substitute(c, arg, assertions, boundVariables)), boundVariables);
    }
    case Algebra.ExpressionTypes.EXISTENCE:
      // TODO: work out how to propagate an assertion into the pattern of an EXISTS.
      return expression;
    case Algebra.ExpressionTypes.NAMED:
      return AF.createNamedExpression(
        expression.name,
        expression.args.map(arg => substitute(c, arg, assertions, boundVariables)),
      );
    case Algebra.ExpressionTypes.AGGREGATE:
      return {
        ...expression,
        expression: substitute(c, expression.expression, assertions, boundVariables),
      };
    default:
      return expression;
  }
}

/**
 * Substitutes theta into the term of a term expression, writing a triple term out one component at a time.
 *
 * No position is checked, deliberately: a component the position cannot hold makes the *construction*
 * raise, leaving its target unbound, which is exactly what the variable it replaces would have done. Only a
 * pattern refuses such a term outright ({@link substituteInTerm}), a pattern that cannot match being an
 * emptiness rather than an error.
 * @param term - The term to substitute into
 * @param assertions - What the conjunction decides about it
 * @returns the substituted term, or `undefined` where the conjunction decides nothing about it
 */
function substitutedTerm(term: RDF.Term, assertions: AssertionView): RDF.Term | undefined {
  if (term.termType === 'Variable') {
    return assertions.resolve({ name: term.value, positions: []});
  }
  if (term.termType !== 'Quad') {
    return undefined;
  }
  const subject = substitutedTerm(term.subject, assertions);
  const predicate = substitutedTerm(term.predicate, assertions);
  const object = substitutedTerm(term.object, assertions);
  const graph = substitutedTerm(term.graph, assertions);
  if (subject === undefined && predicate === undefined && object === undefined && graph === undefined) {
    return undefined;
  }
  return DF.quad(
    <RDF.Quad_Subject> (subject ?? term.subject),
    <RDF.Quad_Predicate> (predicate ?? term.predicate),
    <RDF.Quad_Object> (object ?? term.object),
    <RDF.Quad_Graph> (graph ?? term.graph),
  );
}

/**
 * Reads an accessor chain - `SUBJECT(?o)`, `OBJECT(SUBJECT(?o))` - or an `isTRIPLE` of one against what
 * theta decides, before its argument is substituted into.
 *
 * These folds are what make the pass **idempotent** (S7): the condition an assertion was read from is
 * written back over the operation it was pushed into, and unless it collapses to `true` there, a second run
 * reads it as a second assertion and stacks a second copy of the rewrite it caused.
 * @param c - The transformation context
 * @param expression - The expression to read
 * @param assertions - What the conjunction decides about it
 * @returns what it folds to, or `undefined` when the conjunction decides it not at all
 */
function decidedByAccess(
  c: TransformContext,
  expression: Algebra.OperatorExpression,
  assertions: AssertionView,
): Algebra.Expression | undefined {
  const termTypeAssertion = asAssertableTermType(expression.operator);
  if (termTypeAssertion !== undefined && expression.args.length === 1) {
    const access = asAccess(expression.args[0]);
    const rangeOfAccess = access === undefined ? undefined : assertions.typeRange?.(access);
    if (rangeOfAccess === undefined) {
      return undefined;
    }
    // `⊆` answers it `true`, an empty meet answers it `false`, and anything between leaves it standing.
    if (rangeOfAccess.size === rangeOfAccess.meet(rangeOfTermType(termTypeAssertion)).size) {
      return createBooleanExpression(c, true);
    }
    return rangeOfAccess.has(termTypeAssertion) ? undefined : createBooleanExpression(c, false);
  }
  const access = asAccess(expression);
  const decided = access === undefined ? undefined : assertions.resolve(access);
  return decided === undefined ? undefined : c.AF.createTermExpression(decided);
}

/**
 * The term an argument spells out, when it is a ground one.
 * @param expression - The expression to read
 * @returns the term, or `undefined` for anything else
 */
function exprAsGroundedTerm(expression: Algebra.Expression): RDF.Term | undefined {
  return expression.subType === Algebra.ExpressionTypes.TERM && isAssertableTerm(expression.term) ?
    expression.term :
    undefined;
}

/**
 * Constant-folds an operator expression whose arguments are (partly) constant.
 *
 * Only deterministic, side-effect free operators may be folded: `rand`, `uuid`, `struuid`, `bnode` and
 * `now` must survive to evaluation, and anything not listed is rebuilt unchanged. Only the folds sound
 * under SPARQL's error handling are applied - notably `=` folds to `true` for two identical terms but never
 * to `false`, comparing unsupported datatypes raising an error, and an error is not `false` in every
 * context (`COALESCE(Error, false, true) == false`).
 * @param c - The transformation context
 * @param operator - The operator to fold
 * @param args - Its arguments, already substituted into
 * @param boundVariables - The variables known to be bound here, which is the only thing that makes
 * `sameTerm(?x, ?x)` decidable: it is `true` of a bound `?x` and an *error* of an unbound one
 * @returns the folded expression, or the operator rebuilt over its arguments
 */
export function constantFoldOperator(
  c: TransformContext,
  operator: string,
  args: Algebra.Expression[],
  boundVariables: ReadonlySet<string> = new Set(),
): Algebra.Expression {
  const constants = args.map(arg => booleanConstantOf(arg));
  switch (operator) {
    case 'subject':
    case 'predicate':
    case 'object': {
      // A position of a triple term written out: `SUBJECT(<<( :a :b :c )>>)` is `:a`. Of anything else it
      // is an error, which is `false` in a FILTER and has no term to fold to, so it is left standing.
      const groundedTerm = args.length === 1 ? exprAsGroundedTerm(args[0]) : undefined;
      const component = groundedTerm === undefined ?
        undefined :
        componentOf(groundedTerm, <TriplePosition> operator);
      if (component !== undefined) {
        return c.AF.createTermExpression(component);
      }
      break;
    }
    case 'isiri':
    case 'isuri':
    case 'isblank':
    case 'isliteral':
    case 'istriple': {
      // Decidable of any ground term, and of a ground term only: these answer `false` rather than
      // erroring, so both directions fold.
      const groundedTerm = args.length === 1 ? exprAsGroundedTerm(args[0]) : undefined;
      if (groundedTerm !== undefined) {
        return createBooleanExpression(c, groundedTerm.termType === asAssertableTermType(operator));
      }
      break;
    }
    case 'triple': {
      // A construction of three ground terms *is* the triple term, unless no triple term can hold them -
      // and then it raises, which leaves the target of a BIND unbound and a FILTER false, neither of
      // which a term folds to.
      const groundedTerms = args.length === 3 ? args.map(arg => exprAsGroundedTerm(arg)) : [];
      const ranges = [ subjectRange, predicateRange, objectRange ];
      if (groundedTerms.length === 3 && groundedTerms.every((term, index) => term !== undefined &&
        ranges[index].has(term.termType))) {
        return c.AF.createTermExpression(DF.quad(
          <RDF.Quad_Subject> groundedTerms[0]!,
          <RDF.Quad_Predicate> groundedTerms[1]!,
          <RDF.Quad_Object> groundedTerms[2]!,
        ));
      }
      break;
    }
    case 'sameterm': {
      // Evaluate sameTerm if LHS and RHS are static terms
      const [ left, right ] = args;
      if (args.length === 2 &&
                left.subType === Algebra.ExpressionTypes.TERM && isAssertableTerm(left.term) &&
                right.subType === Algebra.ExpressionTypes.TERM && isAssertableTerm(right.term)) {
        return createBooleanExpression(c, left.term.equals(right.term));
      }
      // The residual a unification leaves behind: substituting `?s ↦ ?o` turns `sameTerm(?s, ?o)` into
      // `sameTerm(?o, ?o)`. Only decidable for a variable certainly bound here - an unbound `?a` makes
      // `sameTerm(?a, ?a)` an error rather than `true`.
      if (args.length === 2 &&
                left.subType === Algebra.ExpressionTypes.TERM && left.term.termType === 'Variable' &&
                right.subType === Algebra.ExpressionTypes.TERM && right.term.equals(left.term) &&
                boundVariables.has(left.term.value)) {
        return createBooleanExpression(c, true);
      }
      break;
    }
    case '=': {
      if (args.length !== 2) {
        break;
      }
      const [ left, right ] = args;
      // `=` is, worst case RDFterm-equal/ sameValue -- which raises a type error when *both* of its arguments
      // are literals, and of different types. But, for IRIs, if not sameTerm, then false.
      if (isIriExpression(left) || isIriExpression(right)) {
        return constantFoldOperator(c, 'sameterm', args, boundVariables);
      }
      // Everywhere else only the *positive* answer of `sameTerm` carries over: identical terms are
      // equal, but distinct ones may be equal by value, or raise the type error `sameTerm` never does.
      const identical = constantFoldOperator(c, 'sameterm', args, boundVariables);
      if (booleanConstantOf(identical) === true) {
        return identical;
      }
      break;
    }
    case '!':
      if (args.length === 1 && constants[0] !== undefined) {
        return createBooleanExpression(c, !constants[0]);
      }
      break;
    case '&&':
      // `false && error` is false, and `true && X` is X (an erroring X keeps erroring),
      // so both the absorbing and the neutral element may be folded away.
      if (constants.includes(false)) {
        return createBooleanExpression(c, false);
      }
      return neutralFold(c, args, constants, true);
    case '||':
      // Mirrors `&&`: `true || error` is true, and `false || X` is X.
      if (constants.includes(true)) {
        return createBooleanExpression(c, true);
      }
      return neutralFold(c, args, constants, false);
    default:
      break;
  }
  return c.AF.createOperatorExpression(operator, args);
}

/**
 * Drops the arguments of an `&&` / `||` that are its neutral element.
 * @param c - The transformation context
 * @param args - The arguments of the operator
 * @param constants - The boolean each argument folds to, `undefined` where it folds to none
 * @param neutral - The neutral element: `true` for `&&`, `false` for `||`
 * @returns the operator over what is left, or that single argument, or the neutral element itself
 */
function neutralFold(
  c: TransformContext,
  args: Algebra.Expression[],
  constants: (boolean | undefined)[],
  neutral: boolean,
): Algebra.Expression {
  const remaining = args.filter((_, index) => constants[index] !== neutral);
  if (remaining.length === 0) {
    // Under `&&` you removed all 'true', non left -> true
    // under '||' you removed all 'false', non left -> false.
    return createBooleanExpression(c, neutral);
  }
  if (remaining.length === 1) {
    return remaining[0];
  }
  return c.AF.createOperatorExpression(neutral ? '&&' : '||', remaining);
}
