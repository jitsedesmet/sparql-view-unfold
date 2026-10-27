import { objectRange } from '../RangeSet.js';
import type { RangeSet } from '../RangeSet.js';
import { TermClusterSet } from './TermClusterSet.js';

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
export class AssertionClusterSet extends TermClusterSet<string> {
  /** Maps group ID to the part of its range a condition asserted, rather than the set working it out */
  protected groupToAssertedRange: Record<number, RangeSet>;

  public constructor() {
    super(name => name, variable => variable.value);
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
   * Forgets what a condition asserted of the group's range, keeping the range it narrowed to. Like {@link remove}, it
   * drops a group that no longer says anything.
   * @param group - The group to forget the asserted range of
   */
  public forgetAssertedRange(group: number): void {
    this.touch();
    const resolved = this.resolveGroup(group);
    this.groupToAssertedRange[resolved] = objectRange;
    if (!this.isLive(resolved)) {
      this.dropGroup(resolved);
    }
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
   * A group whose range a condition narrowed carries information however few members it has. Without this,
   * `FILTER(isTRIPLE(?x))` would be dropped as soon as its group falls to one member.
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
