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
 * @fileoverview The conjunction of assertions (Θ) the pushdown moves around, and how a filter
 * condition is read into one.
 *
 * `FILTER(sameTerm(?x, ?y))` constrains two variables at once, and a chain of such filters makes a clique
 * of variables that all have to be equal. So the carrier is a union-find ({@link TermClusterSet}) whose
 * groups may be pinned to a term or to the *shape* of a triple term - three groups, one per position -
 * plus the two term-less forms (`bound` / `!bound`), which stay per variable.
 *
 * A shape on the group is what makes `FILTER(sameTerm(SUBJECT(?o), ?s))` expressible: unifying `?o` with
 * `?x` makes everything known about `SUBJECT(?o)` known about `SUBJECT(?x)`, and a conjunct is about an
 * {@link Access} rather than about a variable.
 */

/**
 * One walk of {@link AssertionConjunction.conjuncts | conjuncts} over Θ: the readings every group has, and
 * what the groups it already wrote out contribute.
 *
 * The two travel together because the second is a function of the first, of the pins and of the strengths -
 * so the memo lives for exactly one walk, rather than being stamped on the cluster set's
 * {@link datastructures/ClusterSet!ClusterSet.revision | revision} the way `readingsPerGroup` is. A
 * strength alone can change without the clusters being written at all (`assertBound` completing a weak
 * member), which that stamp would not catch.
 */
interface Decomposition {
  /** The readings of every group, from `readingsPerGroup`. */
  readonly accessesPerGroup: ReadonlyMap<number, readonly Access[]>;
  /** What each group written out so far contributes, filled in as the walk reaches it. */
  readonly conjunctsPerGroup: Map<number, readonly AssertionConjunct[]>;
}

/**
 * A set of assertions Θ, in the states an assertion about an access can be in:
 *
 * | state                                | means                                                      |
 * |--------------------------------------|------------------------------------------------------------|
 * | strong member of a pinned group      | `sameTerm(?x, c)`                                          |
 * | weak member of a pinned group        | `!bound(?x) ∨ sameTerm(?x, c)`                             |
 * | member of an unpinned group (clique) | `sameTerm(?x, ?rep)`                                       |
 * | group with an asserted term type     | `isIRI(?x)`, `isBLANK(?x)`, `isLITERAL(?x)`, `isTRIPLE(?x)` |
 * | the same, asserted weakly            | `!bound(?x) ∨ is<τ>(?x)`                                   |
 * | member of a shaped group             | one conjunct per position of the shape that says something |
 * | unbound / bound                      | `!bound(?x)` / `bound(?x)`, no term                        |
 *
 * Every row is written back in the form the recogniser reads straight back into the same state, which is
 * what {@link toExpression} and {@link collectAssertions} being inverses of each other means. What was
 * derived rather than asserted - that a subject holds no literal, that a shaped group holds a triple term -
 * is left unsaid ({@link AssertionClusterSet}).
 *
 * Two invariants shape everything below:
 *
 * - **A shape is never written as `sameTerm(?o, <<( ... )>>)`** (S2), only as one `sameTerm(SUBJECT(?o),
 *   ...)` per position that says something: the positions nobody named would be unbound wherever the
 *   filter sits, so the condition would error and drop every row.
 * - **Weak means sole member of a pinned group.** There is no sound weak form of a clique - cluster-level
 *   weak does not distribute over a join, and merging two weak edges is unsound - so a pin, a value both
 *   sides of a join already agree on, is what makes the weak form work. Every operation that would put a
 *   second named member into a group promotes the weak one first.
 *
 * The `assert...` methods report a contradiction by returning `false` rather than raising: one variable
 * asserted to be two terms at once is an ordinary outcome, which the pass turns into the empty operation.
 * A conjunction they returned `false` for holds no meaningful state and has to be discarded.
 */
export class AssertionConjunction {
  /**
   * Variable to its group; a group may be pinned to the term or the shape all of its members equal.
   */
  private clusters: AssertionClusterSet;
  /**
   * Strength per *root* variable, and only meaningful for variables in a group. The accessor conjuncts about
   * `?o` are exactly as strong as what is known about `?o` itself, reading a position of an unbound variable
   * being an error.
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
  /**
   * The last {@link readingsPerGroup} taken, with the {@link datastructures/ClusterSet!ClusterSet.revision |
   * revision} of {@link clusters} it was taken at.
   *
   * Nothing invalidates it: the decomposition is a function of `clusters` alone, and a stamp is unique to
   * one state of one set, so a write - or {@link adopt} putting a different set here altogether - leaves
   * the stamp it was taken at unreachable. See {@link readingsPerGroup} for why that is the whole of it.
   */
  private readings: { revision: number; value: ReadonlyMap<number, readonly Access[]> } | undefined;
  /**
   * The groups {@link namedMembers} was asked about, with the
   * {@link datastructures/ClusterSet!ClusterSet.revision | revision} of {@link clusters} they were read at.
   *
   * Filled in group by group rather than in one walk, most of the callers wanting a single group. It goes
   * stale the way {@link readings} does, and for the same reason: the members of a group are a function of
   * `clusters` alone, and no two states of any two sets share a stamp.
   */
  private members: { revision: number; value: Map<number, readonly string[]> } | undefined;

  public constructor() {
    this.clusters = new AssertionClusterSet();
    this.strength = new Map();
    this.unbound = new Set();
    this.bound = new Set();
    this.order = new Set();
  }

  /**
   * The conjunction of the assertions of `conjuncts`, which never contradict when every one of them is
   * entailed by one satisfiable Θ - a subset of its {@link AssertionConjunction.conjuncts | conjuncts}, or
   * the weakened and entailed forms the pushdown derives from them, which are implied by what they came
   * from and so satisfiable with it.
   * @param conjuncts - The conjuncts to conjoin
   * @returns the conjunction they make
   * @throws when the conjuncts do contradict, since a caller handing over conjuncts of two different Θ has
   * no meaningful conjunction to be given back
   */
  public static of(conjuncts: Iterable<AssertionConjunct>): AssertionConjunction {
    const result = new AssertionConjunction();
    for (const { access, assertion } of conjuncts) {
      if (!result.assert(access, assertion)) {
        throw new Error(
          `Conjuncts entailed by one Θ contradict, at ${assertion.subType} of ${accessId(access)}`,
        );
      }
    }
    return result;
  }

  /**
   * A copy that shares no state with this one, so that either may be asserted into on its own.
   * @returns the copy
   */
  public clone(): AssertionConjunction {
    const copy = new AssertionConjunction();
    copy.clusters = this.clusters.clone();
    copy.strength = new Map(this.strength);
    copy.unbound = new Set(this.unbound);
    copy.bound = new Set(this.bound);
    copy.order = new Set(this.order);
    return copy;
  }

  /**
   * Takes over the state of a {@link clone} that an attempted assertion succeeded on.
   * @param other - The clone to adopt
   */
  private adopt(other: AssertionConjunction): void {
    this.clusters = other.clusters;
    this.strength = other.strength;
    this.unbound = other.unbound;
    this.bound = other.bound;
    this.order = other.order;
  }

  /**
   * The variables the conjunction says something about, in the order it first met them.
   * @returns those variable names
   */
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
   * What a *shape* says about the positions is not about this variable at all - it is about the groups those
   * positions name - so it is {@link conjuncts} rather than this that reports it.
   * @param name - The variable to look up
   * @returns the assertion, or `undefined` when the conjunction says nothing about it
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
   * The kind of term **Θ itself** says the group holds: a condition asserted it outright, or Θ holds
   * a shape for the group, which is a triple term by being one.
   * @param group - The group to look up
   * @returns the term type, or `undefined` where Θ says nothing about it
   */
  private assertedTermTypeOf(group: number): AssertableTermType | undefined {
    // Deliberately not {@link TermClusterSet.rangeOf}: that is narrowed by the position the group sits in
    // and by what the operation leaves its variables, which are facts of the plan Θ is written into
    // rather than facts of Θ. Reporting them would put {@link get} at odds with {@link conjuncts},
    // which states only what was asserted.
    if (this.clusters.childrenOf(group) !== undefined) {
      return 'Quad';
    }
    const asserted = this.clusters.assertedRangeOf(group);
    return asserted.size === 1 ?
      assertableTermTypes.find(termType => asserted.has(termType)) :
      undefined;
  }

  /**
   * The independent conjuncts Θ decomposes into: one per {@link equatedReadings | reading} of every
   * group it can reach from a named variable, plus the two term-less forms.
   * @returns the conjuncts, every one of them pointing at the representative of its group so that a re-run
   * of the pass absorbs what it finds instead of stacking it
   */
  public conjuncts(): AssertionConjunct[] {
    // ConjunctsPerGroup is used for memoization
    const walk: Decomposition = { accessesPerGroup: this.readingsPerGroup(), conjunctsPerGroup: new Map() };
    const result: AssertionConjunct[] = [];
    const emitted = new Set<number>();

    const emit = (group: number): void => {
      const resolved = this.clusters.resolveGroup(group);
      if (!emitted.has(resolved) && walk.accessesPerGroup.has(resolved)) {
        emitted.add(resolved);
        result.push(...this.groupConjuncts(resolved, walk));
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
   * is bound.
   * @returns {@link conjuncts} without the edges, which are the only conjuncts mentioning two accesses and
   * so the only ones a rule cannot decide by looking at a single one
   */
  public unaryConjuncts(): AssertionConjunct[] {
    return this.conjuncts().filter(conjunct => !isEdgeConjunct(conjunct));
  }

  /**
   * Every group Θ names more than one way, as the ways of naming its value: a variable that is a member
   * of it, or a position of a shape, read from the representative of the group holding that shape.
   *
   * Several readings is the statement that they are equal - a clique for a group of variables, one edge for
   * `sameTerm(SUBJECT(?o), ?s)`, and the two are one thing here. A rule deciding per reading would split
   * such a group into pieces that no longer say it, so it splits the *edges* instead (`splitClique` in the pushdown).
   * A group pinned to a term is not one of them: every reading of it is that term, which already states it.
   * @returns the readings per group, each list representative first
   */
  public equatedReadings(): (readonly Access[])[] {
    const result: (readonly Access[])[] = [];
    for (const [ group, readings ] of this.readingsPerGroup()) {
      if (this.clusters.pinOf(group)?.kind !== 'term' && readings.length > 1) {
        result.push(readings);
      }
    }
    return result;
  }

  /**
   * Splits Θ in two: a conjunct all of whose variables match `predicate` goes inside, the rest outside.
   * @param predicate - Which variables belong inside
   * @returns the two halves, which together hold every conjunct and so are equivalent to the whole
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
   * The variables Θ entails `bound(?x)` of - every member of a clique, and every variable a shape
   * reaches, a triple term and each of its positions being bound (S5).
   * @returns those variable names, which is what lets a structural assertion decide the rules the strong
   * form decides even where the edge itself cannot travel
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
   * The substitution the strong assertions stand for: a pinned member maps to its term, a clique member to
   * its representative, and a member of a shaped group to the triple term that shape is - written out of the
   * variables that already read its positions, and undecided where a position is read by nothing at all.
   * @returns the substitution, everything in which is already written elsewhere, so it stays usable outside
   * a pattern where S3 rules the materialised shape out ({@link intoPattern})
   */
  public rebuildingSubstitution(): Assertions {
    return this.strongMembersReplacedBy(group => this.termDecidedByPin(group, (undecided) => {
      const representative = this.representativeMemberOf(undecided);
      return representative === undefined ? undefined : DF.variable(representative);
    }));
  }

  /**
   * What a *pattern* takes of Θ, and what it leaves behind: two halves of one decision, decided together
   * off the one set of values written for the groups.
   *
   * The substitution is {@link rebuildingSubstitution} with the shapes written out further: a member of a
   * shaped group maps to the triple term that shape is, its positions filled in with the terms they are
   * pinned to, the variables that name them, and a variable coined for each position nothing names (D4).
   * That last part is why this may only go into a pattern (S3): the pattern is what binds the coined
   * variables, where a condition reading them would error away every row.
   *
   * The residual is what that pattern does *not* state, read off the value the pattern holds at each side of
   * a conjunct rather than off the form of the conjunct. `asWritten` is what it has to be read against once
   * the pattern holds those values: Θ keeps saying `OBJECT(?o)` where the plan says `?o_o`, so
   * `isIRI(OBJECT(?o))` is written as `isIRI(?o_o)`, a condition over a variable the pattern binds.
   * @param namer - Coins the variable for a position, once per position and query ({@link utils!derivedVarNamer})
   * @returns the substitution to write into the pattern, the residual to state over it, and the view that
   * residual has to be written through
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
   * The substitution replacing every strong member by what `valueOf` makes of its group, which is the one
   * thing {@link rebuildingSubstitution} and {@link intoPattern} differ in.
   * @param valueOf - The value to substitute for a group, `undefined` to leave its members alone
   * @returns the substitution, never mapping a variable to itself - the representative of its own group is
   * already written where it is, and re-binding it would be the `BIND(?x AS ?x)` the algebra raises on
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
   * knows: the term an access is fixed to, which kind of term an access is, and which variables are bound.
   * @returns the view; a shape may not be substituted into an expression at all (S3), so what travels is
   * only what folds to a term, plus the variable that reads a group most directly
   */
  public expressionSubstitution(): AssertionView {
    return {
      bound: this.boundImpliedBy(),
      resolve: access => this.substitutionFor(access),
      typeRange: access => this.strength.get(access.name) === 'strong' ? this.rangeKnownFor(access) : undefined,
    };
  }

  /**
   * Reads Θ in terms of what an operation binds, converting between the forms at every step of the
   * pushdown.
   *
   * Where `?x` is certainly bound, `!bound(?x)` is unsatisfiable, so W *is* A, B is `true` and U is empty;
   * where `?x` can never be bound, A and B empty the operation by (FBndII) while W and U are `true`. The
   * ranges decide the same two things one level finer - a variable whose range is empty never binds, exactly
   * as one out of scope does, and a variable pinned to something outside a non-empty range cannot be bound
   * to it, which makes the strong form unsatisfiable and the weak form exactly U⟨?x⟩.
   *
   * Takes the {@link CPMeta} of the operation the filter sits on: the variables it binds in every
   * solution, and the scope it binds with the term types each variable there can take.
   * @returns the normalised conjunction, or `undefined` when it makes that operation empty
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
   * For a BIND that is its expression: below `BIND(?z AS ?t)` it is `?z` that holds what `?t` holds above.
   * An access takes over everything the group holds, a term is what the group has to be, and a construction
   * is the shape itself, so what the group said about a position is restated about the variable holding it.
   * @param name - The variable to take out
   * @param replacement - What carries its value below
   * @returns the transferred conjunction, or `undefined` when the transfer contradicts what is known
   */
  public transferred(name: string, replacement: TransferSource): AssertionConjunction | undefined {
    const result = this.clone();
    // U⟨?x⟩ is simply dropped: it is about the EXTEND's own binding rather than about what the expression
    // yields. B⟨?x⟩ is not - it says the expression produced a value, which for the source is that
    // reading it yields one, and dropping it would lose the solutions where the expression errored.
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
   * @param access - The access being transferred away
   * @param source - What carries its value below
   * @returns `false` on a contradiction
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
   * Conjoins what the source has to satisfy for reading it to yield a value at all, which is what B⟨?x⟩ on a
   * transferred target comes to.
   * @param source - What carries the target's value below
   * @returns `false` on a contradiction
   */
  private assertReadingYieldValue(source: TransferSource): boolean {
    if (isTripleConstruction(source)) {
      return triplePositions.every(position => this.assertReadingYieldValue(source[position]));
    }
    const access = normalisedTarget(source);
    return !targetIsAccess(access) || this.assertUnify(access, access);
  }

  /**
   * Conjoins one assertion about one access, in whichever of the states it is - the inverse of
   * {@link conjuncts}.
   * @param access - The access the assertion is about
   * @param assertion - What it asserts
   * @returns `false` on a contradiction
   * @throws when the assertion is in a state Θ cannot hold - a weak edge, or a bare form about a position
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
        // A weak *edge* is not a state this can be in - weakening one is the unsound merge the form does
        // not exist to make - and neither the recognisers nor {@link asWeakenedConjunct} ever produce one,
        // so the target of a weak assertion is a term. Storing nothing while reporting success would drop
        // the conjunct from Θ and from the residual alike, which adds solutions.
        if (targetIsAccess(assertion.term)) {
          const target = accessId(assertion.term);
          throw new Error(`Unreachable: weak is only ever asserted of a term, not of ${target}`);
        }
        return this.assertPin(access, assertion.term, false);
      }
    }
  }

  /**
   * Conjoins A⟨?x ≡ c⟩ or W⟨?x ≡ c⟩, pinning the group of `?x` to `c` - which fixes every member of a clique
   * at once, and is how an assertion met above a unification travels onto all the variables it unified.
   * @param name - The variable to pin
   * @param term - The term it equals
   * @param strong - Whether it holds outright, rather than only where `?x` is bound
   * @returns `false` when the assertion contradicts what is already known
   */
  public assertTerm(name: string, term: RDF.Term, strong: boolean): boolean {
    return this.assertPin(access(name), term, strong);
  }

  /**
   * Conjoins A⟨a ≡ c⟩ or W⟨a ≡ c⟩ for an arbitrary access, which pins the group that access names and shapes
   * the groups on the way to it.
   * @param access - The access to pin
   * @param term - The term it equals
   * @param strong - Whether it holds outright, rather than only where its root is bound
   * @returns `false` on a contradiction
   */
  public assertPin(access: Access, term: RDF.Term, strong: boolean): boolean {
    return this.narrowing(access, strong, (clusters, group) => clusters.setTerm(group, term));
  }

  /**
   * Conjoins T⟨a : τ⟩ - `isIRI(a)`, `isBLANK(a)`, `isLITERAL(a)`, `isTRIPLE(a)` - or its weak form,
   * narrowing the group `a` names to the one kind of term it may hold.
   * @param access - The access to narrow
   * @param termType - The kind of term it holds
   * @param strong - Whether it holds outright, rather than only where its root is bound
   * @returns `false` on a contradiction
   */
  public assertTermType(access: Access, termType: AssertableTermType, strong: boolean): boolean {
    return this.narrowing(access, strong, (clusters, group) =>
      clusters.assertTermTypeRange(group, rangeOfTermType(termType)));
  }

  /**
   * Conjoins something that narrows the *group* an access names: the shapes on the way to the access are
   * opened, and then `narrow` says what the group it names may be.
   * @param access - The access to narrow
   * @param strong - Whether the narrowing holds outright, or only where the root is bound
   * @param narrow - What to do to the group, given the clusters of the conjunction it is applied to - which
   * is a *copy* of this one wherever the weak form has to try the narrowing before committing to it
   * @returns `false` on a contradiction
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
   * @param left - One side of the equality
   * @param right - The other
   * @returns `false` on a contradiction
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

  /**
   * Conjoins B⟨?x⟩: `bound(?x)`.
   * @param name - The variable to assert bound
   * @returns `false` on a contradiction
   */
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

  /**
   * Conjoins U⟨?x⟩: `!bound(?x)`.
   * @param name - The variable to assert unbound
   * @returns `false` on a contradiction
   */
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

  /**
   * The single condition the (non-empty) conjunction stands for, each conjunct in the form it carries.
   * @param c - The transformation context
   * @returns the condition
   */
  public toExpression(c: TransformContext): Algebra.Expression {
    return conjunctionOf(c, this.conjuncts().map(conjunct => conjunctAsExpression(c, conjunct)));
  }

  /**
   * Conjoins a form that implies `bound(?x)` of the root it is about, which rules U out, absorbs B and makes
   * the member strong before `apply` runs.
   * @param root - The variable the form is about
   * @param apply - The narrowing to make once the root is known bound
   * @returns `false` on a contradiction
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
   * @param root - The variable the form is about
   * @param apply - The narrowing `φ` makes
   * @returns `false` only where U⟨?x⟩ itself contradicts, a `φ` the group cannot hold coming to U⟨?x⟩
   * rather than to an empty conjunction
   */
  private assertWeakly(root: string, apply: (target: AssertionConjunction) => boolean): boolean {
    this.remember(root);
    if (this.unbound.has(root)) {
      return true;
    }
    if (this.bound.has(root) || this.strength.get(root) === 'strong') {
      return this.assertStrongly(root, apply);
    }
    // `¬b ∨ φ` with a false `φ` is `!b`, so two weak assertions that cannot both hold come to U⟨?x⟩
    // rather than to an empty conjunction - which is how `FILTER(!bound(?x))` most often arises. There is
    // no way to ask the pin lattice whether a merge *would* have succeeded, and a merge that fails leaves
    // it in a state no caller may read, so it is tried on a clone and adopted only if it held.
    const attempt = this.clone();
    attempt.strength.set(root, 'weak');
    if (apply(attempt)) {
      this.adopt(attempt);
      this.assertWeakMemberIsAlone(root);
      return true;
    }
    return this.assertUnbound(root);
  }

  /**
   * Checks the invariant a weak member rests on: it is the only variable naming its group.
   *
   * {@link get} reports any other member of a group as a strong edge to its representative without reading
   * {@link strength}, which is right only where no weak member has another member to point at. The single
   * way into a group of several is {@link assertUnify}, which makes both of its sides strong, so a weak
   * member is alone in its group - and a violation would state a weak edge as a strong one, adding
   * solutions.
   * @param root - The variable just made weak
   * @throws when that variable shares its group with another
   */
  private assertWeakMemberIsAlone(root: string): void {
    const group = this.clusters.groupOf(root);
    if (group === undefined) {
      return;
    }
    const members = this.namedMembers(group);
    if (members.length > 1) {
      throw new Error(`Unreachable: the weak ?${root} shares a group with ${members.join(', ')}`);
    }
  }

  /**
   * Resolves an access to a group, asserting a shape for every position it reads through on the way -
   * which is the point rather than a side effect, reading a position of something being what says that
   * something is a triple term.
   * @param access - The access to resolve
   * @returns the group the access names, or `false` when one of those shapes contradicts what a group holds
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

  /**
   * The group an access names, without asserting anything.
   * @param access - The access to resolve
   * @returns the group, or `undefined` when Θ does not name it yet
   */
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

  /**
   * The conjuncts one group of Θ contributes, given how the whole of it can be read, remembered on the walk
   * that asked for them.
   *
   * Without the memo the walk is exponential in the depth of the shape: writing a group out asks whether its
   * positions speak up ({@link shapeIsWitnessed}), which writes each of them out *and* asks the same of
   * their own positions, so every group below is written once per ancestor and once again per ancestor's
   * question. `FILTER(sameTerm(OBJECT(OBJECT(...(?z))), ?w))` nests as deep as it is written, which made a
   * fourteen-deep chain a million calls.
   * @param group - The group to write out
   * @param walk - The decomposition being written, whose memo this fills in
   * @returns its conjuncts, shared with whoever asks again on the same walk and so not to be written to
   */
  private groupConjuncts(group: number, walk: Decomposition): readonly AssertionConjunct[] {
    // Memoization
    const known = walk.conjunctsPerGroup.get(group);
    if (known !== undefined) {
      return known;
    }
    const written = this.writeOutGroup(group, walk);
    walk.conjunctsPerGroup.set(group, written);
    return written;
  }

  /**
   * The walk {@link groupConjuncts} memoises, run once per group and decomposition.
   *
   * A shape holds no cycles ({@link datastructures/TermClusterSet!TermClusterSet}), so a group is never
   * asked for while it is being written, and the memo is filled in with a finished list.
   * @param group - The group to write out
   * @param walk - The decomposition being written
   * @returns its conjuncts
   */
  private writeOutGroup(group: number, walk: Decomposition): AssertionConjunct[] {
    const accesses = walk.accessesPerGroup.get(group)!;
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
    const termType = this.termTypeToState(group, walk);
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
   * The kind of term the group has to be *told* to be: only what is not already entailed by the rest of what
   * the group writes out, since restating it would stop the pass being idempotent.
   * @param group - The group to look at
   * @param walk - The decomposition being written
   * @returns the term type, or `undefined` when nothing has to be told
   */
  private termTypeToState(group: number, walk: Decomposition): AssertableTermType | undefined {
    if (this.clusters.pinOf(group)?.kind === 'term') {
      return undefined;
    }
    if (this.clusters.childrenOf(group) !== undefined) {
      // I have kids, so I should assert that if they don't speak up
      return this.shapeIsWitnessed(group, walk) ? undefined : 'Quad';
    }
    const asserted = this.clusters.assertedRangeOf(group);
    return asserted.size === 1 ? assertableTermTypes.find(termType => asserted.has(termType)) : undefined;
  }

  /**
   * Whether a position of the shape says something of its own, in which case T⟨representative : Quad⟩ need
   * not be stated - reading a position already entails that what it is read through is a triple term.
   * @param group - The shaped group to ask about
   * @param walk - The decomposition being written
   * @returns whether some position speaks up
   */
  private shapeIsWitnessed(group: number, walk: Decomposition): boolean {
    const childGroups = childGroupsOf(this.clusters.childrenOf(group));
    // Any of my kids write something, or I am getting accessed.
    return childGroups.some((child) => {
      const lengthOfAccessPath = (walk.accessesPerGroup.get(child)?.length ?? 0);
      return lengthOfAccessPath > 1 || this.writesAnything(child, walk);
    });
  }

  /**
   * Whether the group, or anything the shape of it reaches, writes a conjunct of its own.
   * @param group - The group to ask about
   * @param walk - The decomposition being written
   * @returns whether the subtree writes anything - the whole subtree, since a position that says nothing
   * itself may hold one that does
   */
  private writesAnything(group: number, walk: Decomposition): boolean {
    // Either I write something
    if (this.groupConjuncts(group, walk).length > 0) {
      return true;
    }
    // Or my children do (recursively)
    const childGroups = childGroupsOf(this.clusters.childrenOf(group));
    return childGroups.some(child => this.writesAnything(child, walk));
  }

  /**
   * Every group Θ can reach from a variable it names, with the readings of it, representative first.
   *
   * - `FILTER(sameTerm(?x, ?y))` - one group, readings `[?x, ?y]`, giving the edge `?y = ?x`.
   * - `FILTER(sameTerm(SUBJECT(?o), ?s))` - `?o`'s group holds `[?o]`; its subject position holds
   *   `[?s, SUBJECT(?o)]`, giving the edge `SUBJECT(?o) = ?s`. The other two positions are anonymous.
   * - `FILTER(sameTerm(SUBJECT(?o), :a))` - the subject position has one reading, so no edge; it writes
   *   `SUBJECT(?o) = :a` from that single reading.
   * Memoised per state of {@link clusters}, which is the only thing the walk reads: an operation asks for the
   * decomposition several times over ({@link conjuncts}, {@link equatedReadings}, {@link patternValues}), and
   * the walk is a BFS over every group plus a sort per group. Handed out read-only, the memo being shared.
   * @returns the readings per group; a group nothing reaches is left out, being what is left of a shape a
   * variable was taken out of, which nothing may be written about
   */
  private readingsPerGroup(): ReadonlyMap<number, readonly Access[]> {
    // Stamped before the walk rather than after it: a walk that wrote something - it does not, reading only
    // the groups, their members and their shapes - would then leave a stamp the next call misses on, rather
    // than one it wrongly trusts.
    const revision = this.clusters.revision;
    if (this.readings?.revision !== revision) {
      this.readings = { revision, value: this.walkReadingsPerGroup() };
    }
    return this.readings.value;
  }

  /**
   * The walk {@link readingsPerGroup} memoises, run once per state of {@link clusters}.
   * @returns the readings per group, each list representative first
   */
  private walkReadingsPerGroup(): Map<number, Access[]> {
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

  /**
   * The variables in a group, memoised per state of {@link clusters}.
   *
   * Sorting is what makes a group's representative the same one every time, and so what keeps the pass
   * idempotent - but hardly anything asks about a group once. {@link get} takes a representative per
   * variable it is asked about, {@link rebuildingSubstitution} one per group it rebuilds, and
   * {@link walkReadingsPerGroup} two per group, so a pushdown over a filter of a few hundred conditions
   * sorts some thousands of times over, under an eighth of which reads a group this has not already got.
   * @param group - The group to read
   * @returns them lexicographically, the first being the group's representative; handed out read-only, the
   * memo being shared
   */
  private namedMembers(group: number): readonly string[] {
    const revision = this.clusters.revision;
    if (this.members?.revision !== revision) {
      this.members = { revision, value: new Map() };
    }
    const known = this.members.value.get(group);
    if (known !== undefined) {
      return known;
    }
    const sorted = [ ...this.clusters.valuesOf(group) ].sort((left, right) => left.localeCompare(right));
    this.members.value.set(group, sorted);
    return sorted;
  }

  /**
   * The representative of a group: its lexicographically first member, so that the pass stays idempotent.
   * @param group - The group to read
   * @returns the representative, or `undefined` for a group no variable names
   */
  private representativeMemberOf(group: number): string | undefined {
    return this.namedMembers(group)[0];
  }

  /**
   * The term types Θ leaves the group an access names.
   * @param read - The access to look up
   * @returns the range, or `undefined` when Θ does not name its group yet
   */
  private rangeKnownFor(read: Access): RangeSet | undefined {
    const group = this.resolveAccess(read);
    return group === undefined ? undefined : this.clusters.rangeOf(group);
  }

  /**
   * Whether what is said about an access holds outright, rather than only where its root is bound.
   * @param access - The access to check
   * @returns whether its root is strong
   */
  private isStrong(access: Access): boolean {
    return this.strength.get(access.name) !== 'weak';
  }

  /**
   * The term a group is fixed to, which for a shape is the triple term its decided positions make.
   *
   * One walk for both callers, so that the two cannot come to disagree about what a shape is. A caller that
   * always has a value for an undecided group always gets a term back, which the second signature states:
   * every way out of the walk is a pin's term, a quad built from three of those, or that value.
   * @param group - The group to resolve
   * @param valueForUndecidedGroup - What to put where the pins decide nothing; a substitution into an
   * expression has nothing to offer (S3), a substitution into a pattern has the variable reading the group
   * @returns the term, or `undefined` where a position is decided by nothing at all
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
    // The positions need no type check: a position carries the range it admits from the moment it is
    // created ({@link AssertionClusterSet.assertTriplePin}), and a pin the range refuses never gets here.
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
   * The value a pattern holds for every group a variable of Θ names: the term it is pinned to, the triple
   * term its shape is written out as, or the variable that reads it.
   * @param namer - Coins the variable for a position nothing names
   * @returns the value per group; two readings of one group become the same term or the same variable in the
   * same pattern, and matching that pattern is what states the equality Θ carried as a condition
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
   * Whether writing the shape of a group into a pattern states anything the pattern did not already state,
   * which is exactly whether some position of it, however deep, holds a term or is named.
   * @param group - The group to ask about
   * @returns whether writing it is worth the variables it coins
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
   * The value the pattern holds where an access reads it: an access is answered exactly as deep as the shapes
   * were written.
   * @param access - The access to read
   * @param values - The value per group, from {@link patternValues}
   * @returns the value, or `undefined` where the pattern holds none - a weak member among them, the pattern
   * never writing one
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

  /**
   * Whether matching the pattern the substitution builds already states what the conjunct states.
   * @param conjunct - The conjunct to check
   * @param values - The value per group, from {@link patternValues}
   * @returns whether the pattern enforces it, so that it need not be restated over it
   */
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
   * @param read - The access to substitute
   * @returns the term or variable, or `undefined` where Θ decides neither
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

  /**
   * Takes a variable out of its group, dropping the group when nothing is left to be equal to.
   * @param name - The variable to remove
   */
  private removeMember(name: string): void {
    this.clusters.remove(name);
    this.strength.delete(name);
  }

  private remember(name: string): void {
    this.order.add(name);
  }
}

/**
 * Whether a group can still hold a value of one of these types, its pin included.
 * @param clusters - The clusters holding the group
 * @param group - The group to check
 * @param range - The term types to admit
 * @returns whether something is left for the group to be
 */
function admitsRange(clusters: AssertionClusterSet, group: number, range: RangeSet): boolean {
  const pin = clusters.pinOf(group);
  if (pin === undefined) {
    return clusters.rangeOf(group).meet(range).size > 0;
  }
  const type = pin.kind === 'term' ? pin.term.termType : 'Quad';
  return clusters.rangeOf(group).meet(range).size > 0 && range.has(type);
}

/**
 * The positions of a shape paired with the groups holding them, for the rules that walk all three.
 * @param children - The positions of a shape, or `undefined` for a group without one
 * @returns the pairs, empty for a group without a shape
 */
function childEntriesOf(children: PinChildren | undefined): [ TriplePosition, number ][] {
  return children === undefined ? [] : triplePositions.map(position => [ position, children[position] ]);
}

/**
 * The access reading one position of what `access` reads.
 * @param access - The access to read through
 * @param position - The position to read
 * @returns the longer access
 */
function wrapAccess(access: Access, position: TriplePosition): Access {
  return { name: access.name, positions: [ ...access.positions, position ]};
}

/**
 * Whether the conjunct is an *edge*: one access fixed to another, rather than to a term or to nothing.
 * @param conjunct - The conjunct to check
 * @returns whether it mentions two accesses, which is what makes it a conjunct no rule can place by reading
 * a single one
 */
function isEdgeConjunct(conjunct: AssertionConjunct): boolean {
  return hasTarget(conjunct.assertion) && targetIsAccess(conjunct.assertion.term);
}

/**
 * The variable of a form that only ever is about one.
 * @param access - The access the form is about
 * @param form - The name of the form, for the error message
 * @returns its root variable
 * @throws when the access reads a position: `BOUND` takes a bare variable by the grammar, and a position is
 * bound exactly when the triple term holding it is
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
 * Like {@link withCpVars} this is dynamic programming: a filter this pass created already knows its own
 * assertions, and one met in the input tree is analysed once and carries the result from then on.
 * @param c - The transformation context
 * @param filter - The filter to analyse
 * @returns the same filter, with its conjunction cached on it
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
 * about at least one variable, and the contradictory ones, which are the empty operation.
 * @param c - The transformation context
 * @param op - The operation to check
 * @returns whether it is such a filter; anything else is left where it is, and the traversal keeps
 * descending into it looking for the filters deeper down
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
 * assertions `known` to already hold there (Θ).
 *
 * The leftovers have the strong assertions substituted into them, per (FReord):
 * `σ_R(A) == σ_{simplify(R[theta])}(σ_θ(A))`. That can turn a leftover into an assertion of
 * its own - `sameTerm(?y, ?x)` becomes `sameTerm(?y, c)` - so this repeats until the substitution stops
 * changing. Merging into `known` is also what makes the pass idempotent: re-running it re-derives the same
 * conjunction and absorbs it rather than stacking a second copy.
 * @param c - The transformation context
 * @param expression - The condition to read
 * @param known - The assertions already known to hold there
 * @param cVars - The variables the filtered operation certainly binds, which is what the substitution folds
 * `sameTerm(?x, ?x)` against; leaving it empty only means fewer residuals fold
 * @returns the conjunction and the residual, or `undefined` when the condition is contradictory, which
 * makes the filter empty
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
  // The rounds that learned something, which is what the fixpoint terminating comes down to: a round only
  // runs again when the substitution changed, and {@link substitutionGrew} is where the argument that such
  // a change is always a *gain* - and so only ever made finitely often - is written down and checked.
  let rounds = 0;
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
    if (substitutionGrew(substitution, grown, assertions)) {
      learned = true;
      rounds += 1;
      // The steps of {@link substitutionGrew} counted for the variables Θ has: each enters the substitution
      // once, moves to an earlier representative at most `size - 1` times, is pinned once and leaves once.
      // Every step a round took was a step of a variable Θ already names, so a round past that many has
      // taken one twice - which the per-round check missed, the variables themselves having grown.
      if (rounds > assertions.size * (assertions.size + 2)) {
        throw new Error(`Unreachable: the assertions of a condition over ${assertions.size} variables kept ` +
          `growing for ${rounds} rounds`);
      }
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

/**
 * Whether the round that just ran learned something, which is what makes the fixpoint of
 * {@link collectAssertions} terminate.
 *
 * A round runs again whenever the substitution changed, so termination rests on a change never being a
 * *different* answer to a question Θ already answered. Every way a round writes into Θ is a step down one
 * finite chain per variable:
 *
 * - A variable enters the substitution when it becomes a strong member of a group, and it does so once:
 *   {@link AssertionConjunction.assertUnbound} is the only thing that takes one out again, and it takes it
 *   out into U⟨?x⟩, where every further assertion about it is a contradiction that ends the collection.
 * - A member of an unpinned group substitutes to the representative of the group, its lexicographically
 *   first member. Groups only ever merge over a round - nothing splits one, and the single member that
 *   leaves is a weak one, which is alone in its group - so a group only gains members and its
 *   representative only moves earlier: at most as many steps as Θ names variables.
 * - A pinned group substitutes to its term, and a pin is final: a second one either meets the first to the
 *   same term or contradicts. So the step from a representative to a term is taken once, and a shape is the
 *   same argument one position at a time, the positions being groups of their own.
 *
 * The chain is finite, a round that runs again steps down at least one of them, and the collection stops.
 * @param before - The substitution the round started with
 * @param after - The substitution Θ rebuilds now that the round has run
 * @param assertions - Θ as the round left it, which is what says a variable left the substitution because it
 * is unbound
 * @returns whether anything changed, which is whether the leftovers are worth another round
 * @throws when a variable's value changed into one that does not refine it, Θ answering a question twice
 * over being the one thing that could keep the loop running
 */
function substitutionGrew(before: Assertions, after: Assertions, assertions: AssertionConjunction): boolean {
  let grew = false;
  // The variables of `before` that `after` still has, so that the ones only `after` has are what is left.
  let kept = 0;
  for (const [ name, value ] of before) {
    const now = after.get(name);
    if (now === undefined) {
      if (assertions.get(name)?.subType !== 'unbound') {
        throw new Error(`Unreachable: ?${name} left the substitution without becoming unbound`);
      }
      grew = true;
    } else {
      kept += 1;
      if (!now.equals(value)) {
        if (!refinesTerm(value, now)) {
          throw new Error(`Unreachable: what Θ substitutes for ?${name} changed rather than grew, ` +
              `from ${value.termType} to ${now.termType}`);
        }
        grew = true;
      }
    }
  }
  return grew || after.size > kept;
}

/**
 * Whether the value Θ substitutes for a variable now *refines* the one it substituted before - the same
 * value, decided further - which is the step {@link substitutionGrew} allows a round to take.
 * @param before - What was substituted before the round
 * @param after - What is substituted now
 * @returns whether the second is a refinement of the first
 */
function refinesTerm(before: RDF.Term, after: RDF.Term): boolean {
  if (before.termType === 'Variable') {
    // A representative, which a merge moves earlier and a pin replaces by the term the group is fixed to.
    return after.termType !== 'Variable' || after.value.localeCompare(before.value) <= 0;
  }
  if (before.termType === 'Quad') {
    // A shape written out: what a round can decide about it is a position of it, one group further down.
    return after.termType === 'Quad' &&
      triplePositions.every(position => refinesTerm(before[position], after[position]));
  }
  // A pin is final, so a term never becomes a different one.
  return after.equals(before);
}
