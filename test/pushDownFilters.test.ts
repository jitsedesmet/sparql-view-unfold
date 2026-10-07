import { QueryEngine } from '@comunica/query-sparql-file';
import type * as RDF from '@rdfjs/types';
import { Algebra } from '@traqula/algebra-transformations-1-2';
import * as arrayifyStreamNS from 'arrayify-stream';
import { Parser, Store } from 'n3';
import type { expect as Expect } from 'vitest';
import { describe, it } from 'vitest';
import { toAst } from '../lib/generator/toAst.js';
import { pushDownFilters, pushDownFiltersTransformation } from '../lib/transformations/pushDownFilters.js';
import { createTransformationContext, parseQuery } from '../lib/transformContext.js';

// Crazy workaround to support both CJS and ESM
const arrayifyStream =
  (<any> arrayifyStreamNS).default ?? arrayifyStreamNS;

const prefixes = `PREFIX : <ex://>
PREFIX xsd: <http://www.w3.org/2001/XMLSchema#>
`;

describe('pushDownFilters', () => {
  // The pass only uses AF / DF / astTransformer from the context, never the mapping, so a mapping-less
  // partial context is sufficient here.
  const c = createTransformationContext();

  function generate(op: Algebra.Operation): string {
    return c.generator.generate(toAst(op)).trim();
  }

  function transform(query: string): Algebra.Operation {
    return pushDownFilters(c, parseQuery(c, prefixes + query));
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
   * Asserts the rewritten query, and with it the checks every case owes: the metadata hygiene the licences
   * depend on, and the idempotence of the pass - on its own output, and on that output printed and parsed
   * again, which is what the next pass of a pipeline sees.
   * @param expect - The assertion API of the running test
   * @param query - The query to rewrite, without its prefixes
   * @param expected - The query the rewrite has to generate
   */
  function expectTransform(expect: typeof Expect, query: string, expected: string): void {
    const output = transform(query);
    const generated = generate(output);
    expect(generated).toEqual(expected.trim());
    expect(holdsCachedMetadata(output)).toBe(false);
    expect(generate(pushDownFilters(c, output))).toEqual(expected.trim());
    expect(generate(pushDownFilters(c, parseQuery(c, generated)))).toEqual(expected.trim());
  }

  /** The types along the first input of every operation, from the root down. */
  function spine(op: Algebra.Operation): string[] {
    const types: string[] = [];
    let current: any = op;
    while (current !== undefined) {
      types.push(current.type);
      current = Array.isArray(current.input) ? current.input[0] : current.input;
    }
    return types;
  }

  describe('congruent operations', () => {
    it('passes a DISTINCT', ({ expect }) => {
      expectTransform(
        expect,
        'SELECT * WHERE { { SELECT DISTINCT ?x ?y WHERE { ?x :p ?y } } FILTER(?y > 1) }',
        `SELECT ?x ?y WHERE {
  SELECT DISTINCT ?x ?y WHERE {
    ?x <ex://p> ?y .
    FILTER ( ( ?y > "1"^^<http://www.w3.org/2001/XMLSchema#integer> ) )
  }
}`,
      );
    });

    it('passes a REDUCED', ({ expect }) => {
      expectTransform(
        expect,
        'SELECT * WHERE { { SELECT REDUCED ?x ?y WHERE { ?x :p ?y } } FILTER(?y > 1) }',
        `SELECT ?x ?y WHERE {
  SELECT REDUCED ?x ?y WHERE {
    ?x <ex://p> ?y .
    FILTER ( ( ?y > "1"^^<http://www.w3.org/2001/XMLSchema#integer> ) )
  }
}`,
      );
    });

    it('passes an ORDER BY', ({ expect }) => {
      expectTransform(
        expect,
        'SELECT * WHERE { { SELECT ?x ?y WHERE { ?x :p ?y } ORDER BY ?y } FILTER(?y > 1) }',
        `SELECT ?x ?y WHERE {
  SELECT ?x ?y WHERE {
    ?x <ex://p> ?y .
    FILTER ( ( ?y > "1"^^<http://www.w3.org/2001/XMLSchema#integer> ) )
  }
  ORDER BY ASC ( ?y )
}`,
      );
    });

    it('passes a FROM', ({ expect }) => {
      // A FROM only ever sits above the top-level projection of a query, so no query string puts a filter
      // on one: the shape is built by hand.
      const query = <Algebra.Project> parseQuery(c, `${prefixes}SELECT * WHERE { ?s :p ?o FILTER(?o > 1) }`);
      const filter = <Algebra.Filter> query.input;
      const input = c.AF.createFilter(
        c.AF.createFrom(filter.input, [ c.DF.namedNode('ex://g') ], []),
        filter.expression,
      );
      const output = pushDownFilters(c, input);
      expect(spine(output)).toEqual([ Algebra.Types.FROM, Algebra.Types.FILTER, Algebra.Types.BGP ]);
      expect((<Algebra.From> output).default).toEqual([ c.DF.namedNode('ex://g') ]);
      expect(holdsCachedMetadata(output)).toBe(false);
      expect(spine(pushDownFilters(c, output))).toEqual(spine(output));
    });

    it('enters every branch of a UNION', ({ expect }) => {
      expectTransform(
        expect,
        'SELECT * WHERE { { ?x :p ?y } UNION { ?x :q ?y } FILTER(?y > 1) }',
        `SELECT ?x ?y WHERE {
  {
    ?x <ex://p> ?y .
    FILTER ( ( ?y > "1"^^<http://www.w3.org/2001/XMLSchema#integer> ) )
  }
  UNION {
    ?x <ex://q> ?y .
    FILTER ( ( ?y > "1"^^<http://www.w3.org/2001/XMLSchema#integer> ) )
  }
}`,
      );
    });

    it('enters a UNION branch that does not bind what it reads, where it reads the unbound value', ({ expect }) => {
      expectTransform(
        expect,
        'SELECT * WHERE { { ?s :p ?x } UNION { ?s :q ?y } FILTER(?x > 1 || bound(?y)) }',
        `SELECT ?s ?x ?y WHERE {
  {
    ?s <ex://p> ?x .
    FILTER ( ( ( ?x > "1"^^<http://www.w3.org/2001/XMLSchema#integer> ) || BOUND( ?y ) ) )
  }
  UNION {
    ?s <ex://q> ?y .
    FILTER ( ( ( ?x > "1"^^<http://www.w3.org/2001/XMLSchema#integer> ) || BOUND( ?y ) ) )
  }
}`,
      );
    });

    it('enters the left of a MINUS only', ({ expect }) => {
      expectTransform(
        expect,
        'SELECT * WHERE { ?x :p ?y MINUS { ?x :q ?y } FILTER(?y > 1) }',
        `SELECT ?x ?y WHERE {
  {
    ?x <ex://p> ?y .
    FILTER ( ( ?y > "1"^^<http://www.w3.org/2001/XMLSchema#integer> ) )
  }
  MINUS {
    ?x <ex://q> ?y .
  }
}`,
      );
    });

    it('enters the left of a MINUS with a variable only the right side binds', ({ expect }) => {
      // `?z` is out of scope above the MINUS, so `bound(?z)` is false there and on the left alike.
      expectTransform(
        expect,
        'SELECT * WHERE { ?s :p ?o MINUS { ?s :q ?z } FILTER(bound(?z)) }',
        `SELECT ?o ?s WHERE {
  {
    ?s <ex://p> ?o .
    FILTER ( BOUND( ?z ) )
  }
  MINUS {
    ?s <ex://q> ?z .
  }
}`,
      );
    });

    it('merges with the filter below it', ({ expect }) => {
      expectTransform(
        expect,
        'SELECT * WHERE { { ?s :p ?o FILTER(?o > 0) } UNION { ?s :q ?o } FILTER(?o < 5) }',
        `SELECT ?o ?s WHERE {
  {
    ?s <ex://p> ?o .
    FILTER ( ( ( ?o < "5"^^<http://www.w3.org/2001/XMLSchema#integer> ) && ( ?o > "0"^^<http://www.w3.org/2001/XMLSchema#integer> ) ) )
  }
  UNION {
    ?s <ex://q> ?o .
    FILTER ( ( ?o < "5"^^<http://www.w3.org/2001/XMLSchema#integer> ) )
  }
}`,
      );
    });
  });

  describe('projections', () => {
    it('passes a PROJECT keeping what the conjunct reads', ({ expect }) => {
      expectTransform(
        expect,
        'SELECT * WHERE { { SELECT ?x WHERE { ?x :p ?y } } FILTER(?x != :a) }',
        `SELECT ?x WHERE {
  SELECT ?x WHERE {
    ?x <ex://p> ?y .
    FILTER ( ( ?x != <ex://a> ) )
  }
}`,
      );
    });

    it('stays above a PROJECT dropping a variable its input binds', ({ expect }) => {
      // Above the projection `?y` is unbound, below it is not.
      expectTransform(
        expect,
        'SELECT * WHERE { { SELECT ?x WHERE { ?x :p ?y } } FILTER(?y > 1) }',
        `SELECT ?x WHERE {
  {
    SELECT ?x WHERE {
      ?x <ex://p> ?y .
    }
  }
  FILTER ( ( ?y > "1"^^<http://www.w3.org/2001/XMLSchema#integer> ) )
}`,
      );
    });

    it('passes a PROJECT dropping a variable nothing below binds', ({ expect }) => {
      expectTransform(
        expect,
        'SELECT * WHERE { { SELECT ?x WHERE { ?x :p ?o } } FILTER(!bound(?y)) }',
        `SELECT ?x WHERE {
  SELECT ?x WHERE {
    ?x <ex://p> ?o .
    FILTER ( ! BOUND( ?y ) )
  }
}`,
      );
    });

    it('substitutes a projected variable alias', ({ expect }) => {
      expectTransform(
        expect,
        'SELECT * WHERE { { SELECT (?o AS ?x) WHERE { ?s :p ?o } } FILTER(?x > 1) }',
        `SELECT ?x WHERE {
  SELECT ( ?o AS ?x ) WHERE {
    ?s <ex://p> ?o .
    FILTER ( ( ?o > "1"^^<http://www.w3.org/2001/XMLSchema#integer> ) )
  }
}`,
      );
    });
  });

  describe('groups', () => {
    it('moves a HAVING on a key below the GROUP', ({ expect }) => {
      expectTransform(
        expect,
        'SELECT ?k (COUNT(*) AS ?n) WHERE { ?s :p ?k } GROUP BY ?k HAVING(?k > 1)',
        `SELECT ?k ( COUNT( * ) AS ?n ) WHERE {
  ?s <ex://p> ?k .
  FILTER ( ( ?k > "1"^^<http://www.w3.org/2001/XMLSchema#integer> ) )
}
GROUP BY ?k`,
      );
    });

    it('keeps a HAVING on an aggregate above the GROUP', ({ expect }) => {
      expectTransform(
        expect,
        'SELECT ?k (COUNT(*) AS ?n) WHERE { ?s :p ?k } GROUP BY ?k HAVING(COUNT(*) > 1)',
        `SELECT ?k ( COUNT( * ) AS ?n ) WHERE {
  ?s <ex://p> ?k .
}
GROUP BY ?k
HAVING ( COUNT( * ) > "1"^^<http://www.w3.org/2001/XMLSchema#integer> )`,
      );
    });

    it('splits a HAVING into the conjunct on a key and the one on an aggregate', ({ expect }) => {
      expectTransform(
        expect,
        'SELECT ?g (COUNT(*) AS ?n) WHERE { ?s :p ?g } GROUP BY ?g HAVING(?g != :a && COUNT(*) > 1)',
        `SELECT ?g ( COUNT( * ) AS ?n ) WHERE {
  {
    ?s <ex://p> ?g .
    FILTER ( ( ?g != <ex://a> ) )
  }
}
GROUP BY ?g
HAVING ( COUNT( * ) > "1"^^<http://www.w3.org/2001/XMLSchema#integer> )`,
      );
    });

    it('keeps a HAVING of a keyless GROUP above it', ({ expect }) => {
      expectTransform(
        expect,
        'SELECT (COUNT(*) AS ?n) WHERE { ?s :p ?k } HAVING(COUNT(*) > 1)',
        `SELECT ( COUNT( * ) AS ?n ) WHERE {
  ?s <ex://p> ?k .
}
HAVING ( COUNT( * ) > "1"^^<http://www.w3.org/2001/XMLSchema#integer> )`,
      );
    });

    it('keeps a conjunct on no key outside a keyless grouped sub-SELECT', ({ expect }) => {
      // A keyless GROUP makes one group of an empty input, so this must not reach the pattern.
      expectTransform(
        expect,
        'SELECT * WHERE { { SELECT (COUNT(*) AS ?n) WHERE { ?s :p ?k } } FILTER(?k > 1) }',
        `SELECT ?n WHERE {
  {
    SELECT ( COUNT( * ) AS ?n ) WHERE {
      ?s <ex://p> ?k .
    }
  }
  FILTER ( ( ?k > "1"^^<http://www.w3.org/2001/XMLSchema#integer> ) )
}`,
      );
    });

    it('lets a conjunct on a key into a grouped sub-SELECT, below its GROUP', ({ expect }) => {
      // Between the projection and the GROUP, `toAst` would print what stays there into the WHERE clause,
      // so the conjunct on the aggregate's alias stays outside.
      expectTransform(
        expect,
        'SELECT * WHERE { { SELECT ?k (COUNT(*) AS ?n) WHERE { ?s :p ?k } GROUP BY ?k } FILTER(?k > 1 && ?n > 1) }',
        `SELECT ?k ?n WHERE {
  {
    SELECT ?k ( COUNT( * ) AS ?n ) WHERE {
      ?s <ex://p> ?k .
      FILTER ( ( ?k > "1"^^<http://www.w3.org/2001/XMLSchema#integer> ) )
    }
    GROUP BY ?k
  }
  FILTER ( ( ?n > "1"^^<http://www.w3.org/2001/XMLSchema#integer> ) )
}`,
      );
    });

    it('keeps bound() of an aggregate alias outside the grouped sub-SELECT', ({ expect }) => {
      expectTransform(
        expect,
        'SELECT * WHERE { { SELECT ?g (COUNT(?k) AS ?n) WHERE { ?s :p ?g ; :q ?k } GROUP BY ?g } FILTER(bound(?n)) }',
        `SELECT ?g ?n WHERE {
  {
    SELECT ?g ( COUNT( ?k ) AS ?n ) WHERE {
      ?s <ex://p> ?g .
      ?s <ex://q> ?k .
    }
    GROUP BY ?g
  }
  FILTER ( BOUND( ?n ) )
}`,
      );
    });
  });

  describe('binds', () => {
    it('passes a BIND it does not read', ({ expect }) => {
      expectTransform(
        expect,
        'SELECT * WHERE { ?s :p ?o BIND(:a AS ?x) FILTER(?o > 1) }',
        `SELECT ?o ?s ( <ex://a> AS ?x ) WHERE {
  ?s <ex://p> ?o .
  FILTER ( ( ?o > "1"^^<http://www.w3.org/2001/XMLSchema#integer> ) )
}`,
      );
    });

    it('reads the variable a BIND copies in its place', ({ expect }) => {
      expectTransform(
        expect,
        'SELECT * WHERE { ?s :p ?o BIND(?o AS ?x) FILTER(?x > 1) }',
        `SELECT ?o ?s ( ?o AS ?x ) WHERE {
  ?s <ex://p> ?o .
  FILTER ( ( ?o > "1"^^<http://www.w3.org/2001/XMLSchema#integer> ) )
}`,
      );
    });

    it('reads the term a BIND constructs in its place, equality against an IRI becoming sameTerm', ({ expect }) => {
      expectTransform(
        expect,
        'SELECT * WHERE { ?s :p ?o BIND(:a AS ?x) FILTER(?x = ?s) }',
        `SELECT ?o ?s ( <ex://a> AS ?x ) WHERE {
  ?s <ex://p> ?o .
  FILTER ( SAMETERM( <ex://a> , ?s ) )
}`,
      );
    });

    it('drops a conjunct the construction decides to be true', ({ expect }) => {
      expectTransform(
        expect,
        'SELECT * WHERE { ?s :p ?o BIND(:a AS ?x) FILTER(?x = :a) }',
        `SELECT ?o ?s ( <ex://a> AS ?x ) WHERE {
  ?s <ex://p> ?o .
}`,
      );
    });

    it('leaves FALSE below a BIND whose construction contradicts the conjunct', ({ expect }) => {
      expectTransform(
        expect,
        'SELECT * WHERE { ?s :p ?o BIND(:a AS ?x) FILTER(?x = :b) }',
        `SELECT ?o ?s ( <ex://a> AS ?x ) WHERE {
  ?s <ex://p> ?o .
  FILTER ( FALSE )
}`,
      );
    });

    it('stays above a BIND computing its value', ({ expect }) => {
      expectTransform(
        expect,
        'SELECT * WHERE { ?s :p ?o BIND(STR(?o) AS ?x) FILTER(?x = "1") }',
        `SELECT ?o ?s ?x WHERE {
  {
    ?s <ex://p> ?o .
    BIND( STR( ?o ) AS ?x )
  }
  FILTER ( ( ?x = "1" ) )
}`,
      );
    });

    it('keeps bound() above a BIND of a possibly unbound variable', ({ expect }) => {
      expectTransform(
        expect,
        'SELECT * WHERE { ?s :p ?o OPTIONAL { ?s :q ?z } BIND(?z AS ?x) FILTER(bound(?x)) }',
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

    it('folds away bound() of a BIND that cannot fail', ({ expect }) => {
      expectTransform(
        expect,
        'SELECT * WHERE { ?s :p ?o BIND(?o AS ?x) FILTER(bound(?x)) }',
        `SELECT ?o ?s ( ?o AS ?x ) WHERE {
  ?s <ex://p> ?o .
}`,
      );
    });

    it('substitutes into COALESCE over a possibly unbound variable', ({ expect }) => {
      // `?x` is unbound exactly where `?z` is, so COALESCE takes its fallback in the same solutions.
      expectTransform(
        expect,
        'SELECT * WHERE { ?s :p ?o OPTIONAL { ?s :q ?z } BIND(?z AS ?x) FILTER(COALESCE(?x, 1) = 1) }',
        `SELECT ?o ?s ( ?z AS ?x ) ?z WHERE {
  ?s <ex://p> ?o .
  OPTIONAL {
    ?s <ex://q> ?z .
  }
  FILTER ( ( COALESCE( ?z , "1"^^<http://www.w3.org/2001/XMLSchema#integer> ) = "1"^^<http://www.w3.org/2001/XMLSchema#integer> ) )
}`,
      );
    });

    it('substitutes, then turns the OPTIONAL it reaches into a JOIN', ({ expect }) => {
      expectTransform(
        expect,
        'SELECT * WHERE { ?s :p ?o OPTIONAL { ?s :q ?z } BIND(?z AS ?x) FILTER(?x > 1) }',
        `SELECT ?o ?s ( ?z AS ?x ) ?z WHERE {
  ?s <ex://p> ?o .
  {
    ?s <ex://q> ?z .
    FILTER ( ( ?z > "1"^^<http://www.w3.org/2001/XMLSchema#integer> ) )
  }
}`,
      );
    });

    it('passes a chain of binds, stopping at the computed one', ({ expect }) => {
      expectTransform(
        expect,
        'SELECT * WHERE { ?s :p ?o BIND(?o AS ?x) BIND(STR(?x) AS ?y) FILTER(?y = "1" && ?x != 2) }',
        `SELECT ?o ?s ?x ?y WHERE {
  {
    {
      ?s <ex://p> ?o .
      FILTER ( ( ?o != "2"^^<http://www.w3.org/2001/XMLSchema#integer> ) )
    }
    BIND( ?o AS ?x )
    BIND( STR( ?x ) AS ?y )
  }
  FILTER ( ( ?y = "1" ) )
}`,
      );
    });

    it('reads a component of a TRIPLE() construction', ({ expect }) => {
      expectTransform(
        expect,
        'SELECT * WHERE { ?s :p ?o BIND(TRIPLE(?s, :p, ?o) AS ?t) FILTER(OBJECT(?t) > 1) }',
        `SELECT ?o ?s ( TRIPLE( ?s , <ex://p> , ?o ) AS ?t ) WHERE {
  ?s <ex://p> ?o .
  FILTER ( ( ?o > "1"^^<http://www.w3.org/2001/XMLSchema#integer> ) )
}`,
      );
    });
  });

  describe('joins', () => {
    it('enters the operand binding what it reads certainly', ({ expect }) => {
      expectTransform(
        expect,
        'SELECT * WHERE { ?s :p ?o { SELECT ?s ?z WHERE { ?s :q ?z } } FILTER(?z > 1) }',
        `SELECT ?o ?s ?z WHERE {
  ?s <ex://p> ?o .
  {
    SELECT ?s ?z WHERE {
      ?s <ex://q> ?z .
      FILTER ( ( ?z > "1"^^<http://www.w3.org/2001/XMLSchema#integer> ) )
    }
  }
}`,
      );
    });

    it('enters every operand binding what it reads certainly', ({ expect }) => {
      expectTransform(
        expect,
        'SELECT * WHERE { ?s :p ?o { SELECT ?s ?z WHERE { ?s :q ?z } } FILTER(?s != :a) }',
        `SELECT ?o ?s ?z WHERE {
  {
    ?s <ex://p> ?o .
    FILTER ( ( ?s != <ex://a> ) )
  }
  {
    SELECT ?s ?z WHERE {
      ?s <ex://q> ?z .
      FILTER ( ( ?s != <ex://a> ) )
    }
  }
}`,
      );
    });

    it('stays above a JOIN when what it reads comes from different operands', ({ expect }) => {
      expectTransform(
        expect,
        'SELECT * WHERE { ?s :p ?o { SELECT ?t ?z WHERE { ?t :q ?z } } FILTER(?o = ?z) }',
        `SELECT ?o ?s ?t ?z WHERE {
  ?s <ex://p> ?o .
  {
    SELECT ?t ?z WHERE {
      ?t <ex://q> ?z .
    }
  }
  FILTER ( ( ?o = ?z ) )
}`,
      );
    });

    it('stays above a JOIN when several operands bind what it reads possibly', ({ expect }) => {
      expectTransform(
        expect,
        'SELECT * WHERE { { ?s :p ?o } UNION { ?s :q ?z } { ?t :r ?o } UNION { ?t :r ?w } FILTER(?o > 1) }',
        `SELECT ?o ?s ?t ?w ?z WHERE {
  {
    ?s <ex://p> ?o .
  }
  UNION {
    ?s <ex://q> ?z .
  }
  {
    ?t <ex://r> ?o .
  }
  UNION {
    ?t <ex://r> ?w .
  }
  FILTER ( ( ?o > "1"^^<http://www.w3.org/2001/XMLSchema#integer> ) )
}`,
      );
    });

    it('enters the one operand that can bind what it reads, possibly or not', ({ expect }) => {
      expectTransform(
        expect,
        'SELECT * WHERE { { ?s :p ?o } UNION { ?s :q ?z } { SELECT ?t ?w WHERE { ?t :r ?w } } FILTER(?o > 1) }',
        `SELECT ?o ?s ?t ?w ?z WHERE {
  {
    ?s <ex://p> ?o .
    FILTER ( ( ?o > "1"^^<http://www.w3.org/2001/XMLSchema#integer> ) )
  }
  UNION {
    ?s <ex://q> ?z .
    FILTER ( ( ?o > "1"^^<http://www.w3.org/2001/XMLSchema#integer> ) )
  }
  {
    SELECT ?t ?w WHERE {
      ?t <ex://r> ?w .
    }
  }
}`,
      );
    });

    it('enters a VALUES operand with UNDEF in the column it reads', ({ expect }) => {
      expectTransform(
        expect,
        'SELECT * WHERE { VALUES (?x ?y) { (1 UNDEF) (2 3) } ?s :p ?x FILTER(?y > 1) }',
        `SELECT ?s ?x ?y WHERE {
  {
    VALUES( ?x ?y ){
      ( "1"^^<http://www.w3.org/2001/XMLSchema#integer> UNDEF )
      ( "2"^^<http://www.w3.org/2001/XMLSchema#integer> "3"^^<http://www.w3.org/2001/XMLSchema#integer> )
    }
    FILTER ( ( ?y > "1"^^<http://www.w3.org/2001/XMLSchema#integer> ) )
  }
  ?s <ex://p> ?x .
}`,
      );
    });
  });

  describe('optionals', () => {
    it('enters the left of an OPTIONAL', ({ expect }) => {
      expectTransform(
        expect,
        'SELECT * WHERE { ?s :p ?o OPTIONAL { ?s :q ?z } FILTER(?o > 1) }',
        `SELECT ?o ?s ?z WHERE {
  {
    ?s <ex://p> ?o .
    FILTER ( ( ?o > "1"^^<http://www.w3.org/2001/XMLSchema#integer> ) )
  }
  OPTIONAL {
    ?s <ex://q> ?z .
  }
}`,
      );
    });

    it('is copied into the right of an OPTIONAL where both sides bind what it reads certainly', ({ expect }) => {
      expectTransform(
        expect,
        'SELECT * WHERE { ?s :p ?o OPTIONAL { ?s :q ?z } FILTER(?s != :a) }',
        `SELECT ?o ?s ?z WHERE {
  {
    ?s <ex://p> ?o .
    FILTER ( ( ?s != <ex://a> ) )
  }
  OPTIONAL {
    {
      ?s <ex://q> ?z .
      FILTER ( ( ?s != <ex://a> ) )
    }
  }
}`,
      );
    });

    it('enters only the left where the right does not bind what it reads', ({ expect }) => {
      expectTransform(
        expect,
        'SELECT * WHERE { ?s :p ?o OPTIONAL { ?t :q ?z } FILTER(?s != :a) }',
        `SELECT ?o ?s ?t ?z WHERE {
  {
    ?s <ex://p> ?o .
    FILTER ( ( ?s != <ex://a> ) )
  }
  OPTIONAL {
    ?t <ex://q> ?z .
  }
}`,
      );
    });

    it('turns an OPTIONAL into a JOIN under a conjunct rejecting an unbound right-only variable', ({ expect }) => {
      expectTransform(
        expect,
        'SELECT * WHERE { ?s :p ?o OPTIONAL { ?s :q ?x } FILTER(?x > 1) }',
        `SELECT ?o ?s ?x WHERE {
  ?s <ex://p> ?o .
  {
    ?s <ex://q> ?x .
    FILTER ( ( ?x > "1"^^<http://www.w3.org/2001/XMLSchema#integer> ) )
  }
}`,
      );
    });

    it('turns an OPTIONAL into a JOIN under NOT IN, which raises on an unbound variable', ({ expect }) => {
      expectTransform(
        expect,
        'SELECT * WHERE { ?s :p ?o OPTIONAL { ?s :q ?x } FILTER(?x NOT IN (1, 2)) }',
        `SELECT ?o ?s ?x WHERE {
  ?s <ex://p> ?o .
  {
    ?s <ex://q> ?x .
    FILTER ( ( ?x NOT IN ( "1"^^<http://www.w3.org/2001/XMLSchema#integer> , "2"^^<http://www.w3.org/2001/XMLSchema#integer> ) ) )
  }
}`,
      );
    });

    it('turns an OPTIONAL into a JOIN under a conjunct reading both sides, which stays above', ({ expect }) => {
      expectTransform(
        expect,
        'SELECT * WHERE { ?s :p ?o OPTIONAL { ?s :q ?x } FILTER(?x > ?o) }',
        `SELECT ?o ?s ?x WHERE {
  ?s <ex://p> ?o .
  ?s <ex://q> ?x .
  FILTER ( ( ?x > ?o ) )
}`,
      );
    });

    it('does not turn an OPTIONAL into a JOIN under !bound()', ({ expect }) => {
      expectTransform(
        expect,
        'SELECT * WHERE { ?s :p ?o OPTIONAL { ?s :q ?x } FILTER(!bound(?x)) }',
        `SELECT ?o ?s ?x WHERE {
  ?s <ex://p> ?o .
  OPTIONAL {
    ?s <ex://q> ?x .
  }
  FILTER ( ! BOUND( ?x ) )
}`,
      );
    });

    it('does not turn an OPTIONAL into a JOIN under COALESCE', ({ expect }) => {
      expectTransform(
        expect,
        'SELECT * WHERE { ?s :p ?o OPTIONAL { ?s :q ?x } FILTER(COALESCE(?x, 1) = 1) }',
        `SELECT ?o ?s ?x WHERE {
  ?s <ex://p> ?o .
  OPTIONAL {
    ?s <ex://q> ?x .
  }
  FILTER ( ( COALESCE( ?x , "1"^^<http://www.w3.org/2001/XMLSchema#integer> ) = "1"^^<http://www.w3.org/2001/XMLSchema#integer> ) )
}`,
      );
    });

    it('does not turn an OPTIONAL into a JOIN under a disjunction one side of which holds unbound', ({ expect }) => {
      expectTransform(
        expect,
        'SELECT * WHERE { ?s :p ?o OPTIONAL { ?s :q ?x } FILTER(?x > 1 || !bound(?x)) }',
        `SELECT ?o ?s ?x WHERE {
  ?s <ex://p> ?o .
  OPTIONAL {
    ?s <ex://q> ?x .
  }
  FILTER ( ( ( ?x > "1"^^<http://www.w3.org/2001/XMLSchema#integer> ) || ! BOUND( ?x ) ) )
}`,
      );
    });

    it('stays above an OPTIONAL whose two sides both bind what it reads possibly', ({ expect }) => {
      expectTransform(
        expect,
        'SELECT * WHERE { VALUES (?x ?y) { (1 UNDEF) (2 3) } OPTIONAL { ?s :p ?y } FILTER(?y > 1) }',
        `SELECT ?s ?x ?y WHERE {
  VALUES( ?x ?y ){
    ( "1"^^<http://www.w3.org/2001/XMLSchema#integer> UNDEF )
    ( "2"^^<http://www.w3.org/2001/XMLSchema#integer> "3"^^<http://www.w3.org/2001/XMLSchema#integer> )
  }
  OPTIONAL {
    ?s <ex://p> ?y .
  }
  FILTER ( ( ?y > "1"^^<http://www.w3.org/2001/XMLSchema#integer> ) )
}`,
      );
    });

    it('turns an OPTIONAL into a JOIN when its left side only declares the variable unbound', ({ expect }) => {
      expectTransform(
        expect,
        'SELECT * WHERE { VALUES ?x { UNDEF } OPTIONAL { ?s :p ?x } FILTER(?x > 1) }',
        `SELECT ?s ?x WHERE {
  VALUES ?x {
    UNDEF
  }
  {
    ?s <ex://p> ?x .
    FILTER ( ( ?x > "1"^^<http://www.w3.org/2001/XMLSchema#integer> ) )
  }
}`,
      );
    });

    it('turns nested OPTIONALs into JOINs one level at a time', ({ expect }) => {
      expectTransform(
        expect,
        'SELECT * WHERE { ?s :p ?o OPTIONAL { ?s :q ?z OPTIONAL { ?z :r ?w } } FILTER(?w > 1) }',
        `SELECT ?o ?s ?w ?z WHERE {
  ?s <ex://p> ?o .
  ?s <ex://q> ?z .
  {
    ?z <ex://r> ?w .
    FILTER ( ( ?w > "1"^^<http://www.w3.org/2001/XMLSchema#integer> ) )
  }
}`,
      );
    });

    it('keeps the condition of the OPTIONAL it turns into a JOIN as a filter on it', ({ expect }) => {
      expectTransform(
        expect,
        'SELECT * WHERE { ?s :p ?o OPTIONAL { ?s :q ?z FILTER(?z != ?o) } FILTER(?z > 1) }',
        `SELECT ?o ?s ?z WHERE {
  ?s <ex://p> ?o .
  {
    ?s <ex://q> ?z .
    FILTER ( ( ?z > "1"^^<http://www.w3.org/2001/XMLSchema#integer> ) )
  }
  FILTER ( ( ?z != ?o ) )
}`,
      );
    });

    it('sinks the condition of an OPTIONAL into its right side', ({ expect }) => {
      expectTransform(
        expect,
        'SELECT * WHERE { ?s :p ?o OPTIONAL { ?s :q ?z FILTER(?z > 1) } }',
        `SELECT ?o ?s ?z WHERE {
  ?s <ex://p> ?o .
  OPTIONAL {
    {
      ?s <ex://q> ?z .
      FILTER ( ( ?z > "1"^^<http://www.w3.org/2001/XMLSchema#integer> ) )
    }
  }
}`,
      );
    });

    it('keeps a condition of an OPTIONAL reading the left side', ({ expect }) => {
      expectTransform(
        expect,
        'SELECT * WHERE { ?s :p ?o OPTIONAL { ?s :q ?z FILTER(?z > ?o) } }',
        `SELECT ?o ?s ?z WHERE {
  ?s <ex://p> ?o .
  OPTIONAL {
    ?s <ex://q> ?z .
    FILTER ( ( ?z > ?o ) )
  }
}`,
      );
    });

    it('splits the condition of an OPTIONAL between its right side and itself', ({ expect }) => {
      expectTransform(
        expect,
        'SELECT * WHERE { ?s :p ?o OPTIONAL { ?s :q ?z FILTER(?z > 1 && ?z > ?o) } }',
        `SELECT ?o ?s ?z WHERE {
  ?s <ex://p> ?o .
  OPTIONAL {
    {
      ?s <ex://q> ?z .
      FILTER ( ( ?z > "1"^^<http://www.w3.org/2001/XMLSchema#integer> ) )
    }
    FILTER ( ( ?z > ?o ) )
  }
}`,
      );
    });
  });

  describe('named graphs', () => {
    it('enters a GRAPH when it does not read the graph variable', ({ expect }) => {
      expectTransform(
        expect,
        'SELECT * WHERE { GRAPH ?g { ?s :p ?o } FILTER(?o > 1) }',
        `SELECT ?g ?o ?s WHERE {
  GRAPH ?g {
    {
      ?s <ex://p> ?o .
      FILTER ( ( ?o > "1"^^<http://www.w3.org/2001/XMLSchema#integer> ) )
    }
  }
}`,
      );
    });

    it('stays above a GRAPH whose pattern does not bind the graph variable it reads', ({ expect }) => {
      expectTransform(
        expect,
        'SELECT * WHERE { GRAPH ?g { ?s :p ?o } FILTER(?g != :g1) }',
        `SELECT ?g ?o ?s WHERE {
  GRAPH ?g {
    ?s <ex://p> ?o .
  }
  FILTER ( ( ?g != <ex://g1> ) )
}`,
      );
    });

    it('enters a GRAPH whose pattern binds the graph variable it reads certainly', ({ expect }) => {
      expectTransform(
        expect,
        'SELECT * WHERE { GRAPH ?g { ?g :p ?o } FILTER(?g != :g1) }',
        `SELECT ?g ?o WHERE {
  GRAPH ?g {
    {
      ?g <ex://p> ?o .
      FILTER ( ( ?g != <ex://g1> ) )
    }
  }
}`,
      );
    });
  });

  describe('pinned conjuncts', () => {
    it('keeps RAND() where it is, moving the rest of the condition', ({ expect }) => {
      expectTransform(
        expect,
        'SELECT * WHERE { ?s :p ?o OPTIONAL { ?s :q ?z } FILTER(RAND() < 0.5 && ?o > 1) }',
        `SELECT ?o ?s ?z WHERE {
  {
    ?s <ex://p> ?o .
    FILTER ( ( ?o > "1"^^<http://www.w3.org/2001/XMLSchema#integer> ) )
  }
  OPTIONAL {
    ?s <ex://q> ?z .
  }
  FILTER ( ( RAND( ) < "0.5"^^<http://www.w3.org/2001/XMLSchema#decimal> ) )
}`,
      );
    });

    it('keeps a conjunct reading a variable and RAND()', ({ expect }) => {
      expectTransform(
        expect,
        'SELECT * WHERE { { ?s :p ?o } UNION { ?s :q ?o } FILTER(?o > RAND()) }',
        `SELECT ?o ?s WHERE {
  {
    ?s <ex://p> ?o .
  }
  UNION {
    ?s <ex://q> ?o .
  }
  FILTER ( ( ?o > RAND( ) ) )
}`,
      );
    });

    it('keeps a FILTER(FALSE) sentinel intact', ({ expect }) => {
      expectTransform(
        expect,
        'SELECT * WHERE { { ?s :p ?o } UNION { ?s :q ?o } FILTER(false) }',
        `SELECT ?o ?s WHERE {
  {
    ?s <ex://p> ?o .
  }
  UNION {
    ?s <ex://q> ?o .
  }
  FILTER ( FALSE )
}`,
      );
    });

    it('keeps FALSE above while the conjunct beside it moves', ({ expect }) => {
      expectTransform(
        expect,
        'SELECT * WHERE { { ?s :p ?o } UNION { ?s :q ?o } FILTER(false && ?o > 1) }',
        `SELECT ?o ?s WHERE {
  {
    ?s <ex://p> ?o .
    FILTER ( ( ?o > "1"^^<http://www.w3.org/2001/XMLSchema#integer> ) )
  }
  UNION {
    ?s <ex://q> ?o .
    FILTER ( ( ?o > "1"^^<http://www.w3.org/2001/XMLSchema#integer> ) )
  }
  FILTER ( FALSE )
}`,
      );
    });

    it('keeps a conjunct reading no variable, NOW() included', ({ expect }) => {
      expectTransform(
        expect,
        'SELECT * WHERE { {?s :p ?o} UNION {?s :q ?o} FILTER(?o > 1 && NOW() > "2000-01-01T00:00:00Z"^^xsd:dateTime) }',
        `SELECT ?o ?s WHERE {
  {
    ?s <ex://p> ?o .
    FILTER ( ( ?o > "1"^^<http://www.w3.org/2001/XMLSchema#integer> ) )
  }
  UNION {
    ?s <ex://q> ?o .
    FILTER ( ( ?o > "1"^^<http://www.w3.org/2001/XMLSchema#integer> ) )
  }
  FILTER ( ( NOW( ) > "2000-01-01T00:00:00Z"^^<http://www.w3.org/2001/XMLSchema#dateTime> ) )
}`,
      );
    });

    it('keeps an EXISTS conjunct, moving the rest of the condition', ({ expect }) => {
      expectTransform(
        expect,
        'SELECT * WHERE { { ?s :p ?o } UNION { ?s :q ?o } FILTER(EXISTS { ?o :r ?w } && ?o > 1) }',
        `SELECT ?o ?s WHERE {
  {
    ?s <ex://p> ?o .
    FILTER ( ( ?o > "1"^^<http://www.w3.org/2001/XMLSchema#integer> ) )
  }
  UNION {
    ?s <ex://q> ?o .
    FILTER ( ( ?o > "1"^^<http://www.w3.org/2001/XMLSchema#integer> ) )
  }
  FILTER ( EXISTS {
    ?o <ex://r> ?w .
  }
  )
}`,
      );
    });

    it('leaves a filter inside an EXISTS pattern untouched', ({ expect }) => {
      expectTransform(
        expect,
        'SELECT * WHERE { ?s :p ?o FILTER(EXISTS { { ?o :r ?w } UNION { ?o :t ?w } FILTER(?w > 1) }) }',
        `SELECT ?o ?s WHERE {
  ?s <ex://p> ?o .
  FILTER ( EXISTS {
    {
      {
        ?o <ex://r> ?w .
      }
      UNION {
        ?o <ex://t> ?w .
      }
      FILTER ( ( ?w > "1"^^<http://www.w3.org/2001/XMLSchema#integer> ) )
    }
  }
  )
}`,
      );
    });

    it('leaves a filter inside a NOT EXISTS pattern untouched', ({ expect }) => {
      expectTransform(
        expect,
        'SELECT * WHERE { ?s :p ?o FILTER NOT EXISTS { { ?o :r ?w } UNION { ?o :t ?w } FILTER(?w > 1) } }',
        `SELECT ?o ?s WHERE {
  ?s <ex://p> ?o .
  FILTER ( NOT EXISTS {
    {
      {
        ?o <ex://r> ?w .
      }
      UNION {
        ?o <ex://t> ?w .
      }
      FILTER ( ( ?w > "1"^^<http://www.w3.org/2001/XMLSchema#integer> ) )
    }
  }
  )
}`,
      );
    });

    it('keeps a call of an extension function, a cast included', ({ expect }) => {
      expectTransform(
        expect,
        'SELECT * WHERE { ?s :p ?o OPTIONAL { ?s :q ?z } FILTER(xsd:integer(?z) > 1) }',
        `SELECT ?o ?s ?z WHERE {
  ?s <ex://p> ?o .
  OPTIONAL {
    ?s <ex://q> ?z .
  }
  FILTER ( ( <http://www.w3.org/2001/XMLSchema#integer> ( ?z ) > "1"^^<http://www.w3.org/2001/XMLSchema#integer> ) )
}`,
      );
    });
  });

  describe('barriers', () => {
    it('stays above a SLICE', ({ expect }) => {
      expectTransform(
        expect,
        'SELECT * WHERE { { SELECT ?s ?z WHERE { ?s :q ?z } LIMIT 2 } FILTER(?z > 1) }',
        `SELECT ?s ?z WHERE {
  {
    SELECT ?s ?z WHERE {
      ?s <ex://q> ?z .
    }
    LIMIT 2
  }
  FILTER ( ( ?z > "1"^^<http://www.w3.org/2001/XMLSchema#integer> ) )
}`,
      );
    });

    it('stays above a SLICE operand while entering the other one', ({ expect }) => {
      expectTransform(
        expect,
        'SELECT * WHERE { ?s :p ?o { SELECT ?s WHERE { ?s :q ?z } LIMIT 2 } FILTER(?s != :a) }',
        `SELECT ?o ?s WHERE {
  {
    ?s <ex://p> ?o .
    FILTER ( ( ?s != <ex://a> ) )
  }
  {
    {
      SELECT ?s WHERE {
        ?s <ex://q> ?z .
      }
      LIMIT 2
    }
    FILTER ( ( ?s != <ex://a> ) )
  }
}`,
      );
    });
  });

  describe('discipline', () => {
    it('leaves the operation it is given untouched', ({ expect }) => {
      const algebra = parseQuery(c, `${prefixes}SELECT * WHERE {
        ?s :p ?o OPTIONAL { ?s :q ?z FILTER(?z > 1) } BIND(?o AS ?x) FILTER(?x > 1 && ?z != 2)
      }`);
      const before = JSON.stringify(algebra);
      pushDownFilters(c, algebra);
      expect(JSON.stringify(algebra)).toEqual(before);
    });

    it('is the pipeline step', ({ expect }) => {
      expect(pushDownFiltersTransformation()).toBe(pushDownFilters);
    });
  });

  const engine = new QueryEngine();
  // Small, but with integers, a non-canonical integer, a decimal, a boolean, plain and language-tagged
  // strings, IRIs and blank nodes in object position, subjects missing each predicate, a duplicate
  // `:p 1`, a cycle on `:r`, and two named graphs.
  const store = new Store(new Parser({ format: 'application/trig' }).parse(`
    @prefix : <ex://> .
    @prefix xsd: <http://www.w3.org/2001/XMLSchema#> .
    :a :p 1, 2 ; :q 2, 7 ; :r :b .
    :b :p 3, "x" ; :q "y" ; :r :c .
    :c :p "1", "chat"@fr ; :r :a .
    :d :p :e, _:b1 .
    _:b1 :p 5 ; :q _:b1 .
    :z :p 1 .
    :e :q 1 ; :r 4 .
    :f :p "01"^^xsd:integer ; :q 3.5 .
    :g :p true .
    :g1 { :a :p 10 . :h :p 1 . :g1 :p 2 }
    :g2 { :b :p 20 . :g2 :p 3 }
  `));

  function termKey(term: RDF.Term): string {
    return term.termType === 'Literal' ?
      `"${term.value}"@${term.language}^^${term.datatype.value}` :
      `${term.termType}:${term.value}`;
  }

  /**
   * Evaluates a query, or an algebra operation as it stands, into one line per solution.
   * @param query - The query string or operation
   * @param ordered - Whether the order of the solutions is part of the answer
   * @returns the solutions, sorted unless the order matters, duplicates kept either way
   */
  async function bindings(query: string | Algebra.Operation, ordered: boolean): Promise<string[]> {
    const stream = await engine.queryBindings(<any> query, { sources: [ store ]});
    const rows: any[] = await arrayifyStream(stream);
    const lines = rows.map(row => [ ...row ]
      .map(([ key, value ]: [RDF.Variable, RDF.Term]) => `${key.value}=${termKey(value)}`)
      .sort()
      .join(' | '));
    return ordered ? lines : lines.sort();
  }

  describe('semantic equivalence (evaluation)', () => {
    /**
     * Asserts that the rewrite answers a query the same, as the plan the pass produces and as the query that
     * plan prints to.
     * @param expect - The assertion API of the running test
     * @param query - The query, without its prefixes
     * @param expectedRows - How many solutions the query has, so that no case passes by being empty
     * @param options - What else to know about the query
     * @param options.ordered - Whether the order of the solutions is part of the answer
     * @param options.plan - Whether Comunica can evaluate the plan itself, which it cannot for a GRAPH
     * outside quad mode
     */
    async function assertEquivalent(
      expect: typeof Expect,
      query: string,
      expectedRows: number,
      { ordered = false, plan = true }: { ordered?: boolean; plan?: boolean } = {},
    ): Promise<void> {
      const original = await bindings(prefixes + query, ordered);
      const rewritten = transform(query);
      if (plan) {
        expect(await bindings(rewritten, ordered)).toEqual(original);
      }
      expect(await bindings(generate(rewritten), ordered)).toEqual(original);
      expect(original).toHaveLength(expectedRows);
    }

    it('passes DISTINCT, keeping one row per value', async({ expect }) => {
      await assertEquivalent(expect, 'SELECT * WHERE { { SELECT DISTINCT ?o WHERE { ?s :p ?o } } FILTER(?o > 1) }', 3);
    });

    it('passes a PROJECT, keeping the duplicates it produces', async({ expect }) => {
      await assertEquivalent(expect, 'SELECT * WHERE { { SELECT ?o WHERE { ?s :p ?o } } FILTER(?o < 3) }', 4);
    });

    it('passes REDUCED', async({ expect }) => {
      await assertEquivalent(
        expect,
        'SELECT * WHERE { { SELECT REDUCED ?o WHERE { ?s :p ?o } } FILTER(isLiteral(?o)) }',
        8,
      );
    });

    it('passes ORDER BY', async({ expect }) => {
      await assertEquivalent(
        expect,
        'SELECT * WHERE { { SELECT ?s ?o WHERE { ?s :p ?o } ORDER BY ?o } FILTER(?o >= 2) }',
        3,
      );
    });

    it('keeps the order an ORDER BY with LIMIT gives', async({ expect }) => {
      await assertEquivalent(
        expect,
        'SELECT * WHERE { { ?s :p ?o } UNION { ?s :q ?o } FILTER(isNumeric(?o)) } ORDER BY DESC(?o) ?s LIMIT 4',
        4,
        { ordered: true },
      );
    });

    it('stays above a sub-SELECT with ORDER BY and LIMIT', async({ expect }) => {
      await assertEquivalent(
        expect,
        'SELECT * WHERE { { SELECT ?s ?o WHERE { ?s :p ?o } ORDER BY ?s ?o LIMIT 3 } FILTER(isIRI(?s)) }',
        2,
      );
    });

    it('reads a variable bound on one UNION branch only', async({ expect }) => {
      await assertEquivalent(
        expect,
        'SELECT * WHERE { { ?s :p ?x } UNION { ?s :q ?y } FILTER(?x > 1 || ?y = "y") }',
        4,
      );
    });

    it('keeps the UNION branch where !bound() holds', async({ expect }) => {
      await assertEquivalent(expect, 'SELECT * WHERE { { ?s :p ?x } UNION { ?s :q ?y } FILTER(!bound(?x)) }', 6);
    });

    it('enters the left of a MINUS', async({ expect }) => {
      await assertEquivalent(expect, 'SELECT * WHERE { ?s :p ?o MINUS { ?s :q ?o } FILTER(?o > 0) }', 5);
    });

    it('reads a variable only the right of a MINUS binds as unbound', async({ expect }) => {
      await assertEquivalent(expect, 'SELECT * WHERE { ?s :p ?o MINUS { ?s :q ?z } FILTER(!bound(?z)) }', 6);
    });

    it('stays above a PROJECT dropping the variable it reads', async({ expect }) => {
      await assertEquivalent(expect, 'SELECT * WHERE { { SELECT ?s WHERE { ?s :p ?o } } FILTER(?o > 1) }', 0);
    });

    it('passes a PROJECT dropping a variable nothing below binds', async({ expect }) => {
      await assertEquivalent(
        expect,
        'SELECT * WHERE { { SELECT ?s WHERE { ?s :q ?w } } FILTER(!bound(?o) && ?s != :e) }',
        5,
      );
    });

    it('moves a HAVING on a key below the GROUP', async({ expect }) => {
      await assertEquivalent(expect, 'SELECT ?k (COUNT(*) AS ?n) WHERE { ?s :p ?k } GROUP BY ?k HAVING(?k > 1)', 3);
    });

    it('splits a HAVING on a key and an aggregate', async({ expect }) => {
      await assertEquivalent(
        expect,
        'SELECT ?s (COUNT(*) AS ?n) WHERE { ?s :p ?o } GROUP BY ?s HAVING(COUNT(*) > 1 && ?s != :a)',
        3,
      );
    });

    it('keeps the one group a keyless GROUP makes of no match', async({ expect }) => {
      await assertEquivalent(
        expect,
        'SELECT (COUNT(*) AS ?n) WHERE { ?s :p ?o FILTER(?o > 100) } HAVING(COUNT(*) = 0)',
        1,
      );
    });

    it('makes no group of no match where there is a key', async({ expect }) => {
      await assertEquivalent(
        expect,
        'SELECT ?o (COUNT(*) AS ?n) WHERE { ?s :nothing ?o } GROUP BY ?o HAVING(?o > 1)',
        0,
      );
    });

    it('reads a SUM through its alias, an error included', async({ expect }) => {
      // `:b` sums 3 and "x", which raises.
      await assertEquivalent(
        expect,
        'SELECT * WHERE { { SELECT ?s (SUM(?o) AS ?t) WHERE { ?s :p ?o } GROUP BY ?s } FILTER(?t > 2 || ?s = :b) }',
        3,
      );
    });

    it('substitutes a chain of binds', async({ expect }) => {
      await assertEquivalent(
        expect,
        'SELECT * WHERE { ?s :p ?o BIND(?o AS ?x) BIND(?x AS ?y) BIND(STR(?y) AS ?l) FILTER(?y > 1 && ?l != "3") }',
        2,
      );
    });

    it('substitutes a constant bind into an equality', async({ expect }) => {
      await assertEquivalent(expect, 'SELECT * WHERE { ?s :p ?o BIND(:a AS ?x) FILTER(?x = ?s) }', 2);
    });

    it('keeps bound() above a bind of a possibly unbound variable', async({ expect }) => {
      await assertEquivalent(
        expect,
        'SELECT * WHERE { ?s :p ?o OPTIONAL { ?s :q ?z } BIND(?z AS ?x) FILTER(bound(?x)) }',
        8,
      );
    });

    it('substitutes into COALESCE and a disjunction with !bound()', async({ expect }) => {
      await assertEquivalent(
        expect,
        'SELECT * WHERE { ?s :p ?o OPTIONAL { ?s :q ?z } BIND(?z AS ?x) FILTER(COALESCE(?x, 0) = 0 || ?x > 5) }',
        8,
      );
    });

    it('replicates into join operands binding the variable certainly', async({ expect }) => {
      await assertEquivalent(
        expect,
        'SELECT * WHERE { ?s :p ?o { SELECT ?s ?z WHERE { ?s :q ?z } } FILTER(?s != :a && ?z != 1) }',
        2,
      );
    });

    it('stays above a join whose operands bind what it reads separately', async({ expect }) => {
      await assertEquivalent(
        expect,
        'SELECT * WHERE { ?s :p ?o { SELECT ?t ?z WHERE { ?t :q ?z } } FILTER(?o = ?z) }',
        5,
      );
    });

    it('enters a union operand that binds the variable on one branch only', async({ expect }) => {
      await assertEquivalent(
        expect,
        'SELECT * WHERE { {?s :p ?o} UNION {?s :q ?z} { SELECT ?s ?w WHERE {?s :r ?w} } FILTER(?o > 1 || bound(?z)) }',
        6,
      );
    });

    it('stays above a join of unions binding the variable possibly', async({ expect }) => {
      await assertEquivalent(
        expect,
        'SELECT * WHERE { { ?s :p ?o } UNION { ?s :r ?o } { ?s :q ?o } UNION { ?s :q ?w } FILTER(?o != 2) }',
        9,
      );
    });

    it('enters the left of an OPTIONAL, raising on a type mismatch', async({ expect }) => {
      await assertEquivalent(expect, 'SELECT * WHERE { ?s :p ?o OPTIONAL { ?s :q ?z } FILTER(?o != 1) }', 6);
    });

    it('enters both sides of an OPTIONAL binding the variable on both', async({ expect }) => {
      await assertEquivalent(expect, 'SELECT * WHERE { ?s :p ?o OPTIONAL { ?s :q ?o } FILTER(?o > 1) }', 3);
    });

    it('turns an OPTIONAL into a JOIN under a comparison', async({ expect }) => {
      await assertEquivalent(expect, 'SELECT * WHERE { ?s :p ?o OPTIONAL { ?s :q ?z } FILTER(?z > 1 || ?z = "y") }', 7);
    });

    it('keeps an OPTIONAL under !bound()', async({ expect }) => {
      await assertEquivalent(expect, 'SELECT * WHERE { ?s :p ?o OPTIONAL { ?s :q ?z } FILTER(!bound(?z)) }', 6);
    });

    it('keeps an OPTIONAL under COALESCE', async({ expect }) => {
      await assertEquivalent(
        expect,
        'SELECT * WHERE { ?s :p ?o OPTIONAL { ?s :q ?z } FILTER(COALESCE(?z, 1) = 1) }',
        6,
      );
    });

    it('turns an OPTIONAL into a JOIN under IN and NOT IN', async({ expect }) => {
      await assertEquivalent(expect, 'SELECT * WHERE { ?s :p ?o OPTIONAL { ?s :q ?z } FILTER(?z IN (2, "y")) }', 4);
      await assertEquivalent(expect, 'SELECT * WHERE { ?s :p ?o OPTIONAL { ?s :q ?z } FILTER(?z NOT IN (2, "y")) }', 1);
    });

    it('keeps an OPTIONAL under IF over bound()', async({ expect }) => {
      await assertEquivalent(
        expect,
        'SELECT * WHERE { ?s :p ?o OPTIONAL { ?s :q ?z } FILTER(IF(bound(?z), ?z = 7, ?o = 3)) }',
        2,
      );
    });

    it('sinks the condition of an OPTIONAL into its right side', async({ expect }) => {
      await assertEquivalent(expect, 'SELECT * WHERE { ?s :p ?o OPTIONAL { ?s :q ?z FILTER(?z > 1) } }', 14);
    });

    it('keeps a condition of an OPTIONAL reading the left side', async({ expect }) => {
      await assertEquivalent(expect, 'SELECT * WHERE { ?s :p ?o OPTIONAL { ?s :q ?z FILTER(?z > ?o) } }', 13);
    });

    it('turns nested OPTIONALs into JOINs', async({ expect }) => {
      await assertEquivalent(
        expect,
        'SELECT * WHERE { ?s :p ?o OPTIONAL { ?s :r ?m OPTIONAL { ?m :q ?w } } FILTER(?w > 1) }',
        4,
      );
    });

    it('keeps nested OPTIONALs under a disjunction with !bound()', async({ expect }) => {
      await assertEquivalent(
        expect,
        'SELECT * WHERE { ?s :p ?o OPTIONAL { ?s :r ?m OPTIONAL { ?m :q ?w } } FILTER(!bound(?w) || ?w = "y") }',
        10,
      );
    });

    it('stays above two OPTIONALs binding the same variable', async({ expect }) => {
      await assertEquivalent(
        expect,
        'SELECT * WHERE { ?s :p ?o OPTIONAL { ?s :q ?z } OPTIONAL { ?s :r ?z } FILTER(bound(?z)) }',
        10,
      );
    });

    it('turns an OPTIONAL into a JOIN when its left side only declares the variable', async({ expect }) => {
      await assertEquivalent(expect, 'SELECT * WHERE { VALUES ?z { UNDEF } OPTIONAL { ?s :q ?z } FILTER(?z > 1) }', 3);
    });

    it('compares across datatypes and language tags', async({ expect }) => {
      await assertEquivalent(
        expect,
        'SELECT * WHERE { { ?s :p ?o } UNION { ?s :q ?o } FILTER(?o = 1 || ?o = "chat"@fr || ?o > "a") }',
        7,
      );
    });

    it('keeps an EXISTS above while the rest moves', async({ expect }) => {
      await assertEquivalent(
        expect,
        'SELECT * WHERE { { ?s :p ?o } UNION { ?s :r ?o } FILTER(EXISTS { ?s :q ?w FILTER(?w > 1) } && ?o != 3) }',
        4,
      );
    });

    it('leaves the pattern of a NOT EXISTS alone', async({ expect }) => {
      await assertEquivalent(
        expect,
        'SELECT * WHERE { ?s :p ?o FILTER NOT EXISTS { { ?s :q ?w } UNION { ?s :r ?w } FILTER(?w = ?o) } }',
        11,
      );
    });

    it('enters a GRAPH', async({ expect }) => {
      await assertEquivalent(
        expect,
        'SELECT * WHERE { GRAPH ?g { ?s :p ?o } FILTER(?o > 1 && ?g != :g1) }',
        2,
        { plan: false },
      );
    });

    it('reads a component of a TRIPLE() construction', async({ expect }) => {
      await assertEquivalent(
        expect,
        'SELECT * WHERE { ?s :p ?o BIND(TRIPLE(?s, :p, ?o) AS ?t) FILTER(OBJECT(?t) > 1) }',
        3,
      );
    });
  });

  describe('round trips through the generator', () => {
    // Shapes whose printed query once answered differently from the plan: a filter stranded inside a
    // sub-SELECT, which `toAst` prints into its WHERE clause or prints without its DISTINCT, and an OPTIONAL
    // or MINUS that is not the first operand of a JOIN, which `toAst` printed without the braces scoping it.
    const cases: [string, string][] = [
      [
        'a filter stranded between a DISTINCT and its projection',
        'SELECT * WHERE { { SELECT DISTINCT ?s WHERE { ?s :p ?o } } FILTER(?s != :a || bound(?o)) }',
      ],
      [
        'a filter on no key over a keyless GROUP',
        'SELECT * WHERE { { SELECT (COUNT(*) AS ?n) WHERE { ?s :p ?k } } FILTER(?k > 1) }',
      ],
      [
        'a filter on no key over a GROUP',
        'SELECT * WHERE { { SELECT ?g (COUNT(*) AS ?n) WHERE {?g :p ?o} GROUP BY ?g } FILTER(?g != :a || bound(?o)) }',
      ],
      [
        'a filter between a projection and the alias of an aggregate',
        'SELECT * WHERE { { SELECT ?s (SUM(?o) AS ?n) WHERE { ?s :p ?o } GROUP BY ?s } FILTER(bound(?n)) }',
      ],
      [
        'an OPTIONAL turned into a JOIN over an OPTIONAL',
        'SELECT * WHERE { ?s :p ?o OPTIONAL { ?s :r ?m OPTIONAL { ?m :q ?o } } FILTER(bound(?m)) }',
      ],
      [
        'a filter sunk into a MINUS that is not the first operand of a JOIN',
        'SELECT * WHERE { ?s :p ?o { ?s :r ?m MINUS { ?m :q ?o } FILTER(?m != :zz) } }',
      ],
    ];

    for (const [ name, query ] of cases) {
      it(`answers the same as a plan: ${name}`, async({ expect }) => {
        expect(await bindings(transform(query), false)).toEqual(await bindings(prefixes + query, false));
      });

      it(`answers the same as a query: ${name}`, async({ expect }) => {
        expect(await bindings(generate(transform(query)), false)).toEqual(await bindings(prefixes + query, false));
      });
    }
  });
});
