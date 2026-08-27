import { describe, it } from 'vitest';
import { ClusterSolver } from '../lib/ClusterSolver.js';
import { VAR_PREFIX_USER_QUERY } from '../lib/consts.js';
import { DF } from '../lib/utils/rdfDatatypes.js';

/**
 * The unfolding side of the pin lattice: what a *mapping head* writing a triple term comes to when the
 * pattern it is unified with binds that triple term as a whole.
 *
 * A triple term never becomes a pin of its own. It is decomposed into a shape, so everything the lattice
 * does for the assertion conjunction - unification of the positions, the range each position admits, the
 * occurs check - is what the solver does with `?t rdf:reifies <<( ?s ?p ?o )>>` as well.
 */
describe('clusterSolver', () => {
  const termA = DF.namedNode('ex://a');
  const termB = DF.namedNode('ex://b');
  const termC = DF.namedNode('ex://c');
  const varS = DF.variable('s');
  const varP = DF.variable('p');
  const varO = DF.variable('o');
  const varY = DF.variable('y');

  /** `?y ≡ <<( ?s ?p ?o )>>`, the head triple term of a mapping bound to one pattern variable. */
  function solverWithShape(): ClusterSolver {
    const solver = new ClusterSolver();
    solver.register(DF.quad(varS, varP, varO), varY);
    return solver;
  }

  describe('triple terms of a mapping head', () => {
    it('reads a triple term back off the shape it became', ({ expect }) => {
      const solver = solverWithShape();
      // Nothing *pins* the group: a triple term is a shape, and the term is what reading it back gives.
      expect(solver.termOf(solver.getGroup(varY))).toBeUndefined();
      expect(solver.getCluster(varY).term).toEqual(DF.quad(varS, varP, varO));
    });

    it('gives every position a group of its own, which fixing it is visible through', ({ expect }) => {
      const solver = solverWithShape();
      solver.register(termA, varS);
      expect(solver.getCluster(varY).term).toEqual(DF.quad(termA, varP, varO));
    });

    it('names a position by the variable it is unified with where nothing fixes it', ({ expect }) => {
      const solver = solverWithShape();
      solver.register(DF.variable('mi_x'), varO);
      solver.sortClusters();
      expect(solver.getCluster(varY).term).toEqual(DF.quad(varS, varP, DF.variable('mi_x')));
    });

    it('unifies two triple terms of one group position by position', ({ expect }) => {
      const solver = solverWithShape();
      // The two spellings are one value, so `?s` is the subject of that value and so is `?a`.
      solver.register(DF.quad(DF.variable('a'), DF.variable('b'), DF.variable('c')), varY);
      expect(solver.getGroup(DF.variable('a'))).toBe(solver.getGroup(varS));
      expect(solver.getGroup(DF.variable('b'))).toBe(solver.getGroup(varP));
      expect(solver.getGroup(DF.variable('c'))).toBe(solver.getGroup(varO));
    });

    it('decides the variables of one triple term from the terms of another', ({ expect }) => {
      const solver = new ClusterSolver();
      solver.register(DF.quad(termA, termB, varO), varY);
      solver.register(DF.quad(varS, varP, termC), varY);
      expect(solver.termOf(solver.getGroup(varS))).toEqual(termA);
      expect(solver.termOf(solver.getGroup(varP))).toEqual(termB);
      expect(solver.termOf(solver.getGroup(varO))).toEqual(termC);
    });

    it('takes a nested triple term apart with it', ({ expect }) => {
      const solver = new ClusterSolver();
      const nested = DF.quad(DF.variable('a'), DF.variable('b'), DF.variable('c'));
      solver.register(DF.quad(varS, varP, nested), varY);
      solver.register(termB, DF.variable('b'));
      expect(solver.getCluster(varY).term)
        .toEqual(DF.quad(varS, varP, DF.quad(DF.variable('a'), termB, DF.variable('c'))));
    });

    it('decides a ground triple term position by position rather than pinning it whole', ({ expect }) => {
      const solver = new ClusterSolver();
      solver.register(DF.quad(termA, termB, termC), varY);
      expect(solver.getCluster(varY).term).toEqual(DF.quad(termA, termB, termC));
      expect(() => solver.register(DF.quad(termA, termB, termA), varY))
        .toThrow('Cannot match Term');
    });
  });

  describe('telling the mapping side of a cluster from the user query side', () => {
    /**
     * The two sides are told apart by the whole `uq_` prefix of {@link VAR_PREFIX_USER_QUERY}, not by the
     * two letters it starts with: `?uqx` names no user query variable - the user's `?uqx` arrives here as
     * `?uq_uqx` - so it is a mapping variable like any other.
     */
    it('counts a variable merely starting with the letters of the prefix as a mapping variable', ({ expect }) => {
      const solver = new ClusterSolver();
      const mappingVar = DF.variable('uqx');
      solver.register(mappingVar, DF.variable(`${VAR_PREFIX_USER_QUERY}x`));
      expect(solver.mappingVarsOf(solver.getGroup(mappingVar)).map(value => value.value))
        .toEqual([ 'uqx' ]);
    });

    /**
     * What the rewriting reads off a cluster is its *first* variable, so the ordering is the classification
     * rather than a lexicographic accident of the two prefixes: a mapping variable sorting after `uq_` by
     * name still comes first.
     */
    it('orders the mapping variables first however their names compare', ({ expect }) => {
      const solver = new ClusterSolver();
      const userQueryVar = DF.variable(`${VAR_PREFIX_USER_QUERY}a`);
      const mappingVar = DF.variable('zz_x');
      solver.register(mappingVar, userQueryVar);
      solver.register(mappingVar, DF.variable(`${VAR_PREFIX_USER_QUERY}b`));
      solver.sortClusters();
      // The variable a bind on `?uq_a` names, which has to be one the mapping body projects.
      expect(solver.getCluster(userQueryVar).vars.map(value => value.value))
        .toEqual([ 'zz_x', `${VAR_PREFIX_USER_QUERY}b` ]);
    });
  });

  describe('what a shape refuses', () => {
    it('holds every position to the range that position admits', ({ expect }) => {
      const solver = solverWithShape();
      expect([ ...solver.rangeOf(solver.getGroup(varS)).values() ].sort())
        .toEqual([ 'BlankNode', 'NamedNode' ]);
      // Which is a Literal subject refused where a Literal object is not.
      expect(() => solver.register(DF.literal('l'), varS)).toThrow('Cannot assign Term');
    });

    it('refuses a triple term containing the very group it fixes', ({ expect }) => {
      const solver = new ClusterSolver();
      // `?y ≡ <<( ?s ?p ?y )>>` has no solution: a triple term is larger than each of its positions.
      expect(() => solver.register(DF.quad(varS, varP, varY), varY)).toThrow();
    });

    it('refuses a triple term on a group already fixed to a basic term', ({ expect }) => {
      const solver = new ClusterSolver();
      solver.register(termA, varY);
      expect(() => solver.register(DF.quad(varS, varP, varO), varY)).toThrow('Cannot match Term');
    });

    it('refuses a basic term on a group already holding a triple term', ({ expect }) => {
      const solver = solverWithShape();
      expect(() => solver.register(termA, varY)).toThrow('Cannot match Term');
    });
  });
});
