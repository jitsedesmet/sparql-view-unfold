import { describe, it } from 'vitest';
import { AlgebraTemplateFactory } from '../lib/AlgebraTemplateFactory.js';
import { ClusterSolver } from '../lib/ClusterSolver.js';
import { AssertionClusterSet } from '../lib/datastructures/AssertionClusterSet.js';
import type { PinChildren } from '../lib/datastructures/TermClusterSet.js';
import { predicateRange, subjectRange, tripleTermRange } from '../lib/RangeSet.js';
import { DF } from '../lib/utils/rdfDatatypes.js';

/**
 * @fileoverview The invariant the memos of
 * {@link utils/assertionConjunction!AssertionConjunction} rest on: **every write moves
 * {@link datastructures/ClusterSet!ClusterSet.revision | revision} on**, so that a memo keyed by a stamp
 * is valid for exactly as long as the set still reports that stamp.
 *
 * Tested here rather than through the rewriting, because the rewriting cannot test it. Losing one
 * `touch` is invisible end to end: over 5 000 fuzzed queries, dropping the call from any single one of
 * `copyInto`, `createEmptyGroup`, `remove`, `dropGroup`, `mergeGroupIds`, `narrowRange`,
 * `resolveAllConstraints` or `assertTermTypeRange` left the memos never once holding a value that had
 * gone stale, let alone writing a different query - the choke points cover the same paths several times
 * over, so one of them going missing changes nothing until another does too. Only freezing the stamp
 * altogether reached the output, and then for 1 query in 5 000. A test that fires once every choke point
 * is gone would be worth almost nothing; these pin them one at a time.
 *
 * **Ten of the twelve calls are covered**, in the sense that removing any one of them fails a case here.
 * The two that are not are stamped a second time on the same path by a call they cannot avoid making, so
 * nothing outside can tell whether their own call is there:
 *
 * - `TermClusterSet.resolveAllConstraints`, whose every work list drains through `mergeGroupIds` or
 *   `narrowRange` before it settles, and which is private besides.
 * - `AssertionClusterSet.assertTermTypeRange`, which writes the asserted range and then narrows
 *   unconditionally.
 *
 * Both keep their call anyway: what covers them is a fact about the callee, not about them, and the
 * point of the contract is that a method is answerable for its own writes.
 *
 * So a new write needs a case here, and a subclass writing state no ancestor writes needs its own
 * `touch` - see the contract on `ClusterSet.touch`.
 */

/**
 * The set with the three writes that are `protected` because nothing outside the hierarchy may call them
 * opened up, so that a case can reach one on its own.
 *
 * They need reaching directly: each is only ever called from a method that stamps the set as well, so a
 * `touch` going missing from one of them is invisible through the public API - which is a redundancy to
 * rely on for correctness and not for testing. Opened by a cast rather than by a subclass, so that what
 * the cases run against is the class itself.
 */
type OpenedSet = AssertionClusterSet & {
  copyInto: (target: AssertionClusterSet) => void;
  dropGroup: (group: number) => void;
  mergeGroupIds: (from: number, to: number) => { oldGroup: number; newGroup: number } | undefined;
};

/** Anything that reports a revision stamp: any of the three sets, and the solver. */
type Stamped = Pick<AssertionClusterSet, 'revision'>;

describe('cluster set revision', () => {
  const termA = DF.namedNode('ex://a');
  const termB = DF.namedNode('ex://b');
  const AF = new AlgebraTemplateFactory();

  /** A set holding `x` and `y` in groups of their own. */
  function twoGroups(): AssertionClusterSet {
    const set = new AssertionClusterSet();
    set.getGroup('x');
    set.getGroup('y');
    return set;
  }

  describe('every write moves the stamp on', () => {
    /**
     * Runs a write and reports whether the stamp moved.
     * @param set - The set to write to
     * @param write - The write to make
     * @returns whether {@link AssertionClusterSet.revision} differs afterwards
     */
    function moves(set: Stamped, write: () => void): boolean {
      const before = set.revision;
      write();
      return set.revision !== before;
    }

    it('clear', ({ expect }) => {
      const set = twoGroups();
      expect(moves(set, () => set.clear())).toBe(true);
    });

    it('getGroup, where it creates the group', ({ expect }) => {
      const set = new AssertionClusterSet();
      expect(moves(set, () => set.getGroup('x'))).toBe(true);
    });

    it('remove, where the group survives it', ({ expect }) => {
      // Three members, so that removing one leaves a live group and `dropGroup` does not run - which is
      // what makes this the `touch` of `remove` alone rather than of either.
      const set = new AssertionClusterSet();
      set.mergeGroups('x', 'y');
      set.mergeGroups('y', 'z');
      expect(moves(set, () => set.remove('x'))).toBe(true);
      expect(set.valuesOf(set.getGroup('y'))).toHaveLength(2);
    });

    it('mergeGroups', ({ expect }) => {
      const set = twoGroups();
      expect(moves(set, () => void set.mergeGroups('x', 'y'))).toBe(true);
    });

    it('unifyGroups', ({ expect }) => {
      const set = twoGroups();
      expect(moves(set, () => void set.unifyGroups(set.getGroup('x'), set.getGroup('y')))).toBe(true);
    });

    it('setTerm', ({ expect }) => {
      const set = twoGroups();
      expect(moves(set, () => void set.setTerm(set.getGroup('x'), termA))).toBe(true);
    });

    it('narrowRange', ({ expect }) => {
      const set = twoGroups();
      expect(moves(set, () => void set.narrowRange(set.getGroup('x'), subjectRange))).toBe(true);
    });

    it('assertTriplePin, where it shapes the group', ({ expect }) => {
      const set = twoGroups();
      expect(moves(set, () => void set.assertTriplePin(set.getGroup('x')))).toBe(true);
    });

    it('dropGroup', ({ expect }) => {
      const set = <OpenedSet> new AssertionClusterSet();
      const group = set.getGroup('x');
      expect(moves(set, () => set.dropGroup(group))).toBe(true);
      expect(set.hasGroup(group)).toBe(false);
    });

    it('mergeGroupIds', ({ expect }) => {
      const set = <OpenedSet> new AssertionClusterSet();
      const left = set.getGroup('x');
      const right = set.getGroup('y');
      expect(moves(set, () => void set.mergeGroupIds(left, right))).toBe(true);
    });

    it('copyInto, which stamps the set it writes rather than the one it reads', ({ expect }) => {
      const source = <OpenedSet> new AssertionClusterSet();
      source.mergeGroups('x', 'y');
      const target = new AssertionClusterSet();
      const sourceStamp = source.revision;
      expect(moves(target, () => source.copyInto(target))).toBe(true);
      // The set being read is not written, so its own stamp stands still.
      expect(source.revision).toBe(sourceStamp);
    });

    it('assertTermTypeRange, which writes state of its own before it narrows', ({ expect }) => {
      const set = twoGroups();
      expect(moves(set, () => void set.assertTermTypeRange(set.getGroup('x'), predicateRange))).toBe(true);
      expect(set.assertedRangeOf(set.getGroup('x'))).toEqual(predicateRange);
    });

    it('migrateGroupData, reached by merging two groups that both carry an asserted range', ({ expect }) => {
      const set = twoGroups();
      set.assertTermTypeRange(set.getGroup('x'), subjectRange);
      set.assertTermTypeRange(set.getGroup('y'), subjectRange);
      expect(moves(set, () => void set.mergeGroups('x', 'y'))).toBe(true);
    });

    it('the solver unifying two variables', ({ expect }) => {
      const solver = new ClusterSolver();
      solver.getGroup(DF.variable('mi_x'));
      solver.getGroup(DF.variable('mi_y'));
      expect(moves(solver, () => solver.register(DF.variable('mi_x'), DF.variable('mi_y')))).toBe(true);
    });

    it('the solver registering an expression onto a group', ({ expect }) => {
      const solver = new ClusterSolver();
      const variable = DF.variable('mi_x');
      solver.getGroup(variable);
      const expression = AF.createTermExpression(termA);
      expect(moves(solver, () => solver.register(expression, variable))).toBe(true);
      expect(solver.getExpressions(variable)).toHaveLength(1);
    });

    it('the solver registering an expression against a term, which writes no group at all', ({ expect }) => {
      const solver = new ClusterSolver();
      solver.getGroup(DF.variable('mi_x'));
      const expression = AF.createTermExpression(termA);
      expect(moves(solver, () => solver.register(expression, termB))).toBe(true);
      expect(solver.getStaticExpressionValidation()).toHaveLength(1);
    });

    it('sortClusters, which reorders a group in place rather than changing what is in it', ({ expect }) => {
      const solver = new ClusterSolver();
      // The user query variable is met first, so it lands first and the sort has something to move.
      solver.register(DF.variable('uq_x'), DF.variable('mi_a'));
      const group = solver.getGroup(DF.variable('uq_x'));
      expect(solver.valuesOf(group).map(value => value.value)).toEqual([ 'uq_x', 'mi_a' ]);
      expect(moves(solver, () => solver.sortClusters())).toBe(true);
      expect(solver.valuesOf(group).map(value => value.value)).toEqual([ 'mi_a', 'uq_x' ]);
    });
  });

  describe('a read leaves the stamp alone', () => {
    it('so that a memo taken off the set survives being read again', ({ expect }) => {
      const set = twoGroups();
      set.setTerm(set.getGroup('x'), termA);
      const children = <PinChildren> set.assertTriplePin(set.getGroup('y'));
      const before = set.revision;

      set.groupOf('x');
      set.getGroup('x');
      set.valuesOf(set.groupOf('x')!);
      set.groupEntries();
      set.hasGroup(set.groupOf('x')!);
      set.pinOf(set.groupOf('y')!);
      set.termOf(set.groupOf('x')!);
      set.childrenOf(set.groupOf('y')!);
      set.rangeOf(set.groupOf('y')!);
      set.assertedRangeOf(set.groupOf('x')!);
      set.resolveGroup(children.subject);
      // Already shaped, so this answers rather than writes.
      set.assertTriplePin(set.groupOf('y')!);

      expect(set.revision).toBe(before);
    });
  });

  describe('a stamp is unique to one state of one set', () => {
    it('so a clone never reports what the set it came from reports', ({ expect }) => {
      const set = twoGroups();
      set.setTerm(set.getGroup('x'), termA);
      const copy = set.clone();
      expect(copy.revision).not.toBe(set.revision);
      // The copy holds the same state, which is exactly why the stamp may not be the same.
      expect(copy.termOf(copy.getGroup('x'))).toEqual(termA);
      expect(copy.revision).not.toBe(set.revision);
    });

    it('so two sets built the same way never collide', ({ expect }) => {
      const stamps = new Set<number>();
      for (let index = 0; index < 8; index++) {
        const set = new AssertionClusterSet();
        stamps.add(set.revision);
        set.getGroup('x');
        stamps.add(set.revision);
        set.narrowRange(set.getGroup('x'), tripleTermRange);
        stamps.add(set.revision);
      }
      expect(stamps.size).toBe(24);
    });

    it('so a set the conjunction adopts cannot hand back a stamp of the set it replaces', ({ expect }) => {
      const original = twoGroups();
      const seen = original.revision;
      // What `AssertionConjunction.assertWeakly` does: try on a clone, then take the clone's set over.
      const attempt = original.clone();
      attempt.setTerm(attempt.getGroup('x'), termA);
      expect(attempt.revision).toBeGreaterThan(seen);
    });
  });
});
