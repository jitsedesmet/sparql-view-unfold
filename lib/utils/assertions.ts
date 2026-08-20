import type * as RDF from '@rdfjs/types';
import { Algebra } from '@traqula/algebra-transformations-1-2';
import type { TransformContext } from '../transformContext.js';
import { termVars } from './certainlyBoundVars.js';
import { sameTermExpression } from './expressionHelpers.js';
import { DF } from './rdfDatatypes.js';

/**
 * @fileoverview The assertion (`FILTER(sameTerm(?x, c))`) toolbox: recognizing the assertions a filter
 * condition carries, building them, and substituting them into expressions and patterns.
 *
 * A condition is read for all of the forms at once, into the single {@link AssertionConjunction} the
 * pushdown moves around.
 */

/**
 * A set of assertions θ: variable name to the single term it is fixed to, i.e. `σ_{sameTerm(?x, c)}`.
 *
 * This is the *substitutable* form - the map every `substituteIn...` helper takes - which is why the
 * weak, unbound and bound assertions of an {@link AssertionConjunction} are kept out of it, see
 * {@link AssertionConjunction.strongSubstitution}. The term may be a *variable*: that is what a
 * unification substitutes, replacing every member of a clique by the representative of it.
 */
export type Assertions = ReadonlyMap<string, RDF.Term>;

/**
 * One assertion about one variable, in one of the four forms this pass moves around.
 *
 * - `strong` is A⟨?x ≡ c⟩ ≔ `sameTerm(?x, c)`, which implies `bound(?x)`. Its term may be a variable, in
 *   which case it is A⟨?x ≡ ?y⟩ - one edge of the clique an {@link AssertionConjunction} holds.
 * - `weak` is W⟨?x ≡ c⟩ ≔ `!bound(?x) || sameTerm(?x, c)`, which does not - it is what survives a move
 *   into a place that may leave the variable unbound (the RHS of a MINUS, the unlicensed operand of a join).
 * - `unbound` is U⟨?x⟩ ≔ `!bound(?x)`.
 * - `bound` is B⟨?x⟩ ≔ `bound(?x)`, which fixes the variable to no term at all.
 *
 * The third form is what the conjunction of two *different* weak assertions about one variable comes to:
 * `(¬b ∨ ?x ≡ c) ∧ (¬b ∨ ?x ≡ d)` distributes to `¬b ∨ (?x ≡ c ∧ ?x ≡ d)`, which for `c ≠ d` is `¬b`.
 * Without it {@link mergeAssertion} would have nowhere to put that fact - it has no term - and would have
 * to leave the conjunct behind as a residual. It is also SPARQL's negation idiom
 * (`OPTIONAL { … } FILTER(!bound(?x))`), so it is the form assertions most often *start* in.
 *
 * The fourth is the negation of the third, and the term-less half of the strong form: it says only that
 * the variable *is* bound, which is what SPARQL writes as `FILTER(bound(?x))`. It carries no term, so it
 * never substitutes into anything, but it decides the same emptiness rule the strong form does
 * ((FBndII): `?x ∉ pVars(A) ⟹ σ_{bound(?x)}(A) ≡ ∅`) and it *completes* a weak assertion into a strong
 * one - `b ∧ (¬b ∨ ?x ≡ c) ≡ ?x ≡ c` - which is where it earns its keep.
 *
 * Only the strong form may be substituted into a pattern: `weak` and `unbound` say what the variable is
 * *not* bound to rather than that it is bound, and `bound` says nothing about which term it is.
 */
interface BaseAssertion {
  type: 'assertion';
  subType: string;
}
export interface StrongAssertion<T extends RDF.Term = RDF.Term> extends BaseAssertion {
  subType: 'strong';
  term: T;
}
export interface WeakAssertion<T extends RDF.Term = RDF.Term> extends BaseAssertion {
  subType: 'weak';
  term: T;
}
export interface UnboundAssertion extends BaseAssertion {
  subType: 'unbound';
}
export interface BoundAssertion extends BaseAssertion {
  subType: 'bound';
}
export type Assertion = StrongAssertion | WeakAssertion | BoundAssertion | UnboundAssertion;

export function assertStrong<T extends RDF.Term>(term: T): StrongAssertion<T> {
  return {
    type: 'assertion',
    subType: 'strong',
    term,
  };
}
export function assertWeak<T extends RDF.Term>(term: T): WeakAssertion<T> {
  return {
    type: 'assertion',
    subType: 'weak',
    term,
  };
}

export function assertBound(): BoundAssertion {
  return {
    type: 'assertion',
    subType: 'bound',
  };
}
export function assertUnbound(): UnboundAssertion {
  return {
    type: 'assertion',
    subType: 'unbound',
  };
}

/**
 * Whether the assertion implies `bound(?x)`, which is what the emptiness rule (FBndII) and every licence
 * that moves an assertion into a single operand are read off - the strong form and the bound form alike.
 */
export function impliesBound(assertion: Assertion): assertion is BoundAssertion | StrongAssertion {
  return assertion.subType === 'strong' || assertion.subType === 'bound';
}

/**
 * Whether an assertion may fix a variable to this *ground* term, i.e. whether it pins a group to it.
 *
 * A triple term is admitted exactly when it is ground, which is what makes it a term at all rather than a
 * *shape* - `<<( ?a ?b ?c )>>` says which triple the variable is the term of only once its components are
 * known, and until then it is the business of the pin lattice ({@link TermClusterSet}) instead.
 *
 * This is the same call the EXTEND case of {@link withCpVars} (`certainlyBoundVars.ts`) makes from the
 * other side, and the two now agree: a ground triple term cannot raise an evaluation error, so
 * `BIND(<<( :a :b :c )>> AS ?t)` binds `?t` certainly, and an assertion on `?t` may be discharged as soon
 * as its term is decided - `BIND(e AS ?t)` under A⟨?t ≡ c⟩ becomes `Extend(σ_{sameTerm(e,c)}(A), ?t, c)`,
 * which for a decided `e` folds away without a row where `?t` was left unbound to worry about.
 */
export function isAssertableTerm(term: RDF.Term): boolean {
  // Ground *is* variable-free, so the two cases - a variable, and a triple term holding one - are the one
  // question {@link termVars} already answers, and the one `isStaticExpression` asks of a term expression.
  // Blank nodes need no exclusion here: by the time this pass runs, the ones in a WHERE clause have
  // already been converted to variables, so no assertion can ever carry one.
  return termVars(term).size === 0;
}

/**
 * Recognizes the strong assertion a single conjunct carries: `sameTerm(?x, c)`, `sameTerm(c, ?x)`, or the
 * unification `sameTerm(?x, ?y)` - which is A⟨?x ≡ ?y⟩, a strong assertion whose term is a variable.
 *
 * Never generalise this to `=`: `?x = "01"^^xsd:integer` holds of the *term* `"1"^^xsd:integer`, so
 * substituting under `=` would drop solutions. An `=` against an IRI is the one place the two coincide,
 * and {@link constantFoldOperator} has already rewritten that into the `sameTerm` read here.
 */
export function asStrongAssertion(expression: Algebra.Expression):
    { name: string; assertion: StrongAssertion } | undefined {
  if (expression.subType === Algebra.ExpressionTypes.OPERATOR &&
    expression.operator === 'sameterm' &&
    expression.args.length === 2) {
    const [ left, right ] = expression.args;
    if (left.subType === 'term' && right.subType === 'term') {
      // Two variables: which one is read as the subject of the assertion does not matter, since the
      // conjunction unifies them and picks the representative of the resulting clique itself.
      if (left.term.termType === 'Variable' &&
        (right.term.termType === 'Variable' || isAssertableTerm(right.term))) {
        return { name: left.term.value, assertion: assertStrong(right.term) };
      }
      if (right.term.termType === 'Variable' && isAssertableTerm(left.term)) {
        return { name: right.term.value, assertion: assertStrong(left.term) };
      }
    }
  }
  return undefined;
}

/**
 * Recognizes the *weak* assertion a single conjunct carries: `!bound(?x) || sameTerm(?x, c)`.
 *
 * A ground term, never a variable. There is no weak form of a unification (see
 * {@link AssertionConjunction}), so reading `!bound(?x) || sameTerm(?x, ?y)` back as one would be the
 * unsound merge that form does not exist to avoid: it stays a residual condition instead.
 */
export function asWeakAssertion(expression: Algebra.Expression):
    { name: string; assertion: WeakAssertion } | undefined {
  if (expression.subType === Algebra.ExpressionTypes.OPERATOR &&
    expression.operator === '||' && expression.args.length === 2) {
    for (const [ index, arg ] of expression.args.entries()) {
      const bound = variableOfNotBound(arg);
      if (bound !== undefined) {
        const assertion = asStrongAssertion(expression.args[index === 0 ? 1 : 0]);
        if (assertion !== undefined && assertion.name === bound && isAssertableTerm(assertion.assertion.term)) {
          return { name: bound, assertion: assertWeak(assertion.assertion.term) };
        }
      }
    }
  }
  return undefined;
}

/** Recognizes the assertion a single conjunct carries, in whichever of the four forms it is written. */
export function assertionOf(expression: Algebra.Expression): { name: string; assertion: Assertion } | undefined {
  const strong = asStrongAssertion(expression);
  if (strong !== undefined) {
    return strong;
  }
  const weak = asWeakAssertion(expression);
  if (weak !== undefined) {
    return weak;
  }
  const unbound = variableOfNotBound(expression);
  if (unbound !== undefined) {
    return { name: unbound, assertion: assertUnbound() };
  }
  const bound = variableOfBound(expression);
  return bound === undefined ? undefined : { name: bound, assertion: assertBound() };
}

/** The variable of a `bound(?x)` expression, if that is what it is. */
function variableOfBound(expression: Algebra.Expression): string | undefined {
  if (expression.subType === Algebra.ExpressionTypes.OPERATOR && expression.operator === 'bound' &&
    expression.args.length === 1) {
    const [ argument ] = expression.args;
    if (argument.subType === Algebra.ExpressionTypes.TERM && argument.term.termType === 'Variable') {
      return argument.term.value;
    }
  }
  return undefined;
}

/** The variable of a `!bound(?x)` expression, if that is what it is. */
function variableOfNotBound(expression: Algebra.Expression): string | undefined {
  if (expression.subType === Algebra.ExpressionTypes.OPERATOR && expression.operator === '!' &&
    expression.args.length === 1) {
    return variableOfBound(expression.args[0]);
  }
  return undefined;
}

/** Creates the strong assertion A⟨?x ≡ c⟩: `sameTerm(?x, c)`. */
export function assertionExpression(c: TransformContext, name: string, term: RDF.Term): Algebra.Expression {
  return sameTermExpression(c, c.AF.createTermExpression(DF.variable(name)), term);
}

/**
 * Creates the weak assertion W⟨?x ≡ c⟩: `!bound(?x) || sameTerm(?x, c)`.
 *
 * Keeping the solutions that leave `?x` unbound is what makes it usable on the RHS of a MINUS
 * (anti-monotone in that argument) and pushable through operations that may leave `?x` unbound.
 */
export function weakAssertionExpression(c: TransformContext, name: string, term: RDF.Term): Algebra.Expression {
  const variable = c.AF.createTermExpression(DF.variable(name));
  return c.AF.createOperatorExpression('||', [
    c.AF.createOperatorExpression('!', [ c.AF.createOperatorExpression('bound', [ variable ]) ]),
    sameTermExpression(c, variable, term),
  ]);
}

/** Creates the bound assertion B⟨?x⟩: `bound(?x)`. */
export function boundAssertionExpression(c: TransformContext, name: string): Algebra.Expression {
  return c.AF.createOperatorExpression('bound', [ c.AF.createTermExpression(DF.variable(name)) ]);
}

/** Creates the unbound assertion U⟨?x⟩: `!bound(?x)`. */
export function unboundAssertionExpression(c: TransformContext, name: string): Algebra.Expression {
  return c.AF.createOperatorExpression('!', [ boundAssertionExpression(c, name) ]);
}

/** The position a term takes in a quad pattern, which decides what kind of term may occupy it. */
type TermPosition = 'graph' | 'object' | 'predicate' | 'subject';

/**
 * Whether a triple with this term in this position can exist at all.
 *
 * No triple has a literal or a triple term as its subject, predicate or graph name, and none has
 * anything but an IRI as its predicate - so substituting such a term there makes the pattern match
 * nothing, whatever the data is. Variables may occupy any position.
 */
function canOccupy(term: RDF.Term, position: TermPosition): boolean {
  if (position === 'object' || term.termType === 'Variable') {
    return true;
  }
  if (position === 'predicate') {
    return term.termType === 'NamedNode';
  }
  return term.termType !== 'Literal' && term.termType !== 'Quad';
}

/**
 * Substitutes assertions (θ) into a term, recursing into triple terms. `undefined` when the result lands
 * a term in a position no RDF triple can have it in.
 */
export function substituteInTerm(
  term: RDF.Term,
  assertions: Assertions,
  position: TermPosition,
): RDF.Term | undefined {
  if (term.termType === 'Variable') {
    const asserted = assertions.get(term.value);
    if (asserted === undefined) {
      return term;
    }
    return canOccupy(asserted, position) ? asserted : undefined;
  }
  if (term.termType === 'Quad') {
    const subject = substituteInTerm(term.subject, assertions, 'subject');
    const predicate = substituteInTerm(term.predicate, assertions, 'predicate');
    const object = substituteInTerm(term.object, assertions, 'object');
    const graph = substituteInTerm(term.graph, assertions, 'graph');
    if (subject === undefined || predicate === undefined || object === undefined || graph === undefined) {
      return undefined;
    }
    return DF.quad(
      <RDF.Quad_Subject> subject,
      <RDF.Quad_Predicate> predicate,
      <RDF.Quad_Object> object,
      <RDF.Quad_Graph> graph,
    );
  }
  return term;
}

/**
 * Substitutes assertions (θ) into a single triple/quad pattern, or `undefined` when the result can no
 * longer match any triple.
 */
export function substituteInPattern(
  c: TransformContext,
  pattern: Algebra.Pattern,
  assertions: Assertions,
): Algebra.Pattern | undefined {
  const subject = substituteInTerm(pattern.subject, assertions, 'subject');
  const predicate = substituteInTerm(pattern.predicate, assertions, 'predicate');
  const object = substituteInTerm(pattern.object, assertions, 'object');
  const graph = substituteInTerm(pattern.graph, assertions, 'graph');
  if (subject === undefined || predicate === undefined || object === undefined || graph === undefined) {
    return undefined;
  }
  return c.AF.createPattern(subject, predicate, object, graph);
}
