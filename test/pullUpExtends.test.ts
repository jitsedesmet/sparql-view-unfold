import { toAlgebra, toAst } from '@traqula/algebra-sparql-1-2';
import type { Algebra } from '@traqula/algebra-transformations-1-2';
import { algebraUtils } from '@traqula/algebra-transformations-1-2';
import type { expect as Expect } from 'vitest';
import { describe, it } from 'vitest';
import { EXTENSION_FUNCTION_BNODE } from '../lib/consts.js';
import { pullUpExtends } from '../lib/transformations/pullUpExtends.js';
import { pushDownAssertions } from '../lib/transformations/pushDownAssertions.js';
import type { TransformContext } from '../lib/transformContext.js';
import { createPartialContext, parseQuery } from '../lib/transformContext.js';
import { withCpVars, withoutCpVars } from '../lib/utils/certainlyBoundVars.js';
import { expressionsEqual, isStableExpression } from '../lib/utils/expressionHelpers.js';
import { peelExtends } from '../lib/utils/extendChain.js';

const prefixes = `PREFIX : <ex://>
PREFIX xsd: <http://www.w3.org/2001/XMLSchema#>
`;

describe('pullUpExtends', () => {
  // The pass only uses AF / DF / astTransformer from the context, never the mapping, so a mapping-less
  // partial context is sufficient here - as it is for the pushdown this mirrors.
  const c = <TransformContext> createPartialContext();

  function transform(query: string): string {
    return c.generator.generate(toAst(pullUpExtends(c, parseQuery(c, prefixes + query)))).trim();
  }

  /** The variables bound by the EXTEND chain at the top of an operation, in evaluation order. */
  function bindsAtTopOf(op: Algebra.Operation): string[] {
    return peelExtends(c, op).binds.map(bind => bind.variable.value);
  }

  /** What an operation puts in scope: the variables every solution binds, and what `SELECT *` expands to. */
  function scopeOf(op: Algebra.Operation): { cVars: string[]; pVars: string[] } {
    const { cVars, vRanges } = withCpVars(withoutCpVars(op)).metadata;
    return { cVars: [ ...cVars ].sort(), pVars: [ ...vRanges.keys() ].sort() };
  }

  /** Whether any operation of a tree still carries a cached `CPMeta`. */
  function holdsCachedMetadata(op: Algebra.Operation): boolean {
    let found = false;
    c.astTransformer.visitObject(op, (object) => {
      if ('type' in object && 'metadata' in object) {
        found = true;
      }
      return object;
    });
    return found;
  }

  /**
   * Asserts the rewritten query, and with it the three checks every case owes: the scope invariant, the
   * idempotence of the pass, and the metadata hygiene the licences depend on.
   * @param expect - The assertion API of the running test
   * @param query - The query to rewrite, without its prefixes
   * @param expected - The query the rewrite has to generate
   */
  function expectTransform(expect: typeof Expect, query: string, expected: string): void {
    // The scope invariant is what the string comparison cannot see: a hoist that lost a variable out of
    // `cVars` still prints as a plausible query, and only changes what `SELECT *` returns on data that
    // leaves something unbound.
    const input = parseQuery(c, prefixes + query);
    const output = pullUpExtends(c, input);
    expect(c.generator.generate(toAst(output)).trim()).toEqual(expected.trim());
    expect(scopeOf(output)).toEqual(scopeOf(parseQuery(c, prefixes + query)));
    expect(holdsCachedMetadata(output)).toBe(false);
    // Idempotence: what the pass produced is a fixpoint of it.
    expect(c.generator.generate(toAst(pullUpExtends(c, output))).trim()).toEqual(expected.trim());
  }

  /** Parses a query *without* quads, so that a GRAPH survives as an operation of its own. */
  function parseWithGraphOperation(query: string): Algebra.Operation {
    return toAlgebra(c.parser.parse(prefixes + query), { quads: false, blankToVariable: true });
  }

  /**
   * {@link expectTransform} for a query whose GRAPH has to stay an operation, which is the only way to
   * reach the GRAPH rule - {@link parseQuery} always asks for quads.
   * @param expect - The assertion API of the running test
   * @param query - The query to rewrite, without its prefixes
   * @param expected - The query the rewrite has to generate
   */
  function expectTransformGraphOperation(expect: typeof Expect, query: string, expected: string): void {
    const output = pullUpExtends(c, parseWithGraphOperation(query));
    expect(c.generator.generate(toAst(output)).trim()).toEqual(expected.trim());
    expect(scopeOf(output)).toEqual(scopeOf(parseWithGraphOperation(query)));
    expect(holdsCachedMetadata(output)).toBe(false);
    expect(c.generator.generate(toAst(pullUpExtends(c, output))).trim()).toEqual(expected.trim());
  }

  describe('congruent operations', () => {
    it('rises past a FILTER whose condition does not mention the variable', ({ expect }) => {
      expectTransform(
        expect,
        'SELECT * WHERE { ?s :p ?o BIND(:a AS ?x) FILTER(?o > 2) }',
        `SELECT ?o ?s ( <ex://a> AS ?x ) WHERE {
  ?s <ex://p> ?o .
  FILTER ( ( ?o > "2"^^<http://www.w3.org/2001/XMLSchema#integer> ) )
}`,
      );
    });

    it('rises past a FILTER that reads it, writing the term into the condition', ({ expect }) => {
      expectTransform(
        expect,
        'SELECT * WHERE { ?s :p ?o BIND(:a AS ?x) FILTER(?x = :a) }',
        `SELECT ?o ?s ( <ex://a> AS ?x ) WHERE {
  ?s <ex://p> ?o .
  FILTER ( TRUE )
}`,
      );
    });

    it('folds bound(?x) to true for a certain bind', ({ expect }) => {
      expectTransform(
        expect,
        'SELECT * WHERE { ?s :p ?o BIND(:a AS ?x) FILTER(BOUND(?x)) }',
        `SELECT ?o ?s ( <ex://a> AS ?x ) WHERE {
  ?s <ex://p> ?o .
  FILTER ( TRUE )
}`,
      );
    });

    it('rises past a DISTINCT of a sub-SELECT', ({ expect }) => {
      expectTransform(
        expect,
        'SELECT * WHERE { { SELECT DISTINCT ?s ?x WHERE { ?s :p ?o BIND(:a AS ?x) } } ?s :q ?w }',
        `SELECT ?s ?w ( <ex://a> AS ?x ) WHERE {
  {
    SELECT DISTINCT ?s WHERE {
      ?s <ex://p> ?o .
    }
  }
  ?s <ex://q> ?w .
}`,
      );
    });

    it('rises past a SLICE, which the pushdown may not pass', ({ expect }) => {
      expectTransform(
        expect,
        'SELECT * WHERE { { SELECT ?s ?x WHERE { ?s :p ?o BIND(:a AS ?x) } LIMIT 5 } ?s :q ?w }',
        `SELECT ?s ?w ( <ex://a> AS ?x ) WHERE {
  {
    SELECT ?s WHERE {
      ?s <ex://p> ?o .
    }
    LIMIT 5
  }
  ?s <ex://q> ?w .
}`,
      );
    });

    it('rises past an ORDER BY that does not mention it', ({ expect }) => {
      expectTransform(
        expect,
        'SELECT * WHERE { { SELECT ?s ?x WHERE { ?s :p ?o BIND(:a AS ?x) } ORDER BY ?s } ?s :q ?w }',
        `SELECT ?s ?w ( <ex://a> AS ?x ) WHERE {
  {
    SELECT ?s WHERE {
      ?s <ex://p> ?o .
    }
    ORDER BY ASC ( ?s )
  }
  ?s <ex://q> ?w .
}`,
      );
    });

    it('stops below the query\'s own solution modifiers', ({ expect }) => {
      // The bind rises out of the join, and then stops: SPARQL has nowhere to write a BIND above a SELECT
      // or between it and its ORDER BY and LIMIT, so the sealed chain decides nothing and returns early.
      expectTransform(
        expect,
        'SELECT * WHERE { { ?s :p ?o BIND(:a AS ?x) } { ?a :r ?b } } ORDER BY ?o LIMIT 5',
        `SELECT ?a ?b ?o ?s ( <ex://a> AS ?x ) WHERE {
  ?s <ex://p> ?o .
  ?a <ex://r> ?b .
}
ORDER BY ASC ( ?o )
LIMIT 5`,
      );
    });

    it('rises past a FROM, whose place in a query no parser puts a hoist target above', ({ expect }) => {
      // Built by hand: `FROM` only occurs at the top of a query, where the modifier chain seals it.
      const { AF, DF } = c;
      const scan = AF.createBgp([ AF.createPattern(DF.variable('s'), DF.namedNode('ex://p'), DF.variable('o')) ]);
      const from = AF.createFrom(
        AF.createExtend(scan, DF.variable('x'), AF.createTermExpression(DF.namedNode('ex://a'))),
        [ DF.namedNode('ex://g') ],
        [],
      );
      const other = AF.createBgp([ AF.createPattern(DF.variable('a'), DF.namedNode('ex://q'), DF.variable('b')) ]);
      const result = pullUpExtends(c, AF.createJoin([ from, other ], false));
      expect(bindsAtTopOf(result)).toEqual([ 'x' ]);
      expect(scopeOf(result)).toEqual(scopeOf(AF.createJoin([ from, other ], false)));
    });
  });

  describe('ordering that decides nothing', () => {
    it('drops a comparator over a variable a BIND fixes, and then the bind', ({ expect }) => {
      // `?x` holds one value across the whole sequence, so it compares equal on every pair and decides no
      // ordering. Once the comparator is gone nothing in the ordering reads `?x`, so the bind rises past
      // it - an ordering is not sealed, being below the projection rather than above it - and the
      // projection, which never asked for `?x`, drops it.
      expectTransform(
        expect,
        'SELECT ?s ?p ?o WHERE { ?s ?p ?o . BIND(<ex://a> AS ?x) } ORDER BY ?s ?x ?o',
        `SELECT ?s ?p ?o WHERE {
  ?s ?p ?o .
}
ORDER BY ASC ( ?s ) ASC ( ?o )`,
      );
    });

    it('re-plants a bind the projection does ask for above the ordering', ({ expect }) => {
      // The same rise, with nothing to drop it: `toAst` writes an EXTEND between a PROJECT and its
      // ORDER_BY as a SELECT expression, which is exactly where SPARQL puts one.
      expectTransform(
        expect,
        'SELECT ?s ?x WHERE { ?s :p ?o . BIND(:a AS ?x) } ORDER BY ?s',
        `SELECT ?s ( <ex://a> AS ?x ) WHERE {
  ?s <ex://p> ?o .
}
ORDER BY ASC ( ?s )`,
      );
    });

    it('drops the ordering itself when no comparator decides anything', ({ expect }) => {
      // And then the projection sees an EXTEND chain where it saw an ORDER BY, so the drop rule reaches a
      // bind it could not before - the two rewrites cascade in one post-order pass.
      expectTransform(
        expect,
        'SELECT ?s WHERE { ?s :p ?o . BIND(:a AS ?x) } ORDER BY ?x',
        `SELECT ?s WHERE {
  ?s <ex://p> ?o .
}`,
      );
    });

    it('keeps a comparator over a variable no BIND fixes', ({ expect }) => {
      // The comparator is `?x`, and what decides it is the expression *below*: `RAND()` is unstable, so
      // `?x` holds a different value on every row and the ordering is a real one. Nothing moves either -
      // an unstable expression cannot rise - so this is the untouched tree, printed. `toAst` writes a
      // BIND at the top of a WHERE as a SELECT expression, which is where SPARQL's own algebra puts it
      // (§18.3.4.4 extends before §18.3.5 orders), so the string re-parses to exactly this tree - which
      // means an expected output like this one is no evidence either way. The assertion below is.
      const query = 'SELECT * WHERE { ?s :p ?o . BIND(RAND() AS ?x) } ORDER BY ?x';
      expectTransform(
        expect,
        query,
        `SELECT ?o ?s ( RAND( ) AS ?x ) WHERE {
  ?s <ex://p> ?o .
}
ORDER BY ASC ( ?x )`,
      );
      const result = <Algebra.Project> pullUpExtends(c, parseQuery(c, prefixes + query));
      expect(bindsAtTopOf(result.input)).toEqual([]);
    });

    it('cleans what the substitution made constant', ({ expect }) => {
      // The sub-SELECT is not sealed, so `?x` rises and the comparator over it becomes the term it read -
      // which is then a comparator this can throw away.
      expectTransform(
        expect,
        'SELECT * WHERE { { SELECT ?s ?x WHERE { ?s :p ?o BIND(:a AS ?x) } ORDER BY ?x ?s } ?s :q ?w }',
        `SELECT ?s ?w ( <ex://a> AS ?x ) WHERE {
  {
    SELECT ?s WHERE {
      ?s <ex://p> ?o .
    }
    ORDER BY ASC ( ?s )
  }
  ?s <ex://q> ?w .
}`,
      );
    });
  });

  describe('a named graph', () => {
    // A GRAPH evaluates its pattern against each named graph and joins `{?g ↦ u}` on *outside* it, so `?g`
    // is bound above where the pattern below may leave it unbound.
    it('rises out of a GRAPH when it does not read the graph variable', ({ expect }) => {
      expectTransformGraphOperation(
        expect,
        'SELECT * WHERE { GRAPH ?g { ?s :p ?o BIND(:a AS ?x) } }',
        `SELECT ?g ?o ?s ( <ex://a> AS ?x ) WHERE {
  GRAPH ?g {
    ?s <ex://p> ?o .
  }
}`,
      );
    });

    it('rises when the pattern binds the graph variable certainly', ({ expect }) => {
      // The escape hatch: `?g` reads the same inside as out, because the pattern binds it in every
      // solution, so `e` is asked about the same value either side of the GRAPH.
      expectTransformGraphOperation(
        expect,
        'SELECT * WHERE { GRAPH ?g { ?g :q ?w BIND(?g AS ?x) } }',
        `SELECT ?g ?w ( ?g AS ?x ) WHERE {
  GRAPH ?g {
    ?g <ex://q> ?w .
  }
}`,
      );
    });

    it('stays when it reads a graph variable the pattern does not certainly bind', ({ expect }) => {
      // The OPTIONAL leaves `?g` unbound on the rows it misses, where above the GRAPH it is always the
      // graph name - so the bind would read a different value if it rose.
      expectTransformGraphOperation(
        expect,
        'SELECT * WHERE { GRAPH ?g { { ?s :p ?o } OPTIONAL { ?g :q ?w } BIND(?g AS ?x) } }',
        `SELECT ?g ?o ?s ?w ?x WHERE {
  GRAPH ?g {
    {
      ?s <ex://p> ?o .
      OPTIONAL {
        ?g <ex://q> ?w .
      }
      BIND( ?g AS ?x )
    }
  }
}`,
      );
    });

    it('stays when it writes the graph variable itself', ({ expect }) => {
      // (C1) with the operation as the other binder: the GRAPH puts `?g` in every solution above it.
      // TODO(phase 4): this bind is an *assertion* in disguise and phase 4 should read it as one. `?g` is
      //  unbound inside the pattern, so the join with `{?g ↦ u}` that a GRAPH ends with keeps only the
      //  graph named `:a` - which is to say `Graph(?g, Extend(P, ?g, :a)) ≡ Extend(Graph(:a, P), ?g, :a)`,
      //  turning a scan of every named graph into one graph and letting the bind rise after all.
      expectTransformGraphOperation(
        expect,
        'SELECT * WHERE { GRAPH ?g { ?s :p ?o BIND(:a AS ?g) } }',
        `SELECT ?g ?o ?s WHERE {
  GRAPH ?g {
    {
      ?s <ex://p> ?o .
      BIND( <ex://a> AS ?g )
    }
  }
}`,
      );
    });
  });

  describe('the drop sites', () => {
    it('drops a bind a PROJECT does not project', ({ expect }) => {
      expectTransform(
        expect,
        'SELECT ?y WHERE { ?y :p ?o . BIND(:a AS ?x) }',
        `SELECT ?y WHERE {
  ?y <ex://p> ?o .
}`,
      );
    });

    it('rises out of a sub-SELECT that projects it, striking the column', ({ expect }) => {
      expectTransform(
        expect,
        'SELECT * WHERE { { SELECT ?s ?x WHERE { ?s :p ?o BIND(:a AS ?x) } } ?s :q ?w }',
        `SELECT ?s ?w ( <ex://a> AS ?x ) WHERE {
  {
    SELECT ?s WHERE {
      ?s <ex://p> ?o .
    }
  }
  ?s <ex://q> ?w .
}`,
      );
    });

    it('stays in a sub-SELECT that does not project what the expression reads', ({ expect }) => {
      expectTransform(
        expect,
        'SELECT * WHERE { { SELECT ?s ?x WHERE { ?s :p ?o BIND(?o AS ?x) } } ?s :q ?w }',
        `SELECT ?s ?w ?x WHERE {
  {
    SELECT ?s ( ?o AS ?x ) WHERE {
      ?s <ex://p> ?o .
    }
  }
  ?s <ex://q> ?w .
}`,
      );
    });

    it('drops a bind a GROUP sees in neither its keys nor its aggregates', ({ expect }) => {
      expectTransform(
        expect,
        'SELECT * WHERE { SELECT (COUNT(?o) AS ?n) WHERE { ?s :p ?o BIND(:a AS ?x) } GROUP BY ?s }',
        `SELECT ?n WHERE {
  SELECT ( COUNT( ?o ) AS ?n ) WHERE {
    ?s <ex://p> ?o .
  }
  GROUP BY ?s
}`,
      );
    });

    it('keeps a bind an aggregate expression reads, which is neither a key nor a target', ({ expect }) => {
      expectTransform(
        expect,
        'SELECT * WHERE { SELECT ?s (SUM(?x) AS ?n) WHERE { ?s :p ?o BIND(?o AS ?x) } GROUP BY ?s }',
        `SELECT ?n ?s WHERE {
  SELECT ?s ( SUM( ?x ) AS ?n ) WHERE {
    ?s <ex://p> ?o .
    BIND( ?o AS ?x )
  }
  GROUP BY ?s
}`,
      );
    });

    it('keeps a bind of a grouping key', ({ expect }) => {
      expectTransform(
        expect,
        'SELECT * WHERE { SELECT ?x (COUNT(?o) AS ?n) WHERE { ?s :p ?o BIND(:a AS ?x) } GROUP BY ?x }',
        `SELECT ?n ?x WHERE {
  SELECT ?x ( COUNT( ?o ) AS ?n ) WHERE {
    ?s <ex://p> ?o .
    BIND( <ex://a> AS ?x )
  }
  GROUP BY ?x
}`,
      );
    });
  });

  describe('joins', () => {
    it('rises out of the one operand that binds the variable - the worked example', ({ expect }) => {
      expectTransform(
        expect,
        'SELECT * WHERE { { ?s ?p ?o . BIND(<ex://a> AS ?x) } { ?a ?b ?c } }',
        `SELECT ?a ?b ?c ?o ?p ?s ( <ex://a> AS ?x ) WHERE {
  ?s ?p ?o .
  ?a ?b ?c .
}`,
      );
    });

    it('rises past a sibling that has the variable in scope but never binds it', ({ expect }) => {
      // (C1) is read on the ranges, so an all-UNDEF VALUES column is a legitimate hoist target.
      expectTransform(
        expect,
        'SELECT * WHERE { { ?s :p ?o BIND(:a AS ?x) } { VALUES ?x { UNDEF } ?a :q ?b } }',
        `SELECT ?a ?b ?o ?s ( <ex://a> AS ?x ) WHERE {
  ?s <ex://p> ?o .
  VALUES ?x {
    UNDEF
  }
  ?a <ex://q> ?b .
}`,
      );
    });

    it('stays when a sibling can bind the variable (C1)', ({ expect }) => {
      expectTransform(
        expect,
        'SELECT * WHERE { { ?s :p ?o BIND(:a AS ?x) } { ?a :q ?x } }',
        `SELECT ?a ?o ?s ?x WHERE {
  {
    ?s <ex://p> ?o .
    BIND( <ex://a> AS ?x )
  }
  ?a <ex://q> ?x .
}`,
      );
    });

    it('stays when a non-term expression has a single carrier (the cost gate)', ({ expect }) => {
      expectTransform(
        expect,
        'SELECT * WHERE { { ?s :p ?o BIND(CONCAT(STR(?s), "z") AS ?x) } { ?a :q ?w } }',
        `SELECT ?a ?o ?s ?w ?x WHERE {
  {
    ?s <ex://p> ?o .
    BIND( CONCAT( STR( ?s ) , "z" ) AS ?x )
  }
  ?a <ex://q> ?w .
}`,
      );
    });

    it('deletes the duplicate of a non-term bind but leaves the survivor in place', ({ expect }) => {
      // The copies are provably one value, so one of them is redundant - but hoisting the survivor would
      // trade `|A| + |B|` evaluations for `|A ⋈ B|`, which a join that fans out makes far worse. Deleting
      // the duplicate and leaving the rest alone is the half of that with no downside.
      expectTransform(
        expect,
        `SELECT * WHERE {
          { ?s :p ?o BIND(CONCAT(STR(?s), "z") AS ?x) }
          { ?s :q ?w BIND(CONCAT(STR(?s), "z") AS ?x) }
        }`,
        `SELECT ?o ?s ?w ?x WHERE {
  {
    ?s <ex://p> ?o .
    BIND( CONCAT( STR( ?s ) , "z" ) AS ?x )
  }
  ?s <ex://q> ?w .
}`,
      );
    });

    it('hoists the survivor when re-evaluating it is free', ({ expect }) => {
      // A construction costs nothing to ask again, so there is no cardinality bet to lose and the
      // survivor goes all the way up.
      expectTransform(
        expect,
        `SELECT * WHERE {
          { ?s :p ?o BIND(<<( ?s :q ?s )>> AS ?x) }
          { ?s :r ?w BIND(<<( ?s :q ?s )>> AS ?x) }
        }`,
        `SELECT ?o ?s ?w ( <<( ?s <ex://q> ?s )>> AS ?x ) WHERE {
  ?s <ex://p> ?o .
  ?s <ex://r> ?w .
}`,
      );
    });

    it('merges two carriers of one ground bind', ({ expect }) => {
      expectTransform(
        expect,
        'SELECT * WHERE { { ?s :p ?o BIND(:a AS ?x) } { ?s :q ?w BIND(:a AS ?x) } }',
        `SELECT ?o ?s ?w ( <ex://a> AS ?x ) WHERE {
  ?s <ex://p> ?o .
  ?s <ex://q> ?w .
}`,
      );
    });

    it('does not merge when a carrier does not certainly bind what the expression reads', ({ expect }) => {
      // `?o` is bound in the first operand and nowhere in the second, so the two copies of the bind are
      // not the same value and the compatibility test on `?x` is not a tautology.
      expectTransform(
        expect,
        `SELECT * WHERE {
          { ?s :p ?o BIND(CONCAT(STR(?o), "z") AS ?x) }
          { ?s :q ?w BIND(CONCAT(STR(?o), "z") AS ?x) }
        }`,
        `SELECT ?o ?s ?w ?x WHERE {
  {
    ?s <ex://p> ?o .
    BIND( CONCAT( STR( ?o ) , "z" ) AS ?x )
  }
  {
    ?s <ex://q> ?w .
    BIND( CONCAT( STR( ?o ) , "z" ) AS ?x )
  }
}`,
      );
    });
  });

  describe('triple term constructions', () => {
    // `<<( s p o )>>` and `TRIPLE(s, p, o)` are one construction the parser keeps as two shapes - a term
    // expression holding a Quad, and an operator expression - so every rule that asks "is this a term"
    // has to read through {@link constructedTermOf} or the two spellings get different answers.
    it('rises past a join for either spelling of the construction', ({ expect }) => {
      const built = 'SELECT * WHERE { { ?s :p ?o BIND(%s AS ?x) } { ?a :r ?b } }';
      const expected = `SELECT ?a ?b ?o ?s ( %s AS ?x ) WHERE {
  ?s <ex://p> ?o .
  ?a <ex://r> ?b .
}`;
      expectTransform(
        expect,
        built.replace('%s', '<<( ?s :q ?o )>>'),
        expected.replace('%s', '<<( ?s <ex://q> ?o )>>'),
      );
      expectTransform(
        expect,
        built.replace('%s', 'TRIPLE(?s, :q, ?o)'),
        expected.replace('%s', 'TRIPLE( ?s , <ex://q> , ?o )'),
      );
    });

    it('reads a position out of the construction it wrote in', ({ expect }) => {
      // `SUBJECT(?x)` of a construction that cannot fail is the component itself, so the reader is left
      // with the variable rather than with an accessor over a triple term it has to build first.
      expectTransform(
        expect,
        'SELECT * WHERE { ?s :p ?o BIND(<<( ?s :q ?o )>> AS ?x) FILTER(SUBJECT(?x) = :a) }',
        `SELECT ?o ?s ( <<( ?s <ex://q> ?o )>> AS ?x ) WHERE {
  ?s <ex://p> ?o .
  FILTER ( SAMETERM( ?s , <ex://a> ) )
}`,
      );
    });

    it('reads through a nested position', ({ expect }) => {
      expectTransform(
        expect,
        `SELECT * WHERE {
          ?s :p ?o BIND(<<( ?s :q <<( ?s :r ?s )>> )>> AS ?x) FILTER(SUBJECT(OBJECT(?x)) = :a)
        }`,
        `SELECT ?o ?s ( <<( ?s <ex://q> <<( ?s <ex://r> ?s )>> )>> AS ?x ) WHERE {
  ?s <ex://p> ?o .
  FILTER ( SAMETERM( ?s , <ex://a> ) )
}`,
      );
    });

    it('writes the whole term in when the construction can fail', ({ expect }) => {
      // `?o` occupies the subject position, and an object may be a literal, so the construction may raise
      // and leave `?x` unbound - where `SUBJECT(?x)` is an error and the component would not be.
      expectTransform(
        expect,
        'SELECT * WHERE { ?s :p ?o BIND(<<( ?o :q ?s )>> AS ?x) FILTER(SUBJECT(?x) = :a) }',
        `SELECT ?o ?s ( <<( ?o <ex://q> ?s )>> AS ?x ) WHERE {
  ?s <ex://p> ?o .
  FILTER ( SAMETERM( SUBJECT( <<( ?o <ex://q> ?s )>> ) , <ex://a> ) )
}`,
      );
    });

    it('leaves a TRIPLE() no triple term could spell', ({ expect }) => {
      // A literal cannot be a subject, so this raises rather than constructing - and there is no
      // `<<( … )>>` for it, so it stays an operator expression and the cost gate keeps it put.
      expectTransform(
        expect,
        'SELECT * WHERE { { ?s :p ?o BIND(TRIPLE("lit", :q, ?o) AS ?x) } { ?a :r ?b } }',
        `SELECT ?a ?b ?o ?s ?x WHERE {
  {
    ?s <ex://p> ?o .
    BIND( TRIPLE( "lit" , <ex://q> , ?o ) AS ?x )
  }
  ?a <ex://r> ?b .
}`,
      );
    });
  });

  describe('optionals, minus and unions', () => {
    it('rises out of the left of an OPTIONAL', ({ expect }) => {
      expectTransform(
        expect,
        'SELECT * WHERE { { ?s :p ?o BIND(:a AS ?x) } OPTIONAL { ?a :q ?b } }',
        `SELECT ?a ?b ?o ?s ( <ex://a> AS ?x ) WHERE {
  ?s <ex://p> ?o .
  OPTIONAL {
    ?a <ex://q> ?b .
  }
}`,
      );
    });

    it('writes the term into the condition of the OPTIONAL it rises past', ({ expect }) => {
      expectTransform(
        expect,
        'SELECT * WHERE { { ?s :p ?o BIND(:a AS ?x) } OPTIONAL { ?s :q ?w FILTER(?x = :a) } }',
        `SELECT ?o ?s ?w ( <ex://a> AS ?x ) WHERE {
  ?s <ex://p> ?o .
  OPTIONAL {
    ?s <ex://q> ?w .
    FILTER ( TRUE )
  }
}`,
      );
    });

    it('never rises out of the right of an OPTIONAL', ({ expect }) => {
      expectTransform(
        expect,
        'SELECT * WHERE { ?s :p ?o OPTIONAL { ?a :q ?b BIND(:a AS ?x) } }',
        `SELECT ?a ?b ?o ?s ?x WHERE {
  ?s <ex://p> ?o .
  OPTIONAL {
    {
      ?a <ex://q> ?b .
      BIND( <ex://a> AS ?x )
    }
  }
}`,
      );
    });

    it('rises out of the left of a MINUS', ({ expect }) => {
      expectTransform(
        expect,
        'SELECT * WHERE { { ?s :p ?o BIND(:a AS ?x) } MINUS { ?a :q ?b } }',
        `SELECT ?o ?s ( <ex://a> AS ?x ) WHERE {
  ?s <ex://p> ?o .
  MINUS {
    ?a <ex://q> ?b .
  }
}`,
      );
    });

    it('stays on the left of a MINUS whose right can bind the variable', ({ expect }) => {
      // `?x` is in both the compatibility and the domain-disjointness test, neither of which the hoisted
      // bind would be above.
      expectTransform(
        expect,
        'SELECT * WHERE { { ?s :p ?o BIND(:a AS ?x) } MINUS { ?a :q ?x } }',
        `SELECT ?o ?s ?x WHERE {
  {
    ?s <ex://p> ?o .
    BIND( <ex://a> AS ?x )
  }
  MINUS {
    ?a <ex://q> ?x .
  }
}`,
      );
    });

    it('never rises out of the right of a MINUS', ({ expect }) => {
      expectTransform(
        expect,
        'SELECT * WHERE { ?s :p ?o MINUS { ?s :q ?w BIND(:a AS ?x) } }',
        `SELECT ?o ?s WHERE {
  ?s <ex://p> ?o .
  MINUS {
    {
      ?s <ex://q> ?w .
      BIND( <ex://a> AS ?x )
    }
  }
}`,
      );
    });

    it('hoists out of a UNION every branch of which carries the same bind', ({ expect }) => {
      expectTransform(
        expect,
        'SELECT * WHERE { { ?s :p ?o BIND(:a AS ?x) } UNION { ?s :q ?o BIND(:a AS ?x) } }',
        `SELECT ?o ?s ( <ex://a> AS ?x ) WHERE {
  {
    ?s <ex://p> ?o .
  }
  UNION {
    ?s <ex://q> ?o .
  }
}`,
      );
    });

    it('hoists out of a three-branch UNION', ({ expect }) => {
      expectTransform(
        expect,
        `SELECT * WHERE {
          { ?s :p ?o BIND(:a AS ?x) } UNION { ?s :q ?o BIND(:a AS ?x) } UNION { ?s :r ?o BIND(:a AS ?x) }
        }`,
        `SELECT ?o ?s ( <ex://a> AS ?x ) WHERE {
  {
    ?s <ex://p> ?o .
  }
  UNION {
    ?s <ex://q> ?o .
  }
  UNION {
    ?s <ex://r> ?o .
  }
}`,
      );
    });

    it('leaves a UNION whose branches bind the variable to different terms', ({ expect }) => {
      expectTransform(
        expect,
        'SELECT * WHERE { { ?s :p ?o BIND(:a AS ?x) } UNION { ?s :q ?o BIND(:b AS ?x) } }',
        `SELECT ?o ?s ?x WHERE {
  {
    ?s <ex://p> ?o .
    BIND( <ex://a> AS ?x )
  }
  UNION {
    ?s <ex://q> ?o .
    BIND( <ex://b> AS ?x )
  }
}`,
      );
    });

    it('leaves a UNION one branch of which does not carry the bind', ({ expect }) => {
      expectTransform(
        expect,
        'SELECT * WHERE { { ?s :p ?o BIND(:a AS ?x) } UNION { ?s :q ?o } }',
        `SELECT ?o ?s ?x WHERE {
  {
    ?s <ex://p> ?o .
    BIND( <ex://a> AS ?x )
  }
  UNION {
    ?s <ex://q> ?o .
  }
}`,
      );
    });
  });

  describe('barriers', () => {
    it('leaves an unstable expression where it is', ({ expect }) => {
      expectTransform(
        expect,
        'SELECT * WHERE { { ?s :p ?o BIND(RAND() AS ?x) } { ?a :q ?b } }',
        `SELECT ?a ?b ?o ?s ?x WHERE {
  {
    ?s <ex://p> ?o .
    BIND( RAND( ) AS ?x )
  }
  ?a <ex://q> ?b .
}`,
      );
    });

    it('leaves a bind a FILTER reads through a non-term expression', ({ expect }) => {
      expectTransform(
        expect,
        'SELECT * WHERE { ?s :p ?o BIND(CONCAT(STR(?o), "z") AS ?x) FILTER(?x = "q") }',
        `SELECT ?o ?s ?x WHERE {
  {
    ?s <ex://p> ?o .
    BIND( CONCAT( STR( ?o ) , "z" ) AS ?x )
  }
  FILTER ( ( ?x = "q" ) )
}`,
      );
    });

    it('rises past a FILTER whose EXISTS does not read the variable', ({ expect }) => {
      // The nested pattern is evaluated against a solution mapping that does not hold `?x` either way, so
      // nothing about the EXISTS changes. What stays forbidden is *writing* into one, below.
      expectTransform(
        expect,
        'SELECT * WHERE { { ?s :p ?o BIND(:a AS ?x) FILTER(EXISTS { ?s :q ?z }) } { ?a :q ?b } }',
        `SELECT ?a ?b ?o ?s ( <ex://a> AS ?x ) WHERE {
  {
    ?s <ex://p> ?o .
    FILTER ( EXISTS {
      ?s <ex://q> ?z .
    }
    )
  }
  ?a <ex://q> ?b .
}`,
      );
    });

    it('is a barrier at a FILTER whose EXISTS reads the variable', ({ expect }) => {
      // A term may not be written into a nested pattern: an unbound `?x` there is a variable matching
      // anything, where the term it would be replaced by matches one thing.
      expectTransform(
        expect,
        'SELECT * WHERE { { ?s :p ?o BIND(:a AS ?x) FILTER(EXISTS { ?s :q ?x }) } { ?a :q ?b } }',
        `SELECT ?a ?b ?o ?s ?x WHERE {
  {
    {
      ?s <ex://p> ?o .
      BIND( <ex://a> AS ?x )
    }
    FILTER ( EXISTS {
      ?s <ex://q> ?x .
    }
    )
  }
  ?a <ex://q> ?b .
}`,
      );
    });

    it('blocks a hoist past bound(?x) when the bind is not certain', ({ expect }) => {
      // `?z` is only bound where the OPTIONAL matched, so `?x` is uncertain and `bound(?x)` cannot fold:
      // writing the term in would emit the ungrammatical `bound(<ex://a>)`.
      expectTransform(
        expect,
        'SELECT * WHERE { ?s :p ?o OPTIONAL { ?s :q ?z } BIND(?z AS ?x) FILTER(BOUND(?x)) }',
        `SELECT ?o ?s ?x ?z WHERE {
  {
    ?s <ex://p> ?o .
    OPTIONAL {
      ?s <ex://q> ?z .
    }
    BIND( ?z AS ?x )
  }
  FILTER ( BOUND( ?x ) )
}`,
      );
    });

    it('is a barrier at a SERVICE', ({ expect }) => {
      expectTransform(
        expect,
        'SELECT * WHERE { { SERVICE <ex://e> { ?s :p ?o BIND(:a AS ?x) } } { ?a :q ?b } }',
        `SELECT ?a ?b ?o ?s ?x WHERE {
  SERVICE <ex://e> {
    {
      ?s <ex://p> ?o .
      BIND( <ex://a> AS ?x )
    }
  }
  ?a <ex://q> ?b .
}`,
      );
    });
  });

  describe('order within a chain', () => {
    it('writes a risen term into the bind that stays above it', ({ expect }) => {
      expectTransform(
        expect,
        'SELECT * WHERE { { ?s :p ?o BIND(:a AS ?x) BIND(CONCAT(STR(?x), STR(RAND())) AS ?y) } { ?a :q ?b } }',
        `SELECT ?a ?b ?o ?s ( <ex://a> AS ?x ) ?y WHERE {
  {
    ?s <ex://p> ?o .
    BIND( CONCAT( STR( <ex://a> ) , STR( RAND( ) ) ) AS ?y )
  }
  ?a <ex://q> ?b .
}`,
      );
    });

    it('pins a riser the bind above it reads but cannot take the value of', ({ expect }) => {
      // `?x` is not a term expression, so it cannot be written into `?y`; and `?y` is unstable, so it
      // cannot follow `?x` up. The only partition left is both staying.
      expectTransform(
        expect,
        `SELECT * WHERE {
          ?s :p ?o
          BIND(CONCAT(STR(?o), "z") AS ?x)
          BIND(CONCAT(STR(?x), STR(RAND())) AS ?y)
          FILTER(?o > 2)
        }`,
        `SELECT ?o ?s ?x ?y WHERE {
  {
    ?s <ex://p> ?o .
    BIND( CONCAT( STR( ?o ) , "z" ) AS ?x )
    BIND( CONCAT( STR( ?x ) , STR( RAND( ) ) ) AS ?y )
  }
  FILTER ( ( ?o > "2"^^<http://www.w3.org/2001/XMLSchema#integer> ) )
}`,
      );
    });
  });

  describe('discipline', () => {
    it('leaves the input tree untouched', ({ expect }) => {
      const algebra = parseQuery(c, `${prefixes}SELECT * WHERE {
        { ?s :p ?o BIND(:a AS ?x) } { ?a :q ?b } FILTER(?x = :a)
      }`);
      const before = JSON.stringify(algebraUtils.objectify(algebra));
      pullUpExtends(c, algebra);
      expect(JSON.stringify(algebraUtils.objectify(algebra))).toEqual(before);
    });

    it('does not oscillate against the assertion pushdown', ({ expect }) => {
      const query = `${prefixes}SELECT * WHERE {
        { ?s :p ?o } { ?s :q ?w } FILTER(sameTerm(?s, :a))
      }`;
      const once = pullUpExtends(c, pushDownAssertions(c, parseQuery(c, query)));
      const twice = pullUpExtends(c, pushDownAssertions(c, once));
      const thrice = pullUpExtends(c, pushDownAssertions(c, twice));
      const generated = (op: Algebra.Operation): string => c.generator.generate(toAst(op)).trim();
      expect(generated(twice)).toEqual(generated(once));
      expect(generated(thrice)).toEqual(generated(once));
    });
  });

  describe('isStableExpression', () => {
    const { AF, DF } = c;

    it('accepts NOW, which one query execution answers once', ({ expect }) => {
      expect(isStableExpression(c, AF.createOperatorExpression('now', []))).toBe(true);
    });

    it('accepts an expression over variables', ({ expect }) => {
      expect(isStableExpression(c, AF.createOperatorExpression('str', [
        AF.createTermExpression(DF.variable('s')),
      ]))).toBe(true);
    });

    for (const operator of [ 'rand', 'uuid', 'struuid', 'bnode' ]) {
      it(`rejects ${operator.toUpperCase()}`, ({ expect }) => {
        expect(isStableExpression(c, AF.createOperatorExpression('concat', [
          AF.createTermExpression(DF.literal('a')),
          AF.createOperatorExpression(operator, []),
        ]))).toBe(false);
      });
    }

    it('accepts the one allowlisted extension function', ({ expect }) => {
      expect(isStableExpression(c, AF.createNamedExpression(DF.namedNode(EXTENSION_FUNCTION_BNODE), [
        AF.createTermExpression(DF.variable('s')),
      ]))).toBe(true);
    });

    it('rejects an extension function nothing declares stable', ({ expect }) => {
      expect(isStableExpression(c, AF.createNamedExpression(DF.namedNode('ex://f'), []))).toBe(false);
    });

    it('rejects an EXISTS', ({ expect }) => {
      expect(isStableExpression(c, AF.createExistenceExpression(false, AF.createBgp([])))).toBe(false);
    });

    it('rejects an aggregate', ({ expect }) => {
      expect(isStableExpression(c, AF.createAggregateExpression(
        'sum',
        AF.createTermExpression(DF.variable('o')),
        false,
      ))).toBe(false);
    });
  });

  describe('expressionsEqual', () => {
    const { AF, DF } = c;

    it('is true of two spellings of one term expression', ({ expect }) => {
      expect(expressionsEqual(
        AF.createTermExpression(DF.namedNode('ex://a')),
        AF.createTermExpression(DF.namedNode('ex://a')),
      )).toBe(true);
    });

    it('is false of two different terms', ({ expect }) => {
      expect(expressionsEqual(
        AF.createTermExpression(DF.namedNode('ex://a')),
        AF.createTermExpression(DF.namedNode('ex://b')),
      )).toBe(false);
    });

    it('compares operator arguments pairwise and in order', ({ expect }) => {
      const arguments_ = [ DF.variable('s'), DF.literal('z') ].map(term => AF.createTermExpression(term));
      expect(expressionsEqual(
        AF.createOperatorExpression('concat', arguments_),
        AF.createOperatorExpression('concat', [ ...arguments_ ]),
      )).toBe(true);
      expect(expressionsEqual(
        AF.createOperatorExpression('concat', arguments_),
        AF.createOperatorExpression('concat', [ ...arguments_ ].reverse()),
      )).toBe(false);
    });

    it('is false across sub-types and across operators', ({ expect }) => {
      expect(expressionsEqual(
        AF.createOperatorExpression('str', [ AF.createTermExpression(DF.variable('s')) ]),
        AF.createTermExpression(DF.variable('s')),
      )).toBe(false);
      expect(expressionsEqual(
        AF.createOperatorExpression('str', [ AF.createTermExpression(DF.variable('s')) ]),
        AF.createOperatorExpression('ucase', [ AF.createTermExpression(DF.variable('s')) ]),
      )).toBe(false);
    });

    it('compares the name of an extension function', ({ expect }) => {
      expect(expressionsEqual(
        AF.createNamedExpression(DF.namedNode('ex://f'), []),
        AF.createNamedExpression(DF.namedNode('ex://f'), []),
      )).toBe(true);
      expect(expressionsEqual(
        AF.createNamedExpression(DF.namedNode('ex://f'), []),
        AF.createNamedExpression(DF.namedNode('ex://g'), []),
      )).toBe(false);
    });

    it('never walks into an EXISTS, so two of them are never equal', ({ expect }) => {
      const exists = (): Algebra.Expression => AF.createExistenceExpression(false, AF.createBgp([]));
      expect(expressionsEqual(exists(), exists())).toBe(false);
    });
  });

  it('transforms the query the design opens with', ({ expect }) => {
    expect(transform('SELECT * { { ?s ?p ?o . BIND(<ex://a> AS ?x) } { ?a ?b ?c } }')).toEqual(
      `SELECT ?a ?b ?c ?o ?p ?s ( <ex://a> AS ?x ) WHERE {
  ?s ?p ?o .
  ?a ?b ?c .
}`,
    );
  });
});
