import { QueryEngine } from '@comunica/query-sparql-file';
import type * as RDF from '@rdfjs/types';
import * as arrayifyStreamNS from 'arrayify-stream';
import { DataFactory, Store } from 'n3';
import { describe, it } from 'vitest';
import { transformFilterFalse } from '../lib/transformations/filterFalse.js';
import { nullifyJoinOverIncompatibleBounds } from '../lib/transformations/nullifyJoinOverIncompatibleBounds.js';
import { nullifyUnbindableVars } from '../lib/transformations/nullifyUnbindableVars.js';
import { pullUpExtends } from '../lib/transformations/pullUpExtends.js';
import { removeProjections } from '../lib/transformations/removeProjections.js';
import { operationTransform, queryTransform } from '../lib/transformBgp.js';
import { transformContextFromConstructs } from '../lib/transformContext.js';
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

  const standardTransformations = <const>[
    operationTransform,
    transformFilterFalse,
    nullifyJoinOverIncompatibleBounds,
    nullifyUnbindableVars,
    transformFilterFalse,
    pullUpExtends,
    // TODO: remove once https://github.com/comunica/comunica/pull/1734 is merged
    removeProjections,
  ];

  async function sourceToStore(
    sources: NonNullable<Parameters<typeof engine.queryQuads>[1]>['sources'],
    query = 'CONSTRUCT WHERE { ?s ?p ?o }',
  ): Promise<Store> {
    const queryRes: RDF.Quad[] = await arrayifyStream(
      await engine.queryQuads(query, { sources }),
    );
    return new Store(queryRes);
  }

  async function storeTo12Store(source: Store, mappers: string[]): Promise<Store> {
    const result = new Store();
    for (const mapper of mappers) {
      const subRes = await sourceToStore([ source ], mapper);
      result.addAll(subRes);
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

    const transformerContext = transformContextFromConstructs(mappers);
    const rewrittenQuery = queryTransform(transformerContext, userQuery, [ ...standardTransformations ]);
    const resUsingRewriter = (await sourceToStore([ store11 ], rewrittenQuery)).getQuads(null, null, null, null);

    return { resOnMappedData, resUsingRewriter };
  }

  /**
   * Converts a binding to a canonical sorted string representation for comparison.
   * Variables are sorted alphabetically to ensure consistent ordering.
   */
  function bindingToString(binding: RDF.Bindings): string {
    const entries = [ ...binding ]
      .map(([ variable, term ]) => `${variable.value}=${term.termType}:${term.value}`)
      .sort()
      .join(',');
    return `{${entries}}`;
  }

  /**
   * For a given RDF 1.1 store, mappers, and user SPARQL 1.2 SELECT query:
   * - Maps the store to an RDF 1.2 store and runs the SELECT query on it.
   * - Rewrites the SELECT query for the original store and runs it there.
   * Returns both bindings arrays as sorted strings for comparison.
   */
  async function compareSelectRewrittenToMapped(
    store11: Store,
    mappers: string[],
    userQuery: string,
  ): Promise<{ resOnMappedData: string[]; resUsingRewriter: string[] }> {
    const store12 = await storeTo12Store(store11, mappers);
    const mappedBindings: RDF.Bindings[] = await arrayifyStream(
      await engine.queryBindings(userQuery, { sources: [ store12 ]}),
    );

    const transformerContext = transformContextFromConstructs(mappers);
    const rewrittenQuery = queryTransform(transformerContext, userQuery, [ ...standardTransformations ]);
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
      // variables, which previously produced an invalid double BIND to the same variable.
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
});
