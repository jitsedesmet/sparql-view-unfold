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
  protected getGroup(value: T): number {
    const group = this.valueToGroup[this.toId(value)];
    // Return the group
    if (group !== undefined) {
      return group;
    }
    return this.createGroup(value);
  }

  protected createGroup(value: T): number {
    const group = this.cleanNumber;
    this.cleanNumber++;
    this.groupToValues[group] = [ value ];
    this.valueToGroup[this.toId(value)] = group;
    return group;
  }

  /**
   * Merges two groups into one.
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
