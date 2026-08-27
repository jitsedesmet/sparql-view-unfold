import type * as RDF from '@rdfjs/types';
import { Algebra } from '@traqula/algebra-transformations-1-2';
import type { TriplePosition } from '../datastructures/TermClusterSet.js';
import { isTriplePosition, triplePositions } from '../datastructures/TermClusterSet.js';
import { RangeSet } from '../RangeSet.js';
import type { TransformContext } from '../transformContext.js';
import { termVars } from './certainlyBoundVars.js';
import { DF } from './rdfDatatypes.js';
import { unionSets } from './setUtils.js';

/**
 * @fileoverview The assertion toolbox: recognizing the assertions a filter condition carries, building
 * them, and substituting them into expressions and patterns.
 *
 * A condition is read for all of the forms at once, into the single
 * {@link utils/assertionConjunction!AssertionConjunction} the pushdown moves around.
 */

/**
 * A substitution theta: variable name to the single term it is fixed to.
 *
 * The *substitutable* form every `substituteIn...` helper takes, which is why the weak, bound and unbound
 * forms of an {@link utils/assertionConjunction!AssertionConjunction} are kept out of it. The term may be
 * a variable: that is what a unification substitutes, replacing every member of a clique by its
 * representative.
 */
export type Assertions = ReadonlyMap<string, RDF.Term>;

/**
 * A variable read through a chain of accessors: `?x`, `SUBJECT(?x)`, `OBJECT(SUBJECT(?x))`.
 *
 * An assertion is about an access rather than a variable, since a triple term is constrained one position
 * at a time. The chain reads left to right from the root, so `{ name: 'o', positions: [ 'subject',
 * 'object' ]}` is `OBJECT(SUBJECT(?o))`, and the zero-length access is the variable itself.
 */
export interface Access {
  name: string;
  positions: readonly TriplePosition[];
}

/** The access `?name`, read through `positions`. */
export function access(name: string, ...positions: TriplePosition[]): Access {
  return { name, positions };
}

/**
 * The key two accesses are the same one under.
 * @param access - The access to key
 * @returns its positions joined onto its name by `.`, which no variable name may hold
 */
export function accessId(access: Access): string {
  return [ access.name, ...access.positions ].join('.');
}

/**
 * Orders the ways of reading one value, most direct first: a variable before a position of one, and
 * lexicographic within that.
 * @param left - One access
 * @param right - The other
 * @returns negative, zero or positive, as {@link Array.sort} expects
 */
export function compareAccesses(left: Access, right: Access): number {
  return left.positions.length - right.positions.length || accessId(left).localeCompare(accessId(right));
}

/** Whether the two accesses read the same variable through the same chain. */
export function sameAccessAs(left: Access, right: Access): boolean {
  return accessId(left) === accessId(right);
}

/**
 * Whether the access is the variable itself, which is the only thing `BOUND` and a group member can be.
 * @param access - The access to check
 * @returns whether it reads no positions
 */
export function isBareAccess(access: Access): boolean {
  return access.positions.length === 0;
}

/**
 * The term types a SPARQL condition names with a predicate of its own, and so the ones an assertion can be
 * about. `isNUMERIC` is not one: it asks after the datatype of a literal rather than after a kind of term.
 */
export type AssertableTermType = 'BlankNode' | 'Literal' | 'NamedNode' | 'Quad';

/** The predicate a condition states a term type with, which is also how one is written back. */
const termTypePredicates: Readonly<Record<AssertableTermType, string>> = {
  NamedNode: 'isiri',
  BlankNode: 'isblank',
  Literal: 'isliteral',
  Quad: 'istriple',
};

/** The term types, in the order the lattice writes them, for iterating over all of them. */
export const assertableTermTypes = <AssertableTermType[]> Object.keys(termTypePredicates);

/**
 * The term type a predicate states, `isURI` reading as the `isIRI` it is a synonym of.
 * @param operator - The operator of a unary condition
 * @returns the term type it states, or `undefined` for anything that is not one of them
 */
export function asAssertableTermType(operator: string): AssertableTermType | undefined {
  const termAssertion = operator === 'isuri' ? 'isiri' : operator;
  return assertableTermTypes.find(termType => termTypePredicates[termType] === termAssertion);
}

/** The range a term type narrows a group to - a singleton, a term having exactly one kind. */
export function rangeOfTermType(termType: AssertableTermType): RangeSet {
  return new RangeSet([ termType ]);
}

/** What an assertion fixes an access to: another access, or a ground term. */
export type AssertionTarget = Access | RDF.Term;

/** Whether the target is an access rather than a term - the two are told apart by their shape. */
export function targetIsAccess(target: AssertionTarget): target is Access {
  return 'positions' in target;
}

/**
 * One assertion about one {@link Access}, in one of the five forms this pass moves around:
 *
 * - `strong` is A⟨a ≡ c⟩ ≔ `sameTerm(a, c)`, which implies `bound(?x)` of the root of `a`. Its target
 *   may be another access, in which case it is an *edge* of a clique or of a shape.
 * - `weak` is W⟨a ≡ c⟩ ≔ `¬bnd(?x) ∨ sameTerm(a, c)`, which does not - it is what survives a move into
 *   a place that may leave the variable unbound (the RHS of a MINUS, the unlicensed operand of a join).
 * - `termType` is T⟨a : τ⟩ ≔ `isIRI(a)` / `isBLANK(a)` / `isLITERAL(a)` / `isTRIPLE(a)`, with `strong`
 *   recording whether it is asserted outright or only where the root is bound.
 * - `unbound` is U⟨?x⟩ ≔ `!bound(?x)`, and `bound` is B⟨?x⟩ ≔ `bound(?x)`, which fixes no term at all but
 *   decides the same emptiness rule the strong form does and completes a weak assertion into a strong one.
 *
 * `bound` and `unbound` are restricted to a bare access, `BOUND` taking a `Var` by the grammar; a
 * `termType` is not, `isTRIPLE(SUBJECT(?o))` being a fact about the group `SUBJECT(?o)` names.
 *
 * Only the strong form may be substituted into a pattern: the others say what the variable is *not* bound
 * to, or say nothing about which term it is.
 */
interface BaseAssertion {
  type: 'assertion';
  subType: string;
}
export interface StrongAssertion extends BaseAssertion {
  subType: 'strong';
  term: AssertionTarget;
}
export interface WeakAssertion extends BaseAssertion {
  subType: 'weak';
  term: AssertionTarget;
}
/** T⟨?x : τ⟩ when `strong`, and `!bound(?x) || is<τ>(?x)` when not. */
export interface TermTypeAssertion extends BaseAssertion {
  subType: 'termType';
  termType: AssertableTermType;
  strong: boolean;
}
export interface UnboundAssertion extends BaseAssertion {
  subType: 'unbound';
}
export interface BoundAssertion extends BaseAssertion {
  subType: 'bound';
}
export type Assertion =
  BoundAssertion | StrongAssertion | TermTypeAssertion | UnboundAssertion | WeakAssertion;

export function assertStrong(term: AssertionTarget): StrongAssertion {
  return {
    type: 'assertion',
    subType: 'strong',
    // A variable is always wrapped in an access
    term: normalisedTarget(term),
  };
}
export function assertWeak(term: AssertionTarget): WeakAssertion {
  return {
    type: 'assertion',
    subType: 'weak',
    // A variable is always wrapped in an access
    term: normalisedTarget(term),
  };
}

/**
 * Spells a target the one way everything downstream expects: a variable as the zero-length access reading
 * it, anything else unchanged.
 * @param target - The target to normalise
 * @returns the access for a variable, the target itself otherwise
 */
export function normalisedTarget(target: AssertionTarget): AssertionTarget {
  return !targetIsAccess(target) && target.termType === 'Variable' ? access(target.value) : target;
}

/** Creates T⟨?x : τ⟩, or its weak form `!bound(?x) || is<τ>(?x)`. */
export function assertTermType(termType: AssertableTermType, strong = true): TermTypeAssertion {
  return {
    type: 'assertion',
    subType: 'termType',
    termType,
    strong,
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
 * Whether the assertion carries a target, which is the pair the strong and weak forms are.
 * @param assertion - The assertion to check
 * @returns whether it is a strong or a weak assertion
 */
export function hasTarget(assertion: Assertion): assertion is StrongAssertion | WeakAssertion {
  // Check it is not a bound, unbound, nor a termType assertion
  return assertion.subType === 'strong' || assertion.subType === 'weak';
}

/**
 * Whether the assertion implies `bound(?x)` of its root, which is what the emptiness rule (FBndII) and
 * every licence moving an assertion into a single operand are read off.
 * @param assertion - The assertion to check
 * @returns whether it entails that the root is bound
 */
export function impliesBound(assertion: Assertion): boolean {
  return assertion.subType === 'strong' || assertion.subType === 'bound' ||
    (assertion.subType === 'termType' && assertion.strong);
}

/**
 * Whether an assertion may fix a variable to this *ground* term, i.e. whether it pins a group to it.
 *
 * A triple term is admitted exactly when it is ground: until its components are known it is a *shape*, and
 * that is the business of the pin lattice ({@link datastructures/TermClusterSet!TermClusterSet}) instead.
 * @param term - The term to check
 * @returns whether the term is variable-free
 */
export function isAssertableTerm(term: RDF.Term): boolean {
  // Ground *is* variable-free, so the two cases - a variable, and a triple term holding one - are the one
  // question {@link termVars} already answers, and the one `isStaticExpression` asks of a term expression.
  // Blank nodes need no exclusion here: by the time this pass runs, the ones in a WHERE clause have
  // already been converted to variables, so no assertion can ever carry one.
  return termVars(term).size === 0;
}

/**
 * The access an expression reads, when that is all it does: a variable, or a chain of `SUBJECT` /
 * `PREDICATE` / `OBJECT` around one.
 * @param expression - The expression to read
 * @param acc - The positions collected so far, filled in by the recursion
 * @returns the access, or `undefined` when the expression does more than read one
 */
export function asAccess(expression: Algebra.Expression, acc: TriplePosition[] = []): Access | undefined {
  if (expression.subType === Algebra.ExpressionTypes.TERM) {
    return expression.term.termType === 'Variable' ?
        { name: expression.term.value, positions: acc.reverse() } :
      undefined;
  }
  if (expression.subType === Algebra.ExpressionTypes.OPERATOR && expression.args.length === 1 &&
      isTriplePosition(expression.operator)) {
    acc.push(expression.operator);
    return asAccess(expression.args[0], acc);
  }
  return undefined;
}

/** The target one side of a `sameTerm` stands for: the access it reads, or the ground term it is. */
function asAssertionTarget(expression: Algebra.Expression): AssertionTarget | undefined {
  const read = asAccess(expression);
  if (read === undefined) {
    return expression.subType === Algebra.ExpressionTypes.TERM && isAssertableTerm(expression.term) ?
      expression.term :
      undefined;
  }
  return read;
}

/**
 * What a BIND hands an {@link utils/assertionConjunction!AssertionConjunction} in place of its target:
 * the thing below the EXTEND that carries the value the target holds above it.
 *
 * Either a value the conjunction can name - a ground term, or an {@link Access} reading one - or the shape
 * of one, which is what a triple term construction over variables is. The three are told apart by their
 * shape: a construction has neither the `positions` of an access nor the `termType` of a term.
 */
export type TransferSource = AssertionTarget | TripleConstruction;

/**
 * The three positions a triple term construction builds its value out of.
 *
 * All three are a {@link TransferSource}, although only an object can hold a triple term: this says what
 * the BIND wrote, not what a value can be, and reading `TRIPLE(TRIPLE(?a, ?b, ?c), ?p, ?o)` as the
 * construction it is, is what lets the positional range refuse it and prove the operation empty.
 */
export interface TripleConstruction {
  subject: TransferSource;
  predicate: TransferSource;
  object: TransferSource;
}

/** Whether the source builds its value rather than being one. */
export function isTripleConstruction(source: TransferSource): source is TripleConstruction {
  return !('positions' in source) && !('termType' in source);
}

/**
 * Reads what a BIND expression hands down.
 *
 * `TRIPLE(?a, ?b, ?c)` and its `<<( ?a ?b ?c )>>` spelling are the same construction: only the first is an
 * operator, the second parsing to a term expression holding a quad with variables in it.
 * @param expression - The expression of the EXTEND
 * @returns the source, or `undefined` for a compound expression the conjunction cannot name
 */
export function asTransferSource(expression: Algebra.Expression): TransferSource | undefined {
  if (expression.subType === Algebra.ExpressionTypes.TERM) {
    return transferSourceOfTerm(expression.term);
  }
  const access = asAccess(expression);
  if (access !== undefined) {
    return access;
  }
  if (expression.subType === Algebra.ExpressionTypes.OPERATOR && expression.operator === 'triple' &&
    expression.args.length === 3) {
    return constructionOf(expression.args.map(arg => asTransferSource(arg)));
  }
  return undefined;
}

/**
 * The same for a term, which is where a construction over variables actually arrives.
 * @param term - The term of a term expression
 * @returns the source, or `undefined` when no value the conjunction can hold is one
 */
function transferSourceOfTerm(term: RDF.Term): TransferSource | undefined {
  if (term.termType === 'Variable') {
    return access(term.value);
  }
  if (term.termType === 'Quad' && !isAssertableTerm(term)) {
    // A quad carrying a graph is a generalised statement rather than a triple term, so no value Θ can
    // hold is one and nothing is handed down. A *ground* one is a term like any other, and was decided
    // by the branch above.
    return term.graph.termType === 'DefaultGraph' ?
      constructionOf(triplePositions.map(position => transferSourceOfTerm(term[position]))) :
      undefined;
  }
  return isAssertableTerm(term) ? term : undefined;
}

/**
 * The construction of three positions.
 * @param positions - The sources of subject, predicate and object
 * @returns the construction, or `undefined` when a position is nothing the conjunction can name - one
 * statement lost is a transfer that no longer says what the conjunction said, so nothing is transferred
 */
function constructionOf(positions: (TransferSource | undefined)[]): TripleConstruction | undefined {
  const [ subject, predicate, object ] = positions;
  if (subject === undefined || predicate === undefined || object === undefined) {
    // One position Θ cannot name is one statement that would be lost, and a transfer that no longer says
    // what the conjunction said - so nothing is transferred and the assertion stays above the EXTEND.
    return undefined;
  }
  return { subject, predicate, object };
}

/**
 * The variables a source reads, which is what tells a BIND that its own target is one of them.
 * @param source - The source to read
 * @returns the variables it mentions
 */
export function variablesOfTransferSource(source: TransferSource): Set<string> {
  if (isTripleConstruction(source)) {
    return unionSets(triplePositions.map(position => variablesOfTransferSource(source[position])));
  }
  return targetIsAccess(source) ? new Set([ source.name ]) : termVars(source);
}

/**
 * Recognizes the conjuncts a `sameTerm` carries: `sameTerm(a, c)`, `sameTerm(c, a)`, the unification
 * `sameTerm(a, b)`, and the construction `sameTerm(?o, <<( ?a ?b ?c )>>)` which decomposes per position.
 * @param expression - The conjunct to recognize
 * @returns the conjuncts it carries, or `undefined` when it is not a `sameTerm` of two readable sides
 */
function asStrongAssertion(expression: Algebra.Expression):
    (AssertionConjunct & { assertion: StrongAssertion })[] | undefined {
  // Never generalise this to `=`: `?x = "01"^^xsd:integer` holds of the term `"1"^^xsd:integer`, so
  // substituting under `=` would drop solutions. An `=` against an IRI is the one place the two coincide,
  // and `constantFoldOperator` has already rewritten that into the `sameterm` read here.
  if (expression.subType === Algebra.ExpressionTypes.OPERATOR && expression.operator === 'sameterm' &&
    expression.args.length === 2) {
    const [ left, right ] = expression.args;
    // Decompose triple term assertions first. If they are not here, try for terms next
    const decomposed = decomposedConstruction(left, right) ?? decomposedConstruction(right, left);
    if (decomposed !== undefined) {
      return decomposed;
    }
    // Which side is read as the subject of the assertion does not matter for an access on both: the
    // conjunction unifies the two groups and picks the representative of the result itself.
    const leftAccess = asAccess(left);
    if (leftAccess !== undefined) {
      const target = asAssertionTarget(right);
      return target === undefined ? undefined : [{ access: leftAccess, assertion: assertStrong(target) }];
    }
    const rightAccess = asAccess(right);
    if (rightAccess !== undefined) {
      const target = asAssertionTarget(left);
      return target === undefined ? undefined : [{ access: rightAccess, assertion: assertStrong(target) }];
    }
    return undefined;
  }
  return undefined;
}

/**
 * `sameTerm(a, <<( x y z )>>)` read as one conjunct per position of the shape `a` has to have.
 * @param read - The side reading a value
 * @param built - The side constructing one
 * @returns the conjuncts, or `undefined` when the two are not that pair
 */
function decomposedConstruction(read: Algebra.Expression, built: Algebra.Expression):
    (AssertionConjunct & { assertion: StrongAssertion })[] | undefined {
  const root = asAccess(read);
  const source = asTransferSource(built);
  if (root === undefined || source === undefined || !isTripleConstruction(source)) {
    return undefined;
  }
  return decomposedSource(root, source);
}

/**
 * The conjuncts a construction states about the access it is equated to, a position at a time.
 * @param read - The access the source is equated to
 * @param source - The value or construction it is equated to
 * @returns one conjunct per position that names a value
 */
function decomposedSource(read: Access, source: TransferSource):
(AssertionConjunct & { assertion: StrongAssertion })[] {
  if (!isTripleConstruction(source)) {
    return [{ access: read, assertion: assertStrong(source) }];
  }
  return triplePositions.flatMap(position =>
    decomposedSource({ name: read.name, positions: [ ...read.positions, position ]}, source[position]));
}

/**
 * Recognizes T⟨a : τ⟩ - `isIRI(a)`, `isBLANK(a)`, `isLITERAL(a)`, `isTRIPLE(a)` - which says which kind of
 * term `a` is and nothing about which one.
 * @param expression - The conjunct to recognize
 * @returns the conjunct it carries, or `undefined` when it is not one of the four predicates
 */
function asTermTypeAssertion(expression: Algebra.Expression):
    (AssertionConjunct & { assertion: TermTypeAssertion }) | undefined {
  if (expression.subType === Algebra.ExpressionTypes.OPERATOR && expression.args.length === 1) {
    const termType = asAssertableTermType(expression.operator);
    if (termType !== undefined) {
      const access = asAccess(expression.args[0]);
      if (access !== undefined) {
        return { access, assertion: assertTermType(termType) };
      }
    }
  }
  return undefined;
}

/**
 * Recognizes the weak conjuncts a condition carries: `!bound(?x) || φ`, where `φ` is a strong assertion
 * about `?x` and about nothing else.
 * @param expression - The conjunct to recognize
 * @returns the conjunct it carries, or `undefined` when it is not of that shape
 */
function asWeakAssertion(expression: Algebra.Expression): AssertionConjunct[] | undefined {
  if (expression.subType === Algebra.ExpressionTypes.OPERATOR && expression.operator === '||' &&
    expression.args.length === 2) {
    for (const [ index, arg ] of expression.args.entries()) {
      const unbound = variableOfNotBound(arg);
      if (unbound === undefined) {
        continue;
      }
      const other = expression.args[index === 0 ? 1 : 0];
      const typed = asTermTypeAssertion(other);
      if (typed === undefined) {
        const strong = asStrongAssertion(other);
        if (strong?.length === 1) {
          const [{ access, assertion }] = strong;
          // A weak *edge* is not a state the conjunction can be in - weakening one is the unsound merge
          // that form does not exist to avoid - so an edge is left standing as an ordinary residual.
          if (access.name === unbound && !targetIsAccess(assertion.term)) {
            return [{ access, assertion: assertWeak(assertion.term) }];
          }
        }
      } else if (accessId(typed.access) === unbound) {
        return [{ access: typed.access, assertion: assertTermType(typed.assertion.termType, false) }];
      }
    }
  }
  return undefined;
}

/**
 * Recognizes the conjuncts a single condition carries, in whichever of the forms they are written.
 * @param expression - The conjunct to recognize
 * @returns the conjuncts it carries, or `undefined` for a condition that is no assertion at all
 */
export function asAssertionConjuncts(expression: Algebra.Expression): AssertionConjunct[] | undefined {
  const strong = asStrongAssertion(expression);
  if (strong !== undefined) {
    return strong;
  }
  const weak = asWeakAssertion(expression);
  if (weak !== undefined) {
    return weak;
  }
  const typed = asTermTypeAssertion(expression);
  if (typed !== undefined) {
    return [ typed ];
  }
  const unbound = variableOfNotBound(expression);
  if (unbound !== undefined) {
    return [{ access: access(unbound), assertion: assertUnbound() }];
  }
  const bound = variableOfBound(expression);
  return bound === undefined ? undefined : [{ access: access(bound), assertion: assertBound() }];
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

/** The expression reading an access: the variable, wrapped in one accessor per position it reads. */
function accessAsExpression(c: TransformContext, access: Access): Algebra.Expression {
  return access.positions.reduce<Algebra.Expression>(
    (inner, position) => c.AF.createOperatorExpression(position, [ inner ]),
    c.AF.createTermExpression(DF.variable(access.name)),
  );
}

/** The expression one side of an assertion stands for. */
function targetAsExpression(c: TransformContext, target: AssertionTarget): Algebra.Expression {
  if (targetIsAccess(target)) {
    return accessAsExpression(c, target);
  }
  return c.AF.createTermExpression(target);
}

/** Creates the strong assertion A⟨a ≡ c⟩: `sameTerm(a, c)`. */
function strongAssertionAsExpression(c: TransformContext, access: Access, target: AssertionTarget):
Algebra.Expression {
  return c.AF.createOperatorExpression('sameterm', [
    accessAsExpression(c, access),
    targetAsExpression(c, target),
  ]);
}

/** Creates T⟨a : τ⟩: the predicate that states `τ`, applied to `a`. */
function termTypeAssertionAsExpression(
  c: TransformContext,
  access: Access,
  termType: AssertableTermType,
): Algebra.Expression {
  return c.AF.createOperatorExpression(termTypePredicates[termType], [ accessAsExpression(c, access) ]);
}

/**
 * Creates the weak form of a condition about `?x`: `!bound(?x) || φ`.
 * @param c - The transformation context
 * @param name - The variable the condition is about
 * @param strong - The condition to weaken
 * @returns the disjunction, which may only ever be placed as a filter condition (S1)
 */
function weakenedExpression(c: TransformContext, name: string, strong: Algebra.Expression):
Algebra.Expression {
  return c.AF.createOperatorExpression('||', [ unboundAssertionAsExpression(c, name), strong ]);
}

/**
 * Creates the weak assertion W⟨a ≡ c⟩: `¬bnd(?x) ∨ sameTerm(a, c)`.
 * @param c - The transformation context
 * @param access - The access the assertion is about
 * @param target - The term it is fixed to where its root is bound
 * @returns the condition
 */
function weakAssertionAsExpression(c: TransformContext, access: Access, target: AssertionTarget):
Algebra.Expression {
  return weakenedExpression(c, access.name, strongAssertionAsExpression(c, access, target));
}

/** Creates the bound assertion B⟨?x⟩: `bound(?x)`. */
function boundAssertionAsExpression(c: TransformContext, name: string): Algebra.Expression {
  return c.AF.createOperatorExpression('bound', [ c.AF.createTermExpression(DF.variable(name)) ]);
}

/** Creates the unbound assertion U⟨?x⟩: `!bound(?x)`. */
function unboundAssertionAsExpression(c: TransformContext, name: string): Algebra.Expression {
  return c.AF.createOperatorExpression('!', [ boundAssertionAsExpression(c, name) ]);
}

/**
 * The condition one conjunct stands for - the inverse of {@link asAssertionConjuncts}, and next to it so
 * that the two can be read against each other.
 * @returns the condition, in the shape the recogniser reads straight back into the same state
 */
export function conjunctAsExpression(c: TransformContext, { access, assertion }: AssertionConjunct):
Algebra.Expression {
  // Nothing new is ever serialised, which is what keeps a second run of the pass from stacking a second
  // copy of what it derived. A shape in particular is never written as `sameTerm(?o, <<( ... )>>)` (S2):
  // it arrives here one position at a time, the positions nobody named having no variable that is bound
  // where the condition sits.
  switch (assertion.subType) {
    case 'unbound': {
      return unboundAssertionAsExpression(c, access.name);
    }
    case 'bound': {
      return boundAssertionAsExpression(c, access.name);
    }
    case 'strong': {
      return strongAssertionAsExpression(c, access, assertion.term);
    }
    case 'weak': {
      return weakAssertionAsExpression(c, access, assertion.term);
    }
    case 'termType': {
      const typed = termTypeAssertionAsExpression(c, access, assertion.termType);
      return assertion.strong ? typed : weakenedExpression(c, access.name, typed);
    }
  }
}

/**
 * One conjunct of an {@link utils/assertionConjunction!AssertionConjunction}: what it says about one
 * access, or one edge between two.
 */
export interface AssertionConjunct {
  access: Access;
  assertion: Assertion;
}

/**
 * The variables a conjunct reads - two iff it is an edge between two of them.
 * @param conjunct - The conjunct to read
 * @returns the variables it mentions, without repetition, the one it is about first
 */
export function variablesReadByConjunct(conjunct: AssertionConjunct): string[] {
  const { access, assertion } = conjunct;
  if (hasTarget(assertion) && targetIsAccess(assertion.term) && assertion.term.name !== access.name) {
    return [ access.name, assertion.term.name ];
  }
  return [ access.name ];
}

/**
 * The same conjunct, in the strongest form that survives a move somewhere its variables may be unbound:
 * A⟨a ≡ c⟩ becomes W⟨a ≡ c⟩, T⟨a : τ⟩ becomes its weak self, and W and U are already that weak.
 * @param conjunct - The conjunct to weaken
 * @returns the weakened conjunct, or `undefined` for the two that have no weak form and so cannot travel:
 * B⟨?x⟩, whose weakening `!b || b` is `true`, and an edge between two accesses
 */
export function asWeakenedConjunct(conjunct: AssertionConjunct): AssertionConjunct | undefined {
  const { access, assertion } = conjunct;
  switch (assertion.subType) {
    case 'bound': {
      return undefined;
    }
    case 'termType': {
      return assertion.strong ? { access, assertion: assertTermType(assertion.termType, false) } : conjunct;
    }
    case 'strong': {
      return targetIsAccess(assertion.term) ? undefined : { access, assertion: assertWeak(assertion.term) };
    }
    default: {
      return conjunct;
    }
  }
}

/** The position a term takes in a quad pattern, which decides what kind of term may occupy it. */
type TermPosition = 'graph' | 'object' | 'predicate' | 'subject';

/**
 * Whether a triple with this term in this position can exist at all: no triple has a literal or a triple
 * term as its subject, predicate or graph name, and none has anything but an IRI as its predicate.
 * @param term - The term to place
 * @param position - The position it lands in
 * @returns whether some triple holds it there, `true` for a variable, which may occupy any position
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
 * The component a triple term holds in a position.
 * @param term - The term to read
 * @param position - The position to read
 * @returns the component, or `undefined` for anything that is not a triple term - the graph is what tells
 * the two apart, a quad carrying one being a generalised statement rather than a term
 */
export function componentOf(term: RDF.Term, position: TriplePosition): RDF.Term | undefined {
  if (term.termType !== 'Quad' || term.graph.termType !== 'DefaultGraph') {
    return undefined;
  }
  return term[position];
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
