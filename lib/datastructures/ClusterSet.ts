/**
 * Hands out the stamp {@link ClusterSet.revision} reports, from one counter shared by every set there is.
 *
 * Globally unique rather than per set, so that a stamp identifies a *state of one set* and never collides
 * with the state of another. That is what lets a memo be keyed by a stamp alone: swapping a set for
 * another - which {@link utils/assertionConjunction!AssertionConjunction} does whenever it adopts a clone -
 * can never hand back a stamp a memo of the old set was taken at.
 */
let revisions = 0;

/**
 * A union-find over values, grouping the ones that have to be equal. Complexity: n*log(n).
 *
 * Allegedly this can be compressed down to O(invAckerman(n)):
 * https://claude.ai/share/8db9c2e2-918f-42ed-af83-e5564a6f80a3
 */
export class ClusterSet<T> {
  /** Maps group ID to the values in it - read through {@link valuesOf} and {@link groupEntries}. */
  protected groupToValues: Record<number, T[]>;
  /** Maps a value to the group it is in - read through {@link groupOf}. */
  protected valueToGroup: Record<string, number | undefined>;

  /** Counter for generating unique group IDs */
  protected cleanNumber: number;
  /** The stamp {@link revision} reports - read through it, and moved on by {@link touch}. */
  private revisionStamp: number;

  public constructor(protected readonly toId: (value: T) => string) {
    this.clear();
  }

  /**
   * The state the set is in, as a stamp that no two states of any two sets share.
   *
   * Every method that writes anything moves it on ({@link touch}), so a memo taken off the set is valid for
   * exactly as long as this is what it was taken at - which is a check the memo cannot forget to make, there
   * being nothing to invalidate.
   */
  public get revision(): number {
    return this.revisionStamp;
  }

  /**
   * Moves {@link revision} on, invalidating whatever was memoised off the state the set was just in.
   *
   * Called by the method that writes rather than by whoever asked for the write, so that a caller has
   * nothing to remember. Most of the calls sit on the choke points the writes of this class pass through -
   * {@link clear}, {@link copyInto}, {@link createEmptyGroup}, {@link remove}, {@link dropGroup},
   * {@link mergeGroupIds} - which is what a subclass extending one of them inherits rather than has to
   * repeat, and what makes `createGroup` and every `super`-chaining override safe without a call of their
   * own.
   *
   * **A subclass writing state no ancestor writes owes a call here on its own account**, since no choke
   * point of this class covers it. Those are `narrowRange` and `resolveAllConstraints` on
   * {@link datastructures/TermClusterSet!TermClusterSet}, `assertTermTypeRange` on
   * {@link datastructures/AssertionClusterSet!AssertionClusterSet}, and `sortClusters`,
   * `registerExpressionToGroup` and the static-validation branch of `register` on {@link ClusterSolver!ClusterSolver}
   * - the last three of which write no group at all, which is exactly why they are easy to miss.
   */
  protected touch(): void {
    revisions++;
    this.revisionStamp = revisions;
  }

  /** Resets the set to its initial state, dropping every group. */
  public clear(): void {
    this.touch();
    this.groupToValues = {};
    this.valueToGroup = {};
    this.cleanNumber = 1;
  }

  /**
   * Gets or creates a group for a value.
   * @param value - The value to get/create a group for
   * @returns the group ID
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
   * @returns the group ID, or `undefined` when the value is in no group
   */
  public groupOf(value: T): number | undefined {
    return this.valueToGroup[this.toId(value)];
  }

  /**
   * The values of a group.
   * @param group - The group to read
   * @returns its values, empty when the group does not exist
   */
  public valuesOf(group: number): readonly T[] {
    return this.groupToValues[group] ?? [];
  }

  /**
   * Whether the group exists at all - a group nothing points at any more does not.
   * @param group - The group to check
   * @returns whether it exists
   */
  public hasGroup(group: number): boolean {
    return this.groupToValues[group] !== undefined;
  }

  /**
   * Every group and its values, in the order the groups were created.
   * @returns the pairs
   */
  public groupEntries(): [ number, readonly T[] ][] {
    return Object.entries(this.groupToValues).map(([ group, values ]) => [ Number(group), values ]);
  }

  /**
   * A copy that shares no state with this one, so that either may be mutated on its own.
   * @returns the copy
   */
  public clone(): ClusterSet<T> {
    const copy = new ClusterSet<T>(this.toId);
    this.copyInto(copy);
    return copy;
  }

  /**
   * Copies the state of this set into `target`, which subclasses extend with the state they add.
   * @param target - The set to copy into
   */
  protected copyInto(target: ClusterSet<T>): void {
    target.touch();
    target.groupToValues = Object.fromEntries(
      Object.entries(this.groupToValues).map(([ group, values ]) => [ group, [ ...values ]]),
    );
    target.valueToGroup = { ...this.valueToGroup };
    target.cleanNumber = this.cleanNumber;
  }

  /**
   * Creates a group holding no values at all, which is only reachable through whatever a subclass makes point
   * at it - the positions of a triple pin, for {@link datastructures/TermClusterSet!TermClusterSet}.
   * @returns the new group
   */
  protected createEmptyGroup(): number {
    this.touch();
    const group = this.cleanNumber;
    this.cleanNumber++;
    this.groupToValues[group] = [];
    return group;
  }

  /**
   * Creates a group holding one value.
   * @param value - The value to hold
   * @returns the new group
   */
  protected createGroup(value: T): number {
    const group = this.createEmptyGroup();
    this.groupToValues[group].push(value);
    this.valueToGroup[this.toId(value)] = group;
    return group;
  }

  /**
   * Takes a value out of the group it is in, dropping the group when it no longer says anything
   * ({@link isLive}).
   * @param value - The value to remove
   */
  public remove(value: T): void {
    this.touch();
    const id = this.toId(value);
    const group = this.valueToGroup[id];
    if (group === undefined) {
      return;
    }
    delete this.valueToGroup[id];
    this.groupToValues[group] = this.groupToValues[group].filter(other => this.toId(other) !== id);
    if (!this.isLive(group)) {
      this.dropGroup(group);
    }
  }

  /**
   * Whether the group is still worth keeping: two members constrain each other, and a single one is
   * constrained by whatever the group {@link carriesInformation} about.
   * @param group - The group to check
   * @returns whether it is worth keeping; a subclass that lets something *outside* the group's values point
   * at it overrides this, dropping such a group leaving that reference dangling
   */
  protected isLive(group: number): boolean {
    const values = this.groupToValues[group]?.length ?? 0;
    return values > 1 || (values === 1 && this.carriesInformation(group));
  }

  /**
   * Whether the group holds something its single remaining member would still be constrained by.
   * @param _group - The group to check
   * @returns whether it does; never at this level
   */
  protected carriesInformation(_group: number): boolean {
    return false;
  }

  /**
   * Deletes a group and every value in it, which subclasses extend with the state they add.
   * @param group - The group to drop
   */
  protected dropGroup(group: number): void {
    this.touch();
    for (const value of this.groupToValues[group] ?? []) {
      delete this.valueToGroup[this.toId(value)];
    }
    delete this.groupToValues[group];
  }

  /**
   * Merges the groups of two values into one.
   * @param from - One of the values
   * @param to - The other
   * @returns the ids involved, or `undefined` when both values were already in the same group
   */
  public mergeGroups(from: T, to: T): { oldGroup: number; newGroup: number } | undefined {
    return this.mergeGroupIds(this.getGroup(from), this.getGroup(to));
  }

  /**
   * Merges two groups by *id*, which is what a group nothing names can be merged by - the values-only half of
   * a merge, whatever else a subclass hangs off a group being migrated by {@link migrateGroupData}.
   * @param fromGroup - One group
   * @param toGroup - The other
   * @returns the ids involved, or `undefined` when the two ids are the same group
   */
  protected mergeGroupIds(fromGroup: number, toGroup: number): { oldGroup: number; newGroup: number } | undefined {
    this.touch();
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

  /**
   * Moves everything the disappearing group carried besides its values onto the surviving one. Subclasses
   * that give a group more state migrate it here, calling `super` first so that whatever a class further up
   * carries over is already in place.
   * @param _oldGroup - The group disappearing
   * @param _newGroup - The group surviving
   */
  protected migrateGroupData(_oldGroup: number, _newGroup: number): void {
    // Nothing but the values, at this level.
  }
}
