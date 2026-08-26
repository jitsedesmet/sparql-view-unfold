import type * as RDF from '@rdfjs/types';
import { objectRange, RangeSet, rangeOfPosition, tripleTermRange } from '../RangeSet.js';
import { ClusterSet } from './ClusterSet.js';

/** The position a triple term holds one of its three components in. */
export type TriplePosition = 'subject' | 'predicate' | 'object';

/** The three positions, in the order a triple term writes them. */
export const triplePositions: readonly TriplePosition[] = [ 'subject', 'predicate', 'object' ];

/** The groups a triple pin holds its three components in, one per position. */
export type PinChildren = Readonly<Record<TriplePosition, number>>;

/**
 * The constraint a group carries: every value in it equals what the pin says.
 *
 * A `term` pin *is* the value. A `triple` pin is a **shape** - the value is a triple term, and each of
 * its three positions is a group in its own right - so it fixes a value only once all three positions
 * are decided, and constrains it partially until then. Holding group ids rather than terms is what makes
 * that possible: a position nobody named is an *anonymous* group, which unifies and carries a pin and a
 * range like any other while contributing nothing to the members of the set.
 */
export type Pin<Term> = TriplePin | { kind: 'term'; term: Term };

/** The shape half of a {@link Pin}, named so that a meet can take one and hand one back. */
export type TriplePin = { kind: 'triple' } & PinChildren;

/**
 * One thing that has to hold of the groups, and does not yet: two of them hold the same value, or one of
 * them carries a pin.
 *
 * Establishing either may establish further ones - merging two groups meets their pins, and meeting two
 * pins merges the groups their positions name - so they are collected rather than applied on the spot,
 * and {@link TermClusterSet.unifyGroups} drains the collection through a work list. Recursing instead
 * would re-enter a merge halfway through the one running.
 */
export type GroupConstraint<Term> =
  { kind: 'pin'; group: number; pin: Pin<Term> } | { kind: 'unify'; left: number; right: number };

/**
 * What comes of meeting the two pins a group is asked to carry at once: the pin it is left with, plus
 * what meeting them *entailed* about other groups. A meet that no value satisfies is reported as `false`
 * instead - the contradiction.
 *
 * Two shapes entail that their positions are pairwise equal; a ground triple term meeting a shape
 * entails what each position of that shape is. Which is the same pair of things the work list already
 * handles, so it is those it is written in.
 */
export interface PinMeet<Term> {
  /** The pin the group keeps - the more informative of the two. */
  pin: Pin<Term>;
  /** What meeting the two entailed, for the work list to establish in turn. */
  entailed: GroupConstraint<Term>[];
}

/**
 * A {@link ClusterSet} whose groups may be *pinned*: every value in the group equals what the pin says -
 * a term, or the shape of a triple term whose positions are groups in their own right.
 *
 * The two users of this differ in what a pin conflict means, which is why {@link setPin} reports one
 * rather than raising it. For the unfolding ({@link ClusterSolver}) a group asked to be two terms at once
 * is a broken mapping, and it throws; for an assertion conjunction it is an ordinary contradiction, and it
 * becomes the empty operation. They also differ in the terms they allow - the solver narrows to a
 * {@link RawBasicTerm} by the range of the triple position - hence the second type parameter, and in what
 * meeting two pins comes to, hence {@link meetPins}.
 *
 * **Ranges** live here rather than only in the solver, because the same question is asked on both sides:
 * a group in a subject position holds no Literal and no triple term, which is what makes the nesting of
 * shapes run down the `object` chain and no further, and what decides a pin the position cannot hold
 * before anything downstream has to type-check it.
 *
 * A pin makes the child DAG a real graph, and two invariants keep it well founded:
 *
 * - **occurs check**: a group may not reach itself through the pins, since `?o ≡ <<( ?o … )>>` has no
 *   solution and resolving such a group to a term would not terminate. Checked over the whole graph after
 *   a unification settles, since a merge closes a cycle just as a pin does.
 * - **liveness**: a group that is the child of a live pin survives {@link remove} however few members it
 *   has left, or the pin pointing at it would dangle.
 */
export class TermClusterSet<T, Term extends { termType: RDF.Term['termType'] }> extends ClusterSet<T> {
  /** Maps group ID to what the group is pinned to (if anything) - read through {@link pinOf}. */
  protected groupToPin: Record<number, Pin<Term> | undefined>;
  /** Maps group ID to the term types its value may have, needed for groups that are e.g. the subject of a TripleTerm */
  protected groupToRange: Record<number, RangeSet>;
  /**
   * A history of oldGroups (keys) that got merged into newGroups (values).
   * Needed to dereference removed groups still used in a pin.
   */
  protected groupMergeHistory: Record<number, number>;

  /**
   * @param toId how to transform the object to a string (key) representation
   * @param meetPins a callback that merges/ meets two pins,
   *   returns false if the two pins merging forms a contradiction.
   */
  public constructor(
    toId: (value: T) => string,
    protected readonly meetPins: (a: Pin<Term>, b: Pin<Term>) => PinMeet<Term> | false,
  ) {
    super(toId);
    this.clear();
  }

  public override clear(): void {
    super.clear();
    this.groupToPin = {};
    this.groupToRange = {};
    this.groupMergeHistory = {};
  }

  public override clone(): TermClusterSet<T, Term> {
    const copy = new TermClusterSet<T, Term>(this.toId, this.meetPins);
    this.copyInto(copy);
    return copy;
  }

  protected override copyInto(target: ClusterSet<T>): void {
    super.copyInto(target);
    const copy = <TermClusterSet<T, Term>> target;
    copy.groupToPin = { ...this.groupToPin };
    copy.groupToRange = { ...this.groupToRange };
    copy.groupMergeHistory = { ...this.groupMergeHistory };
  }

  /** The group a merged-away id has become - the identity for one that is still its own group. */
  public resolveGroup(group: number): number {
    let resolved = group;
    while (this.groupMergeHistory[resolved] !== undefined) {
      resolved = this.groupMergeHistory[resolved];
    }
    return resolved;
  }

  /** What the group is pinned to, or `undefined` when nothing fixes its value. */
  public pinOf(group: number): Pin<Term> | undefined {
    return this.groupToPin[this.resolveGroup(group)];
  }

  /** The term the group is pinned to, or `undefined` when nothing pins it, or a shape does instead. */
  public termOf(group: number): Term | undefined {
    const pin = this.pinOf(group);
    return pin?.kind === 'term' ? pin.term : undefined;
  }

  /** The positions of the shape the group is pinned to, or `undefined` when it is not pinned to one. */
  public childrenOf(group: number): PinChildren | undefined {
    const pin = this.pinOf(group);
    if (pin?.kind !== 'triple') {
      return undefined;
    }
    return {
      subject: this.resolveGroup(pin.subject),
      predicate: this.resolveGroup(pin.predicate),
      object: this.resolveGroup(pin.object),
    };
  }

  /** The term types the group's value may have. */
  public rangeOf(group: number): RangeSet {
    return this.groupToRange[this.resolveGroup(group)] ?? objectRange;
  }

  /**
   * Pins a term onto a group, or reports that the group already carries something incompatible.
   * @returns `false` when the two cannot both hold, leaving the set in a state no caller may read.
   */
  public setTerm(group: number, term: Term): boolean {
    return this.setPin(group, { kind: 'term', term });
  }

  /**
   * Pins a group, meeting the pin with whatever the group already carries and draining everything that
   * meet decides ({@link PinMeet}).
   * @returns `false` on a contradiction, after which the set holds no meaningful state.
   */
  private setPin(group: number, pin: Pin<Term>): boolean {
    return this.resolveAllConstraints([{ kind: 'pin', group, pin }]);
  }

  public assertTriplePin(group: number): PinChildren | false {
    const resolved = this.resolveGroup(group);
    const known = this.childrenOf(resolved);
    if (known !== undefined) {
      // It is already known to be a triple term
      return known;
    }
    const children: PinChildren = {
      subject: this.createPositionGroup('subject'),
      predicate: this.createPositionGroup('predicate'),
      object: this.createPositionGroup('object'),
    };
    if (this.setPin(resolved, { kind: 'triple', ...children })) {
      return this.childrenOf(resolved)!;
    }
    return false;
  }

  /**
   * Narrows what terms the group's value may have.
   * @returns `false` when nothing is left for it to be, or when its pin is not one of those terms.
   */
  public narrowRange(group: number, range: RangeSet): boolean {
    const resolved = this.resolveGroup(group);
    const narrowed = this.rangeOf(resolved).disjunct(range);
    this.groupToRange[resolved] = narrowed;
    return narrowed.size > 0 && this.rangeAdmits(resolved, this.groupToPin[resolved]);
  }

  /**
   * Unifies two groups by id - the merge {@link mergeGroups} is, for the groups no value names.
   * @returns `false` when the two cannot hold the same value.
   */
  public unifyGroups(left: number, right: number): boolean {
    return this.resolveAllConstraints([{ kind: 'unify', left, right }]);
  }

  /**
   * Merges two groups, carrying over everything the disappearing one held.
   * @returns `conflict` when the two could not hold the same value, which leaves the set in a state no
   * caller may read - what to do about that is up to the two callers.
   */
  public override mergeGroups(from: T, to: T): { oldGroup: number; newGroup: number; conflict: boolean } | undefined {
    const fromGroup = this.getGroup(from);
    const toGroup = this.getGroup(to);
    if (fromGroup === toGroup) {
      return undefined;
    }
    const conflict = !this.unifyGroups(fromGroup, toGroup);
    const newGroup = this.resolveGroup(toGroup);
    return { oldGroup: newGroup === toGroup ? fromGroup : toGroup, newGroup, conflict };
  }

  /**
   * Runs a work list of merges and pins to exhaustion.
   *
   * @return false in case of a contradiction
   */
  private resolveAllConstraints(work: GroupConstraint<Term>[]): boolean {
    while (work.length > 0) {
      const item = work.shift()!;
      const staysValid = item.kind === 'unify' ?
        this.unite(this.resolveGroup(item.left), this.resolveGroup(item.right), work) :
        this.place(this.resolveGroup(item.group), item.pin, work);
      if (!staysValid) {
        return false;
      }
    }
    // A cycle is closed by a merge just as much as by a pin, so the check is over the settled graph.
    return !this.hasCycle();
  }

  /**
   * Merges two live groups, queueing whatever meeting their pins decides.
   * @return false on a contradiction
   */
  private unite(left: number, right: number, work: GroupConstraint<Term>[]): boolean {
    const merged = this.mergeGroupIds(left, right);
    // Nothing to merge
    if (merged === undefined) {
      return true;
    }
    const { oldGroup, newGroup } = merged;
    this.groupMergeHistory[oldGroup] = newGroup;
    this.migrateGroupData(oldGroup, newGroup);
    const oldRange = this.groupToRange[oldGroup] ?? objectRange;
    const oldPin = this.groupToPin[oldGroup];
    delete this.groupToRange[oldGroup];
    delete this.groupToPin[oldGroup];
    if (!this.narrowRange(newGroup, oldRange)) {
      return false;
    }
    return oldPin === undefined || this.place(newGroup, oldPin, work);
  }

  /** Puts a pin on a group, meeting it with the one already there and queueing what that decides. */
  private place(group: number, pin: Pin<Term>, work: GroupConstraint<Term>[]): boolean {
    const currentPin = this.groupToPin[group];
    let keptPin = pin;
    if (currentPin !== undefined) {
      const pinMeet = this.meetPins(currentPin, pin);
      if (pinMeet === false) {
        return false;
      }
      keptPin = pinMeet.pin;
      work.push(...pinMeet.entailed);
    }
    this.groupToPin[group] = keptPin;
    // A pin is a range statement too, and the sharper one: a group pinned to a NamedNode holds nothing else.
    return this.narrowRange(
      group,
      keptPin.kind === 'triple' ? tripleTermRange : new RangeSet([ keptPin.term.termType ]),
    );
  }

  /** Whether the pin - if there is one - is a term the range still admits. */
  private rangeAdmits(group: number, pin: Pin<Term> | undefined): boolean {
    if (pin === undefined) {
      return true;
    }
    return this.rangeOf(group).has(pin.kind === 'term' ? pin.term.termType : 'Quad');
  }

  /**
   * Whether any group is its own descendant, which no value satisfies: a triple term is strictly larger
   * than each of its components, so `?o ≡ <<( ?o … )>>` is unsatisfiable - and resolving such a group to
   * a term would not terminate.
   */
  private hasCycle(): boolean {
    // Done, for example because you already descended top level, and did not find any cycle, can shortcut and stop.
    const done = new Set<number>();
    const onCurPath = new Set<number>();
    const descendHasCycle = (group: number): boolean => {
      const resolved = this.resolveGroup(group);
      if (onCurPath.has(resolved)) {
        return true;
      }
      if (done.has(resolved)) {
        return false;
      }
      onCurPath.add(resolved);
      const cyclic = childGroupsOf(this.childrenOf(resolved)).some(child => descendHasCycle(child));
      onCurPath.delete(resolved);
      done.add(resolved);
      return cyclic;
    };
    return Object.keys(this.groupToValues).some(group => descendHasCycle(Number(group)));
  }

  /** A pinned group still constrains its last remaining member, so it survives {@link remove}. */
  protected override carriesInformation(group: number): boolean {
    return this.groupToPin[group] !== undefined;
  }

  /**
   * A group a live pin points at survives however few members it has: it is a *position* of a shape, and
   * dropping it would leave the shape naming a group that is no longer there. The sharpest trap in the
   * lattice, since the group nobody named is exactly the one {@link remove} would otherwise take away.
   */
  protected override isLive(group: number): boolean {
    return super.isLive(group) || this.isPinChild(group);
  }

  /** Whether some group's shape holds this one in one of its positions. */
  private isPinChild(group: number): boolean {
    const resolved = this.resolveGroup(group);
    return Object.keys(this.groupToPin)
      .some(owner => childGroupsOf(this.childrenOf(Number(owner))).includes(resolved));
  }

  /** An anonymous group for one position of a shape, holding what that position admits and no more. */
  private createPositionGroup(position: TriplePosition): number {
    const group = this.createEmptyGroup();
    this.groupToRange[group] = rangeOfPosition(position);
    return group;
  }

  protected override createEmptyGroup(): number {
    const group = super.createEmptyGroup();
    this.groupToPin[group] = undefined;
    this.groupToRange[group] = objectRange;
    return group;
  }

  protected override dropGroup(group: number): void {
    super.dropGroup(group);
    delete this.groupToPin[group];
    delete this.groupToRange[group];
  }
}

/** The three positions of a shape as a list, for the rules that ask something of every one of them. */
export function childGroupsOf(children: PinChildren | undefined): number[] {
  return children === undefined ? [] : [ children.subject, children.predicate, children.object ];
}
