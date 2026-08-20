import { QueryEngine } from '@comunica/query-sparql-file';
import type * as RDF from '@rdfjs/types';
import * as arrayifyStreamNS from 'arrayify-stream';
import { Store } from 'n3';
import { DataFactory } from 'rdf-data-factory';
import { describe, it } from 'vitest';
import { transformFilterFalse } from '../lib/transformations/filterFalse.js';
import { nullifyJoinOverIncompatibleBounds } from '../lib/transformations/nullifyJoinOverIncompatibleBounds.js';
import { nullifyUnbindableVars } from '../lib/transformations/nullifyUnbindableVars.js';
import { operationTransform, queryTransform } from '../lib/transformBgp.js';
import { transformContextFromConstructs } from '../lib/transformContext.js';
import { nonTripleTermConstruct, tripleTermConstruct } from './queryConsts.js';
import './matchers/toBeRdfIsomorphic.js';

// Crazy workaround to support both CJS and ESM
const arrayifyStream =
  (<any> arrayifyStreamNS).default ?? arrayifyStreamNS;

describe('evaluation tests', () => {
  const engine = new QueryEngine();
  const DF = new DataFactory();

  it('an empty eval text', async({ expect }) => {
    const query = 'CONSTRUCT WHERE { ?s ?p ?o }';
    const queryRes = arrayifyStream(
      await engine.queryQuads(query, { sources: [ './test/statics/data01.ttl' ]}),
    );
    await expect(queryRes)
      .resolves.toMatchObject([
        DF.quad(DF.namedNode('ex://a'), DF.namedNode('ex://p1'), DF.namedNode('ex://o1')),
        DF.quad(DF.namedNode('ex://a'), DF.namedNode('ex://p2'), DF.namedNode('ex://o2')),
      ]);
  });

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

  describe('rdf reification', () => {
    it ('fails without mapping', async({ expect }) => {
      const store11 = await sourceToStore([ './test/statics/singleRdfReifiedTriple.ttl' ]);
      const store12 = await storeTo12Store(store11, [ tripleTermConstruct, nonTripleTermConstruct ]);

      // Querying a normal query over store 1.2 should give same result as altered query over store 1.1
      const userQuery = 'CONSTRUCT WHERE { ?s ?p ?o }';
      const resOnMappedData = await sourceToStore([ store12 ], userQuery);
      const resUsingMapper = await sourceToStore([ store11 ], userQuery);

      expect(resOnMappedData.getQuads(null, null, null, null))
        .not.toBeRdfIsomorphic(resUsingMapper.getQuads(null, null, null, null));
    });

    it ('works on single reified triple construct *', async({ expect }) => {
      const store11 = await sourceToStore([ './test/statics/singleRdfReifiedTriple.ttl' ]);
      const store12 = await storeTo12Store(store11, [ tripleTermConstruct, nonTripleTermConstruct ]);

      // Querying a normal query over store 1.2 should give same result as altered query over store 1.1
      const userQuery = 'CONSTRUCT WHERE { ?s ?p ?o }';
      const resOnMappedData = await sourceToStore([ store12 ], userQuery);
      const transformerContext = transformContextFromConstructs([ tripleTermConstruct, nonTripleTermConstruct ]);
      const resUsingMapper = await sourceToStore([ store11 ], queryTransform(transformerContext, userQuery, [
        operationTransform,
        transformFilterFalse,
        nullifyJoinOverIncompatibleBounds,
        nullifyUnbindableVars,
        transformFilterFalse,
      ]));

      expect(resOnMappedData.getQuads(null, null, null, null))
        .toBeRdfIsomorphic(resUsingMapper.getQuads(null, null, null, null));
    });
  });
});
