import { readFileSync } from 'node:fs';
import { QueryEngine } from '@comunica/query-sparql-file';
import { toAst } from '@traqula/algebra-sparql-1-2';
import type { Algebra } from '@traqula/algebra-transformations-1-2';
import { Parser, Store } from 'n3';
import { termToString } from 'rdf-string';
import type { expect as Expect } from 'vitest';
import { describe, it } from 'vitest';
import { PREDICATE_DERIVATION_OF, PREDICATE_DERIVED_FROM, PROVENANCE_NAMESPACE } from '../lib/consts.js';
import { mappingFromConstructQueries } from '../lib/mapping.js';
import {
  provenanceCapturingQuery,
  provenanceConstructOf,
  provenanceMappingFromConstructQueries,
} from '../lib/provenance.js';
import { createDefaultTransformationPipeline, createQueryRewriter } from '../lib/queryRewriter.js';
import { internalBnodeAsSpecialIriTransformation } from '../lib/transformations/bnodeMapAsLiteral.js';
import { createTransformationContext, parseQuery } from '../lib/transformContext.js';
import type { Mapping } from '../lib/types.js';
import { DF } from '../lib/utils/rdfDatatypes.js';

const prefixes = 'PREFIX : <ex://> PREFIX provenance: <https://sparql-extension.knows.idlab.ugent.be/provenance#> ';
// The provenance IRIs as a rewritten query writes them.
const derivationOf = `<${PREDICATE_DERIVATION_OF}>`;
const derivedFrom = `<${PREDICATE_DERIVED_FROM}>`;
const unbound = `<${PROVENANCE_NAMESPACE}unbound>`;
const construct0 = `<${PROVENANCE_NAMESPACE}construct0>`;
const colleagueConstructs = [
  `${prefixes} CONSTRUCT { ?s ?p ?o } WHERE { ?s ?p ?o }`,
  `${prefixes} CONSTRUCT { ?x :colleague ?y } WHERE { ?x :worksAt ?org . ?y :worksAt ?org . FILTER(?x != ?y) }`,
];
const colleaguesOfAlicesFriends = `${prefixes} SELECT DISTINCT ?c WHERE { :alice :knows ?f . ?f :colleague ?c }`;

type Row = Record<string, string>;

const engine = new QueryEngine();
const colleagues = new Store(new Parser().parse(readFileSync('./test/statics/colleagues.ttl', 'utf8')));

/**
 * Rewrites a query against a mapping and evaluates it over the colleagues data.
 * @param mapping - The mapping to unfold
 * @param query - The query over the view
 * @returns one record per solution, each term written as a string
 */
async function evaluate(mapping: Mapping, query: string): Promise<Row[]> {
  const rewriter = createQueryRewriter([
    ...createDefaultTransformationPipeline(mapping),
    internalBnodeAsSpecialIriTransformation(),
  ]);
  const bindings = await engine.queryBindings(await rewriter.rewriteQuery(query), {
    sources: [ colleagues ],
  });
  return (await bindings.toArray()).map(binding =>
    Object.fromEntries([ ...binding ].map(([ variable, term ]) => [ variable.value, termToString(term) ])));
}

/**
 * The distinct answers among some rows, restricted to the variables of the original query.
 * @param rows - The rows to read
 * @param variables - The variables of the original query
 * @returns the answers, sorted
 */
function distinctAnswers(rows: Row[], variables: readonly string[]): string[] {
  return [ ...new Set(rows.map(row => variables.map(variable => `${variable}=${row[variable]}`).join(' '))) ].sort();
}

describe('provenanceConstructOf', () => {
  const c = createTransformationContext();

  function expectProvenanceConstruct(expect: typeof Expect, constructQuery: string, expected: string): void {
    const construct = <Algebra.Construct> parseQuery(c, prefixes + constructQuery);
    const provenanceConstruct = provenanceConstructOf(c, construct, DF.namedNode(`${PROVENANCE_NAMESPACE}construct0`));
    expect(c.generator.generate(toAst(provenanceConstruct)).trim()).toEqual(expected.trim());
  }

  it('links a derivation to the triple it produces and the triple it matched', ({ expect }) => {
    expectProvenanceConstruct(
      expect,
      'CONSTRUCT { ?s ?p ?o } WHERE { ?s ?p ?o }',
      `CONSTRUCT {
  ?derivation0 ${derivationOf} <<( ?s ?p ?o )>> .
  ?derivation0 ${derivedFrom} <<( ?s ?p ?o )>> .
}
WHERE {
  ?s ?p ?o .
  BIND( <internal://blank> ( ${construct0} , ?s , ?p , ?o ) AS ?derivation0 )
}`,
    );
  });

  it('identifies a derivation by its CONSTRUCT and every variable of the body', ({ expect }) => {
    expectProvenanceConstruct(
      expect,
      'CONSTRUCT { ?x :colleague ?y } WHERE { ?x :worksAt ?org . ?y :worksAt ?org . FILTER(?x != ?y) }',
      `CONSTRUCT {
  ?derivation0 ${derivationOf} <<( ?x <ex://colleague> ?y )>> .
  ?derivation0 ${derivedFrom} <<( ?x <ex://worksAt> ?org )>> .
  ?derivation0 ${derivedFrom} <<( ?y <ex://worksAt> ?org )>> .
}
WHERE {
  {
    ?x <ex://worksAt> ?org .
    ?y <ex://worksAt> ?org .
    FILTER ( ( ?x != ?y ) )
  }
  BIND( <internal://blank> ( ${construct0} , ?x , ?org , ?y ) AS ?derivation0 )
}`,
    );
  });

  it('links one derivation to every triple of its template', ({ expect }) => {
    expectProvenanceConstruct(
      expect,
      'CONSTRUCT { ?x :name ?f . ?x a :Person } WHERE { ?x :firstName ?f }',
      `CONSTRUCT {
  ?derivation0 ${derivationOf} <<( ?x <ex://name> ?f )>> .
  ?derivation0 ${derivationOf} <<( ?x <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <ex://Person> )>> .
  ?derivation0 ${derivedFrom} <<( ?x <ex://firstName> ?f )>> .
}
WHERE {
  ?x <ex://firstName> ?f .
  BIND( <internal://blank> ( ${construct0} , ?x , ?f ) AS ?derivation0 )
}`,
    );
  });

  it('identifies a derivation by the value, or the unbound marker, of a variable a BIND may leave unbound', (
    { expect },
  ) => {
    expectProvenanceConstruct(
      expect,
      'CONSTRUCT { ?x :name ?n } WHERE { ?x :firstName ?f BIND(CONCAT(?f, "!") AS ?n) }',
      `CONSTRUCT {
  ?derivation0 <https://sparql-extension.knows.idlab.ugent.be/provenance#derivationOf> <<( ?x <ex://name> ?n )>> .
  ?derivation0 <https://sparql-extension.knows.idlab.ugent.be/provenance#derivedFrom> <<( ?x <ex://firstName> ?f )>> .
}
WHERE {
  ?x <ex://firstName> ?f .
  BIND( CONCAT( ?f , "!" ) AS ?n )
  BIND( <internal://blank> ( <https://sparql-extension.knows.idlab.ugent.be/provenance#construct0> , ?x , ?f , ?n ) AS ?derivation0 )
}`,
    );
  });

  it('identifies a derivation by an OPTIONAL variable, but links it only to the patterns outside', ({ expect }) => {
    expectProvenanceConstruct(
      expect,
      'CONSTRUCT { ?x :employed true } WHERE { ?x :worksAt :ugent OPTIONAL { ?x :knows ?y } }',
      `CONSTRUCT {
  ?derivation0 ${derivationOf} <<( ?x <ex://employed> TRUE )>> .
  ?derivation0 ${derivedFrom} <<( ?x <ex://worksAt> <ex://ugent> )>> .
}
WHERE {
  ?x <ex://worksAt> <ex://ugent> .
  OPTIONAL {
    ?x <ex://knows> ?y .
  }
  BIND( <internal://blank> ( ${construct0} , ?x , ?y ) AS ?derivation0 )
}`,
    );
  });

  it('links a derivation to no pattern of a MINUS', ({ expect }) => {
    expectProvenanceConstruct(
      expect,
      'CONSTRUCT { ?x :unemployed true } WHERE { ?x :knows ?y MINUS { ?x :worksAt ?o } }',
      `CONSTRUCT {
  ?derivation0 ${derivationOf} <<( ?x <ex://unemployed> TRUE )>> .
  ?derivation0 ${derivedFrom} <<( ?x <ex://knows> ?y )>> .
}
WHERE {
  ?x <ex://knows> ?y .
  MINUS {
    ?x <ex://worksAt> ?o .
  }
  BIND( <internal://blank> ( ${construct0} , ?x , ?y ) AS ?derivation0 )
}`,
    );
  });

  it('links a derivation to no pattern of a UNION, as a solution matches only one branch', ({ expect }) => {
    expectProvenanceConstruct(
      expect,
      'CONSTRUCT { ?x :reaches ?y } WHERE { { ?x :knows ?y } UNION { ?x :colleague ?y } }',
      `CONSTRUCT {
  ?derivation0 ${derivationOf} <<( ?x <ex://reaches> ?y )>> .
}
WHERE {
  {
    ?x <ex://knows> ?y .
  }
  UNION {
    ?x <ex://colleague> ?y .
  }
  BIND( <internal://blank> ( ${construct0} , ?x , ?y ) AS ?derivation0 )
}`,
    );
  });

  it('links a derivation to no pattern of a sub-SELECT', ({ expect }) => {
    expectProvenanceConstruct(
      expect,
      'CONSTRUCT { ?x :friends ?n } WHERE { { SELECT ?x (COUNT(*) AS ?n) WHERE { ?x :knows ?y } GROUP BY ?x } }',
      `CONSTRUCT {
  ?derivation0 ${derivationOf} <<( ?x <ex://friends> ?n )>> .
}
WHERE {
  {
    SELECT ?x ( COUNT( * ) AS ?n ) WHERE {
      ?x <ex://knows> ?y .
    }
    GROUP BY ?x
  }
  BIND( <internal://blank> ( ${construct0} , ?x , ?n ) AS ?derivation0 )
}`,
    );
  });

  it('coins a derivation variable the CONSTRUCT does not use yet', ({ expect }) => {
    expectProvenanceConstruct(
      expect,
      'CONSTRUCT { ?derivation0 :p ?o } WHERE { ?derivation0 :q ?o }',
      `CONSTRUCT {
  ?derivation1 ${derivationOf} <<( ?derivation0 <ex://p> ?o )>> .
  ?derivation1 ${derivedFrom} <<( ?derivation0 <ex://q> ?o )>> .
}
WHERE {
  ?derivation0 <ex://q> ?o .
  BIND( <internal://blank> ( ${construct0} , ?derivation0 , ?o ) AS ?derivation1 )
}`,
    );
  });
});

describe('provenanceCapturingQuery', () => {
  function expectCapture(expect: typeof Expect, query: string, expected: string): void {
    expect(provenanceCapturingQuery(prefixes + query).trim()).toEqual(expected.trim());
  }

  it('looks up one derivation per triple pattern and selects it', ({ expect }) => {
    expectCapture(
      expect,
      'SELECT DISTINCT ?c WHERE { :alice :knows ?f . ?f :colleague ?c }',
      `SELECT DISTINCT ?c ?derivation0 ?derivation1 WHERE {
  ?derivation0 ${derivationOf} <<( <ex://alice> <ex://knows> ?f )>> .
  ?derivation1 ${derivationOf} <<( ?f <ex://colleague> ?c )>> .
}`,
    );
  });

  it('selects the derivation of a pattern under an OPTIONAL', ({ expect }) => {
    expectCapture(
      expect,
      'SELECT ?x WHERE { ?x :worksAt :ugent OPTIONAL { ?x :knows ?y } }',
      `SELECT ?x ?derivation0 ?derivation1 WHERE {
  ?derivation0 ${derivationOf} <<( ?x <ex://worksAt> <ex://ugent> )>> .
  OPTIONAL {
    ?derivation1 ${derivationOf} <<( ?x <ex://knows> ?y )>> .
  }
}`,
    );
  });

  it('selects no derivation of a pattern under a MINUS', ({ expect }) => {
    expectCapture(
      expect,
      'SELECT ?x WHERE { ?x :worksAt :ugent MINUS { ?x :worksAt :imec } }',
      `SELECT ?x ?derivation0 WHERE {
  ?derivation0 ${derivationOf} <<( ?x <ex://worksAt> <ex://ugent> )>> .
  MINUS {
    ?derivation1 ${derivationOf} <<( ?x <ex://worksAt> <ex://imec> )>> .
  }
}`,
    );
  });

  it('selects no derivation of a pattern under a NOT EXISTS', ({ expect }) => {
    expectCapture(
      expect,
      'SELECT ?x WHERE { ?x :worksAt :ugent FILTER NOT EXISTS { ?x :knows ?y } }',
      `SELECT ?x ?derivation1 WHERE {
  ?derivation1 ${derivationOf} <<( ?x <ex://worksAt> <ex://ugent> )>> .
  FILTER ( NOT EXISTS {
    ?derivation0 ${derivationOf} <<( ?x <ex://knows> ?y )>> .
  }
  )
}`,
    );
  });

  it('selects the derivations of both branches of a UNION', ({ expect }) => {
    expectCapture(
      expect,
      'SELECT ?x WHERE { { ?x :knows ?y } UNION { ?x :colleague :dave } }',
      `SELECT ?x ?derivation0 ?derivation1 WHERE {
  {
    ?derivation0 ${derivationOf} <<( ?x <ex://knows> ?y )>> .
  }
  UNION {
    ?derivation1 ${derivationOf} <<( ?x <ex://colleague> <ex://dave> )>> .
  }
}`,
    );
  });

  it('looks up a derivation per step of a non-recursive property path', ({ expect }) => {
    expectCapture(
      expect,
      'SELECT ?x WHERE { :alice :knows/:colleague ?x }',
      `SELECT ?x ?derivation0 ?derivation1 WHERE {
  ?derivation0 ${derivationOf} <<( <ex://alice> <ex://knows> ?var0 )>> .
  ?derivation1 ${derivationOf} <<( ?var0 <ex://colleague> ?x )>> .
}`,
    );
  });

  it('selects the derivations of a sub-SELECT through it', ({ expect }) => {
    expectCapture(
      expect,
      'SELECT ?x WHERE { { SELECT ?x WHERE { ?x :knows ?y } } }',
      `SELECT ?x ?derivation0 WHERE {
  SELECT ?x ?derivation0 WHERE {
    ?derivation0 ${derivationOf} <<( ?x <ex://knows> ?y )>> .
  }
}`,
    );
  });

  it('leaves a SERVICE alone', ({ expect }) => {
    expectCapture(
      expect,
      'SELECT ?x WHERE { SERVICE <ex://endpoint> { ?x :knows ?y } ?x :worksAt ?o }',
      `SELECT ?x ?derivation0 WHERE {
  SERVICE <ex://endpoint> {
    ?x <ex://knows> ?y .
  }
  ?derivation0 ${derivationOf} <<( ?x <ex://worksAt> ?o )>> .
}`,
    );
  });

  it('groups without derivations and attaches those of the group\'s solutions, joined on its key', ({ expect }) => {
    expectCapture(
      expect,
      'SELECT ?x (COUNT(*) AS ?n) WHERE { ?x :colleague ?y } GROUP BY ?x',
      `SELECT ?x ?n ?derivation0 WHERE {
  {
    SELECT ?x ( COUNT( * ) AS ?n ) WHERE {
      SELECT ?x ?y WHERE {
        ?internal0 ${derivationOf} <<( ?x <ex://colleague> ?y )>> .
      }
    }
    GROUP BY ?x
  }
  OPTIONAL {
    {
      SELECT ?x ?derivation0 WHERE {
        ?derivation0 ${derivationOf} <<( ?x <ex://colleague> ?y )>> .
      }
    }
  }
}`,
    );
  });

  it('selects a group key the query does not, to join on it', ({ expect }) => {
    expectCapture(
      expect,
      'SELECT (COUNT(*) AS ?n) WHERE { ?x :colleague ?y } GROUP BY ?x',
      `SELECT ?n ?derivation0 WHERE {
  {
    SELECT ( COUNT( * ) AS ?n ) ?x WHERE {
      SELECT ?x ?y WHERE {
        ?internal0 ${derivationOf} <<( ?x <ex://colleague> ?y )>> .
      }
    }
    GROUP BY ?x
  }
  OPTIONAL {
    {
      SELECT ?x ?derivation0 WHERE {
        ?derivation0 ${derivationOf} <<( ?x <ex://colleague> ?y )>> .
      }
    }
  }
}`,
    );
  });

  it('joins on a key coalescing a group key that may be unbound', ({ expect }) => {
    expectCapture(
      expect,
      'SELECT ?x ?o WHERE { ?x :worksAt :ugent OPTIONAL { ?x :knows ?o } } GROUP BY ?x ?o',
      `SELECT ?x ?o ?derivation0 ?derivation1 WHERE {
  {
    {
      SELECT ?x ?o WHERE {
        {
          SELECT ?x WHERE {
            ?internal0 ${derivationOf} <<( ?x <ex://worksAt> <ex://ugent> )>> .
          }
        }
        OPTIONAL {
          {
            SELECT ?x ?o WHERE {
              ?internal1 ${derivationOf} <<( ?x <ex://knows> ?o )>> .
            }
          }
        }
      }
      GROUP BY ?x ?o
    }
    BIND( COALESCE( ?o , ${unbound} ) AS ?internal2 )
  }
  OPTIONAL {
    {
      SELECT ?x ( COALESCE( ?o , ${unbound} ) AS ?internal2 ) ?derivation0 ?derivation1 WHERE {
        ?derivation0 ${derivationOf} <<( ?x <ex://worksAt> <ex://ugent> )>> .
        OPTIONAL {
          ?derivation1 ${derivationOf} <<( ?x <ex://knows> ?o )>> .
        }
      }
    }
  }
}`,
    );
  });

  it('attaches the derivations of a group without a key through a join on nothing', ({ expect }) => {
    expectCapture(
      expect,
      'SELECT (COUNT(*) AS ?n) WHERE { :alice :knows :bob }',
      `SELECT ?n ?derivation0 WHERE {
  {
    SELECT ( COUNT( * ) AS ?n ) WHERE {
      SELECT ?mExists0 WHERE {
        ?internal0 ${derivationOf} <<( <ex://alice> <ex://knows> <ex://bob> )>> .
      }
    }
  }
  OPTIONAL {
    {
      SELECT ?derivation0 WHERE {
        ?derivation0 ${derivationOf} <<( <ex://alice> <ex://knows> <ex://bob> )>> .
      }
    }
  }
}`,
    );
  });

  it('limits the answers without derivations and attaches those of their solutions, unordered', ({ expect }) => {
    expectCapture(
      expect,
      'SELECT ?x ?y WHERE { ?x :colleague ?y } ORDER BY ?x LIMIT 2',
      `SELECT ?x ?y ?derivation0 WHERE {
  {
    SELECT DISTINCT ?x ?y WHERE {
      SELECT ?x ?y WHERE {
        SELECT ?x ?y WHERE {
          ?internal0 ${derivationOf} <<( ?x <ex://colleague> ?y )>> .
        }
      }
      ORDER BY ASC ( ?x )
      LIMIT 2
    }
  }
  OPTIONAL {
    {
      SELECT ?x ?y ?derivation0 WHERE {
        SELECT ?x ?y ?derivation0 WHERE {
          ?derivation0 ${derivationOf} <<( ?x <ex://colleague> ?y )>> .
        }
      }
    }
  }
}`,
    );
  });

  it('rejects a query that is not a SELECT', ({ expect }) => {
    expect(() => provenanceCapturingQuery(`${prefixes} ASK { ?x :worksAt :ugent }`))
      .toThrow('Provenance can only be captured for a SELECT query.');
  });

  it('rejects a recursive property path', ({ expect }) => {
    expect(() => provenanceCapturingQuery(`${prefixes} SELECT ?x WHERE { :alice :knows+ ?x }`))
      .toThrow('A recursive property path (+) is not supported');
  });
});

describe('provenance captured over the colleagues data', () => {
  const mapping = mappingFromConstructQueries(colleagueConstructs);
  const provenanceMapping = provenanceMappingFromConstructQueries(colleagueConstructs);

  it.for(<const> [
    [ 'SELECT DISTINCT ?c WHERE { :alice :knows ?f . ?f :colleague ?c }', [ 'c' ]],
    [ 'SELECT ?c WHERE { :alice :knows ?f . ?f :colleague ?c }', [ 'c' ]],
    [ 'SELECT ?x ?o WHERE { ?x :worksAt :ugent OPTIONAL { ?x :worksAt ?o FILTER(?o != :ugent) } }', [ 'x', 'o' ]],
    [ 'SELECT ?x WHERE { ?x :worksAt :ugent MINUS { ?x :worksAt :imec } }', [ 'x' ]],
    [ 'SELECT ?x WHERE { { ?x :knows ?y } UNION { ?x :colleague :dave } }', [ 'x' ]],
    [ 'SELECT ?x (COUNT(*) AS ?n) WHERE { ?x :colleague ?y } GROUP BY ?x', [ 'x', 'n' ]],
    [ 'SELECT ?x ?o WHERE { ?x :worksAt :ugent OPTIONAL { ?x :knows ?o } } GROUP BY ?x ?o', [ 'x', 'o' ]],
    [ 'SELECT (COUNT(*) AS ?n) WHERE { ?x :colleague :nobody }', [ 'n' ]],
    [ 'SELECT ?x ?y WHERE { ?x :colleague ?y } ORDER BY ?x ?y LIMIT 2', [ 'x', 'y' ]],
    [ 'SELECT ?x WHERE { { SELECT DISTINCT ?x WHERE { ?x :worksAt ?o } } }', [ 'x' ]],
    [ 'SELECT (COUNT(*) AS ?n) WHERE { ?x :colleague ?y } GROUP BY ?x ORDER BY ?x LIMIT 1', [ 'n' ]],
    [ 'SELECT ?x WHERE { { SELECT ?x WHERE { ?x :worksAt ?o } GROUP BY ?x } } ORDER BY ?x LIMIT 1', [ 'x' ]],
  ])('answers %s as the query without provenance does', async([ query, variables ], { expect }) => {
    const [ rowsWithProvenance, rows ] = await Promise.all([
      evaluate(provenanceMapping, provenanceCapturingQuery(prefixes + query)),
      evaluate(mapping, prefixes + query),
    ]);
    expect(distinctAnswers(rowsWithProvenance, variables)).toEqual(distinctAnswers(rows, variables));
  });

  it('answers once per combination of derivations', async({ expect }) => {
    const rows = await evaluate(provenanceMapping, provenanceCapturingQuery(colleaguesOfAlicesFriends));
    const derivationsOf = (colleague: string): string[] =>
      rows.filter(row => row.c === colleague).map(row => row.derivation1);

    // Carol works with Bob at two organisations, Dave at one; both through the one triple Alice knows Bob.
    expect(new Set(derivationsOf('ex://carol')).size).toBe(2);
    expect(derivationsOf('ex://dave')).toHaveLength(1);
    expect(new Set(rows.map(row => row.derivation0)).size).toBe(1);
  });

  it('attaches to a group the derivations of its solutions, its key selected or not', async({ expect }) => {
    const rows = await evaluate(provenanceMapping, provenanceCapturingQuery(
      `${prefixes} SELECT (COUNT(*) AS ?n) WHERE { ?x :colleague ?y } GROUP BY ?x`,
    ));

    // Bob and Carol have three colleague derivations each, Dave two: every one is attached to its own group.
    expect(rows.map(row => row.n.split('^^')[0]).sort())
      .toEqual([ '"2"', '"2"', '"3"', '"3"', '"3"', '"3"', '"3"', '"3"' ]);
    expect(new Set(rows.map(row => row.derivation0)).size).toBe(8);
  });

  it('links a derivation to the source triples it matched', async({ expect }) => {
    const rows = await evaluate(provenanceMapping, `${prefixes} SELECT ?derivation ?source WHERE {
      ?derivation provenance:derivationOf <<( :bob :colleague :carol )>> ; provenance:derivedFrom ?source .
    }`);

    expect(distinctAnswers(rows, [ 'source' ])).toEqual([
      'source=<<ex://bob ex://worksAt ex://imec>>',
      'source=<<ex://bob ex://worksAt ex://ugent>>',
      'source=<<ex://carol ex://worksAt ex://imec>>',
      'source=<<ex://carol ex://worksAt ex://ugent>>',
    ]);
    expect(new Set(rows.map(row => row.derivation)).size).toBe(2);
  });

  it('tells apart the solutions of a body that differ in a variable it may leave unbound', async({ expect }) => {
    const rows = await evaluate(provenanceMappingFromConstructQueries([
      `${prefixes} CONSTRUCT { ?x :employed true } WHERE { ?x :worksAt :ugent OPTIONAL { ?x :worksAt ?other } }`,
    ]), `${prefixes} SELECT ?derivation WHERE { ?derivation provenance:derivationOf <<( :bob :employed true )>> }`);

    // Bob works at UGent and at imec, so the OPTIONAL gives him two solutions.
    expect(new Set(rows.map(row => row.derivation)).size).toBe(2);
  });

  it('links a derivation only to the source triples every solution of the body matches', async({ expect }) => {
    const rows = await evaluate(provenanceMappingFromConstructQueries([
      `${prefixes} CONSTRUCT { ?x :employed true } WHERE { ?x :worksAt :ugent OPTIONAL { ?x :knows ?y } }`,
    ]), `${prefixes} SELECT ?source WHERE {
      ?derivation provenance:derivationOf <<( :bob :employed true )>> ; provenance:derivedFrom ?source .
    }`);

    expect(distinctAnswers(rows, [ 'source' ])).toEqual([ 'source=<<ex://bob ex://worksAt ex://ugent>>' ]);
  });
});
