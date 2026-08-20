export type SSet = Set<string>;

export function unionSets(sets: readonly ReadonlySet<string>[]): SSet {
  const result = new Set<string>();
  for (const set of sets) {
    for (const value of set) {
      result.add(value);
    }
  }
  return result;
}

/** Tests whether every element of `subset` is contained in `superset`. */
export function isSubsetOf(subset: Set<string>, superset: Set<string>): boolean {
  for (const value of subset) {
    if (!superset.has(value)) {
      return false;
    }
  }
  return true;
}

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

/** The elements of `set` that do not occur in `remove`. */
export function differenceSets(set: SSet, remove: SSet): SSet {
  const agg = new Set<string>();
  for (const value of set) {
    if (!remove.has(value)) {
      agg.add(value);
    }
  }
  return agg;
}
