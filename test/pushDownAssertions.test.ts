import { QueryEngine } from '@comunica/query-sparql-file';
import { toAlgebra, toAst } from '@traqula/algebra-sparql-1-2';
import type { Algebra as AlgebraTypes } from '@traqula/algebra-transformations-1-2';
import * as arrayifyStreamNS from 'arrayify-stream';
import type { expect as Expect } from 'vitest';
import { describe, it } from 'vitest';
import { transformFilterFalse } from '../lib/transformations/filterFalse.js';
import { pushDownAssertions } from '../lib/transformations/pushDownAssertions.js';
import type { TransformContext } from '../lib/transformContext.js';
import { createPartialContext, parseQuery } from '../lib/transformContext.js';

// Crazy workaround to support both CJS and ESM
const arrayifyStream =
  (<any> arrayifyStreamNS).default ?? arrayifyStreamNS;

const prefixes = `PREFIX : <ex://>
PREFIX xsd: <http://www.w3.org/2001/XMLSchema#>
`;

describe('pushDownAssertions', () => {
  // PushDownAssertions only uses AF / DF / astTransformer / generator from the context, never the
  // mapping, so a mapping-less partial context is sufficient here.
  const c = <TransformContext> createPartialContext();

  function transform(query: string): string {
    const transformed = pushDownAssertions(c, parseQuery(c, prefixes + query));
    return c.generator.generate(toAst(transformed)).trim();
  }

  /** Runs the FILTER(FALSE) normalisation of the design's normalisation pass on top of the pushdown. */
  function transformAndNormalise(query: string): string {
    const pushed = pushDownAssertions(c, parseQuery(c, prefixes + query));
    return c.generator.generate(toAst(transformFilterFalse(c, pushed))).trim();
  }

  function expectTransform(expect: typeof Expect, query: string, expected: string): void {
    expect(transform(query)).toEqual(expected.trim());
  }

  /**
   * Transforms a query parsed *without* quads, so that a GRAPH survives as an operation of its own
   * rather than as the graph component of every pattern below it - the only way to reach the GRAPH
   * rule, since {@link parseQuery} always asks for quads.
   */
  function transformGraphOperation(query: string): string {
    const parsed = toAlgebra(c.parser.parse(prefixes + query), { quads: false, blankToVariable: true });
    return c.generator.generate(toAst(pushDownAssertions(c, parsed))).trim();
  }

  function expectTransformGraphOperation(expect: typeof Expect, query: string, expected: string): void {
    expect(transformGraphOperation(query)).toEqual(expected.trim());
  }

  describe('base cases', () => {
    it('substitutes the term into a BGP and re-binds the variable', ({ expect }) => {
      expectTransform(
        expect,
        'SELECT * WHERE { ?x :p ?y . ?y :q ?z FILTER(sameTerm(?x, :c)) }',
        `SELECT ( <ex://c> AS ?x ) ?y ?z WHERE {
  <ex://c> <ex://p> ?y .
  ?y <ex://q> ?z .
}`,
      );
    });

    it('empties a BGP that would need a literal in the subject position', ({ expect }) => {
      expectTransform(
        expect,
        'SELECT * WHERE { ?x :p ?y FILTER(sameTerm(?x, "lit")) }',
        `SELECT ?x ?y WHERE {
  ?x <ex://p> ?y .
  FILTER ( FALSE )
}`,
      );
    });

    it('substitutes the exact term, keeping a non-canonical lexical form (sameTerm, not =)', ({ expect }) => {
      expectTransform(
        expect,
        'SELECT * WHERE { ?s :p ?x FILTER(sameTerm(?x, "01"^^xsd:integer)) }',
        `SELECT ?s ( "01"^^<http://www.w3.org/2001/XMLSchema#integer> AS ?x ) WHERE {
  ?s <ex://p> "01"^^<http://www.w3.org/2001/XMLSchema#integer> .
}`,
      );
    });

    it('substitutes into a property path', ({ expect }) => {
      expectTransform(
        expect,
        'SELECT * WHERE { ?x :step* ?y FILTER(sameTerm(?x, :a)) }',
        `SELECT ( <ex://a> AS ?x ) ?y WHERE {
  <ex://a> (<ex://step>*) ?y .
}`,
      );
    });

    it('drops the VALUES rows that contradict the assertion, UNDEF included', ({ expect }) => {
      expectTransform(
        expect,
        'SELECT * WHERE { VALUES (?x ?y) { (:c :a) (UNDEF :b) (:d :e) } FILTER(sameTerm(?x, :c)) }',
        `SELECT ( <ex://c> AS ?x ) ?y WHERE {
  VALUES ?y {
    <ex://a>
  }
}`,
      );
    });

    it('replaces a VALUES the assertions leave one empty row of by the empty BGP', ({ expect }) => {
      expectTransform(
        expect,
        'SELECT * WHERE { VALUES (?x) { (:c) (:d) } FILTER(sameTerm(?x, :c)) }',
        `SELECT ( <ex://c> AS ?x ) WHERE {
}`,
      );
    });

    it('keeps a VALUES the assertions leave several empty rows of, one solution per row', ({ expect }) => {
      // `VALUES () { () () }` is two empty solution mappings, which the empty BGP cannot express.
      expectTransform(
        expect,
        'SELECT * WHERE { VALUES (?x) { (:c) (:c) (:d) } FILTER(sameTerm(?x, :c)) }',
        `SELECT ( <ex://c> AS ?x ) WHERE {
  VALUES( ){
    ( )
    ( )
  }
}`,
      );
    });

    it('empties a VALUES no row of which satisfies the assertion', ({ expect }) => {
      expectTransform(
        expect,
        'SELECT * WHERE { VALUES (?x ?y) { (:d :e) } FILTER(sameTerm(?x, :c)) }',
        `SELECT ?x ?y WHERE {
  VALUES( ?x ?y ){
    ( <ex://d> <ex://e> )
  }
  FILTER ( FALSE )
}`,
      );
    });
  });

  describe('structural rules', () => {
    it('sends the assertion into both UNION branches, emptying the one that cannot bind it', ({ expect }) => {
      // The worked example of the design: `?x ∉ cVars(A₁)` fails the first disjunct of L, but
      // `?x ∉ pVars(A₂)` holds, so the assertion gets below the join and (FUPush) reaches the branches.
      expectTransform(
        expect,
        `SELECT * WHERE {
          { { ?x :p ?y } UNION { ?z :q ?w } }
          { SELECT ?a ?b WHERE { ?a :r ?b } }
          FILTER(sameTerm(?x, :c))
        }`,
        `SELECT ?a ?b ?w ?x ?y ?z WHERE {
  {
    <ex://c> <ex://p> ?y .
    BIND( <ex://c> AS ?x )
  }
  UNION {
    ?z <ex://q> ?w .
    FILTER ( FALSE )
  }
  {
    SELECT ?a ?b WHERE {
      ?a <ex://r> ?b .
    }
  }
}`,
      );
    });

    it('normalises the emptied UNION branch away', ({ expect }) => {
      expect(transformAndNormalise(`SELECT * WHERE {
        { { ?x :p ?y } UNION { ?z :q ?w } }
        { SELECT ?a ?b WHERE { ?a :r ?b } }
        FILTER(sameTerm(?x, :c))
      }`)).toEqual(`SELECT ?a ?b ?w ?x ?y ?z WHERE {
  {
    <ex://c> <ex://p> ?y .
    BIND( <ex://c> AS ?x )
  }
  {
    SELECT ?a ?b WHERE {
      ?a <ex://r> ?b .
    }
  }
}`);
    });

    it('replicates the assertion into both sides of a join that both bind it certainly', ({ expect }) => {
      expectTransform(
        expect,
        'SELECT * WHERE { { ?x :p ?y } { ?x :q ?z } FILTER(sameTerm(?x, :c)) }',
        `SELECT ( <ex://c> AS ?x ) ?y ?z WHERE {
  <ex://c> <ex://p> ?y .
  <ex://c> <ex://q> ?z .
}`,
      );
    });

    it('turns an OPTIONAL over an optional-only variable into a plain join', ({ expect }) => {
      const result = transform('SELECT * WHERE { ?s :p ?o OPTIONAL { ?s :q ?x } FILTER(sameTerm(?x, :c)) }');
      expect(result).toEqual(`SELECT ?o ?s ( <ex://c> AS ?x ) WHERE {
  ?s <ex://p> ?o .
  ?s <ex://q> <ex://c> .
}`);
      expect(result).not.toContain('OPTIONAL');
    });

    it('keeps the MINUS and prunes its right hand side only weakly', ({ expect }) => {
      // The right hand side may not take the strong assertion: `∖` is anti-monotone in it, so the row
      // binding no ?x at all has to stay, and the whole MINUS has to stay.
      expectTransform(
        expect,
        `SELECT * WHERE {
          ?x :p ?y
          MINUS { VALUES (?x ?y) { (:c :a) (UNDEF :b) (:d :e) } }
          FILTER(sameTerm(?x, :c))
        }`,
        `SELECT ?x ?y WHERE {
  {
    <ex://c> <ex://p> ?y .
    BIND( <ex://c> AS ?x )
  }
  MINUS {
    VALUES( ?x ?y ){
      ( <ex://c> <ex://a> )
      ( UNDEF <ex://b> )
    }
  }
}`,
      );
    });

    it('leaves a MINUS right hand side that cannot bind the variable alone', ({ expect }) => {
      expectTransform(
        expect,
        'SELECT * WHERE { ?x :p ?y MINUS { ?z :q ?y } FILTER(sameTerm(?x, :c)) }',
        `SELECT ?x ?y WHERE {
  {
    <ex://c> <ex://p> ?y .
    BIND( <ex://c> AS ?x )
  }
  MINUS {
    ?z <ex://q> ?y .
  }
}`,
      );
    });

    it('prunes a MINUS right hand side that binds the asserted variable certainly', ({ expect }) => {
      // Only the weak form enters the right hand side, but `?y ∈ cVars` there promotes it back to the
      // strong one - and that is sound for the very reason the weak form was sent in: every surviving
      // left hand side mapping binds ?y to :c, so a right hand side mapping binding it to anything else
      // is incompatible with all of them and never removed anything.
      expectTransform(
        expect,
        'SELECT * WHERE { ?x :p ?y MINUS { ?z :q ?y } FILTER(sameTerm(?y, :c)) }',
        `SELECT ?x ?y WHERE {
  {
    ?x <ex://p> <ex://c> .
    BIND( <ex://c> AS ?y )
  }
  MINUS {
    {
      ?z <ex://q> <ex://c> .
      BIND( <ex://c> AS ?y )
    }
  }
}`,
      );
    });

    it('collapses the weak assertion per branch inside a MINUS right hand side', ({ expect }) => {
      // W becomes the strong assertion in the branch that certainly binds ?x, and `true` - dropped,
      // never empty - in the branch that cannot bind it at all.
      expectTransform(
        expect,
        `SELECT * WHERE {
          ?x :p ?y
          MINUS { { ?x :q ?y } UNION { ?z :r ?y } }
          FILTER(sameTerm(?x, :c))
        }`,
        `SELECT ?x ?y WHERE {
  {
    <ex://c> <ex://p> ?y .
    BIND( <ex://c> AS ?x )
  }
  MINUS {
    {
      <ex://c> <ex://q> ?y .
      BIND( <ex://c> AS ?x )
    }
    UNION {
      ?z <ex://r> ?y .
    }
  }
}`,
      );
    });

    it('keeps the weak assertion above an OPTIONAL inside a MINUS right hand side', ({ expect }) => {
      // ?x is possible but not certain there, and pushing W into the right argument of a left join is
      // unsound, so it stays on top of it in its weak form.
      expectTransform(
        expect,
        `SELECT * WHERE {
          ?x :p ?y
          MINUS { ?y :s ?w OPTIONAL { ?y :q ?x } }
          FILTER(sameTerm(?x, :c))
        }`,
        `SELECT ?x ?y WHERE {
  {
    <ex://c> <ex://p> ?y .
    BIND( <ex://c> AS ?x )
  }
  MINUS {
    {
      ?y <ex://s> ?w .
      OPTIONAL {
        ?y <ex://q> ?x .
      }
      FILTER ( ( ! BOUND( ?x ) || SAMETERM( ?x , <ex://c> ) ) )
    }
  }
}`,
      );
    });

    it('is transparent for GRAPH, and selects the single graph when asserting its name', ({ expect }) => {
      expectTransform(
        expect,
        'SELECT * WHERE { GRAPH ?g { ?x :p ?y } FILTER(sameTerm(?x, :c)) }',
        `SELECT ?g ( <ex://c> AS ?x ) ?y WHERE {
  GRAPH ?g {
    <ex://c> <ex://p> ?y .
  }
}`,
      );
      expectTransform(
        expect,
        'SELECT * WHERE { GRAPH ?g { ?x :p ?y } FILTER(sameTerm(?g, :g1)) }',
        `SELECT ( <ex://g1> AS ?g ) ?x ?y WHERE {
  GRAPH <ex://g1> {
    ?x <ex://p> ?y .
  }
}`,
      );
    });

    it('travels into a GRAPH operation the conjunction says nothing about the name of', ({ expect }) => {
      // A GRAPH that is an operation of its own, rather than the graph component of the quads below
      // it: the conjunction has no assertion on `?g` to read, and every rule here is about the ones
      // it does carry.
      expectTransformGraphOperation(
        expect,
        'SELECT * WHERE { GRAPH ?g { ?x :p ?y } FILTER(sameTerm(?x, :c)) }',
        `SELECT ?g ( <ex://c> AS ?x ) ?y WHERE {
  GRAPH ?g {
    <ex://c> <ex://p> ?y .
  }
}`,
      );
    });

    it('selects the single graph of a GRAPH operation whose name is asserted', ({ expect }) => {
      // `?g` is certainly bound by the GRAPH, so it leaves the pattern in the weak form and is
      // promoted back on arrival - and the binding it stood for has to be put back on top.
      expectTransformGraphOperation(
        expect,
        'SELECT * WHERE { GRAPH ?g { ?x :p ?y } FILTER(sameTerm(?g, :g1)) }',
        `SELECT ( <ex://g1> AS ?g ) ?x ?y WHERE {
  GRAPH <ex://g1> {
    ?x <ex://p> ?y .
  }
}`,
      );
    });

    it('empties a GRAPH operation whose name is asserted to be a literal', ({ expect }) => {
      expectTransformGraphOperation(
        expect,
        'SELECT * WHERE { GRAPH ?g { ?x :p ?y } FILTER(sameTerm(?g, "lit")) }',
        `SELECT ?g ?x ?y WHERE {
  GRAPH ?g {
    ?x <ex://p> ?y .
  }
  FILTER ( FALSE )
}`,
      );
    });

    it('empties a GRAPH whose name is asserted to be a literal', ({ expect }) => {
      // No graph is named by a literal, so the pattern - which carries the graph name in quad mode -
      // can never match.
      expectTransform(
        expect,
        'SELECT * WHERE { GRAPH ?g { ?x :p ?y } FILTER(sameTerm(?g, "lit")) }',
        `SELECT ?g ?x ?y WHERE {
  GRAPH ?g {
    {
      ?x <ex://p> ?y .
      FILTER ( FALSE )
    }
  }
}`,
      );
    });

    it('stops above a SLICE', ({ expect }) => {
      expectTransform(
        expect,
        'SELECT * WHERE { { SELECT ?x ?y WHERE { ?x :p ?y } LIMIT 3 } FILTER(sameTerm(?x, :c)) }',
        `SELECT ?x ?y WHERE {
  {
    SELECT ?x ?y WHERE {
      ?x <ex://p> ?y .
    }
    LIMIT 3
  }
  FILTER ( SAMETERM( ?x , <ex://c> ) )
}`,
      );
    });

    it('stops above a SERVICE', ({ expect }) => {
      // Sound to push, but it has to be a replication rather than a move because of SILENT, so this
      // pass treats it as a barrier.
      expectTransform(
        expect,
        'SELECT * WHERE { SERVICE <ex://endpoint> { ?x :p ?y } FILTER(sameTerm(?x, :c)) }',
        `SELECT ?x ?y WHERE {
  SERVICE <ex://endpoint> {
    ?x <ex://p> ?y .
  }
  FILTER ( SAMETERM( ?x , <ex://c> ) )
}`,
      );
    });

    it('keeps pushing the assertions it finds below a barrier', ({ expect }) => {
      expectTransform(
        expect,
        `SELECT * WHERE {
          { SELECT ?x ?y WHERE { ?x :p ?y FILTER(sameTerm(?y, :d)) } LIMIT 3 }
          FILTER(sameTerm(?x, :c))
        }`,
        `SELECT ?x ?y WHERE {
  {
    SELECT ?x ( <ex://d> AS ?y ) WHERE {
      ?x <ex://p> <ex://d> .
    }
    LIMIT 3
  }
  FILTER ( SAMETERM( ?x , <ex://c> ) )
}`,
      );
    });

    it('pushes below a GROUP BY for a grouping key', ({ expect }) => {
      expectTransform(
        expect,
        `SELECT ?x (COUNT(?y) AS ?count) WHERE { ?x :p ?y }
         GROUP BY ?x HAVING(sameTerm(?x, :c))`,
        `SELECT ?x ( COUNT( ?y ) AS ?count ) WHERE {
  <ex://c> <ex://p> ?y .
  BIND( <ex://c> AS ?x )
}
GROUP BY ?x`,
      );
    });

    it('stops above a GROUP BY for a variable that is not a grouping key', ({ expect }) => {
      // Filtering an aggregate before the aggregation would change it. Not reachable from query text -
      // a HAVING over an aggregate references the internal variable the translation coins for it - so
      // the plan is built directly here.
      const { AF, DF } = c;
      const group = AF.createGroup(
        AF.createBgp([ AF.createPattern(DF.variable('x'), DF.namedNode('ex://p'), DF.variable('y')) ]),
        [ DF.variable('x') ],
        [ AF.createBoundAggregate(
          DF.variable('total'),
          'count',
          AF.createTermExpression(DF.variable('y')),
          false,
        ) ],
      );
      const pushed = pushDownAssertions(c, AF.createFilter(group, AF.createOperatorExpression('sameterm', [
        AF.createTermExpression(DF.variable('total')),
        AF.createTermExpression(DF.namedNode('ex://c')),
      ])));

      expect(pushed.type).toBe('filter');
      expect((pushed).input.type).toBe('group');
      expect((<AlgebraTypes.Group> (pushed).input).input.type).toBe('bgp');
    });
  });

  describe('the weak form', () => {
    it('demotes into the join operand the strong form may not enter', ({ expect }) => {
      // L fails for the union: ?x is not certain in it, and it is possible in the subquery. Left at
      // that, the union keeps both of its branches. Demoted, the assertion reaches them, becomes strong
      // again in the branch that binds ?x certainly, and is dropped by the one that cannot bind it.
      expectTransform(
        expect,
        `SELECT * WHERE {
          { { ?x :p ?y } UNION { ?z :q ?w } }
          { SELECT ?x ?d WHERE { ?x :r ?d } }
          FILTER(sameTerm(?x, :c))
        }`,
        `SELECT ?d ?w ?x ?y ?z WHERE {
  {
    <ex://c> <ex://p> ?y .
    BIND( <ex://c> AS ?x )
  }
  UNION {
    ?z <ex://q> ?w .
  }
  {
    SELECT ( <ex://c> AS ?x ) ?d WHERE {
      <ex://c> <ex://r> ?d .
    }
  }
}`,
      );
    });

    it('demotes into the left hand side of an OPTIONAL that may bind the variable', ({ expect }) => {
      // The strong assertion stays on top - the OPTIONAL can still bind ?x to something else - but the
      // weak one reaches the union below and prunes it.
      expectTransform(
        expect,
        `SELECT * WHERE {
          { { ?x :p ?y } UNION { ?u :s ?v } }
          OPTIONAL { ?x :q ?z }
          FILTER(sameTerm(?x, :c))
        }`,
        `SELECT ?u ?v ?x ?y ?z WHERE {
  {
    <ex://c> <ex://p> ?y .
    BIND( <ex://c> AS ?x )
  }
  UNION {
    ?u <ex://s> ?v .
  }
  OPTIONAL {
    ?x <ex://q> ?z .
  }
  FILTER ( SAMETERM( ?x , <ex://c> ) )
}`,
      );
    });

    it('promotes back to the strong form at a GRAPH, which binds its variable certainly', ({ expect }) => {
      // The right hand side of the MINUS takes the weak form. A GRAPH binds ?g certainly, so it is the
      // strong assertion again by the time it gets there - which is what lets it select the graph
      // rather than park on top of it.
      expectTransform(
        expect,
        `SELECT * WHERE {
          GRAPH ?g { ?x :p ?y }
          MINUS { GRAPH ?g { ?x :q ?z } }
          FILTER(sameTerm(?g, :g1))
        }`,
        `SELECT ?g ?x ?y WHERE {
  GRAPH <ex://g1> {
    {
      ?x <ex://p> ?y .
      BIND( <ex://g1> AS ?g )
    }
    MINUS {
      {
        ?x <ex://q> ?z .
        BIND( <ex://g1> AS ?g )
      }
    }
  }
}`,
      );
    });

    it('reads two weak assertions about one variable as `!bound`', ({ expect }) => {
      // `(¬b ∨ ?x ≡ :c) ∧ (¬b ∨ ?x ≡ :d)` is `¬b ∨ (?x ≡ :c ∧ ?x ≡ :d)`, and for two distinct terms
      // that is exactly `!bound(?x)`. Without the unbound form there would be nothing to merge the
      // second conjunct into - it has no term - and it would be stranded as a residual.
      expectTransform(
        expect,
        `SELECT * WHERE {
          ?a :p ?b
          OPTIONAL { ?a :q ?x }
          FILTER((!bound(?x) || sameTerm(?x, :c)) && (!bound(?x) || sameTerm(?x, :d)))
        }`,
        `SELECT ?a ?b ?x WHERE {
  ?a <ex://p> ?b .
  OPTIONAL {
    ?a <ex://q> ?x .
  }
  FILTER ( ! BOUND( ?x ) )
}`,
      );
    });

    it('empties the plan where that `!bound` meets a variable that is certainly bound', ({ expect }) => {
      // The inference the residual used to lose: a BGP binds ?x certainly, so `!bound(?x)` cannot hold
      // and the whole plan is empty. Before the merge this substituted :c and stranded the second
      // conjunct above it - correct, but a plan that does work to return nothing.
      expectTransform(
        expect,
        `SELECT * WHERE {
          ?x :p ?y
          FILTER((!bound(?x) || sameTerm(?x, :c)) && (!bound(?x) || sameTerm(?x, :d)))
        }`,
        `SELECT ?x ?y WHERE {
  ?x <ex://p> ?y .
  FILTER ( FALSE )
}`,
      );
    });

    it('empties the plan where `!bound` meets a strong assertion', ({ expect }) => {
      // The strong form implies `bound(?x)`, so the two cannot both hold whatever the operation binds.
      expectTransform(
        expect,
        `SELECT * WHERE {
          ?a :p ?b
          OPTIONAL { ?a :q ?x }
          FILTER(!bound(?x) && sameTerm(?x, :c))
        }`,
        `SELECT ?a ?b ?x WHERE {
  ?a <ex://p> ?b .
  OPTIONAL {
    ?a <ex://q> ?x .
  }
  FILTER ( FALSE )
}`,
      );
    });

    it('contradicts a weak assertion it meets on a variable it knows is bound', ({ expect }) => {
      // Inside the MINUS the conjunction is weak, but the pattern binds ?x certainly, so it is the
      // strong `?x ≡ :c` there - and `!bound(?x) || ?x ≡ :d` cannot hold of that.
      expectTransform(
        expect,
        `SELECT * WHERE {
          ?x :p ?y
          MINUS { ?x :q ?z FILTER(!bound(?x) || sameTerm(?x, :d)) }
          FILTER(sameTerm(?x, :c))
        }`,
        `SELECT ?x ?y WHERE {
  {
    <ex://c> <ex://p> ?y .
    BIND( <ex://c> AS ?x )
  }
  MINUS {
    {
      {
        ?x <ex://q> ?z .
        FILTER ( ( ! BOUND( ?x ) || SAMETERM( ?x , <ex://d> ) ) )
      }
      FILTER ( FALSE )
    }
  }
}`,
      );
    });
  });

  describe('the unbound form', () => {
    it('empties the union branch that binds the variable certainly', ({ expect }) => {
      // `FILTER(!bound(?x))` is SPARQL's negation idiom, so this is the form assertions most often
      // start in. It distributes over a union like the others, and the branch that cannot leave ?x
      // unbound is empty.
      expectTransform(
        expect,
        `SELECT * WHERE {
          { { ?a :p ?b OPTIONAL { ?a :q ?x } } UNION { ?c :r ?x } }
          FILTER(!bound(?x))
        }`,
        `SELECT ?a ?b ?c ?x WHERE {
  {
    ?a <ex://p> ?b .
    OPTIONAL {
      ?a <ex://q> ?x .
    }
    FILTER ( ! BOUND( ?x ) )
  }
  UNION {
    ?c <ex://r> ?x .
    FILTER ( FALSE )
  }
}`,
      );
    });

    it('drops the VALUES rows that bind the variable, and its column with them', ({ expect }) => {
      // The column has to go: a VALUES declares its own `pVars`, so leaving an all-UNDEF column would
      // put ?x back in scope - which is what `!bound(?x)` took it out of.
      expectTransform(
        expect,
        `SELECT * WHERE {
          VALUES (?x ?y) { (:a 1) (UNDEF 2) (UNDEF 3) }
          FILTER(!bound(?x))
        }`,
        `SELECT ?x ?y WHERE {
  VALUES ?y {
    "2"^^<http://www.w3.org/2001/XMLSchema#integer>
    "3"^^<http://www.w3.org/2001/XMLSchema#integer>
  }
}`,
      );
    });

    it('stays where the negation idiom put it when nothing below can take it', ({ expect }) => {
      // The plain shape: the OPTIONAL is the only thing that binds ?x, and pushing into the right hand
      // side of a left join is exactly what no form of assertion may do.
      expectTransform(
        expect,
        'SELECT * WHERE { ?a :p ?b OPTIONAL { ?a :q ?x } FILTER(!bound(?x)) }',
        `SELECT ?a ?b ?x WHERE {
  ?a <ex://p> ?b .
  OPTIONAL {
    ?a <ex://q> ?x .
  }
  FILTER ( ! BOUND( ?x ) )
}`,
      );
    });
  });

  describe('the bound form', () => {
    it('disappears where the variable is certainly bound', ({ expect }) => {
      // `bound(?x)` fixes no term, so all it can do is decide whether a solution exists at all - and a
      // BGP binds every variable of it, so it decides nothing here.
      expectTransform(
        expect,
        'SELECT * WHERE { ?x :p ?y FILTER(bound(?x)) }',
        `SELECT ?x ?y WHERE {
  ?x <ex://p> ?y .
}`,
      );
    });

    it('turns an OPTIONAL over an optional-only variable into a plain join', ({ expect }) => {
      // The structural rule the strong form triggers, on the half of it that has nothing to do with the
      // term: the anti-join half of the left join leaves ?x unbound, so `bound(?x)` discards all of it.
      expectTransform(
        expect,
        'SELECT * WHERE { ?a :p ?b OPTIONAL { ?a :q ?x } FILTER(bound(?x)) }',
        `SELECT ?a ?b ?x WHERE {
  ?a <ex://p> ?b .
  ?a <ex://q> ?x .
}`,
      );
    });

    it('empties the union branch that can never bind the variable', ({ expect }) => {
      // (FBndII) reads off `bound(?x)` alone: the branch that has no ?x to bind contributes nothing.
      expectTransform(
        expect,
        'SELECT * WHERE { { { ?a :p ?b } UNION { ?c :r ?x } } FILTER(bound(?x)) }',
        `SELECT ?a ?b ?c ?x WHERE {
  {
    ?a <ex://p> ?b .
    FILTER ( FALSE )
  }
  UNION {
    ?c <ex://r> ?x .
  }
}`,
      );
    });

    it('drops the VALUES rows that leave the variable UNDEF, and keeps its column', ({ expect }) => {
      // The column stays where an `!bound` or a strong assertion would have taken it out: the rows still
      // decide which term ?x takes, this only says there has to be one.
      expectTransform(
        expect,
        'SELECT * WHERE { VALUES (?x ?y) { (:a 1) (UNDEF 2) } FILTER(bound(?x)) }',
        `SELECT ?x ?y WHERE {
  VALUES( ?x ?y ){
    ( <ex://a> "1"^^<http://www.w3.org/2001/XMLSchema#integer> )
  }
}`,
      );
    });

    it('completes a weak assertion it meets into a strong one', ({ expect }) => {
      // `b ∧ (¬b ∨ ?x ≡ c) ≡ ?x ≡ c`: the two together are what neither is on its own, and the strong
      // assertion they come to then does everything a strong assertion does - here turning the OPTIONAL
      // into a join and substituting :c into the pattern below it.
      expectTransform(
        expect,
        `SELECT * WHERE {
          ?a :p ?b
          OPTIONAL { ?a :q ?x }
          FILTER(bound(?x) && (!bound(?x) || sameTerm(?x, :c)))
        }`,
        `SELECT ?a ?b ( <ex://c> AS ?x ) WHERE {
  ?a <ex://p> ?b .
  ?a <ex://q> <ex://c> .
}`,
      );
    });

    it('completes the weak assertion of a filter it passes on its way down', ({ expect }) => {
      // The same merge, but between two filters the conjunction only meets one after the other.
      expectTransform(
        expect,
        `SELECT * WHERE {
          { ?a :p ?b OPTIONAL { ?a :q ?x } FILTER(!bound(?x) || sameTerm(?x, :c)) }
          FILTER(bound(?x))
        }`,
        `SELECT ?a ?b ( <ex://c> AS ?x ) WHERE {
  ?a <ex://p> ?b .
  ?a <ex://q> <ex://c> .
}`,
      );
    });

    it('empties the plan where it meets the `!bound` of the same variable', ({ expect }) => {
      expectTransform(
        expect,
        'SELECT * WHERE { ?a :p ?b OPTIONAL { ?a :q ?x } FILTER(bound(?x) && !bound(?x)) }',
        `SELECT ?a ?b ?x WHERE {
  ?a <ex://p> ?b .
  OPTIONAL {
    ?a <ex://q> ?x .
  }
  FILTER ( FALSE )
}`,
      );
    });

    it('enters the one join operand that can bind the variable', ({ expect }) => {
      // The licence of the strong form, on an assertion carrying no term: the right operand has no ?x,
      // so `bound(?x)` on the join is `bound(?x)` on the left one - where it turns the OPTIONAL into a join.
      expectTransform(
        expect,
        `SELECT * WHERE {
          { ?a :p ?b OPTIONAL { ?a :q ?x } }
          { ?c :r ?d }
          FILTER(bound(?x))
        }`,
        `SELECT ?a ?b ?c ?d ?x WHERE {
  ?a <ex://p> ?b .
  ?a <ex://q> ?x .
  ?c <ex://r> ?d .
}`,
      );
    });

    it('stays above a join both operands may bind the variable in', ({ expect }) => {
      // Where the weak form would be demoted into both operands, this one may not go anywhere: a merged
      // mapping binds ?x as soon as *one* half does, so an operand leaving it unbound still contributes.
      expectTransform(
        expect,
        `SELECT * WHERE {
          { ?a :p ?b OPTIONAL { ?a :q ?x } }
          { ?c :r ?d OPTIONAL { ?c :s ?x } }
          FILTER(bound(?x))
        }`,
        `SELECT ?a ?b ?c ?d ?x WHERE {
  ?a <ex://p> ?b .
  OPTIONAL {
    ?a <ex://q> ?x .
  }
  ?c <ex://r> ?d .
  OPTIONAL {
    ?c <ex://s> ?x .
  }
  FILTER ( BOUND( ?x ) )
}`,
      );
    });

    it('stays above an OPTIONAL whose right hand side may bind the variable', ({ expect }) => {
      // The same reason on a left join: the right hand side is what may bind ?x, so the left one may not
      // be pruned - and there is no weaker form to demote to.
      expectTransform(
        expect,
        `SELECT * WHERE {
          { ?a :p ?b OPTIONAL { ?a :q ?x } }
          OPTIONAL { ?c :s ?x }
          FILTER(bound(?x))
        }`,
        `SELECT ?a ?b ?c ?x WHERE {
  ?a <ex://p> ?b .
  OPTIONAL {
    ?a <ex://q> ?x .
  }
  OPTIONAL {
    ?c <ex://s> ?x .
  }
  FILTER ( BOUND( ?x ) )
}`,
      );
    });

    it('pushes below a GROUP BY for a grouping key', ({ expect }) => {
      // Selecting the groups whose key is bound selects exactly the solutions binding it, the group of
      // the unbound key included - and below the GROUP the assertion still turns the OPTIONAL into a join.
      expectTransform(
        expect,
        `SELECT ?x (COUNT(?y) AS ?cnt) WHERE {
          ?a :p ?b OPTIONAL { ?a :q ?x } . ?a :t ?y
          FILTER(bound(?x))
        } GROUP BY ?x`,
        `SELECT ?x ( COUNT( ?y ) AS ?cnt ) WHERE {
  ?a <ex://p> ?b .
  ?a <ex://q> ?x .
  ?a <ex://t> ?y .
}
GROUP BY ?x`,
      );
    });

    it('stops above a SLICE', ({ expect }) => {
      // A barrier for every form: filtering before the slice changes which rows fall in the window.
      expectTransform(
        expect,
        'SELECT * WHERE { { SELECT * WHERE { ?a :p ?b OPTIONAL { ?a :q ?x } } LIMIT 5 } FILTER(bound(?x)) }',
        `SELECT ?a ?b ?x WHERE {
  {
    SELECT ?a ?b ?x WHERE {
      ?a <ex://p> ?b .
      OPTIONAL {
        ?a <ex://q> ?x .
      }
    }
    LIMIT 5
  }
  FILTER ( BOUND( ?x ) )
}`,
      );
    });
  });

  describe('variable unification', () => {
    it('unifies a pattern onto the representative of the clique and re-binds the other member', ({ expect }) => {
      // The representative is the lexicographically first member, so `{?s, ?o}` unifies onto `?o`.
      // The BIND is mandatory: substituting takes `?s` out of the pattern, and `pVars` is preserved.
      expectTransform(
        expect,
        'SELECT * WHERE { ?s ?p ?o FILTER(sameTerm(?s, ?o)) }',
          `SELECT ?o ?p ( ?o AS ?s ) WHERE {
  ?o ?p ?o .
}`,
      );
    });

    it('drags a term met above a unification onto every variable it unified', ({ expect }) => {
      // The interop case: the left branch pins `?s`, the unification above hands that term to `?o` as
      // well, and the right branch - which learns no term - unifies onto its representative instead.
      expectTransform(
        expect,
        `SELECT * WHERE {
          { ?s ?p ?o FILTER(sameTerm(?s, :x)) } UNION { ?s :p ?o }
          FILTER(sameTerm(?s, ?o))
        }`,
        `SELECT ?o ?p ?s WHERE {
  {
    <ex://x> ?p <ex://x> .
    BIND( <ex://x> AS ?s )
    BIND( <ex://x> AS ?o )
  }
  UNION {
    ?o <ex://p> ?o .
    BIND( ?o AS ?s )
  }
}`,
      );
    });

    it('collapses a three way unification onto one variable', ({ expect }) => {
      expectTransform(
        expect,
        'SELECT * WHERE { ?b :p ?c . ?c :q ?a FILTER(sameTerm(?a, ?b) && sameTerm(?b, ?c)) }',
        `SELECT ?a ( ?a AS ?b ) ( ?a AS ?c ) WHERE {
  ?a <ex://p> ?a .
  ?a <ex://q> ?a .
}`,
      );
    });

    it('substitutes the term into every member once the clique is pinned', ({ expect }) => {
      expectTransform(
        expect,
        'SELECT * WHERE { ?x :p ?y FILTER(sameTerm(?x, ?y) && sameTerm(?y, :c)) }',
        `SELECT ( <ex://c> AS ?x ) ( <ex://c> AS ?y ) WHERE {
  <ex://c> <ex://p> <ex://c> .
}`,
      );
    });

    it('empties the plan where the clique is pinned to two distinct terms', ({ expect }) => {
      expectTransform(
        expect,
        'SELECT * WHERE { ?x :p ?y FILTER(sameTerm(?x, ?y) && sameTerm(?x, :c) && sameTerm(?y, :d)) }',
        `SELECT ?x ?y WHERE {
  ?x <ex://p> ?y .
  FILTER ( FALSE )
}`,
      );
    });

    it('empties the plan where `!bound` meets a clique member, which is always strong', ({ expect }) => {
      expectTransform(
        expect,
        'SELECT * WHERE { ?x :p ?y FILTER(sameTerm(?x, ?y) && !bound(?x)) }',
        `SELECT ?x ?y WHERE {
  ?x <ex://p> ?y .
  FILTER ( FALSE )
}`,
      );
    });

    it('completes a weak assertion it meets, membership implying bound', ({ expect }) => {
      // `sameTerm(?x, ?y)` says `?x` is bound, which promotes W⟨?x ≡ :c⟩ to the strong form; that pins
      // the clique, and the `bound(?x)` it entails turns the OPTIONAL into a join on the way.
      expectTransform(
        expect,
        `SELECT * WHERE {
          ?s :p ?y OPTIONAL { ?s :r ?x }
          FILTER(sameTerm(?x, ?y) && (!bound(?x) || sameTerm(?x, :c)))
        }`,
        `SELECT ?s ( <ex://c> AS ?x ) ( <ex://c> AS ?y ) WHERE {
  ?s <ex://p> <ex://c> .
  ?s <ex://r> <ex://c> .
}`,
      );
    });

    it('prunes the VALUES rows whose two columns differ, and re-binds the column it drops', ({ expect }) => {
      // Three ways for a row to go: the columns differ, one of them is UNDEF where the clique requires
      // it bound, or they agree - in which case only the representative's column has to stay.
      expectTransform(
        expect,
        `SELECT * WHERE {
          VALUES (?s ?o ?k) { (:a :a 1) (:a :b 2) (UNDEF :c 3) (:d :d 4) }
          FILTER(sameTerm(?s, ?o))
        }`,
        `SELECT ?k ?o ( ?o AS ?s ) WHERE {
  VALUES( ?o ?k ){
    ( <ex://a> "1"^^<http://www.w3.org/2001/XMLSchema#integer> )
    ( <ex://d> "4"^^<http://www.w3.org/2001/XMLSchema#integer> )
  }
}`,
      );
    });

    it('splits the clique over a join, keeping one edge to span what it pushed', ({ expect }) => {
      // No operand is licensed for the whole clique, but each is for half of it, and one edge between
      // the halves puts it back together: `σ_{y≡w}( σ_{w≡x}(L) ⋈ σ_{y≡z}(R) )`.
      expectTransform(
        expect,
        `SELECT * WHERE {
          { SELECT ?w ?x WHERE { ?w :p ?x } }
          { SELECT ?y ?z WHERE { ?y :q ?z } }
          FILTER(sameTerm(?w, ?x) && sameTerm(?x, ?y) && sameTerm(?y, ?z))
        }`,
        `SELECT ?w ?x ?y ?z WHERE {
  {
    SELECT ?w ( ?w AS ?x ) WHERE {
      ?w <ex://p> ?w .
    }
  }
  {
    SELECT ?y ( ?y AS ?z ) WHERE {
      ?y <ex://q> ?y .
    }
  }
  FILTER ( SAMETERM( ?y , ?w ) )
}`,
      );
    });

    it('needs no spanning edge when the two halves share a variable', ({ expect }) => {
      // `?y` is certain on both sides, so join compatibility *is* the equality that would connect them.
      expectTransform(
        expect,
        `SELECT * WHERE {
          { SELECT ?x ?y WHERE { ?x :p ?y } }
          { SELECT ?y ?z WHERE { ?y :q ?z } }
          FILTER(sameTerm(?x, ?y) && sameTerm(?y, ?z))
        }`,
        `SELECT ?x ?y ?z WHERE {
  {
    SELECT ?x ( ?x AS ?y ) WHERE {
      ?x <ex://p> ?x .
    }
  }
  {
    SELECT ?y ( ?y AS ?z ) WHERE {
      ?y <ex://q> ?y .
    }
  }
}`,
      );
    });

    it('empties the plan where one member of the clique is not a grouping key', ({ expect }) => {
      // The edge stays above the GROUP, where `?y` is out of scope, and a strong assertion on a variable
      // outside `pVars` is (FBndII). Splitting the clique per *variable* would have lost that.
      expectTransform(
        expect,
        'SELECT ?x (COUNT(?y) AS ?n) WHERE { ?x :p ?y } GROUP BY ?x HAVING(sameTerm(?x, ?y))',
        `SELECT ?x ( COUNT( ?y ) AS ?n ) WHERE {
  ?x <ex://p> ?y .
  FILTER ( FALSE )
}
GROUP BY ?x`,
      );
    });

    it('pushes below a GROUP BY whose keys hold the whole clique', ({ expect }) => {
      expectTransform(
        expect,
        'SELECT ?x ?y (COUNT(?z) AS ?n) WHERE { ?x :p ?y . ?y :q ?z } GROUP BY ?x ?y HAVING(sameTerm(?x, ?y))',
        `SELECT ?x ?y ( COUNT( ?z ) AS ?n ) WHERE {
  ?x <ex://p> ?x .
  ?x <ex://q> ?z .
  BIND( ?x AS ?y )
}
GROUP BY ?x?y`,
      );
    });

    it('transfers the clique of a BIND target to the variable it copies', ({ expect }) => {
      // `?t` has to leave Θ before descending, but its edges do not: below the EXTEND `?z` is what `?t`
      // was, so A⟨?t ≡ ?y⟩ becomes A⟨?z ≡ ?y⟩ there - and `?y` is the representative of what is left.
      expectTransform(
        expect,
        'SELECT * WHERE { ?z :p ?y BIND(?z AS ?t) FILTER(sameTerm(?t, ?y)) }',
        `SELECT ( ?y AS ?t ) ?y ( ?y AS ?z ) WHERE {
  ?y <ex://p> ?y .
}`,
      );
    });

    it('pins the clique to the term a constant BIND fixes its target to', ({ expect }) => {
      // The other direction of the same transfer: `?t` is `:c` above the EXTEND, so `?t ≡ ?y` there is
      // `?y ≡ :c` below - a constant BIND is what gives a clique the term the assertions never found.
      expectTransform(
        expect,
        'SELECT * WHERE { ?y :p ?w BIND(:c AS ?t) FILTER(sameTerm(?t, ?y)) }',
        `SELECT ( <ex://c> AS ?t ) ?w ( <ex://c> AS ?y ) WHERE {
  <ex://c> <ex://p> ?w .
}`,
      );
    });

    it('pins every member of the clique, not just the one the BIND met', ({ expect }) => {
      expectTransform(
        expect,
        'SELECT * WHERE { ?y :p ?w BIND(:c AS ?t) FILTER(sameTerm(?t, ?y) && sameTerm(?y, ?w)) }',
        `SELECT ( <ex://c> AS ?t ) ( <ex://c> AS ?w ) ( <ex://c> AS ?y ) WHERE {
  <ex://c> <ex://p> <ex://c> .
}`,
      );
    });

    it('empties the plan where a constant BIND contradicts the term of the clique', ({ expect }) => {
      expectTransform(
        expect,
        'SELECT * WHERE { ?y :p ?w BIND(:c AS ?t) FILTER(sameTerm(?t, ?y) && sameTerm(?y, :d)) }',
        `SELECT ?t ?w ?y WHERE {
  {
    ?y <ex://p> ?w .
    BIND( <ex://c> AS ?t )
  }
  FILTER ( FALSE )
}`,
      );
    });

    it('empties the plan where the term it pins the clique to cannot occupy its position', ({ expect }) => {
      // `?y ≡ "a"` cannot hold: `?y` is a subject, and no triple has a literal one. The *group* carries
      // that range, so the contradiction is decided where the BIND hands the clique its term - before the
      // term ever reaches the pattern that `canOccupy` would have refused it at.
      expectTransform(
        expect,
        'SELECT * WHERE { ?y :p ?w BIND("a" AS ?t) FILTER(sameTerm(?t, ?y)) }',
        `SELECT ?t ?w ?y WHERE {
  {
    ?y <ex://p> ?w .
    BIND( "a" AS ?t )
  }
  FILTER ( FALSE )
}`,
      );
    });

    it('keeps a clique above a BIND whose expression is compound', ({ expect }) => {
      // `sameTerm(e, ?y)` over a compound `e` is a multi-variable condition, which this pass has no
      // licence for - so nothing transfers and the edge stays where it was.
      expectTransform(
        expect,
        'SELECT * WHERE { ?y :p ?w BIND(CONCAT(?w, "x") AS ?t) FILTER(sameTerm(?t, ?y)) }',
        `SELECT ?t ?w ?y WHERE {
  {
    ?y <ex://p> ?w .
    BIND( CONCAT( ?w , "x" ) AS ?t )
  }
  FILTER ( SAMETERM( ?y , ?t ) )
}`,
      );
    });

    it('turns an OPTIONAL over a right-only member into a join, and unifies over the merged BGP', ({ expect }) => {
      // The B⟨?z⟩ the edge entails rules out the anti-join half. The edge itself is licensed for neither
      // operand of the join that leaves - a join enforces nothing between `?y` and `?z` - so it only
      // travels because the two BGPs are merged into the one that binds both of its endpoints, which is
      // the plan the same query written without the OPTIONAL has all along.
      expectTransform(
        expect,
        'SELECT * WHERE { ?s :p ?y OPTIONAL { ?s :r ?z } FILTER(sameTerm(?y, ?z)) }',
        `SELECT ?s ?y ( ?y AS ?z ) WHERE {
  ?s <ex://p> ?y .
  ?s <ex://r> ?y .
}`,
      );
    });

    it('sends nothing into the right hand side of a MINUS, which has no anchor to agree on', ({ expect }) => {
      expectTransform(
        expect,
        'SELECT * WHERE { ?x :p ?y MINUS { ?z :q ?y } FILTER(sameTerm(?x, ?y)) }',
        `SELECT ?x ?y WHERE {
  {
    ?x <ex://p> ?x .
    BIND( ?x AS ?y )
  }
  MINUS {
    ?z <ex://q> ?y .
  }
}`,
      );
    });

    it('leaves a GRAPH whose name is only unified alone, naming no graph statically', ({ expect }) => {
      expectTransformGraphOperation(
        expect,
        'SELECT * WHERE { GRAPH ?g { ?s :p ?o } FILTER(sameTerm(?g, ?s)) }',
        `SELECT ?g ?o ?s WHERE {
  GRAPH ?g {
    ?s <ex://p> ?o .
  }
  FILTER ( SAMETERM( ?s , ?g ) )
}`,
      );
    });

    it('splits a clique over a GRAPH name into the pattern and back together on top', ({ expect }) => {
      // `?a` is the representative, so the star of the clique {a, b, g} is `?b ≡ ?a` and `?g ≡ ?a`. Only
      // the first mentions no `?g` and travels into the pattern; the second stays above, and the two
      // together still span the clique - `?b ≡ ?g` is what neither of them states on its own.
      expectTransformGraphOperation(
        expect,
        'SELECT * WHERE { GRAPH ?g { ?a :p ?b } FILTER(sameTerm(?a, ?g) && sameTerm(?a, ?b)) }',
        `SELECT ?a ?b ?g WHERE {
  GRAPH ?g {
    {
      ?a <ex://p> ?a .
      BIND( ?a AS ?b )
    }
  }
  FILTER ( SAMETERM( ?g , ?a ) )
}`,
      );
    });

    it('splits a clique whose representative is the GRAPH name', ({ expect }) => {
      // `?g` is the representative here, so no edge of the star `?s ≡ ?g`, `?t ≡ ?g` may travel as it
      // stands. The sub-clique over the members that are not `?g` still can: `?s ≡ ?t` - an edge the
      // star never states, only entails - goes into the pattern, and one edge back to `?g` stays here
      // to span the clique again.
      expectTransformGraphOperation(
        expect,
        'SELECT * WHERE { GRAPH ?g { ?s :p ?t } FILTER(sameTerm(?g, ?s) && sameTerm(?g, ?t)) }',
        `SELECT ?g ?s ?t WHERE {
  GRAPH ?g {
    {
      ?s <ex://p> ?s .
      BIND( ?s AS ?t )
    }
  }
  FILTER ( SAMETERM( ?s , ?g ) )
}`,
      );
    });

    it('unifies a property path onto its representative', ({ expect }) => {
      expectTransform(
        expect,
        'SELECT * WHERE { ?x :step* ?y FILTER(sameTerm(?x, ?y)) }',
        `SELECT ?x ( ?x AS ?y ) WHERE {
  ?x (<ex://step>*) ?x .
}`,
      );
    });

    it('leaves the input tree untouched', ({ expect }) => {
      const algebra = parseQuery(c, `${prefixes}SELECT * WHERE {
        { SELECT ?w ?x WHERE { ?w :p ?x } }
        { SELECT ?y ?z WHERE { ?y :q ?z } }
        OPTIONAL { ?x :s ?t }
        FILTER(sameTerm(?w, ?x) && sameTerm(?x, ?y) && sameTerm(?y, ?z))
      }`);
      const before = JSON.stringify(algebra);
      pushDownAssertions(c, algebra);
      expect(JSON.stringify(algebra)).toEqual(before);
    });

    it('applying the transformation twice yields the same result as once', ({ expect }) => {
      // What the deterministic representative buys: re-reading `SAMETERM(?y, ?w)` rebuilds the same
      // clique, picks the same representative, and folds the `SAMETERM(?w, ?w)` it re-derives away.
      for (const query of [
        'SELECT * WHERE { ?s ?p ?o FILTER(sameTerm(?s, ?o)) }',
        `SELECT * WHERE {
          { SELECT ?w ?x WHERE { ?w :p ?x } }
          { SELECT ?y ?z WHERE { ?y :q ?z } }
          FILTER(sameTerm(?w, ?x) && sameTerm(?x, ?y) && sameTerm(?y, ?z))
        }`,
        'SELECT * WHERE { ?s :p ?y OPTIONAL { ?s :r ?z } FILTER(sameTerm(?y, ?z)) }',
        'SELECT * WHERE { ?z :p ?y BIND(?z AS ?t) FILTER(sameTerm(?t, ?y)) }',
        'SELECT * WHERE { ?y :p ?w BIND(:c AS ?t) FILTER(sameTerm(?t, ?y)) }',
        `SELECT * WHERE {
          { ?s ?p ?o FILTER(sameTerm(?s, :x)) } UNION { ?s :p ?o }
          FILTER(sameTerm(?s, ?o))
        }`,
        // The accessor folds are what make these idempotent: the condition the assertion was read from
        // is written back over the operation it was pushed into, and has to collapse there.
        'SELECT * WHERE { ?s ?p ?o FILTER(sameTerm(subject(?o), ?s)) }',
        'SELECT * WHERE { ?s ?p ?o FILTER(isTRIPLE(?o)) }',
        'SELECT * WHERE { ?s ?p ?o FILTER(sameTerm(?o, <<( :a :b :c )>>)) }',
        'SELECT * WHERE { ?s ?p ?o FILTER(sameTerm(?o, TRIPLE(?s, ?p, ?s))) }',
        'SELECT * WHERE { ?s ?p ?o OPTIONAL { ?o :q ?z } FILTER(isTRIPLE(?z)) }',
        'SELECT * WHERE { ?s ?p ?o FILTER(isLITERAL(?o)) }',
        'SELECT * WHERE { ?s ?p ?o FILTER(isIRI(object(?o))) }',
        'SELECT * WHERE { ?s ?p ?o FILTER(subject(object(?o)) = :subj) }',
        'SELECT * WHERE { ?s ?p ?o FILTER(sameTerm(subject(?o), subject(?o))) }',
        'SELECT * WHERE { ?s ?p ?o FILTER(isTRIPLE(?o) && sameTerm(subject(?o), :a)) }',
        // And the materialisation on top of them: the plan a shape leaves behind holds no condition for
        // the pass to read a second time, and what it does leave - a kind of term, a position no
        // pattern reached - has to survive the second run unchanged rather than coin a second name.
        'SELECT * WHERE { ?s ?p ?o FILTER(sameTerm(subject(?o), :a) && isIRI(object(?o))) }',
        'SELECT * WHERE { ?s ?p ?o FILTER(sameTerm(subject(object(?o)), ?s)) }',
        `SELECT * WHERE {
          { { ?t :p ?o } UNION { ?t :q ?o } }
          ?s :r ?o
          FILTER(sameTerm(subject(?o), :a))
        }`,
      ]) {
        const once = pushDownAssertions(c, parseQuery(c, prefixes + query));
        const twice = pushDownAssertions(c, pushDownAssertions(c, parseQuery(c, prefixes + query)));
        expect(c.generator.generate(toAst(twice))).toEqual(c.generator.generate(toAst(once)));
      }
    });
  });

  describe('condition handling', () => {
    it('propagates the assertion through a renaming BIND', ({ expect }) => {
      expectTransform(
        expect,
        'SELECT * WHERE { { SELECT ?x ?y WHERE { ?z :p ?y BIND(?z AS ?x) } } FILTER(sameTerm(?x, :c)) }',
        `SELECT ?x ?y WHERE {
  SELECT ( <ex://c> AS ?x ) ?y WHERE {
    <ex://c> <ex://p> ?y .
    BIND( <ex://c> AS ?z )
  }
}`,
      );
    });

    it('turns the assertion on a fallible BIND target into a condition on its expression', ({ expect }) => {
      expectTransform(
        expect,
        'SELECT * WHERE { { SELECT ?x ?a WHERE { ?a :p ?b BIND(?a + ?b AS ?x) } } FILTER(sameTerm(?x, :c)) }',
        `SELECT ?a ?x WHERE {
  SELECT ( <ex://c> AS ?x ) ?a WHERE {
    ?a <ex://p> ?b .
    FILTER ( SAMETERM( ( ?a + ?b ) , <ex://c> ) )
  }
}`,
      );
    });

    it('propagates an assertion between two variables asserted equal', ({ expect }) => {
      expectTransform(
        expect,
        'SELECT * WHERE { ?x :p ?y FILTER(sameTerm(?x, :c) && sameTerm(?y, ?x)) }',
        `SELECT ( <ex://c> AS ?x ) ( <ex://c> AS ?y ) WHERE {
  <ex://c> <ex://p> <ex://c> .
}`,
      );
    });

    it('folds bound(?x) of an asserted variable to true instead of substituting it', ({ expect }) => {
      // Substituting would produce the ungrammatical `BOUND(<ex://c>)`.
      expectTransform(
        expect,
        'SELECT * WHERE { ?x :p ?y FILTER(sameTerm(?x, :c) && (BOUND(?x) && ?y > 2)) }',
        `SELECT ?x ?y WHERE {
  {
    <ex://c> <ex://p> ?y .
    BIND( <ex://c> AS ?x )
  }
  FILTER ( ( ?y > "2"^^<http://www.w3.org/2001/XMLSchema#integer> ) )
}`,
      );
    });

    it('folds sameTerm(?y, ?y) inside a residual for a variable the operation below binds', ({ expect }) => {
      // Under the `||` it is no conjunct of the top level, so nothing reads it as an assertion and
      // nothing substitutes for ?y: it is the `cVars` of the BGP that decide the fold, `sameTerm(?y, ?y)`
      // being `true` of a bound ?y and an error of an unbound one. Folding it makes the `||` true, which
      // takes the whole residual with it.
      expectTransform(
        expect,
        'SELECT * WHERE { ?x :p ?y FILTER(sameTerm(?x, :c) && (sameTerm(?y, ?y) || ?y > 2)) }',
        `SELECT ( <ex://c> AS ?x ) ?y WHERE {
  <ex://c> <ex://p> ?y .
}`,
      );
    });

    it('collapses the !bound(?x) negation idiom to the empty result', ({ expect }) => {
      expectTransform(
        expect,
        `SELECT * WHERE {
          { ?s :p ?o OPTIONAL { ?s :q ?x } }
          FILTER(sameTerm(?x, :c) && !BOUND(?x))
        }`,
        `SELECT ?o ?s ?x WHERE {
  ?s <ex://p> ?o .
  OPTIONAL {
    ?s <ex://q> ?x .
  }
  FILTER ( FALSE )
}`,
      );
    });

    it('empties a filter asserting one variable to be two distinct terms', ({ expect }) => {
      expectTransform(
        expect,
        'SELECT * WHERE { ?x :p ?y FILTER(sameTerm(?x, :c) && sameTerm(?x, :d)) }',
        `SELECT ?x ?y WHERE {
  ?x <ex://p> ?y .
  FILTER ( FALSE )
}`,
      );
    });

    it('leaves the pattern of an EXISTS alone', ({ expect }) => {
      // Nothing travels into an EXISTS. The assertion still holds of every solution the condition is
      // evaluated against - the BIND keeps ?x bound to :c - and `substitute()` inlines it at evaluation
      // time, so this is a missed optimisation rather than a missed rewrite. See the TODO in
      // `substituteInExpression` for why neither obvious way of doing it is right.
      expectTransform(
        expect,
        'SELECT * WHERE { ?x :p ?y FILTER(sameTerm(?x, :c) && EXISTS { ?x :q ?w }) }',
        `SELECT ?x ?y WHERE {
  {
    <ex://c> <ex://p> ?y .
    BIND( <ex://c> AS ?x )
  }
  FILTER ( EXISTS {
    ?x <ex://q> ?w .
  }
  )
}`,
      );
    });

    it('re-serialises to valid SPARQL, never emitting BOUND of a term', ({ expect }) => {
      // What may not happen is substituting the term into the `BOUND` - `BOUND(<ex://c>)` does not parse -
      // so it folds to `true` instead, and that is what takes the whole `BOUND(?z) || BOUND(?x)` conjunct
      // with it: `X || true` is `true` whatever `X` is. That ?z may be unbound is precisely what does not
      // matter here; the fold is licensed by the *sibling* conjunct `sameTerm(?x, :c)`, since a solution
      // this filter keeps has to satisfy that one too, and it implies `bound(?x)`. The test below shows
      // the disjunction surviving where no assertion decides one of its sides.
      // The `FILTER(BOUND(?x))` inside the EXISTS is a bound assertion of its own, met by the traversal
      // in the pattern it stands in: the BGP there binds ?x certainly, so it holds of every solution and
      // disappears. The assertion on ?x outside says nothing about it - EXISTS is scoped separately.
      const result = transform(`SELECT * WHERE {
        ?x :p ?y
        OPTIONAL { ?y :q ?z }
        FILTER(sameTerm(?x, :c) && (BOUND(?z) || BOUND(?x)) && EXISTS { ?w :r ?x FILTER(BOUND(?x)) })
      }`);
      expect(result).toBe(`SELECT ?x ?y ?z WHERE {
  {
    <ex://c> <ex://p> ?y .
    BIND( <ex://c> AS ?x )
  }
  OPTIONAL {
    ?y <ex://q> ?z .
  }
  FILTER ( EXISTS {
    ?w <ex://r> ?x .
  }
  )
}`);
      // A round trip over the whole plan is the real check: the generated query has to parse again.
      expect(() => parseQuery(c, result)).not.toThrow();
    });

    it('leaves a BOUND the assertions do not decide alone', ({ expect }) => {
      // The counterpart of the fold above: nothing is asserted about ?y, so neither disjunct is decided
      // and the condition stays exactly as it was written.
      expectTransform(
        expect,
        `SELECT * WHERE {
          ?x :p ?y
          OPTIONAL { ?y :q ?z }
          FILTER(sameTerm(?x, :c) && (BOUND(?z) || BOUND(?y)))
        }`,
        `SELECT ?x ?y ?z WHERE {
  {
    <ex://c> <ex://p> ?y .
    BIND( <ex://c> AS ?x )
  }
  OPTIONAL {
    ?y <ex://q> ?z .
  }
  FILTER ( ( BOUND( ?z ) || BOUND( ?y ) ) )
}`,
      );
    });
  });

  describe('equality against an IRI', () => {
    // `=` raises a type error only when both of its arguments are literals, so against an IRI it is
    // term identity - the very function `sameTerm` is - and it may travel as an assertion.
    it('is an assertion, and reaches the pattern like sameTerm does', ({ expect }) => {
      expectTransform(
        expect,
        'SELECT * WHERE { ?x :p ?y FILTER(?x = :c) }',
        `SELECT ( <ex://c> AS ?x ) ?y WHERE {
  <ex://c> <ex://p> ?y .
}`,
      );
    });

    it('reads the IRI on either side', ({ expect }) => {
      expectTransform(
        expect,
        'SELECT * WHERE { ?x :p ?y FILTER(:c = ?x) }',
        `SELECT ( <ex://c> AS ?x ) ?y WHERE {
  <ex://c> <ex://p> ?y .
}`,
      );
    });

    it('joins the conjunction, and contradicts it like any other assertion', ({ expect }) => {
      expectTransform(
        expect,
        'SELECT * WHERE { ?x :p ?y FILTER(?x = :c && sameTerm(?x, :d)) }',
        `SELECT ?x ?y WHERE {
  ?x <ex://p> ?y .
  FILTER ( FALSE )
}`,
      );
    });

    it('decides two IRIs against each other, false included', ({ expect }) => {
      // The general `=` may only fold to true: comparing literals of unsupported datatypes raises an
      // error, and an error is not false everywhere. Between IRIs it may fold either way.
      expectTransform(
        expect,
        'SELECT * WHERE { ?x :p ?y FILTER(:c = :d) }',
        `SELECT ?x ?y WHERE {
  ?x <ex://p> ?y .
  FILTER ( FALSE )
}`,
      );
    });

    it('leaves an equality against a literal alone', ({ expect }) => {
      // The case the two functions genuinely differ in, so it stays a value comparison on top.
      expectTransform(
        expect,
        'SELECT * WHERE { ?s :value ?o FILTER(?o = "01"^^xsd:integer) }',
        `SELECT ?o ?s WHERE {
  ?s <ex://value> ?o .
  FILTER ( ( ?o = "01"^^<http://www.w3.org/2001/XMLSchema#integer> ) )
}`,
      );
    });
  });

  describe('the conjunction that travels', () => {
    it('substitutes a conjunction of assertions in one go', ({ expect }) => {
      expectTransform(
        expect,
        'SELECT * WHERE { ?x :p ?y . ?y :q ?z FILTER(sameTerm(?x, :c) && sameTerm(?y, :d)) }',
        `SELECT ( <ex://c> AS ?x ) ( <ex://d> AS ?y ) ?z WHERE {
  <ex://c> <ex://p> <ex://d> .
  <ex://d> <ex://q> ?z .
}`,
      );
    });

    it('absorbs the assertions of a filter it passes', ({ expect }) => {
      // The second filter is met on the way down, and its assertion joins the conjunction rather than
      // starting a traversal of its own.
      expectTransform(
        expect,
        'SELECT * WHERE { ?x :p ?y FILTER(sameTerm(?x, :c)) FILTER(sameTerm(?y, :d)) }',
        `SELECT ( <ex://c> AS ?x ) ( <ex://d> AS ?y ) WHERE {
  <ex://c> <ex://p> <ex://d> .
}`,
      );
    });

    it('absorbs the weak form of something it already knows strongly', ({ expect }) => {
      // A ∧ W is A for the same term, so the weak conjunct adds nothing and disappears rather than
      // staying behind as a residual.
      expectTransform(
        expect,
        'SELECT * WHERE { ?x :p ?y FILTER(sameTerm(?x, :c) && (!bound(?x) || sameTerm(?x, :c))) }',
        `SELECT ( <ex://c> AS ?x ) ?y WHERE {
  <ex://c> <ex://p> ?y .
}`,
      );
    });

    it('empties the plan where the weak form contradicts what it knows strongly', ({ expect }) => {
      // The strong assertion says ?x is bound to :c; the weak one allows only unbound or :d. Neither
      // form alone is contradictory, which is why the two have to be read as one conjunction.
      expectTransform(
        expect,
        'SELECT * WHERE { ?x :p ?y FILTER(sameTerm(?x, :c) && (!bound(?x) || sameTerm(?x, :d))) }',
        `SELECT ?x ?y WHERE {
  ?x <ex://p> ?y .
  FILTER ( FALSE )
}`,
      );
    });

    it('re-running it changes nothing', ({ expect }) => {
      // A filter the conjunction passes is absorbed, not swapped with, so a second run re-derives the
      // same conjunction and merges it away instead of stacking a second copy of it.
      const query = `${prefixes}SELECT * WHERE {
        { { ?x :p ?y } UNION { ?z :q ?w } }
        { SELECT ?x ?d WHERE { ?x :r ?d } }
        FILTER(sameTerm(?x, :c))
      }`;
      const once = pushDownAssertions(c, parseQuery(c, query));
      const twice = pushDownAssertions(c, once);
      expect(c.generator.generate(toAst(twice))).toEqual(c.generator.generate(toAst(once)));
    });

    it('empties the plan where a passed assertion contradicts the conjunction', ({ expect }) => {
      // ?x cannot be both, so everything below is skipped rather than rewritten - the inner filter is
      // left exactly as it was.
      expectTransform(
        expect,
        `SELECT * WHERE {
          { SELECT * WHERE { ?x :p ?y FILTER(sameTerm(?x, :d)) } }
          FILTER(sameTerm(?x, :c))
        }`,
        `SELECT ?x ?y WHERE {
  SELECT ?x ?y WHERE {
    {
      ?x <ex://p> ?y .
      FILTER ( SAMETERM( ?x , <ex://d> ) )
    }
    FILTER ( FALSE )
  }
}`,
      );
    });
  });

  describe('soundness guards', () => {
    it('demotes rather than pushes into a join operand whose BIND may leave the variable unbound', ({ expect }) => {
      // ?x is not certainly bound in the left operand (`?a / ?b` errors when ?b is 0), and it is
      // possible in the right one, so L fails for the left: only the right operand may take the strong
      // assertion. The left still gets the weak one, which is what prunes it - and which stops above
      // the BIND, since it does not say `?a / ?b` evaluated to anything.
      expectTransform(
        expect,
        `SELECT * WHERE {
          { SELECT ?x ?a ?b WHERE { ?a :p ?b BIND(?a / ?b AS ?x) } }
          { SELECT ?x ?d WHERE { ?x :q ?d } }
          FILTER(sameTerm(?x, :c))
        }`,
        `SELECT ?a ?b ?d ?x WHERE {
  {
    SELECT ?x ?a ?b WHERE {
      {
        ?a <ex://p> ?b .
        BIND( ( ?a / ?b ) AS ?x )
      }
      FILTER ( ( ! BOUND( ?x ) || SAMETERM( ?x , <ex://c> ) ) )
    }
  }
  {
    SELECT ( <ex://c> AS ?x ) ?d WHERE {
      <ex://c> <ex://q> ?d .
    }
  }
}`,
      );
    });

    it('keeps sameTerm(?z, ?z) for a variable an OPTIONAL may leave unbound', ({ expect }) => {
      // The counterpart of the fold in 'condition handling': ?z is only *possibly* bound, so
      // `sameTerm(?z, ?z)` is an error rather than `true` there - and there is nothing to rewrite it into
      // either, since `COALESCE` tells that error apart from the `false` of `bound(?z)`.
      expectTransform(
        expect,
        `SELECT * WHERE {
          ?x :p ?y
          OPTIONAL { ?x :q ?z }
          FILTER(sameTerm(?x, :c) && (sameTerm(?z, ?z) || ?z > 2))
        }`,
        `SELECT ?x ?y ?z WHERE {
  {
    <ex://c> <ex://p> ?y .
    BIND( <ex://c> AS ?x )
  }
  OPTIONAL {
    {
      <ex://c> <ex://q> ?z .
      BIND( <ex://c> AS ?x )
    }
  }
  FILTER ( ( SAMETERM( ?z , ?z ) || ( ?z > "2"^^<http://www.w3.org/2001/XMLSchema#integer> ) ) )
}`,
      );
    });

    it('keeps a weak assertion above the OPTIONAL that may bind its variable', ({ expect }) => {
      // The weak form goes into the left hand side of a left join, never into the right: if the left
      // leaves ?z unbound and the right binds it to another term, the merged solution is the one the
      // assertion discards - and pruning the right would instead let the unmatched left row through.
      expectTransform(
        expect,
        `SELECT * WHERE {
          ?x :p ?y
          OPTIONAL { ?x :q ?z }
          FILTER((!bound(?z) || sameTerm(?z, :c)) && sameTerm(?x, :a))
        }`,
        `SELECT ?x ?y ?z WHERE {
  {
    <ex://a> <ex://p> ?y .
    BIND( <ex://a> AS ?x )
  }
  OPTIONAL {
    {
      <ex://a> <ex://q> ?z .
      BIND( <ex://a> AS ?x )
    }
  }
  FILTER ( ( ! BOUND( ?z ) || SAMETERM( ?z , <ex://c> ) ) )
}`,
      );
    });

    it('empties a pattern that would need a triple term in the subject position', ({ expect }) => {
      // A ground triple term is a term like any other, so it pins `?t` - and `?t` only ever occurs in a
      // subject position, whose range holds no `Quad`, so this asks for a triple that cannot exist rather
      // than for a filter. `normalisedFor` proves that off the range before the assertion reaches the
      // pattern; `canOccupy` refusing to substitute it there says the same thing one step later.
      expectTransform(
        expect,
        'SELECT * WHERE { ?t :p ?w FILTER(sameTerm(?t, <<( :a :b :c )>>)) }',
        `SELECT ?t ?w WHERE {
  ?t <ex://p> ?w .
  FILTER ( FALSE )
}`,
      );
    });

    it('lets a ground triple term BIND pin the clique of its target', ({ expect }) => {
      // The construction is infallible for ground components, so `?t` is certainly bound and the term
      // travels onto `?y` - which the pattern restricts to a subject, a position holding no triple term,
      // so the operation is empty. The *fallible* version is the test below, where the rows leaving `?t`
      // unbound are real.
      expectTransform(
        expect,
        'SELECT * WHERE { ?y :p ?w BIND(<<( :a :b :c )>> AS ?t) FILTER(sameTerm(?t, ?y)) }',
        `SELECT ?t ?w ?y WHERE {
  {
    ?y <ex://p> ?w .
    BIND( <<( <ex://a> <ex://b> <ex://c> )>> AS ?t )
  }
  FILTER ( FALSE )
}`,
      );
    });

    it('does not let a fallible triple term BIND pin the clique of its target', ({ expect }) => {
      // `?w` may be a literal, in which case the construction errors and leaves `?t` unbound - so nothing
      // *transfers* onto the expression, and the edge stays an edge.
      //
      // The plan is still empty, and for a reason that has nothing to do with the transfer: the edge
      // implies both of its endpoints are bound, `?t` bound is a triple term ({Quad}), and `?y` is a
      // subject. Those two ranges meet in nothing, so the group holds no value at all.
      expectTransform(
        expect,
        'SELECT * WHERE { ?y :p ?w BIND(<<( ?w :b :c )>> AS ?t) FILTER(sameTerm(?t, ?y)) }',
        `SELECT ?t ?w ?y WHERE {
  {
    ?y <ex://p> ?w .
    BIND( <<( ?w <ex://b> <ex://c> )>> AS ?t )
  }
  FILTER ( FALSE )
}`,
      );
    });

    it('substitutes a ground triple term into the object position it can occupy', ({ expect }) => {
      expectTransform(
        expect,
        'SELECT * WHERE { ?s :p ?t FILTER(sameTerm(?t, <<( :a :b :c )>>)) }',
        `SELECT ?s ( <<( <ex://a> <ex://b> <ex://c> )>> AS ?t ) WHERE {
  ?s <ex://p> <<( <ex://a> <ex://b> <ex://c> )>> .
}`,
      );
    });

    it('substitutes it into a pattern carrying a graph of its own', ({ expect }) => {
      // {@link parseQuery} asks for quads, so a GRAPH clause is the *graph component* of the patterns
      // below it rather than an operation - the usual shape, and the one where a pattern holds both a
      // graph and a triple term at once. The two positions have to stay apart: the term lands in the
      // object, and the graph is left to say which graph the triple is in.
      expectTransform(
        expect,
        'SELECT * WHERE { GRAPH ?g { ?s :p ?t } FILTER(sameTerm(?t, <<( :a :b :c )>>)) }',
        `SELECT ?g ?s ( <<( <ex://a> <ex://b> <ex://c> )>> AS ?t ) WHERE {
  GRAPH ?g {
    ?s <ex://p> <<( <ex://a> <ex://b> <ex://c> )>> .
  }
}`,
      );
    });

    it('empties a graph-carrying pattern that would need one in its subject position', ({ expect }) => {
      // The other half: the graph component does not make the subject any more accommodating.
      expectTransform(
        expect,
        'SELECT * WHERE { GRAPH ?g { ?t :p ?w } FILTER(sameTerm(?t, <<( :a :b :c )>>)) }',
        `SELECT ?g ?t ?w WHERE {
  GRAPH ?g {
    {
      ?t <ex://p> ?w .
      FILTER ( FALSE )
    }
  }
}`,
      );
    });

    it('meets no blank node, because the parse turned them into variables', ({ expect }) => {
      // What lets `isAssertableTerm` admit a blank node - and so lets the constant folding decide
      // `sameTerm` between two of them. A blank node label in an expression would be a fresh label
      // rather than a reference to one in the data, so nothing could be concluded from it.
      expect(transform(`SELECT * WHERE {
        ?x :p [ :q ?y ]
        FILTER(sameTerm(?x, :c))
      }`)).toBe(`SELECT ( <ex://c> AS ?x ) ?y WHERE {
  ?g_0 <ex://q> ?y .
  <ex://c> <ex://p> ?g_0 .
}`);
    });

    it('leaves the input tree untouched', ({ expect }) => {
      const algebra = parseQuery(c, `${prefixes}SELECT * WHERE {
        { { ?x :p ?y } UNION { ?z :q ?w } }
        ?x :r ?b
        OPTIONAL { ?x :s ?t }
        FILTER(sameTerm(?x, :c))
      }`);
      const before = JSON.stringify(algebra);
      pushDownAssertions(c, algebra);
      expect(JSON.stringify(algebra)).toEqual(before);
    });

    it('applying the transformation twice yields the same result as once', ({ expect }) => {
      const query = `${prefixes}SELECT * WHERE {
        { { ?x :p ?y } UNION { ?z :q ?w } }
        OPTIONAL { ?x :s ?t }
        { SELECT ?x ?b WHERE { ?x :r ?b } LIMIT 5 }
        FILTER(sameTerm(?x, :c))
      }`;
      const once = pushDownAssertions(c, parseQuery(c, query));
      const twice = pushDownAssertions(c, pushDownAssertions(c, parseQuery(c, query)));
      expect(c.generator.generate(toAst(twice))).toEqual(c.generator.generate(toAst(once)));
    });
  });

  describe('structural assertions', () => {
    it('materialises a shape into a triple term pattern, re-binding the variable', ({ expect }) => {
      // The pattern is what states the shape: `?s` written into the subject position is the equality the
      // condition carried, and the two coined variables are what the pattern binds the other positions
      // to. The `BIND` hands `?o` back the value the substitution took out of the pattern.
      expectTransform(
        expect,
        'SELECT * WHERE { ?s ?p ?o FILTER(sameTerm(subject(?o), ?s)) }',
        `SELECT ( <<( ?s ?o_p ?o_o )>> AS ?o ) ?p ?s WHERE {
  ?s ?p <<( ?s ?o_p ?o_o )>> .
}`,
      );
    });

    it('materialises the same shape into every operand a join gives it to', ({ expect }) => {
      // Both operands write the *same* names for the positions, which is what keeps them joining on the
      // triple term after both have been rewritten: the positions are functionally determined by the
      // value the two already joined on, so agreeing on `?o` is agreeing on `?o_p` and `?o_o`.
      expectTransform(
        expect,
        `SELECT * WHERE {
          { { ?t :holds ?o } UNION { ?t :mirrors ?o } }
          ?s :holds ?o
          FILTER(sameTerm(subject(?o), :a))
        }`,
        `SELECT ?o ?s ?t WHERE {
  {
    ?t <ex://holds> <<( <ex://a> ?o_p ?o_o )>> .
    BIND( <<( <ex://a> ?o_p ?o_o )>> AS ?o )
  }
  UNION {
    ?t <ex://mirrors> <<( <ex://a> ?o_p ?o_o )>> .
    BIND( <<( <ex://a> ?o_p ?o_o )>> AS ?o )
  }
  {
    ?s <ex://holds> <<( <ex://a> ?o_p ?o_o )>> .
    BIND( <<( <ex://a> ?o_p ?o_o )>> AS ?o )
  }
}`,
      );
    });

    it('coins a name the query does not already use', ({ expect }) => {
      // The candidate `?o_p` is taken by a variable of the query, so the position takes the first free
      // suffix instead - and the one nothing collides with keeps its plain name.
      expectTransform(
        expect,
        'SELECT * WHERE { ?s ?p ?o . ?a :q ?o_p FILTER(sameTerm(subject(?o), ?s)) }',
        `SELECT ?a ( <<( ?s ?o_p0 ?o_o )>> AS ?o ) ?o_p ?p ?s WHERE {
  ?s ?p <<( ?s ?o_p0 ?o_o )>> .
  ?a <ex://q> ?o_p .
}`,
      );
    });

    it('materialises a shape into a property path', ({ expect }) => {
      expectTransform(
        expect,
        'SELECT * WHERE { ?x :step* ?y FILTER(sameTerm(subject(?x), :a)) }',
        `SELECT ( <<( <ex://a> ?x_p ?x_o )>> AS ?x ) ?y WHERE {
  <<( <ex://a> ?x_p ?x_o )>> (<ex://step>*) ?y .
}`,
      );
    });

    it('keeps the kind of a position over the pattern that materialised it', ({ expect }) => {
      // A pattern states which term a position holds and which positions the value has; which *kind* of
      // term a variable takes is not something it states, so that conjunct stays a condition - written
      // about `?o`, which the re-binding above the pattern has bound, rather than about the variable
      // coined for the position.
      expectTransform(
        expect,
        'SELECT * WHERE { ?s ?p ?o FILTER(sameTerm(subject(?o), :a) && isIRI(object(?o))) }',
        `SELECT ?o ?p ?s WHERE {
  {
    ?s ?p <<( <ex://a> ?o_p ?o_o )>> .
    BIND( <<( <ex://a> ?o_p ?o_o )>> AS ?o )
  }
  FILTER ( ISIRI( OBJECT( ?o ) ) )
}`,
      );
    });

    it('drops the kind of a position the term written there already decides', ({ expect }) => {
      // The other side of the test above: `isIRI` says which kind of term the subject is, and the
      // pattern writes *which* term it is - a NamedNode, which is the kind. A term decides its own kind,
      // so the conjunct states nothing the pattern does not and is not written back, exactly as it is
      // not written back into a condition (`termTypeToState`).
      expectTransform(
        expect,
        'SELECT * WHERE { ?s ?p ?o FILTER(sameTerm(subject(?o), :a) && isIRI(subject(?o))) }',
          `SELECT ( <<( <ex://a> ?o_p ?o_o )>> AS ?o ) ?p ?s WHERE {
  ?s ?p <<( <ex://a> ?o_p ?o_o )>> .
}`,
      );
    });

    it('leaves a shape no position of which says anything as the condition it is', ({ expect }) => {
      // Writing it would coin three variables to state that the value is a triple term, which is what
      // `isTRIPLE(?o)` states without coining any - and the two have to be the one plan, being the one
      // fact reached two ways.
      const expected = `SELECT ?o ?p ?s WHERE {
  ?s ?p ?o .
  FILTER ( ISTRIPLE( ?o ) )
}`;
      expectTransform(expect, 'SELECT * WHERE { ?s ?p ?o FILTER(isTRIPLE(?o)) }', expected);
      expectTransform(expect, 'SELECT * WHERE { ?s ?p ?o FILTER(sameTerm(subject(?o), subject(?o))) }', expected);
    });

    it('substitutes a shape every position of which is decided, being a term after all', ({ expect }) => {
      expectTransform(
        expect,
        'SELECT * WHERE { ?s ?p ?o FILTER(sameTerm(?o, TRIPLE(:a, :b, :c))) }',
        `SELECT ( <<( <ex://a> <ex://b> <ex://c> )>> AS ?o ) ?p ?s WHERE {
  ?s ?p <<( <ex://a> <ex://b> <ex://c> )>> .
}`,
      );
    });

    it('reads a triple term construction as one conjunct per position', ({ expect }) => {
      // Not written back as itself: as *conjuncts of a FILTER* the two agree, differing only where one is
      // `false` and the other an error, which a FILTER discards either way.
      expectTransform(
        expect,
        'SELECT * WHERE { ?s ?p ?o FILTER(sameTerm(?o, TRIPLE(?s, ?p, :c))) }',
        `SELECT ( <<( ?s ?p <ex://c> )>> AS ?o ) ?p ?s WHERE {
  ?s ?p <<( ?s ?p <ex://c> )>> .
}`,
      );
    });

    it('empties the plan where the position a shape lands in holds no triple term', ({ expect }) => {
      // No triple has a triple term as its subject, which the *group* range decides before anything
      // downstream has to type-check a term.
      expectTransform(
        expect,
        'SELECT * WHERE { ?s ?p ?o FILTER(isTRIPLE(?s)) }',
        `SELECT ?o ?p ?s WHERE {
  ?s ?p ?o .
  FILTER ( FALSE )
}`,
      );
    });

    it('collapses an OPTIONAL over a structurally asserted variable into a join (FLBndII)', ({ expect }) => {
      // A shape implies `bnd(?z)`, and `?z ∉ pVars` of the left hand side, so the anti-join half of the
      // left join produces nothing the assertion keeps.
      expectTransform(
        expect,
        'SELECT * WHERE { ?s ?p ?o OPTIONAL { ?o :q ?z } FILTER(isTRIPLE(?z)) }',
        `SELECT ?o ?p ?s ?z WHERE {
  ?s ?p ?o .
  ?o <ex://q> ?z .
  FILTER ( ISTRIPLE( ?z ) )
}`,
      );
    });

    it('deletes the UNION branch that can never bind what the shape is about', ({ expect }) => {
      expectTransform(
        expect,
        'SELECT * WHERE { { ?s ?p ?o } UNION { ?s ?p ?q } FILTER(sameTerm(subject(?o), :a)) }',
        `SELECT ?o ?p ?q ?s WHERE {
  {
    ?s ?p <<( <ex://a> ?o_p ?o_o )>> .
    BIND( <<( <ex://a> ?o_p ?o_o )>> AS ?o )
  }
  UNION {
    ?s ?p ?q .
    FILTER ( FALSE )
  }
}`,
      );
    });

    it('keeps an edge reading through an accessor above a join no operand licenses it for', ({ expect }) => {
      // `?s` is bound by the union and `?o` by the pattern, so no single operand is licensed for the edge
      // - and dropping it rather than keeping it would be a wrong answer, not a missed optimisation.
      expectTransform(
        expect,
        `SELECT * WHERE {
          { { ?s :q ?x } UNION { ?s :q2 ?x } }
          ?y :r ?o
          FILTER(sameTerm(subject(?o), ?s))
        }`,
        `SELECT ?o ?s ?x ?y WHERE {
  {
    ?s <ex://q> ?x .
  }
  UNION {
    ?s <ex://q2> ?x .
  }
  ?y <ex://r> ?o .
  FILTER ( SAMETERM( SUBJECT( ?o ) , ?s ) )
}`,
      );
    });

    it('sends nothing into the right hand side of a MINUS that Θ holds only weakly', ({ expect }) => {
      // The argument for the RHS needs the surviving `μ₁` to *bind* `?o`: a compatible `μ₂` then either
      // misses `?o` or agrees with it on the value. Under the weak form `μ₁` may leave `?o` unbound, and
      // an RHS `μ₂` binding it to anything is still compatible - so filtering that `μ₂` out would keep a
      // `μ₁` the MINUS removes. The RHS is left alone.
      expectTransform(
        expect,
        `SELECT * WHERE {
          ?s :p ?y
          OPTIONAL { ?s :nosuch ?o }
          MINUS { ?s :value ?o }
          FILTER(!bound(?o) || isIRI(?o))
        }`,
        `SELECT ?o ?s ?y WHERE {
  {
    ?s <ex://p> ?y .
    OPTIONAL {
      ?s <ex://nosuch> ?o .
    }
    FILTER ( ( ! BOUND( ?o ) || ISIRI( ?o ) ) )
  }
  MINUS {
    ?s <ex://value> ?o .
  }
}`,
      );
    });

    it('sends the weak form of a shape into the right hand side of a MINUS', ({ expect }) => {
      // A unary predicate on the value is admissible there: the argument turns on the two sides agreeing
      // on that value. Here the RHS binds `?o` to a subject, which no triple term is, so it empties.
      expectTransform(
        expect,
        'SELECT * WHERE { ?y :r ?o MINUS { ?o :q ?z } FILTER(isTRIPLE(?o)) }',
        `SELECT ?o ?y WHERE {
  {
    ?y <ex://r> ?o .
    FILTER ( ISTRIPLE( ?o ) )
  }
  MINUS {
    {
      ?o <ex://q> ?z .
      FILTER ( FALSE )
    }
  }
}`,
      );
    });

    it('leaves the weak form of a shape weak where the variable may be unbound', ({ expect }) => {
      expectTransform(
        expect,
        'SELECT * WHERE { ?y :r ?o OPTIONAL { ?o :q ?z } FILTER(!bound(?z) || isTRIPLE(?z)) }',
        `SELECT ?o ?y ?z WHERE {
  ?y <ex://r> ?o .
  OPTIONAL {
    ?o <ex://q> ?z .
  }
  FILTER ( ( ! BOUND( ?z ) || ISTRIPLE( ?z ) ) )
}`,
      );
    });

    it('empties the plan where a position cannot be the kind of term asserted', ({ expect }) => {
      // The predicate of a triple term is an IRI, so no solution has a literal there - the same rule for
      // a position of a shape that `isLITERAL(?s)` is for a subject of a pattern.
      expectTransform(
        expect,
        'SELECT * WHERE { ?s ?p ?o FILTER(isLITERAL(predicate(?o))) }',
        `SELECT ?o ?p ?s WHERE {
  ?s ?p ?o .
  FILTER ( FALSE )
}`,
      );
    });

    it('states the kind of term without restating that it is a triple term', ({ expect }) => {
      expectTransform(
        expect,
        'SELECT * WHERE { ?s ?p ?o FILTER(isIRI(subject(?o))) }',
        `SELECT ?o ?p ?s WHERE {
  ?s ?p ?o .
  FILTER ( ISIRI( SUBJECT( ?o ) ) )
}`,
      );
    });

    it('empties the plan on a kind of term the position of a pattern cannot hold', ({ expect }) => {
      expectTransform(
        expect,
        'SELECT * WHERE { ?s ?p ?o FILTER(isLITERAL(?s)) }',
        `SELECT ?o ?p ?s WHERE {
  ?s ?p ?o .
  FILTER ( FALSE )
}`,
      );
    });

    it('reads `isURI` as the synonym of `isIRI` that it is', ({ expect }) => {
      // Written back as `isIRI`, which is the same non-verbatim round trip the other forms make.
      expectTransform(
        expect,
        'SELECT * WHERE { ?s ?p ?o FILTER(isURI(?o)) }',
        `SELECT ?o ?p ?s WHERE {
  ?s ?p ?o .
  FILTER ( ISIRI( ?o ) )
}`,
      );
    });

    it('prunes the VALUES rows holding another kind of term', ({ expect }) => {
      // A row decides which kind of term its column holds, so the assertion is discharged here rather
      // than left on top - what it cannot decide is a *position* of one.
      expectTransform(
        expect,
        'SELECT * WHERE { VALUES (?o) { (:a) ("l") (:b) } FILTER(isIRI(?o)) }',
        `SELECT ?o WHERE {
  VALUES ?o {
    <ex://a>
    <ex://b>
  }
}`,
      );
    });

    it('drops an `isTRIPLE` the position read beside it already entails', ({ expect }) => {
      // `SUBJECT(?o)` cannot be read of anything but a triple term, so `isTRIPLE(?o)` beside it states a
      // second time what the row already has to satisfy. Writing both back would grow the condition on
      // every run of the pass, which is why the shape states it only where no position of it says
      // anything at all.
      expectTransform(
        expect,
        'SELECT * WHERE { ?s ?p ?o FILTER(isTRIPLE(?o) && sameTerm(subject(?o), :a)) }',
        `SELECT ( <<( <ex://a> ?o_p ?o_o )>> AS ?o ) ?p ?s WHERE {
  ?s ?p <<( <ex://a> ?o_p ?o_o )>> .
}`,
      );
    });

    it('drops it whichever way round the two are met', ({ expect }) => {
      // The order they arrive in is not the order Θ decomposes into, so neither spelling can keep it -
      // including the one where they arrive as two filters and the second is absorbed into the first.
      const expected = `SELECT ( <<( <ex://a> ?o_p ?o_o )>> AS ?o ) ?p ?s WHERE {
  ?s ?p <<( <ex://a> ?o_p ?o_o )>> .
}`;
      expectTransform(
        expect,
        'SELECT * WHERE { ?s ?p ?o FILTER(sameTerm(subject(?o), :a) && isTRIPLE(?o)) }',
        expected,
      );
      expectTransform(
        expect,
        'SELECT * WHERE { ?s ?p ?o FILTER(isTRIPLE(?o)) FILTER(sameTerm(subject(?o), :a)) }',
        expected,
      );
    });

    it('reads and writes back a chain of accessors', ({ expect }) => {
      // Two levels down, which is where a chain can go at all: only the object of a triple term holds
      // another one. Written back as the chain it was read from, and it re-parses as one.
      expectTransform(
        expect,
        'SELECT * WHERE { { ?s ?p ?o } UNION { ?x ?y ?z } FILTER(sameTerm(subject(object(?o)), :subj)) }',
        `SELECT ?o ?p ?s ?x ?y ?z WHERE {
  {
    ?s ?p <<( ?o_s ?o_p <<( <ex://subj> ?o_o_p ?o_o_o )>> )>> .
    BIND( <<( ?o_s ?o_p <<( <ex://subj> ?o_o_p ?o_o_o )>> )>> AS ?o )
  }
  UNION {
    ?x ?y ?z .
    FILTER ( FALSE )
  }
}`,
      );
    });

    it('reads an `=` against an IRI over a chain as the `sameTerm` it is', ({ expect }) => {
      // `=` and `sameTerm` coincide against an IRI - `=` only raises a type error where both sides are
      // literals - so the fold rewrites it before the recognisers ever see it.
      expectTransform(
        expect,
        'SELECT * WHERE { { ?s ?p ?o } UNION { ?x ?y ?z } FILTER(subject(object(?o)) = :subj) }',
        `SELECT ?o ?p ?s ?x ?y ?z WHERE {
  {
    ?s ?p <<( ?o_s ?o_p <<( <ex://subj> ?o_o_p ?o_o_o )>> )>> .
    BIND( <<( ?o_s ?o_p <<( <ex://subj> ?o_o_p ?o_o_o )>> )>> AS ?o )
  }
  UNION {
    ?x ?y ?z .
    FILTER ( FALSE )
  }
}`,
      );
    });

    it('reads `sameTerm(a, a)` over an accessor as what it reads *through* being a triple term', ({ expect }) => {
      // Not that `SUBJECT(?o)` is a triple term - that would be unsatisfiable, no subject being one.
      // Asserting the access shapes the groups on the way to it and leaves the one it names alone.
      expectTransform(
        expect,
        'SELECT * WHERE { ?s ?p ?o FILTER(sameTerm(subject(?o), subject(?o))) }',
        `SELECT ?o ?p ?s WHERE {
  ?s ?p ?o .
  FILTER ( ISTRIPLE( ?o ) )
}`,
      );
    });

    it('empties the plan where a chain would make a value its own position', ({ expect }) => {
      // `OBJECT(?o) ≡ OBJECT(OBJECT(?o))` asks a triple term to be its own object, which the occurs
      // check refuses: a triple term is strictly larger than each of its positions.
      expectTransform(
        expect,
        'SELECT * WHERE { ?s ?p ?o FILTER(sameTerm(object(object(?o)), object(?o))) }',
        `SELECT ?o ?p ?s WHERE {
  ?s ?p ?o .
  FILTER ( FALSE )
}`,
      );
    });

    it('leaves the input tree untouched', ({ expect }) => {
      const algebra = parseQuery(c, `${prefixes}SELECT * WHERE {
        ?s ?p ?o
        OPTIONAL { ?o :q ?z }
        FILTER(sameTerm(subject(?o), ?s) && isTRIPLE(?z) && isIRI(?p))
      }`);
      const before = JSON.stringify(algebra);
      pushDownAssertions(c, algebra);
      expect(JSON.stringify(algebra)).toEqual(before);
    });
  });

  describe('semantic equivalence (evaluation)', () => {
    const engine = new QueryEngine();

    async function bindings(query: string): Promise<string[]> {
      const stream = await engine.queryBindings(query, {
        sources: [ './test/statics/assertionPushdown.ttl' ],
      });
      const rows: any[] = await arrayifyStream(stream);
      // Sorted, but duplicates kept: the multiplicity of every row is part of the answer.
      return rows
        .map(row => [ ...row ].map(([ k, v ]: [any, any]) => `${k.value}=${v.value}`).sort().join('|'))
        .sort();
    }

    async function assertEquivalent(
      expect: typeof Expect,
      query: string,
      expectedRows: number,
    ): Promise<void> {
      const original = await bindings(prefixes + query);
      const transformed = await bindings(transform(query));
      expect(transformed).toEqual(original);
      expect(original).toHaveLength(expectedRows);
    }

    it('still yields one solution when the VALUES collapses to the empty BGP', async({ expect }) => {
      await assertEquivalent(expect, `SELECT * WHERE {
        VALUES (?x) { (:a) (:b) }
        FILTER(sameTerm(?x, :a))
      }`, 1);
    });

    it('keeps one solution per row of a VALUES the assertion strips every column from', async({ expect }) => {
      // The empty BGP is one empty solution mapping, so it may only replace a *single* remaining row.
      await assertEquivalent(expect, `SELECT * WHERE {
        VALUES (?x) { (:a) (:a) (:b) }
        FILTER(sameTerm(?x, :a))
      }`, 2);
    });

    it('keeps the multiplicities a UNION produces', async({ expect }) => {
      await assertEquivalent(expect, `SELECT * WHERE {
        { { ?x :p ?y } UNION { ?x :p ?y } }
        FILTER(sameTerm(?x, :a))
      }`, 2);
    });

    it('keeps the per-pair witness count of a property path', async({ expect }) => {
      await assertEquivalent(expect, `SELECT ?x ?y WHERE {
        ?x :step/:onwards ?y
        FILTER(sameTerm(?x, :a))
      }`, 2);
    });

    it('matches the ground triple term it substituted into the object position', async({ expect }) => {
      await assertEquivalent(expect, `SELECT * WHERE {
        ?s :says ?t
        FILTER(sameTerm(?t, <<( :a :p :shared )>>))
      }`, 1);
    });

    it('keeps a MINUS whose right hand side shares only the object variable', async({ expect }) => {
      // The trap: a strong prune empties the right hand side by (FBndII), `A ∖ Empty ≡ A` deletes the
      // MINUS, and the query returns everything where the answer is nothing.
      await assertEquivalent(expect, `SELECT * WHERE {
        ?x :p ?y
        MINUS { ?z :q ?y }
        FILTER(sameTerm(?x, :a))
      }`, 0);
    });

    it('still removes the row when the right hand side of a MINUS is pruned strongly', async({ expect }) => {
      // The other side of the previous test: here the right hand side binds the asserted variable
      // certainly, so the weak form promotes and the prune *is* strong. It has to keep `:b :q :shared`,
      // which is what removes the only answer - pruning one term too many would yield a row.
      await assertEquivalent(expect, `SELECT * WHERE {
        ?x :p ?y
        MINUS { ?z :q ?y }
        FILTER(sameTerm(?y, :shared))
      }`, 0);
    });

    it('keeps the UNDEF row of a VALUES on the right of a MINUS', async({ expect }) => {
      // The UNDEF row is what excludes the only answer: dropping it - as a strong prune would - turns
      // the empty answer into one row.
      await assertEquivalent(expect, `SELECT * WHERE {
        ?x :p ?y
        MINUS { VALUES (?x ?y) { (:d :shared) (UNDEF :shared) } }
        FILTER(sameTerm(?x, :a))
      }`, 0);
    });

    it('keeps the join rows whose operand never bound the asserted variable', async({ expect }) => {
      // The trap the demotion has to avoid: the right branch of the union does not bind ?x, so a
      // *strong* push into the union would empty it by (FBndII) and lose the row it contributes. The
      // weak form keeps it, because an unbound ?x satisfies it.
      await assertEquivalent(expect, `SELECT * WHERE {
        { { ?x :p ?y } UNION { ?z :q ?w } }
        { SELECT ?x ?d WHERE { ?x :r ?d } }
        FILTER(sameTerm(?x, :a))
      }`, 2);
    });

    it('keeps the OPTIONAL rows whose left hand side never bound the asserted variable', async({ expect }) => {
      // The same trap on the left of a left join, where the row survives by being completed from the
      // right hand side instead.
      await assertEquivalent(expect, `SELECT * WHERE {
        { { ?x :p ?y } UNION { ?z :q ?w } }
        OPTIONAL { ?x :r ?d }
        FILTER(sameTerm(?x, :a))
      }`, 2);
    });

    it('keeps the union branch an `!bound` leaves alone while emptying the other', async({ expect }) => {
      // The left branch binds ?y certainly and becomes empty; the right one cannot bind it at all and
      // is untouched. Getting either direction of that backwards changes the answer.
      await assertEquivalent(expect, `SELECT * WHERE {
        { { ?x :p ?y } UNION { ?a :r ?d } }
        FILTER(!bound(?y))
      }`, 1);
    });

    it('keeps the UNDEF rows when `!bound` takes the column out of a VALUES', async({ expect }) => {
      await assertEquivalent(expect, `SELECT * WHERE {
        VALUES (?x ?y) { (:a 1) (UNDEF 2) }
        FILTER(!bound(?x))
      }`, 1);
    });

    it('does not match a literal with another lexical form (sameTerm, not =)', async({ expect }) => {
      await assertEquivalent(expect, `SELECT * WHERE {
        ?s :value ?o
        FILTER(sameTerm(?o, "01"^^xsd:integer))
      }`, 0);
      // The very same query under `=` does match, which is why this pass may never generalise to `=`.
      expect(await bindings(`${prefixes}SELECT * WHERE {
        ?s :value ?o
        FILTER(?o = "01"^^xsd:integer)
      }`)).toHaveLength(1);
    });

    it('keeps the row an equality against a literal matches', async({ expect }) => {
      // The regression the IRI case has to stay clear of: reading this `=` as an assertion would
      // substitute "01"^^xsd:integer into the pattern and lose the row holding "1"^^xsd:integer.
      await assertEquivalent(expect, `SELECT * WHERE {
        ?s :value ?o
        FILTER(?o = "01"^^xsd:integer)
      }`, 1);
    });

    it('matches what an equality against an IRI matched', async({ expect }) => {
      await assertEquivalent(expect, `SELECT * WHERE {
        ?x :p ?y
        FILTER(?x = :a)
      }`, 1);
    });

    it('keeps an OPTIONAL turned into a join equivalent', async({ expect }) => {
      await assertEquivalent(expect, `SELECT * WHERE {
        ?x :step ?m
        OPTIONAL { ?m :onwards ?y }
        FILTER(sameTerm(?y, :end))
      }`, 2);
    });

    it('keeps the OPTIONAL rows a `bound` turns into a join', async({ expect }) => {
      // Only the subjects `:r` reaches survive, and they survive exactly once.
      await assertEquivalent(expect, `SELECT * WHERE {
        ?s ?p2 ?o
        OPTIONAL { ?s :r ?d }
        FILTER(bound(?d))
      }`, 6);
    });

    it('keeps the join rows whose operand never bound the variable `bound` asserts', async({ expect }) => {
      // The trap the missing weak form of `bound(?x)` avoids: the right operand leaves ?x unbound, and
      // the merged mapping still binds it from the left one. Pruning that operand would lose the row.
      await assertEquivalent(expect, `SELECT * WHERE {
        { ?s :p ?y OPTIONAL { ?s :r ?x } }
        { SELECT ?z ?w ?x WHERE { ?z :q ?w OPTIONAL { ?z :r ?x } } }
        FILTER(bound(?x))
      }`, 1);
    });

    it('keeps the union branch a `bound` leaves alone while emptying the other', async({ expect }) => {
      await assertEquivalent(expect, `SELECT * WHERE {
        { { ?s :p ?y } UNION { ?z :r ?x } }
        FILTER(bound(?x))
      }`, 1);
    });

    it('keeps exactly the rows whose two variables are the same term', async({ expect }) => {
      // `:loop` is its own object twice and `:other` once, so a rewrite that changed multiplicities -
      // or that matched the pairs `:loop :self :other` too - would show here.
      await assertEquivalent(expect, `SELECT * WHERE {
        ?s ?p ?o
        FILTER(sameTerm(?s, ?o))
      }`, 3);
    });

    it('keeps the multiplicities a UNION produces over a unification', async({ expect }) => {
      await assertEquivalent(expect, `SELECT * WHERE {
        { { ?s :self ?o } UNION { ?s :self ?o } }
        FILTER(sameTerm(?s, ?o))
      }`, 4);
    });

    it('keeps the MINUS a unification must not be pushed into', async({ expect }) => {
      // The trap the missing weak form of a clique avoids: pruning the right hand side by `?s ≡ ?o` -
      // which it has no anchor for - would stop it removing the `:loop` row, and yield two rows here.
      await assertEquivalent(expect, `SELECT * WHERE {
        ?s :self ?o
        MINUS { ?o :twice ?x }
        FILTER(sameTerm(?s, ?o))
      }`, 1);
    });

    it('keeps the per-pair witness count of a path whose two ends are unified', async({ expect }) => {
      // `:cyc` reaches itself through two intermediate witnesses, so the pair has multiplicity two.
      await assertEquivalent(expect, `SELECT ?x ?y WHERE {
        ?x :step/:onwards ?y
        FILTER(sameTerm(?x, ?y))
      }`, 2);
    });

    it('keeps the rows an OPTIONAL turned into a join by a unification selects', async({ expect }) => {
      await assertEquivalent(expect, `SELECT * WHERE {
        ?s :self ?o
        OPTIONAL { ?o :twice ?x }
        FILTER(sameTerm(?x, ?o))
      }`, 1);
    });

    it('keeps the rows a clique split over a join selects', async({ expect }) => {
      await assertEquivalent(expect, `SELECT * WHERE {
        { SELECT ?w ?x WHERE { ?w :self ?x } }
        { SELECT ?y ?z WHERE { ?y :twice ?z } }
        FILTER(sameTerm(?w, ?x) && sameTerm(?x, ?y) && sameTerm(?y, ?z))
      }`, 1);
    });

    it('keeps the VALUES rows whose two columns agree', async({ expect }) => {
      await assertEquivalent(expect, `SELECT * WHERE {
        VALUES (?s ?o) { (:a :a) (:a :b) (UNDEF :c) (:d :d) }
        FILTER(sameTerm(?s, ?o))
      }`, 2);
    });

    it('keeps the rows a unification transferred through a BIND selects', async({ expect }) => {
      await assertEquivalent(expect, `SELECT * WHERE {
        ?z :self ?y
        BIND(?z AS ?t)
        FILTER(sameTerm(?t, ?y))
      }`, 2);
    });

    it('keeps the rows a constant BIND pinning a unification selects', async({ expect }) => {
      await assertEquivalent(expect, `SELECT * WHERE {
        ?y :self ?w
        BIND(:loop AS ?t)
        FILTER(sameTerm(?t, ?y))
      }`, 2);
    });

    it('keeps the rows a term meeting a unification selects', async({ expect }) => {
      await assertEquivalent(expect, `SELECT * WHERE {
        ?s :self ?o
        FILTER(sameTerm(?s, ?o) && sameTerm(?o, :loop))
      }`, 1);
    });

    it('keeps the rows a `bound` completing a weak assertion selects', async({ expect }) => {
      // The two conjuncts come to `sameTerm(?y, :end)`, which the OPTIONAL then becomes a join for.
      await assertEquivalent(expect, `SELECT * WHERE {
        ?s :step ?m
        OPTIONAL { ?m :onwards ?y }
        FILTER(bound(?y) && (!bound(?y) || sameTerm(?y, :end)))
      }`, 2);
    });

    it('keeps the rows the subject of a triple term agrees with its own subject on', async({ expect }) => {
      // The target of this whole feature: `:a` and `:c` say a triple term whose subject is themselves,
      // `:b` says one whose subject is someone else, and `:d` says something that is not a triple term
      // at all - where the accessor errors, and the FILTER discards the row rather than the query
      // failing.
      await assertEquivalent(expect, `SELECT * WHERE {
        ?s :says ?o
        FILTER(sameTerm(subject(?o), ?s))
      }`, 2);
    });

    it('returns nothing rather than erroring where the variable is no triple term', async({ expect }) => {
      await assertEquivalent(expect, `SELECT * WHERE {
        ?s :says ?o
        FILTER(sameTerm(subject(?o), :notATripleTerm))
      }`, 0);
    });

    it('keeps the rows a shape selects, the parts of it decided one at a time', async({ expect }) => {
      await assertEquivalent(expect, `SELECT * WHERE {
        ?s :says ?o
        FILTER(sameTerm(predicate(?o), :p) && sameTerm(object(?o), :shared))
      }`, 1);
    });

    it('keeps the rows a triple term construction selects', async({ expect }) => {
      // Read as one conjunct per position, which is not how it was written - and equivalent to it as a
      // conjunct of a FILTER, where `false` and an error both discard the row.
      await assertEquivalent(expect, `SELECT * WHERE {
        ?s :says ?o
        FILTER(sameTerm(?o, TRIPLE(?s, :p, :shared)))
      }`, 1);
    });

    it('keeps the rows a bare shape selects', async({ expect }) => {
      await assertEquivalent(expect, `SELECT * WHERE {
        ?s :says ?o
        FILTER(isTRIPLE(?o))
      }`, 3);
    });

    it('keeps the rows a shape pushed weakly into a join operand selects', async({ expect }) => {
      // `?o` is bound by one operand only, so the other takes the *weak* form - and the rows it leaves
      // `?o` unbound in have to survive that.
      await assertEquivalent(expect, `SELECT * WHERE {
        { ?s :says ?o } UNION { ?s :p ?y }
        ?s :says ?any
        FILTER(!bound(?o) || isTRIPLE(?o))
      }`, 4);
    });

    it('keeps the rows a shape over a VALUES with an UNDEF column selects', async({ expect }) => {
      // The UNDEF row leaves `?s` to the pattern, so it contributes every triple term whose subject is
      // the subject that says it; `:d` says something that is no triple term, and drops.
      await assertEquivalent(expect, `SELECT * WHERE {
        VALUES (?s ?x) { (:a :one) (UNDEF :two) (:d :three) }
        ?s :says ?o
        FILTER(sameTerm(subject(?o), ?s))
      }`, 3);
    });

    it('keeps the rows a shape on the right hand side of a MINUS removes', async({ expect }) => {
      // The RHS takes the weak form, which is what keeps it from removing the rows the LHS binds `?o`
      // in and the RHS does not.
      await assertEquivalent(expect, `SELECT * WHERE {
        ?s :says ?o
        MINUS { ?z :says ?o FILTER(sameTerm(?z, :a)) }
        FILTER(isTRIPLE(?o))
      }`, 2);
    });

    it('keeps the rows a kind of term selects', async({ expect }) => {
      // `:a :value "1"^^xsd:integer` is the only literal object in the fixture.
      await assertEquivalent(expect, `SELECT * WHERE {
        ?s ?p ?o
        FILTER(isLITERAL(?o))
      }`, 1);
    });

    it('keeps the rows a kind of term over a position of a triple term selects', async({ expect }) => {
      // Every triple term in the fixture has an IRI subject, and `:d` says something that is no triple
      // term at all - where the accessor errors and the row drops.
      await assertEquivalent(expect, `SELECT * WHERE {
        ?s :says ?o
        FILTER(isIRI(subject(?o)))
      }`, 3);
    });

    it('returns nothing for a kind of term no position can hold', async({ expect }) => {
      await assertEquivalent(expect, `SELECT * WHERE {
        ?s :says ?o
        FILTER(isLITERAL(subject(?o)))
      }`, 0);
    });

    it('keeps the rows a weak kind of term leaves under an OPTIONAL', async({ expect }) => {
      await assertEquivalent(expect, `SELECT * WHERE {
        ?s :says ?any
        OPTIONAL { ?s :value ?o }
        FILTER(!bound(?o) || isLITERAL(?o))
      }`, 4);
    });

    it('keeps the rows a MINUS removes through a variable Θ holds only weakly', async({ expect }) => {
      // `:a :value "1"` is an RHS solution binding `?o` to a literal, and the LHS leaves `?o` unbound -
      // compatible, sharing `?s`, so it removes the row. An RHS pruned by the weak `isIRI(?o)` would not
      // have, and the row would come back.
      await assertEquivalent(expect, `SELECT * WHERE {
        ?s :p ?y
        OPTIONAL { ?s :nosuch ?o }
        MINUS { ?s :value ?o }
        FILTER(!bound(?o) || isIRI(?o))
      }`, 0);
      // The same over a subject that has more to say, so the answer is not empty for want of anything to
      // remove: `:a` goes, the other three stay.
      await assertEquivalent(expect, `SELECT * WHERE {
        ?s :says ?y
        OPTIONAL { ?s :nosuch ?o }
        MINUS { ?s :value ?o }
        FILTER(!bound(?o) || isIRI(?o))
      }`, 3);
    });

    it('keeps the rows an `isTRIPLE` selected once the pass has dropped it', async({ expect }) => {
      // The half that matters: dropping a conjunct is only sound where something else enforces it. `:d`
      // says a term that is not a triple one, and it has to be gone from the answer even though the
      // rewritten plan no longer mentions `isTRIPLE` - the accessor errors on it, and the FILTER drops
      // the row.
      await assertEquivalent(expect, `SELECT * WHERE {
        ?s :says ?o
        FILTER(isTRIPLE(?o) && sameTerm(subject(?o), :a))
      }`, 2);
    });

    it('keeps the rows a chain of accessors selects', async({ expect }) => {
      // `:e` nests a triple term inside one, `:f` holds an IRI there - so reading two levels down errors
      // on `:f` and the row drops, which is the answer the rewritten plan has to reproduce.
      await assertEquivalent(expect, `SELECT * WHERE {
        ?s :nests ?o
        FILTER(sameTerm(subject(object(?o)), :b))
      }`, 1);
    });

    it('keeps the rows an `=` over a chain selects', async({ expect }) => {
      await assertEquivalent(expect, `SELECT * WHERE {
        ?s :nests ?o
        FILTER(subject(object(?o)) = :b)
      }`, 1);
    });

    it('keeps the rows `sameTerm(a, a)` over an accessor selects', async({ expect }) => {
      // Both rows hold a triple term, so both survive - the assertion is about `?o`, not about the
      // subject it reads.
      await assertEquivalent(expect, `SELECT * WHERE {
        ?s :nests ?o
        FILTER(sameTerm(subject(?o), subject(?o)))
      }`, 2);
    });

    it('keeps the rows two operands materialising the same shape join on', async({ expect }) => {
      // Both operands of the join are licensed for the shape, so both write it out - and after that they
      // join on the variables coined for its positions as well as on `?o`. That is only sound because
      // both sites coined the same names for the same positions, which is what the shared namer is for;
      // two independently named sites would join on nothing and multiply the rows out.
      await assertEquivalent(expect, `SELECT * WHERE {
        { { ?t :holds ?o } UNION { ?t :mirrors ?o } }
        ?s :holds ?o
        FILTER(sameTerm(subject(?o), :a))
      }`, 2);
    });

    it('keeps the rows a kind of term selects over a materialised position', async({ expect }) => {
      // The shape reaches the pattern and the kind of term stays a condition over it, read through the
      // variable the re-binding gave back rather than through the one coined for the position.
      await assertEquivalent(expect, `SELECT * WHERE {
        ?s :says ?o
        FILTER(sameTerm(subject(?o), :a) && isIRI(object(?o)))
      }`, 2);
    });

    it('keeps the rows an OPTIONAL collapsed by a shape selects', async({ expect }) => {
      await assertEquivalent(expect, `SELECT * WHERE {
        ?s :p ?y
        OPTIONAL { ?s :says ?o }
        FILTER(isTRIPLE(?o))
      }`, 1);
    });
  });
});
