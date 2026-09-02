import type * as RDF from '@rdfjs/types';
import { objectRange, RangeSet, rangeOfPosition, tripleTermRange } from '../RangeSet.js';
import { ClusterSet } from './ClusterSet.js';

/** The position a triple term holds one of its three components in. */
export type TriplePosition = 'subject' | 'predicate' | 'object';

/** The three positions, in the order a triple term writes them. */
export const triplePositions: readonly TriplePosition[] = [ 'subject', 'predicate', 'object' ];

/**
 * Whether a name is one of the three positions - which is also whether an operator is the accessor that
 * reads it, the two being spelt the same.
 * @param name - The name to check
 * @returns whether it is a {@link TriplePosition}
 */
export function isTriplePosition(name: string): name is TriplePosition {
  return (<readonly string[]> triplePositions).includes(name);
}

/** The groups a triple pin holds its three components in, one per position. */
export type PinChildren = Readonly<Record<TriplePosition, number>>;

/**
 * The constraint a group carries: every value in it equals what the pin says.
 *
 * A `term` pin *is* the value. A `triple` pin is a **shape** - the value is a triple term, and each of its
 * three positions is a group in its own right - so it fixes a value only once all three are decided, and
 * constrains it partially until then. Holding group ids rather than terms is what makes a position nobody
 * named an *anonymous* group: it unifies and carries a pin and a range like any other, while contributing
 * nothing to the members of the set.
 */
export type Pin<Term> = TriplePin | { kind: 'term'; term: Term };

/** The shape half of a {@link Pin}, named so that a meet can take one and hand one back. */
export type TriplePin = { kind: 'triple' } & PinChildren;

/**
 * One thing that has to hold of the groups, and does not yet: two of them hold the same value, or one of
 * them carries a pin.
 *
 * Collected rather than applied on the spot, since establishing either may establish further ones - merging
 * two groups meets their pins, and meeting two pins merges the groups their positions name - and recursing
 * would re-enter a merge halfway through the one running.
 */
export type GroupConstraint<Term> =
  { kind: 'pin'; group: number; pin: Pin<Term> } | { kind: 'unify'; left: number; right: number };

/**
 * What comes of meeting the two pins a group is asked to carry at once: the pin it is left with, plus what
 * meeting them *entailed* about other groups. A meet no value satisfies is reported as `false` instead.
 */
export interface PinMeet<Term> {
  /** The pin the group keeps - the more informative of the two. */
  pin: Pin<Term>;
  /** What meeting the two entailed, for the work list to establish in turn. */
  entailed: GroupConstraint<Term>[];
}

/**
 * The meet of two shapes on one group: one value spelt twice, so its positions are pairwise one value too.
 * @param left - One of the two shapes, and the one the group keeps
 * @param right - The other
 * @returns the pin the group keeps and the unifications the meet entailed
 */
export function meetShapes<Term>(left: TriplePin, right: TriplePin): PinMeet<Term> {
  return {
    pin: left,
    entailed: triplePositions.map(position => ({ kind: 'unify', left: left[position], right: right[position] })),
  };
}

/**
 * A {@link ClusterSet} whose groups may be *pinned*: every value in the group equals what the pin says - a
 * term, or the shape of a triple term whose positions are groups in their own right.
 *
 * Its two users differ in what a pin conflict means, which is why {@link setPin} reports one rather than
 * raising it: for the unfolding ({@link ClusterSolver}) a group asked to be two terms at once is a broken
 * mapping, for an assertion conjunction it is an ordinary contradiction. They also differ in the terms a
 * pin may hold, hence the second type parameter, and in what meeting two pins comes to, hence
 * {@link meetPins}.
 *
 * **Ranges** live here rather than only in the solver, since the same question is asked on both sides: a
 * group in a subject position holds no Literal and no triple term, which is what confines the nesting of
 * shapes to the `object` chain.
 *
 * A pin makes the child DAG a real graph, and two invariants keep it well founded:
 *
 * - **occurs check**: a group may not reach itself through the pins, `?o ≡ <<( ?o ... )>>` having no
 *   solution. Checked once a whole work list settles rather than as each pin lands, since a merge closes a
 *   cycle just as a pin does - and only from the groups that work list touched, the rest of the graph having
 *   been acyclic before it ran ({@link hasCycle}).
 * - **liveness**: a group that is the child of a live pin survives {@link remove} however few members it
 *   has left, or the pin pointing at it would dangle.
 */
export class TermClusterSet<T, Term extends { termType: RDF.Term['termType'] }> extends ClusterSet<T> {
  /** Maps group ID to what the group is pinned to (if anything) - read through {@link pinOf}. */
  protected groupToPin: Record<number, Pin<Term> | undefined>;
  /** Maps group ID to the term types its value may have - read through {@link rangeOf}. */
  protected groupToRange: Record<number, RangeSet>;
  /**
   * A history of oldGroups (keys) that got merged into newGroups (values).
   * Needed to dereference removed groups still used in a pin.
   */
  protected groupMergeHistory: Record<number, number>;
  /**
   * The reverse of {@link childrenOf}, keyed by *resolved* group: the groups whose shape holds this one in
   * one of its positions. It is what {@link isPinChild} reads instead of walking every pin there is, that
   * question being asked on every {@link ClusterSet.remove}.
   *
   * Kept as an over-approximation the lookup verifies against the pins themselves, so that the only thing
   * maintenance owes it is never to *lose* an owner: entries move with the group they are keyed by
   * ({@link migrateGroupData}) and are dropped with it ({@link dropGroup}), while an owner whose pin has
   * moved on is pruned the next time it is read.
   */
  private pinChildToOwners: Record<number, Set<number>>;
  /**
   * Whether the last work list to settle left the pins acyclic, which is what lets {@link hasCycle} start
   * from the groups a run touched rather than from every group there is. Cleared by a run that gives up
   * halfway, since the constraints it did establish may have closed a cycle nothing went on to check.
   *
   * `false` is *not known to be acyclic*, never *cyclic*. Nothing reads it as an answer: all it decides is
   * where {@link hasCycle} starts from, so being wrong about it the safe way costs a walk of every group
   * and nothing else.
   */
  private acyclic: boolean;

  /**
   * @param toId - How to transform a value into its string key
   * @param meetPins - Meets the two pins a group is asked to carry at once, reporting `false` when no value
   * satisfies both
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
    this.pinChildToOwners = {};
    this.acyclic = true;
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
    copy.pinChildToOwners = Object.fromEntries(
      Object.entries(this.pinChildToOwners).map(([ child, owners ]) => [ child, new Set(owners) ]),
    );
    copy.acyclic = this.acyclic;
  }

  /**
   * Dereferences a group id through the merge history.
   * @param group - The id to resolve
   * @returns the group it has become, or itself when it is still its own group
   */
  public resolveGroup(group: number): number {
    let resolved = group;
    while (this.groupMergeHistory[resolved] !== undefined) {
      resolved = this.groupMergeHistory[resolved];
    }
    return resolved;
  }

  /**
   * The pin of a group.
   * @param group - The group to look up
   * @returns what it is pinned to, or `undefined` when nothing fixes its value
   */
  public pinOf(group: number): Pin<Term> | undefined {
    return this.groupToPin[this.resolveGroup(group)];
  }

  /**
   * The term a group is pinned to.
   * @param group - The group to look up
   * @returns the term, or `undefined` when nothing pins it, or a shape does instead
   */
  public termOf(group: number): Term | undefined {
    const pin = this.pinOf(group);
    return pin?.kind === 'term' ? pin.term : undefined;
  }

  /**
   * The positions of the shape a group is pinned to.
   * @param group - The group to look up
   * @returns the group per position, or `undefined` when it is not pinned to a shape
   */
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

  /**
   * The term types a group's value may have.
   * @param group - The group to look up
   * @returns its range, the top of the lattice when nothing narrowed it
   */
  public rangeOf(group: number): RangeSet {
    return this.groupToRange[this.resolveGroup(group)] ?? objectRange;
  }

  /**
   * Pins a term onto a group.
   * @param group - The group to pin
   * @param term - The term every value of it equals
   * @returns `false` when the group already carries something incompatible, which leaves the set in a state
   * no caller may read
   */
  public setTerm(group: number, term: Term): boolean {
    return this.setPin(group, { kind: 'term', term });
  }

  /**
   * Pins a group, meeting the pin with whatever the group already carries and draining everything that meet
   * decides ({@link PinMeet}).
   * @param group - The group to pin
   * @param pin - What every value of it equals
   * @returns `false` on a contradiction, after which the set holds no meaningful state
   */
  private setPin(group: number, pin: Pin<Term>): boolean {
    return this.resolveAllConstraints([{ kind: 'pin', group, pin }]);
  }

  /**
   * Gives a group the shape of a triple term, creating an anonymous group per position where it has none.
   * @param group - The group to shape
   * @returns the group per position, or `false` when the group cannot hold a triple term
   */
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
   * Narrows what terms a group's value may have.
   * @param group - The group to narrow
   * @param range - The term types to narrow it to
   * @returns `false` when nothing is left for it to be, or when its pin is not one of those terms
   */
  public narrowRange(group: number, range: RangeSet): boolean {
    this.touch();
    const resolved = this.resolveGroup(group);
    const narrowed = this.rangeOf(resolved).meet(range);
    this.groupToRange[resolved] = narrowed;
    return narrowed.size > 0 && this.rangeAdmits(resolved, this.groupToPin[resolved]);
  }

  /**
   * Unifies two groups by id - the merge {@link mergeGroups} is, for the groups no value names.
   * @param left - One group
   * @param right - The other
   * @returns `false` when the two cannot hold the same value
   */
  public unifyGroups(left: number, right: number): boolean {
    return this.resolveAllConstraints([{ kind: 'unify', left, right }]);
  }

  /**
   * Merges two groups, carrying over everything the disappearing one held.
   * @param from - One of the values whose group to merge
   * @param to - The other
   * @returns the ids involved and whether the two could not hold the same value, which leaves the set in a
   * state no caller may read - what to do about that is up to the two subclasses; `undefined` when both
   * values were already in one group
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
   * @param work - The constraints to establish, which establishing them adds to
   * @returns `false` on a contradiction
   */
  private resolveAllConstraints(work: GroupConstraint<Term>[]): boolean {
    this.touch();
    // The groups the run pins or merges, which is where a cycle it closed has to pass through.
    const touched: number[] = [];
    while (work.length > 0) {
      const item = work.shift()!;
      let staysValid: boolean;
      if (item.kind === 'unify') {
        const left = this.resolveGroup(item.left);
        const right = this.resolveGroup(item.right);
        touched.push(left, right);
        staysValid = this.unite(left, right, work);
      } else {
        const group = this.resolveGroup(item.group);
        touched.push(group);
        staysValid = this.place(group, item.pin, work);
      }
      if (!staysValid) {
        this.acyclic = false;
        return false;
      }
    }
    // A cycle is closed by a merge just as much as by a pin, so the check is over the settled graph.
    if (this.hasCycle(touched)) {
      this.acyclic = false;
      return false;
    }
    this.acyclic = true;
    return true;
  }

  /**
   * Merges two live groups, queueing whatever meeting their pins decides.
   * @param left - One group
   * @param right - The other
   * @param work - The work list to queue onto
   * @returns `false` on a contradiction
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
    // The pin moves onto `newGroup` just below, which is what re-registers its positions.
    this.unregisterPinChildren(oldGroup, oldPin);
    if (!this.narrowRange(newGroup, oldRange)) {
      return false;
    }
    return oldPin === undefined || this.place(newGroup, oldPin, work);
  }

  /**
   * Puts a pin on a group, meeting it with the one already there and queueing what that decides.
   * @param group - The group to pin
   * @param pin - The pin to place
   * @param work - The work list to queue onto
   * @returns `false` on a contradiction
   */
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
    this.unregisterPinChildren(group, currentPin);
    this.groupToPin[group] = keptPin;
    this.registerPinChildren(group, keptPin);
    // A pin is a range statement too, and the sharper one: a group pinned to a NamedNode holds nothing else.
    return this.narrowRange(
      group,
      keptPin.kind === 'triple' ? tripleTermRange : new RangeSet([ keptPin.term.termType ]),
    );
  }

  /**
   * Whether the pin - if there is one - is a term the group's range still admits.
   * @param group - The group whose range to read
   * @param pin - The pin to check
   * @returns whether the two agree
   */
  private rangeAdmits(group: number, pin: Pin<Term> | undefined): boolean {
    if (pin === undefined) {
      return true;
    }
    return this.rangeOf(group).has(pin.kind === 'term' ? pin.term.termType : 'Quad');
  }

  /**
   * Whether any group is its own descendant, which no value satisfies: a triple term is strictly larger than
   * each of its components, so `?o ≡ <<( ?o ... )>>` is unsatisfiable - and resolving such a group to a term
   * would not terminate.
   *
   * Descending from `touched` alone is the whole graph's answer whenever the graph was acyclic before the run
   * ({@link acyclic}): a cycle that holds none of the groups the run pinned or merged holds none of its new
   * edges either - the pins of those groups are the only ones it changed, and a merge is the identification
   * of two groups into one of them - so it was there to be found on the way in. Where that does not hold,
   * every group is a root again.
   * @param touched - The groups the run that is settling pinned or merged
   * @returns whether the pins close a cycle
   */
  private hasCycle(touched: readonly number[]): boolean {
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
    const roots = this.acyclic ? touched : Object.keys(this.groupToValues).map(Number);
    return roots.some(group => descendHasCycle(group));
  }

  /**
   * A pinned group still constrains its last remaining member, so it survives {@link remove}.
   * @param group - The group to check
   * @returns whether it is pinned
   */
  protected override carriesInformation(group: number): boolean {
    return this.groupToPin[group] !== undefined;
  }

  /**
   * A group a live pin points at survives however few members it has: it is a *position* of a shape, and
   * dropping it would leave that shape naming a group that is no longer there.
   * @param group - The group to check
   * @returns whether it is worth keeping
   */
  protected override isLive(group: number): boolean {
    return super.isLive(group) || this.isPinChild(group);
  }

  /**
   * Whether some group's shape holds this one in one of its positions, read off {@link pinChildToOwners}
   * and checked against the pins of the owners it names - which is also where an owner that no longer
   * points here is pruned.
   * @param group - The group to look for
   * @returns whether anything points at it
   */
  private isPinChild(group: number): boolean {
    const resolved = this.resolveGroup(group);
    const owners = this.pinChildToOwners[resolved];
    if (owners === undefined) {
      return false;
    }
    for (const owner of owners) {
      if (childGroupsOf(this.childrenOf(owner)).includes(resolved)) {
        return true;
      }
      owners.delete(owner);
    }
    delete this.pinChildToOwners[resolved];
    return false;
  }

  /**
   * Records a group as an owner of every position of the pin it just took on.
   * @param owner - The group carrying the pin
   * @param pin - The pin it carries, positions of which are groups when it is a shape
   */
  private registerPinChildren(owner: number, pin: Pin<Term> | undefined): void {
    for (const child of childGroupsOf(pin?.kind === 'triple' ? pin : undefined)) {
      const resolved = this.resolveGroup(child);
      if (this.pinChildToOwners[resolved] === undefined) {
        this.pinChildToOwners[resolved] = new Set();
      }
      this.pinChildToOwners[resolved].add(owner);
    }
  }

  /**
   * Takes a group back out as an owner of the positions of a pin it no longer carries.
   * @param owner - The group that carried the pin
   * @param pin - The pin it is losing
   */
  private unregisterPinChildren(owner: number, pin: Pin<Term> | undefined): void {
    for (const child of childGroupsOf(pin?.kind === 'triple' ? pin : undefined)) {
      this.pinChildToOwners[this.resolveGroup(child)]?.delete(owner);
    }
  }

  /**
   * Creates an anonymous group for one position of a shape, holding what that position admits and no more.
   * @param position - The position it stands for
   * @returns the new group
   */
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

  /**
   * Carries the owners pointing at the disappearing group over: {@link pinChildToOwners} is keyed by
   * resolved group, and this is the point at which the two ids become one.
   * @param oldGroup - The group disappearing
   * @param newGroup - The group surviving
   */
  protected override migrateGroupData(oldGroup: number, newGroup: number): void {
    super.migrateGroupData(oldGroup, newGroup);
    const inherited = this.pinChildToOwners[oldGroup];
    if (inherited !== undefined) {
      delete this.pinChildToOwners[oldGroup];
      const owners = this.pinChildToOwners[newGroup];
      if (owners === undefined) {
        this.pinChildToOwners[newGroup] = inherited;
      } else {
        for (const owner of inherited) {
          owners.add(owner);
        }
      }
    }
  }

  protected override dropGroup(group: number): void {
    super.dropGroup(group);
    this.unregisterPinChildren(group, this.groupToPin[group]);
    delete this.groupToPin[group];
    delete this.groupToRange[group];
    delete this.pinChildToOwners[group];
  }
}

/**
 * The three positions of a shape as a list, for the rules that ask something of every one of them.
 * @param children - The positions of a shape, or `undefined` for a group without one
 * @returns the groups, empty for a group without a shape
 */
export function childGroupsOf(children: PinChildren | undefined): number[] {
  return children === undefined ? [] : [ children.subject, children.predicate, children.object ];
}
