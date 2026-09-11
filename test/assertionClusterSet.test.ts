import { describe, it } from 'vitest';
import { AssertionClusterSet } from '../lib/datastructures/AssertionClusterSet.js';
import { objectRange, tripleTermRange } from '../lib/RangeSet.js';

describe('assertionClusterSet', () => {
  describe('liveness', () => {
    // A condition that narrowed a group's range - `isTRIPLE(?x)`, `isIRI`, `isLITERAL`, `isBLANK` - still
    // constrains the single member it falls to, which the transfer through a `BIND(?y AS ?x)` does at
    // once, `?x` leaving the group it just put `?y` in. Dropping it there would discard the whole
    // condition from Θ, and so from the rewritten query.
    it('keeps a group an asserted range narrowed when its last member leaves', ({ expect }) => {
      const set = new AssertionClusterSet();
      set.mergeGroups('x', 'y');
      const group = set.getGroup('x');
      set.assertTermTypeRange(group, tripleTermRange);

      set.remove('x');

      const survivor = set.groupOf('y');
      expect(survivor).not.toBe(undefined);
      expect(set.assertedRangeOf(survivor!)).toEqual(tripleTermRange);
    });

    // The other side: a group at the top range - nothing asserted of it - carries nothing its last member
    // is still constrained by, so it drops as before.
    it('still drops a group nothing narrowed when its last member leaves', ({ expect }) => {
      const set = new AssertionClusterSet();
      set.mergeGroups('x', 'y');
      const group = set.getGroup('x');
      expect(set.assertedRangeOf(group)).toEqual(objectRange);

      set.remove('x');

      expect(set.groupOf('y')).toBe(undefined);
    });
  });
});
