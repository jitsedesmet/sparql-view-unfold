import { QueryEngine } from '@comunica/query-sparql-file';
import type * as RDF from '@rdfjs/types';
import * as arrayifyStreamNS from 'arrayify-stream';
import { DataFactory, Store } from 'n3';
import { termToString } from 'rdf-string';
import type { expect as Expect } from 'vitest';
import { describe, it } from 'vitest';
import type { MappingOptions } from '../lib/mapping.js';
import { mappingFromConstructQueries } from '../lib/mapping.js';
import { createDefaultTransformationPipeline, createQueryRewriter } from '../lib/queryRewriter.js';
import {
  nonSingletonTripleConstruct,
  nonTripleTermConstruct,
  predicateReifierConstruct,
  singletonPropertyConstruct,
  tripleTermConstruct,
} from './queryConsts.js';
import './matchers/toBeRdfIsomorphic.js';

// Crazy workaround to support both CJS and ESM
const arrayifyStream =
  (<any> arrayifyStreamNS).default ?? arrayifyStreamNS;

/**
 * Integration tests that verify query rewriting correctness by comparing:
 * 1. Executing a SPARQL 1.2 query over data mapped to RDF 1.2 format
 * 2. Executing the rewritten query over the original RDF 1.1 data
 *
 * Both approaches must yield identical results for the rewriter to be correct.
 */
describe('integration tests', () => {
  const engine = new QueryEngine();
  const DF = DataFactory;

  /**
   * The rewriter of the default pipeline over the given mappings, which is what these tests are here to check.
   * @param mappers - The CONSTRUCT queries of the mappings
   * @param options - What the mapping is configured with
   * @returns the rewriter
   */
  function rewriterFor(mappers: string[], options: MappingOptions = {}): ReturnType<typeof createQueryRewriter> {
    return createQueryRewriter(createDefaultTransformationPipeline(mappingFromConstructQueries(mappers, options)));
  }

  async function sourceToStore(
    sources: NonNullable<Parameters<typeof engine.queryQuads>[1]>['sources'],
    query = 'CONSTRUCT WHERE { ?s ?p ?o }',
  ): Promise<Store> {
    const queryRes: RDF.Quad[] = await arrayifyStream(
      await engine.queryQuads(query, { sources }),
    );
    return new Store(queryRes);
  }

  /**
   * Whether RDF 1.2 admits a triple: an IRI or a blank node as subject, an IRI as predicate, and the same of a triple
   * term in the object.
   * @param triple - The triple to check
   * @returns whether RDF 1.2 admits it
   */
  function isRdfTriple(triple: RDF.BaseQuad): boolean {
    return (triple.subject.termType === 'NamedNode' || triple.subject.termType === 'BlankNode') &&
      triple.predicate.termType === 'NamedNode' &&
      (triple.object.termType !== 'Quad' || isRdfTriple(triple.object));
  }

  /**
   * Materialises the graph the mappings denote. Comunica's CONSTRUCT keeps triples RDF does not admit, which
   * SPARQL 1.1 §16.2 does not instantiate, so this drops them unless the view is generalized RDF.
   * @param source - The RDF 1.1 store
   * @param mappers - The CONSTRUCT queries of the mappings
   * @param options - What the mapping is configured with
   * @returns the materialised store
   */
  async function storeTo12Store(source: Store, mappers: string[], options: MappingOptions = {}): Promise<Store> {
    const result = new Store();
    for (const mapper of mappers) {
      const subRes = (await sourceToStore([ source ], mapper)).getQuads(null, null, null, null);
      result.addQuads(options.generalizedRdfView === true ? subRes : subRes.filter(isRdfTriple));
    }
    return result;
  }

  /**
   * For a given RDF 1.1 store, mappers, and user SPARQL 1.2 query:
   * - Maps the store to an RDF 1.2 store and runs the user query on it.
   * - Rewrites the user query for the original store and runs it there.
   * Returns both quad arrays for comparison.
   */
  async function compareRewrittenToMapped(
    store11: Store,
    mappers: string[],
    userQuery: string,
  ): Promise<{ resOnMappedData: RDF.Quad[]; resUsingRewriter: RDF.Quad[] }> {
    const store12 = await storeTo12Store(store11, mappers);
    const resOnMappedData = (await sourceToStore([ store12 ], userQuery)).getQuads(null, null, null, null);

    const rewrittenQuery = await rewriterFor(mappers).rewriteQuery(userQuery);
    const resUsingRewriter = (await sourceToStore([ store11 ], rewrittenQuery)).getQuads(null, null, null, null);

    return { resOnMappedData, resUsingRewriter };
  }

  /**
   * Writes a term out as `rdf-string` does, so that triple terms and literals of different datatypes tell apart. A
   * blank node is written by its label in the data file, without the prefixes N3 and Comunica give it.
   * @param term - The term to write
   * @returns the string
   */
  function termToComparableString(term: RDF.Term): string {
    if (term.termType === 'Quad') {
      const [ subject, predicate, object ] = [ term.subject, term.predicate, term.object ].map(termToComparableString);
      return `<<${subject} ${predicate} ${object}>>`;
    }
    return term.termType === 'BlankNode' ? `_:${term.value.replace(/^(?:bc_\d+_)*(?:b\d+_)?/u, '')}` : termToString(term);
  }

  /**
   * Writes a binding out for comparison, its variables sorted alphabetically.
   * @param binding - The binding to write
   * @returns the string
   */
  function bindingToString(binding: RDF.Bindings): string {
    const entries = [ ...binding ]
      .map(([ variable, term ]) => `${variable.value}=${termToComparableString(term)}`)
      .sort()
      .join(',');
    return `{${entries}}`;
  }

  /**
   * Runs a SELECT over the RDF 1.2 store the mappings materialise, and its rewriting over the RDF 1.1 store.
   * @param store11 - The RDF 1.1 store
   * @param mappers - The CONSTRUCT queries of the mappings
   * @param userQuery - The SELECT query
   * @param options - What the mapping is configured with
   * @returns the two answers, each as the sorted strings of its bindings
   */
  async function compareSelectRewrittenToMapped(
    store11: Store,
    mappers: string[],
    userQuery: string,
    options: MappingOptions = {},
  ): Promise<{ resOnMappedData: string[]; resUsingRewriter: string[] }> {
    const store12 = await storeTo12Store(store11, mappers, options);
    const mappedBindings: RDF.Bindings[] = await arrayifyStream(
      await engine.queryBindings(userQuery, { sources: [ store12 ]}),
    );

    const rewrittenQuery = await rewriterFor(mappers, options).rewriteQuery(userQuery);
    const rewrittenBindings: RDF.Bindings[] = await arrayifyStream(
      await engine.queryBindings(rewrittenQuery, { sources: [ store11 ]}),
    );

    return {
      resOnMappedData: mappedBindings.map(bindingToString).sort(),
      resUsingRewriter: rewrittenBindings.map(bindingToString).sort(),
    };
  }

  describe('rdf interop reification - single reified triple', () => {
    const mappers = [ tripleTermConstruct, nonTripleTermConstruct ];

    it('querying via CONSTRUCT WHERE { ?s ?p ?o } returns the same results', async({ expect }) => {
      const store11 = await sourceToStore([ './test/statics/singleRdfReifiedTriple.ttl' ]);
      const { resOnMappedData, resUsingRewriter } = await compareRewrittenToMapped(
        store11,
        mappers,
        'CONSTRUCT WHERE { ?s ?p ?o }',
      );
      expect(resOnMappedData).toBeRdfIsomorphic(resUsingRewriter);
    });

    it('querying for annotations on reified triples returns the same results', async({ expect }) => {
      const store11 = await sourceToStore([ './test/statics/singleRdfReifiedTriple.ttl' ]);
      const { resOnMappedData, resUsingRewriter } = await compareRewrittenToMapped(
        store11,
        mappers,
        `PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
         PREFIX : <ex://>
         CONSTRUCT { ?t :statedBy ?agent }
         WHERE { ?t rdf:reifies <<( ?s ?p ?o )>> . ?t :statedBy ?agent }`,
      );
      expect(resOnMappedData).toBeRdfIsomorphic(resUsingRewriter);
    });
  });

  describe('rdf interop reification - multiple reified triples', () => {
    const mappers = [ tripleTermConstruct, nonTripleTermConstruct ];

    it('querying via CONSTRUCT WHERE { ?s ?p ?o } returns the same results', async({ expect }) => {
      const store11 = await sourceToStore([ './test/statics/multipleRdfReifiedTriples.ttl' ]);
      const { resOnMappedData, resUsingRewriter } = await compareRewrittenToMapped(
        store11,
        mappers,
        'CONSTRUCT WHERE { ?s ?p ?o }',
      );
      expect(resOnMappedData).toBeRdfIsomorphic(resUsingRewriter);
    });

    it('querying for all reified triples returns the same results', async({ expect }) => {
      const store11 = await sourceToStore([ './test/statics/multipleRdfReifiedTriples.ttl' ]);
      const { resOnMappedData, resUsingRewriter } = await compareRewrittenToMapped(
        store11,
        mappers,
        `PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
         CONSTRUCT { ?t rdf:reifies <<( ?s ?p ?o )>> }
         WHERE { ?t rdf:reifies <<( ?s ?p ?o )>> }`,
      );
      expect(resOnMappedData).toBeRdfIsomorphic(resUsingRewriter);
    });

    it('querying for annotations on reified triples returns the same results', async({ expect }) => {
      const store11 = await sourceToStore([ './test/statics/multipleRdfReifiedTriples.ttl' ]);
      const { resOnMappedData, resUsingRewriter } = await compareRewrittenToMapped(
        store11,
        mappers,
        `PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
         PREFIX : <ex://>
         CONSTRUCT { ?t :statedBy ?agent }
         WHERE { ?t rdf:reifies <<( ?s ?p ?o )>> . ?t :statedBy ?agent }`,
      );
      expect(resOnMappedData).toBeRdfIsomorphic(resUsingRewriter);
    });

    it('querying for who stated Alice\'s relationships returns the same results', async({ expect }) => {
      const store11 = await sourceToStore([ './test/statics/multipleRdfReifiedTriples.ttl' ]);
      const { resOnMappedData, resUsingRewriter } = await compareRewrittenToMapped(
        store11,
        mappers,
        `PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
         PREFIX : <ex://>
         CONSTRUCT { ?agent :statedAbout :alice }
         WHERE { ?t rdf:reifies <<( :alice ?p ?o )>> . ?t :statedBy ?agent }`,
      );
      expect(resOnMappedData).toBeRdfIsomorphic(resUsingRewriter);
    });

    it('querying for reified triples with a specific subject returns the same results', async({ expect }) => {
      const store11 = await sourceToStore([ './test/statics/multipleRdfReifiedTriples.ttl' ]);
      const { resOnMappedData, resUsingRewriter } = await compareRewrittenToMapped(
        store11,
        mappers,
        `PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
         PREFIX : <ex://>
         CONSTRUCT { :alice :knows ?o }
         WHERE { ?t rdf:reifies <<( :alice :knows ?o )>> }`,
      );
      expect(resOnMappedData).toBeRdfIsomorphic(resUsingRewriter);
    });

    it('querying for reified triples by a specific source returns the same results', async({ expect }) => {
      const store11 = await sourceToStore([ './test/statics/multipleRdfReifiedTriples.ttl' ]);
      const { resOnMappedData, resUsingRewriter } = await compareRewrittenToMapped(
        store11,
        mappers,
        `PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
         PREFIX : <ex://>
         CONSTRUCT { ?s :knows ?o }
         WHERE { ?t rdf:reifies <<( ?s :knows ?o )>> . ?t :statedBy :wikipedia }`,
      );
      expect(resOnMappedData).toBeRdfIsomorphic(resUsingRewriter);
    });
  });

  describe('singleton property reification', () => {
    const mappers = [ singletonPropertyConstruct, nonSingletonTripleConstruct ];

    it('querying via CONSTRUCT WHERE { ?s ?p ?o } returns the same results', async({ expect }) => {
      const store11 = await sourceToStore([ './test/statics/singletonPropertyData.ttl' ]);
      const { resOnMappedData, resUsingRewriter } = await compareRewrittenToMapped(
        store11,
        mappers,
        'CONSTRUCT WHERE { ?s ?p ?o }',
      );
      expect(resOnMappedData).toBeRdfIsomorphic(resUsingRewriter);
    });

    it('querying for all reified triples returns the same results', async({ expect }) => {
      const store11 = await sourceToStore([ './test/statics/singletonPropertyData.ttl' ]);
      const { resOnMappedData, resUsingRewriter } = await compareRewrittenToMapped(
        store11,
        mappers,
        `PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
         CONSTRUCT { ?prop rdf:reifies <<( ?s ?p ?o )>> }
         WHERE { ?prop rdf:reifies <<( ?s ?p ?o )>> }`,
      );
      expect(resOnMappedData).toBeRdfIsomorphic(resUsingRewriter);
    });

    it('querying for employment start dates returns the same results', async({ expect }) => {
      const store11 = await sourceToStore([ './test/statics/singletonPropertyData.ttl' ]);
      const { resOnMappedData, resUsingRewriter } = await compareRewrittenToMapped(
        store11,
        mappers,
        `PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
         PREFIX : <ex://>
         CONSTRUCT { ?prop :startDate ?date }
         WHERE { ?prop rdf:reifies <<( ?s :worksFor ?o )>> . ?prop :startDate ?date }`,
      );
      expect(resOnMappedData).toBeRdfIsomorphic(resUsingRewriter);
    });

    it('querying for employment roles returns the same results', async({ expect }) => {
      const store11 = await sourceToStore([ './test/statics/singletonPropertyData.ttl' ]);
      const { resOnMappedData, resUsingRewriter } = await compareRewrittenToMapped(
        store11,
        mappers,
        `PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
         PREFIX : <ex://>
         CONSTRUCT { ?s :hasRole ?role }
         WHERE { ?prop rdf:reifies <<( ?s :worksFor ?o )>> . ?prop :role ?role }`,
      );
      expect(resOnMappedData).toBeRdfIsomorphic(resUsingRewriter);
    });

    it('querying for employees of a specific company returns the same results', async({ expect }) => {
      const store11 = await sourceToStore([ './test/statics/singletonPropertyData.ttl' ]);
      const { resOnMappedData, resUsingRewriter } = await compareRewrittenToMapped(
        store11,
        mappers,
        `PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
         PREFIX : <ex://>
         CONSTRUCT { ?employee :worksFor :acme }
         WHERE { ?prop rdf:reifies <<( ?employee :worksFor :acme )>> }`,
      );
      expect(resOnMappedData).toBeRdfIsomorphic(resUsingRewriter);
    });
  });

  describe('rdf interop reification - SELECT queries', () => {
    const mappers = [ tripleTermConstruct, nonTripleTermConstruct ];

    it('selecting all reified triple components returns the same results', async({ expect }) => {
      const store11 = await sourceToStore([ './test/statics/multipleRdfReifiedTriples.ttl' ]);
      const { resOnMappedData, resUsingRewriter } = await compareSelectRewrittenToMapped(
        store11,
        mappers,
        `PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
         SELECT ?s ?p ?o WHERE { ?t rdf:reifies <<( ?s ?p ?o )>> }`,
      );
      expect(resOnMappedData).toEqual(resUsingRewriter);
    });

    // A triple term pattern whose predicate is a variable also reaches the pass through mapping,
    // where the object is any term. Reading SUBJECT/PREDICATE/OBJECT out of a non triple term
    // raises an evaluation error, which leaves the BIND target unbound instead of rejecting the
    // solution, so the rewriting has to assert the triple term-ness itself.
    it('a triple term pattern with a variable predicate does not match plain triples', async({ expect }) => {
      const store11 = await sourceToStore([ './test/statics/multipleRdfReifiedTriples.ttl' ]);
      const { resOnMappedData, resUsingRewriter } = await compareSelectRewrittenToMapped(
        store11,
        mappers,
        'SELECT ?t ?p ?s ?p2 ?o WHERE { ?t ?p <<( ?s ?p2 ?o )>> }',
      );
      expect(resOnMappedData).toEqual(resUsingRewriter);
    });

    it('selecting with OPTIONAL annotation (StarBench S-category) returns the same results', async({ expect }) => {
      const store11 = await sourceToStore([ './test/statics/multipleRdfReifiedTriples.ttl' ]);
      const { resOnMappedData, resUsingRewriter } = await compareSelectRewrittenToMapped(
        store11,
        mappers,
        `PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
         PREFIX : <ex://>
         SELECT ?s ?p ?o ?agent WHERE {
           ?t rdf:reifies <<( ?s ?p ?o )>> .
           OPTIONAL { ?t :statedBy ?agent }
         }`,
      );
      expect(resOnMappedData).toEqual(resUsingRewriter);
    });

    it(
      'selecting by joining two reified triples (StarBench P22-style) returns the same results',
      async({ expect }) => {
        const store11 = await sourceToStore([ './test/statics/multipleRdfReifiedTriples.ttl' ]);
        const { resOnMappedData, resUsingRewriter } = await compareSelectRewrittenToMapped(
          store11,
          mappers,
          `PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
           PREFIX : <ex://>
           SELECT ?o1 ?o2 WHERE {
             ?t1 rdf:reifies <<( :alice :knows ?o1 )>> .
             ?t2 rdf:reifies <<( ?o1 :knows ?o2 )>> .
           }`,
        );
        expect(resOnMappedData).toEqual(resUsingRewriter);
      },
    );

    it('selecting with FILTER on annotation (StarBench S-category) returns the same results', async({ expect }) => {
      const store11 = await sourceToStore([ './test/statics/multipleRdfReifiedTriples.ttl' ]);
      const { resOnMappedData, resUsingRewriter } = await compareSelectRewrittenToMapped(
        store11,
        mappers,
        `PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
         PREFIX : <ex://>
         SELECT ?s ?p ?o WHERE {
           ?t rdf:reifies <<( ?s ?p ?o )>> .
           ?t :statedBy :wikipedia .
         }`,
      );
      expect(resOnMappedData).toEqual(resUsingRewriter);
    });

    it('selecting with subject filter returns the same results', async({ expect }) => {
      const store11 = await sourceToStore([ './test/statics/multipleRdfReifiedTriples.ttl' ]);
      const { resOnMappedData, resUsingRewriter } = await compareSelectRewrittenToMapped(
        store11,
        mappers,
        `PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
         PREFIX : <ex://>
         SELECT ?p ?o WHERE { ?t rdf:reifies <<( :alice ?p ?o )>> }`,
      );
      expect(resOnMappedData).toEqual(resUsingRewriter);
    });

    it('selecting with a variable reused across positions (?x ?x ?o) returns the same results', async({ expect }) => {
      // Reusing the same variable in subject and predicate position unifies two mapping-head
      // variables, which has to bind that variable once rather than twice.
      // The store deliberately contains a triple whose subject equals its predicate.
      const store11 = new Store([
        DF.quad(DF.namedNode('ex://loop'), DF.namedNode('ex://loop'), DF.namedNode('ex://x')),
        DF.quad(DF.namedNode('ex://a'), DF.namedNode('ex://b'), DF.namedNode('ex://c')),
      ]);
      const { resOnMappedData, resUsingRewriter } = await compareSelectRewrittenToMapped(
        store11,
        mappers,
        'SELECT ?x ?o WHERE { ?x ?x ?o }',
      );
      expect(resOnMappedData).toEqual(resUsingRewriter);
    });
  });

  describe('mapping head triple terms - single mapping', () => {
    // With a single mapping the head keeps its own shape rather than being merged behind ?m_s ?m_p ?m_o,
    // so these are the queries where a pattern is unified with a triple term the *head* writes.

    it('binding the whole triple term of a head returns the same results', async({ expect }) => {
      const store11 = await sourceToStore([ './test/statics/multipleRdfReifiedTriples.ttl' ]);
      const { resOnMappedData, resUsingRewriter } = await compareSelectRewrittenToMapped(
        store11,
        [ tripleTermConstruct ],
        `PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
         SELECT ?t ?s ?p ?o WHERE {
           ?t rdf:reifies ?tt .
           BIND(SUBJECT(?tt) AS ?s)
           BIND(PREDICATE(?tt) AS ?p)
           BIND(OBJECT(?tt) AS ?o)
         }`,
      );
      expect(resOnMappedData).toEqual(resUsingRewriter);
    });

    it('deciding a position of the head triple term returns the same results', async({ expect }) => {
      // The reifier is the predicate of the triple term it reifies, so fixing it decides that position,
      // which the rewriting writes into the triple term it constructs.
      const store11 = await sourceToStore([ './test/statics/multipleRdfReifiedTriples.ttl' ]);
      const { resOnMappedData, resUsingRewriter } = await compareSelectRewrittenToMapped(
        store11,
        [ predicateReifierConstruct ],
        `PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
         PREFIX : <ex://>
         SELECT ?s ?p ?o WHERE {
           :knows rdf:reifies ?tt .
           BIND(SUBJECT(?tt) AS ?s)
           BIND(PREDICATE(?tt) AS ?p)
           BIND(OBJECT(?tt) AS ?o)
         }`,
      );
      expect(resOnMappedData).toEqual(resUsingRewriter);
    });
  });

  describe('singleton property reification - SELECT queries', () => {
    const mappers = [ singletonPropertyConstruct, nonSingletonTripleConstruct ];

    it('selecting all employees and their roles returns the same results', async({ expect }) => {
      const store11 = await sourceToStore([ './test/statics/singletonPropertyData.ttl' ]);
      const { resOnMappedData, resUsingRewriter } = await compareSelectRewrittenToMapped(
        store11,
        mappers,
        `PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
         PREFIX : <ex://>
         SELECT ?employee ?role WHERE {
           ?prop rdf:reifies <<( ?employee :worksFor :acme )>> .
           ?prop :role ?role .
         }`,
      );
      expect(resOnMappedData).toEqual(resUsingRewriter);
    });

    it('selecting with OPTIONAL start date returns the same results', async({ expect }) => {
      const store11 = await sourceToStore([ './test/statics/singletonPropertyData.ttl' ]);
      const { resOnMappedData, resUsingRewriter } = await compareSelectRewrittenToMapped(
        store11,
        mappers,
        `PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
         PREFIX : <ex://>
         SELECT ?employee ?o ?date WHERE {
           ?prop rdf:reifies <<( ?employee :worksFor ?o )>> .
           OPTIONAL { ?prop :startDate ?date }
         }`,
      );
      expect(resOnMappedData).toEqual(resUsingRewriter);
    });

    it('selecting employees of a specific company returns the same results', async({ expect }) => {
      const store11 = await sourceToStore([ './test/statics/singletonPropertyData.ttl' ]);
      const { resOnMappedData, resUsingRewriter } = await compareSelectRewrittenToMapped(
        store11,
        mappers,
        `PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
         PREFIX : <ex://>
         SELECT ?employee WHERE { ?prop rdf:reifies <<( ?employee :worksFor :acme )>> }`,
      );
      expect(resOnMappedData).toEqual(resUsingRewriter);
    });

    it('selecting with FILTER on role returns the same results', async({ expect }) => {
      const store11 = await sourceToStore([ './test/statics/singletonPropertyData.ttl' ]);
      const { resOnMappedData, resUsingRewriter } = await compareSelectRewrittenToMapped(
        store11,
        mappers,
        `PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
         PREFIX : <ex://>
         SELECT ?employee WHERE {
           ?prop rdf:reifies <<( ?employee :worksFor :acme )>> .
           ?prop :role "engineer" .
         }`,
      );
      expect(resOnMappedData).toEqual(resUsingRewriter);
    });
  });

  describe('mappings writing a variable into a position it was not read from', () => {
    // Every mapping but the first writes a variable its body reads from an object position into a subject or a
    // predicate position. A literal or a triple term cannot stand there, and a CONSTRUCT instantiates no triple
    // for such a solution (SPARQL 1.1 §16.2), so the mapping body tests the term type of that variable.
    // permutedPositions.ttl holds objects of every kind of term; the comment on each test names the rows that
    // tell it apart from a rewrite that lost a type test, or that dropped what it should not have.
    const prefix = 'PREFIX : <ex://>\n';
    const mappers = [
      // `:knows` as it stands, objects of every kind included.
      `${prefix}CONSTRUCT WHERE { ?s :knows ?o }`,
      // An object written into the subject position.
      `${prefix}CONSTRUCT { ?o :knownBy ?s } WHERE { ?s :knows ?o }`,
      // An object written into the subject position of a triple term the head builds.
      `${prefix}CONSTRUCT { ?s :claims <<( ?o :knownBy ?s )>> } WHERE { ?s :knows ?o }`,
      // Objects written into the subject and into the predicate position.
      `${prefix}CONSTRUCT { ?s ?p ?o } WHERE { ?row :subj ?s ; :pred ?p ; :obj ?o }`,
      // The object of either branch of a UNION written into the subject position.
      `${prefix}CONSTRUCT { ?o :contactOf ?s } WHERE { { ?s :knows ?o } UNION { ?s :met ?o } }`,
      // The same beside an OPTIONAL, whose variable the head needs bound as well.
      `${prefix}CONSTRUCT { ?o :introducedBy ?w } WHERE { ?s :met ?o OPTIONAL { ?s :via ?w } }`,
    ];

    /**
     * Checks that a SELECT over the mapped data and its rewriting over permutedPositions.ttl give the same rows, and
     * that those are the rows expected.
     * @param expect - The `expect` of the test
     * @param userQuery - The SELECT query, without its prefix
     * @param rows - The rows it has to give
     * @param options - What the mapping is configured with
     */
    async function expectRowsOverPermutedPositions(
      expect: typeof Expect,
      userQuery: string,
      rows: string[],
      options: MappingOptions = {},
    ): Promise<void> {
      const store11 = await sourceToStore([ './test/statics/permutedPositions.ttl' ]);
      const { resOnMappedData, resUsingRewriter } =
        await compareSelectRewrittenToMapped(store11, mappers, `${prefix}${userQuery}`, options);
      expect(resOnMappedData).toEqual(resUsingRewriter);
      expect(resOnMappedData).toEqual(rows);
    }

    it('returns an object as subject only where it can be one', async({ expect }) => {
      // "Bob", 42 and the triple term make no `:knownBy` triple: a rewrite without the type test returns them as
      // `?x`. The blank node does make one, which a rewrite testing for an IRI alone would lose.
      await expectRowsOverPermutedPositions(
        expect,
        'SELECT * WHERE { ?x :knownBy ?y }',
        [
          '{x=_:someone,y=ex://dave}',
          '{x=ex://bob,y=ex://alice}',
          '{x=ex://carol,y=ex://bob}',
          '{x=ex://carol,y=ex://carol}',
          '{x=ex://erin,y=_:someone}',
        ],
      );
    });

    it('returns an object as predicate only where it is an IRI', async({ expect }) => {
      // Of the table rows with `:obj :alice` only `:r1` is a triple: `:r3` has a literal subject, and `:r4`, `:r5`
      // and `:r6` a literal, a blank node and a triple term as predicate - a rewrite admitting a blank node there,
      // as a subject does, keeps `:r5`. "Bob" and "Zoe", objects of `:alice`, make no `:knownBy` or `:contactOf`
      // triple.
      await expectRowsOverPermutedPositions(
        expect,
        'SELECT * WHERE { ?s ?p :alice }',
        [
          '{p=ex://contactOf,s=ex://bob}',
          '{p=ex://contactOf,s=ex://dave}',
          '{p=ex://knownBy,s=ex://bob}',
          '{p=ex://likes,s=ex://carol}',
        ],
      );
    });

    it('still tests the subject where the query fixes the predicate', async({ expect }) => {
      // `:likes` decides the type test of the predicate, not the one of the subject: `:r3` ("Dave") would be back.
      await expectRowsOverPermutedPositions(
        expect,
        'SELECT * WHERE { ?s :likes ?o }',
        [
          '{o="tea",s=ex://carol}',
          '{o=ex://alice,s=ex://carol}',
        ],
      );
    });

    it('builds a triple term only out of an object that can be its subject', async({ expect }) => {
      // "Bob", 42 and the triple term make no `:claims` triple. Without the type test, building the triple term
      // raises for them and leaves `?t` unbound: rows of `:alice`, `:bob` and `:carol` without a `?t` come back.
      await expectRowsOverPermutedPositions(
        expect,
        'SELECT * WHERE { ?s :claims ?t }',
        [
          '{s=_:someone,t=<<ex://erin ex://knownBy _:someone>>}',
          '{s=ex://alice,t=<<ex://bob ex://knownBy ex://alice>>}',
          '{s=ex://bob,t=<<ex://carol ex://knownBy ex://bob>>}',
          '{s=ex://carol,t=<<ex://carol ex://knownBy ex://carol>>}',
          '{s=ex://dave,t=<<_:someone ex://knownBy ex://dave>>}',
        ],
      );
    });

    it('matches a triple term pattern only where the head builds a triple term', async({ expect }) => {
      // The same rows tell: without a type test, reading the positions of the triple term that could not be built
      // binds neither `?x` nor `?y`, and `:alice`, `:bob` and `:carol` come back with `?s` alone.
      await expectRowsOverPermutedPositions(
        expect,
        'SELECT * WHERE { ?s :claims <<( ?x :knownBy ?y )>> }',
        [
          '{s=_:someone,x=ex://erin,y=_:someone}',
          '{s=ex://alice,x=ex://bob,y=ex://alice}',
          '{s=ex://bob,x=ex://carol,y=ex://bob}',
          '{s=ex://carol,x=ex://carol,y=ex://carol}',
          '{s=ex://dave,x=_:someone,y=ex://dave}',
        ],
      );
    });

    it('tests the objects of both branches of a UNION body', async({ expect }) => {
      // "Bob", 42 and the triple term from the `:knows` branch, and "Zoe" from the `:met` one, make no triple.
      await expectRowsOverPermutedPositions(
        expect,
        'SELECT * WHERE { ?x :contactOf ?y }',
        [
          '{x=_:someone,y=ex://dave}',
          '{x=ex://alice,y=ex://erin}',
          '{x=ex://bob,y=ex://alice}',
          '{x=ex://carol,y=ex://bob}',
          '{x=ex://carol,y=ex://carol}',
          '{x=ex://dave,y=ex://alice}',
          '{x=ex://erin,y=_:someone}',
        ],
      );
    });

    it('tests an object beside an OPTIONAL whose variable has to be bound', async({ expect }) => {
      // "Zoe" has an introducer, so only the type test keeps it out; `:alice`, met by `:erin`, has none, so only
      // `bound(?w)` does - a rewrite without it returns `:alice` with no `?w`.
      await expectRowsOverPermutedPositions(
        expect,
        'SELECT * WHERE { ?x :introducedBy ?w }',
        [
          '{w=ex://bob,x=ex://dave}',
        ],
      );
    });

    it('drops only the branch a user isLITERAL contradicts', async({ expect }) => {
      // No `:knownBy` triple has a literal subject, so only the `:knows` branch has rows here. A rewrite without
      // the type test returns "Bob" and 42 from the `:knownBy` branch as well, twice over in all; one emptying the
      // whole UNION loses both.
      await expectRowsOverPermutedPositions(
        expect,
        'SELECT * WHERE { { ?x :knownBy ?y } UNION { ?y :knows ?x } FILTER(isLITERAL(?x)) }',
        [
          '{x="42"^^http://www.w3.org/2001/XMLSchema#integer,y=ex://bob}',
          '{x="Bob",y=ex://alice}',
        ],
      );
    });

    it('keeps the rows a user isIRI || isBLANK restating the mapping\'s test keeps', async({ expect }) => {
      // The two tests are one, so the rewrite needs only one of them: a rewrite that took either for the other
      // and dropped both returns "Bob", 42, "Zoe" and the triple term.
      await expectRowsOverPermutedPositions(
        expect,
        'SELECT * WHERE { ?x :contactOf ?y FILTER(isIRI(?x) || isBLANK(?x)) }',
        [
          '{x=_:someone,y=ex://dave}',
          '{x=ex://alice,y=ex://erin}',
          '{x=ex://bob,y=ex://alice}',
          '{x=ex://carol,y=ex://bob}',
          '{x=ex://carol,y=ex://carol}',
          '{x=ex://dave,y=ex://alice}',
          '{x=ex://erin,y=_:someone}',
        ],
      );
    });

    it('narrows the mapping\'s test to a user isIRI', async({ expect }) => {
      // The blank node passes the mapping's test and fails the user's: a rewrite keeping only the wider of the two
      // returns `_:someone` as `?x`.
      await expectRowsOverPermutedPositions(
        expect,
        'SELECT * WHERE { ?x :knownBy ?y FILTER(isIRI(?x)) }',
        [
          '{x=ex://bob,y=ex://alice}',
          '{x=ex://carol,y=ex://bob}',
          '{x=ex://carol,y=ex://carol}',
          '{x=ex://erin,y=_:someone}',
        ],
      );
    });

    it('joins a variable in a subject position with one in an object position', async({ expect }) => {
      // `?x` is the subject of `:knownBy`, typed, and an object of `:knows`, which holds anything: "Bob", 42 and
      // the triple term are objects of `:knows` the join would keep if `:knownBy` had kept them as subjects.
      await expectRowsOverPermutedPositions(
        expect,
        'SELECT * WHERE { ?x :knownBy ?y . ?z :knows ?x }',
        [
          '{x=_:someone,y=ex://dave,z=ex://dave}',
          '{x=ex://bob,y=ex://alice,z=ex://alice}',
          '{x=ex://carol,y=ex://bob,z=ex://bob}',
          '{x=ex://carol,y=ex://bob,z=ex://carol}',
          '{x=ex://carol,y=ex://carol,z=ex://bob}',
          '{x=ex://carol,y=ex://carol,z=ex://carol}',
          '{x=ex://erin,y=_:someone,z=_:someone}',
        ],
      );
    });

    it('carries the type test across a sameTerm between the two patterns', async({ expect }) => {
      // The join above as a clique `{ ?x, ?w }`: every reading of it holds only what `?x` can, so the same rows
      // tell - "Bob", 42 and the triple term, as both `?x` and `?w`.
      await expectRowsOverPermutedPositions(
        expect,
        'SELECT * WHERE { ?x :knownBy ?y . ?z :knows ?w FILTER(sameTerm(?x, ?w)) }',
        [
          '{w=_:someone,x=_:someone,y=ex://dave,z=ex://dave}',
          '{w=ex://bob,x=ex://bob,y=ex://alice,z=ex://alice}',
          '{w=ex://carol,x=ex://carol,y=ex://bob,z=ex://bob}',
          '{w=ex://carol,x=ex://carol,y=ex://bob,z=ex://carol}',
          '{w=ex://carol,x=ex://carol,y=ex://carol,z=ex://bob}',
          '{w=ex://carol,x=ex://carol,y=ex://carol,z=ex://carol}',
          '{w=ex://erin,x=ex://erin,y=_:someone,z=_:someone}',
        ],
      );
    });

    it('drops nothing when a sameTerm makes the type test redundant', async({ expect }) => {
      // Equating `?x` with `?y` puts the object the test is about in the subject position of `:knows`, which
      // decides the test: what is left to tell is the loop on `:carol`, which a rewrite emptying the query loses.
      await expectRowsOverPermutedPositions(
        expect,
        'SELECT * WHERE { ?x :knownBy ?y FILTER(sameTerm(?x, ?y)) }',
        [
          '{x=ex://carol,y=ex://carol}',
        ],
      );
    });

    it('leaves an object no subject can be without a match in an OPTIONAL', async({ expect }) => {
      // "Bob", 42 and the triple term keep their row, with no `?k`: a rewrite without the type test finds them a
      // `?k`, and one making the OPTIONAL a join loses them.
      await expectRowsOverPermutedPositions(
        expect,
        'SELECT * WHERE { ?s :knows ?o OPTIONAL { ?o :knownBy ?k } }',
        [
          '{k=_:someone,o=ex://erin,s=_:someone}',
          '{k=ex://alice,o=ex://bob,s=ex://alice}',
          '{k=ex://bob,o=ex://carol,s=ex://bob}',
          '{k=ex://bob,o=ex://carol,s=ex://carol}',
          '{k=ex://carol,o=ex://carol,s=ex://bob}',
          '{k=ex://carol,o=ex://carol,s=ex://carol}',
          '{k=ex://dave,o=_:someone,s=ex://dave}',
          '{o="42"^^http://www.w3.org/2001/XMLSchema#integer,s=ex://bob}',
          '{o="Bob",s=ex://alice}',
          '{o=<<ex://alice ex://knows ex://bob>>,s=ex://carol}',
        ],
      );
    });

    it('keeps a bound() on a triple term the query builds out of an object', async({ expect }) => {
      // Building `<<( ?o :knownBy ?s )>>` raises for "Bob", 42 and the triple term, which leaves `?t` unbound: a
      // rewrite dropping the condition returns their rows without a `?t`.
      await expectRowsOverPermutedPositions(
        expect,
        'SELECT * WHERE { ?s :knows ?o BIND(<<( ?o :knownBy ?s )>> AS ?t) FILTER(bound(?t)) }',
        [
          '{o=_:someone,s=ex://dave,t=<<_:someone ex://knownBy ex://dave>>}',
          '{o=ex://bob,s=ex://alice,t=<<ex://bob ex://knownBy ex://alice>>}',
          '{o=ex://carol,s=ex://bob,t=<<ex://carol ex://knownBy ex://bob>>}',
          '{o=ex://carol,s=ex://carol,t=<<ex://carol ex://knownBy ex://carol>>}',
          '{o=ex://erin,s=_:someone,t=<<ex://erin ex://knownBy _:someone>>}',
        ],
      );
    });

    it('keeps a sameTerm over a BIND of a variable one UNION branch leaves unbound', async({ expect }) => {
      // `sameTerm(?t, ?z)` raises where `?z` is unbound, so the `:likes` branch has no rows: a rewrite dropping the
      // filter returns `:carol` liking `:alice` and "tea". "Bob", 42 and the triple term tell the type test again.
      await expectRowsOverPermutedPositions(
        expect,
        'SELECT * WHERE { { ?a :knownBy ?z } UNION { ?a :likes ?b } BIND(?z AS ?t) FILTER(sameTerm(?t, ?z)) }',
        [
          '{a=_:someone,t=ex://dave,z=ex://dave}',
          '{a=ex://bob,t=ex://alice,z=ex://alice}',
          '{a=ex://carol,t=ex://bob,z=ex://bob}',
          '{a=ex://carol,t=ex://carol,z=ex://carol}',
          '{a=ex://erin,t=_:someone,z=_:someone}',
        ],
      );
    });

    it('returns the rows the type tests drop when the mapping is a generalized RDF view', async({ expect }) => {
      // The query of the second test above: with `generalizedRdfView` there is no type test, and the triples it
      // would drop - the ones Comunica's CONSTRUCT keeps - are what the view holds.
      await expectRowsOverPermutedPositions(
        expect,
        'SELECT * WHERE { ?s ?p :alice }',
        [
          '{p="likes",s=ex://bob}',
          '{p=<<ex://a ex://b ex://c>>,s=ex://erin}',
          '{p=_:p,s=ex://dave}',
          '{p=ex://contactOf,s="Bob"}',
          '{p=ex://contactOf,s="Zoe"}',
          '{p=ex://contactOf,s=ex://bob}',
          '{p=ex://contactOf,s=ex://dave}',
          '{p=ex://knownBy,s="Bob"}',
          '{p=ex://knownBy,s=ex://bob}',
          '{p=ex://likes,s="Dave"}',
          '{p=ex://likes,s=ex://carol}',
        ],
        { generalizedRdfView: true },
      );
    });
  });
});
