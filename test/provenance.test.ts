import { readFileSync } from 'node:fs';
import { QueryEngine } from '@comunica/query-sparql-file';
import type * as RDF from '@rdfjs/types';
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
import type { ProvenanceAnnotatedAnswer } from '../lib/provenancePolynomial.js';
import {
  countingSpmSemiring,
  decodeProvenance,
  evaluatePolynomial,
  lineageOf,
  polynomialToString,
} from '../lib/provenancePolynomial.js';
import { createDefaultTransformationPipeline, createQueryRewriter } from '../lib/queryRewriter.js';
import { internalBnodeExtensionFunctions } from '../lib/transformations/bnodeExtensionFunction.js';
import { internalBnodeAsSpecialIriTransformation } from '../lib/transformations/bnodeMapAsLiteral.js';
import type { UnfoldingOptions } from '../lib/transformations/unfolding.js';
import { createTransformationContext, parseQuery } from '../lib/transformContext.js';
import type { Mapping } from '../lib/types.js';
import { DF } from '../lib/utils/rdfDatatypes.js';

const prefixes = `PREFIX : <ex://> PREFIX provenance: <${PROVENANCE_NAMESPACE}> `;
// The provenance IRIs as a rewritten query writes them.
const derivationOf = `<${PREDICATE_DERIVATION_OF}>`;
const derivedFrom = `<${PREDICATE_DERIVED_FROM}>`;
const construct0 = `<${PROVENANCE_NAMESPACE}construct0>`;
const colleagueConstructs = [
  `${prefixes} CONSTRUCT { ?s ?p ?o } WHERE { ?s ?p ?o }`,
  `${prefixes} CONSTRUCT { ?x :colleague ?y } WHERE { ?x :worksAt ?org . ?y :worksAt ?org . FILTER(?x != ?y) }`,
];

type Row = Record<string, string>;

const engine = new QueryEngine();
const colleagues = new Store(new Parser().parse(readFileSync('./test/statics/colleagues.ttl', 'utf8')));

/**
 * Rewrites a query against a mapping and evaluates it over the colleagues data.
 * @param mapping - The mapping to unfold
 * @param query - The query over the view
 * @param options - What to configure the unfolding with
 * @returns the solutions
 */
async function bindingsOf(mapping: Mapping, query: string, options: UnfoldingOptions = {}): Promise<RDF.Bindings[]> {
  const rewriter = createQueryRewriter([
    ...createDefaultTransformationPipeline(mapping, options),
    internalBnodeAsSpecialIriTransformation({ encodedByExtensionFunction: true }),
  ]);
  const bindings = await engine.queryBindings(await rewriter.rewriteQuery(query), {
    sources: [ colleagues ],
    extensionFunctions: internalBnodeExtensionFunctions(),
  });
  return bindings.toArray();
}

/**
 * As {@link bindingsOf}, each term written as a string.
 * @param mapping - The mapping to unfold
 * @param query - The query over the view
 * @param options - What to configure the unfolding with
 * @returns one record per solution
 */
async function evaluate(mapping: Mapping, query: string, options: UnfoldingOptions = {}): Promise<Row[]> {
  return (await bindingsOf(mapping, query, options)).map(binding =>
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
  ?derivation0 ${derivationOf} <<( ?x <ex://name> ?n )>> .
  ?derivation0 ${derivedFrom} <<( ?x <ex://firstName> ?f )>> .
}
WHERE {
  ?x <ex://firstName> ?f .
  BIND( CONCAT( ?f , "!" ) AS ?n )
  BIND( <internal://blank> ( ${construct0} , ?x , ?f , ?n ) AS ?derivation0 )
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
  it('reifies a triple pattern as the sum of its derivations, each node identified by its solution', ({ expect }) => {
    const capture = provenanceCapturingQuery(`${prefixes} SELECT ?x WHERE { ?x :worksAt :ugent }`);

    expect(capture.provenanceVariablePrefix).toBe('prov');
    expect(capture.query.trim()).toBe(`SELECT ?x ?prov_sum_sum_statement \
( <internal://blank> ( "prov_sum_sum" , ?x ) AS ?prov_sum_sum ) \
( <internal://blank> ( "prov_sum" , ?x ) AS ?prov_sum ) WHERE {
  ?prov_sum_sum_statement ${derivationOf} <<( ?x <ex://worksAt> <ex://ugent> )>> .
}`.replaceAll(' \\\n', ' '));
  });

  it('coins a provenance variable prefix no variable of the query starts with', ({ expect }) => {
    expect(provenanceCapturingQuery(`${prefixes} SELECT ?prov_x WHERE { ?prov_x :knows ?y }`).provenanceVariablePrefix)
      .toBe('prov1');
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

  /**
   * Captures the provenance of a query, evaluates it over the provenance view and decodes its answers.
   * @param query - The query over the view, without prefixes
   * @returns the decoded solutions
   */
  async function decodedAnswersOf(query: string): Promise<ProvenanceAnnotatedAnswer[]> {
    const capture = provenanceCapturingQuery(prefixes + query);
    return decodeProvenance(await bindingsOf(provenanceMapping, capture.query), capture.provenanceVariablePrefix);
  }

  let derivationLabels: Promise<Map<string, string>> | undefined;

  /**
   * Labels every derivation by the view triple it produces and, where they differ, the source triples it matched.
   * @returns the labels by derivation
   */
  async function labelDerivations(): Promise<Map<string, string>> {
    const links = await evaluate(provenanceMapping, `${prefixes} SELECT ?derivation ?viewTriple ?source WHERE {
      ?derivation provenance:derivationOf ?viewTriple . OPTIONAL { ?derivation provenance:derivedFrom ?source }
    }`);
    const compact = (triple: string): string => triple.replaceAll(/<<|>>|ex:\/\//gu, '');
    const labels = new Map<string, string>();
    for (const derivation of new Set(links.map(link => link.derivation))) {
      const linksOfDerivation = links.filter(link => link.derivation === derivation);
      const viewTriple = linksOfDerivation[0].viewTriple;
      const sources = linksOfDerivation.map(link => link.source).filter(source => source !== viewTriple).sort();
      labels.set(derivation, sources.length === 0 ?
        compact(viewTriple) :
        `${compact(viewTriple)} from ${sources.map(compact).join(' and ')}`);
    }
    return labels;
  }

  /**
   * Captures the provenance of a query, evaluates it and decodes its answers.
   * @param query - The query over the view, without prefixes
   * @returns per solution `+` for an answer or `-` for a solution a difference removes, its values and polynomial
   */
  async function explain(query: string): Promise<string[]> {
    derivationLabels ??= labelDerivations();
    const [ answers, labels ] = await Promise.all([ decodedAnswersOf(query), derivationLabels ]);
    return answers.map(({ answer, polynomial, isAnswer }) => {
      const values = [ ...answer ].map(([ name, term ]) => `${name}=${termToString(term).replace('ex://', '')}`)
        .sort().join(' ');
      const explanation = polynomialToString(polynomial, term => labels.get(termToString(term))!);
      return `${isAnswer ? '+' : '-'} ${values}: ${explanation}`;
    }).sort();
  }

  // FILTER (NOT) EXISTS is left out: the rewrite without provenance gets a correlated one wrong on main.
  it.for(<const> [
    'SELECT DISTINCT ?c WHERE { :alice :knows ?f . ?f :colleague ?c }',
    'SELECT ?x ?o WHERE { ?x :worksAt :ugent OPTIONAL { ?x :worksAt ?o FILTER(?o != :ugent) } }',
    'SELECT ?x WHERE { ?x :worksAt :ugent OPTIONAL { ?x :knows ?y } }',
    'SELECT ?x WHERE { ?x :worksAt :ugent MINUS { ?x :worksAt :imec } }',
    'SELECT ?x WHERE { { ?x :knows ?y } UNION { ?x :colleague :dave } }',
    'SELECT ?x ?n WHERE { VALUES ?x { :bob :erin } ?x :worksAt :ugent BIND(1 AS ?n) }',
    'SELECT ?x (COUNT(*) AS ?n) WHERE { ?x :colleague ?y } GROUP BY ?x',
    'SELECT ?x ?o WHERE { ?x :worksAt :ugent OPTIONAL { ?x :knows ?o } } GROUP BY ?x ?o',
    'SELECT (COUNT(*) AS ?n) WHERE { ?x :colleague :nobody }',
    'SELECT ?x ?y WHERE { ?x :colleague ?y } ORDER BY ?x ?y LIMIT 2',
    'SELECT ?x WHERE { { SELECT DISTINCT ?x WHERE { ?x :worksAt ?o } } }',
    'SELECT (COUNT(*) AS ?n) WHERE { ?x :colleague ?y } GROUP BY ?x ORDER BY ?x LIMIT 1',
    'SELECT ?x WHERE { { SELECT ?x WHERE { ?x :worksAt ?o } GROUP BY ?x } } ORDER BY ?x LIMIT 1',
    'SELECT ?x (COUNT(*) AS ?n) WHERE { ?x :colleague ?y } GROUP BY ?x VALUES ?x { :bob }',
  ])('answers %s as the query without provenance does', async(query, { expect }) => {
    const [ decodedAnswers, rows ] = await Promise.all([
      decodedAnswersOf(query),
      // The answers keep the view's set semantics, whatever the unfolding preserves.
      evaluate(mapping, prefixes + query, { preserveCardinality: true }),
    ]);
    const answers = decodedAnswers
      .filter(({ isAnswer }) => isAnswer)
      .map(({ answer }) => Object.fromEntries([ ...answer ].map(([ name, term ]) => [ name, termToString(term) ])));
    const variables = [ ...new Set(rows.flatMap(row => Object.keys(row))) ];
    expect(distinctAnswers(answers, variables)).toEqual(distinctAnswers(rows, variables));
  });

  it('multiplies the derivations of a join and sums those of one view triple', async({ expect }) => {
    // Carol works with Bob at two organisations, Dave at one; both through the one triple Alice knows Bob.
    expect(await explain('SELECT ?c WHERE { :alice :knows ?f . ?f :colleague ?c }')).toEqual([
      '+ c=carol: ((bob colleague carol from bob worksAt imec and carol worksAt imec ⊕ ' +
      'bob colleague carol from bob worksAt ugent and carol worksAt ugent) ⊗ alice knows bob)',
      '+ c=dave: (alice knows bob ⊗ bob colleague dave from bob worksAt ugent and dave worksAt ugent)',
    ]);
  });

  it('sums the derivations of the branches of a UNION', async({ expect }) => {
    expect(await explain('SELECT ?x WHERE { { ?x :worksAt :imec } UNION { ?x :colleague :dave } }')).toEqual([
      '+ x=bob: (bob colleague dave from bob worksAt ugent and dave worksAt ugent ⊕ bob worksAt imec)',
      '+ x=carol: (carol colleague dave from carol worksAt ugent and dave worksAt ugent ⊕ carol worksAt imec)',
    ]);
  });

  it('subtracts the derivations of the solutions a MINUS or NOT EXISTS removes with', async({ expect }) => {
    const expected = [
      '+ x=dave: (dave worksAt ugent ⊖ 0)',
      '- x=bob: (bob worksAt ugent ⊖ bob worksAt imec)',
      '- x=carol: (carol worksAt ugent ⊖ carol worksAt imec)',
    ];
    expect(await explain('SELECT ?x WHERE { ?x :worksAt :ugent MINUS { ?x :worksAt :imec } }')).toEqual(expected);
    expect(await explain('SELECT ?x WHERE { ?x :worksAt :ugent FILTER NOT EXISTS { ?x :worksAt :imec } }'))
      .toEqual(expected);
  });

  it('keeps a solution of an EXISTS as the difference with its difference', async({ expect }) => {
    expect(await explain('SELECT ?x WHERE { ?x :worksAt :ugent FILTER EXISTS { ?x :worksAt :imec } }')).toEqual([
      '+ x=bob: (bob worksAt ugent ⊖ (bob worksAt ugent ⊖ bob worksAt imec))',
      '+ x=carol: (carol worksAt ugent ⊖ (carol worksAt ugent ⊖ carol worksAt imec))',
      '- x=dave: (dave worksAt ugent ⊖ (dave worksAt ugent ⊖ 0))',
    ]);
  });

  it('explains an OPTIONAL as the join of both sides plus the left side less the right', async({ expect }) => {
    expect(await explain('SELECT ?x ?o WHERE { ?x :worksAt :ugent OPTIONAL { ?x :knows ?o } }')).toEqual([
      '+ x=bob: (bob worksAt ugent ⊖ 0)',
      '+ x=carol: (carol worksAt ugent ⊖ 0)',
      '+ x=dave: (dave worksAt ugent ⊖ 0)',
    ]);
    expect(await explain('SELECT ?x ?o WHERE { ?x :worksAt :ugent OPTIONAL { ?x :worksAt ?o FILTER(?o != :ugent) } }'))
      .toEqual([
        '+ o=imec x=bob: (bob worksAt imec ⊗ bob worksAt ugent)',
        '+ o=imec x=carol: (carol worksAt imec ⊗ carol worksAt ugent)',
        '+ x=dave: (dave worksAt ugent ⊖ 0)',
        '- x=bob: (bob worksAt ugent ⊖ bob worksAt imec)',
        '- x=carol: (carol worksAt ugent ⊖ carol worksAt imec)',
      ]);
  });

  it('subtracts from every row of an OPTIONAL, its unmatched left side included', async({ expect }) => {
    expect(await explain(
      'SELECT ?x ?o WHERE { { ?x :worksAt :ugent OPTIONAL { ?x :worksAt ?o FILTER(?o != :ugent) } } ' +
      'MINUS { ?x :worksAt :imec } }',
    )).toEqual([
      '+ x=dave: ((dave worksAt ugent ⊖ 0) ⊖ 0)',
      '- o=imec x=bob: ((bob worksAt imec ⊗ bob worksAt ugent) ⊖ bob worksAt imec)',
      '- o=imec x=carol: ((carol worksAt imec ⊗ carol worksAt ugent) ⊖ carol worksAt imec)',
      '- x=bob: ((bob worksAt ugent ⊖ bob worksAt imec) ⊖ bob worksAt imec)',
      '- x=carol: ((carol worksAt ugent ⊖ carol worksAt imec) ⊖ carol worksAt imec)',
    ]);
  });

  it('evaluates an EXISTS nested in an expression over the view, contributing no provenance', async({ expect }) => {
    // Uncorrelated: the rewrite without provenance loses a correlated EXISTS in an expression on main.
    expect(await explain('SELECT ?x ?e WHERE { ?x :worksAt :imec BIND(EXISTS { :dave :worksAt :ugent } AS ?e) }'))
      .toEqual([
        '+ e="true"^^http://www.w3.org/2001/XMLSchema#boolean x=bob: bob worksAt imec',
        '+ e="true"^^http://www.w3.org/2001/XMLSchema#boolean x=carol: carol worksAt imec',
      ]);
  });

  it('marks the derivations of an aggregated group by the lineage δ', async({ expect }) => {
    expect(await explain('SELECT ?x (COUNT(*) AS ?n) WHERE { ?x :colleague ?y } GROUP BY ?x VALUES ?x { :dave }'))
      .toEqual([
        '+ n="2"^^http://www.w3.org/2001/XMLSchema#integer x=dave: δ(dave colleague bob from bob worksAt ugent and ' +
        'dave worksAt ugent ⊕ dave colleague carol from carol worksAt ugent and dave worksAt ugent)',
      ]);
    expect(await explain('SELECT (COUNT(*) AS ?n) WHERE { ?x :colleague :nobody }'))
      .toEqual([ '+ n="0"^^http://www.w3.org/2001/XMLSchema#integer: δ0' ]);
  });

  it('annotates a solution produced from no view triple with 1', async({ expect }) => {
    expect(await explain('SELECT ?x WHERE { VALUES ?x { :dave } }')).toEqual([ '+ x=dave: 1' ]);
  });

  it('counts the derivations of an answer in the spm-semiring of natural numbers', async({ expect }) => {
    const answers = await decodedAnswersOf('SELECT ?c WHERE { :alice :knows ?f . ?f :colleague ?c }');
    const counts = Object.fromEntries(answers.map(({ answer, polynomial }) =>
      [ answer.get('c')!.value, evaluatePolynomial(polynomial, countingSpmSemiring, () => 1) ]));

    expect(counts).toEqual({ 'ex://carol': 2, 'ex://dave': 1 });
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

describe('provenance, the whole story', () => {
  it('traces a grouped answer over the view back to the source triples it rests on', async({ expect }) => {
    // The source data (test/statics/colleagues.ttl): Bob and Carol work at UGent and imec, Dave at UGent only.
    // The view: two people working at the same organisation are colleagues.
    const view = [
      `${prefixes} CONSTRUCT { ?x :colleague ?y } WHERE { ?x :worksAt ?org . ?y :worksAt ?org . FILTER(?x != ?y) }`,
    ];
    // A user asks the view how many colleagues each person has.
    const query = `${prefixes} SELECT ?x (COUNT(*) AS ?colleagues) WHERE { ?x :colleague ?y } GROUP BY ?x`;

    // 1. The provenance view: every solution of the view's body is a derivation, `derivationOf` the view triple it
    //    produces and `derivedFrom` the source triples it matched. SPARQLprov (Hernández et al., "Computing
    //    How-Provenance for SPARQL Queries via Query Rewriting", https://doi.org/10.14778/3484224.3484235) and NPCS
    //    (Asma et al., "NPCS: Native Provenance Computation for SPARQL", https://doi.org/10.1145/3589334.3645557)
    //    need the data stored reified; NPCS (p. 2092) leaves non-reified data as future work. This view supplies the
    //    reification virtually: the derivations are SPARQLprov's sources, `derivationOf` its reification scheme.
    const provenanceMapping = provenanceMappingFromConstructQueries(view);

    // 2. The query is rewritten as SPARQLprov rewrites it (Def. 4.12 and 4.17): every triple pattern reified by a
    //    lookup of the derivations of the view triple it matches, and every operator encoding its node of the
    //    answer's polynomial in provenance variables `?prov_…`. The GROUP duplicates its subtree: the counts are
    //    computed without provenance, and the provenance of each group's solutions joined onto its answer.
    const capture = provenanceCapturingQuery(query);

    // 3. Unfolded onto the source and evaluated, with Comunica encoding the identities, the answers decode into their
    //    polynomials (Def. 4.10). Bob has two colleagues, as the view without provenance says, resting on three
    //    derivations: Carol through UGent, Carol through imec, and Dave through UGent. δ marks them as aggregated
    //    (Def. 4.15).
    const answers = decodeProvenance(
      await bindingsOf(provenanceMapping, capture.query),
      capture.provenanceVariablePrefix,
    );
    const bobsAnswer = answers.find(({ answer }) => answer.get('x')!.value === 'ex://bob')!;
    expect(bobsAnswer.answer.get('colleagues')!.value).toBe('2');
    expect(bobsAnswer.polynomial.type).toBe('aggregate');
    const bobsDerivations = lineageOf(bobsAnswer.polynomial).map(termToString);
    expect(bobsDerivations).toHaveLength(3);

    // 4. Every derivation leads back, through the provenance view, to the view triple it produced and the source
    //    triples it matched.
    const links = await evaluate(provenanceMapping, `${prefixes} SELECT ?derivation ?viewTriple ?source WHERE {
      ?derivation provenance:derivationOf ?viewTriple ; provenance:derivedFrom ?source .
    }`);
    const traceOf = (derivation: string): string => {
      const linksOfDerivation = links.filter(link => link.derivation === derivation);
      const sources = linksOfDerivation.map(link => link.source).sort().join(' and ');
      return `${linksOfDerivation[0].viewTriple} from ${sources}`;
    };
    expect(polynomialToString(bobsAnswer.polynomial, term => traceOf(termToString(term)))).toBe(
      'δ(<<ex://bob ex://colleague ex://carol>> from <<ex://bob ex://worksAt ex://imec>> and ' +
      '<<ex://carol ex://worksAt ex://imec>> ⊕ <<ex://bob ex://colleague ex://carol>> from ' +
      '<<ex://bob ex://worksAt ex://ugent>> and <<ex://carol ex://worksAt ex://ugent>> ⊕ ' +
      '<<ex://bob ex://colleague ex://dave>> from <<ex://bob ex://worksAt ex://ugent>> and ' +
      '<<ex://dave ex://worksAt ex://ugent>>)',
    );
  });
});
