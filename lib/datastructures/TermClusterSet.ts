import { ClusterSet } from './ClusterSet.js';

/**
 * A {@link ClusterSet} whose groups may be *pinned* to a term: every value in the group equals that term.
 *
 * The two users of this differ in what a pin conflict means, which is why {@link setTerm} reports one
 * rather than raising it. For the unfolding ({@link ClusterSolver}) a group asked to be two terms at once
 * is a broken mapping, and it throws; for an assertion conjunction it is an ordinary contradiction, and it
 * becomes the empty operation. They also differ in the terms they allow - the solver narrows to a
 * {@link RawBasicTerm} by the range of the triple position - hence the second type parameter.
 */
export class TermClusterSet<T, Term> extends ClusterSet<T> {
  /** Maps group ID to the concrete term the group is pinned to (if any) */
  public groupToTerm: Record<number, Term | undefined>;

  public constructor(
    toId: (value: T) => string,
    protected readonly compareTerm: (a: Term, b: Term) => boolean,
  ) {
    super(toId);
    this.clear();
  }

  public override clear(): void {
    super.clear();
    this.groupToTerm = {};
  }

  public override clone(): TermClusterSet<T, Term> {
    const copy = new TermClusterSet<T, Term>(this.toId, this.compareTerm);
    this.copyInto(copy);
    return copy;
  }

  protected override copyInto(target: ClusterSet<T>): void {
    super.copyInto(target);
    (<TermClusterSet<T, Term>> target).groupToTerm = { ...this.groupToTerm };
  }

  /** The term the group is pinned to, or `undefined` when the group is anchorless. */
  public termOf(group: number): Term | undefined {
    return this.groupToTerm[group];
  }

  /**
   * Pins a term onto a group, or reports that the group already carries a different one.
   * @returns `false` when the group is already pinned to another term, leaving it untouched.
   */
  public setTerm(group: number, term: Term): boolean {
    const current = this.groupToTerm[group];
    if (current !== undefined && !this.compareTerm(current, term)) {
      return false;
    }
    this.groupToTerm[group] = current ?? term;
    return true;
  }

  /** A pinned group still constrains its last remaining member, so it survives {@link remove}. */
  protected override carriesInformation(group: number): boolean {
    return this.groupToTerm[group] !== undefined;
  }

  protected override createGroup(value: T): number {
    const group = super.createGroup(value);
    this.groupToTerm[group] = undefined;
    return group;
  }

  protected override dropGroup(group: number): void {
    super.dropGroup(group);
    delete this.groupToTerm[group];
  }

  /**
   * Merges two groups, carrying over everything the disappearing one held.
   * @returns `conflict` when the two groups were pinned to different terms, which leaves the surviving
   * group pinned to its own term - what the two callers do about that is up to them.
   */
  public override mergeGroups(from: T, to: T): { oldGroup: number; newGroup: number; conflict: boolean } | undefined {
    const merged = super.mergeGroups(from, to);
    if (merged === undefined) {
      return undefined;
    }
    const migrated = this.migrateGroupData(merged.oldGroup, merged.newGroup);
    delete this.groupToTerm[merged.oldGroup];
    return { ...merged, conflict: !migrated };
  }

  /**
   * Moves everything the disappearing group carried besides its values onto the surviving one.
   * Subclasses that give a group more state migrate it here.
   */
  protected migrateGroupData(oldGroup: number, newGroup: number): boolean {
    const oldTerm = this.groupToTerm[oldGroup];
    return oldTerm === undefined || this.setTerm(newGroup, oldTerm);
  }
}
