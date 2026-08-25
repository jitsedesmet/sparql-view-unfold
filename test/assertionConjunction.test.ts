import type * as RDF from '@rdfjs/types';
import { toAst } from '@traqula/algebra-sparql-1-2';
import type { Algebra as AlgebraTypes } from '@traqula/algebra-transformations-1-2';
import { describe, it } from 'vitest';
import type { RangeSet } from '../lib/RangeSet.js';
import { emptyRange, graphRange, predicateRange } from '../lib/RangeSet.js';
import type { TransformContext } from '../lib/transformContext.js';
import { createPartialContext } from '../lib/transformContext.js';
import { AssertionConjunction, collectAssertions } from '../lib/utils/assertionConjunction.js';
import type { Access, Assertion, Assertions } from '../lib/utils/assertions.js';
import {
  access,
  accessId,
  assertBound,
  assertStrong,
  assertTermType,
  assertUnbound,
  assertWeak,
} from '../lib/utils/assertions.js';
import type { CPMeta } from '../lib/utils/certainlyBoundVars.js';
import { VRanges } from '../lib/utils/certainlyBoundVars.js';
import { DF } from '../lib/utils/rdfDatatypes.js';
import { derivedVarNamer } from '../lib/utils.js';

const c = <TransformContext> createPartialContext();
const termC = DF.namedNode('ex://c');
const termD = DF.namedNode('ex://d');

/** The metadata of an operation binding `inScope`, of which `certain` is certainly bound. */
function metaOf(certain: string[], inScope: string[]): CPMeta {
  const vRanges = new VRanges();
  vRanges.addAtTop(inScope);
  return { cVars: new Set(certain), vRanges };
}

/** {@link metaOf} with `name` narrowed to `range`, the operation binding nothing else. */
function rangedMeta(certain: string[], name: string, range: RangeSet): CPMeta {
  const vRanges = new VRanges();
  vRanges.narrow(name, range);
  return { cVars: new Set(certain), vRanges };
}

/** The conjunction of the given conjuncts, or `undefined` when they contradict each other. */
function conjunctionOf(...conjuncts: [ string, Assertion ][]): AssertionConjunction | undefined {
  return structuralConjunctionOf(...conjuncts.map<[ Access, Assertion ]>(
    ([ name, assertion ]) => [ access(name), assertion ],
  ));
}

/** {@link conjunctionOf} over accesses, which is what a conjunct about a shape is written against. */
function structuralConjunctionOf(...conjuncts: [ Access, Assertion ][]): AssertionConjunction | undefined {
  const result = new AssertionConjunction();
  for (const [ access, assertion ] of conjuncts) {
    if (!result.assert(access, assertion)) {
      return undefined;
    }
  }
  return result;
}

/** What Θ decomposes into, each conjunct as `access=state`, in the order it hands them over. */
function conjunctsOf(assertions: AssertionConjunction | undefined): string[] {
  return (assertions?.conjuncts() ?? []).map(({ access: read, assertion }) => {
    if (assertion.subType === 'strong' || assertion.subType === 'weak') {
      const target = 'positions' in assertion.term ? accessId(assertion.term) : assertion.term.value;
      return `${accessId(read)}=${assertion.subType}(${target})`;
    }
    if (assertion.subType === 'termType') {
      return `${accessId(read)}=${assertion.strong ? 'type' : 'weakType'}(${assertion.termType})`;
    }
    return `${accessId(read)}=${assertion.subType}`;
  });
}

/** The state of a variable, as the single letter of the form it is in. */
function stateOf(assertions: AssertionConjunction | undefined, name: string): string {
  const assertion = assertions?.get(name);
  if (assertion === undefined) {
    return 'none';
  }
  if (assertion.subType === 'strong' || assertion.subType === 'weak') {
    return `${assertion.subType}(${'positions' in assertion.term ?
      accessId(assertion.term) :
      assertion.term.value})`;
  }
  if (assertion.subType === 'termType') {
    return `${assertion.strong ? 'type' : 'weakType'}(${assertion.termType})`;
  }
  return assertion.subType;
}

/** The expression `positions` read off `?name`, outermost accessor last: `OBJECT(SUBJECT(?o))`. */
function reads(name: string, ...positions: string[]): AlgebraTypes.Expression {
  return positions.reduce<AlgebraTypes.Expression>(
    (inner, position) => c.AF.createOperatorExpression(position, [ inner ]),
    c.AF.createTermExpression(DF.variable(name)),
  );
}

/** The conjunction, serialised through the generator - which is also how the pass writes it into a plan. */
function conditionOf(assertions: AssertionConjunction): string {
  const query = c.generator.generate(toAst(c.AF.createProject(
    c.AF.createFilter(c.AF.createBgp([]), assertions.toExpression(c)),
    [],
  ))).trim();
  return query.split('\n').map(line => line.trim()).filter(line => line.startsWith('FILTER')).join(' ');
}

/** A term as a query writes it, which for a materialised shape is the triple term it wrote. */
function termString(term: RDF.Term): string {
  if (term.termType === 'Variable') {
    return `?${term.value}`;
  }
  if (term.termType === 'Quad') {
    return `<<( ${termString(term.subject)} ${termString(term.predicate)} ${termString(term.object)} )>>`;
  }
  return term.value;
}

/** A substitution as `name=term`, in the order it hands the replacements over. */
function substitutionOf(substitution: Assertions): string[] {
  return [ ...substitution ].map(([ name, term ]) => `${name}=${termString(term)}`);
}

describe('assertionConjunction', () => {
  describe('assertions about a term', () => {
    it('reads a strong assertion back', ({ expect }) => {
      expect(stateOf(conjunctionOf([ 'x', assertStrong(termC) ]), 'x')).toBe('strong(ex://c)');
    });

    it('absorbs the weak form of what it knows strongly (`A ∧ W ≡ A`)', ({ expect }) => {
      expect(stateOf(conjunctionOf([ 'x', assertStrong(termC) ], [ 'x', assertWeak(termC) ]), 'x'))
        .toBe('strong(ex://c)');
    });

    it('promotes what it knows weakly when it meets the strong form', ({ expect }) => {
      expect(stateOf(conjunctionOf([ 'x', assertWeak(termC) ], [ 'x', assertStrong(termC) ]), 'x'))
        .toBe('strong(ex://c)');
    });

    it('contradicts on two distinct terms, one of them strong', ({ expect }) => {
      expect(conjunctionOf([ 'x', assertStrong(termC) ], [ 'x', assertStrong(termD) ])).toBeUndefined();
      expect(conjunctionOf([ 'x', assertStrong(termC) ], [ 'x', assertWeak(termD) ])).toBeUndefined();
      expect(conjunctionOf([ 'x', assertWeak(termC) ], [ 'x', assertStrong(termD) ])).toBeUndefined();
    });

    it('comes to `!bound` on two distinct terms, both weak', ({ expect }) => {
      // `(¬b ∨ ?x ≡ c) ∧ (¬b ∨ ?x ≡ d)` distributes to `¬b ∨ (?x ≡ c ∧ ?x ≡ d)`, which for `c ≠ d` is `¬b`.
      expect(stateOf(conjunctionOf([ 'x', assertWeak(termC) ], [ 'x', assertWeak(termD) ]), 'x')).toBe('unbound');
    });
  });

  describe('the U interactions of a group', () => {
    it('contradicts a strong member of a pinned group', ({ expect }) => {
      expect(conjunctionOf([ 'x', assertStrong(termC) ], [ 'x', assertUnbound() ])).toBeUndefined();
      expect(conjunctionOf([ 'x', assertUnbound() ], [ 'x', assertStrong(termC) ])).toBeUndefined();
    });

    it('absorbs a weak member and takes it out of the group', ({ expect }) => {
      // `¬b ∧ (¬b ∨ φ) ≡ ¬b`, so nothing of the term survives on `?x` - and nothing of it reaches `?y`,
      // which keeps saying exactly what it said.
      const assertions = conjunctionOf(
        [ 'x', assertWeak(termC) ],
        [ 'y', assertStrong(termC) ],
        [ 'x', assertUnbound() ],
      );
      expect(stateOf(assertions, 'x')).toBe('unbound');
      expect(stateOf(assertions, 'y')).toBe('strong(ex://c)');
      // Disjointness: `?x` is in no group any more, so nothing about it can be substituted.
      expect([ ...(<AssertionConjunction> assertions).strongSubstitution().keys() ]).toEqual([ 'y' ]);
    });

    it('contradicts a member of a clique, which is always strong', ({ expect }) => {
      expect(conjunctionOf([ 'x', assertStrong(DF.variable('y')) ], [ 'x', assertUnbound() ])).toBeUndefined();
      // The representative just as much: the clique implies it is bound too.
      expect(conjunctionOf([ 'y', assertStrong(DF.variable('x')) ], [ 'x', assertUnbound() ])).toBeUndefined();
    });

    it('contradicts `bound`', ({ expect }) => {
      expect(conjunctionOf([ 'x', assertBound() ], [ 'x', assertUnbound() ])).toBeUndefined();
      expect(conjunctionOf([ 'x', assertUnbound() ], [ 'x', assertBound() ])).toBeUndefined();
    });
  });

  describe('the B interactions of a group', () => {
    it('is absorbed by a strong member', ({ expect }) => {
      expect(stateOf(conjunctionOf([ 'x', assertStrong(termC) ], [ 'x', assertBound() ]), 'x'))
        .toBe('strong(ex://c)');
    });

    it('promotes a weak member to a strong one', ({ expect }) => {
      // `b ∧ (¬b ∨ ?x ≡ c) ≡ ?x ≡ c`, in both orders.
      expect(stateOf(conjunctionOf([ 'x', assertWeak(termC) ], [ 'x', assertBound() ]), 'x'))
        .toBe('strong(ex://c)');
      expect(stateOf(conjunctionOf([ 'x', assertBound() ], [ 'x', assertWeak(termC) ]), 'x'))
        .toBe('strong(ex://c)');
    });

    it('is absorbed by clique membership, which implies it', ({ expect }) => {
      const assertions = conjunctionOf([ 'x', assertStrong(DF.variable('y')) ], [ 'x', assertBound() ]);
      // `?x` is the representative of the clique `{?x, ?y}`, and B⟨?x⟩ is all that is left to say of it.
      expect(stateOf(assertions, 'x')).toBe('bound');
      expect(stateOf(assertions, 'y')).toBe('strong(x)');
      expect(conditionOf(<AssertionConjunction> assertions)).toBe('FILTER ( SAMETERM( ?y , ?x ) )');
    });

    it('is absorbed by itself', ({ expect }) => {
      expect(stateOf(conjunctionOf([ 'x', assertBound() ], [ 'x', assertBound() ]), 'x')).toBe('bound');
    });
  });

  describe('unification', () => {
    it('makes a clique whose representative is its lexicographically first member', ({ expect }) => {
      const assertions = <AssertionConjunction> conjunctionOf([ 's', assertStrong(DF.variable('o')) ]);
      expect(assertions.cliques()).toEqual([[ 'o', 's' ]]);
      expect(stateOf(assertions, 's')).toBe('strong(o)');
      // The representative has nothing left to be equal to, and reads as what the clique entails of it.
      expect(stateOf(assertions, 'o')).toBe('bound');
      expect([ ...assertions.strongSubstitution() ]).toEqual([[ 's', DF.variable('o') ]]);
      expect(conditionOf(assertions)).toBe('FILTER ( SAMETERM( ?s , ?o ) )');
    });

    it('re-picks the representative when a merge brings in an earlier variable', ({ expect }) => {
      const assertions = <AssertionConjunction> conjunctionOf(
        [ 's', assertStrong(DF.variable('o')) ],
        [ 'o', assertStrong(DF.variable('a')) ],
      );
      expect(assertions.cliques()).toEqual([[ 'a', 'o', 's' ]]);
      expect([ ...assertions.strongSubstitution() ])
        .toEqual([[ 's', DF.variable('a') ], [ 'o', DF.variable('a') ]]);
    });

    it('is only `bound` between a variable and itself', ({ expect }) => {
      const assertions = <AssertionConjunction> conjunctionOf([ 'x', assertStrong(DF.variable('x')) ]);
      expect(stateOf(assertions, 'x')).toBe('bound');
      expect(assertions.cliques()).toEqual([]);
    });

    it('drags a term met later onto every member of the clique', ({ expect }) => {
      const assertions = conjunctionOf(
        [ 's', assertStrong(DF.variable('o')) ],
        [ 'o', assertStrong(termC) ],
      );
      expect(stateOf(assertions, 's')).toBe('strong(ex://c)');
      expect(stateOf(assertions, 'o')).toBe('strong(ex://c)');
      expect((<AssertionConjunction> assertions).cliques()).toEqual([]);
    });

    it('promotes a weak member it meets, membership implying bound', ({ expect }) => {
      const assertions = conjunctionOf(
        [ 's', assertWeak(termC) ],
        [ 's', assertStrong(DF.variable('o')) ],
      );
      expect(stateOf(assertions, 's')).toBe('strong(ex://c)');
      expect(stateOf(assertions, 'o')).toBe('strong(ex://c)');
    });

    it('contradicts when the two cliques carry different terms', ({ expect }) => {
      expect(conjunctionOf(
        [ 'x', assertStrong(termC) ],
        [ 'y', assertStrong(termD) ],
        [ 'x', assertStrong(DF.variable('y')) ],
      )).toBeUndefined();
    });

    it('has no weak form to read back: `!bound(?x) || sameTerm(?x, ?y)` is left alone', ({ expect }) => {
      const collected = collectAssertions(
        c,
        c.AF.createOperatorExpression('||', [
          c.AF.createOperatorExpression('!', [
            c.AF.createOperatorExpression('bound', [ c.AF.createTermExpression(DF.variable('x')) ]),
          ]),
          c.AF.createOperatorExpression('sameterm', [
            c.AF.createTermExpression(DF.variable('x')),
            c.AF.createTermExpression(DF.variable('y')),
          ]),
        ]),
      );
      expect(collected?.assertions.size).toBe(0);
      expect(collected?.residual).toBeDefined();
    });
  });

  describe('splitting', () => {
    it('splits a clique into edges, never into variables', ({ expect }) => {
      const assertions = <AssertionConjunction> conjunctionOf(
        [ 'b', assertStrong(DF.variable('a')) ],
        [ 'c', assertStrong(DF.variable('b')) ],
      );
      const { inside, outside } = assertions.split(name => name !== 'c');
      // The edge `?c ≡ ?a` mentions a variable the predicate rejects, so the whole edge is on the outside.
      expect(conditionOf(inside)).toBe('FILTER ( SAMETERM( ?b , ?a ) )');
      expect(conditionOf(outside)).toBe('FILTER ( SAMETERM( ?c , ?a ) )');
    });

    it('keeps the two halves equivalent to the whole', ({ expect }) => {
      const assertions = <AssertionConjunction> conjunctionOf(
        [ 'b', assertStrong(DF.variable('a')) ],
        [ 'c', assertStrong(DF.variable('b')) ],
      );
      const { inside, outside } = assertions.split(name => name !== 'c');
      const rejoined = inside.clone();
      expect(rejoined.absorb(outside)).toBe(true);
      expect(rejoined.cliques()).toEqual([[ 'a', 'b', 'c' ]]);
    });
  });

  describe('weakening', () => {
    it('drops a clique rather than inventing a weak form of it', ({ expect }) => {
      const assertions = <AssertionConjunction> conjunctionOf(
        [ 'x', assertStrong(DF.variable('y')) ],
        [ 'z', assertStrong(termC) ],
        [ 'w', assertBound() ],
        [ 'v', assertUnbound() ],
      );
      const weakened = assertions.weakened();
      expect(stateOf(weakened, 'x')).toBe('none');
      expect(stateOf(weakened, 'y')).toBe('none');
      // B⟨?x⟩ weakened is `¬b ∨ b`, which is `true`, so it is dropped too.
      expect(stateOf(weakened, 'w')).toBe('none');
      expect(stateOf(weakened, 'z')).toBe('weak(ex://c)');
      expect(stateOf(weakened, 'v')).toBe('unbound');
    });
  });

  describe('what a clique entails', () => {
    it('offers `bound` of every member, the representative included', ({ expect }) => {
      const assertions = <AssertionConjunction> conjunctionOf(
        [ 'x', assertStrong(DF.variable('y')) ],
        [ 'z', assertWeak(termC) ],
        [ 'w', assertUnbound() ],
      );
      expect([ ...assertions.boundImpliedBy() ].sort()).toEqual([ 'x', 'y' ]);
    });
  });

  describe('normalising against an operation', () => {
    it('empties the plan on a clique member that can never be bound', ({ expect }) => {
      const assertions = <AssertionConjunction> conjunctionOf([ 'x', assertStrong(DF.variable('y')) ]);
      expect(assertions.normalisedFor(metaOf([ 'x' ], [ 'x' ]))).toBeUndefined();
    });

    it('drops a weak member that can never be bound, leaving its group alone', ({ expect }) => {
      const assertions = <AssertionConjunction> conjunctionOf(
        [ 'x', assertWeak(termC) ],
        [ 'y', assertStrong(termC) ],
      );
      const normalised = assertions.normalisedFor(metaOf([ 'y' ], [ 'y' ]));
      expect(stateOf(normalised, 'x')).toBe('none');
      expect(stateOf(normalised, 'y')).toBe('strong(ex://c)');
    });

    it('empties the plan on a term outside the range the variable can take', ({ expect }) => {
      // `GRAPH ?g` narrows `?g` to a graph name, and no solution binds one to a literal.
      const assertions = <AssertionConjunction> conjunctionOf([ 'g', assertStrong(DF.literal('1')) ]);
      expect(assertions.normalisedFor(rangedMeta([ 'g' ], 'g', graphRange))).toBeUndefined();
    });

    it('keeps a term the range still admits', ({ expect }) => {
      const assertions = <AssertionConjunction> conjunctionOf([ 'g', assertStrong(termC) ]);
      const normalised = assertions.normalisedFor(rangedMeta([ 'g' ], 'g', graphRange));
      expect(stateOf(normalised, 'g')).toBe('strong(ex://c)');
    });

    it('keeps a BlankNode a graph may be named by, which is not the emptiness a literal is', ({ expect }) => {
      const assertions = <AssertionConjunction> conjunctionOf([ 'g', assertStrong(DF.blankNode('b')) ]);
      const normalised = assertions.normalisedFor(rangedMeta([ 'g' ], 'g', graphRange));
      expect(stateOf(normalised, 'g')).toBe('strong(b)');
    });

    it('collapses a weak member out of range to `!bound`, its other disjunct being false', ({ expect }) => {
      // `¬bnd(?g) ∨ ?g ≡ "1"` where `?g` can only be a graph name: the right disjunct never holds, so
      // what is left is the unbound assertion - a real constraint, where the weak one said almost nothing.
      const assertions = <AssertionConjunction> conjunctionOf([ 'g', assertWeak(DF.literal('1')) ]);
      const normalised = assertions.normalisedFor(rangedMeta([], 'g', graphRange));
      expect(stateOf(normalised, 'g')).toBe('unbound');
    });

    it('leaves a weak member the range still admits weak', ({ expect }) => {
      const assertions = <AssertionConjunction> conjunctionOf([ 'g', assertWeak(termC) ]);
      const normalised = assertions.normalisedFor(rangedMeta([], 'g', graphRange));
      expect(stateOf(normalised, 'g')).toBe('weak(ex://c)');
    });

    it('empties rather than collapses where the variable is certainly bound', ({ expect }) => {
      // `?g ∈ cVars` promotes the weak member to strong first, and a strong one out of range is empty.
      const assertions = <AssertionConjunction> conjunctionOf([ 'g', assertWeak(DF.literal('1')) ]);
      expect(assertions.normalisedFor(rangedMeta([ 'g' ], 'g', graphRange))).toBeUndefined();
    });

    it('empties the plan on a bound assertion the variable can never satisfy', ({ expect }) => {
      // In scope - an all-UNDEF VALUES column declares it - and yet never bound, so `bound(?x)` is false.
      const assertions = <AssertionConjunction> conjunctionOf([ 'x', assertBound() ]);
      expect(assertions.normalisedFor(rangedMeta([], 'x', emptyRange))).toBeUndefined();
    });

    it('prunes an unbound assertion the variable can never fail', ({ expect }) => {
      const assertions = <AssertionConjunction> conjunctionOf([ 'x', assertUnbound() ]);
      expect(stateOf(assertions.normalisedFor(rangedMeta([], 'x', emptyRange)), 'x')).toBe('none');
    });

    it('prunes a weak member the `!bound` disjunct already carries', ({ expect }) => {
      const assertions = <AssertionConjunction> conjunctionOf([ 'x', assertWeak(termC) ]);
      expect(stateOf(assertions.normalisedFor(rangedMeta([], 'x', emptyRange)), 'x')).toBe('none');
    });

    it('promotes a weak member of a pinned group where it is certainly bound', ({ expect }) => {
      const assertions = <AssertionConjunction> conjunctionOf(
        [ 'x', assertWeak(termC) ],
        [ 'y', assertWeak(termC) ],
      );
      const normalised = assertions.normalisedFor(metaOf([ 'x' ], [ 'x', 'y' ]));
      expect(stateOf(normalised, 'x')).toBe('strong(ex://c)');
      expect(stateOf(normalised, 'y')).toBe('weak(ex://c)');
    });
  });

  describe('transferring a variable', () => {
    it('moves a clique membership onto the variable that carries its value', ({ expect }) => {
      // `BIND(?z AS ?t)` under A⟨?t ≡ ?y⟩: below the EXTEND `?z` is what `?t` was.
      const assertions = <AssertionConjunction> conjunctionOf([ 'y', assertStrong(DF.variable('t')) ]);
      const transferred = <AssertionConjunction> assertions.transferred('t', DF.variable('z'));
      expect(transferred.cliques()).toEqual([[ 'y', 'z' ]]);
      expect(stateOf(transferred, 't')).toBe('none');
    });

    it('moves a term onto the variable that carries its value', ({ expect }) => {
      const assertions = <AssertionConjunction> conjunctionOf([ 't', assertStrong(termC) ]);
      expect(stateOf(assertions.transferred('t', DF.variable('z')), 'z')).toBe('strong(ex://c)');
      const conflicting = <AssertionConjunction> conjunctionOf(
        [ 't', assertStrong(termC) ],
        [ 'z', assertStrong(termD) ],
      );
      expect(conflicting.transferred('t', DF.variable('z'))).toBeUndefined();
    });

    it('pins a clique to the term that takes the place of one of its members', ({ expect }) => {
      // `BIND(:c AS ?t)` under A⟨?t ≡ ?y⟩: `?t` is `:c` above, so `?y` has to be `:c` below.
      const assertions = <AssertionConjunction> conjunctionOf(
        [ 'y', assertStrong(DF.variable('t')) ],
        [ 'w', assertStrong(DF.variable('t')) ],
      );
      const transferred = <AssertionConjunction> assertions.transferred('t', termC);
      expect(stateOf(transferred, 'y')).toBe('strong(ex://c)');
      expect(stateOf(transferred, 'w')).toBe('strong(ex://c)');
      expect(stateOf(transferred, 't')).toBe('none');
      expect(transferred.cliques()).toEqual([]);
    });

    it('decides a term against the term the group was already pinned to', ({ expect }) => {
      const assertions = <AssertionConjunction> conjunctionOf(
        [ 't', assertStrong(termC) ],
        [ 'y', assertStrong(DF.variable('t')) ],
      );
      // `?t ≡ :c` with `?t` bound to `:c` holds, and `?y` keeps the term the group carries.
      expect(stateOf(assertions.transferred('t', termC), 'y')).toBe('strong(ex://c)');
      // `?t ≡ :c` with `?t` bound to `:d` does not.
      expect(assertions.transferred('t', termD)).toBeUndefined();
    });
  });

  describe('shapes', () => {
    const subjectOfO = access('o', 'subject');
    const objectOfO = access('o', 'object');

    it('reads a shape back as the degenerate one it is', ({ expect }) => {
      expect(stateOf(conjunctionOf([ 'o', assertTermType('Quad') ]), 'o')).toBe('type(Quad)');
      expect(conditionOf(<AssertionConjunction> conjunctionOf([ 'o', assertTermType('Quad') ])))
        .toBe('FILTER ( ISTRIPLE( ?o ) )');
    });

    it('implies bound, which is what collapses an OPTIONAL over it', ({ expect }) => {
      const assertions = <AssertionConjunction> conjunctionOf([ 'o', assertTermType('Quad') ]);
      expect([ ...assertions.boundImpliedBy() ]).toEqual([ 'o' ]);
      // The weak form does not, being satisfied by every solution leaving `?o` unbound.
      expect([ ...(<AssertionConjunction> conjunctionOf([ 'o', assertTermType('Quad', false) ])).boundImpliedBy() ])
        .toEqual([]);
    });

    it('is absorbed by anything that says more about the same positions', ({ expect }) => {
      // `isTRIPLE(?o)` adds nothing to a shape a position of which is already decided, so it is not
      // restated - which is what keeps a second run of the pass from stacking a copy of it.
      const assertions = structuralConjunctionOf(
        [ subjectOfO, assertStrong(termC) ],
        [ access('o'), assertTermType('Quad') ],
      );
      expect(conjunctsOf(assertions)).toEqual([ 'o.subject=strong(ex://c)' ]);
    });

    it('decomposes a shape asserted twice', ({ expect }) => {
      // `?o ≡ <<( ?a … )>>` and `?o ≡ <<( ?b … )>>` say `?a ≡ ?b`.
      const assertions = structuralConjunctionOf(
        [ access('a'), assertStrong(subjectOfO) ],
        [ access('b'), assertStrong(subjectOfO) ],
      );
      expect(assertions?.cliques()).toEqual([[ 'a', 'b' ]]);
    });

    it('carries what it knows about a position onto everything unified with it', ({ expect }) => {
      // Congruence: the shape sits on the *group*, so unifying `?o` with `?x` makes what is known about
      // `SUBJECT(?o)` known about `SUBJECT(?x)`.
      const assertions = structuralConjunctionOf(
        [ subjectOfO, assertStrong(termC) ],
        [ access('x'), assertStrong(access('o')) ],
      );
      expect(conjunctsOf(assertions)).toEqual([ 'x=strong(o)', 'o.subject=strong(ex://c)' ]);
      expect(conditionOf(<AssertionConjunction> assertions))
        .toBe('FILTER ( ( SAMETERM( ?x , ?o ) && SAMETERM( SUBJECT( ?o ) , <ex://c> ) ) )');
    });

    it('meets a ground triple term with a shape, position by position', ({ expect }) => {
      const assertions = structuralConjunctionOf(
        [ access('s'), assertStrong(subjectOfO) ],
        [ access('o'), assertStrong(DF.quad(termC, DF.namedNode('ex://p'), termD)) ],
      );
      // `?s` is the subject of that triple term, so it is `:c` - and the compact form of the shape is
      // gone, every position of it being decided on its own now.
      expect(stateOf(assertions, 's')).toBe('strong(ex://c)');
      expect(conjunctsOf(assertions)).toEqual([
        's=strong(ex://c)',
        'o.subject=strong(ex://c)',
        'o.predicate=strong(ex://p)',
        'o.object=strong(ex://d)',
      ]);
    });

    it('contradicts a shape against a term that is no triple term', ({ expect }) => {
      expect(structuralConjunctionOf([ access('o'), assertTermType('Quad') ], [ access('o'), assertStrong(termC) ]))
        .toBeUndefined();
      expect(structuralConjunctionOf([ access('o'), assertStrong(termC) ], [ subjectOfO, assertStrong(termD) ]))
        .toBeUndefined();
    });

    it('contradicts the unbound form, a triple term being a term', ({ expect }) => {
      expect(structuralConjunctionOf([ access('o'), assertTermType('Quad') ], [ access('o'), assertUnbound() ]))
        .toBeUndefined();
      expect(structuralConjunctionOf([ subjectOfO, assertStrong(termC) ], [ access('o'), assertUnbound() ]))
        .toBeUndefined();
    });

    it('refuses a variable that would be a position of itself (the occurs check)', ({ expect }) => {
      // `?o ≡ SUBJECT(?o)` has no solution: a triple term is strictly larger than each of its positions.
      expect(structuralConjunctionOf([ access('o'), assertStrong(subjectOfO) ])).toBeUndefined();
      // And one step deeper, where the cycle is closed by a merge rather than by the pin itself.
      expect(structuralConjunctionOf(
        [ access('x'), assertStrong(access('o', 'object', 'object')) ],
        [ access('x'), assertStrong(access('o')) ],
      )).toBeUndefined();
    });

    it('never writes an open shape as a triple term construction (S2)', ({ expect }) => {
      // The positions nobody named have no variable to write, so a construction would mention terms that
      // are unbound wherever the filter sits - and error, dropping every row.
      const assertions = <AssertionConjunction> structuralConjunctionOf([ objectOfO, assertStrong(termC) ]);
      expect(conditionOf(assertions)).toBe('FILTER ( SAMETERM( OBJECT( ?o ) , <ex://c> ) )');
    });

    it('round-trips the weak form of a conjunct about a position', ({ expect }) => {
      const assertions = <AssertionConjunction> structuralConjunctionOf([ subjectOfO, assertWeak(termC) ]);
      expect(conditionOf(assertions))
        .toBe('FILTER ( ( ! BOUND( ?o ) || SAMETERM( SUBJECT( ?o ) , <ex://c> ) ) )');
      expect(conditionOf(<AssertionConjunction> conjunctionOf([ 'o', assertTermType('Quad', false) ])))
        .toBe('FILTER ( ( ! BOUND( ?o ) || ISTRIPLE( ?o ) ) )');
    });

    it('comes to `!bound` on two weak conjuncts that cannot both hold', ({ expect }) => {
      // `(¬b ∨ SUBJECT(?o) ≡ c) ∧ (¬b ∨ SUBJECT(?o) ≡ d)` is `¬b`, exactly as for two terms.
      expect(stateOf(structuralConjunctionOf(
        [ subjectOfO, assertWeak(termC) ],
        [ subjectOfO, assertWeak(termD) ],
      ), 'o')).toBe('unbound');
    });

    it('empties the plan where a position can never hold what it is pinned to', ({ expect }) => {
      // The subject of a triple term is no literal, which is the same rule a `GRAPH ?g` reads for a term
      // outside `graphRange` - and it is what confines the nesting of shapes to the `object` chain.
      expect(structuralConjunctionOf([ subjectOfO, assertStrong(DF.literal('1')) ])).toBeUndefined();
      expect(structuralConjunctionOf([ subjectOfO, assertTermType('Quad') ])).toBeUndefined();
      // The predicate of one is an IRI and nothing else, blank nodes included. Every position carries
      // the range it admits from the moment the shape creates it, which is why nothing downstream - the
      // term a shape resolves to, above all - has to type-check the three all over again.
      expect(structuralConjunctionOf([ access('o', 'predicate'), assertStrong(DF.literal('1')) ]))
        .toBeUndefined();
      expect(structuralConjunctionOf([ access('o', 'predicate'), assertStrong(DF.blankNode('b')) ]))
        .toBeUndefined();
      expect(structuralConjunctionOf([ subjectOfO, assertStrong(DF.blankNode('b')) ])).toBeDefined();
    });

    it('empties the plan where the operation leaves the shape no term to take', ({ expect }) => {
      // A shape is a `Quad`, so a variable a graph position restricts to a graph name cannot carry one.
      const assertions = <AssertionConjunction> conjunctionOf([ 'g', assertTermType('Quad') ]);
      expect(assertions.normalisedFor(rangedMeta([ 'g' ], 'g', graphRange))).toBeUndefined();
    });

    it('weakens a conjunct about a position, and never one about two variables', ({ expect }) => {
      const assertions = <AssertionConjunction> structuralConjunctionOf(
        [ subjectOfO, assertStrong(termC) ],
        [ access('x'), assertStrong(access('y', 'object')) ],
      );
      expect(conjunctsOf(assertions.weakened())).toEqual([ 'o.subject=weak(ex://c)' ]);
    });

    it('reads the four term-type predicates as one form', ({ expect }) => {
      expect(stateOf(conjunctionOf([ 'x', assertTermType('NamedNode') ]), 'x')).toBe('type(NamedNode)');
      expect(stateOf(conjunctionOf([ 'x', assertTermType('BlankNode') ]), 'x')).toBe('type(BlankNode)');
      expect(stateOf(conjunctionOf([ 'x', assertTermType('Literal') ]), 'x')).toBe('type(Literal)');
      expect(conditionOf(<AssertionConjunction> conjunctionOf([ 'x', assertTermType('Literal') ])))
        .toBe('FILTER ( ISLITERAL( ?x ) )');
      expect(conditionOf(<AssertionConjunction> conjunctionOf([ 'x', assertTermType('BlankNode') ])))
        .toBe('FILTER ( ISBLANK( ?x ) )');
      expect(conditionOf(<AssertionConjunction> conjunctionOf([ 'x', assertTermType('NamedNode', false) ])))
        .toBe('FILTER ( ( ! BOUND( ?x ) || ISIRI( ?x ) ) )');
    });

    it('contradicts on two kinds of term at once, a term having one', ({ expect }) => {
      expect(conjunctionOf([ 'x', assertTermType('NamedNode') ], [ 'x', assertTermType('Literal') ]))
        .toBeUndefined();
      // And against a term of another kind, which says which kind it is by saying which term it is.
      expect(conjunctionOf([ 'x', assertTermType('Literal') ], [ 'x', assertStrong(termC) ]))
        .toBeUndefined();
      expect(conjunctionOf([ 'x', assertStrong(termC) ], [ 'x', assertTermType('Literal') ]))
        .toBeUndefined();
    });

    it('is absorbed by the term that decides which kind it is', ({ expect }) => {
      // `?x ≡ :c` already says `isIRI(?x)`, so restating it would say the same thing twice.
      const assertions = conjunctionOf([ 'x', assertTermType('NamedNode') ], [ 'x', assertStrong(termC) ]);
      expect(conjunctsOf(assertions)).toEqual([ 'x=strong(ex://c)' ]);
    });

    it('travels onto every member of a clique, being about the group', ({ expect }) => {
      const assertions = conjunctionOf(
        [ 'x', assertTermType('Literal') ],
        [ 'y', assertStrong(DF.variable('x')) ],
      );
      expect(stateOf(assertions, 'y')).toBe('strong(x)');
      // The edge comes first: the group writes itself out from its anchor, and `?x` is that anchor.
      expect(conjunctsOf(assertions)).toEqual([ 'y=strong(x)', 'x=type(Literal)' ]);
    });

    it('empties the plan where the kind of term is one the operation cannot bind', ({ expect }) => {
      // A graph name is never a literal, which is the same rule that empties it for a shape.
      const assertions = <AssertionConjunction> conjunctionOf([ 'g', assertTermType('Literal') ]);
      expect(assertions.normalisedFor(rangedMeta([ 'g' ], 'g', graphRange))).toBeUndefined();
      // One it *can* bind survives, and stays exactly as strong as it was.
      const named = <AssertionConjunction> conjunctionOf([ 'g', assertTermType('NamedNode') ]);
      expect(stateOf(named.normalisedFor(rangedMeta([ 'g' ], 'g', graphRange)), 'g')).toBe('type(NamedNode)');
    });

    it('states the kind of a position of a shape, which is a group like any other', ({ expect }) => {
      const assertions = <AssertionConjunction> structuralConjunctionOf(
        [ objectOfO, assertTermType('Literal') ],
      );
      // No `isTRIPLE(?o)` beside it: reading a position already entails what it is read through.
      expect(conjunctsOf(assertions)).toEqual([ 'o.object=type(Literal)' ]);
      expect(conditionOf(assertions)).toBe('FILTER ( ISLITERAL( OBJECT( ?o ) ) )');
    });

    it('keeps what a condition asserted across a clone', ({ expect }) => {
      // The cluster set a conjunction is built on carries state of its own, and cloning is how every
      // `split`, `weakened` and `normalisedFor` gets a Θ to work on - so a clone that quietly built the
      // base class would lose it on the first one of those.
      const assertions = <AssertionConjunction> conjunctionOf([ 'x', assertTermType('Literal') ]);
      expect(conjunctsOf(assertions.clone())).toEqual([ 'x=type(Literal)' ]);
      expect(conjunctsOf(assertions.split(() => true).inside)).toEqual([ 'x=type(Literal)' ]);
    });

    it('never writes back a kind of term it worked out for itself', ({ expect }) => {
      // `?x ≡ ?p` puts the two in one group, and a predicate is an IRI - so the group holds one. That is
      // a fact of where `?p` sits, true wherever the group is written, and restating it would grow the
      // condition on every pass without saying anything.
      const vRanges = new VRanges();
      vRanges.addAtTop([ 'x' ]);
      vRanges.narrow('p', predicateRange);
      const assertions = <AssertionConjunction> conjunctionOf([ 'x', assertStrong(DF.variable('p')) ]);
      const normalised = assertions.normalisedFor({ cVars: new Set([ 'x', 'p' ]), vRanges });
      expect(conjunctsOf(normalised)).toEqual([ 'x=strong(p)' ]);
    });

    it('reads a condition about a position as an assertion, not as a residual', ({ expect }) => {
      // Worth pinning on its own, because a *failure* to recognise one is close to invisible further out:
      // what the pass writes back for an assertion it cannot move is the condition it started from, so a
      // broken recogniser shows up as a residual that happens to read the same. Only the cases where the
      // assertion does travel - a deleted UNION branch, an emptied plan - tell the two apart.
      const collected = collectAssertions(c, c.AF.createOperatorExpression('sameterm', [
        reads('o', 'subject'),
        c.AF.createTermExpression(DF.variable('s')),
      ]));
      expect(collected?.residual).toBeUndefined();
      expect(conjunctsOf(collected?.assertions)).toEqual([ 'o.subject=strong(s)' ]);
    });

    it('reads a chain of accessors in the order they are applied', ({ expect }) => {
      // `SUBJECT(OBJECT(?o))` is `?o` read at its object and *then* at that object's subject - the
      // expression nests the other way round, so the two orders are easy to swap by accident. Read
      // backwards it would be `OBJECT(SUBJECT(?o))`, which is not even satisfiable: no subject is a
      // triple term, which is what confines the nesting to the `object` chain.
      const collected = collectAssertions(c, c.AF.createOperatorExpression('sameterm', [
        reads('o', 'object', 'subject'),
        c.AF.createTermExpression(termC),
      ]));
      expect(collected?.residual).toBeUndefined();
      expect(conjunctsOf(collected?.assertions)).toEqual([ 'o.object.subject=strong(ex://c)' ]);
      // And back out as the chain it came in as, which is what keeps a second run from re-deriving it.
      expect(conditionOf(<AssertionConjunction> collected?.assertions))
        .toBe('FILTER ( SAMETERM( SUBJECT( OBJECT( ?o ) ) , <ex://c> ) )');
      // And the impossible direction is empty rather than misread.
      expect(collectAssertions(c, c.AF.createOperatorExpression('sameterm', [
        reads('o', 'subject', 'object'),
        c.AF.createTermExpression(termC),
      ]))).toBeUndefined();
    });

    it('says nothing about a kind of term it only worked out from the plan', ({ expect }) => {
      // `?x ≡ PREDICATE(?o)` puts `?x` in a group the predicate position narrows to `{IRI}`. True, and
      // true wherever the group is written - but Θ never asserted it, so Θ must not report it as one of
      // its own. `get` and `conjuncts` are two views of one conjunction and cannot disagree about that.
      const assertions = <AssertionConjunction> structuralConjunctionOf(
        [ access('x'), assertStrong(access('o', 'predicate')) ],
      );
      expect(conjunctsOf(assertions)).toEqual([ 'o.predicate=strong(x)' ]);
      expect(stateOf(assertions, 'x')).toBe('bound');
    });

    it('does report a shape it holds as the triple term it is', ({ expect }) => {
      // The other side of the same line: a shape is Θ's own, so what it entails is Θ's to report. The
      // conjuncts leave `isTRIPLE(?o)` unwritten because the position already entails it - minimal
      // rather than silent, which is not the same as saying nothing.
      const assertions = <AssertionConjunction> structuralConjunctionOf([ subjectOfO, assertStrong(termC) ]);
      expect(stateOf(assertions, 'o')).toBe('type(Quad)');
      expect(conjunctsOf(assertions)).toEqual([ 'o.subject=strong(ex://c)' ]);
    });

    it('hands an edge reading through an accessor over one at a time', ({ expect }) => {
      const assertions = <AssertionConjunction> structuralConjunctionOf(
        [ access('s'), assertStrong(subjectOfO) ],
        [ access('y'), assertStrong(access('z')) ],
      );
      expect(assertions.singleVariableConjuncts().map(conjunct => accessId(conjunct.access))).toEqual([]);
      expect(assertions.cliques()).toEqual([[ 'y', 'z' ]]);
      expect(conjunctsOf(AssertionConjunction.of(assertions.accessConjuncts())))
        .toEqual([ 'o.subject=strong(s)' ]);
    });
  });

  describe('materialisation', () => {
    const subjectOfO = access('o', 'subject');
    const objectOfO = access('o', 'object');

    it('writes a shape out as the triple term it is, coining what nothing names', ({ expect }) => {
      // The target of the whole feature, at the level Θ decides it: `?s` goes into the position it is
      // asserted equal to, and the two positions nothing says anything about get a variable named after
      // the value they are read from.
      const assertions = <AssertionConjunction> structuralConjunctionOf([ access('s'), assertStrong(subjectOfO) ]);
      expect(substitutionOf(assertions.intoPattern(derivedVarNamer([])).substitution))
        .toEqual([ 'o=<<( ?s ?o_p ?o_o )>>' ]);
      // Nothing is left over: writing the pattern *is* stating the equality.
      expect(conjunctsOf(assertions.intoPattern(derivedVarNamer([])).residual)).toEqual([]);
    });

    it('writes a named position as its name rather than as a coined one', ({ expect }) => {
      // A group reachable both as `?x` and as `OBJECT(?o)` has to render the same way wherever it is
      // written, or the two readings stop being the one value (D4).
      const assertions = <AssertionConjunction> structuralConjunctionOf(
        [ access('x'), assertStrong(objectOfO) ],
        [ subjectOfO, assertStrong(termC) ],
      );
      expect(substitutionOf(assertions.intoPattern(derivedVarNamer([])).substitution))
        .toEqual([ 'o=<<( ex://c ?o_p ?x )>>' ]);
    });

    it('leaves a shape no position of which says anything alone', ({ expect }) => {
      // Three coined variables that state only that the value is a triple term, which is what the
      // condition states without coining any - so the condition is what it stays.
      const assertions = <AssertionConjunction> structuralConjunctionOf(
        [ access('o'), assertTermType('Quad') ],
        [ subjectOfO, assertStrong(subjectOfO) ],
      );
      expect(substitutionOf(assertions.intoPattern(derivedVarNamer([])).substitution)).toEqual([]);
      expect(conjunctsOf(assertions.intoPattern(derivedVarNamer([])).residual)).toEqual([ 'o=type(Quad)' ]);
    });

    it('keeps what a pattern cannot state about a position it wrote', ({ expect }) => {
      // Which kind of term a position holds is not something a triple pattern says, so it survives the
      // materialisation - and is written about `?o`, never about the variable coined for the position.
      const assertions = <AssertionConjunction> structuralConjunctionOf(
        [ access('s'), assertStrong(subjectOfO) ],
        [ objectOfO, assertTermType('NamedNode') ],
      );
      expect(substitutionOf(assertions.intoPattern(derivedVarNamer([])).substitution))
        .toEqual([ 'o=<<( ?s ?o_p ?o_o )>>' ]);
      expect(conjunctsOf(assertions.intoPattern(derivedVarNamer([])).residual))
        .toEqual([ 'o.object=type(NamedNode)' ]);
    });

    it('writes a nested shape out with the one holding it', ({ expect }) => {
      const assertions = <AssertionConjunction> structuralConjunctionOf(
        [ access('o', 'object', 'subject'), assertStrong(termC) ],
      );
      expect(substitutionOf(assertions.intoPattern(derivedVarNamer([])).substitution))
        .toEqual([ 'o=<<( ?o_s ?o_p <<( ex://c ?o_o_p ?o_o_o )>> )>>' ]);
    });

    it('never writes a weak member, which the pattern would claim is bound', ({ expect }) => {
      const assertions = <AssertionConjunction> structuralConjunctionOf(
        [ subjectOfO, assertWeak(termC) ],
      );
      expect(substitutionOf(assertions.intoPattern(derivedVarNamer([])).substitution)).toEqual([]);
      expect(conjunctsOf(assertions.intoPattern(derivedVarNamer([])).residual)).toEqual([ 'o.subject=weak(ex://c)' ]);
    });

    it('names a position once, and around the names the query already uses', ({ expect }) => {
      // The memo is what makes two materialisation sites agree, and the suffix is what keeps a coined
      // name off a variable of the query - including on the second reading, which has to hand back the
      // name the first one settled on rather than coin the next free one.
      const namer = derivedVarNamer([ 'o_p' ]);
      expect(namer('o', 'predicate').value).toBe('o_p0');
      expect(namer('o', 'predicate').value).toBe('o_p0');
      expect(namer('o', 'object').value).toBe('o_o');
    });
  });

  it('leaves the conjunction it was cloned from untouched', ({ expect }) => {
    const assertions = <AssertionConjunction> conjunctionOf([ 'x', assertStrong(DF.variable('y')) ]);
    const copy = assertions.clone();
    expect(copy.assert(access('z'), assertStrong(DF.variable('y')))).toBe(true);
    expect(copy.cliques()).toEqual([[ 'x', 'y', 'z' ]]);
    expect(assertions.cliques()).toEqual([[ 'x', 'y' ]]);
  });
});
