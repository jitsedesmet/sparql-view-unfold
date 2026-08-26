import type * as RDF from '@rdfjs/types';
import { Algebra } from '@traqula/algebra-transformations-1-2';
import { AssertionClusterSet } from '../datastructures/AssertionClusterSet.js';
import type { PinChildren, TriplePosition } from '../datastructures/TermClusterSet.js';
import { childGroupsOf, triplePositions } from '../datastructures/TermClusterSet.js';
import type { RangeSet } from '../RangeSet.js';
import type { TransformContext } from '../transformContext.js';
import type { DerivedVarNamer } from '../utils.js';
import type {
  Access,
  AssertableTermType,
  Assertion,
  AssertionConjunct,
  Assertions,
  TransferSource,
} from './assertions.js';
import {
  access,
  accessId,
  compareAccesses,
  componentOf,
  assertableTermTypes,
  assertBound,
  asAssertionConjuncts,
  assertStrong,
  assertTermType,
  assertUnbound,
  assertWeak,
  conjunctAsExpression,
  variablesReadByConjunct,
  hasTarget,
  impliesBound,
  targetIsAccess,
  isBareAccess,
  isTripleConstruction,
  normalisedTarget,
  rangeOfTermType,
  sameAccessAs,
} from './assertions.js';
import type { CPMeta } from './certainlyBoundVars.js';
import { withCpVars } from './certainlyBoundVars.js';
import { booleanConstantOf, conjunctionOf, splitConjunction } from './expressionHelpers.js';
import type { AssertionView } from './partialExpressionEvaluation.js';
import { substituteInExpression } from './partialExpressionEvaluation.js';
import { DF } from './rdfDatatypes.js';

/**
 * @fileoverview The conjunction of assertions (Θ) the pushdown moves around, and how a filter condition
 * is read into one.
 *
 * `FILTER(sameTerm(?x, ?y))` constrains *two* variables at once, and a chain of such filters makes
 * a clique of variables that all have to be equal. So the carrier is a union-find ({@link TermClusterSet})
 * whose groups may be pinned, plus the two term-less forms (`bound` / `!bound`) which stay per variable.
 *
 * A pin is a term, or the **shape** of a triple term - three groups, one per position. That is what makes
 * `FILTER(sameTerm(SUBJECT(?o), ?s))` expressible: the shape sits on the *group*, so unifying `?o` with
 * `?x` makes everything known about `SUBJECT(?o)` known about `SUBJECT(?x)`, and a conjunct is about an
 * {@link Access} - a variable read through a chain of accessors - rather than about a variable.
 *
 * The dividing line, and the reason everything else stays simple:
 * a group **pinned to a term** still decomposes into independent single-variable conjuncts.
 * A group **without one** - a clique, or a shape whose positions are groups of their own - has to be
 * reasoned about as a whole, because its conjuncts mention two accesses each.
 */

/**
 * A set of assertions Θ, in the states an assertion about an access can be in:
 *
 * | state                                  | means                                             |
 * |----------------------------------------|---------------------------------------------------|
 * | strong member of a pinned group        | `sameTerm(?x, c)`                                 |
 * | weak member of a pinned group          | `!bound(?x) \|\| sameTerm(?x, c)`                 |
 * | member of an unpinned group (clique)   | `sameTerm(?x, ?rep)`                              |
 * | group with an asserted term type       | `isIRI(?x)`, `isBLANK(?x)`, `isLITERAL(?x)`, `isTRIPLE(?x)` |
 * | the same, asserted weakly              | `!bound(?x) \|\| is<τ>(?x)`                       |
 * | member of a shaped group               | one conjunct per position of the shape that says something |
 * | unbound                                | `!bound(?x)`                                      |
 * | bound                                  | `bound(?x)`, no term                              |
 *
 * Nothing new is serialised: every row is the form the parser reads straight back into the same state,
 * which is what {@link toExpression} and {@link collectAssertions} being inverses of each other means.
 *
 * A term type and a shape meet in one place. A shape narrows its group to `{Quad}` by *being* a triple
 * term, where `isTRIPLE(?x)` narrows it by saying so, and each makes the other add nothing - which is why
 * a shape writes `isTRIPLE(?x)` exactly when none of its positions says anything, and why the four
 * predicates are one form ({@link assertTermType}) rather than `isTRIPLE` being a shape of its own.
 * Only what a condition *asserted* is written back: that a subject holds no literal, or that a shaped
 * group holds a triple term, is derived, holds wherever the group is written, and is left unsaid
 * ({@link AssertionClusterSet}).
 *
 * **A shape is never written as `sameTerm(?o, <<( … )>>)`** (S2), only as one
 * `sameTerm(SUBJECT(?o), …)` per position that says something. The positions nobody named are *anonymous*
 * groups, and writing them out would mention variables that are unbound wherever the filter sits, so the
 * condition would error and drop every row.
 *
 * **Weak ⇔ sole member of a pinned group.** There is no usable weak form of a clique: cluster-level weak
 * ("all bound members pairwise `sameTerm`") does not distribute over a join - `μ₁={?x↦a}` and `μ₂={?y↦b}`
 * each satisfy it and their merge does not - and merging two independent weak edges is unsound
 * (`W⟨{x,y}⟩ ∧ W⟨{y,z}⟩ ⊭ W⟨{x,y,z}⟩`, take `?y` unbound). A pin is what makes the weak form work: a
 * value both sides of a join already agree on. So {@link asWeakenedConjunct} hands back nothing for an
 * edge, exactly as it does for B⟨?x⟩, and every operation that would put a second
 * named member into a group promotes the weak one first - which is why a group holding a weak member
 * holds nothing else, and why a shape reached through a weak root is read only through that root.
 *
 * **`unbound` and `bound` are disjoint from the groups**, as a consequence of the rules rather than by
 * construction: U⟨?x⟩ takes `?x` out of its group ({@link assertUnbound}) and B⟨?x⟩ is absorbed by a
 * membership that already implies it ({@link assertBound}).
 *
 * The `assert…` methods report a contradiction by returning `false` rather than raising: one variable
 * asserted to be two terms at once is an ordinary outcome, which the pass turns into the empty operation.
 * A conjunction they returned `false` for holds no meaningful state and has to be discarded.
 */
export class AssertionConjunction {
  /**
   * Variable to its group; a group may be pinned to the term or the shape all of its members equal.
   */
  private clusters: AssertionClusterSet;
  /**
   * Strength only applies to variables in groups. If you are not in a group, you are a stale leftover.
   * It is recorded per *root* variable: the accessor conjuncts about `?o` are exactly as strong as what
   * is known about `?o` itself, since reading a position of an unbound variable is an error.
   */
  private strength: Map<string, 'strong' | 'weak'>;
  /** U⟨?x⟩ */
  private unbound: Set<string>;
  /** B⟨?x⟩ */
  private bound: Set<string>;
  /**
   * The variables in the order they were first mentioned, used to keep a pass idempotent.
   */
  private order: Set<string>;

  public constructor() {
    this.clusters = new AssertionClusterSet();
    this.strength = new Map();
    this.unbound = new Set();
    this.bound = new Set();
    this.order = new Set();
  }

  /** The conjunction of the assertions of `conjuncts`, which never contradict when they come from one Θ. */
  public static of(conjuncts: Iterable<AssertionConjunct>): AssertionConjunction {
    const result = new AssertionConjunction();
    for (const { access, assertion } of conjuncts) {
      // A subset of a satisfiable conjunction is satisfiable, so this cannot fail for such a subset.
      result.assert(access, assertion);
    }
    return result;
  }

  /** A copy that shares no state with this one, so that either may be asserted into on its own. */
  public clone(): AssertionConjunction {
    const copy = new AssertionConjunction();
    copy.clusters = this.clusters.clone();
    copy.strength = new Map(this.strength);
    copy.unbound = new Set(this.unbound);
    copy.bound = new Set(this.bound);
    copy.order = new Set(this.order);
    return copy;
  }

  /** Takes over the state of a {@link clone} that an attempted assertion succeeded on. */
  private adopt(other: AssertionConjunction): void {
    this.clusters = other.clusters;
    this.strength = other.strength;
    this.unbound = other.unbound;
    this.bound = other.bound;
    this.order = other.order;
  }

  /** The variables the conjunction says something about, in the order it first met them. */
  private names(): string[] {
    return [ ...this.order ].filter(name => this.get(name) !== undefined);
  }

  /** How many variables the conjunction says something about. */
  public get size(): number {
    return this.names().length;
  }

  /**
   * What the conjunction says about one variable, read as a bare access.
   *
   * For a clique, the strong assertion to the representative is made; for the representative of one, and
   * for a variable a shape says nothing more about, the term-less form its membership entails.
   * What a *shape* says about the positions is not about this variable at all - it is about the groups
   * those positions name - so it is {@link conjuncts} rather than this that reports it.
   */
  public get(name: string): Assertion | undefined {
    if (this.unbound.has(name)) {
      return assertUnbound();
    }
    if (this.bound.has(name)) {
      return assertBound();
    }
    const group = this.clusters.groupOf(name);
    if (group === undefined) {
      return undefined;
    }
    const isStrong = this.strength.get(name) !== 'weak';
    const pin = this.clusters.pinOf(group);
    if (pin?.kind === 'term') {
      return isStrong ? assertStrong(pin.term) : assertWeak(pin.term);
    }
    const representative = this.representativeMemberOf(group);
    if (representative === undefined || representative === name) {
      const termType = this.assertedTermTypeOf(group);
      return termType === undefined ? assertBound() : assertTermType(termType, isStrong);
    }
    return assertStrong(access(representative));
  }

  /**
   * The kind of term **Θ itself** says the group holds, `undefined` where Θ says nothing about it.
   *
   * Two ways of saying it, and they are both Θ's: a condition asserted it outright (`isIRI(?x)`), or Θ
   * holds a shape for the group, which is a triple term by being one. A term pin is a third, decided by
   * the term before this is reached.
   *
   * What {@link TermClusterSet.rangeOf} additionally knows is *not* one of them, and reading it here is
   * the mistake this exists to avoid: the range is narrowed by the position the group sits in and by what
   * the operation leaves the variables in it, which are facts of the plan Θ is being written into rather
   * than facts of Θ. `?x ≡ PREDICATE(?o)` leaves the group at `{IRI}` without anyone having asserted it -
   * reporting that would have Θ claim an assertion it never carried, and would put {@link get} at odds
   * with the conjuncts Θ decomposes into, which state only what was asserted.
   */
  private assertedTermTypeOf(group: number): AssertableTermType | undefined {
    if (this.clusters.childrenOf(group) !== undefined) {
      return 'Quad';
    }
    const asserted = this.clusters.assertedRangeOf(group);
    return asserted.size === 1 ?
      assertableTermTypes.find(termType => asserted.has(termType)) :
      undefined;
  }

  /**
   * The independent conjuncts Θ decomposes into: one per reading of every group it can reach from a named
   * variable, plus the two term-less forms.
   *
   * The *readings* of a group are the ways of naming its value: a variable that is a member of it, or a
   * position of a shape that holds it, read from the representative of the group holding that shape. A
   * group with several readings states that they are equal - which for a clique is the star from its
   * representative, and for `sameTerm(SUBJECT(?o), ?s)` is that one edge. All of them point at the
   * *representative*, the reading that names the value most directly (a member before a position,
   * lexicographic within that), so that the same Θ always decomposes the same way and a re-run of the
   * pass absorbs what it finds instead of stacking it.
   *
   * Splitting a clique means splitting its *edges*, never its variables: a clique is transitively closed,
   * so any spanning tree of it is equivalent to the whole, and what a caller pushes plus what it keeps has
   * to span it. Dropping the representative's own (empty) conjunct is what makes that work out: the edges of the
   * star already entail B⟨?rep⟩.
   *
   * A shape adds T⟨representative⟩ only where no position of it says anything - reading a position already
   * entails that what it is read from is a triple term, so `isTRIPLE(?o) && sameTerm(SUBJECT(?o), :a)`
   * would state the same thing twice and stop the pass being idempotent.
   */
  public conjuncts(): AssertionConjunct[] {
    const accessesPerGroup = this.readingsPerGroup();
    const result: AssertionConjunct[] = [];
    const emitted = new Set<number>();

    const emit = (group: number): void => {
      const resolved = this.clusters.resolveGroup(group);
      if (!emitted.has(resolved) && accessesPerGroup.has(resolved)) {
        emitted.add(resolved);
        result.push(...this.groupConjuncts(resolved, accessesPerGroup));
        for (const child of childGroupsOf(this.clusters.childrenOf(resolved))) {
          emit(child);
        }
      }
    };

    for (const name of this.order) {
      if (this.unbound.has(name)) {
        result.push({ access: access(name), assertion: assertUnbound() });
      } else if (this.bound.has(name)) {
        result.push({ access: access(name), assertion: assertBound() });
      } else {
        const group = this.clusters.groupOf(name);
        if (group !== undefined) {
          emit(group);
        }
      }
    }
    return result;
  }

  /**
   * The conjuncts of Θ about one access alone: what it is fixed to, which kind of term it is, whether it
   * is bound. Everything but an *edge*, which is what a rule cannot decide by looking at one access.
   *
   * Exactly the conjuncts reading a single variable, and for the one reason: two of them only ever come
   * of one access being fixed to another, an access having a single root.
   */
  public unaryConjuncts(): AssertionConjunct[] {
    return this.conjuncts().filter(conjunct => !isEdgeConjunct(conjunct));
  }

  /**
   * Every group Θ names more than one way, each as its {@link Access | readings}, representative first -
   * the conjuncts of {@link conjuncts} a rule cannot take one at a time.
   *
   * A *reading* names the value of a group: a variable in it, or a position of a shape, read from the
   * representative of the group holding that shape. Several of them is the statement that they are equal, which
   * for a group of variables is a clique and for `sameTerm(SUBJECT(?o), ?s)` is that one edge - and the
   * two are one thing here, since a group reached both as `?s` and as `SUBJECT(?o)` says that equality
   * exactly as two variables in one group do.
   *
   * A rule that decided per reading would split such a group into pieces that no longer say it, so it
   * decides per group and splits the *edges* instead ({@link splitClique}): a group is transitively
   * closed, so any spanning tree of it is equivalent to the whole, and what a rule pushes plus what it
   * keeps has to span it again.
   *
   * A group pinned to a *term* is not one of them: every reading of it is that term, which already states
   * that they are equal, so each writes a conjunct of its own and no edge is left to split.
   */
  public equatedReadings(): Access[][] {
    const result: Access[][] = [];
    for (const [ group, readings ] of this.readingsPerGroup()) {
      if (this.clusters.pinOf(group)?.kind !== 'term' && readings.length > 1) {
        result.push(readings);
      }
    }
    return result;
  }

  /**
   * Splits Θ in two along `predicate` callback:
   * when all variables in an {@link AssertionConjunct} match the predicate, they are in 'inside'.
   * The two are equivalent to the whole, since together they hold every conjunct (under simple conjunct-UNION).
   */
  public split(predicate: (name: string) => boolean): { inside: AssertionConjunction; outside: AssertionConjunction } {
    const inside: AssertionConjunct[] = [];
    const outside: AssertionConjunct[] = [];
    for (const conjunct of this.conjuncts()) {
      (variablesReadByConjunct(conjunct).every(predicate) ? inside : outside).push(conjunct);
    }
    return { inside: AssertionConjunction.of(inside), outside: AssertionConjunction.of(outside) };
  }

  /**
   * The variables Θ entails `bound(?x)` of.
   *
   * Every member of a clique is one of them, and so is every variable a shape reaches - a triple term is
   * bound, and so is each of its positions (S5) - which is what lets a structural assertion decide the
   * rules the strong form decides, the OPTIONAL → JOIN collapse above all, even where the edge itself
   * cannot travel.
   */
  public boundImpliedBy(): Set<string> {
    const result = new Set<string>();
    for (const name of this.names()) {
      const assertion = this.get(name);
      if (assertion !== undefined && impliesBound(assertion)) {
        result.add(name);
      }
    }
    return result;
  }

  /**
   * The substitution the strong assertions stand for, in the form the `substituteIn…` helpers take: a
   * pinned member maps to its term, a clique member to the representative of its clique, and a member of
   * a shaped group to the triple term that shape is - written out of the variables that already read its
   * positions, and undecided where a position is read by nothing at all.
   *
   * Dropping the other forms is the point: substituting `c` for `?x` under W⟨?x ≡ c⟩ would claim `?x` is
   * bound, and B⟨?x⟩ and U⟨?x⟩ have no term to substitute.
   *
   * Everything it writes is something already written elsewhere, which is what makes it usable outside a
   * pattern where S3 rules the *materialised* shape out ({@link intoPattern}): every variable it names
   * already reads the group it stands for, so it is bound wherever the value it rebuilds is. That is
   * also what takes a variable out of a VALUES no single column holds the value of - under
   * A⟨?o ≡ <<( ?s ?p ?x )>>⟩ the column `?o` goes and `BIND(<<( ?s ?p ?x )>> AS ?o)` rebuilds it from
   * the three that stay.
   */
  public rebuildingSubstitution(): Assertions {
    return this.strongMembersReplacedBy(group => this.termDecidedByPin(group, (undecided) => {
      const representative = this.representativeMemberOf(undecided);
      return representative === undefined ? undefined : DF.variable(representative);
    }));
  }

  /**
   * What a *pattern* takes of Θ, and what it leaves behind: the two halves of one decision, which is why
   * they are decided together off the one set of values written for the groups.
   *
   * The substitution is {@link rebuildingSubstitution} with the shapes written out further:
   * a member of a shaped group maps to the triple term that shape is, its positions filled in with the
   * terms they are pinned to, the variables that name them, and a variable coined for each position
   * nothing names (D4).
   *
   * That last part is why this may only go into a pattern (S3). `<<( ?s ?o_p ?o_o )>>` in an object
   * position *binds* `?o_p` and `?o_o` - the pattern is what gives the coined variables a value, and the
   * re-binding `BIND(<<( ?s ?o_p ?o_o )>> AS ?o)` below it hands `?o` back the value it had. The same
   * term in a condition would read two variables nothing has bound and error away every row.
   *
   * A shape *no* position of which names anything is left alone ({@link shapeIsWorthWriting}): writing
   * it coins three variables to say only that the value is a triple term, which is what T⟨?x : Quad⟩
   * already says without coining anything, and which is the form the very same fact takes when it
   * arrives as `isTRIPLE(?x)` rather than through an accessor. Below a shape that *is* written, every
   * nested one is written with it - there the three variables cost nothing beyond what the position they
   * sit in already writes.
   *
   * The residual is what the pattern that substitution builds does **not** state, read off the *value the
   * pattern holds* at each side of a conjunct rather than off the form of the conjunct - which is what
   * keeps the two halves in step as more of Θ becomes writable:
   *
   * - an equality holds where both sides are written, whatever they are written as - the same term
   *   twice, or the same variable twice, which is the join compatibility a repeated variable in a BGP
   *   already enforces;
   * - T⟨a : Quad⟩ holds where `a` is written as a triple term - the three positions of a materialised
   *   shape *are* the assertion that it is one;
   * - T⟨a : τ⟩ for any other kind does not, a position holding a variable saying nothing about which
   *   kind of term that variable takes. It is written back over the pattern - and *against the values
   *   the pattern holds* rather than against the accesses Θ reads them by, which is what `asWritten` is
   *   for: `isIRI(SUBJECT(?o))` becomes `isIRI(?o_s)`, a condition over a variable the pattern binds
   *   rather than an accessor over one only the re-binding above it does, and one an engine can push
   *   into the scan.
   *
   * The forms that say a variable is *not* bound to something (W and U), and B⟨?x⟩ which names no value
   * at all, are never written into a pattern and so always stay. None of them ever reaches one -
   * {@link normalisedFor} promotes or prunes all three against the `cVars` of a leaf that binds every
   * variable it has - but the rule is about what the pattern enforces, not about what happens to arrive.
   *
   * `asWritten` is that last part: what the residual has to be *read against* once the pattern holds the
   * values, as a substitution over the condition it writes rather than over Θ itself. Θ keeps saying
   * `OBJECT(?o)` where the plan will say `?o_o`, and the two meet only when the condition is written.
   *
   * Not because a coined name may never reach Θ - it does, later in this same traversal and by the
   * ordinary route: the condition written here is read back as the pass carries on past it, and `?o_o`
   * enters Θ from it like any other variable of the plan, checked against the very pattern that binds
   * it. That is the rule D6 is really about, and writing the name down rather than injecting it is what
   * keeps to it: **a name enters Θ only from a condition read against the operation it is about**, never
   * from a rewrite that knows what it is *going* to write.
   *
   * The substitution has to be over the condition for two reasons of its own, either of which would sink
   * a Θ built over the coined names:
   *
   * - **Some of the residual stops being a conjunct at all.** `bound(?o_p)` over the pattern that writes
   *   `?o_p` is `true`, and Θ has no state for that - it would write `BOUND(?o_p)` back out, and the next
   *   run would delete it, which is the pass failing to be a fixpoint over its own output. An access can
   *   equally resolve to a *term* (`SUBJECT(?o)` to `:a`), and a conjunct of Θ is never about a term.
   * - **A coined name in a group would state what the pattern states.** `?o_o` put into the group
   *   `OBJECT(?o)` names makes {@link conjuncts} write the edge `sameTerm(OBJECT(?o), ?o_o)` - the thing
   *   the pattern already says, said a second time. Avoiding that means rebuilding Θ over fresh accesses,
   *   which is this substitution again, only without the folds that come free on an expression (S7).
   *
   * @param namer - Coins the variable for a position, once per position and query ({@link derivedVarNamer}).
   */
  public intoPattern(namer: DerivedVarNamer): {
    substitution: Assertions;
    residual: AssertionConjunction;
    asWritten: AssertionView;
  } {
    const values = this.patternValues(namer);
    return {
      substitution: this.strongMembersReplacedBy(group => values.get(group)),
      residual: AssertionConjunction.of(this.conjuncts()
        .filter(conjunct => !this.enforcedByPattern(conjunct, values))),
      // TODO: why do we need this? I thought we concluded that coining the variables indeed break cVars/ pVars
      //  and thus we need not wory about what we coined exactly?
      //  D6 can happen while passing an expression because we already know at the time of passing the expression
      //  what variable can and will be coined to represent e.g. subject(?o)
      // No `typeRange`: the kinds of term are what the residual is *about* here, and what the pattern
      // decided about one has already taken the conjunct out of the residual.
      asWritten: { resolve: access => this.patternValueOf(access, values), bound: this.boundImpliedBy() },
    };
  }

  /**
   * The substitution replacing every strong member by what `valueOf` makes of its group, which is the
   * one thing the two substitutions above differ in.
   *
   * Only the strong members: substituting `c` for `?x` under W⟨?x ≡ c⟩ would claim `?x` is bound, and
   * B⟨?x⟩ and U⟨?x⟩ have no term to substitute. And never a variable standing for itself - the
   * representative of its own group is already written where it is, and re-binding it below would be the
   * `BIND(?x AS ?x)` the algebra raises on.
   */
  private strongMembersReplacedBy(valueOf: (group: number) => RDF.Term | undefined): Assertions {
    const result = new Map<string, RDF.Term>();
    for (const name of this.names()) {
      const group = this.clusters.groupOf(name);
      if (group !== undefined && this.strength.get(name) === 'strong') {
        const value = valueOf(group);
        if (value !== undefined && (value.termType !== 'Variable' || value.value !== name)) {
          result.set(name, value);
        }
      }
    }
    return result;
  }

  /**
   * What Θ decides about the *expressions* it is substituted into, which is strictly less than what it
   * knows: the term an access is fixed to, whether an access is a triple term, and which variables are
   * bound.
   *
   * A shape may not be substituted into an expression at all (S3) - its anonymous positions are unbound
   * wherever the condition sits - so what travels is only what folds to a term: a ground pin, the ground
   * triple term a fully decided shape is, and the variable that reads a group most directly, which is
   * what turns the very condition an assertion was read from into `true` when the pass runs again.
   */
  public expressionSubstitution(): AssertionView {
    return {
      bound: this.boundImpliedBy(),
      resolve: access => this.substitutionFor(access),
      typeRange: access => this.strength.get(access.name) === 'strong' ? this.rangeKnownFor(access) : undefined,
    };
  }

  /**
   * Reads Θ in terms of what an operation binds - `undefined` when it makes that operation empty.
   *
   * Where `?x` is certainly bound, `!bound(?x)` is unsatisfiable, so W *is* A, B is `true` and U is empty;
   * where `?x` can never be bound, A and B are empty ((FBndII)) and W and U are simply `true`.
   *
   * The ranges decide the same two things one level finer, which is why every rule below reads them
   * rather than the scope:
   *
   * - A variable whose range is *empty* is never bound, exactly as one out of scope is never bound -
   *   {@link VRanges.neverBinds} is the single fact both are - so A and B empty the operation by (FBndII)
   *   while W and U are carried by their `!bound(?x)` disjunct and prune away.
   * - A variable pinned to something outside a range that is *not* empty - `?g ≡ "1"` under a `GRAPH ?g`,
   *   `?p ≡ _:b` in a predicate position, a *shape* anywhere but an object position - cannot be bound to
   *   it, which is the same fact for one term rather than for all of them. **Strong** is then
   *   unsatisfiable, since it implies `bnd(?x)`; **weak** loses its right disjunct and becomes exactly
   *   U⟨?x⟩. Which is why the rewrites downstream need no term-type checks of their own.
   *
   * A strong member narrows its *group*, rather than only being checked against it: its value is the
   * group's value, so what the plan leaves for the variable is what it leaves for every reading of the
   * group - which is what confines the nesting of shapes to the `object` chain, a shape in a subject
   * position being the same contradiction a Literal there is.
   *
   * Per member of a group, not per group: a group whose members disagree about being in `cVars` is
   * perfectly ordinary. Taking a member out may leave its group with a single variable and nothing for it
   * to equal, which {@link TermClusterSet.remove} then drops.
   *
   * Reading a clique per member is not an approximation of a per-clique rule. Every member of one carries
   * A⟨?x ≡ ?rep⟩, which entails `bnd(?x)` of that member alone, and both rules are about exactly that: a
   * member out of scope empties the operation by (FBndII) - which is the clique's own emptiness check,
   * since the clique entails `bnd` of each of them - and `cVars` has nothing to promote an edge into,
   * there being no form of one weaker than itself.
   *
   * Coverage - whether something below binds enough of a clique to be handed its edges - is not decided
   * here. This reads the conjunction against the single operation the filter sits on, before the swap;
   * the swap is what splits the edges over the branches it has licences for.
   */
  public normalisedFor({ cVars, vRanges }: CPMeta): AssertionConjunction | undefined {
    const result = this.clone();
    for (const name of this.names()) {
      if (this.unbound.has(name)) {
        if (cVars.has(name)) {
          // Contradiction
          return undefined;
        }
        if (vRanges.neverBinds(name)) {
          // `!bound(?x)` holds of every solution here, so nothing is left to assert.
          result.unbound.delete(name);
        }
      } else if (this.bound.has(name)) {
        // Contradiction -- (FBndII), which every form implying `bound(?x)` triggers.
        if (vRanges.neverBinds(name)) {
          return undefined;
        }
        if (cVars.has(name)) {
          result.bound.delete(name);
        }
      } else if (vRanges.neverBinds(name)) {
        if (this.strength.get(name) === 'strong') {
          return undefined;
        }
        // Never bound and weak -> the `!bound(?x)` disjunct carries it, so nothing to assert.
        result.removeMember(name);
      } else {
        if (cVars.has(name)) {
          // B⟨?x⟩ holds of every solution here, and completes a weak member into a strong one.
          result.strength.set(name, 'strong');
        }
        const group = result.clusters.groupOf(name);
        if (group !== undefined) {
          // A member of a group the variable can never be, which both forms have something to say about -
          // the same rule as (FBndII) one level down the lattice, the variable being in scope here and no
          // solution binding it to *this* value. Read off `result`, so a promotion just above counts.
          if (result.strength.get(name) === 'strong') {
            // A⟨?x ≡ v⟩ implies `bnd(?x)`, so what the plan leaves for `?x` is what it leaves for the group.
            // We need to do this e.g. in case the var just became strong,
            //   and we do it here since we need a 'isValid' check regardless.
            if (!result.clusters.narrowRange(group, vRanges.rangeOf(name))) {
              return undefined;
            }
          } else if (!admitsRange(result.clusters, group, vRanges.rangeOf(name))) {
            // W⟨?x ≡ v⟩ is `¬bnd(?x) ∨ ?x ≡ v`, and the right disjunct is false wherever `?x` is bound. So
            // the weak form *is* U⟨?x⟩ here - which is worth doing rather than leaving it: a weak member
            // says almost nothing, where `!bound(?x)` is a constraint the rest of the pass acts on.
            // Cannot fail: `?x` is neither `bound` nor a strong member, the two states it rejects.
            result.assertUnbound(name);
          }
        }
      }
    }
    return result;
  }

  /**
   * Θ with `name` taken out of it and whatever it said about it restated against `replacement` - what
   * carries its value where the result is going, which the caller is responsible for establishing.
   *
   * For a BIND, that is its expression: below `BIND(?z AS ?t)` it is `?z` that holds what `?t` holds
   * above, and below `BIND(:c AS ?t)` it is `:c`. Three cases, which are the same rule read against the
   * three kinds of thing a {@link TransferSource} can be:
   *
   * - an *access* takes over everything the group holds - the term it is pinned to, the shape it has, and
   *   the edges to its other members - which for a bare variable is joining that group, and for
   *   `SUBJECT(?o)` is the same after opening the shape of `?o` on the way to it;
   * - a *term* is what the group has to be, which either agrees with what it already was - decomposing
   *   against a shape, position by position - or makes the whole thing empty;
   * - a *construction* is the shape itself: `BIND(<<( ?a ?b ?c )>> AS ?o)` says that the value has
   *   `?a`, `?b` and `?c` in its positions, so everything the group said about a position is restated
   *   about the variable holding it, and `sameTerm(SUBJECT(?o), :a)` reaches the pattern binding `?a` as
   *   `sameTerm(?a, :a)`.
   *
   * Taking the variable out one member at a time, rather than dropping every conjunct that mentions it,
   * is what keeps the rest of its group intact when it happens to be the representative all of the edges
   * point at, or the only variable a shape is reached through.
   *
   * U⟨?x⟩ is simply removed and stays where the caller put it - it is about the EXTEND's own binding
   * rather than about what the expression yields. B⟨?x⟩ is *not*: it says the expression produced a
   * value, which for the source is that reading it yields one - `bnd(?z)` for a variable it copies, and
   * for `SUBJECT(?o)` that `?o` is a triple term at all. Dropping it instead loses the one thing the
   * assertion said, and with it the solutions where the expression errored.
   */
  public transferred(name: string, replacement: TransferSource): AssertionConjunction | undefined {
    const result = this.clone();
    const wasBound = result.bound.delete(name);
    result.unbound.delete(name);
    if (wasBound && !result.assertReadingYieldValue(replacement)) {
      return undefined;
    }
    if (result.clusters.groupOf(name) === undefined) {
      return result;
    }
    // The replacement takes over before `name` leaves, so that a group nothing else names does not go
    // away between the two - with it, the shape it carries and the anonymous groups that shape holds.
    if (!result.assertRestatedOn(access(name), replacement)) {
      return undefined;
    }
    result.removeMember(name);
    return result;
  }

  /**
   * Restates on the source what Θ holds about the access being transferred away.
   *
   * A construction is taken apart rather than met as a whole, which is the one thing that makes it
   * different from the two kinds of value: what it hands down is a statement per position, and a
   * position that is a construction of its own hands down three more.
   */
  private assertRestatedOn(access: Access, source: TransferSource): boolean {
    if (isTripleConstruction(source)) {
      return triplePositions.every(position =>
        this.assertRestatedOn(wrapAccess(access, position), source[position]));
    }
    // A⟨read ≡ source⟩ is what a value carrying another's is, so it is asserted as one - which also
    // spells a variable the single way Θ holds one, as the access reading it.
    return this.assert(access, assertStrong(source));
  }

  /**
   * Conjoins what the source has to satisfy for reading it to yield a value at all, which is what
   * B⟨?x⟩ on a transferred target comes to.
   *
   * A ground term is one by being one. An access says that what it reads *through* is a triple term,
   * which for a bare variable is `bnd(?x)` - both of which asserting `a ≡ a` already is. A construction
   * that yields a value is one every position of which does, since it raises where a component is
   * unbound.
   */
  private assertReadingYieldValue(source: TransferSource): boolean {
    if (isTripleConstruction(source)) {
      return triplePositions.every(position => this.assertReadingYieldValue(source[position]));
    }
    const access = normalisedTarget(source);
    return !targetIsAccess(access) || this.assertUnify(access, access);
  }

  /**
   * Conjoins one assertion about one access, in whichever of the states it is.
   *
   * The inverse of {@link conjuncts}: a strong assertion whose target is an access is the view of an edge,
   * and reading it back unifies the two groups.
   * @return false on contradiction
   */
  public assert(access: Access, assertion: Assertion): boolean {
    switch (assertion.subType) {
      case 'unbound': {
        return this.assertUnbound(rootVarOfBare(access, 'unbound'));
      }
      case 'bound': {
        return this.assertBound(rootVarOfBare(access, 'bound'));
      }
      case 'termType': {
        return this.assertTermType(access, assertion.termType, assertion.strong);
      }
      case 'strong': {
        return targetIsAccess(assertion.term) ?
          this.assertUnify(access, assertion.term) :
          this.assertPin(access, assertion.term, true);
      }
      case 'weak': {
        // A weak *edge* is not a state this can be in (weak ⇔ pinned group), and neither the recognisers
        // nor {@link asWeakenedConjunct} ever produce one, so the target of a weak assertion is a term.
        if (targetIsAccess(assertion.term)) {
          return true;
        }
        return this.assertPin(access, assertion.term, false);
      }
    }
  }

  /**
   * Conjoins A⟨?x ≡ c⟩ (`strong`) or W⟨?x ≡ c⟩ (`weak`), pinning the group of `?x` to `c`.
   *
   * Pinning is per *group*: a term meeting a clique fixes every member of it, which is how an assertion
   * met above a unification travels onto all of the variables it unified.
   * @returns `false` when the assertion contradicts what is already known.
   */
  public assertTerm(name: string, term: RDF.Term, strong: boolean): boolean {
    return this.assertPin(access(name), term, strong);
  }

  /**
   * Conjoins A⟨a ≡ c⟩ or W⟨a ≡ c⟩ for an arbitrary access, which pins the group that access names.
   *
   * Reading `a` through an accessor is what shapes the groups on the way: `SUBJECT(?o) ≡ :a` says that
   * `?o` is a triple term as much as it says what its subject is, and under the weak form it says both
   * only where `?o` is bound at all.
   */
  public assertPin(access: Access, term: RDF.Term, strong: boolean): boolean {
    return this.narrowing(access, strong, (clusters, group) => clusters.setTerm(group, term));
  }

  /**
   * Conjoins T⟨a : τ⟩ - `isIRI(a)`, `isBLANK(a)`, `isLITERAL(a)`, `isTRIPLE(a)` - or its weak form,
   * narrowing the group `a` names to the one kind of term it may hold.
   *
   * It is only the *range* of the group, even for a triple term: which positions that triple term has is
   * the business of the accesses that read them, and `isTRIPLE(?o)` says nothing about any of them. The
   * shape follows from the range wherever one is needed - {@link TermClusterSet.assertTriplePin} narrows
   * to the same `{Quad}` - so the two never disagree.
   */
  public assertTermType(access: Access, termType: AssertableTermType, strong: boolean): boolean {
    return this.narrowing(access, strong, (clusters, group) =>
      clusters.assertTermTypeRange(group, rangeOfTermType(termType)));
  }

  /**
   * Conjoins something that narrows the *group* an access names, which is what both of the forms above
   * are: opening the shapes on the way to the access, and then narrowing what the group it names may be.
   *
   * The strength decides which of the two ways that is conjoined, and nothing else does: strongly, the
   * root is known bound and the narrowing simply holds; weakly, it is `¬bnd(?x) ∨ φ`, and a `φ` the
   * group cannot hold comes to U⟨?x⟩ rather than to a contradiction ({@link assertWeakly}).
   *
   * `narrow` is what to do to the group the access names, once every shape on the way to it is asserted.
   * It takes the clusters of the conjunction it is applied to, which is a *copy* of this one wherever the
   * weak form has to try the narrowing before committing to it.
   */
  private narrowing(
    access: Access,
    strong: boolean,
    narrow: (clusters: AssertionClusterSet, group: number) => boolean,
  ): boolean {
    function apply(target: AssertionConjunction): boolean {
      const group = target.assertAccessAndResolve(access);
      if (group === false) {
        return false;
      }
      return narrow(target.clusters, group);
    }
    return strong ? this.assertStrongly(access.name, apply) : this.assertWeakly(access.name, apply);
  }

  /**
   * Conjoins A⟨a ≡ b⟩: `sameTerm(a, b)`, merging the two groups into one.
   *
   * The edge implies both sides are bound, which is not an extra rule but the reason U contradicts it and
   * a weak member meeting it is promoted - so it is asserted as such, before the merge.
   */
  public assertUnify(left: Access, right: Access): boolean {
    if (sameAccessAs(left, right)) {
      // `sameTerm(a, a)` says only that `a` is bound - which for a bare variable is B⟨?x⟩, and for an
      // accessor is that what it reads *through* is a triple term. Not that `a` itself is one: opening
      // the access shapes every group on the way to it and leaves the group it names alone.
      return isBareAccess(left) ?
        this.assertBound(left.name) :
        this.assertStrongly(left.name, target => target.assertAccessAndResolve(left) !== false);
    }
    this.remember(left.name);
    this.remember(right.name);
    if (!this.assertBound(left.name) || !this.assertBound(right.name)) {
      return false;
    }
    // Both are about to be group members, and B⟨?x⟩ is disjoint from those.
    this.bound.delete(left.name);
    this.bound.delete(right.name);
    this.strength.set(left.name, 'strong');
    this.strength.set(right.name, 'strong');
    const leftGroup = this.assertAccessAndResolve(left);
    const rightGroup = this.assertAccessAndResolve(right);
    if (leftGroup === false || rightGroup === false) {
      return false;
    }
    return this.clusters.unifyGroups(leftGroup, rightGroup);
  }

  /** Conjoins B⟨?x⟩: `bound(?x)`. */
  public assertBound(name: string): boolean {
    this.remember(name);
    if (this.unbound.has(name)) {
      // Contradiction
      return false;
    }
    const group = this.clusters.groupOf(name);
    if (group !== undefined) {
      // Absorbed by a strong member, and completes a weak one - `b ∧ (¬b ∨ ?x ≡ c) ≡ ?x ≡ c`.
      this.strength.set(name, 'strong');
      return true;
    }
    this.bound.add(name);
    return true;
  }

  /** Conjoins U⟨?x⟩: `!bound(?x)`. */
  public assertUnbound(name: string): boolean {
    this.remember(name);
    if (this.bound.has(name)) {
      // Contradiction
      return false;
    }
    const group = this.clusters.groupOf(name);
    if (group !== undefined) {
      // A strong member implies `bnd(?x)`; a weak one is absorbed (`¬b ∧ (¬b ∨ φ) ≡ ¬b`) and leaves the
      // group. U never propagates to the other members - it is about this variable only.
      if (this.strength.get(name) === 'strong') {
        return false;
      }
      this.removeMember(name);
    }
    this.unbound.add(name);
    return true;
  }

  /** The single condition the (non-empty) conjunction stands for, each conjunct in the form it carries. */
  public toExpression(c: TransformContext): Algebra.Expression {
    return conjunctionOf(c, this.conjuncts().map(conjunct => conjunctAsExpression(c, conjunct)));
  }

  /**
   * Conjoins a form that implies `bnd(?x)` of the root it is about.
   *
   * That is what rules U out, absorbs B, and makes the member strong - all three before `apply` runs, so
   * that the shapes it opens on the way are opened on a root already known to be bound.
   */
  private assertStrongly(root: string, apply: (target: AssertionConjunction) => boolean): boolean {
    this.remember(root);
    if (this.unbound.has(root)) {
      return false;
    }
    this.bound.delete(root);
    this.strength.set(root, 'strong');
    return apply(this);
  }

  /**
   * Conjoins the weak form `¬bnd(?x) ∨ φ` of something about the root `?x`.
   *
   * Three of the four cases are absorptions: U absorbs it outright (`¬b ∧ (¬b ∨ φ) ≡ ¬b`), and anything
   * already implying `bnd(?x)` - B⟨?x⟩, or a membership that entails it - rules the left disjunct out and
   * promotes it (`b ∧ (¬b ∨ φ) ≡ φ`).
   *
   * The fourth is why this runs on a copy. `φ` contradicting what is known does *not* make the
   * conjunction empty: `¬b ∨ φ` with `φ` false is `¬b`, so two weak assertions that cannot both hold come
   * to U⟨?x⟩ - which is how `FILTER(!bound(?x))` most often arises in the first place. There is no way to
   * ask a pin lattice whether a merge would have succeeded without doing it, and a merge that fails
   * leaves it in a state no caller may read, so the merge is done on a clone and adopted only if it held.
   */
  private assertWeakly(root: string, apply: (target: AssertionConjunction) => boolean): boolean {
    this.remember(root);
    if (this.unbound.has(root)) {
      return true;
    }
    if (this.bound.has(root) || this.strength.get(root) === 'strong') {
      return this.assertStrongly(root, apply);
    }
    const attempt = this.clone();
    attempt.strength.set(root, 'weak');
    // If adding the assertion fails, we know we can only be unbound
    if (apply(attempt)) {
      this.adopt(attempt);
      return true;
    }
    return this.assertUnbound(root);
  }

  /**
   * An access that is not a plain variable needs to assert a chain of groups and
   * thereby create the group the access refers to. Asserting them is the point rather than a side
   * effect: reading a position of something is what says that something is a triple term.
   * @returns `false` when one of those shapes contradicts what the group already holds.
   *   Otherwise, the group the access represents.
   */
  private assertAccessAndResolve(access: Access): number | false {
    let group = this.clusters.getGroup(access.name);
    for (const position of access.positions) {
      const children = this.clusters.assertTriplePin(group);
      if (children === false) {
        return false;
      }
      group = children[position];
    }
    return group;
  }

  /** The group an access names, without asserting anything - `undefined` when Θ does not name it yet. */
  private resolveAccess(access: Access): number | undefined {
    let group = this.clusters.groupOf(access.name);
    for (const position of access.positions) {
      if (group === undefined) {
        return undefined;
      }
      const children = this.clusters.childrenOf(group);
      if (children === undefined) {
        return undefined;
      }
      group = children[position];
    }
    return group;
  }

  /** The conjuncts one group of Θ contributes, given how the whole of it can be read. */
  private groupConjuncts(group: number, accessesPerGroup: Map<number, Access[]>): AssertionConjunct[] {
    const accesses = accessesPerGroup.get(group)!;
    const pin = this.clusters.pinOf(group);
    const result: AssertionConjunct[] = [];
    if (pin?.kind === 'term') {
      // Every reading is that term, which already says they are equal to each other.
      return accesses.map(access => ({
        access,
        assertion: this.isStrong(access) ? assertStrong(pin.term) : assertWeak(pin.term),
      }));
    }
    const [ representative, ...rest ] = accesses;
    for (const access of rest) {
      result.push({ access, assertion: assertStrong(representative) });
    }
    const termType = this.termTypeToState(group, accessesPerGroup);
    if (termType !== undefined) {
      result.push({ access: representative, assertion: assertTermType(termType, this.isStrong(representative)) });
    } else if (result.length === 0 && isBareAccess(representative) && this.clusters.childrenOf(group) === undefined) {
      // A group of one, with nothing for that one to equal: all that is left of it is that it is bound.
      // A shape is never that - what it holds says everything this would - and neither is a position of
      // one nobody else names, `bnd` of which is not even expressible, `BOUND` taking a variable.
      result.push({ access: representative, assertion: assertBound() });
    }
    return result;
  }

  /**
   * The kind of term the group has to be *told* to be, `undefined` when nothing has to be told.
   *
   * Only what is not already entailed by the rest of what the group writes out: a term pin says which
   * kind of term it is by saying which term it is, and so does any position of a shape that says
   * something of its own - reading a position entails that what it is read through is a triple term.
   * Restating either would say the same thing twice and stop the pass being idempotent.
   *
   * A shape *nothing* says anything about is the one case where the group has to say it itself, and it
   * is a triple term by being one at all rather than by anyone having asserted it.
   */
  private termTypeToState(group: number, accessesPerGroup: Map<number, Access[]>): AssertableTermType | undefined {
    if (this.clusters.pinOf(group)?.kind === 'term') {
      return undefined;
    }
    if (this.clusters.childrenOf(group) !== undefined) {
      // I have kids, so I should assert that if they don't speak up
      return this.shapeIsWitnessed(group, accessesPerGroup) ? undefined : 'Quad';
    }
    const asserted = this.clusters.assertedRangeOf(group);
    return asserted.size === 1 ? assertableTermTypes.find(termType => asserted.has(termType)) : undefined;
  }

  /**
   * Whether a position of the shape says something of its own, in which case T⟨representative : Quad⟩ need not be
   * stated: reading a position already entails that what it is read through is a triple term.
   *
   * "Says something" is asked of the position by writing it out, rather than by listing the ways it might
   * - which is what keeps the two from drifting apart as more of them appear. A position with a reading
   * of its own writes an edge back to this one; one without writes whatever it writes from here.
   */
  private shapeIsWitnessed(group: number, accessesPerGroup: Map<number, Access[]>): boolean {
    const childGroups = childGroupsOf(this.clusters.childrenOf(group));
    // Any of my kids write something, or I am getting accessed.
    return childGroups.some((child) => {
      const lengthOfAccessPath = (accessesPerGroup.get(child)?.length ?? 0);
      return lengthOfAccessPath > 1 || this.writesAnything(child, accessesPerGroup);
    });
  }

  /**
   * Whether the group, or anything the shape of it reaches, writes a conjunct of its own.
   *
   * The whole subtree rather than the group alone: a position that says nothing itself may hold one that
   * does, and `SUBJECT(OBJECT(?o)) ≡ :c` entails that `?o` is a triple term just as surely from two
   * levels down as from one. Asking only the position would restate it - and a position that says nothing
   * with *nothing* below it is the one case that has to be stated, which is the T⟨…⟩ it writes.
   */
  private writesAnything(group: number, accessesPerGroup: Map<number, Access[]>): boolean {
    // Either I write something
    if (this.groupConjuncts(group, accessesPerGroup).length > 0) {
      return true;
    }
    // Or my children do (recursively)
    const childGroups = childGroupsOf(this.clusters.childrenOf(group));
    return childGroups.some(child => this.writesAnything(child, accessesPerGroup));
  }

  /**
   * Every group Θ can reach from a variable it names, with the readings of it, representative first.
   * - FILTER(sameTerm(?x, ?y)) — one group, two members. Entry: [?x, ?y], representative ?x.
   *      The conjunct is the edge ?y ≡ ?x.
   * - FILTER(sameTerm(SUBJECT(?o), ?s)) — two groups. ?o's group: [?o]. The subject position:
   *      [?s, SUBJECT(?o)], representative ?s, giving the edge SUBJECT(?o) ≡ ?s.
   *      The other two positions are anonymous: [PREDICATE(?o)] and [OBJECT(?o)], one reading each,
   *      nothing to say.
   * - FILTER(sameTerm(SUBJECT(?o), :a)) — the subject position has only [SUBJECT(?o)], so no edge;
   *      it writes SUBJECT(?o) ≡ :a from that single reading.
   *
   * Two passes, because a reading through a shape is written from the *representative* of the group
   * holding that shape: the representatives are settled first, shortest path and lexicographic first within
   * that, and the readings are collected against them afterwards. A group nothing reaches is not in the
   * result at all - it is what is left of a shape a variable was taken out of, and nothing may be written
   * about it, since there is no way left to name it.
   */
  private readingsPerGroup(): Map<number, Access[]> {
    // The shortest access pattern into a group
    const representatives = new Map<number, Access>();
    // Seed with every group that has a named member, including groups created for
    // un-asserted positions of a tripleTerm variable.
    let frontier = new Map<number, Access>();
    // Iterate all groups, also groups that were created to represent un-asserted positions of a tripleTerm variable.
    for (const [ group ] of this.clusters.groupEntries()) {
      const [ representative ] = this.namedMembers(group);
      if (representative !== undefined) {
        frontier.set(group, access(representative));
      }
    }

    // Level-by-level so that depth dominates and accessId only breaks ties.
    while (frontier.size > 0) {
      for (const [ group, via ] of frontier) {
        // Sink frontiers into representatives - a group is accessed through some variable (shortest acces first)
        representatives.set(group, via);
      }
      const next = new Map<number, Access>();
      for (const [ group, via ] of frontier) {
        for (const [ position, child ] of childEntriesOf(this.clusters.childrenOf(group))) {
          // We donnot yet know how to access this group
          if (!representatives.has(child)) {
            const candidate = wrapAccess(via, position);
            const known = next.get(child);
            if (known === undefined || accessId(candidate) < accessId(known)) {
              next.set(child, candidate);
            }
          }
        }
      }
      frontier = next;
    }

    // All access patterns into a group
    const result = new Map(
      [ ...representatives.keys() ].map(group => <const> [ group, this.namedMembers(group).map(name => access(name)) ]),
    );
    for (const [ group, via ] of representatives) {
      for (const [ position, child ] of childEntriesOf(this.clusters.childrenOf(group))) {
        result.get(child)?.push(wrapAccess(via, position));
      }
    }
    for (const reads of result.values()) {
      reads.sort(compareAccesses);
    }
    return result;
  }

  /** The variables in a group, lexicographically - the first of them being its representative. */
  private namedMembers(group: number): string[] {
    return [ ...this.clusters.valuesOf(group) ].sort((left, right) => left.localeCompare(right));
  }

  /** The representative of a group: its lexicographically first member, so that the pass stays idempotent. */
  private representativeMemberOf(group: number): string | undefined {
    return this.namedMembers(group)[0];
  }

  /** The term types Θ leaves the group an access names, `undefined` when it does not name one yet. */
  private rangeKnownFor(read: Access): RangeSet | undefined {
    const group = this.resolveAccess(read);
    return group === undefined ? undefined : this.clusters.rangeOf(group);
  }

  /** Whether what is said about an access holds outright, rather than only where its root is bound. */
  private isStrong(access: Access): boolean {
    return this.strength.get(access.name) !== 'weak';
  }

  /**
   * The term a group is fixed to, which for a shape is the triple term its decided positions make, and
   * `undefined` where a position is decided by nothing at all.
   *
   * Unless the caller has something to put there, which is the one thing its callers differ in:
   * `valueForUndecidedGroup` is asked for every group the pins leave undecided. A substitution into an
   * expression has nothing to offer (S3) and takes the `undefined`; a substitution into a *pattern* has
   * the variable that reads the group, and so gets the shape written out whole rather than not at all;
   * a re-binding has one for the groups something reads and none for the rest, which is the third
   * signature - a position nobody reads leaves the shape as undecided as a position nothing pins.
   * Everything else - that a pin is a term or three groups, and that three terms make one - is this
   * walk, here once so that the two cannot come to disagree about what a shape is.
   *
   * **A caller that always has one always gets a term back**, which the second signature states: every
   * way out of the walk is a pin's term, a quad built from three of those, or the value the caller has
   * for an undecided group, so nothing else can come back. That is the one step the compiler takes on trust -
   * a conditional return type would not defer over a parameter that is not generic, and would hand the
   * *first* caller a term it can be missing - so it is stated here once, where the argument for it is.
   *
   * The three positions need no type checking of their own. A position of a shape carries the range that
   * position admits from the moment it is created ({@link AssertionClusterSet.assertTriplePin}), and a
   * pin the range does not admit is refused where it is placed rather than here - so a predicate that
   * got this far is a NamedNode, and a subject is neither a Literal nor a triple term.
   */
  private termDecidedByPin(group: number): RDF.Term | undefined;
  private termDecidedByPin(group: number, valueForUndecidedGroup: (group: number) => RDF.Term): RDF.Term;
  private termDecidedByPin(
    group: number,
    valueForUndecidedGroup: (group: number) => RDF.Term | undefined,
  ): RDF.Term | undefined;
  private termDecidedByPin(
    group: number,
    valueForUndecidedGroup?: (group: number) => RDF.Term | undefined,
  ): RDF.Term | undefined {
    // The walk is a function of its own so that it recurses on what it *is* rather than on what the
    // signatures above promise: the two modes are one traversal, and only the promise is per caller.
    const recurse = (reached: number): RDF.Term | undefined => {
      const term = this.clusters.termOf(reached);
      if (term !== undefined) {
        return term;
      }
      const children = this.clusters.childrenOf(reached);
      if (children === undefined) {
        return valueForUndecidedGroup?.(reached);
      }
      const subject = recurse(children.subject);
      const predicate = recurse(children.predicate);
      const object = recurse(children.object);
      if (subject === undefined || predicate === undefined || object === undefined) {
        // A position nothing decides leaves the whole shape undecided, so the group is read the way any
        // other undecided one is - which for the caller that has no reading is the `undefined` above.
        return valueForUndecidedGroup?.(reached);
      }
      return DF.quad(<RDF.Quad_Subject> subject, <RDF.Quad_Predicate> predicate, <RDF.Quad_Object> object);
    };
    return recurse(group);
  }

  /**
   * The value a pattern holds for every group a variable of Θ names: the term it is pinned to, the
   * triple term its shape is written out as, or the variable that reads it.
   *
   * Only the groups a variable names are in the result, since only those can be *read* from the pattern
   * - a position nobody named is reached through the triple term written for the group holding it, and
   * has no way of being asked for on its own.
   *
   * The value is what every reading of the group is written as, wherever it occurs, which is where the
   * enforcement comes from: two readings of one group become the same term or the same variable in the
   * same pattern, and matching that pattern is what states the equality Θ carried as a condition.
   */
  private patternValues(namer: DerivedVarNamer): Map<number, RDF.Term> {
    const accessesPerGroup = this.readingsPerGroup();

    const nameOfGroup = (group: number): string => {
      const [ representative ] = accessesPerGroup.get(group)!;
      return representative.positions.reduce<string>(
        (name, position) => namer(name, position).value,
        representative.name,
      );
    };

    const materialisedTerm = (group: number): RDF.Term =>
      this.termDecidedByPin(group, undecided => DF.variable(nameOfGroup(undecided)));

    const result = new Map<number, RDF.Term>();
    for (const [ group, [ representative ]] of accessesPerGroup) {
      // A group no variable names is only ever read through the shape holding it, and the representative of one
      // that has them is the variable it is read by: its representative.
      if (isBareAccess(representative)) {
        // Without its shape, a group is what {@link rebuildingSubstitution} makes of it: the term it is
        // pinned to, or the representative every member of a clique substitutes to.
        result.set(group, this.shapeIsWorthWriting(group) ?
          materialisedTerm(group) :
          this.clusters.termOf(group) ?? DF.variable(representative.name));
      }
    }
    return result;
  }

  /**
   * Whether writing the shape of a group into a pattern states anything the pattern did not already
   * state - which is exactly whether some position of it, however deep, holds a term or is named.
   *
   * A shape none of whose positions says anything is three coined variables that constrain nothing but
   * the value being a triple term, which the condition T⟨?x : Quad⟩ says without growing the pattern.
   * Leaving it is also what keeps `isTRIPLE(?o)` and the shape an accessor opens on the way to a
   * position it says nothing about - `sameTerm(SUBJECT(?o), SUBJECT(?o))` - the one plan, the two being
   * the one fact.
   */
  private shapeIsWorthWriting(group: number): boolean {
    const children = this.clusters.childrenOf(group);
    if (children === undefined) {
      return false;
    }
    return childGroupsOf(children).some(child =>
      this.clusters.termOf(child) !== undefined ||
      this.namedMembers(child).length > 0 ||
      this.shapeIsWorthWriting(child));
  }

  /**
   * The value the pattern holds where an access reads it, `undefined` where it holds none.
   *
   * Reading a position is following the written triple term into it, so an access is answered exactly as
   * deep as the shapes were written: what the pattern says about `SUBJECT(?o)` is the subject of what it
   * wrote for `?o`, and where that is a variable rather than a triple term it says nothing at all.
   *
   * A weak member is never written - the pattern would claim it is bound - so it reads as nothing here.
   */
  private patternValueOf(access: Access, values: ReadonlyMap<number, RDF.Term>): RDF.Term | undefined {
    if (!this.isStrong(access)) {
      return undefined;
    }
    const groupOfRoot = this.clusters.groupOf(access.name);
    let valueOfRoot = groupOfRoot === undefined ? undefined : values.get(groupOfRoot);
    for (const position of access.positions) {
      valueOfRoot = valueOfRoot === undefined ? undefined : componentOf(valueOfRoot, position);
    }
    return valueOfRoot;
  }

  /** Whether matching the pattern the substitution builds already states what the conjunct states. */
  private enforcedByPattern(conjunct: AssertionConjunct, values: ReadonlyMap<number, RDF.Term>): boolean {
    const value = this.patternValueOf(conjunct.access, values);
    if (value === undefined) {
      return false;
    }
    const { assertion } = conjunct;
    if (assertion.subType === 'termType') {
      // Only being a triple term is something a pattern can state, by writing the three positions of one.
      return assertion.strong && value.termType === assertion.termType;
    }
    if (assertion.subType !== 'strong') {
      return false;
    }
    const target = targetIsAccess(assertion.term) ?
      this.patternValueOf(assertion.term, values) :
      assertion.term;
    // The same term written twice, or the same variable - which in a pattern is the equality itself.
    return target !== undefined && value.equals(target);
  }

  /**
   * What an *expression* may be given in place of an access: the term it reads where Θ decides one, and
   * otherwise the variable that reads its group most directly.
   *
   * The second half is what sets this apart from {@link termDecidedByPin}, which hands back a value or
   * nothing. A representative is not a value - it still has to be evaluated - but Θ proves it equal to
   * what the access reads, so writing it there is sound and is what turns `sameTerm(SUBJECT(?o), ?s)`
   * into `sameTerm(?s, ?s)` when the pass meets its own output again.
   */
  private substitutionFor(read: Access): RDF.Term | undefined {
    // A weak member says what the variable is *if* bound, which is not something an expression may assume.
    if (this.strength.get(read.name) !== 'strong') {
      return undefined;
    }
    const group = this.resolveAccess(read);
    if (group === undefined) {
      return undefined;
    }
    const term = this.termDecidedByPin(group);
    if (term !== undefined) {
      return term;
    }
    const representative = this.representativeMemberOf(group);
    if (representative === undefined || (isBareAccess(read) && representative === read.name)) {
      return undefined;
    }
    return DF.variable(representative);
  }

  /** Takes a variable out of its group, dropping the group when nothing is left to be equal to. */
  private removeMember(name: string): void {
    this.clusters.remove(name);
    this.strength.delete(name);
  }

  private remember(name: string): void {
    this.order.add(name);
  }
}

/** Whether a group can still hold a value of one of these types, its pin included. */
function admitsRange(clusters: AssertionClusterSet, group: number, range: RangeSet): boolean {
  const pin = clusters.pinOf(group);
  if (pin === undefined) {
    return clusters.rangeOf(group).disjunct(range).size > 0;
  }
  const type = pin.kind === 'term' ? pin.term.termType : 'Quad';
  return clusters.rangeOf(group).disjunct(range).size > 0 && range.has(type);
}

/** The positions of a shape paired with the groups holding them, for the rules that walk all three. */
function childEntriesOf(children: PinChildren | undefined): [ TriplePosition, number ][] {
  return children === undefined ? [] : triplePositions.map(position => [ position, children[position] ]);
}

/** The access reading one position of what `access` reads. */
function wrapAccess(access: Access, position: TriplePosition): Access {
  return { name: access.name, positions: [ ...access.positions, position ]};
}

/**
 * Whether the conjunct is an *edge*: one access fixed to another, rather than to a term or to nothing.
 *
 * Which is the one thing that makes a conjunct mention two accesses, and so the one thing a rule cannot
 * place by reading a single one - see {@link AssertionConjunction.equatedReadings}.
 */
function isEdgeConjunct(conjunct: AssertionConjunct): boolean {
  return hasTarget(conjunct.assertion) && targetIsAccess(conjunct.assertion.term);
}

/**
 * The variable of a form that only ever is about one.
 *
 * B⟨?x⟩ and U⟨?x⟩ are read off `BOUND(?x)`, whose grammar takes a bare variable, and nothing this pass
 * builds coins one about a position of a shape - a position is bound exactly when the triple term holding
 * it is, so there would be nothing for it to say.
 */
function rootVarOfBare(access: Access, form: string): string {
  if (!isBareAccess(access)) {
    throw new Error(`Unreachable: ${form} is only ever asserted of a variable, not of ${accessId(access)}`);
  }
  return access.name;
}

/**
 * What the top level conjunction of a filter condition says about the variables, cached on the filter
 * the way {@link CPMeta} is cached on any operation.
 */
export interface AssertionConjunctionMeta {
  /** The assertions (Θ) the top level conjunction carries. */
  assertions: AssertionConjunction;
  /**
   * What is left of the condition once the assertions are taken out of it, with the strong ones
   * substituted into it (FReord), or `undefined` when the assertions are all there was.
   */
  residual: Algebra.Expression | undefined;
  /**
   * Whether the conjunction contradicts itself - one variable asserted to be two distinct terms, or a
   * conjunct that folded to `false`. Such a filter is the empty operation.
   */
  contradictory: boolean;
}

/** A filter of which we know what its top level conjunction says about the variables. */
export type AssertionFilter = Algebra.Filter & {
  metadata: Partial<CPMeta> & { assertions: AssertionConjunctionMeta };
};

/**
 * Attaches - or reuses - the {@link AssertionConjunctionMeta} of a filter.
 *
 * Like {@link withCpVars}, this is dynamic programming: a filter this pass created already knows its own
 * assertions, and one met in the input tree is analysed once and carries the result from then on.
 */
function withAssertionConjunction(c: TransformContext, filter: Algebra.Filter): AssertionFilter {
  const casted = <Algebra.Filter & { metadata?: Partial<AssertionFilter['metadata']> }> filter;
  const known = casted.metadata?.assertions;
  if (known === undefined) {
    // The condition is evaluated over the solutions of the input, so those are the variables bound in it.
    const collected = collectAssertions(c, filter.expression, undefined, withCpVars(filter.input).metadata.cVars);
    casted.metadata ??= {};
    casted.metadata.assertions = collected ?? {
      assertions: new AssertionConjunction(),
      residual: undefined,
      // If the collection returns `undefined`, it is a sign of a contradiction.
      contradictory: true,
    };
  }
  return <AssertionFilter> casted;
}

/**
 * Guard recognizing the filters this pass is about: the ones whose top level conjunction says something
 * about at least one variable - fixing it to a term, unifying it with another, giving it a shape, or only
 * deciding whether it is bound - and the contradictory ones (which are the empty operation). Anything else
 * is left where it is, and the traversal keeps descending into it looking for the filters deeper down.
 */
export function isAssertionFilter(c: TransformContext, op: Algebra.Operation): op is AssertionFilter {
  if (op.type !== Algebra.Types.FILTER) {
    return false;
  }
  const { assertions } = withAssertionConjunction(c, op).metadata;
  return assertions.contradictory || assertions.assertions.size > 0;
}

/**
 * Splits a filter condition into the assertions it carries and what is left of it, folding in the
 * assertions `known` to already hold there (Θ). Returns `undefined` when the condition is contradictory,
 * making the filter empty.
 *
 * The leftovers have the *strong* assertions substituted into them, per (FReord):
 * `σ_R(A) == σ_{simplify(R[θ])}(σ_θ(A))`. That can turn a leftover into an assertion of its own -
 * `sameTerm(?y, ?x)` becomes `sameTerm(?y, c)` - so this repeats until the substitution stops changing.
 * Merging two groups counts as a change even though neither gained a term: it may hand a clique a
 * representative that is lexicographically before the one its members were substituted to.
 *
 * Merging into the known assertions is also what makes the pass idempotent: re-running it re-derives the
 * same conjunction and absorbs it rather than stacking a second copy - the residual `sameTerm(?o, ?o)` a
 * re-derived edge leaves behind folds away, since a clique member is bound, and so does the
 * `isTRIPLE(?o)` a re-derived shape leaves.
 *
 * `cVars` are the variables the operation the condition filters certainly binds, which is what the
 * substitution folds `sameTerm(?x, ?x)` against. Leaving it empty only means fewer residuals fold.
 */
export function collectAssertions(
  c: TransformContext,
  expression: Algebra.Expression,
  known: AssertionConjunction = new AssertionConjunction(),
  cVars: ReadonlySet<string> = new Set(),
): AssertionConjunctionMeta | undefined {
  // Make copy and perform substitution
  const assertions = known.clone();
  let substitution = assertions.rebuildingSubstitution();
  let conjuncts = splitConjunction(
    substituteInExpression(c, expression, assertions.expressionSubstitution(), cVars),
  );

  let learned = true;
  let residual: Algebra.Expression[] = [];
  while (learned) {
    residual = [];
    learned = false;

    for (const conjunct of conjuncts) {
      const constant = booleanConstantOf(conjunct);
      if (constant === false) {
        // Filter is filter false
        return undefined;
      }
      if (constant === true) {
        // Conjunct does not add anything
        continue;
      }
      // Each form has its own top level shape, so at most one of these recognizes a conjunct.
      const met = asAssertionConjuncts(conjunct);
      if (met === undefined) {
        // Not an assertion we recognize, so goes into the residuals
        residual.push(conjunct);
        continue;
      }
      // Shortcut contradictions
      for (const { access: read, assertion } of met) {
        if (!assertions.assert(read, assertion)) {
          return undefined;
        }
      }
    }

    const grown = assertions.rebuildingSubstitution();
    // Only a change to what can be substituted below can collapse a leftover into an assertion.
    if (!sameSubstitution(substitution, grown)) {
      learned = true;
      substitution = grown;
      conjuncts = residual.flatMap(conjunct =>
        splitConjunction(substituteInExpression(c, conjunct, assertions.expressionSubstitution(), cVars)));
    }
  }
  return {
    assertions,
    residual: residual.length === 0 ? undefined : conjunctionOf(c, residual),
    contradictory: false,
  };
}

/** Whether two substitutions replace the same variables by the same terms. */
function sameSubstitution(left: Assertions, right: Assertions): boolean {
  return left.size === right.size &&
    [ ...left ].every(([ name, term ]) => right.get(name)?.equals(term) === true);
}
