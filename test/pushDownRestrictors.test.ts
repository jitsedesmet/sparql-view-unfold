import { QueryEngine } from '@comunica/query-sparql-file';
import { toAst } from '@traqula/algebra-sparql-1-2';
import * as arrayifyStreamNS from 'arrayify-stream';
import type { expect as Expect } from 'vitest';
import { describe, it } from 'vitest';
import { pushDownRestrictors } from '../lib/transformations/pushDownRestrictors.js';
import type { TransformContext } from '../lib/transformContext.js';
import { createPartialContext, parseQuery } from '../lib/transformContext.js';

// Crazy workaround to support both CJS and ESM
const arrayifyStream =
  (<any> arrayifyStreamNS).default ?? arrayifyStreamNS;

describe('pushDownRestrictors', () => {
  // PushDownRestrictors only uses AF / astTransformer / generator / DF from the context, never the
  // mapping, so a mapping-less partial context is sufficient here.
  const c = <TransformContext> createPartialContext();

  function transform(query: string): string {
    const algebra = parseQuery(c, query);
    const transformed = pushDownRestrictors(c, algebra);
    return c.generator.generate(toAst(transformed)).trim();
  }

  function expectTransform(expect: typeof Expect, query: string, expected: string): void {
    expect(transform(query)).toEqual(expected.trim());
  }

  describe('distributivity of JOIN over UNION (JUDist)', () => {
    it('right-distributes: (A U B) JOIN C == (A JOIN C) U (B JOIN C) [JUDistR]', ({ expect }) => {
      expectTransform(
        expect,
        'SELECT * WHERE { { { ?s <ex://a> ?o } UNION { ?s <ex://b> ?o } } ?s <ex://c> ?x }',
        `SELECT ?o ?s ?x WHERE {
  {
    ?s <ex://a> ?o .
    ?s <ex://c> ?x .
  }
  UNION {
    ?s <ex://b> ?o .
    ?s <ex://c> ?x .
  }
}`,
      );
    });

    it('left-distributes: A JOIN (B U C) == (A JOIN B) U (A JOIN C) [JUDistL]', ({ expect }) => {
      expectTransform(
        expect,
        'SELECT * WHERE { ?s <ex://c> ?x { { ?s <ex://a> ?o } UNION { ?s <ex://b> ?o } } }',
        `SELECT ?o ?s ?x WHERE {
  {
    ?s <ex://a> ?o .
    ?s <ex://c> ?x .
  }
  UNION {
    ?s <ex://b> ?o .
    ?s <ex://c> ?x .
  }
}`,
      );
    });

    it('fully expands a JOIN of two UNIONs into a single UNION of union-free JOINs', ({ expect }) => {
      expectTransform(
        expect,
        `SELECT * WHERE {
          { { ?s <ex://a> ?o } UNION { ?s <ex://b> ?o } }
          { { ?s <ex://c> ?x } UNION { ?s <ex://d> ?x } }
        }`,
        `SELECT ?o ?s ?x WHERE {
  {
    ?s <ex://c> ?x .
    ?s <ex://a> ?o .
  }
  UNION {
    ?s <ex://d> ?x .
    ?s <ex://a> ?o .
  }
  UNION {
    ?s <ex://c> ?x .
    ?s <ex://b> ?o .
  }
  UNION {
    ?s <ex://d> ?x .
    ?s <ex://b> ?o .
  }
}`,
      );
    });
  });

  describe('distributivity of FILTER over UNION (SUPush)', () => {
    it('distributes a filter into every branch: FILTER_R(A U B) == FILTER_R(A) U FILTER_R(B)', ({ expect }) => {
      expectTransform(
        expect,
        'SELECT * WHERE { { { ?s <ex://a> ?o } UNION { ?s <ex://b> ?o } } FILTER(?o = 1) }',
        `SELECT ?o ?s WHERE {
  {
    ?s <ex://a> ?o .
    FILTER ( ( ?o = "1"^^<http://www.w3.org/2001/XMLSchema#integer> ) )
  }
  UNION {
    ?s <ex://b> ?o .
    FILTER ( ( ?o = "1"^^<http://www.w3.org/2001/XMLSchema#integer> ) )
  }
}`,
      );
    });
  });

  describe('pushing FILTER conjuncts into JOIN operands (SJPush + SDecompI)', () => {
    it('splits a conjunction and routes each conjunct to the operand whose safeVars bind it', ({ expect }) => {
      expectTransform(
        expect,
        `SELECT * WHERE {
          { SELECT ?o ?s WHERE { ?s <ex://a> ?o } }
          { SELECT ?y ?x WHERE { ?x <ex://b> ?y } }
          FILTER(?o = 1 && ?y = 2)
        }`,
        `SELECT ?o ?s ?x ?y WHERE {
  {
    {
      SELECT ?o ?s WHERE {
        ?s <ex://a> ?o .
      }
    }
    FILTER ( ( ?o = "1"^^<http://www.w3.org/2001/XMLSchema#integer> ) )
  }
  {
    {
      SELECT ?y ?x WHERE {
        ?x <ex://b> ?y .
      }
    }
    FILTER ( ( ?y = "2"^^<http://www.w3.org/2001/XMLSchema#integer> ) )
  }
}`,
      );
    });

    it('keeps a conjunct above the JOIN when no single operand binds all its variables', ({ expect }) => {
      expectTransform(
        expect,
        `SELECT * WHERE {
          { SELECT ?o ?s WHERE { ?s <ex://a> ?o } }
          { SELECT ?y ?x WHERE { ?x <ex://b> ?y } }
          FILTER(?o = ?y)
        }`,
        `SELECT ?o ?s ?x ?y WHERE {
  {
    SELECT ?o ?s WHERE {
      ?s <ex://a> ?o .
    }
  }
  {
    SELECT ?y ?x WHERE {
      ?x <ex://b> ?y .
    }
  }
  FILTER ( ( ?o = ?y ) )
}`,
      );
    });
  });

  describe('task example: JOIN over UNION + FILTER push down', () => {
    const example = `SELECT ?m_o WHERE {
{
  VALUES( ?m_p ?m_s ){
    ( <http://www.w3.org/1999/02/22-rdf-syntax-ns#reifies><https://example.com/t> )
  }
  {
    {
      SELECT ?mi_o ?mi_p ?mi_s ?mi_t WHERE {
        ?mi_t <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <http://www.w3.org/1999/02/22-rdf-syntax-ns#Statement> .
        ?mi_t <http://www.w3.org/1999/02/22-rdf-syntax-ns#Subject> ?mi_s .
        ?mi_t <http://www.w3.org/1999/02/22-rdf-syntax-ns#Predicate> ?mi_p .
        ?mi_t <http://www.w3.org/1999/02/22-rdf-syntax-ns#Object> ?mi_o .
      }
    }
    BIND( ?mi_t AS ?m_s )
    BIND( <http://www.w3.org/1999/02/22-rdf-syntax-ns#reifies> AS ?m_p )
    BIND( <<( ?mi_s ?mi_p ?mi_o )>> AS ?m_o )
  }
  UNION {
    {
      SELECT ?mi_o ?mi_p ?mi_s WHERE {
        ?mi_s ?mi_p ?mi_o .
      }
    }
    BIND( ?mi_s AS ?m_s )
    BIND( ?mi_p AS ?m_p )
    BIND( ?mi_o AS ?m_o )
  }
  FILTER ( ( <https://example.com/me> = SUBJECT( ?m_o ) ) )
}
FILTER ( ( <https://example.com/name> = PREDICATE( ?m_o ) ) )
}`;

    it('distributes the JOIN over the UNION and pushes both FILTERs into each branch', ({ expect }) => {
      expectTransform(expect, example, `SELECT ?m_o WHERE {
  {
    {
      {
        {
          SELECT ?mi_o ?mi_p ?mi_s ?mi_t WHERE {
            ?mi_t <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <http://www.w3.org/1999/02/22-rdf-syntax-ns#Statement> .
            ?mi_t <http://www.w3.org/1999/02/22-rdf-syntax-ns#Subject> ?mi_s .
            ?mi_t <http://www.w3.org/1999/02/22-rdf-syntax-ns#Predicate> ?mi_p .
            ?mi_t <http://www.w3.org/1999/02/22-rdf-syntax-ns#Object> ?mi_o .
          }
        }
        BIND( ?mi_t AS ?m_s )
        BIND( <http://www.w3.org/1999/02/22-rdf-syntax-ns#reifies> AS ?m_p )
        BIND( <<( ?mi_s ?mi_p ?mi_o )>> AS ?m_o )
      }
      VALUES( ?m_p ?m_s ){
        ( <http://www.w3.org/1999/02/22-rdf-syntax-ns#reifies> <https://example.com/t> )
      }
      FILTER ( ( <https://example.com/me> = SUBJECT( ?m_o ) ) )
    }
    FILTER ( ( <https://example.com/name> = PREDICATE( ?m_o ) ) )
  }
  UNION {
    {
      {
        {
          SELECT ?mi_o ?mi_p ?mi_s WHERE {
            ?mi_s ?mi_p ?mi_o .
          }
        }
        BIND( ?mi_s AS ?m_s )
        BIND( ?mi_p AS ?m_p )
        BIND( ?mi_o AS ?m_o )
      }
      VALUES( ?m_p ?m_s ){
        ( <http://www.w3.org/1999/02/22-rdf-syntax-ns#reifies> <https://example.com/t> )
      }
      FILTER ( ( <https://example.com/me> = SUBJECT( ?m_o ) ) )
    }
    FILTER ( ( <https://example.com/name> = PREDICATE( ?m_o ) ) )
  }
}`);
    });
  });

  describe('idempotence', () => {
    it('applying the transformation twice yields the same result as once', ({ expect }) => {
      const query =
        'SELECT * WHERE { { { ?s <ex://a> ?o } UNION { ?s <ex://b> ?o } } ?s <ex://c> ?x FILTER(?x = 1) }';
      const once = transform(query);
      const algebra = parseQuery(c, query);
      const twiceOp = pushDownRestrictors(c, pushDownRestrictors(c, algebra));
      const twice = c.generator.generate(toAst(twiceOp)).trim();
      expect(twice).toEqual(once);
    });
  });

  describe('semantic equivalence (evaluation)', () => {
    const engine = new QueryEngine();

    async function bindings(query: string): Promise<string[]> {
      const stream = await engine.queryBindings(query, {
        sources: [ './test/statics/multipleRdfReifiedTriples.ttl' ],
      });
      const rows: any[] = await arrayifyStream(stream);
      return rows
        .map(row => [ ...row ].map(([ k, v ]: [any, any]) => `${k.value}=${v.value}`).sort().join('|'))
        .sort();
    }

    async function assertEquivalent(expect: typeof Expect, query: string): Promise<void> {
      const original = await bindings(query);
      const transformed = await bindings(transform(query));
      expect(transformed).toEqual(original);
      // Sanity: the query actually returns something so the test is meaningful.
      expect(original.length).toBeGreaterThan(0);
    }

    it('jOIN over UNION with FILTER produces identical results', async({ expect }) => {
      await assertEquivalent(expect, `PREFIX : <ex://>
        SELECT * WHERE {
          { { ?s :knows ?o } UNION { ?s :age ?o } }
          ?s :knows ?friend
          FILTER(isIRI(?o))
        }`);
    });

    it('nested UNION with conjunctive FILTER produces identical results', async({ expect }) => {
      await assertEquivalent(expect, `PREFIX : <ex://>
        PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
        SELECT * WHERE {
          { { ?t rdf:Subject ?s } UNION { ?t rdf:Object ?s } }
          { SELECT ?t ?by WHERE { ?t :statedBy ?by } }
          FILTER(isIRI(?s) && isIRI(?by))
        }`);
    });
  });
});
