import { describe, it } from 'vitest';
import { iriRange, objectRange, RangeSet, rangeOfTermType, subjectRange } from '../lib/RangeSet.js';

describe('rangeSet', () => {
  it('hands back the side a meet narrows nothing of', ({ expect }) => {
    expect(subjectRange.meet(objectRange)).toBe(subjectRange);
    expect(objectRange.meet(iriRange)).toBe(iriRange);
    expect([ ...subjectRange.meet(new RangeSet([ 'NamedNode', 'Literal' ])) ]).toEqual([ 'NamedNode' ]);
  });

  it('refuses to change once built, a range being shared', ({ expect }) => {
    const range = new RangeSet([ 'NamedNode' ]);
    // The type refuses the call already, which a range read as a plain Set does not.
    const asSet: Set<string> = range;
    expect(() => asSet.add('Literal')).toThrow('A range is not changed once built');
    expect(() => asSet.delete('NamedNode')).toThrow('A range is not changed once built');
    expect(() => asSet.clear()).toThrow('A range is not changed once built');
    expect([ ...range ]).toEqual([ 'NamedNode' ]);
  });

  it('shares the range of one term type', ({ expect }) => {
    expect(rangeOfTermType('NamedNode')).toBe(iriRange);
    expect([ ...rangeOfTermType('Variable') ]).toEqual([ 'Variable' ]);
  });
});
