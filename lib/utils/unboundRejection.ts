import { Algebra } from '@traqula/algebra-transformations-1-2';
import type { SSet } from './setUtils.js';
import { intersectSets, unionSets } from './setUtils.js';

/**
 * @fileoverview Which variables a condition needs bound to hold, read off how SPARQL propagates errors.
 *
 * Evaluating an unbound variable raises an error, and every function raises the error of an argument except
 * the few SPARQL 1.1 §17.2-§17.4 define otherwise. So a condition raising whenever `?x` is unbound is false
 * for a filter there, which is what lets a filter certify `?x` bound and turn an OPTIONAL into a JOIN.
 * The converse is only read off `!bound(?x)`.
 */

/** The operators that do not simply raise the error of an argument; every other operator is strict. */
const nonStrictOperators = new Set([ 'bound', 'if', 'coalesce', '||', '&&', 'in', 'notin' ]);

/**
 * The variables an expression raises an error for whenever they are unbound.
 * @param expression - The expression to read
 * @returns those variables; an extension function is opaque and contributes none
 */
function variablesRaisingWhenUnbound(expression: Algebra.Expression): SSet {
  if (expression.subType === Algebra.ExpressionTypes.TERM) {
    return expression.term.termType === 'Variable' ? new Set([ expression.term.value ]) : new Set();
  }
  if (expression.subType !== Algebra.ExpressionTypes.OPERATOR) {
    return new Set();
  }
  const { operator, args } = expression;
  if (!nonStrictOperators.has(operator)) {
    return unionSets(args.map(argument => variablesRaisingWhenUnbound(argument)));
  }
  switch (operator) {
    // `error || true` is true and `error && false` is false, so only an error on every side survives.
    case '||':
    case '&&':
    case 'coalesce':
      return intersectSets(args.map(argument => variablesRaisingWhenUnbound(argument)));
    case 'if':
      return unionSets([
        variablesRaisingWhenUnbound(args[0]),
        intersectSets(args.slice(1).map(argument => variablesRaisingWhenUnbound(argument))),
      ]);
    // `?x IN (a, b)` is `?x = a || ?x = b`: every disjunct raises on the left operand, and the empty list
    // raises nothing.
    case 'in':
    case 'notin':
      return args.length > 1 ? variablesRaisingWhenUnbound(args[0]) : new Set();
    default:
      return new Set();
  }
}

/**
 * The variables a condition cannot hold for while they are unbound: its effective boolean value is false or
 * an error there, so every solution a filter on it keeps binds them.
 * @param expression - The condition to read
 * @returns those variables
 * @example
 * // ?x and ?y: the comparison raises on an unbound ?x, and bound(?y) is false for an unbound ?y.
 * variablesRequiredBoundBy(parse('?x > 5 && bound(?y)'));
 */
export function variablesRequiredBoundBy(expression: Algebra.Expression): SSet {
  if (expression.subType !== Algebra.ExpressionTypes.OPERATOR) {
    return variablesRaisingWhenUnbound(expression);
  }
  const { operator, args } = expression;
  switch (operator) {
    case '&&':
      return unionSets(args.map(argument => variablesRequiredBoundBy(argument)));
    case '||':
      return intersectSets(args.map(argument => variablesRequiredBoundBy(argument)));
    case 'bound':
      return variablesRaisingWhenUnbound(args[0]);
    case 'if':
      return unionSets([
        variablesRaisingWhenUnbound(args[0]),
        intersectSets(args.slice(1).map(argument => variablesRequiredBoundBy(argument))),
      ]);
    // An empty list makes `IN` false whatever its left operand is.
    case 'in':
      return variablesRaisingWhenUnbound(args[0]);
    default:
      return variablesRaisingWhenUnbound(expression);
  }
}

/**
 * The variables a condition only holds for while they are unbound, read off its `!bound(?x)` conjuncts.
 * @param expression - The condition to read
 * @returns those variables
 */
export function variablesRequiredUnboundBy(expression: Algebra.Expression): SSet {
  if (expression.subType !== Algebra.ExpressionTypes.OPERATOR) {
    return new Set();
  }
  const { operator, args } = expression;
  if (operator === '&&') {
    return unionSets(args.map(argument => variablesRequiredUnboundBy(argument)));
  }
  const [ negated ] = args;
  if (operator === '!' && negated.subType === Algebra.ExpressionTypes.OPERATOR && negated.operator === 'bound') {
    return variablesRaisingWhenUnbound(negated.args[0]);
  }
  return new Set();
}
