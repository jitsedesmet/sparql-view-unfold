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

  it('subtracts from every row of a difference over a variable the left side may not bind', async(
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
  /**
   * Sorts items by their JSON, so that rows compare whatever order the engine returns them in.
   * @param items - The items to sort
   * @returns the sorted items
   */
  function sorted<T>(items: T[]): T[] {
    return [ ...items ].sort((left, right) => JSON.stringify(left) < JSON.stringify(right) ? -1 : 1);
  }

  it('explains each count of a grouped query by the derivations it rests on', async({ expect }) => {
    // The source data is test/statics/colleagues.ttl: Bob and Carol work at UGent and imec, Dave at UGent only.
    // The view: two people working at the same organisation are colleagues.
    const view = [
      `${prefixes} CONSTRUCT { ?x :colleague ?y } WHERE { ?x :worksAt ?org . ?y :worksAt ?org . FILTER(?x != ?y) }`,
    ];
    const query = `${prefixes} SELECT ?x (COUNT(*) AS ?colleagues) WHERE { ?x :colleague ?y } GROUP BY ?x`;

    // 1. The query over the view, without provenance and with the view as a set.
    expect(sorted(await evaluate(mappingFromConstructQueries(view), query, { preserveCardinality: true })))
      .toEqual([
        { x: 'ex://bob', colleagues: '"2"^^http://www.w3.org/2001/XMLSchema#integer' },
        { x: 'ex://carol', colleagues: '"2"^^http://www.w3.org/2001/XMLSchema#integer' },
        { x: 'ex://dave', colleagues: '"2"^^http://www.w3.org/2001/XMLSchema#integer' },
      ]);

    // 2. The query rewritten to also select its provenance.
    const capture = provenanceCapturingQuery(query);
    expect(capture.provenanceVariablePrefix).toBe('prov');
    expect(capture.query).toBe(`
SELECT ?x ?colleagues ?prov_aggregate ?prov_aggregate_sum_sum_statement ?prov_aggregate_sum_sum ?prov_aggregate_sum WHERE {
  {
    {
      SELECT ?x ( COUNT( * ) AS ?colleagues ) WHERE {
        SELECT DISTINCT ?x ?y WHERE {
          ?internal0 <https://sparql-extension.knows.idlab.ugent.be/provenance#derivationOf> <<( ?x <ex://colleague> ?y )>> .
        }
      }
      GROUP BY ?x
    }
    BIND( <internal://blank> ( "prov_aggregate" , ?x ) AS ?prov_aggregate )
  }
  OPTIONAL {
    {
      SELECT ?x ?prov_aggregate_sum_sum_statement ?prov_aggregate_sum_sum ?prov_aggregate_sum WHERE {
        SELECT ?x ?prov_aggregate_sum_sum_statement ( <internal://blank> ( "prov_aggregate_sum_sum" , ?x , ?y ) AS ?prov_aggregate_sum_sum ) ( <internal://blank> ( "prov_aggregate_sum" , ?x ) AS ?prov_aggregate_sum ) WHERE {
          ?prov_aggregate_sum_sum_statement <https://sparql-extension.knows.idlab.ugent.be/provenance#derivationOf> <<( ?x <ex://colleague> ?y )>> .
        }
      }
    }
  }
}
`);

    // 3. Its rows, unfolded against the provenance view and evaluated over the source data.
    const provenanceMapping = provenanceMappingFromConstructQueries(view);
    const rows = await bindingsOf(provenanceMapping, capture.query);
    expect(sorted(rows.map(recordOf))).toEqual([
      {
        prov_aggregate_sum_sum_statement: 'https://myInternalBnode.example.org/0be09eb44785d2772757080e1c62ec5a61b50d36',
        x: 'ex://bob',
        prov_aggregate_sum_sum: 'https://myInternalBnode.example.org/40bb14f804a4ea15274dfd6862956fd31d706b5a',
        prov_aggregate_sum: 'https://myInternalBnode.example.org/b150433de9fa4d189db4787f307c905c713e6cd8',
        colleagues: '"2"^^http://www.w3.org/2001/XMLSchema#integer',
        prov_aggregate: 'https://myInternalBnode.example.org/6065d5f68d9e8d5d8ece13fa00c5578d5e2b82e5',
      },
      {
        prov_aggregate_sum_sum_statement: 'https://myInternalBnode.example.org/74810b8df84eebffced1b47c9533df0735bdcfbb',
        x: 'ex://bob',
        prov_aggregate_sum_sum: 'https://myInternalBnode.example.org/c4c7592be1ec9fc7d0d675e4271ba0ed7c012362',
        prov_aggregate_sum: 'https://myInternalBnode.example.org/b150433de9fa4d189db4787f307c905c713e6cd8',
        colleagues: '"2"^^http://www.w3.org/2001/XMLSchema#integer',
        prov_aggregate: 'https://myInternalBnode.example.org/6065d5f68d9e8d5d8ece13fa00c5578d5e2b82e5',
      },
      {
        prov_aggregate_sum_sum_statement: 'https://myInternalBnode.example.org/862273efa1ef04f50b48eb5e68bc10674688a16b',
        x: 'ex://carol',
        prov_aggregate_sum_sum: 'https://myInternalBnode.example.org/6eb533aab0ed61b08b67e9fa777b11931cf29e8c',
        prov_aggregate_sum: 'https://myInternalBnode.example.org/e326d5ba0a0a670e49dc040e517bf278e189e8c5',
        colleagues: '"2"^^http://www.w3.org/2001/XMLSchema#integer',
        prov_aggregate: 'https://myInternalBnode.example.org/a8388dfa950199fb198e495f5cf0ae5578b78673',
      },
      {
        prov_aggregate_sum_sum_statement: 'https://myInternalBnode.example.org/883eb62e03826d0dda04e9ff19d5d01adcaca2db',
        x: 'ex://carol',
        prov_aggregate_sum_sum: 'https://myInternalBnode.example.org/67006328fa6d665ccb01d71d2f7f18730d196b81',
        prov_aggregate_sum: 'https://myInternalBnode.example.org/e326d5ba0a0a670e49dc040e517bf278e189e8c5',
        colleagues: '"2"^^http://www.w3.org/2001/XMLSchema#integer',
        prov_aggregate: 'https://myInternalBnode.example.org/a8388dfa950199fb198e495f5cf0ae5578b78673',
      },
      {
        prov_aggregate_sum_sum_statement: 'https://myInternalBnode.example.org/90f4456735d97543be8c2834c138b47e15ae3c2c',
        x: 'ex://bob',
        prov_aggregate_sum_sum: 'https://myInternalBnode.example.org/40bb14f804a4ea15274dfd6862956fd31d706b5a',
        prov_aggregate_sum: 'https://myInternalBnode.example.org/b150433de9fa4d189db4787f307c905c713e6cd8',
        colleagues: '"2"^^http://www.w3.org/2001/XMLSchema#integer',
        prov_aggregate: 'https://myInternalBnode.example.org/6065d5f68d9e8d5d8ece13fa00c5578d5e2b82e5',
      },
      {
        prov_aggregate_sum_sum_statement: 'https://myInternalBnode.example.org/a4db0e8460cc73b7dea8988e5df898c53b19f26f',
        x: 'ex://carol',
        prov_aggregate_sum_sum: 'https://myInternalBnode.example.org/6eb533aab0ed61b08b67e9fa777b11931cf29e8c',
        prov_aggregate_sum: 'https://myInternalBnode.example.org/e326d5ba0a0a670e49dc040e517bf278e189e8c5',
        colleagues: '"2"^^http://www.w3.org/2001/XMLSchema#integer',
        prov_aggregate: 'https://myInternalBnode.example.org/a8388dfa950199fb198e495f5cf0ae5578b78673',
      },
      {
        prov_aggregate_sum_sum_statement: 'https://myInternalBnode.example.org/a76c8265d153fb37ac044f59a9109fe05e352cde',
        x: 'ex://dave',
        prov_aggregate_sum_sum: 'https://myInternalBnode.example.org/5fa2488b4ccd3ca0e6828c3beaf3132493462e98',
        prov_aggregate_sum: 'https://myInternalBnode.example.org/9d8f4772aac735af3e0229ae185dc863d94ea1cc',
        colleagues: '"2"^^http://www.w3.org/2001/XMLSchema#integer',
        prov_aggregate: 'https://myInternalBnode.example.org/5397346b50f730fb43d08aff74f9a0f7a30050af',
      },
      {
        prov_aggregate_sum_sum_statement: 'https://myInternalBnode.example.org/c5d75903ebfee0de48bfc464dccefbce7db013b8',
        x: 'ex://dave',
        prov_aggregate_sum_sum: 'https://myInternalBnode.example.org/17465212666d3d9546d20cf2f9afef6449b4221d',
        prov_aggregate_sum: 'https://myInternalBnode.example.org/9d8f4772aac735af3e0229ae185dc863d94ea1cc',
        colleagues: '"2"^^http://www.w3.org/2001/XMLSchema#integer',
        prov_aggregate: 'https://myInternalBnode.example.org/5397346b50f730fb43d08aff74f9a0f7a30050af',
      },
    ]);

    // 4. The rows decoded into a polynomial per answer: δ, the aggregate, over the derivations of the triples counted.
    expect(sorted(decodeProvenance(rows, capture.provenanceVariablePrefix).map(({ answer, isAnswer, polynomial }) =>
      ({ answer: recordOf(answer), isAnswer, polynomial: polynomialToString(polynomial) })))).toEqual([
      {
        answer: { x: 'ex://bob', colleagues: '"2"^^http://www.w3.org/2001/XMLSchema#integer' },
        isAnswer: true,
        polynomial: 'δ(https://myInternalBnode.example.org/0be09eb44785d2772757080e1c62ec5a61b50d36 ⊕ https://myInternalB' +
          'node.example.org/74810b8df84eebffced1b47c9533df0735bdcfbb ⊕ https://myInternalBnode.example.org/90f4' +
          '456735d97543be8c2834c138b47e15ae3c2c)',
      },
      {
        answer: { x: 'ex://carol', colleagues: '"2"^^http://www.w3.org/2001/XMLSchema#integer' },
        isAnswer: true,
        polynomial: 'δ(https://myInternalBnode.example.org/862273efa1ef04f50b48eb5e68bc10674688a16b ⊕ https://myInternalB' +
          'node.example.org/883eb62e03826d0dda04e9ff19d5d01adcaca2db ⊕ https://myInternalBnode.example.org/a4db' +
          '0e8460cc73b7dea8988e5df898c53b19f26f)',
      },
      {
        answer: { x: 'ex://dave', colleagues: '"2"^^http://www.w3.org/2001/XMLSchema#integer' },
        isAnswer: true,
        polynomial: 'δ(https://myInternalBnode.example.org/a76c8265d153fb37ac044f59a9109fe05e352cde ⊕ https://myInternalB' +
          'node.example.org/c5d75903ebfee0de48bfc464dccefbce7db013b8)',
      },
    ]);

    // 5. In the provenance view, the view triple each derivation produces and the source triples it matched.
    expect(sorted(await evaluate(provenanceMapping, `${prefixes} SELECT ?derivation ?viewTriple ?source WHERE {
      ?derivation provenance:derivationOf ?viewTriple ; provenance:derivedFrom ?source .
    }`))).toEqual([
      {
        derivation: 'https://myInternalBnode.example.org/0be09eb44785d2772757080e1c62ec5a61b50d36',
        source: '<<ex://bob ex://worksAt ex://ugent>>',
        viewTriple: '<<ex://bob ex://colleague ex://carol>>',
      },
      {
        derivation: 'https://myInternalBnode.example.org/0be09eb44785d2772757080e1c62ec5a61b50d36',
        source: '<<ex://carol ex://worksAt ex://ugent>>',
        viewTriple: '<<ex://bob ex://colleague ex://carol>>',
      },
      {
        derivation: 'https://myInternalBnode.example.org/74810b8df84eebffced1b47c9533df0735bdcfbb',
        source: '<<ex://bob ex://worksAt ex://ugent>>',
        viewTriple: '<<ex://bob ex://colleague ex://dave>>',
      },
      {
        derivation: 'https://myInternalBnode.example.org/74810b8df84eebffced1b47c9533df0735bdcfbb',
        source: '<<ex://dave ex://worksAt ex://ugent>>',
        viewTriple: '<<ex://bob ex://colleague ex://dave>>',
      },
      {
        derivation: 'https://myInternalBnode.example.org/862273efa1ef04f50b48eb5e68bc10674688a16b',
        source: '<<ex://bob ex://worksAt ex://imec>>',
        viewTriple: '<<ex://carol ex://colleague ex://bob>>',
      },
      {
        derivation: 'https://myInternalBnode.example.org/862273efa1ef04f50b48eb5e68bc10674688a16b',
        source: '<<ex://carol ex://worksAt ex://imec>>',
        viewTriple: '<<ex://carol ex://colleague ex://bob>>',
      },
      {
        derivation: 'https://myInternalBnode.example.org/883eb62e03826d0dda04e9ff19d5d01adcaca2db',
        source: '<<ex://carol ex://worksAt ex://ugent>>',
        viewTriple: '<<ex://carol ex://colleague ex://dave>>',
      },
      {
        derivation: 'https://myInternalBnode.example.org/883eb62e03826d0dda04e9ff19d5d01adcaca2db',
        source: '<<ex://dave ex://worksAt ex://ugent>>',
        viewTriple: '<<ex://carol ex://colleague ex://dave>>',
      },
      {
        derivation: 'https://myInternalBnode.example.org/90f4456735d97543be8c2834c138b47e15ae3c2c',
        source: '<<ex://bob ex://worksAt ex://imec>>',
        viewTriple: '<<ex://bob ex://colleague ex://carol>>',
      },
      {
        derivation: 'https://myInternalBnode.example.org/90f4456735d97543be8c2834c138b47e15ae3c2c',
        source: '<<ex://carol ex://worksAt ex://imec>>',
        viewTriple: '<<ex://bob ex://colleague ex://carol>>',
      },
      {
        derivation: 'https://myInternalBnode.example.org/a4db0e8460cc73b7dea8988e5df898c53b19f26f',
        source: '<<ex://bob ex://worksAt ex://ugent>>',
        viewTriple: '<<ex://carol ex://colleague ex://bob>>',
      },
      {
        derivation: 'https://myInternalBnode.example.org/a4db0e8460cc73b7dea8988e5df898c53b19f26f',
        source: '<<ex://carol ex://worksAt ex://ugent>>',
        viewTriple: '<<ex://carol ex://colleague ex://bob>>',
      },
      {
        derivation: 'https://myInternalBnode.example.org/a76c8265d153fb37ac044f59a9109fe05e352cde',
        source: '<<ex://bob ex://worksAt ex://ugent>>',
        viewTriple: '<<ex://dave ex://colleague ex://bob>>',
      },
      {
        derivation: 'https://myInternalBnode.example.org/a76c8265d153fb37ac044f59a9109fe05e352cde',
        source: '<<ex://dave ex://worksAt ex://ugent>>',
        viewTriple: '<<ex://dave ex://colleague ex://bob>>',
      },
      {
        derivation: 'https://myInternalBnode.example.org/c5d75903ebfee0de48bfc464dccefbce7db013b8',
        source: '<<ex://carol ex://worksAt ex://ugent>>',
        viewTriple: '<<ex://dave ex://colleague ex://carol>>',
      },
      {
        derivation: 'https://myInternalBnode.example.org/c5d75903ebfee0de48bfc464dccefbce7db013b8',
        source: '<<ex://dave ex://worksAt ex://ugent>>',
        viewTriple: '<<ex://dave ex://colleague ex://carol>>',
      },
    ]);
  });
});
