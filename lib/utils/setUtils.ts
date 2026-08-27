export type SSet = Set<string>;

/**
 * The union of a list of sets.
 * @param sets - The sets to unite
 * @returns a new set holding every element of any of them
 */
export function unionSets(sets: readonly ReadonlySet<string>[]): SSet {
  const result = new Set<string>();
  for (const set of sets) {
    for (const value of set) {
      result.add(value);
    }
  }
  return result;
}

/**
 * Tests whether every element of `subset` is contained in `superset`.
 * @param subset - The set that should be contained
 * @param superset - The set that should contain it
 * @returns whether it does
 */
export function isSubsetOf(subset: Set<string>, superset: Set<string>): boolean {
  for (const value of subset) {
    if (!superset.has(value)) {
      return false;
    }
  }
  return true;
}

/**
 * The intersection of a list of sets.
 * @param sets - The sets to intersect
 * @returns a new set holding the elements every one of them has, empty for an empty list
 */
export function intersectSets(sets: SSet[]): SSet {
  if (sets.length === 0) {
    return new Set<string>();
  }
  const [ first, ...rest ] = sets;
  const agg = new Set<string>();
  for (const value of first) {
    if (rest.every(set => set.has(value))) {
      agg.add(value);
    }
  }
  return agg;
}

/**
 * The elements of `set` that do not occur in `remove`.
 * @param set - The set to take from
 * @param remove - The set to take away
 * @returns a new set holding the difference
 */
export function differenceSets(set: SSet, remove: SSet): SSet {
  const agg = new Set<string>();
  for (const value of set) {
    if (!remove.has(value)) {
      agg.add(value);
    }
  }
  return agg;
}
