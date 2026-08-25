import type * as RDF from '@rdfjs/types';
import { describe, it } from 'vitest';
import type { Pin, PinChildren, PinMeet, TriplePin } from '../lib/datastructures/TermClusterSet.js';
import { TermClusterSet, triplePositions } from '../lib/datastructures/TermClusterSet.js';
import { predicateRange, subjectRange } from '../lib/RangeSet.js';
import { DF } from '../lib/utils/rdfDatatypes.js';

/**
 * The meet the assertion conjunction uses, restated here so that the lattice can be tested without one:
 * two terms are an equality, two shapes decompose, and a ground triple term meeting a shape decides
 * every position of it while the shape is what the group keeps.
 */
function meetPins(left: Pin<RDF.Term>, right: Pin<RDF.Term>): PinMeet<RDF.Term> | false {
  if (left.kind === 'triple') {
    return right.kind === 'triple' ?
        {
          pin: left,
          entailed: triplePositions.map(position =>
            ({ kind: 'unify', left: left[position], right: right[position] })),
        } :
      decomposed(left, right.term);
  }
  if (right.kind === 'triple') {
    return decomposed(right, left.term);
  }
  return left.term.equals(right.term) ? { pin: left, entailed: []} : false;
}

function decomposed(shape: TriplePin, ground: RDF.Term): PinMeet<RDF.Term> | false {
  return ground.termType === 'Quad' ?
      {
        pin: shape,
        entailed: triplePositions.map(position =>
          ({ kind: 'pin', group: shape[position], pin: { kind: 'term', term: ground[position] }})),
      } :
    false;
}

function newSet(): TermClusterSet<string, RDF.Term> {
  return new TermClusterSet<string, RDF.Term>(name => name, meetPins);
}

const termA = DF.namedNode('ex://a');
const termB = DF.namedNode('ex://b');
const termC = DF.namedNode('ex://c');
const ground = DF.quad(termA, termB, termC);

describe('termClusterSet', () => {
  describe('term pins', () => {
    it('keeps a term the group is pinned to', ({ expect }) => {
      const set = newSet();
      expect(set.setTerm(set.getGroup('x'), termA)).toBe(true);
      expect(set.termOf(set.getGroup('x'))).toEqual(termA);
    });

    it('reports a conflict rather than raising it', ({ expect }) => {
      const set = newSet();
      set.setTerm(set.getGroup('x'), termA);
      expect(set.setTerm(set.getGroup('x'), termB)).toBe(false);
    });

    it('carries a pin over a merge, and reports the conflict of two', ({ expect }) => {
      const set = newSet();
      set.setTerm(set.getGroup('x'), termA);
      set.getGroup('y');
      expect(set.mergeGroups('x', 'y')?.conflict).toBe(false);
      expect(set.termOf(set.getGroup('y'))).toEqual(termA);

      const conflicting = newSet();
      conflicting.setTerm(conflicting.getGroup('x'), termA);
      conflicting.setTerm(conflicting.getGroup('y'), termB);
      expect(conflicting.mergeGroups('x', 'y')?.conflict).toBe(true);
    });
  });

  describe('shapes', () => {
    it('gives a group three positions of its own', ({ expect }) => {
      const set = newSet();
      const children = <PinChildren> set.assertTriplePin(set.getGroup('o'));
      expect(children).not.toBe(false);
      expect(new Set(Object.values(children)).size).toBe(3);
      // Asking again is the same shape, not a second one.
      expect(set.assertTriplePin(set.getGroup('o'))).toEqual(children);
    });

    it('holds the positions in groups nothing names, which survive on their own', ({ expect }) => {
      const set = newSet();
      const { subject } = <PinChildren> set.assertTriplePin(set.getGroup('o'));
      expect(set.valuesOf(subject)).toEqual([]);
      expect(set.setTerm(subject, termA)).toBe(true);
      expect(set.termOf(subject)).toEqual(termA);
    });

    it('unifies the positions of two shapes met on one group', ({ expect }) => {
      const set = newSet();
      // `?o ≡ <<( ?a … )>>` and `?o ≡ <<( ?b … )>>` say `?a ≡ ?b`, which is what the decomposition is.
      const first = <PinChildren> set.assertTriplePin(set.getGroup('o'));
      set.setTerm(first.subject, termA);
      set.assertTriplePin(set.getGroup('x'));
      expect(set.mergeGroups('o', 'x')?.conflict).toBe(false);
      // Everything known about the subject of `?o` is now known about the subject of `?x`.
      expect(set.termOf(<number> set.childrenOf(set.getGroup('x'))?.subject)).toEqual(termA);
    });

    it('decomposes a ground triple term against a shape', ({ expect }) => {
      const set = newSet();
      const { subject } = <PinChildren> set.assertTriplePin(set.getGroup('o'));
      expect(set.setTerm(set.getGroup('o'), ground)).toBe(true);
      expect(set.termOf(subject)).toEqual(termA);
    });

    it('contradicts a shape against a term that is not a triple term', ({ expect }) => {
      const set = newSet();
      set.assertTriplePin(set.getGroup('o'));
      expect(set.setTerm(set.getGroup('o'), termA)).toBe(false);
    });

    it('refuses a shape a group whose range holds no triple term', ({ expect }) => {
      const set = newSet();
      expect(set.narrowRange(set.getGroup('g'), subjectRange)).toBe(true);
      expect(set.assertTriplePin(set.getGroup('g'))).toBe(false);
    });

    it('gives every position the range that position admits', ({ expect }) => {
      const set = newSet();
      const { predicate } = <PinChildren> set.assertTriplePin(set.getGroup('o'));
      expect([ ...set.rangeOf(predicate) ]).toEqual([ ...predicateRange ]);
      // Which is the same reason a shape on a *subject* position is a contradiction: it confines the
      // nesting of shapes to the `object` chain.
      const { subject } = <PinChildren> set.assertTriplePin(set.getGroup('t'));
      expect(set.assertTriplePin(subject)).toBe(false);
    });

    it('drains the merges a decomposition sets off through a work list', ({ expect }) => {
      const set = newSet();
      // `?o ≡ <<( ?a ?b ?c )>>` twice over, with a nested shape in the object of one of them: merging the
      // two decomposes, and merging the objects decomposes again.
      const first = <PinChildren> set.assertTriplePin(set.getGroup('o'));
      const nested = <PinChildren> set.assertTriplePin(first.object);
      set.setTerm(nested.subject, termA);
      const second = <PinChildren> set.assertTriplePin(set.getGroup('x'));
      const otherNested = <PinChildren> set.assertTriplePin(second.object);
      set.setTerm(otherNested.predicate, termB);
      expect(set.mergeGroups('o', 'x')?.conflict).toBe(false);
      const object = <number> set.childrenOf(set.getGroup('o'))?.object;
      const deep = set.childrenOf(object)!;
      expect(set.termOf(deep.subject)).toEqual(termA);
      expect(set.termOf(deep.predicate)).toEqual(termB);
    });
  });

  describe('the occurs check', () => {
    it('refuses a group a shape it is itself a position of', ({ expect }) => {
      const set = newSet();
      const children = <PinChildren> set.assertTriplePin(set.getGroup('o'));
      // `?o ≡ <<( … ?o )>>` - a triple term is strictly larger than each of its positions.
      expect(set.unifyGroups(set.getGroup('o'), children.object)).toBe(false);
    });

    it('refuses a merge that closes a cycle rather than one that only makes one deeper', ({ expect }) => {
      const set = newSet();
      const outer = <PinChildren> set.assertTriplePin(set.getGroup('o'));
      const inner = <PinChildren> set.assertTriplePin(outer.object);
      expect(set.unifyGroups(set.getGroup('o'), inner.object)).toBe(false);
    });
  });

  describe('liveness', () => {
    it('keeps a group a live shape points at when its last member leaves', ({ expect }) => {
      const set = newSet();
      const { subject } = <PinChildren> set.assertTriplePin(set.getGroup('o'));
      // `?s ≡ SUBJECT(?o)`: the position is now the group of `?s`.
      expect(set.unifyGroups(set.getGroup('s'), subject)).toBe(true);
      const shared = set.getGroup('s');
      set.remove('s');
      // Dropping it would leave the shape of `?o` naming a group that is no longer there.
      expect(set.childrenOf(set.getGroup('o'))?.subject).toBe(set.resolveGroup(shared));
      expect(set.hasGroup(set.resolveGroup(shared))).toBe(true);
    });

    it('still drops a group nothing points at and nothing constrains', ({ expect }) => {
      const set = newSet();
      set.mergeGroups('x', 'y');
      const group = set.getGroup('x');
      set.remove('x');
      expect(set.hasGroup(group)).toBe(false);
    });
  });
});
