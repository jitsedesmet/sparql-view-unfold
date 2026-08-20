import { Algebra } from '@traqula/algebra-transformations-1-2';
import type { TransformContext } from '../transformContext.js';
import type { Assertions } from './assertions.js';
import { isAssertableTerm } from './assertions.js';
import { booleanConstantOf, createBooleanExpression, isIriExpression } from './expressionHelpers.js';
import { unionSets } from './setUtils.js';

/**
 * Substitutes assertions (θ) into an expression and folds what becomes constant: `simplify(R[θ])`.
 *
 * Substitution is *not* uniform textual replacement. `BOUND` is the only SPARQL built-in whose grammar
 * takes a bare `Var` instead of an `Expression`, so replacing the variable by a term would produce the
 * ungrammatical `BOUND(<ex://p>)` once the plan is serialised back to SPARQL. Since an assertion implies
 * the variable is bound, `bound(?x)` becomes `true` instead.
 *
 * `cVars` are the variables certainly bound where the expression is evaluated - the ones of the operation
 * it sits on. They are the only thing that decides `sameTerm(?x, ?x)`, and the substitution proves a few
 * more of them by itself ({@link cVarsExtensionFromAssertions}).
 */
export function substituteInExpression(
  c: TransformContext,
  expression: Algebra.Expression,
  assertions: Assertions,
  cVars: ReadonlySet<string>,
): Algebra.Expression {
  return substitute(c, expression, assertions, unionSets([ cVars, cVarsExtensionFromAssertions(assertions) ]));
}

/**
 * The variables the substitution proves bound on its own, whatever the operation below it binds: both ends
 * of every replacement it makes.
 *
 * Only a strong assertion substitutes, so the variable being replaced is certainly bound wherever the
 * substitution applies; and so is the variable it is replaced *by* - the representative of a clique, of
 * which membership implies `bnd(?x)`. The latter is what lets the residual `sameTerm(?o, ?o)` a
 * unification leaves behind fold away.
 */
function cVarsExtensionFromAssertions(assertions: Assertions): Set<string> {
  const result = new Set<string>();
  for (const [ key, term ] of assertions.entries()) {
    result.add(key);
    if (term.termType === 'Variable') {
      result.add(term.value);
    }
  }
  return result;
}

function substitute(
  c: TransformContext,
  expression: Algebra.Expression,
  assertions: Assertions,
  boundVariables: ReadonlySet<string>,
): Algebra.Expression {
  // TODO(other PR):
  //  part of future works includes evaluating the functions statically using the Comunica Expression Evaluator
  const { AF } = c;
  switch (expression.subType) {
    case Algebra.ExpressionTypes.TERM: {
      const term = expression.term;
      const assertedValue = term.termType === 'Variable' ? assertions.get(term.value) : undefined;
      return assertedValue === undefined ? expression : AF.createTermExpression(assertedValue);
    }
    case Algebra.ExpressionTypes.OPERATOR: {
      // MANDATORY, not cosmetic: the grammar of BOUND takes a Var, so the term may not be substituted.
      if (expression.operator === 'bound' &&
        expression.args.length === 1 &&
        expression.args[0].subType === Algebra.ExpressionTypes.TERM &&
        expression.args[0].term.termType === 'Variable' &&
        assertions.has(expression.args[0].term.value)) {
        return createBooleanExpression(c, true);
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
 * Constant-folds an operator expression whose arguments are (partly) constant.
 *
 * Only deterministic, side-effect free operators may be folded: `rand`, `uuid`, `struuid`, `bnode` and
 * `now` must survive to evaluation, and anything not listed below is rebuilt unchanged.
 *
 * Only the folds sound under SPARQL's error handling are applied. Notably `=` folds to `true` for two
 * identical terms - RDF term equality is the fallback for unsupported datatypes - but never to `false`,
 * since comparing unsupported datatypes raises an error, and an error is not `false` in every context:
 * `COALESCE(Error, false, true) ≡ false`.
 *
 * `boundVariables` are the variables known to be bound here, which is the only thing that makes
 * `sameTerm(?x, ?x)` decidable: it is `true` of a bound `?x` and an *error* of an unbound one. Where `?x`
 * is not known to be bound there is nothing to rewrite it into either, since no expression has that
 * true-or-error semantics: `bound(?x)` answers `false` where `sameTerm(?x, ?x)` errors, and the two are
 * told apart by `COALESCE`.
 */
export function constantFoldOperator(
  c: TransformContext,
  operator: string,
  args: Algebra.Expression[],
  boundVariables: ReadonlySet<string> = new Set(),
): Algebra.Expression {
  const constants = args.map(arg => booleanConstantOf(arg));
  switch (operator) {
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
 * Drops the arguments of an `&&` / `||` that are its neutral element,
 * keeping the operator only when more than one argument is left.
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
