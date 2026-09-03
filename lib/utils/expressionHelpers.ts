import type * as RDF from '@rdfjs/types';
import { Algebra, algebraUtils } from '@traqula/algebra-transformations-1-2';
import { EXTENSION_FUNCTION_BNODE } from '../consts.js';
import { objectRange, predicateRange, subjectRange } from '../RangeSet.js';
import type { TransformContext } from '../transformContext.js';
import { termFalse, termTrue } from './operationhelpers.js';
import { DF } from './rdfDatatypes.js';

/**
 * Splits a filter expression on top level logical conjunctions (`&&`), implementing (SDecompI):
 * `FILTER_{R1 && R2}(A) == FILTER_R1(FILTER_R2(A))`.
 * @param expression - The condition to split
 * @param accumulator - The conjuncts collected so far, filled in by the recursion
 * @returns the conjuncts
 */
export function splitConjunction(
  expression: Algebra.Expression,
  accumulator: Algebra.Expression[] = [],
): Algebra.Expression[] {
  if (expression.subType === Algebra.ExpressionTypes.OPERATOR && expression.operator === '&&') {
    for (const agg of expression.args) {
      splitConjunction(agg, accumulator);
    }
  } else {
    accumulator.push(expression);
  }
  return accumulator;
}

/**
 * Combines a non-empty list of expressions into a single conjunction (`&&`).
 * @param c - The transformation context
 * @param expressions - The conjuncts to combine
 * @returns the conjunction
 */
export function conjunctionOf(c: TransformContext, expressions: Algebra.Expression[]): Algebra.Expression {
  return expressions.reduce((acc, expr) => c.AF.createOperatorExpression('&&', [ acc, expr ]));
}

/**
 * The boolean an expression is the constant for.
 * @param expression - The expression to read
 * @returns the boolean, or `undefined` when it is not a boolean constant
 */
export function booleanConstantOf(expression: Algebra.Expression): boolean | undefined {
  if (expression.subType !== Algebra.ExpressionTypes.TERM) {
    return undefined;
  }
  if (expression.term.equals(termTrue)) {
    return true;
  }
  return expression.term.equals(termFalse) ? false : undefined;
}

/**
 * Creates the constant `true` or `false` expression, as an `xsd:boolean` term.
 * @param c - The transformation context
 * @param value - The boolean to write
 * @returns the term expression
 */
export function createBooleanExpression(c: TransformContext, value: boolean): Algebra.Expression {
  return c.AF.createTermExpression(value ? termTrue : termFalse);
}

/**
 * The operators whose value is not a function of the solution mapping they are evaluated on, so that two
 * evaluations of one expression may disagree. `NOW` is deliberately absent - "all calls to [it] in any one
 * query execution must return the same value" (SPARQL 1.1 §17.4.5.1) - where `BNODE` is present because
 * §17.4.2.14 fixes a blank node per solution mapping *and* argument.
 */
const unstableOperators = new Set([ 'bnode', 'rand', 'uuid', 'struuid' ]);

/**
 * The extension functions declared stable, which is what lets a `BIND` over one of them move.
 * `EXTENSION_FUNCTION_BNODE` is the internal form of the README's `bnodeConsistent`, whose "same inputs =
 * same identity" is stability spelled out; every other `named` expression is opaque and so unstable.
 */
const stableNamedFunctions = new Set<string>([ EXTENSION_FUNCTION_BNODE ]);

/**
 * Whether an expression is a pure function of the variables it reads: asked twice about the same values, it
 * gives the same answer. Strictly weaker than "the same value in every solution", which is
 * `isStableExpression(c, e) && collectVariableNames(c.astTransformer, e).size === 0`.
 * @param c - The transformation context
 * @param expression - The expression to check
 * @returns whether it is stable
 */
export function isStableExpression(c: TransformContext, expression: Algebra.Expression): boolean {
  let isStable = true;
  const neverStable = { preVisitor: () => {
    isStable = false;
    return { shortcut: true };
  } };
  algebraUtils.visitOperationSub(expression, {}, { expression: {
    operator: { preVisitor: (operator) => {
      if (unstableOperators.has(operator.operator)) {
        isStable = false;
        return { shortcut: true };
      }
      return {};
    } },
    named: { preVisitor: (named) => {
      if (!stableNamedFunctions.has(named.name.value)) {
        isStable = false;
        return { shortcut: true };
      }
      return {};
    } },
    // An EXISTS is stable per solution, but it reads `vars(P)` of a nested pattern rather than anything
    // visible in the expression tree, and it is evaluated against the active graph. Nothing holding one
    // moves until that is worked out - the pushdown carries the same TODO.
    // TODO(phase 4): give EXISTENCE a reads-set and let it be stable where the active graph does not change.
    existence: neverStable,
    // Neither can occur in a BIND, and neither is a function of one solution mapping.
    aggregate: neverStable,
    wildcard: neverStable,
  }});
  return isStable;
}

/**
 * Whether two expressions are the same expression, structurally, which the algebra ships no helper for -
 * `Canonicalizer` only renames blank nodes. An `existence` is never equal to anything.
 * @param left - One expression
 * @param right - The other
 * @returns whether they are structurally equal
 */
export function expressionsEqual(left: Algebra.Expression, right: Algebra.Expression): boolean {
  // A question about the expression itself rather than about what it evaluates to, which is what the merge
  // and UNION rules of the pull-up ask ("every branch carries *this* bind"). Generate-and-compare would
  // answer a different one, two expressions printing the same being neither necessary nor sufficient for
  // the trees to agree. And a nested pattern is deliberately not walked into: comparing there would mean
  // operation equality, a bigger promise than any caller needs.
  if (left.subType !== right.subType) {
    return false;
  }
  switch (left.subType) {
    case Algebra.ExpressionTypes.TERM:
      return left.term.equals((<Algebra.TermExpression> right).term);
    case Algebra.ExpressionTypes.OPERATOR: {
      const other = <Algebra.OperatorExpression> right;
      return left.operator === other.operator && argumentsEqual(left.args, other.args);
    }
    case Algebra.ExpressionTypes.NAMED: {
      const other = <Algebra.NamedExpression> right;
      return left.name.equals(other.name) && argumentsEqual(left.args, other.args);
    }
    case Algebra.ExpressionTypes.AGGREGATE: {
      const other = <Algebra.AggregateExpression> right;
      return left.aggregator === other.aggregator && left.distinct === other.distinct &&
        left.separator === other.separator && expressionsEqual(left.expression, other.expression);
    }
    case Algebra.ExpressionTypes.WILDCARD:
      return true;
    case Algebra.ExpressionTypes.EXISTENCE:
      return false;
  }
}

/**
 * Whether two argument lists hold the same expressions, pairwise and in order.
 * @param left - One argument list
 * @param right - The other
 * @returns whether they are equal
 */
function argumentsEqual(left: readonly Algebra.Expression[], right: readonly Algebra.Expression[]): boolean {
  return left.length === right.length && left.every((arg, index) => expressionsEqual(arg, right[index]));
}

/**
 * Whether an expression holds an `EXISTS` or a `NOT EXISTS` anywhere inside it, which is the one
 * sub-expression nothing may be substituted into.
 * @param expression - The expression to read
 * @returns whether it holds one
 */
export function containsExistenceExpression(expression: Algebra.Expression): boolean {
  let found = false;
  algebraUtils.visitOperationSub(expression, {}, { expression: { existence: { preVisitor: () => {
    found = true;
    return { shortcut: true };
  } }}});
  return found;
}

/**
 * Whether an expression asks `bound(?name)` anywhere inside it. `BOUND` is the only built-in whose grammar
 * takes a bare `Var`, so it is the one reader a term may not be written into: `bound(<ex://a>)` is not a
 * query.
 * @param expression - The expression to read
 * @param name - The variable to look for
 * @returns whether it is asked about
 */
export function asksBoundOfVariable(expression: Algebra.Expression, name: string): boolean {
  let found = false;
  algebraUtils.visitOperationSub(expression, {}, { expression: {
    operator: { preVisitor: (operator) => {
      if (operator.operator === 'bound' && operator.args.some(argument =>
        argument.subType === Algebra.ExpressionTypes.TERM &&
        argument.term.termType === 'Variable' &&
        argument.term.value === name)) {
        found = true;
      }
      return {};
    } },
  }});
  return found;
}

/** The term types each position of a triple term admits, in the order `TRIPLE()` takes its arguments. */
const triplePositionRanges = [ subjectRange, predicateRange, objectRange ];

/**
 * The term an expression *constructs*, which is one thing spelled two ways: a term expression is a
 * construction of itself, and so is `TRIPLE(s, p, o)` over three term arguments, which the parser keeps
 * distinct from the `<<( s p o )>>` it means.
 * @param expression - The expression to read
 * @returns the term it constructs, or `undefined` when it constructs none
 */
export function constructedTermOf(expression: Algebra.Expression): RDF.Term | undefined {
  if (expression.subType === Algebra.ExpressionTypes.TERM) {
    return expression.term;
  }
  // `constantFoldOperator` already folds a `TRIPLE()` of three *ground* terms into the term it is; this is
  // the same fold with variables left in, which is what makes the two spellings interchangeable for a
  // rewrite that moves or writes in the construction rather than evaluating it.
  if (expression.subType === Algebra.ExpressionTypes.OPERATOR && expression.operator === 'triple' &&
    expression.args.length === 3) {
    const components = expression.args.map(argument =>
      argument.subType === Algebra.ExpressionTypes.TERM ? argument.term : undefined);
    // A ground component the position cannot hold makes the construction *raise*, and no `<<( … )>>` spells
    // that - so it stays a `TRIPLE()` rather than becoming a triple term no generator could print. A
    // variable is left to the ranges, which is where {@link certainlyBoundVars!withCpVars} decides it.
    if (components.some((component, index) => component === undefined ||
        (component.termType !== 'Variable' && !triplePositionRanges[index].has(component.termType)))) {
      // Needed for valid grammar
      return undefined;
    }
    return DF.quad(
        <RDF.Quad_Subject> components[0],
        <RDF.Quad_Predicate> components[1],
        <RDF.Quad_Object> components[2],
    );
  }
  return undefined;
}

/**
 * Whether an expression is an IRI spelled out as a term.
 * @param expression - The expression to check
 * @returns whether it is a term expression holding a NamedNode
 */
export function isIriExpression(expression: Algebra.Expression):
    expression is Algebra.Expression & { term: { termType: 'NamedNode' }} {
  return expression.subType === Algebra.ExpressionTypes.TERM && expression.term.termType === 'NamedNode';
}

/**
 * Creates `sameTerm(expression, term)`.
 * @param c - The transformation context
 * @param expression - One side of the equality
 * @param term - The other
 * @returns the condition
 */
export function sameTermExpression(
  c: TransformContext,
  expression: Algebra.Expression,
  term: RDF.Term,
): Algebra.Expression {
  return c.AF.createOperatorExpression('sameterm', [ expression, c.AF.createTermExpression(term) ]);
}
