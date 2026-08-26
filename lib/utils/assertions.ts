import type * as RDF from '@rdfjs/types';
import { Algebra } from '@traqula/algebra-transformations-1-2';
import type { TriplePosition } from '../datastructures/TermClusterSet.js';
import { triplePositions } from '../datastructures/TermClusterSet.js';
import { RangeSet } from '../RangeSet.js';
import type { TransformContext } from '../transformContext.js';
import { termVars } from './certainlyBoundVars.js';
import { DF } from './rdfDatatypes.js';
import { unionSets } from './setUtils.js';

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
 * {@link AssertionConjunction.rebuildingSubstitution}. The term may be a *variable*: that is what a
 * unification substitutes, replacing every member of a clique by the representative of it.
 */
export type Assertions = ReadonlyMap<string, RDF.Term>;

/**
 * A variable read through a chain of accessors: `?x`, `SUBJECT(?x)`, `OBJECT(SUBJECT(?x))`.
 *
 * An assertion is about an *access* rather than about a variable, because a triple term is constrained
 * one position at a time: `sameTerm(SUBJECT(?o), ?s)` says nothing about `?o` as a whole and everything
 * about one of its three components. The zero-length access is the variable itself, which is what every
 * form this pass had before this is now spelled as.
 *
 * The chain reads left to right from the root: `{ name: 'o', positions: [ 'subject', 'object' ]}` is
 * `OBJECT(SUBJECT(?o))`.
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
 * The key two accesses are the same one under - `.` separates, and no SPARQL variable name may hold one,
 * so no access collides with another.
 */
export function accessId(access: Access): string {
  return [ access.name, ...access.positions ].join('.');
}

/**
 * Orders the ways of reading one value: the most direct first - a variable before a position of one, and
 * lexicographic within that.
 *
 * The one order Θ reads a group's {@link Access | readings} in, which is what makes a re-run of the pass
 * derive the same representative, write the same conjuncts against it, and absorb what it finds rather than
 * stacking a second copy.
 */
export function compareAccesses(left: Access, right: Access): number {
  return left.positions.length - right.positions.length || accessId(left).localeCompare(accessId(right));
}

/** Whether the two accesses read the same variable through the same chain. */
export function sameAccessAs(left: Access, right: Access): boolean {
  return accessId(left) === accessId(right);
}

/** Whether the access is the variable itself, which is the only thing `BOUND` and a group member can be. */
export function isBareAccess(access: Access): boolean {
  return access.positions.length === 0;
}

/**
 * The term types a SPARQL condition can name with a predicate of its own, and so the ones an assertion
 * can be about.
 *
 * `isNUMERIC` is deliberately not one: it asks after the *datatype* of a literal rather than after the
 * kind of term, so there is no range for it to narrow and no group fact for it to be.
 */
export type AssertableTermType = 'BlankNode' | 'Literal' | 'NamedNode' | 'Quad';

/**
 * The predicate a condition states a term type with, which is also how one is written back.
 * We need to harmonize isIri and isUri manualy using {@link asAssertableTermType}.
 */
const termTypePredicates: Readonly<Record<AssertableTermType, string>> = {
  NamedNode: 'isiri',
  BlankNode: 'isblank',
  Literal: 'isliteral',
  Quad: 'istriple',
};

/** The term types, in the order the lattice writes them, for iterating over all of them. */
export const assertableTermTypes = <AssertableTermType[]> Object.keys(termTypePredicates);

/**
 * The term type a predicate states, or `undefined` for anything that is not one of them.
 *
 * `isURI` is SPARQL's own synonym for `isIRI`, so it reads as the same fact and is written back as
 * `isIRI` - the same kind of non-verbatim round trip the other forms already make.
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
 * One assertion about one *access*, in one of the five forms this pass moves around.
 *
 * - `strong` is A⟨a ≡ c⟩ ≔ `sameTerm(a, c)`, which implies `bound(?x)` of the root of `a`. Its target may
 *   be another access, in which case it is A⟨a ≡ b⟩ - one edge of the clique an
 *   {@link AssertionConjunction} holds, and, when either side reads through an accessor, one edge of the
 *   *shape* it holds.
 * - `weak` is W⟨a ≡ c⟩ ≔ `!bound(?x) || sameTerm(a, c)`, which does not - it is what survives a move into
 *   a place that may leave the variable unbound (the RHS of a MINUS, the unlicensed operand of a join).
 * - `termType` is T⟨?x : τ⟩ ≔ `isIRI(?x)` / `isBLANK(?x)` / `isLITERAL(?x)` / `isTRIPLE(?x)`: which kind
 *   of term `?x` is, and nothing about which one. Like the strong form it implies `bound(?x)` - reading
 *   the kind of an unbound variable is an error - and like it it has a weak form (`!bound(?x) ||
 *   is<τ>(?x)`), which is what `strong` being false records.
 * - `unbound` is U⟨?x⟩ ≔ `!bound(?x)`.
 * - `bound` is B⟨?x⟩ ≔ `bound(?x)`, which fixes the variable to no term at all.
 *
 * The `weak` form is what the conjunction of two *different* weak assertions about one variable comes to:
 * `(¬b ∨ ?x ≡ c) ∧ (¬b ∨ ?x ≡ d)` distributes to `¬b ∨ (?x ≡ c ∧ ?x ≡ d)`, which for `c ≠ d` is `¬b`.
 * Without it {@link AssertionConjunction.assertTerm} would have nowhere to put that fact - it has no term
 * - and would have to leave the conjunct behind as a residual. It is also SPARQL's negation idiom
 * (`OPTIONAL { … } FILTER(!bound(?x))`), so it is the form assertions most often *start* in.
 *
 * B⟨?x⟩ is the negation of U⟨?x⟩, and the term-less half of the strong form: it says only that the
 * variable *is* bound, which is what SPARQL writes as `FILTER(bound(?x))`. It carries no term, so it never
 * substitutes into anything, but it decides the same emptiness rule the strong form does ((FBndII):
 * `?x ∉ pVars(A) ⟹ σ_{bound(?x)}(A) ≡ ∅`) and it *completes* a weak assertion into a strong one -
 * `b ∧ (¬b ∨ ?x ≡ c) ≡ ?x ≡ c` - which is where it earns its keep.
 *
 * `bound` and `unbound` are restricted to a *bare* access, `BOUND` taking a `Var` by the grammar. A
 * `termType` is not: `isTRIPLE(SUBJECT(?o))` is a perfectly good fact, about the group `SUBJECT(?o)`
 * names rather than about `?o`.
 *
 * Only the strong form may be substituted into a pattern: `weak` and `unbound` say what the variable is
 * *not* bound to rather than that it is bound, and `bound` says nothing about which term it is.
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
 * A variable on the right hand side is the zero-length access reading it, so that a target has one
 * spelling only - everything downstream tells the two apart by asking whether it is an access, and a
 * variable spelled as a term would answer no while being exactly one.
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

/** Whether the assertion carries a target, which is the pair the strong and weak forms are. */
export function hasTarget(assertion: Assertion): assertion is StrongAssertion | WeakAssertion {
  // Check it is not a bound, unbound, nor a termType assertion
  return assertion.subType === 'strong' || assertion.subType === 'weak';
}

/**
 * Whether the assertion implies `bound(?x)`, which is what the emptiness rule (FBndII) and every licence
 * that moves an assertion into a single operand are read off - the strong form, the bound form, and the
 * shape alike, a triple term being a term like any other.
 */
export function impliesBound(assertion: Assertion): boolean {
  return assertion.subType === 'strong' || assertion.subType === 'bound' ||
    (assertion.subType === 'termType' && assertion.strong);
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
 * The access an expression reads, when that is all it does: a variable, or a chain of `SUBJECT` /
 * `PREDICATE` / `OBJECT` around one.
 *
 * `OBJECT(SUBJECT(?o))` is `{ name: 'o', positions: [ 'subject', 'object' ]}` - the chain is unwrapped
 * from the outside in, so the positions come out in the order they are applied.
 */
export function asAccess(expression: Algebra.Expression, acc: TriplePosition[] = []): Access | undefined {
  if (expression.subType === Algebra.ExpressionTypes.TERM) {
    return expression.term.termType === 'Variable' ?
        { name: expression.term.value, positions: acc.reverse() } :
      undefined;
  }
  if (expression.subType === Algebra.ExpressionTypes.OPERATOR && expression.args.length === 1 &&
      triplePositions.includes(<TriplePosition> expression.operator)) {
    acc.push(<TriplePosition> expression.operator);
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
 * What a BIND hands Θ in place of its target: the thing below the EXTEND that carries the value the
 * target holds above it.
 *
 * Either a value Θ can name - a ground term, or an {@link Access} reading one - or the *shape* of one,
 * which is what a triple term construction over variables is. `<<( ?a ?b ?c )>>` names no value until
 * its components do, so what it hands down is one statement per position rather than one about the
 * whole, exactly as the shape of a group is.
 *
 * Told apart by their shape, the way an {@link AssertionTarget} already is: a construction has neither
 * the `positions` of an access nor the `termType` of a term.
 */
export type TransferSource = AssertionTarget | TripleConstruction;

/**
 * The three positions a triple term construction builds its value out of.
 *
 * All three are a {@link TransferSource}, although only the object of a triple term can *hold* another
 * one: this says what the BIND wrote, not what a value can be, and `TRIPLE(TRIPLE(?a, ?b, ?c), ?p, ?o)`
 * is a perfectly writable expression. Reading it as the construction it is, is what **decides** it - the
 * transfer opens a shape on the subject position, the positional range refuses it exactly as it refuses
 * a Literal there, and the operation is empty. Which is the right answer rather than a lucky one: such a
 * construction raises, so the target is unbound in every solution, and a transfer is only ever made
 * where Θ implies it is bound.
 *
 * Narrowing subject and predicate to an {@link AssertionTarget} would hand that expression back as
 * "nothing Θ can name", and the assertion would sit above the EXTEND saying nothing - a lost emptiness
 * proof, for a type that would still not be the one the values have.
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
 * Reads what a BIND expression hands down, or `undefined` for one Θ cannot name at all - a compound
 * expression, whose value is whatever evaluating it comes to.
 *
 * `TRIPLE(?a, ?b, ?c)` and `<<( ?a ?b ?c )>>` are the same construction written two ways, and only the
 * first is an operator: the second parses to a *term* expression holding a quad with variables in it,
 * which is also what {@link withCpVars} reads for its own construction rule.
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

/** The same for a term, which is where a construction over variables actually arrives. */
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

/** The construction of three positions, `undefined` when one of them is not something Θ can name. */
function constructionOf(positions: (TransferSource | undefined)[]): TripleConstruction | undefined {
  const [ subject, predicate, object ] = positions;
  if (subject === undefined || predicate === undefined || object === undefined) {
    // One position Θ cannot name is one statement that would be lost, and a transfer that no longer says
    // what the conjunction said - so nothing is transferred and the assertion stays above the EXTEND.
    return undefined;
  }
  return { subject, predicate, object };
}

/** The variables a source reads, which is what tells a BIND that its own target is one of them. */
export function variablesOfTransferSource(source: TransferSource): Set<string> {
  if (isTripleConstruction(source)) {
    return unionSets(triplePositions.map(position => variablesOfTransferSource(source[position])));
  }
  return targetIsAccess(source) ? new Set([ source.name ]) : termVars(source);
}

/**
 * Recognizes the conjuncts a `sameTerm` carries: `sameTerm(a, c)`, `sameTerm(c, a)`, the unification
 * `sameTerm(a, b)` - A⟨a ≡ b⟩, a strong assertion whose target is an access - and the *construction*
 * `sameTerm(?o, <<( ?a ?b ?c )>>)`, which decomposes into one conjunct per position.
 *
 * The construction is not written back as itself, and that is sound rather than sloppy: as *conjuncts of
 * a FILTER*, `sameTerm(?o, TRIPLE(?a,?b,?c))` and `sameTerm(SUBJECT(?o), ?a) && …` agree. They differ only
 * where one is `false` and the other an error - `?o` not a triple term, a component unbound, the
 * construction ill-typed - and a FILTER discards the row either way.
 *
 * Never generalise this to `=`: `?x = "01"^^xsd:integer` holds of the *term* `"1"^^xsd:integer`, so
 * substituting under `=` would drop solutions. An `=` against an IRI is the one place the two coincide,
 * and {@link constantFoldOperator} has already rewritten that into the `sameTerm` read here.
 */
function asStrongAssertion(expression: Algebra.Expression):
    (AssertionConjunct & { assertion: StrongAssertion })[] | undefined {
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
 *
 * Read through {@link asTransferSource}, so the two ways of writing a construction are the one fact -
 * `TRIPLE(?s, ?p, ?o)` is an operator and `<<( ?s ?p ?o )>>` parses to a term holding a quad, and a
 * condition should no more care which was typed than a BIND does. A construction *holding* one goes as
 * deep as it is written, since a conjunct is about an access and an access is a chain.
 *
 * A ground triple term is not one of these: it is a value, and the assertion is the ordinary pin to it.
 * Neither is a construction one position of which Θ cannot name - that would be a conjunct lost and a
 * conjunction no longer saying what the condition said, so the whole condition stays a residual instead
 * ({@link constructionOf}).
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

/** The conjuncts a construction states about the access it is equated to, a position at a time. */
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
 *
 * The four are one form because they are one fact: each narrows the range of the group `a` names to a
 * single term type, which is what the emptiness rules and the folds already read. `isTRIPLE` is the only
 * one with anything below it - the three positions of a shape - and that is a property of the *group*
 * rather than of this conjunct, which says nothing about the parts.
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
 * Recognizes the *weak* conjuncts a condition carries: `!bound(?x) || φ`, where `φ` is a strong assertion
 * about `?x` and about nothing else.
 *
 * The single-variable restriction is what makes the weak form exist at all (S4): `!bound(?o) ||
 * sameTerm(SUBJECT(?o), :a)` is one conjunct about one variable, where `sameTerm(SUBJECT(?o), ?s)` is an
 * edge between two of them and has no weak form (see {@link AssertionConjunction}). Reading such an edge
 * back as one would be exactly the unsound merge that form does not exist to avoid, so it stays a
 * residual condition instead.
 *
 * The target has to be a ground *term* for the same reason: `!bound(?o) || sameTerm(SUBJECT(?o),
 * OBJECT(?o))` does mention one variable only, but weakening a whole shape one edge at a time is not
 * something the conjunction can carry, so it too is left where it is.
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
          // Weak assertions, unlike strong, can only reference a single variable
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

/** Recognizes the conjuncts a single condition carries, in whichever of the forms they are written. */
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
 *
 * Keeping the solutions that leave `?x` unbound is what makes it usable on the RHS of a MINUS
 * (anti-monotone in that argument) and pushable through operations that may leave `?x` unbound.
 *
 * `φ` may read `?x` through an accessor, and an accessor of an unbound `?x` is an *error* rather than
 * `false`. That is exactly why this may only ever be placed as a filter condition (S1): a FILTER
 * identifies error with `false`, and `false || error` is still an error, so the row is dropped either
 * way - which is what the left disjunct then rescues.
 */
function weakenedExpression(c: TransformContext, name: string, strong: Algebra.Expression):
Algebra.Expression {
  return c.AF.createOperatorExpression('||', [ unboundAssertionAsExpression(c, name), strong ]);
}

/**
 * Creates the weak assertion W⟨a ≡ c⟩: `!bound(?x) || sameTerm(a, c)`.
 * Only works for simpleAccess. And single variable targets.
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
 *
 * Nothing new is ever serialised: every form is written back in the shape the recogniser above reads
 * straight back into the same state, which is what a conjunction round-tripping through a condition
 * means and what keeps a second run of the pass from stacking a second copy of what it derived.
 *
 * **Never as `sameTerm(?o, <<( … )>>)`** (S2): a shape is written one position at a time, by the
 * conjuncts {@link AssertionConjunction.conjuncts} decomposes it into, since the positions nobody named
 * have no variable that is bound where the condition sits.
 */
export function conjunctAsExpression(c: TransformContext, { access, assertion }: AssertionConjunct):
Algebra.Expression {
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
 * One conjunct of an {@link AssertionConjunction}: what it says about one access, or one edge between two.
 */
export interface AssertionConjunct {
  access: Access;
  assertion: Assertion;
}

/**
 * The variables a conjunct reads - two iff it is an edge between two of them, and one where both
 * of its sides read the same variable through different accessors.
 *
 * Everything that places a conjunct reads only this: (FJPush)'s side condition is quantified over
 * `vars(R)`, and the variables an accessor conjunct is about are the ones it reads *through*.
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
 * A⟨a ≡ c⟩ becomes W⟨a ≡ c⟩, T⟨?x⟩ becomes its weak self, and W and U are already that weak.
 * Unlike {@link weakenedTerms} this does not weaken the conjunct, rather it gives the weak version of it.
 * A weakened weak assertion does not exist while a weak assertion stays the same here.
 *
 * B⟨?x⟩ has no such form - weakening it means allowing the unbound case, and `¬b ∨ b` is `true` - and
 * neither has an edge between two accesses, for the reasons in {@link asWeakAssertion}. Both are
 * `undefined`: they do not travel at all, and have to stay where they are.
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
 * The component a triple term holds in a position, `undefined` for anything that is not a triple term.
 *
 * The graph is what tells the two apart: a triple term has none, so a quad carrying one is a generalised
 * statement rather than a term, and reading a position of it would answer for something no value is.
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
