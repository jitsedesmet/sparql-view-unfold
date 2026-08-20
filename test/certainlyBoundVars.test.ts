import { describe, it } from 'vitest';
import type { TransformContext } from '../lib/transformContext.js';
import { createPartialContext } from '../lib/transformContext.js';
import { withCpVars } from '../lib/utils/certainlyBoundVars.js';

const c = <TransformContext> createPartialContext();
const x = c.DF.variable('x');
const g = c.DF.variable('g');

/** A one-row VALUES over `?x`, either UNDEF or holding a literal. */
function column(bound: boolean): ReturnType<TransformContext['AF']['createValues']> {
  return c.AF.createValues([ x ], [ bound ? { x: c.DF.literal('l') } : {} ]);
}

/** The term types `?x` can take in `op`, sorted so the assertion does not depend on insertion order. */
function rangeOfX(op: Parameters<typeof withCpVars>[0]): string[] {
  return [ ...withCpVars(op).metadata.vRanges.rangeOf('x') ].sort();
}

describe('withCpVars', () => {
  describe('the range of a merged variable', () => {
    it('intersects the operands that certainly bind it', ({ expect }) => {
      // Both columns are filled, so every solution of the join takes `?x` from both at once.
      expect(rangeOfX(c.AF.createJoin([ column(true), column(true) ], false))).toEqual([ 'Literal' ]);
    });

    it('does not intersect an operand that may leave it unbound', ({ expect }) => {
      // The UNDEF row is a mapping that does not bind `?x`, so it is compatible with the literal one and
      // their merge binds `?x` to it. Intersecting would report `?x` as unbindable, which is a licence to
      // prune the plan - see `AssertionConjunction.normalisedFor`.
      expect(rangeOfX(c.AF.createJoin([ column(false), column(true) ], false))).toEqual([ 'Literal' ]);
    });

    it('lets the right of an OPTIONAL decide what the left does not certainly bind', ({ expect }) => {
      expect(rangeOfX(c.AF.createLeftJoin(column(false), column(true)))).toEqual([ 'Literal' ]);
    });

    it('keeps the left of an OPTIONAL deciding what it certainly binds', ({ expect }) => {
      // `?x ∈ cVars` on the left, so the right can only ever contribute a mapping agreeing with it.
      const left = c.AF.createValues([ x ], [{ x: c.DF.namedNode('ex://c') }]);
      expect(rangeOfX(c.AF.createLeftJoin(left, column(true)))).toEqual([ 'NamedNode' ]);
    });

    it('does not intersect an operand that only *possibly* binds it', ({ expect }) => {
      // The range of `?x` here is non-empty, so `neverBinds` does not catch this one: the row binding it
      // to an IRI is not the only row, and the UNDEF one merges with the literal just as well.
      const possible = c.AF.createValues([ x ], [{ x: c.DF.namedNode('ex://c') }, {}]);
      expect(rangeOfX(c.AF.createJoin([ possible, column(true) ], false))).toEqual([ 'Literal' ]);
    });

    it('is empty where the operands certainly bind it to incompatible types', ({ expect }) => {
      const iri = c.AF.createValues([ x ], [{ x: c.DF.namedNode('ex://c') }]);
      expect(rangeOfX(c.AF.createJoin([ iri, column(true) ], false))).toEqual([]);
    });
  });

  describe('an all-UNDEF column', () => {
    it('is in scope yet never bound, which the scope alone could not say', ({ expect }) => {
      const meta = withCpVars(column(false)).metadata;
      expect(meta.vRanges.has('x')).toBe(true);
      expect(meta.vRanges.neverBinds('x')).toBe(true);
    });
  });
});

/**
 * A triple-term construction is the one term expression that can fail, leaving its target unbound where a
 * component is not a term the position it lands in admits. What decides it is the *range* of the
 * components, so this is the rule the ranges were needed for: a ground construction is infallible by
 * itself, and so is one over a variable that can only take terms the position admits.
 */
describe('the target of a triple-term BIND', () => {
  const t = c.DF.variable('t');
  const ground = c.DF.quad(c.DF.namedNode('ex://a'), c.DF.namedNode('ex://b'), c.DF.namedNode('ex://c'));

  /** Whether `BIND(<<( … )>> AS ?t)` over `input` binds `?t` in every solution. */
  function bindsCertainly(input: Parameters<typeof withCpVars>[0], term: Parameters<typeof c.DF.quad>[2]): boolean {
    const extend = c.AF.createExtend(input, t, c.AF.createTermExpression(term));
    return withCpVars(extend).metadata.cVars.has('t');
  }

  it('is certain for a ground construction, which no range can spoil', ({ expect }) => {
    expect(bindsCertainly(c.AF.createBgp([]), ground)).toBe(true);
  });

  it('is certain for a variable subject a pattern already restricts to a subject', ({ expect }) => {
    // `?x` occurs in a subject position, so it is an IRI or a blank node - every type the subject of the
    // construction admits. Non-ground, and still infallible: this is what reading the ranges buys.
    const pattern = c.AF.createPattern(x, c.DF.namedNode('ex://p'), c.DF.variable('o'));
    expect(bindsCertainly(pattern, c.DF.quad(x, c.DF.namedNode('ex://b'), c.DF.namedNode('ex://c')))).toBe(true);
  });

  it('is uncertain for a subject that may be a literal', ({ expect }) => {
    // The construction is ill-typed for a literal subject, so those solutions leave `?t` unbound.
    expect(bindsCertainly(column(true), c.DF.quad(x, c.DF.namedNode('ex://b'), c.DF.namedNode('ex://c')))).toBe(false);
  });

  it('is uncertain for a component that is not bound at all', ({ expect }) => {
    // The all-UNDEF column has `?x` in scope but never bound, so there is no construction to call
    // infallible - and `cVars` refuses it on top.
    expect(bindsCertainly(column(false), c.DF.quad(x, c.DF.namedNode('ex://b'), c.DF.namedNode('ex://c')))).toBe(false);
  });

  it('is certain for a nested construction, the object position admitting a triple term', ({ expect }) => {
    expect(bindsCertainly(
      c.AF.createBgp([]),
      c.DF.quad(c.DF.namedNode('ex://a'), c.DF.namedNode('ex://b'), ground),
    )).toBe(true);
  });

  it('is uncertain for a quad carrying a graph, which is no triple term', ({ expect }) => {
    // Defensive, and deliberately so. The *type* admits this: `constructionCannotFail` takes an
    // `RDF.BaseQuad`, and an `Algebra.Pattern` is one with its graph slot filled. No parse puts one here
    // - `toAlgebra` with `quads: true` fills the graph of the top-level pattern only, leaving a triple
    // term in its object, and every quad inside a BIND or a FILTER, on the default graph - so the rule
    // states its own precondition instead of resting on that. A triple term has no graph, and
    // `<<( … )>>` cannot construct this, so there is nothing to call infallible however ground it is.
    // The graph is a *name* here rather than a variable on purpose: an unbindable variable would be
    // refused for the ordinary reason, and would say nothing about the graph slot itself.
    const quadPattern = c.AF.createPattern(
      c.DF.namedNode('ex://a'),
      c.DF.namedNode('ex://b'),
      c.DF.namedNode('ex://c'),
      c.DF.namedNode('ex://g1'),
    );
    expect(bindsCertainly(c.AF.createBgp([]), quadPattern)).toBe(false);
  });
});

describe('the range of a graph variable', () => {
  it('is the graph name where the pattern does not certainly bind it', ({ expect }) => {
    // `GRAPH ?g { OPTIONAL { VALUES ?g { "l" } } }`: every solution where the OPTIONAL misses binds `?g`
    // to the name of the graph, so what the pattern says about it never applies on its own.
    const inner = c.AF.createLeftJoin(
      c.AF.createBgp([]),
      c.AF.createValues([ g ], [{ g: c.DF.literal('l') }]),
    );
    const meta = withCpVars(c.AF.createGraph(inner, g)).metadata;
    expect([ ...meta.vRanges.rangeOf('g') ].sort()).toEqual([ 'BlankNode', 'NamedNode' ]);
    // `?g ∈ cVars` and an empty range would be a contradiction the pruning would act on.
    expect(meta.cVars.has('g')).toBe(true);
  });

  it('narrows by what the pattern certainly binds it to', ({ expect }) => {
    const inner = c.AF.createValues([ g ], [{ g: c.DF.namedNode('ex://c') }]);
    const meta = withCpVars(c.AF.createGraph(inner, g)).metadata;
    expect([ ...meta.vRanges.rangeOf('g') ]).toEqual([ 'NamedNode' ]);
  });
});

/**
 * Merging `pVars` into the ranges means a bug in what a rule computes for a *value* comes out as an empty
 * range, which {@link VRanges.neverBinds} then reports as a fact about *binding* - and pruning, (FBndII)
 * and the join licences all act on it. So the pairing to watch is a variable in `cVars` with nowhere to
 * bind: the operation would bind it in every solution and have no term for it to take.
 *
 * That pairing is not an inconsistency - it is the **emptiness oracle**. It says exactly that the
 * operation has no solutions at all, over which both halves hold vacuously. Which makes it the one thing
 * worth pinning in both directions: a rule that produces it for an operation that *does* have solutions
 * deletes them, which is the GRAPH bug above.
 */
describe('the metadata of an operation', () => {
  const iri = c.AF.createValues([ x ], [{ x: c.DF.namedNode('ex://c') }]);
  const literal = column(true);
  const undefCol = column(false);
  const partial = c.AF.createValues([ x ], [{ x: c.DF.namedNode('ex://c') }, {}]);
  const pattern = c.AF.createPattern(x, c.DF.namedNode('ex://p'), c.DF.variable('o'), g);

  /** The variables the metadata says are bound in every solution and bindable to nothing. */
  function unbindableCertainVars(op: Parameters<typeof withCpVars>[0]): string[] {
    const { cVars, vRanges } = withCpVars(op).metadata;
    return [ ...cVars ].filter(variable => vRanges.neverBinds(variable)).sort();
  }

  describe('where it has solutions', () => {
    const shapes: [ string, Parameters<typeof withCpVars>[0] ][] = [
      [ 'a join over an all-UNDEF column', c.AF.createJoin([ undefCol, literal ], false) ],
      [ 'a join over a partly bound column', c.AF.createJoin([ partial, literal ], false) ],
      [ 'an optional over an all-UNDEF left', c.AF.createLeftJoin(undefCol, literal) ],
      [ 'an optional whose sides disagree', c.AF.createLeftJoin(iri, literal) ],
      [ 'a union of disagreeing branches', c.AF.createUnion([ iri, literal ], false) ],
      [ 'a minus of disagreeing sides', c.AF.createMinus(iri, literal) ],
      [ 'a graph over a pattern', c.AF.createGraph(pattern, g) ],
      [ 'a graph over an optional binding its name', c.AF.createGraph(
        c.AF.createLeftJoin(c.AF.createBgp([]), c.AF.createValues([ g ], [{ g: c.DF.literal('l') }])),
        g,
      ) ],
      [ 'a projection over a join', c.AF.createProject(c.AF.createJoin([ undefCol, literal ], false), [ x ]) ],
    ];

    for (const [ name, op ] of shapes) {
      it(`never certainly binds a variable with nowhere to bind: ${name}`, ({ expect }) => {
        expect(unbindableCertainVars(op)).toEqual([]);
      });
    }
  });

  describe('where it has none', () => {
    it('proves a join of operands that certainly disagree empty', ({ expect }) => {
      // No term is both an IRI and a literal, so the join yields nothing - and `?x ∈ cVars` with an empty
      // range is how the metadata says so.
      expect(unbindableCertainVars(c.AF.createJoin([ iri, literal ], false))).toEqual([ 'x' ]);
    });

    it('proves a GRAPH named by something no graph can be named by empty', ({ expect }) => {
      const named = c.AF.createGraph(c.AF.createValues([ g ], [{ g: c.DF.literal('l') }]), g);
      expect(unbindableCertainVars(named)).toEqual([ 'g' ]);
    });
  });
});

describe('the range of a service variable', () => {
  const endpoint = c.DF.namedNode('ex://endpoint');
  const pattern = c.AF.createPattern(x, c.DF.variable('p'), c.DF.variable('o'), c.DF.defaultGraph());

  it('keeps what the pattern says, the endpoint evaluating the same algebra', ({ expect }) => {
    const meta = withCpVars(c.AF.createService(pattern, endpoint, false)).metadata;
    expect([ ...meta.vRanges.rangeOf('p') ]).toEqual([ 'NamedNode' ]);
    expect([ ...meta.vRanges.rangeOf('x') ].sort()).toEqual([ 'BlankNode', 'NamedNode' ]);
  });

  it('takes a variable endpoint for an IRI, which is an assumption and not the spec', ({ expect }) => {
    // See the TODO on `serviceNameRange`: Federated Query §4 is informative and requires nothing.
    const variable = c.DF.variable('e');
    const meta = withCpVars(c.AF.createService(pattern, variable, false)).metadata;
    expect([ ...meta.vRanges.rangeOf('e') ]).toEqual([ 'NamedNode' ]);
  });

  it('narrows rather than overrides where the name occurs in the pattern too', ({ expect }) => {
    // `SERVICE ?e { ?e ?p ?o }`: a subject *and* an endpoint, so it has to satisfy both.
    const variable = c.DF.variable('e');
    const inner = c.AF.createPattern(variable, c.DF.variable('p'), c.DF.variable('o'), c.DF.defaultGraph());
    const meta = withCpVars(c.AF.createService(inner, variable, false)).metadata;
    expect([ ...meta.vRanges.rangeOf('e') ]).toEqual([ 'NamedNode' ]);
  });

  it('leaves the endpoint variable out of cVars, the SERVICE reading it rather than binding it', ({ expect }) => {
    const variable = c.DF.variable('e');
    expect(withCpVars(c.AF.createService(pattern, variable, false)).metadata.cVars.has('e')).toBe(false);
  });

  it('cannot prove a SILENT service empty, a failing one yielding an empty solution', ({ expect }) => {
    // The inner pattern is unsatisfiable, but a SILENT service that fails still produces one solution.
    const impossible = c.AF.createJoin(
      [ c.AF.createValues([ x ], [{ x: c.DF.namedNode('ex://c') }]), column(true) ],
      false,
    );
    const meta = withCpVars(c.AF.createService(impossible, endpoint, true)).metadata;
    expect(meta.vRanges.neverBinds('x')).toBe(true);
    expect(meta.cVars.has('x')).toBe(false);
  });
});
