import { readFileSync } from 'node:fs';
import { QueryEngine } from '@comunica/query-sparql-file';
import type * as RDF from '@rdfjs/types';
import { Parser, Store } from 'n3';
import { termToString } from 'rdf-string';
import type { expect as Expect } from 'vitest';
import { describe, it } from 'vitest';
import { PREDICATE_DERIVATION_OF, PREDICATE_DERIVED_FROM, PROVENANCE_NAMESPACE } from '../lib/consts.js';
import { mappingFromConstructQueries, parseConstructQuery } from '../lib/mapping.js';
import {
  provenanceCapturingOperation,
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
import { createDefaultTransformationPipeline } from '../lib/queryRewriter.js';
import { internalBnodeExtensionFunctions } from '../lib/transformations/bnodeExtensionFunction.js';
import {
  internalBnodeAsSpecialIriTransformation,
  internalBnodeAsSpecialLiteralTransformation,
} from '../lib/transformations/bnodeMapAsLiteral.js';
import type { UnfoldingOptions } from '../lib/transformations/unfolding.js';
import { createTransformationContext, parseQuery } from '../lib/transformContext.js';
import type { Mapping, QueryTransformation } from '../lib/types.js';
import { DF } from '../lib/utils/rdfDatatypes.js';
import { createValidatingQueryRewriter, generateValidQuery } from './validQuery.js';

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
 * @param materialisation - The step materialising internal blank nodes
 * @returns the solutions
 */
async function bindingsOf(
  mapping: Mapping,
  query: string,
  options: UnfoldingOptions = {},
  materialisation: QueryTransformation = internalBnodeAsSpecialIriTransformation({ encodedByExtensionFunction: true }),
): Promise<RDF.Bindings[]> {
  const rewriter = createValidatingQueryRewriter([
    ...createDefaultTransformationPipeline(mapping, options),
    materialisation,
  ]);
  const bindings = await engine.queryBindings(await rewriter.rewriteQuery(query), {
    sources: [ colleagues ],
    extensionFunctions: internalBnodeExtensionFunctions(),
  });
  return bindings.toArray();
}

/**
 * Writes each term of a solution as a string.
 * @param solution - The solution, by variable or by variable name
 * @returns the record
 */
function recordOf(solution: Iterable<readonly [RDF.Variable | string, RDF.Term]>): Row {
  return Object.fromEntries([ ...solution ].map(([ variable, term ]) =>
    [ typeof variable === 'string' ? variable : variable.value, termToString(term) ]));
}

/**
 * Writes a solution as its sorted `name=term` pairs.
 * @param solution - The solution, by variable name
 * @returns the key
 */
function answerKey(solution: ReadonlyMap<string, RDF.Term>): string {
  return Object.entries(recordOf(solution)).map(([ name, term ]) => `${name}=${term}`).sort().join(' ');
}

/**
 * As {@link bindingsOf}, each term written as a string.
 * @param mapping - The mapping to unfold
 * @param query - The query over the view
 * @param options - What to configure the unfolding with
 * @returns one record per solution
 */
async function evaluate(mapping: Mapping, query: string, options: UnfoldingOptions = {}): Promise<Row[]> {
  return (await bindingsOf(mapping, query, options)).map(recordOf);
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
    const construct = parseConstructQuery(c, prefixes + constructQuery);
    const provenanceConstruct = provenanceConstructOf(c, construct, DF.namedNode(`${PROVENANCE_NAMESPACE}construct0`));
    expect(generateValidQuery(c, provenanceConstruct).trim()).toEqual(expected.trim());
  }

  it('links a derivation to the triple it produces and the triple it matched', ({ expect }) => {
    expectProvenanceConstruct(
      expect,
      'CONSTRUCT { ?s ?p ?o } WHERE { ?s ?p ?o }',
      `CONSTRUCT {
  ?derivation ${derivationOf} <<( ?s ?p ?o )>> .
  ?derivation ${derivedFrom} <<( ?s ?p ?o )>> .
}
WHERE {
  ?s ?p ?o .
  BIND( <internal://blank> ( ${construct0} , ?s , ?p , ?o ) AS ?derivation )
}`,
    );
  });

  it('identifies a derivation by its CONSTRUCT and every variable of the body', ({ expect }) => {
    expectProvenanceConstruct(
      expect,
      'CONSTRUCT { ?x :colleague ?y } WHERE { ?x :worksAt ?org . ?y :worksAt ?org . FILTER(?x != ?y) }',
      `CONSTRUCT {
  ?derivation ${derivationOf} <<( ?x <ex://colleague> ?y )>> .
  ?derivation ${derivedFrom} <<( ?x <ex://worksAt> ?org )>> .
  ?derivation ${derivedFrom} <<( ?y <ex://worksAt> ?org )>> .
}
WHERE {
  {
    ?x <ex://worksAt> ?org .
    ?y <ex://worksAt> ?org .
    FILTER ( ( ?x != ?y ) )
  }
  BIND( <internal://blank> ( ${construct0} , ?x , ?org , ?y ) AS ?derivation )
}`,
    );
  });

  it('links one derivation to every triple of its template', ({ expect }) => {
    expectProvenanceConstruct(
      expect,
      'CONSTRUCT { ?x :name ?f . ?x a :Person } WHERE { ?x :firstName ?f }',
      `CONSTRUCT {
  ?derivation ${derivationOf} <<( ?x <ex://name> ?f )>> .
  ?derivation ${derivationOf} <<( ?x <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <ex://Person> )>> .
  ?derivation ${derivedFrom} <<( ?x <ex://firstName> ?f )>> .
}
WHERE {
  ?x <ex://firstName> ?f .
  BIND( <internal://blank> ( ${construct0} , ?x , ?f ) AS ?derivation )
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
  ?derivation ${derivationOf} <<( ?x <ex://name> ?n )>> .
  ?derivation ${derivedFrom} <<( ?x <ex://firstName> ?f )>> .
}
WHERE {
  ?x <ex://firstName> ?f .
  BIND( CONCAT( ?f , "!" ) AS ?n )
  BIND( <internal://blank> ( ${construct0} , ?x , ?f , ?n ) AS ?derivation )
}`,
    );
  });

  it('identifies a derivation by an OPTIONAL variable, but links it only to the patterns outside', ({ expect }) => {
    expectProvenanceConstruct(
      expect,
      'CONSTRUCT { ?x :employed true } WHERE { ?x :worksAt :ugent OPTIONAL { ?x :knows ?y } }',
      `CONSTRUCT {
  ?derivation ${derivationOf} <<( ?x <ex://employed> TRUE )>> .
  ?derivation ${derivedFrom} <<( ?x <ex://worksAt> <ex://ugent> )>> .
}
WHERE {
  ?x <ex://worksAt> <ex://ugent> .
  OPTIONAL {
    ?x <ex://knows> ?y .
  }
  BIND( <internal://blank> ( ${construct0} , ?x , ?y ) AS ?derivation )
}`,
    );
  });

  it('links a derivation to no pattern of a MINUS', ({ expect }) => {
    expectProvenanceConstruct(
      expect,
      'CONSTRUCT { ?x :unemployed true } WHERE { ?x :knows ?y MINUS { ?x :worksAt ?o } }',
      `CONSTRUCT {
  ?derivation ${derivationOf} <<( ?x <ex://unemployed> TRUE )>> .
  ?derivation ${derivedFrom} <<( ?x <ex://knows> ?y )>> .
}
WHERE {
  ?x <ex://knows> ?y .
  MINUS {
    ?x <ex://worksAt> ?o .
  }
  BIND( <internal://blank> ( ${construct0} , ?x , ?y ) AS ?derivation )
}`,
    );
  });

  it('links a derivation to no pattern of a UNION, as a solution matches only one branch', ({ expect }) => {
    expectProvenanceConstruct(
      expect,
      'CONSTRUCT { ?x :reaches ?y } WHERE { { ?x :knows ?y } UNION { ?x :colleague ?y } }',
      `CONSTRUCT {
  ?derivation ${derivationOf} <<( ?x <ex://reaches> ?y )>> .
}
WHERE {
  {
    ?x <ex://knows> ?y .
  }
  UNION {
    ?x <ex://colleague> ?y .
  }
  BIND( <internal://blank> ( ${construct0} , ?x , ?y ) AS ?derivation )
}`,
    );
  });

  it('links a derivation to no pattern of a sub-SELECT', ({ expect }) => {
    expectProvenanceConstruct(
      expect,
      'CONSTRUCT { ?x :friends ?n } WHERE { { SELECT ?x (COUNT(*) AS ?n) WHERE { ?x :knows ?y } GROUP BY ?x } }',
      `CONSTRUCT {
  ?derivation ${derivationOf} <<( ?x <ex://friends> ?n )>> .
}
WHERE {
  {
    SELECT ?x ( COUNT( * ) AS ?n ) WHERE {
      ?x <ex://knows> ?y .
    }
    GROUP BY ?x
  }
  BIND( <internal://blank> ( ${construct0} , ?x , ?n ) AS ?derivation )
}`,
    );
  });

  it('coins a derivation variable the CONSTRUCT does not use yet', ({ expect }) => {
    expectProvenanceConstruct(
      expect,
      'CONSTRUCT { ?derivation :p ?o } WHERE { ?derivation :q ?o }',
      `CONSTRUCT {
  ?derivation0 ${derivationOf} <<( ?derivation <ex://p> ?o )>> .
  ?derivation0 ${derivedFrom} <<( ?derivation <ex://q> ?o )>> .
}
WHERE {
  ?derivation <ex://q> ?o .
  BIND( <internal://blank> ( ${construct0} , ?derivation , ?o ) AS ?derivation0 )
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
      .toBe('prov0');
  });

  it('rewrites a query in algebra form as it rewrites one written out', ({ expect }) => {
    const query = `${prefixes} SELECT ?x WHERE { ?x :worksAt :ugent }`;
    const c = createTransformationContext();
    const { query: operation, provenanceVariablePrefix } = provenanceCapturingOperation(parseQuery(c, query));

    expect(provenanceVariablePrefix).toBe('prov');
    expect(generateValidQuery(c, operation)).toBe(provenanceCapturingQuery(query).query);
  });

  it('keeps the dataset a FROM selects', ({ expect }) => {
    expect(provenanceCapturingQuery(`${prefixes} SELECT ?x FROM <ex://graph> WHERE { ?x :knows ?y }`).query)
      .toContain('FROM <ex://graph>');
  });

  it('rejects a query that is not a SELECT', ({ expect }) => {
    expect(() => provenanceCapturingQuery(`${prefixes} ASK { ?x :worksAt :ugent }`))
      .toThrow('Provenance can only be captured for a SELECT query.');
  });

  it('rewrites the pattern an EXISTS filters once', ({ expect }) => {
    const { query } = provenanceCapturingQuery(`${prefixes} SELECT ?x WHERE { ?x :worksAt :ugent ` +
      'FILTER(EXISTS { ?x :worksAt :imec } && EXISTS { :alice :knows ?x }) }');

    expect(query.split('<<( ?x <ex://worksAt> <ex://ugent> )>>')).toHaveLength(2);
  });

  it('rejects an unstable function, which the rewrite would evaluate more than once', ({ expect }) => {
    expect(() => provenanceCapturingQuery(`${prefixes} SELECT ?x ?r WHERE { ?x :worksAt :ugent BIND(RAND() AS ?r) }`))
      .toThrow('The RAND function cannot be used in a query whose provenance is captured');
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
   * @param materialisation - The step materialising internal blank nodes
   * @returns the decoded solutions
   */
  async function decodedAnswersOf(query: string, materialisation?: QueryTransformation):
  Promise<ProvenanceAnnotatedAnswer[]> {
    const capture = provenanceCapturingQuery(prefixes + query);
    return decodeProvenance(
      await bindingsOf(provenanceMapping, capture.query, {}, materialisation),
      capture.provenanceVariablePrefix,
    );
  }

  /**
   * Counts how many times each decoded answer is an answer, every derivation counting once.
   * @param query - The query over the view, without prefixes
   * @returns the count of each answer, by its values
   */
  async function countsOf(query: string): Promise<Record<string, number>> {
    return Object.fromEntries((await decodedAnswersOf(query)).map(({ answer, polynomial }) =>
      [ answerKey(answer), evaluatePolynomial(polynomial, countingSpmSemiring, () => 1) ]));
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
      const values = answerKey(answer).replaceAll('ex://', '');
      const explanation = polynomialToString(polynomial, term => labels.get(termToString(term))!);
      return `${isAnswer ? '+' : '-'} ${values}: ${explanation}`;
    }).sort();
  }

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
    'SELECT ?x ?o WHERE { ?x :worksAt :ugent OPTIONAL { ?x :knows ?o } ' +
    'OPTIONAL { ?x :worksAt ?o FILTER(!BOUND(?o)) } }',
    'SELECT ?x WHERE { ?x :worksAt :ugent FILTER NOT EXISTS { ?x :worksAt :imec } }',
    'SELECT ?x WHERE { ?x :worksAt :ugent FILTER EXISTS { ?x :worksAt :imec } }',
    'SELECT ?x ?o WHERE { ?x :worksAt ?o FILTER NOT EXISTS { ?y :worksAt ?o FILTER(?y != ?x && ?y != :carol) } }',
    'SELECT ?x ?o WHERE { ?x :worksAt ?o FILTER EXISTS { ?y :worksAt ?o FILTER(?y != ?x && ?y != :carol) } }',
    'SELECT ?x WHERE { ?x :worksAt ?o FILTER NOT EXISTS { { SELECT ?y WHERE { ?y :worksAt ?o } } FILTER(?y != ?x) } }',
    'SELECT ?x ?e WHERE { ?x :worksAt :imec BIND(EXISTS { :alice :knows ?x } AS ?e) }',
    'SELECT ?x ?y WHERE { { ?x :worksAt :ugent } UNION { ?x :worksAt ?y } ' +
    'FILTER EXISTS { ?x :worksAt ?y FILTER(?y = :imec) } }',
    'SELECT ?x ?o WHERE { ?x :worksAt :ugent OPTIONAL { ?x :knows ?o } ' +
    'OPTIONAL { ?x :worksAt ?o FILTER EXISTS { ?o ?p ?q } } }',
    'SELECT ?x WHERE { ?x :worksAt :ugent FILTER EXISTS { VALUES ?y { :bob } OPTIONAL { ?x :knows ?y } } }',
    'SELECT ?x WHERE { ?x :worksAt :ugent FILTER EXISTS { { ?y :worksAt :imec FILTER(?y = ?x) } ?x :worksAt :ugent } }',
    'SELECT ?x ?o WHERE { ?x :worksAt :ugent OPTIONAL { ?x :knows ?o } OPTIONAL { ?x :worksAt ?o ' +
    'FILTER EXISTS { ?x :worksAt ?w OPTIONAL { ?x :worksAt ?v FILTER(?v = ?o) } FILTER(BOUND(?v)) } } }',
    'SELECT ?o WHERE { ?o :worksAt :imec FILTER EXISTS { ?a :knows ?b OPTIONAL { ?a :knows ?o } ?o :worksAt :imec } }',
    'SELECT ?o WHERE { ?o :worksAt :imec FILTER NOT EXISTS { ?a :knows ?b OPTIONAL { ?a :knows ?o } ' +
    '?o :worksAt :imec } }',
    'SELECT ?x WHERE { VALUES ?x { :alice :bob } FILTER EXISTS { ?y :worksAt ?o BIND(?y AS ?x) } }',
    'SELECT ?x WHERE { VALUES ?x { :alice :bob } FILTER NOT EXISTS { ?y :worksAt ?o BIND(?y AS ?x) } }',
  ])('answers %s as the query without provenance does', async(query, { expect }) => {
    const [ decodedAnswers, rows ] = await Promise.all([
      decodedAnswersOf(query),
      // The answers keep the view's set semantics, whatever the unfolding preserves.
      evaluate(mapping, prefixes + query, { preserveCardinality: true }),
    ]);
    const answers = decodedAnswers
      .filter(({ isAnswer }) => isAnswer)
      .map(({ answer }) => recordOf(answer));
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

  it('conditions an OPTIONAL\'s difference on a filter over both sides', async(
    { expect },
  ) => {
    expect(await explain('SELECT ?x ?y WHERE { ?x :worksAt :imec OPTIONAL { ?y :worksAt :ugent FILTER(?x != ?y) } }'))
      .toEqual([
        '+ x=bob y=carol: (bob worksAt imec ⊗ carol worksAt ugent)',
        '+ x=bob y=dave: (bob worksAt imec ⊗ dave worksAt ugent)',
        '+ x=carol y=bob: (bob worksAt ugent ⊗ carol worksAt imec)',
        '+ x=carol y=dave: (carol worksAt imec ⊗ dave worksAt ugent)',
        '- x=bob: (bob worksAt imec ⊖ (carol worksAt ugent ⊕ dave worksAt ugent))',
        '- x=carol: (carol worksAt imec ⊖ (bob worksAt ugent ⊕ dave worksAt ugent))',
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

  it('subtracts from every row of a difference over a variable the minuend may not bind', async(
    { expect },
  ) => {
    const explanations = await explain(
      'SELECT ?x ?q WHERE { ?x :worksAt :ugent OPTIONAL { ?q :knows ?x } MINUS { ?x :worksAt :imec ' +
      'OPTIONAL { ?q :knows ?x } } }',
    );
    expect(explanations.filter(explanation => explanation.includes('x=bob') && !explanation.includes('q=')))
      .toEqual([ '- x=bob: ((bob worksAt ugent ⊖ alice knows bob) ⊖ ((alice knows bob ⊗ bob worksAt imec) ⊕ ' +
        '(bob worksAt imec ⊖ alice knows bob)))' ]);
  });

  it('evaluates an EXISTS nested in an expression over the view, contributing no provenance', async({ expect }) => {
    expect(await explain('SELECT ?x ?e WHERE { ?x :worksAt :imec BIND(EXISTS { :alice :knows ?x } AS ?e) }'))
      .toEqual([
        '+ e="false"^^http://www.w3.org/2001/XMLSchema#boolean x=carol: carol worksAt imec',
        '+ e="true"^^http://www.w3.org/2001/XMLSchema#boolean x=bob: bob worksAt imec',
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
    expect(await countsOf('SELECT ?c WHERE { :alice :knows ?f . ?f :colleague ?c }'))
      .toEqual({ 'c=ex://carol': 2, 'c=ex://dave': 1 });
  });

  it('counts every group of an aggregate giving the same answer', async({ expect }) => {
    expect(await countsOf('SELECT (COUNT(*) AS ?n) WHERE { ?x :colleague ?y } GROUP BY ?x'))
      .toEqual({ 'n="2"^^http://www.w3.org/2001/XMLSchema#integer': 3 });
  });

  it('counts every solution produced from no view triple', async({ expect }) => {
    expect(await countsOf('SELECT ?x WHERE { VALUES (?x ?y) { (:a 1) (:a 2) } }')).toEqual({ 'x=ex://a': 2 });
    expect(await countsOf('SELECT ?x WHERE { VALUES ?x { :a :a } }')).toEqual({ 'x=ex://a': 2 });
  });

  it('keeps the provenance of an EXISTS over a sub-SELECT, a negated path or a nested EXISTS', async({ expect }) => {
    for (const existence of [
      '{ SELECT ?x WHERE { ?x :worksAt :imec } }',
      '{ ?x !:knows :imec }',
      '{ ?x :worksAt ?o FILTER NOT EXISTS { ?y :worksAt ?o FILTER(?y != ?x && ?y != :carol) } }',
    ]) {
      const explanations = await explain(`SELECT ?x WHERE { ?x :worksAt :ugent FILTER EXISTS ${existence} }`);
      expect(explanations.every(explanation => explanation.includes('⊖')), existence).toBe(true);
    }
  });

  it('decodes derivations materialised as typed literals', async({ expect }) => {
    const query = 'SELECT ?x WHERE { ?x :worksAt :ugent FILTER NOT EXISTS { ?x :worksAt :imec } }';
    const explanationsOf = (answers: ProvenanceAnnotatedAnswer[]): string[] => answers
      .map(({ polynomial, isAnswer }) => `${isAnswer} ${polynomialToString(polynomial, () => 'd')}`).sort();

    expect(explanationsOf(await decodedAnswersOf(
      query,
      internalBnodeAsSpecialLiteralTransformation({ encodedByExtensionFunction: true }),
    ))).toEqual(explanationsOf(await decodedAnswersOf(query)));
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
  it('explains each count of a grouped query by the source triples it rests on', async({ expect }) => {
    // The source (test/statics/colleagues.ttl): Bob and Carol work at UGent and imec, Dave at UGent only.
    // The view: two people working at the same organisation are colleagues.
    const view = [
      `${prefixes} CONSTRUCT { ?x :colleague ?y } WHERE { ?x :worksAt ?org . ?y :worksAt ?org . FILTER(?x != ?y) }`,
    ];
    const query = `${prefixes} SELECT ?x (COUNT(*) AS ?colleagues) WHERE { ?x :colleague ?y } GROUP BY ?x`;
    const local = (term: RDF.Term | undefined): string => term!.value.replace('ex://', '');

    // 1. The query answers how many colleagues each person has, over the view as a set.
    const results = await bindingsOf(mappingFromConstructQueries(view), query, { preserveCardinality: true });
    expect(results.map(row => `${local(row.get('x'))}: ${local(row.get('colleagues'))}`).sort())
      .toEqual([ 'bob: 2', 'carol: 2', 'dave: 2' ]);

    // 2. Captured, the same query also answers which derivations each count rests on. A derivation is one solution
    //    of the view's body: a colleague and the organisation shared, which its `derivedFrom` source triples give.
    const provenanceMapping = provenanceMappingFromConstructQueries(view);
    const capture = provenanceCapturingQuery(query);
    const answers = decodeProvenance(
      await bindingsOf(provenanceMapping, capture.query),
      capture.provenanceVariablePrefix,
    );
    const derivations = await bindingsOf(provenanceMapping, `${prefixes} SELECT ?derivation ?y ?org WHERE {
      ?derivation provenance:derivationOf <<( ?x :colleague ?y )>> ; provenance:derivedFrom <<( ?x :worksAt ?org )>> .
    }`);
    const labels = new Map(derivations.map(row =>
      [ termToString(row.get('derivation')), `${local(row.get('y'))}@${local(row.get('org'))}` ]));
    const labelOf = (derivation: RDF.Term): string => labels.get(termToString(derivation))!;

    // 3. Each count is the aggregate δ of the derivations of the colleague triples it counts. Bob counts two
    //    colleagues, Carol and Dave, but Carol through two organisations: three derivations.
    expect(answers.map(({ answer, polynomial }) =>
      `${local(answer.get('x'))}: ${local(answer.get('colleagues'))} = ${polynomialToString(polynomial, labelOf)}`)
      .sort()).toEqual([
      'bob: 2 = δ(carol@imec ⊕ carol@ugent ⊕ dave@ugent)',
      'carol: 2 = δ(bob@imec ⊕ bob@ugent ⊕ dave@ugent)',
      'dave: 2 = δ(bob@ugent ⊕ carol@ugent)',
    ]);
    const bob = answers.find(({ answer }) => local(answer.get('x')) === 'bob')!;
    expect(lineageOf(bob.polynomial).map(labelOf).sort()).toEqual([ 'carol@imec', 'carol@ugent', 'dave@ugent' ]);
  });
});
