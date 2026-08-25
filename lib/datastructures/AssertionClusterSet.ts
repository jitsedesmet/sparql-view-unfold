import type * as RDF from '@rdfjs/types';
import { objectRange } from '../RangeSet.js';
import type { RangeSet } from '../RangeSet.js';
import type { Pin, PinMeet, TriplePin } from './TermClusterSet.js';
import { TermClusterSet, triplePositions } from './TermClusterSet.js';

/**
 * The {@link TermClusterSet} an {@link AssertionConjunction} is built on: groups of RDF terms, meeting
 * pins the way a conjunction of `sameTerm` conditions needs them met, and remembering which part of a
 * group's range it was *told* rather than worked out.
 *
 * That last part is here rather than in {@link TermClusterSet} because it is not a fact about groups at
 * all - it is about writing them back out as a condition, which only a conjunction ever does. The set
 * itself narrows a range from wherever it can (the position a group sits in, the pin it carries, what the
 * plan leaves the variables in it), and those hold wherever the group is written: restating them would
 * say nothing and would grow the condition on every pass. What a condition asserted is the part that has
 * to survive the round trip, so it is tracked apart from the rest.
 *
 * The two are kept in step by {@link assertTermTypeRange} narrowing both, which gives the invariant
 * everything else here relies on: **the asserted range always contains the effective one**. So the
 * asserted half never decides anything the effective half does not - a merge whose asserted ranges have
 * nothing in common is one whose effective ranges have nothing in common either, and that is the merge
 * {@link TermClusterSet} already refuses.
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
   * Overridden rather than inherited: {@link TermClusterSet.clone} builds a set of *its* class, which
   * would leave the asserted ranges behind on every clone the conjunction takes.
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
   * Narrows the group's range with something a condition *asserts* of it, which
   * {@link assertedRangeOf} reports back and everything else treats as an ordinary narrowing.
   * @param group - The group to narrow
   * @param range - The term types the condition asserts its value has
   * @returns `false` when nothing is left for it to be, or when its pin is not one of those terms
   */
  public assertTermTypeRange(group: number, range: RangeSet): boolean {
    const resolved = this.resolveGroup(group);
    this.groupToAssertedRange[resolved] = this.assertedRangeOf(resolved).disjunct(range);
    return this.narrowRange(resolved, range);
  }

  /**
   * Carries the asserted range of the disappearing group over: both groups hold one value, so it is
   * asserted of that value whichever of them it was asserted of.
   *
   * Nothing to report when the two have nothing in common. The asserted range contains the effective one,
   * so an empty meet here is an empty meet there, and the range migration around this call refuses it.
   */
  protected override migrateGroupData(oldGroup: number, newGroup: number): void {
    super.migrateGroupData(oldGroup, newGroup);
    this.groupToAssertedRange[newGroup] = this.assertedRangeOf(newGroup)
      .disjunct(this.groupToAssertedRange[oldGroup] ?? objectRange);
    delete this.groupToAssertedRange[oldGroup];
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
 * The meet of two pins on one group of an assertion conjunction.
 *
 * Two terms are the equality they always were. Two shapes decompose: `?o ≡ <<( a b c )>>` and
 * `?o ≡ <<( d e f )>>` say `a ≡ d`, `b ≡ e`, `c ≡ f`, which is syntactic unification and is what makes
 * everything known about `SUBJECT(?o)` known about `SUBJECT(?x)` as soon as the two are unified.
 *
 * A ground triple term meeting a shape decomposes the same way ({@link decomposedAgainst}). Anything else
 * - a term that is not a triple term, or one carrying a graph no triple term can have - is a
 * contradiction.
 */
function meetTermPins(left: Pin<RDF.Term>, right: Pin<RDF.Term>): PinMeet<RDF.Term> | false {
  if (left.kind === 'triple') {
    if (right.kind === 'triple') {
      return {
        pin: left,
        entailed: triplePositions.map(position =>
          ({ kind: 'unify', left: left[position], right: right[position] })),
      };
    }
    return decomposedAgainst(left, right.term);
  }
  if (right.kind === 'triple') {
    return decomposedAgainst(right, left.term);
  }
  return left.term.equals(right.term) ? { pin: left, entailed: []} : false;
}

/**
 * A ground triple term meeting a shape: the same decomposition two shapes are, with the components
 * already known.
 *
 * The *shape* is what the group keeps. Its positions are groups other things may be equal to, where the
 * term is a single value, and nothing is lost by it - the term reads back off a shape all of whose
 * positions are decided.
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
