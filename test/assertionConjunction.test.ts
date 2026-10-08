import type * as RDF from '@rdfjs/types';
import { toAst } from '@traqula/algebra-sparql-1-2';
import type { Algebra as AlgebraTypes } from '@traqula/algebra-transformations-1-2';
import { describe, it } from 'vitest';
import {
  emptyRange,
  graphRange,
  objectRange,
  predicateRange,
  RangeSet,
  subjectRange,
  tripleTermRange,
} from '../lib/RangeSet.js';
import { createTransformationContext, parseQuery } from '../lib/transformContext.js';
import type { AssertionConjunctionMeta } from '../lib/utils/assertionConjunction.js';
import { AssertionConjunction, collectAssertions, termTypesOfReadings } from '../lib/utils/assertionConjunction.js';
import type { Access, Assertion, AssertionConjunct, Assertions } from '../lib/utils/assertions.js';
import {
  access,
  accessId,
  assertBound,
  assertStrong,
  assertTermType,
  assertUnbound,
  assertWeak,
  asWeakenedConjunct,
} from '../lib/utils/assertions.js';
import type { CPMeta } from '../lib/utils/certainlyBoundVars.js';
import { VRanges } from '../lib/utils/certainlyBoundVars.js';
import { DF } from '../lib/utils/rdfDatatypes.js';
import { derivedVarNamer } from '../lib/utils.js';

const c = createTransformationContext();
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

/**
 * What Θ decomposes into, each conjunct as `access=state`, in the order it hands them over.
 * @param assertions - The conjunction to read, if any
 * @returns the conjuncts
 */
function conjunctsOf(assertions: AssertionConjunction | undefined): string[] {
  return conjunctStrings(assertions?.conjuncts() ?? []);
}

/**
 * Conjuncts as `access=state`, in the order given.
 * @param conjuncts - The conjuncts to write
 * @returns one string per conjunct
 */
function conjunctStrings(conjuncts: readonly AssertionConjunct[]): string[] {
  return conjuncts.map(({ access: read, assertion }) => `${accessId(read)}=${assertionString(assertion)}`);
}

/**
 * The state of a variable, as the form it is in.
 * @param assertions - The conjunction to read, if any
 * @param name - The variable to look up
 * @returns the form, or `none`
 */
function stateOf(assertions: AssertionConjunction | undefined, name: string): string {
  const assertion = assertions?.get(name);
  return assertion === undefined ? 'none' : assertionString(assertion);
}

/**
 * An assertion as its form, with what it fixes its access to or the term types it allows.
 * @param assertion - The assertion to write
 * @returns the string
 */
function assertionString(assertion: Assertion): string {
  if (assertion.subType === 'strong' || assertion.subType === 'weak') {
    const target = 'positions' in assertion.term ? accessId(assertion.term) : assertion.term.value;
    return `${assertion.subType}(${target})`;
  }
  if (assertion.subType === 'termType') {
    return `${assertion.strong ? 'type' : 'weakType'}(${rangeString(assertion.range)})`;
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

/**
 * Θ in the strongest form that survives a move where its variables may be unbound: what the rules that
 * demote a conjunction do to it, one conjunct at a time ({@link asWeakenedConjunct}).
 */
function weakenedForm(assertions: AssertionConjunction): AssertionConjunction {
  return AssertionConjunction.of(assertions.conjuncts()
    .map(conjunct => asWeakenedConjunct(conjunct))
    .filter(conjunct => conjunct !== undefined));
}

/**
 * {@link equatedGroupsOf} without the term types.
 * @param assertions - The conjunction to read, if any
 * @returns the ids of the readings per group
 */
function equatedReadingsOf(assertions: AssertionConjunction | undefined): string[][] {
  return equatedGroupsOf(assertions).map(({ readings }) => readings);
}

/**
 * The range holding exactly the given term types.
 * @param types - The term types
 * @returns the range
 */
function termTypes(...types: RDF.Term['termType'][]): RangeSet {
  return new RangeSet(types);
}

/** The range of an IRI or a literal. */
const iriOrLiteral = termTypes('Literal', 'NamedNode');

/** The range of an IRI or a blank node. */
const iriOrBlank = termTypes('NamedNode', 'BlankNode');

/**
 * A range as its term types, alphabetically, so that a test reads the same whatever order it was built in.
 * @param range - The range to write
 * @returns the string
 */
function rangeString(range: RangeSet): string {
  return [ ...range ].sort().join(',');
}

/**
 * The groups Θ reads more than one way, as the ids of their readings, representative first, with their term types.
 * @param assertions - The conjunction to read, if any
 * @returns the groups, `range` being `undefined` where Θ asserts none
 */
function equatedGroupsOf(assertions: AssertionConjunction | undefined): { readings: string[]; range?: string }[] {
  return (assertions?.equatedGroups() ?? []).map(({ readings, range }) => ({
    readings: readings.map(reading => accessId(reading)),
    range: range === undefined ? undefined : rangeString(range),
  }));
}

/**
 * The two halves {@link AssertionConjunction.split} cuts Θ into, each as its conjuncts.
 * @param assertions - The conjunction to split
 * @param predicate - Which variables belong inside
 * @returns the two halves
 */
function splitOf(
  assertions: AssertionConjunction,
  predicate: (name: string) => boolean,
): { inside: string[]; outside: string[] } {
  const { inside, outside } = assertions.split(predicate);
  return { inside: conjunctsOf(inside), outside: conjunctsOf(outside) };
}

/**
 * The two halves {@link AssertionConjunction.split} cuts Θ into, conjoined again.
 * @param assertions - The conjunction to split
 * @param predicate - Which variables belong inside
 * @returns the conjunction of the halves
 */
function rejoined(assertions: AssertionConjunction, predicate: (name: string) => boolean): AssertionConjunction {
  const { inside, outside } = assertions.split(predicate);
  return AssertionConjunction.of([ ...inside.conjuncts(), ...outside.conjuncts() ]);
}

/**
 * `?y ≡ ?x` with `?x` of the given term types, which `?y` - the same value - is then too.
 * @param range - The term types of `?x`
 * @returns the conjunction
 */
function typedClique(range: RangeSet): AssertionConjunction {
  return <AssertionConjunction> conjunctionOf(
    [ 'x', assertTermType(range) ],
    [ 'y', assertStrong(DF.variable('x')) ],
  );
}

/**
 * What Θ the condition of `FILTER(condition)` reads into, nested the way the parser nests it.
 * @param condition - The condition to read
 * @param known - The assertions already known to hold, if any
 * @returns the conjunction and the residual, or `undefined` when the condition is contradictory
 */
function collectedFrom(condition: string, known?: AssertionConjunction): AssertionConjunctionMeta | undefined {
  const query = <AlgebraTypes.Project> parseQuery(c, `SELECT * WHERE { FILTER(${condition}) }`);
  return collectAssertions(c, (<AlgebraTypes.Filter> query.input).expression, known);
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
      expect([ ...(<AssertionConjunction> assertions).rebuildingSubstitution().keys() ]).toEqual([ 'y' ]);
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
      expect(equatedReadingsOf(assertions)).toEqual([[ 'o', 's' ]]);
      expect(stateOf(assertions, 's')).toBe('strong(o)');
      // The representative has nothing left to be equal to, and reads as what the clique entails of it.
      expect(stateOf(assertions, 'o')).toBe('bound');
      expect([ ...assertions.rebuildingSubstitution() ]).toEqual([[ 's', DF.variable('o') ]]);
      expect(conditionOf(assertions)).toBe('FILTER ( SAMETERM( ?s , ?o ) )');
    });

    it('re-picks the representative when a merge brings in an earlier variable', ({ expect }) => {
      const assertions = <AssertionConjunction> conjunctionOf(
        [ 's', assertStrong(DF.variable('o')) ],
        [ 'o', assertStrong(DF.variable('a')) ],
      );
      expect(equatedReadingsOf(assertions)).toEqual([[ 'a', 'o', 's' ]]);
      expect([ ...assertions.rebuildingSubstitution() ])
        .toEqual([[ 's', DF.variable('a') ], [ 'o', DF.variable('a') ]]);
    });

    it('is only `bound` between a variable and itself', ({ expect }) => {
      const assertions = <AssertionConjunction> conjunctionOf([ 'x', assertStrong(DF.variable('x')) ]);
      expect(stateOf(assertions, 'x')).toBe('bound');
      expect(equatedReadingsOf(assertions)).toEqual([]);
    });

    it('only reads a position it is asserted between and itself', ({ expect }) => {
      // `sameTerm(SUBJECT(?o), SUBJECT(?o))` holds wherever there is a subject to read: it says `?o` is a triple
      // term, and nothing about the subject - not even what a subject always is.
      const subjectOfO = access('o', 'subject');
      expect(conjunctsOf(structuralConjunctionOf([ subjectOfO, assertStrong(subjectOfO) ])))
        .toEqual([ 'o=type(Quad)' ]);
    });

    it('drags a term met later onto every member of the clique', ({ expect }) => {
      const assertions = conjunctionOf(
        [ 's', assertStrong(DF.variable('o')) ],
        [ 'o', assertStrong(termC) ],
      );
      expect(stateOf(assertions, 's')).toBe('strong(ex://c)');
      expect(stateOf(assertions, 'o')).toBe('strong(ex://c)');
      expect(equatedReadingsOf(assertions)).toEqual([]);
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
      expect(equatedReadingsOf(rejoined(assertions, name => name !== 'c'))).toEqual([[ 'a', 'b', 'c' ]]);
    });

    describe('a typed clique', () => {
      const literal = termTypes('Literal');

      it('gives the inside the term types of a reading it holds, the edge outside carrying them on', ({ expect }) => {
        // `isLITERAL(?y)` inside and `?y ≡ ?x` outside say `isLITERAL(?x)` between them, so saying it outside as
        // well would only say it twice - where saying it inside is what lets an operand binding `?y` use it.
        expect(splitOf(typedClique(literal), name => name === 'y'))
          .toEqual({ inside: [ 'y=type(Literal)' ], outside: [ 'y=strong(x)' ]});
      });

      it('keeps the term types outside, on the representative, where no reading goes inside', ({ expect }) => {
        expect(splitOf(typedClique(literal), name => name === 'z'))
          .toEqual({ inside: [], outside: [ 'y=strong(x)', 'x=type(Literal)' ]});
      });

      it('keeps the group whole where every reading goes inside', ({ expect }) => {
        expect(splitOf(typedClique(literal), () => true))
          .toEqual({ inside: [ 'y=strong(x)', 'x=type(Literal)' ], outside: []});
      });

      it('keeps the two halves equivalent to the whole, wherever the group is cut', ({ expect }) => {
        const assertions = <AssertionConjunction> conjunctionOf(
          [ 'x', assertTermType(termTypes('Literal')) ],
          [ 'y', assertStrong(DF.variable('x')) ],
          [ 'z', assertStrong(DF.variable('x')) ],
        );
        const cuts: ((name: string) => boolean)[] = [
          name => name === 'z',
          name => name !== 'z',
          () => false,
          () => true,
        ];
        for (const predicate of cuts) {
          expect(conditionOf(rejoined(assertions, predicate))).toBe(conditionOf(assertions));
        }
      });
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
      const weakened = weakenedForm(assertions);
      expect(stateOf(weakened, 'x')).toBe('none');
      expect(stateOf(weakened, 'y')).toBe('none');
      // B⟨?x⟩ weakened is `¬b ∨ b`, which is `true`, so it is dropped too.
      expect(stateOf(weakened, 'w')).toBe('none');
      expect(stateOf(weakened, 'z')).toBe('weak(ex://c)');
      expect(stateOf(weakened, 'v')).toBe('unbound');
    });

    it('weakens a range into its weak form, range and all', ({ expect }) => {
      const assertions = <AssertionConjunction> conjunctionOf([ 'x', assertTermType(iriOrLiteral) ]);
      expect(stateOf(weakenedForm(assertions), 'x')).toBe('weakType(Literal,NamedNode)');
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

    describe('a range', () => {
      it('comes to `bound` where the operation leaves the variable nothing outside the range', ({ expect }) => {
        // `GRAPH ?g` leaves `?g` a graph name, so `isIRI(?g) || isBLANK(?g)` only asks that it is bound - which
        // nothing is left to ask where the operation binds it in every solution.
        const assertions = <AssertionConjunction> conjunctionOf([ 'g', assertTermType(graphRange) ]);
        expect(conjunctsOf(assertions.normalisedFor(rangedMeta([], 'g', graphRange)))).toEqual([ 'g=bound' ]);
        const certain = assertions.normalisedFor(rangedMeta([ 'g' ], 'g', graphRange));
        expect(certain).toBeDefined();
        expect(certain?.size).toBe(0);
      });

      it('is kept, as asserted, where the operation leaves the variable a term outside it', ({ expect }) => {
        // `?g` can still be a blank node, which the condition rejects. That it can be no literal is a fact of the
        // plan rather than of Θ, so the condition does not narrow to `isIRI(?g)` on its account.
        const assertions = <AssertionConjunction> conjunctionOf([
          'g',
          assertTermType(iriOrLiteral),
        ]);
        expect(stateOf(assertions.normalisedFor(rangedMeta([], 'g', graphRange)), 'g'))
          .toBe('type(Literal,NamedNode)');
      });

      it('is dropped in its weak form where the operation leaves the variable nothing outside it', ({ expect }) => {
        // `!bound(?g) || isIRI(?g) || isBLANK(?g)` holds of every solution where `?g` can only be a graph name.
        const assertions = <AssertionConjunction> conjunctionOf([ 'g', assertTermType(graphRange, false) ]);
        const normalised = assertions.normalisedFor(rangedMeta([], 'g', graphRange));
        expect(normalised).toBeDefined();
        expect(normalised?.size).toBe(0);
        // And where it holds nothing `?g` can be, its right disjunct is false and `!bound` is what is left.
        const outOfRange = <AssertionConjunction> conjunctionOf([ 'g', assertTermType(termTypes('Literal'), false) ]);
        expect(stateOf(outOfRange.normalisedFor(rangedMeta([], 'g', graphRange)), 'g')).toBe('unbound');
      });

      it('is forgotten of a clique a member of which the operation confines, the clique staying', ({ expect }) => {
        // `?y ≡ ?x` already says that `?x` is bound and holds the graph name `?y` holds, which is all the range
        // says - of the group, whichever member the operation happens to confine.
        const vRanges = new VRanges();
        vRanges.addAtTop([ 'x' ]);
        vRanges.narrow('y', graphRange);
        const assertions = <AssertionConjunction> conjunctionOf(
          [ 'x', assertTermType(graphRange) ],
          [ 'y', assertStrong(DF.variable('x')) ],
        );
        const normalised = assertions.normalisedFor({ cVars: new Set(), vRanges });
        expect(conjunctsOf(normalised)).toEqual([ 'y=strong(x)' ]);
        expect(equatedGroupsOf(normalised)).toEqual([{ readings: [ 'x', 'y' ], range: undefined }]);
      });

      it('is forgotten of an accessor test admitting all its position holds, as of `isTRIPLE`', ({ expect }) => {
        // `isIRI(SUBJECT(?o)) || isBLANK(SUBJECT(?o))` asks only that `?o` is a triple term, so it is held as the
        // range `isTRIPLE(?o)` is, and an operation confining `?o` to triple terms decides both alike.
        const read = <AssertionConjunction> structuralConjunctionOf(
          [ access('o', 'subject'), assertTermType(subjectRange) ],
        );
        const asserted = <AssertionConjunction> conjunctionOf([ 'o', assertTermType(tripleTermRange) ]);
        for (const assertions of [ read, asserted ]) {
          expect(conjunctsOf(assertions.normalisedFor(rangedMeta([], 'o', tripleTermRange)))).toEqual([ 'o=bound' ]);
        }
      });

      it('is left alone on a pinned group, the pin saying more than the range does', ({ expect }) => {
        // Forgetting it would take `?g` out of what is a group of one and leave `bound(?g)`, losing the pin.
        const pinned = <AssertionConjunction> conjunctionOf(
          [ 'g', assertTermType(graphRange) ],
          [ 'g', assertStrong(termC) ],
        );
        expect(stateOf(pinned.normalisedFor(rangedMeta([], 'g', graphRange)), 'g')).toBe('strong(ex://c)');
        // A shape just as much: that `?o` is a triple term is the least of what it says.
        const shaped = <AssertionConjunction> structuralConjunctionOf(
          [ access('o'), assertTermType(tripleTermRange) ],
          [ access('o', 'subject'), assertStrong(termC) ],
        );
        expect(conjunctsOf(shaped.normalisedFor(rangedMeta([], 'o', tripleTermRange))))
          .toEqual([ 'o.subject=strong(ex://c)' ]);
      });
    });
  });

  describe('transferring a variable', () => {
    it('moves a clique membership onto the variable that carries its value', ({ expect }) => {
      // `BIND(?z AS ?t)` under A⟨?t ≡ ?y⟩: below the EXTEND `?z` is what `?t` was.
      const assertions = <AssertionConjunction> conjunctionOf([ 'y', assertStrong(DF.variable('t')) ]);
      const transferred = <AssertionConjunction> assertions.transferred('t', DF.variable('z'));
      expect(equatedReadingsOf(transferred)).toEqual([[ 'y', 'z' ]]);
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
      expect(equatedReadingsOf(transferred)).toEqual([]);
    });

    it('takes a shape apart onto the components of the construction that carries it', ({ expect }) => {
      // `BIND(<<( ?a ?b ?c )>> AS ?t)` under a shape on `?t`: what the shape said about a position is
      // what it says about the variable written there, so it can travel on to the pattern binding it.
      const assertions = <AssertionConjunction> structuralConjunctionOf(
        [ access('t', 'subject'), assertStrong(termC) ],
        [ access('t', 'object'), assertStrong(access('y')) ],
      );
      const transferred = <AssertionConjunction> assertions.transferred('t', {
        subject: access('a'),
        predicate: access('b'),
        object: access('c'),
      });
      expect(stateOf(transferred, 'a')).toBe('strong(ex://c)');
      expect(equatedReadingsOf(transferred)).toEqual([[ 'c', 'y' ]]);
      expect(stateOf(transferred, 't')).toBe('none');
    });

    it('moves what it holds onto the access a BIND reads', ({ expect }) => {
      // `BIND(SUBJECT(?o) AS ?x)` under A⟨?x ≡ ?y⟩: below the EXTEND it is the subject of `?o` that has
      // to equal `?y`, which is a shape on `?o` where nothing was known about it before.
      const assertions = <AssertionConjunction> conjunctionOf([ 'x', assertStrong(DF.variable('y')) ]);
      const transferred = <AssertionConjunction> assertions.transferred('x', access('o', 'subject'));
      expect(conjunctsOf(transferred)).toEqual([ 'o.subject=strong(y)' ]);
      expect(stateOf(transferred, 'x')).toBe('none');
    });

    it('restates `bound` as reading the source yielding a value', ({ expect }) => {
      // B⟨?x⟩ says the expression produced a value rather than erroring, which for a variable it copies
      // is that the variable is bound, and for a position that what it is read through is a triple term.
      expect(stateOf(conjunctionOf([ 'x', assertBound() ])?.transferred('x', DF.variable('z')), 'z'))
        .toBe('bound');
      expect(stateOf(conjunctionOf([ 'x', assertBound() ])?.transferred('x', access('o', 'subject')), 'o'))
        .toBe('type(Quad)');
      // And on a construction it is every position of it holding a term the position admits, since one
      // that raises leaves the target unbound.
      const built = conjunctionOf([ 'x', assertBound() ])?.transferred('x', {
        subject: access('a'),
        predicate: access('b'),
        object: access('c'),
      });
      expect(conjunctsOf(built)).toEqual([ 'a=type(BlankNode,NamedNode)', 'b=type(NamedNode)', 'c=bound' ]);
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

    it('keeps `bound` on the member a clique of two is transferred onto', ({ expect }) => {
      // `BIND(?z AS ?t)` under A⟨?t ≡ ?z⟩: `?t` is `?z` wherever `?z` is bound, so all the condition still asks
      // below is that it is. Taking `?t` out drops the group, and must not drop that with it.
      const assertions = <AssertionConjunction> conjunctionOf([ 't', assertStrong(DF.variable('z')) ]);
      expect(conjunctsOf(assertions.transferred('t', access('z')))).toEqual([ 'z=bound' ]);
    });

    it('keeps the term types of a clique on the member left of it', ({ expect }) => {
      const assertions = <AssertionConjunction> conjunctionOf(
        [ 't', assertTermType(iriOrLiteral) ],
        [ 'z', assertStrong(DF.variable('t')) ],
      );
      expect(conjunctsOf(assertions.transferred('t', access('z')))).toEqual([ 'z=type(Literal,NamedNode)' ]);
    });

    it('restates the term types of a target built by a construction as what its positions admit', ({ expect }) => {
      // `BIND(TRIPLE(?a, ?b, ?c) AS ?t)` under `isTRIPLE(?t)`: the construction raises - leaving `?t` unbound -
      // unless `?a` can be a subject and `?b` a predicate, which is what the condition comes to below.
      const construction = { subject: access('a'), predicate: access('b'), object: access('c') };
      const tripleTerm = <AssertionConjunction> conjunctionOf([ 't', assertTermType(tripleTermRange) ]);
      expect(conjunctsOf(tripleTerm.transferred('t', construction)))
        .toEqual([ 'a=type(BlankNode,NamedNode)', 'b=type(NamedNode)', 'c=bound' ]);
      // A construction yields nothing but a triple term, so term types without that one empty the plan.
      const iri = <AssertionConjunction> conjunctionOf([ 't', assertTermType(termTypes('NamedNode')) ]);
      expect(iri.transferred('t', construction)).toBeUndefined();
    });

    it('empties the plan on a construction nested in the subject of one', ({ expect }) => {
      // `TRIPLE(TRIPLE(?a, ?b, ?c), ?p, ?q)` raises, a triple term being no subject, so the target is never bound
      // - whether it was asserted bound or of a kind of term. In the object, the one place a triple term may be,
      // it is a construction like the outer one.
      const inner = { subject: access('a'), predicate: access('b'), object: access('c') };
      for (const assertion of [ assertBound(), assertTermType(tripleTermRange) ]) {
        const assertions = <AssertionConjunction> conjunctionOf([ 't', assertion ]);
        expect(assertions.transferred('t', { subject: inner, predicate: access('p'), object: access('q') }))
          .toBeUndefined();
        const nestedInObject = { subject: access('p'), predicate: access('q'), object: inner };
        expect(conjunctsOf(assertions.transferred('t', nestedInObject)))
          .toEqual([
            'p=type(BlankNode,NamedNode)',
            'q=type(NamedNode)',
            'a=type(BlankNode,NamedNode)',
            'b=type(NamedNode)',
            'c=bound',
          ]);
      }
    });
  });

  describe('shapes', () => {
    const subjectOfO = access('o', 'subject');
    const objectOfO = access('o', 'object');

    it('reads a shape back as the degenerate one it is', ({ expect }) => {
      expect(stateOf(conjunctionOf([ 'o', assertTermType(tripleTermRange) ]), 'o')).toBe('type(Quad)');
      expect(conditionOf(<AssertionConjunction> conjunctionOf([ 'o', assertTermType(tripleTermRange) ])))
        .toBe('FILTER ( ISTRIPLE( ?o ) )');
    });

    it('implies bound, which is what collapses an OPTIONAL over it', ({ expect }) => {
      const assertions = <AssertionConjunction> conjunctionOf([ 'o', assertTermType(tripleTermRange) ]);
      expect([ ...assertions.boundImpliedBy() ]).toEqual([ 'o' ]);
      // The weak form does not, being satisfied by every solution leaving `?o` unbound.
      const weak = <AssertionConjunction> conjunctionOf([ 'o', assertTermType(tripleTermRange, false) ]);
      expect([ ...weak.boundImpliedBy() ]).toEqual([]);
    });

    it('is absorbed by anything that says more about the same positions', ({ expect }) => {
      // `isTRIPLE(?o)` adds nothing to a shape a position of which is already decided, so it is not
      // restated - which is what keeps a second run of the pass from stacking a copy of it.
      const assertions = structuralConjunctionOf(
        [ subjectOfO, assertStrong(termC) ],
        [ access('o'), assertTermType(tripleTermRange) ],
      );
      expect(conjunctsOf(assertions)).toEqual([ 'o.subject=strong(ex://c)' ]);
    });

    it('decomposes a shape asserted twice', ({ expect }) => {
      // `?o ≡ <<( ?a … )>>` and `?o ≡ <<( ?b … )>>` say `?a ≡ ?b` - one group, read three ways.
      const assertions = structuralConjunctionOf(
        [ access('a'), assertStrong(subjectOfO) ],
        [ access('b'), assertStrong(subjectOfO) ],
      );
      expect(equatedReadingsOf(assertions)).toEqual([[ 'a', 'b', 'o.subject' ]]);
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
      expect(structuralConjunctionOf(
        [ access('o'), assertTermType(tripleTermRange) ],
        [ access('o'), assertStrong(termC) ],
      )).toBeUndefined();
      expect(structuralConjunctionOf([ access('o'), assertStrong(termC) ], [ subjectOfO, assertStrong(termD) ]))
        .toBeUndefined();
    });

    it('contradicts the unbound form, a triple term being a term', ({ expect }) => {
      expect(structuralConjunctionOf(
        [ access('o'), assertTermType(tripleTermRange) ],
        [ access('o'), assertUnbound() ],
      )).toBeUndefined();
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
      expect(conditionOf(<AssertionConjunction> conjunctionOf([ 'o', assertTermType(tripleTermRange, false) ])))
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
      expect(structuralConjunctionOf([ subjectOfO, assertTermType(tripleTermRange) ])).toBeUndefined();
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
      const assertions = <AssertionConjunction> conjunctionOf([ 'g', assertTermType(tripleTermRange) ]);
      expect(assertions.normalisedFor(rangedMeta([ 'g' ], 'g', graphRange))).toBeUndefined();
    });

    it('weakens a conjunct about a position, and never one about two variables', ({ expect }) => {
      const assertions = <AssertionConjunction> structuralConjunctionOf(
        [ subjectOfO, assertStrong(termC) ],
        [ access('x'), assertStrong(access('y', 'object')) ],
      );
      expect(conjunctsOf(weakenedForm(assertions))).toEqual([ 'o.subject=weak(ex://c)' ]);
    });

    it('reads the four term-type predicates as one form', ({ expect }) => {
      expect(stateOf(conjunctionOf([ 'x', assertTermType(termTypes('NamedNode')) ]), 'x')).toBe('type(NamedNode)');
      expect(stateOf(conjunctionOf([ 'x', assertTermType(termTypes('BlankNode')) ]), 'x')).toBe('type(BlankNode)');
      expect(stateOf(conjunctionOf([ 'x', assertTermType(termTypes('Literal')) ]), 'x')).toBe('type(Literal)');
      expect(conditionOf(<AssertionConjunction> conjunctionOf([ 'x', assertTermType(termTypes('Literal')) ])))
        .toBe('FILTER ( ISLITERAL( ?x ) )');
      expect(conditionOf(<AssertionConjunction> conjunctionOf([ 'x', assertTermType(termTypes('BlankNode')) ])))
        .toBe('FILTER ( ISBLANK( ?x ) )');
      expect(conditionOf(<AssertionConjunction> conjunctionOf([ 'x', assertTermType(termTypes('NamedNode'), false) ])))
        .toBe('FILTER ( ( ! BOUND( ?x ) || ISIRI( ?x ) ) )');
    });

    it('contradicts on two kinds of term at once, a term having one', ({ expect }) => {
      expect(conjunctionOf(
        [ 'x', assertTermType(termTypes('NamedNode')) ],
        [ 'x', assertTermType(termTypes('Literal')) ],
      )).toBeUndefined();
      // And against a term of another kind, which says which kind it is by saying which term it is.
      expect(conjunctionOf([ 'x', assertTermType(termTypes('Literal')) ], [ 'x', assertStrong(termC) ]))
        .toBeUndefined();
      expect(conjunctionOf([ 'x', assertStrong(termC) ], [ 'x', assertTermType(termTypes('Literal')) ]))
        .toBeUndefined();
    });

    it('is absorbed by the term that decides which kind it is', ({ expect }) => {
      // `?x ≡ :c` already says `isIRI(?x)`, so restating it would say the same thing twice.
      const assertions = conjunctionOf([ 'x', assertTermType(termTypes('NamedNode')) ], [ 'x', assertStrong(termC) ]);
      expect(conjunctsOf(assertions)).toEqual([ 'x=strong(ex://c)' ]);
    });

    it('travels onto every member of a clique, being about the group', ({ expect }) => {
      const assertions = conjunctionOf(
        [ 'x', assertTermType(termTypes('Literal')) ],
        [ 'y', assertStrong(DF.variable('x')) ],
      );
      expect(stateOf(assertions, 'y')).toBe('strong(x)');
      // The edge comes first: the group writes itself out from its representative, and `?x` is that representative.
      expect(conjunctsOf(assertions)).toEqual([ 'y=strong(x)', 'x=type(Literal)' ]);
    });

    it('empties the plan where the kind of term is one the operation cannot bind', ({ expect }) => {
      // A graph name is never a literal, which is the same rule that empties it for a shape.
      const assertions = <AssertionConjunction> conjunctionOf([ 'g', assertTermType(termTypes('Literal')) ]);
      expect(assertions.normalisedFor(rangedMeta([ 'g' ], 'g', graphRange))).toBeUndefined();
      // One it *can* bind survives, and stays exactly as strong as it was.
      const named = <AssertionConjunction> conjunctionOf([ 'g', assertTermType(termTypes('NamedNode')) ]);
      expect(stateOf(named.normalisedFor(rangedMeta([ 'g' ], 'g', graphRange)), 'g')).toBe('type(NamedNode)');
    });

    it('states the kind of a position of a shape, which is a group like any other', ({ expect }) => {
      const assertions = <AssertionConjunction> structuralConjunctionOf(
        [ objectOfO, assertTermType(termTypes('Literal')) ],
      );
      // No `isTRIPLE(?o)` beside it: reading a position already entails what it is read through.
      expect(conjunctsOf(assertions)).toEqual([ 'o.object=type(Literal)' ]);
      expect(conditionOf(assertions)).toBe('FILTER ( ISLITERAL( OBJECT( ?o ) ) )');
    });

    it('keeps what a condition asserted across a clone', ({ expect }) => {
      // The cluster set a conjunction is built on carries state of its own, and cloning is how every
      // `split`, `weakened` and `normalisedFor` gets a Θ to work on - so a clone that quietly built the
      // base class would lose it on the first one of those.
      const assertions = <AssertionConjunction> conjunctionOf([ 'x', assertTermType(termTypes('Literal')) ]);
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

    it('reads an edge through an accessor as a group of two ways of reading one value', ({ expect }) => {
      // A clique of variables and an edge into a position are one thing: each is a group Θ can read
      // more than one way, and it is that which a rule splits rather than places conjunct by conjunct.
      const assertions = <AssertionConjunction> structuralConjunctionOf(
        [ access('s'), assertStrong(subjectOfO) ],
        [ access('y'), assertStrong(access('z')) ],
      );
      expect(assertions.unaryConjunctsAndEquatedGroups().unaryConjuncts.map(conjunct => accessId(conjunct.access)))
        .toEqual([]);
      expect(equatedReadingsOf(assertions)).toEqual([[ 's', 'o.subject' ], [ 'y', 'z' ]]);
    });
  });

  describe('term type ranges', () => {
    it('writes a range back as one test per term type, always in the same order', ({ expect }) => {
      // `isIRI`, `isBLANK`, `isLITERAL`, `isTRIPLE` in that order, whatever order the range was built in: one
      // range written one way is what has a second run of the pass read back exactly what the first one wrote.
      expect(conditionOf(<AssertionConjunction> conjunctionOf([ 'x', assertTermType(iriOrLiteral) ])))
        .toBe('FILTER ( ( ISIRI( ?x ) || ISLITERAL( ?x ) ) )');
      expect(conditionOf(<AssertionConjunction> conjunctionOf([
        'x',
        assertTermType(termTypes('Quad', 'Literal', 'BlankNode')),
      ]))).toBe('FILTER ( ( ( ISBLANK( ?x ) || ISLITERAL( ?x ) ) || ISTRIPLE( ?x ) ) )');
      expect(conditionOf(<AssertionConjunction> conjunctionOf([ 'x', assertTermType(iriOrLiteral, false) ])))
        .toBe('FILTER ( ( ! BOUND( ?x ) || ( ISIRI( ?x ) || ISLITERAL( ?x ) ) ) )');
    });

    it('reports the range it holds of a variable, and how strongly', ({ expect }) => {
      const strong = <AssertionConjunction> conjunctionOf([ 'x', assertTermType(iriOrLiteral) ]);
      const weak = <AssertionConjunction> conjunctionOf([ 'x', assertTermType(iriOrLiteral, false) ]);
      expect(stateOf(strong, 'x')).toBe('type(Literal,NamedNode)');
      expect(stateOf(weak, 'x')).toBe('weakType(Literal,NamedNode)');
      // Only the strong form fails where `?x` is unbound: a term type test raises there, and the weak form's
      // `!bound(?x)` is what holds instead.
      expect([ ...strong.boundImpliedBy() ]).toEqual([ 'x' ]);
      expect([ ...weak.boundImpliedBy() ]).toEqual([]);
    });

    it('meets two ranges asserted of one variable', ({ expect }) => {
      const assertions = <AssertionConjunction> conjunctionOf(
        [ 'x', assertTermType(iriOrBlank) ],
        [ 'x', assertTermType(iriOrLiteral) ],
      );
      expect(stateOf(assertions, 'x')).toBe('type(NamedNode)');
      expect(conditionOf(assertions)).toBe('FILTER ( ISIRI( ?x ) )');
    });

    it('contradicts on two ranges with no term type in common', ({ expect }) => {
      expect(conjunctionOf([ 'x', assertTermType(iriOrBlank) ], [ 'x', assertTermType(termTypes('Literal', 'Quad')) ]))
        .toBeUndefined();
      // A weak range is no way out of it once the other one is strong, which says that `?x` is bound.
      expect(conjunctionOf([ 'x', assertTermType(iriOrBlank, false) ], [ 'x', assertTermType(termTypes('Literal')) ]))
        .toBeUndefined();
    });

    it('comes to `!bound` on two weak ranges with no term type in common', ({ expect }) => {
      // `(¬b ∨ ?x ∈ R) ∧ (¬b ∨ ?x ∈ S)` is `¬b ∨ ?x ∈ R ∩ S`: `¬b` where the two are disjoint, and the weak
      // form of the meet where they are not.
      expect(stateOf(conjunctionOf(
        [ 'x', assertTermType(iriOrBlank, false) ],
        [ 'x', assertTermType(termTypes('Literal'), false) ],
      ), 'x')).toBe('unbound');
      expect(stateOf(conjunctionOf(
        [ 'x', assertTermType(iriOrBlank, false) ],
        [ 'x', assertTermType(iriOrLiteral, false) ],
      ), 'x')).toBe('weakType(NamedNode)');
    });

    it('is absorbed by a term inside it, and contradicts one outside it', ({ expect }) => {
      // `?x ≡ :c` says which kind of term `?x` is by saying which term it is, whichever comes first.
      expect(conjunctsOf(conjunctionOf([ 'x', assertTermType(iriOrLiteral) ], [ 'x', assertStrong(termC) ])))
        .toEqual([ 'x=strong(ex://c)' ]);
      expect(conjunctsOf(conjunctionOf([ 'x', assertStrong(termC) ], [ 'x', assertTermType(iriOrLiteral) ])))
        .toEqual([ 'x=strong(ex://c)' ]);
      const blankOrLiteral = termTypes('BlankNode', 'Literal');
      expect(conjunctionOf([ 'x', assertTermType(blankOrLiteral) ], [ 'x', assertStrong(termC) ])).toBeUndefined();
      expect(conjunctionOf([ 'x', assertStrong(termC) ], [ 'x', assertTermType(blankOrLiteral) ])).toBeUndefined();
    });

    it('meets `bound` and `!bound` the way a weak term does', ({ expect }) => {
      // `b ∧ (¬b ∨ ?x ∈ R)` is `?x ∈ R`, in both orders, and `¬b ∧ (¬b ∨ ?x ∈ R)` is `¬b`.
      expect(stateOf(conjunctionOf([ 'x', assertTermType(iriOrLiteral, false) ], [ 'x', assertBound() ]), 'x'))
        .toBe('type(Literal,NamedNode)');
      expect(stateOf(conjunctionOf([ 'x', assertBound() ], [ 'x', assertTermType(iriOrLiteral, false) ]), 'x'))
        .toBe('type(Literal,NamedNode)');
      expect(stateOf(conjunctionOf([ 'x', assertTermType(iriOrLiteral, false) ], [ 'x', assertUnbound() ]), 'x'))
        .toBe('unbound');
      // The strong form holds of a term, which an unbound variable is not.
      expect(conjunctionOf([ 'x', assertTermType(iriOrLiteral) ], [ 'x', assertUnbound() ])).toBeUndefined();
    });

    it('says only that a variable is bound where it admits every term type', ({ expect }) => {
      // Every RDF term is an IRI, a blank node, a literal or a triple term, so the four tests together fail
      // exactly where `?x` is unbound.
      const assertions = conjunctionOf([ 'x', assertTermType(objectRange) ]);
      expect(stateOf(assertions, 'x')).toBe('bound');
      expect(conjunctsOf(assertions)).toEqual([ 'x=bound' ]);
    });

    it('says nothing at all in its weak form where it admits every term type', ({ expect }) => {
      // `!bound(?x) || bound(?x)` holds of every solution, so not even the variable is left to mention.
      const assertions = <AssertionConjunction> conjunctionOf([ 'x', assertTermType(objectRange, false) ]);
      expect(assertions.size).toBe(0);
      expect(conjunctsOf(assertions)).toEqual([]);
    });

    it('says only that a triple term is read where it admits all a position can hold', ({ expect }) => {
      // `SUBJECT(?o)` is an IRI or a blank node wherever there is a subject to read, so the test holds exactly
      // where `?o` is a triple term - and a range wider than the position says no more than that.
      expect(conjunctsOf(structuralConjunctionOf([ access('o', 'subject'), assertTermType(subjectRange) ])))
        .toEqual([ 'o=type(Quad)' ]);
      expect(conjunctsOf(structuralConjunctionOf([ access('o', 'predicate'), assertTermType(iriOrBlank) ])))
        .toEqual([ 'o=type(Quad)' ]);
      expect(conjunctsOf(structuralConjunctionOf([ access('o', 'subject'), assertTermType(subjectRange, false) ])))
        .toEqual([ 'o=weakType(Quad)' ]);
    });

    it('writes the range of a group read at a position only where the position does not decide it', ({ expect }) => {
      // Equal to `SUBJECT(?o)`, `?s` is an IRI or a blank node whatever else is said of it: `isIRI(?s) || isBLANK(?s)`
      // adds nothing to the edge, and `isIRI(?s) || isLITERAL(?s)` comes to `isIRI(?s)` beside it.
      const edge: [ Access, Assertion ] = [ access('o', 'subject'), assertStrong(access('s')) ];
      expect(conjunctsOf(structuralConjunctionOf(edge, [ access('s'), assertTermType(iriOrBlank) ])))
        .toEqual([ 'o.subject=strong(s)' ]);
      expect(conjunctsOf(structuralConjunctionOf(edge, [ access('s'), assertTermType(iriOrLiteral) ])))
        .toEqual([ 'o.subject=strong(s)', 's=type(NamedNode)' ]);
      // What the group reports is still what was asserted, which is what the pieces a rule splits it into learn.
      expect(equatedGroupsOf(structuralConjunctionOf(edge, [ access('s'), assertTermType(iriOrLiteral) ])))
        .toEqual([{ readings: [ 's', 'o.subject' ], range: 'Literal,NamedNode' }]);
    });

    it('reads a disjunction of term type tests about one access as one range, however it nests', ({ expect }) => {
      // The parser nests `a || b || c` to the left, so the parenthesised form is the one nesting to the right.
      for (const condition of [
        'ISIRI(?x) || ISBLANK(?x) || ISLITERAL(?x)',
        'ISIRI(?x) || (ISBLANK(?x) || ISLITERAL(?x))',
      ]) {
        const collected = collectedFrom(condition);
        expect(collected?.residual).toBeUndefined();
        expect(conjunctsOf(collected?.assertions)).toEqual([ 'x=type(BlankNode,Literal,NamedNode)' ]);
      }
      // `isURI` is the `isIRI` it is a synonym of, and a position is an access like any other.
      expect(conjunctsOf(collectedFrom('ISURI(?x) || ISBLANK(?x)')?.assertions))
        .toEqual([ 'x=type(BlankNode,NamedNode)' ]);
      expect(conjunctsOf(collectedFrom('ISIRI(OBJECT(?o)) || ISLITERAL(OBJECT(?o))')?.assertions))
        .toEqual([ 'o.object=type(Literal,NamedNode)' ]);
    });

    it('leaves a disjunction of tests about two accesses standing as a residual', ({ expect }) => {
      // Neither access on its own has to be an IRI, so there is no range to hold of either one.
      for (const condition of [ 'ISIRI(?x) || ISIRI(?y)', 'ISIRI(?o) || ISIRI(OBJECT(?o))' ]) {
        const collected = collectedFrom(condition);
        expect(collected?.assertions.size).toBe(0);
        expect(collected?.residual).toBeDefined();
      }
    });

    it('reads `!bound` beside a range about its variable as the weak form, however it nests', ({ expect }) => {
      for (const condition of [
        '!BOUND(?x) || ISIRI(?x) || ISBLANK(?x)',
        '!BOUND(?x) || (ISIRI(?x) || ISBLANK(?x))',
        'ISIRI(?x) || !BOUND(?x) || ISBLANK(?x)',
      ]) {
        const collected = collectedFrom(condition);
        expect(collected?.residual).toBeUndefined();
        expect(conjunctsOf(collected?.assertions)).toEqual([ 'x=weakType(BlankNode,NamedNode)' ]);
      }
    });

    it('leaves `!bound` beside a range about another variable standing as a residual', ({ expect }) => {
      // `!bound(?x) || isIRI(?y)` asks something of `?y` only where `?x` is bound, which no state of either says.
      const collected = collectedFrom('!BOUND(?x) || ISIRI(?y)');
      expect(collected?.assertions.size).toBe(0);
      expect(collected?.residual).toBeDefined();
    });

    it('round-trips the weak form of a range about a position', ({ expect }) => {
      // The `!bound` is about the root, which is what a conjunct about `OBJECT(?o)` is weak in.
      const collected = collectedFrom('!BOUND(?o) || ISIRI(OBJECT(?o))');
      expect(collected?.residual).toBeUndefined();
      expect(conjunctsOf(collected?.assertions)).toEqual([ 'o.object=weakType(NamedNode)' ]);
      const assertions = <AssertionConjunction> collected?.assertions;
      expect(conditionOf(assertions)).toBe('FILTER ( ( ! BOUND( ?o ) || ISIRI( OBJECT( ?o ) ) ) )');
      const again = collectAssertions(c, assertions.toExpression(c));
      expect(again?.residual).toBeUndefined();
      expect(conjunctsOf(again?.assertions)).toEqual([ 'o.object=weakType(NamedNode)' ]);
    });

    it('absorbs a range it already holds rather than stacking a copy of it', ({ expect }) => {
      // Re-reading the condition it wrote, with what it already knows, is what a second run of the pass does.
      const assertions = <AssertionConjunction> conjunctionOf([ 'x', assertTermType(iriOrLiteral) ]);
      const again = collectAssertions(c, assertions.toExpression(c), assertions);
      expect(again?.residual).toBeUndefined();
      expect(conjunctsOf(again?.assertions)).toEqual([ 'x=type(Literal,NamedNode)' ]);
      // And a test no term type of the range passes is the empty filter.
      expect(collectedFrom('ISBLANK(?x) || ISTRIPLE(?x)', assertions)).toBeUndefined();
    });
  });

  describe('the term types of a clique', () => {
    it('reports the range of a clique beside its readings', ({ expect }) => {
      expect(equatedGroupsOf(typedClique(iriOrLiteral)))
        .toEqual([{ readings: [ 'x', 'y' ], range: 'Literal,NamedNode' }]);
      expect(equatedGroupsOf(conjunctionOf([ 'y', assertStrong(DF.variable('x')) ])))
        .toEqual([{ readings: [ 'x', 'y' ], range: undefined }]);
    });

    it('reports a shaped group as holding a triple term, which it is by being one', ({ expect }) => {
      const assertions = structuralConjunctionOf(
        [ access('x'), assertStrong(access('o')) ],
        [ access('o', 'subject'), assertStrong(termC) ],
      );
      expect(equatedGroupsOf(assertions)).toEqual([{ readings: [ 'o', 'x' ], range: 'Quad' }]);
    });

    it('meets the ranges asserted of two variables it unifies, being about their one value', ({ expect }) => {
      const assertions = conjunctionOf(
        [ 'x', assertTermType(iriOrBlank) ],
        [ 'y', assertTermType(iriOrLiteral) ],
        [ 'x', assertStrong(DF.variable('y')) ],
      );
      expect(conjunctsOf(assertions)).toEqual([ 'y=strong(x)', 'x=type(NamedNode)' ]);
      expect(conjunctionOf(
        [ 'x', assertTermType(termTypes('NamedNode')) ],
        [ 'y', assertTermType(termTypes('Literal')) ],
        [ 'x', assertStrong(DF.variable('y')) ],
      )).toBeUndefined();
    });

    it('leaves the range of a clique out of its unary conjuncts', ({ expect }) => {
      // It holds of every reading, which a rule placing a conjunct by the one access it is about would place
      // by the representative alone - so the group hands it to each of its readings instead.
      const assertions = <AssertionConjunction> conjunctionOf(
        [ 'x', assertTermType(iriOrLiteral) ],
        [ 'y', assertStrong(DF.variable('x')) ],
        [ 'z', assertTermType(termTypes('NamedNode')) ],
      );
      expect(conjunctsOf(assertions)).toEqual([ 'y=strong(x)', 'x=type(Literal,NamedNode)', 'z=type(NamedNode)' ]);
      expect(conjunctStrings(assertions.unaryConjunctsAndEquatedGroups().unaryConjuncts))
        .toEqual([ 'z=type(NamedNode)' ]);
    });

    it('states the range of a group of every reading of it, representative first', ({ expect }) => {
      const [ clique ] = typedClique(iriOrLiteral).equatedGroups();
      expect(conjunctStrings(termTypesOfReadings(clique)))
        .toEqual([ 'x=type(Literal,NamedNode)', 'y=type(Literal,NamedNode)' ]);
      // A position is a reading like any other, and comes after every variable.
      const [ edge ] = (<AssertionConjunction> structuralConjunctionOf(
        [ access('s'), assertStrong(access('o', 'subject')) ],
        [ access('s'), assertTermType(termTypes('NamedNode')) ],
      )).equatedGroups();
      expect(conjunctStrings(termTypesOfReadings(edge)))
        .toEqual([ 's=type(NamedNode)', 'o.subject=type(NamedNode)' ]);
      // And a group that asserts no range has none to hand out.
      const [ untyped ] = (<AssertionConjunction> conjunctionOf([ 'y', assertStrong(DF.variable('x')) ]))
        .equatedGroups();
      expect(termTypesOfReadings(untyped)).toEqual([]);
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
        [ access('o'), assertTermType(tripleTermRange) ],
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
        [ objectOfO, assertTermType(termTypes('NamedNode')) ],
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

    it('rebuilds a shape out of what reads its positions, and coins nothing', ({ expect }) => {
      // What a re-binding may write, as against what a pattern may: every position is read by a variable
      // of its own, so the value can be put together again without naming anything new.
      const assertions = <AssertionConjunction> structuralConjunctionOf(
        [ access('s'), assertStrong(subjectOfO) ],
        [ access('p'), assertStrong(access('o', 'predicate')) ],
        [ access('v'), assertStrong(objectOfO) ],
      );
      expect(substitutionOf(assertions.rebuildingSubstitution())).toEqual([ 'o=<<( ?s ?p ?v )>>' ]);
    });

    it('leaves a shape a position of which nothing reads alone', ({ expect }) => {
      // The line between the two substitutions: coining `?o_p` and `?o_o` is what a *pattern* may do,
      // since it binds them where it writes them, and a re-binding reading them would find them unbound.
      const assertions = <AssertionConjunction> structuralConjunctionOf([ access('s'), assertStrong(subjectOfO) ]);
      expect(substitutionOf(assertions.rebuildingSubstitution())).toEqual([]);
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
    expect(equatedReadingsOf(copy)).toEqual([[ 'x', 'y', 'z' ]]);
    expect(equatedReadingsOf(assertions)).toEqual([[ 'x', 'y' ]]);
  });
});
