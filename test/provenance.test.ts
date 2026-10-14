import { readFileSync } from 'node:fs';
import { QueryEngine } from '@comunica/query-sparql-file';
import { Parser, Store } from 'n3';
import { termToString } from 'rdf-string';
import { describe, it } from 'vitest';
import { mappingFromConstructQueries } from '../lib/mapping.js';
import { provenanceCapturingQuery, provenanceMappingFromConstructQueries } from '../lib/provenance.js';
import { createDefaultTransformationPipeline, createQueryRewriter } from '../lib/queryRewriter.js';
import { internalBnodeAsSpecialIriTransformation } from '../lib/transformations/bnodeMapAsLiteral.js';
import type { Mapping } from '../lib/types.js';

const prefixes = 'PREFIX : <ex://> PREFIX provenance: <https://sparql-extension.knows.idlab.ugent.be/provenance#> ';
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

describe('provenanceCapturingQuery', () => {
  it('looks up one derivation per triple pattern and selects it', ({ expect }) => {
    expect(provenanceCapturingQuery(colleaguesOfAlicesFriends).trim()).toBe(`SELECT DISTINCT ?c ?derivation0 ?derivation1 WHERE {
  ?derivation0 <https://sparql-extension.knows.idlab.ugent.be/provenance#derivationOf> <<( <ex://alice> <ex://knows> ?f )>> .
  ?derivation1 <https://sparql-extension.knows.idlab.ugent.be/provenance#derivationOf> <<( ?f <ex://colleague> ?c )>> .
}`);
  });

  it('selects no derivation of a pattern under a MINUS', ({ expect }) => {
    expect(provenanceCapturingQuery(`${prefixes} SELECT ?x WHERE { ?x :worksAt :ugent MINUS { ?x :worksAt :imec } }`)
      .trim()).toMatch(/^SELECT \?x \?derivation0 WHERE/u);
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
