/**
 * Clustering Algorithm that allows for merges. Complexity: n*log(n) .
 * Allegedly this can be compressed down to O(invAckerman(n)):
 *  https://claude.ai/share/8db9c2e2-918f-42ed-af83-e5564a6f80a3
 */
export class ClusterSet<T> {
  public groupToValues: Record<number, T[]>;
  /** Maps group ID to the expression that they need to satisfy */
  public valueToGroup: Record<string, number | undefined>;

  /** Counter for generating unique group IDs */
  protected cleanNumber: number;

  public constructor(protected readonly toId: (value: T) => string) {
    this.clear();
  }

  /**
   * Resets the solver to its initial state.
   * Call this before processing a new triple pattern.
   */
  public clear(): void {
    this.groupToValues = {};
    this.valueToGroup = {};
    this.cleanNumber = 1;
  }

  /**
   * Gets or creates a group for a value.
   * @param value - The value to get/create a group for
   * @returns The group ID
   */
  public getGroup(value: T): number {
    const group = this.valueToGroup[this.toId(value)];
    // Return the group
    if (group !== undefined) {
      return group;
    }
    return this.createGroup(value);
  }

  /**
   * The group a value is in, without creating one for it - the read-only counterpart of {@link getGroup}.
   * @param value - The value to look up
   * @returns The group ID, or `undefined` when the value is in no group
   */
  public groupOf(value: T): number | undefined {
    return this.valueToGroup[this.toId(value)];
  }

  /** The values of a group, empty when the group does not exist. */
  public valuesOf(group: number): readonly T[] {
    return this.groupToValues[group] ?? [];
  }

  /** Every group and its values, in the order the groups were created. */
  public groupEntries(): [ number, readonly T[] ][] {
    return Object.entries(this.groupToValues).map(([ group, values ]) => [ Number(group), values ]);
  }

  /** A copy that shares no state with this one, so that either may be mutated on its own. */
  public clone(): ClusterSet<T> {
    const copy = new ClusterSet<T>(this.toId);
    this.copyInto(copy);
    return copy;
  }

  /** Copies the state of this set into `target`, which subclasses extend with the state they add. */
  protected copyInto(target: ClusterSet<T>): void {
    target.groupToValues = Object.fromEntries(
      Object.entries(this.groupToValues).map(([ group, values ]) => [ group, [ ...values ]]),
    );
    target.valueToGroup = { ...this.valueToGroup };
    target.cleanNumber = this.cleanNumber;
  }

  protected createGroup(value: T): number {
    const group = this.cleanNumber;
    this.cleanNumber++;
    this.groupToValues[group] = [ value ];
    this.valueToGroup[this.toId(value)] = group;
    return group;
  }

  /**
   * Takes a value out of the group it is in.
   *
   * A group the removal leaves without members, or with a single member and nothing for that member to be
   * equal *to* ({@link carriesInformation}), no longer says anything, so it is dropped rather than kept
   * around as a group of one.
   */
  public remove(value: T): void {
    const id = this.toId(value);
    const group = this.valueToGroup[id];
    if (group === undefined) {
      return;
    }
    delete this.valueToGroup[id];
    const remaining = this.groupToValues[group].filter(other => this.toId(other) !== id);
    this.groupToValues[group] = remaining;
    if (remaining.length === 0 || (remaining.length < 2 && !this.carriesInformation(group))) {
      this.dropGroup(group);
    }
  }

  /** Whether the group holds something its single remaining member would still be constrained by. */
  protected carriesInformation(_group: number): boolean {
    return false;
  }

  /** Deletes a group and every value in it, which subclasses extend with the state they add. */
  protected dropGroup(group: number): void {
    for (const value of this.groupToValues[group] ?? []) {
      delete this.valueToGroup[this.toId(value)];
    }
    delete this.groupToValues[group];
  }

  /**
   * Merges two groups into one.
   * @returns `undefined` when both values were already in the same group, so nothing was merged.
   */
  public mergeGroups(from: T, to: T): { oldGroup: number; newGroup: number } | undefined {
    const fromGroup = this.getGroup(from);
    const toGroup = this.getGroup(to);
    if (fromGroup === toGroup) {
      return undefined;
    }

    // Union by size: the larger group survives. Ties break towards the lower ID.
    const fromSize = this.groupToValues[fromGroup].length;
    const toSize = this.groupToValues[toGroup].length;
    const fromWins = fromSize > toSize || (fromSize === toSize && fromGroup < toGroup);
    const [ newGroup, oldGroup ] = fromWins ? [ fromGroup, toGroup ] : [ toGroup, fromGroup ];

    // Merge values:
    const oldValues = this.groupToValues[oldGroup];
    delete this.groupToValues[oldGroup];
    this.groupToValues[newGroup].push(...oldValues);
    for (const value of oldValues) {
      this.valueToGroup[this.toId(value)] = newGroup;
    }
    return { oldGroup, newGroup };
  }
}
