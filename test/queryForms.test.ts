import { QueryEngine } from '@comunica/query-sparql-file';
import type * as RDF from '@rdfjs/types';
import * as arrayifyStreamNS from 'arrayify-stream';
import { Store } from 'n3';
import { describe, it } from 'vitest';
import { mappingFromConstructQueries } from '../lib/mapping.js';
import { createQueryRewriter } from '../lib/queryRewriter.js';
import { filterFalseTransformation } from '../lib/transformations/filterFalse.js';
import { pullUpExtendsTransformation } from '../lib/transformations/pullUpExtends.js';
import { removeProjectionsTransformation } from '../lib/transformations/removeProjections.js';
import { unfoldingTransformation } from '../lib/transformations/unfolding.js';
import { nonTripleTermConstruct, tripleTermConstruct } from './queryConsts.js';
import './matchers/toBeRdfIsomorphic.js';

// Crazy workaround to support both CJS and ESM
const arrayifyStream =
  (<any> arrayifyStreamNS).default ?? arrayifyStreamNS;

const prefixes = `PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
PREFIX : <ex://>
`;

/**
 * Every query form, answered over the mapped RDF 1.2 data and over the rewrite of the same query against
 * the RDF 1.1 data it was mapped from. The `uq_` renaming is invisible in the answer of an `ASK`, and a
 * `CONSTRUCT` template and a `DESCRIBE` term are renamed along with the pattern they read, so `SELECT`,
 * `ASK` and `CONSTRUCT` have to answer exactly what the mapped data answers.
 *
 * `DESCRIBE` is the one form that cannot: it answers with a description of the data it is run against, so
 * a rewritten `DESCRIBE` describes its resources in RDF 1.1. What it owes is that it picks the same
 * resources, which is what the test below checks.
 *
 * An update is the other asymmetric one: its `WHERE` reads the RDF 1.2 graph and so is rewritten, but that
 * graph is virtual and the triples it writes go to the RDF 1.1 source as written. What it owes is that the
 * source ends up holding exactly the triples the template instantiates over the solutions the mapped data
 * gives its `WHERE`.
 */
describe('the query forms', () => {
  const engine = new QueryEngine();
  const mappers = [ tripleTermConstruct, nonTripleTermConstruct ];
  const rewriter = createQueryRewriter([
    unfoldingTransformation(mappingFromConstructQueries(mappers)),
    filterFalseTransformation(),
    pullUpExtendsTransformation(),
    removeProjectionsTransformation(),
  ]);

  /** The RDF 1.1 data, and the RDF 1.2 graph the mapping turns it into. */
  async function stores(): Promise<{ store11: Store; store12: Store }> {
    const source = './test/statics/multipleRdfReifiedTriples.ttl';
    const store11 = new Store(await arrayifyStream(
      await engine.queryQuads('CONSTRUCT WHERE { ?s ?p ?o }', { sources: [ source ]}),
    ));
    const store12 = new Store();
    for (const mapper of mappers) {
      store12.addAll(<RDF.Quad[]> await arrayifyStream(await engine.queryQuads(mapper, { sources: [ store11 ]})));
    }
    return { store11, store12 };
  }

  /** What a quad-producing query answers, on the mapped data and through the rewriter. */
  async function compareQuads(userQuery: string): Promise<{ onMappedData: RDF.Quad[]; usingRewriter: RDF.Quad[] }> {
    const { store11, store12 } = await stores();
    return {
      onMappedData: await arrayifyStream(await engine.queryQuads(userQuery, { sources: [ store12 ]})),
      usingRewriter: await arrayifyStream(
        await engine.queryQuads(await rewriter.rewriteQuery(userQuery), { sources: [ store11 ]}),
      ),
    };
  }

  /** What an ASK answers, on the mapped data and through the rewriter. */
  async function compareBoolean(userQuery: string): Promise<{ onMappedData: boolean; usingRewriter: boolean }> {
    const { store11, store12 } = await stores();
    return {
      onMappedData: await engine.queryBoolean(userQuery, { sources: [ store12 ]}),
      usingRewriter: await engine.queryBoolean(await rewriter.rewriteQuery(userQuery), { sources: [ store11 ]}),
    };
  }

  /** The solutions of a SELECT, in order, on the mapped data and through the rewriter. */
  async function compareOrderedSolutions(
    userQuery: string,
  ): Promise<{ onMappedData: string[]; usingRewriter: string[] }> {
    const { store11, store12 } = await stores();
    const asStrings = async(query: string, source: Store): Promise<string[]> => {
      const rows: RDF.Bindings[] = await arrayifyStream(await engine.queryBindings(query, { sources: [ source ]}));
      // Order is part of the answer here, so only the variables within a row are sorted.
      return rows.map(row => [ ...row ].map(([ key, value ]) => `${key.value}=${value.value}`).sort().join('|'));
    };
    return {
      onMappedData: await asStrings(userQuery, store12),
      usingRewriter: await asStrings(await rewriter.rewriteQuery(userQuery), store11),
    };
  }

  describe('an ASK', () => {
    it('is true where the mapped data says it is', async({ expect }) => {
      const { onMappedData, usingRewriter } = await compareBoolean(
        `${prefixes}ASK { ?t rdf:reifies <<( :alice :knows :bob )>> }`,
      );
      expect(onMappedData).toBe(true);
      expect(usingRewriter).toBe(onMappedData);
    });

    it('is false where the mapped data says it is', async({ expect }) => {
      const { onMappedData, usingRewriter } = await compareBoolean(
        `${prefixes}ASK { ?t rdf:reifies <<( :alice :knows :nobody )>> }`,
      );
      expect(onMappedData).toBe(false);
      expect(usingRewriter).toBe(onMappedData);
    });
  });

  describe('a CONSTRUCT', () => {
    it('builds the same graph from a template variable', async({ expect }) => {
      const { onMappedData, usingRewriter } = await compareQuads(
        `${prefixes}CONSTRUCT { ?s :knownBy ?o } WHERE { ?t rdf:reifies <<( ?s :knows ?o )>> }`,
      );
      expect(onMappedData.length).toBeGreaterThan(0);
      expect(onMappedData).toBeRdfIsomorphic(usingRewriter);
    });

    it('keeps its LIMIT, answering as many triples as the mapped data does', async({ expect }) => {
      // Which solutions a LIMIT without an ORDER BY keeps is up to the engine, so the count is what
      // the two sides have to agree on.
      const { onMappedData, usingRewriter } = await compareQuads(
        `${prefixes}CONSTRUCT { ?s :knownBy ?o } WHERE { ?t rdf:reifies <<( ?s :knows ?o )>> } LIMIT 2`,
      );
      expect(onMappedData).toHaveLength(2);
      expect(usingRewriter).toHaveLength(onMappedData.length);
    });
  });

  describe('a DESCRIBE', () => {
    // A DESCRIBE answers with a description *of the data it queries*, so the rewritten query describes
    // the resource in RDF 1.1 where the mapped one describes it in RDF 1.2. Comparing the two graphs is
    // therefore the wrong question; what the rewriting owes is that it describes the same **resources**.
    it('describes the resource the mapped query selects', async({ expect }) => {
      const { store11, store12 } = await stores();
      const userQuery = `${prefixes}DESCRIBE ?t WHERE { ?t rdf:reifies <<( :alice :knows :bob )>> }`;

      const onMappedData: RDF.Quad[] = await arrayifyStream(
        await engine.queryQuads(userQuery, { sources: [ store12 ]}),
      );
      const selectedResources = new Set(onMappedData.map(quad => quad.subject.value));
      expect(selectedResources).toEqual(new Set([ 'ex://t1' ]));

      const usingRewriter: RDF.Quad[] = await arrayifyStream(
        await engine.queryQuads(await rewriter.rewriteQuery(userQuery), { sources: [ store11 ]}),
      );
      const describedOverRdf11: RDF.Quad[] = await arrayifyStream(
        await engine.queryQuads('DESCRIBE <ex://t1>', { sources: [ store11 ]}),
      );
      expect(describedOverRdf11.length).toBeGreaterThan(0);
      expect(usingRewriter).toBeRdfIsomorphic(describedOverRdf11);
    });
  });

  describe('an update', () => {
    /** A quad as the key its three terms make, so that two stores can be compared by content. */
    const quadKey = (quad: RDF.Quad): string =>
      `${quad.subject.value}|${quad.predicate.value}|${quad.object.value}`;

    it('inserts what its template makes of the solutions the mapped data gives its WHERE', async({ expect }) => {
      const { store11, store12 } = await stores();
      const where = 'WHERE { ?t rdf:reifies <<( ?s :knows ?o )>> }';

      // What the same template instantiates over the RDF 1.2 graph: the triples the update owes the source.
      const owed: RDF.Quad[] = await arrayifyStream(
        await engine.queryQuads(`${prefixes}CONSTRUCT { ?s :knownBy ?o } ${where}`, { sources: [ store12 ]}),
      );
      expect(owed.length).toBeGreaterThan(0);

      const before = new Set(store11.getQuads(null, null, null, null).map(quadKey));
      await engine.queryVoid(
        await rewriter.rewriteQuery(`${prefixes}INSERT { ?s :knownBy ?o } ${where}`),
        { sources: [ store11 ]},
      );

      const inserted = store11.getQuads(null, null, null, null).filter(quad => !before.has(quadKey(quad)));
      expect(new Set(inserted.map(quadKey))).toEqual(new Set(owed.map(quadKey)));
    });

    it('deletes the triples its template names, the WHERE reading the mapped data', async({ expect }) => {
      const { store11 } = await stores();
      const before = store11.getQuads(null, null, null, null);
      expect(before.some(quad => quad.predicate.value.endsWith('#Subject'))).toBe(true);

      await engine.queryVoid(
        await rewriter.rewriteQuery(
          `${prefixes}DELETE { ?t rdf:Subject ?s } WHERE { ?t rdf:reifies <<( ?s :knows ?o )>> }`,
        ),
        { sources: [ store11 ]},
      );

      const after = new Set(store11.getQuads(null, null, null, null).map(quadKey));
      const deleted = before.filter(quad => !after.has(quadKey(quad)));
      expect(deleted.length).toBeGreaterThan(0);
      expect(deleted.every(quad => quad.predicate.value.endsWith('#Subject'))).toBe(true);
    });

    it('leaves an update with no WHERE to read exactly as it was', async({ expect }) => {
      expect((await rewriter.rewriteQuery('INSERT DATA { <ex://a> <ex://b> <ex://c> }'))
        .replaceAll(/\s+/gu, ' ').trim()).toBe('INSERT DATA { <ex://a> <ex://b> <ex://c> . }');
    });
  });

  describe('a SELECT', () => {
    it('answers the same solutions in order, under ORDER BY with LIMIT and OFFSET', async({ expect }) => {
      const { onMappedData, usingRewriter } = await compareOrderedSolutions(
        `${prefixes}SELECT ?s ?o WHERE { ?t rdf:reifies <<( ?s :knows ?o )>> } ORDER BY ?o ?s LIMIT 2 OFFSET 1`,
      );
      expect(onMappedData).toHaveLength(2);
      expect(usingRewriter).toEqual(onMappedData);
    });

    it('answers the same solutions under DISTINCT', async({ expect }) => {
      const { onMappedData, usingRewriter } = await compareOrderedSolutions(
        `${prefixes}SELECT DISTINCT ?s WHERE { ?t rdf:reifies <<( ?s :knows ?o )>> } ORDER BY ?s`,
      );
      expect(onMappedData.length).toBeGreaterThan(0);
      expect(usingRewriter).toEqual(onMappedData);
    });
  });
});
