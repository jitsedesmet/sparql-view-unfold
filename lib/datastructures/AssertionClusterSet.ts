import type * as RDF from '@rdfjs/types';
import { objectRange } from '../RangeSet.js';
import type { RangeSet } from '../RangeSet.js';
import type { Pin, PinMeet, TriplePin } from './TermClusterSet.js';
import { meetShapes, TermClusterSet, triplePositions } from './TermClusterSet.js';

/**
 * The {@link TermClusterSet} an {@link utils/assertionConjunction!AssertionConjunction} is built on:
 * groups of RDF terms, meeting pins the way a conjunction of `sameTerm` conditions needs them met, and
 * remembering which part of a group's range it was *told* rather than worked out.
 *
 * That last part is here rather than in {@link TermClusterSet} because it is not a fact about groups at all
 * - it is about writing them back out as a condition, which only a conjunction ever does. The set narrows a
 * range from wherever it can, and those narrowings hold wherever the group is written, so restating them
 * would say nothing and would grow the condition on every pass.
 *
 * The two are kept in step by {@link assertTermTypeRange} narrowing both, which gives the invariant
 * everything else relies on: **the asserted range always contains the effective one**. So the asserted half
 * never decides anything the effective half does not.
 */
export class AssertionClusterSet extends TermClusterSet<string, RDF.Term> {
  /** Maps group ID to the part of its range a condition asserted, rather than the set working it out */
  protected groupToAssertedRange: Record<number, RangeSet>;

  public constructor() {
    super(name => name, meetTermPins);
    this.clear();
  }

  public override clear(): void {
    super.clear();
    this.groupToAssertedRange = {};
  }

  /**
   * A copy that shares no state with this one.
   *
   * Overridden rather than inherited: {@link TermClusterSet.clone} builds a set of *its* class, which would
   * leave the asserted ranges behind on every clone the conjunction takes.
   * @returns the copy
   */
  public override clone(): AssertionClusterSet {
    const copy = new AssertionClusterSet();
    this.copyInto(copy);
    return copy;
  }

  protected override copyInto(target: AssertionClusterSet): void {
    super.copyInto(target);
    target.groupToAssertedRange = { ...this.groupToAssertedRange };
  }

  /**
   * The part of {@link rangeOf} a condition asserted, as against the part we worked out for ourselves.
   * @param group - The group to look up
   * @returns the asserted term types, the top of the lattice when nothing was asserted
   */
  public assertedRangeOf(group: number): RangeSet {
    return this.groupToAssertedRange[this.resolveGroup(group)] ?? objectRange;
  }

  /**
   * Narrows the group's range with something a condition *asserts* of it, which {@link assertedRangeOf}
   * reports back and everything else treats as an ordinary narrowing.
   * @param group - The group to narrow
   * @param range - The term types the condition asserts its value has
   * @returns `false` when nothing is left for it to be, or when its pin is not one of those terms
   */
  public assertTermTypeRange(group: number, range: RangeSet): boolean {
    // Stamped on its own account rather than through the `narrowRange` below: the asserted range is state
    // of this class, which nothing further up writes, and leaning on that delegation would make the stamp
    // depend on where another class happens to put its own `touch`.
    this.touch();
    const resolved = this.resolveGroup(group);
    this.groupToAssertedRange[resolved] = this.assertedRangeOf(resolved).meet(range);
    return this.narrowRange(resolved, range);
  }

  /**
   * Carries the asserted range of the disappearing group over: both groups hold one value, so it is asserted
   * of that value whichever of them it was asserted of.
   * @param oldGroup - The group disappearing
   * @param newGroup - The group surviving
   */
  protected override migrateGroupData(oldGroup: number, newGroup: number): void {
    super.migrateGroupData(oldGroup, newGroup);
    this.groupToAssertedRange[newGroup] = this.assertedRangeOf(newGroup)
      .meet(this.groupToAssertedRange[oldGroup] ?? objectRange);
    delete this.groupToAssertedRange[oldGroup];
  }

  /**
   * A group a condition narrowed the range of carries information however few members it has: what it was
   * told is what its last member is still constrained by, and what {@link
   * utils/assertionConjunction!AssertionConjunction.get} reads back out of it as `T⟨?x : τ⟩`.
   *
   * Without this the whole of `FILTER(isTRIPLE(?x))` would be dropped the moment its group falls to one
   * member - which the transfer through a `BIND(?y AS ?x)` does at once, `?x` leaving the group it just
   * put `?y` in - and a condition dropped from Θ is a condition dropped from the query.
   * @param group - The group to check
   * @returns whether it is worth keeping
   */
  protected override carriesInformation(group: number): boolean {
    // A meet only ever shrinks, so a range that is not the top is one something narrowed.
    return super.carriesInformation(group) || this.assertedRangeOf(group).size < objectRange.size;
  }

  protected override createEmptyGroup(): number {
    const group = super.createEmptyGroup();
    this.groupToAssertedRange[group] = objectRange;
    return group;
  }

  protected override dropGroup(group: number): void {
    super.dropGroup(group);
    delete this.groupToAssertedRange[group];
  }
}

/**
 * The meet of two pins on one group of an assertion conjunction: two terms are the equality they always
 * were, two shapes the pairwise unification {@link meetShapes} is, and a ground triple term meeting a shape
 * decomposes the same way.
 * @param left - One of the two pins
 * @param right - The other
 * @returns what the group is left with plus what the meet entailed, or `false` on a contradiction
 */
function meetTermPins(left: Pin<RDF.Term>, right: Pin<RDF.Term>): PinMeet<RDF.Term> | false {
  if (left.kind === 'triple') {
    return right.kind === 'triple' ? meetShapes(left, right) : decomposedAgainst(left, right.term);
  }
  if (right.kind === 'triple') {
    return decomposedAgainst(right, left.term);
  }
  return left.term.equals(right.term) ? { pin: left, entailed: []} : false;
}

/**
 * A ground triple term meeting a shape: the same decomposition two shapes are, with the components already
 * known.
 * @param shape - The shape the group carries, and the pin it keeps - its positions are groups other things
 * may be equal to, and the term reads back off a shape all of whose positions are decided
 * @param ground - The term it has to agree with
 * @returns the pin and the pins its positions take, or `false` when the term is no triple term at all
 */
function decomposedAgainst(shape: TriplePin, ground: RDF.Term): PinMeet<RDF.Term> | false {
  if (ground.termType === 'Quad' && ground.graph.termType === 'DefaultGraph') {
    return {
      pin: shape,
      entailed: triplePositions.map(position =>
        ({ kind: 'pin', group: shape[position], pin: { kind: 'term', term: ground[position] }})),
    };
  }
  return false;
}
