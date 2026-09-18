import { QueryEngine } from '@comunica/query-sparql-file';
import type * as RDF from '@rdfjs/types';
import * as arrayifyStreamNS from 'arrayify-stream';
import { DataFactory, Store } from 'n3';
import { describe, it } from 'vitest';
import { mappingFromConstructQueries } from '../lib/mapping.js';
import { createQueryRewriter } from '../lib/queryRewriter.js';
import { filterFalseTransformation } from '../lib/transformations/filterFalse.js';
import { unfoldingTransformation } from '../lib/transformations/unfolding.js';

// Crazy workaround to support both CJS and ESM
const arrayifyStream =
  (<any> arrayifyStreamNS).default ?? arrayifyStreamNS;

/**
 * The unfolded query treats the virtual RDF 1.2 graph as a **bag**: two solutions of the mapping body
 * producing the same triple are counted twice, where the mapped graph is a set. `preserveCardinality`
 * closes that gap, at the cost of deduplicating the whole body of every unfolded pattern.
 */
describe('preserveCardinality', () => {
  const engine = new QueryEngine();
  const DF = DataFactory;

  // Both branches of the union produce <ex://alice> <ex://knows> <ex://bob>, so the body has two
  // solutions where the mapped graph holds one triple.
  const duplicatingConstruct = `CONSTRUCT { ?s <ex://knows> ?o } WHERE {
    { ?s <ex://a> ?o } UNION { ?s <ex://b> ?o }
  }`;
  const mapping = mappingFromConstructQueries([ duplicatingConstruct ]);

  const store11 = new Store([
    DF.quad(DF.namedNode('ex://alice'), DF.namedNode('ex://a'), DF.namedNode('ex://bob')),
    DF.quad(DF.namedNode('ex://alice'), DF.namedNode('ex://b'), DF.namedNode('ex://bob')),
  ]);

  function rewriterPreserving(preserveCardinality: boolean): ReturnType<typeof createQueryRewriter> {
    return createQueryRewriter([
      unfoldingTransformation(mapping, { preserveCardinality }),
      filterFalseTransformation(),
    ]);
  }

  /** The solutions of a query, duplicates kept, as sorted `name=value` strings. */
  async function solutionsOf(query: string, source: Store): Promise<string[]> {
    const rows: RDF.Bindings[] = await arrayifyStream(await engine.queryBindings(query, { sources: [ source ]}));
    return rows
      .map(row => [ ...row ].map(([ key, value ]) => `${key.value}=${value.value}`).sort().join('|'))
      .sort();
  }

  /** The RDF 1.2 graph the mapping denotes, which is a set. */
  async function mappedStore(): Promise<Store> {
    const quads: RDF.Quad[] = await arrayifyStream(
      await engine.queryQuads(duplicatingConstruct, { sources: [ store11 ]}),
    );
    return new Store(quads);
  }

  it('counts a repeated triple twice when it is off', async({ expect }) => {
    const userQuery = 'SELECT * WHERE { ?s <ex://knows> ?o }';
    const theOneTriple = 'o=ex://bob|s=ex://alice';
    expect(await solutionsOf(await rewriterPreserving(false).rewriteQuery(userQuery), store11))
      .toEqual([ theOneTriple, theOneTriple ]);
    expect(await solutionsOf(userQuery, await mappedStore())).toEqual([ theOneTriple ]);
  });

  it('counts it once when it is on, as the mapped graph does', async({ expect }) => {
    const userQuery = 'SELECT * WHERE { ?s <ex://knows> ?o }';
    expect(await solutionsOf(await rewriterPreserving(true).rewriteQuery(userQuery), store11))
      .toEqual(await solutionsOf(userQuery, await mappedStore()));
  });

  it('agrees with the mapped graph on COUNT(*) only when it is on', async({ expect }) => {
    const userQuery = 'SELECT (COUNT(*) AS ?n) WHERE { ?s <ex://knows> ?o }';
    const onMappedData = await solutionsOf(userQuery, await mappedStore());
    expect(onMappedData).toEqual([ 'n=1' ]);

    expect(await solutionsOf(await rewriterPreserving(true).rewriteQuery(userQuery), store11))
      .toEqual(onMappedData);
    expect(await solutionsOf(await rewriterPreserving(false).rewriteQuery(userQuery), store11))
      .toEqual([ 'n=2' ]);
  });
});

/**
 * A mapping head of nothing but constants is the worst case for the bag semantics: where a head with
 * variables needs two body solutions to coincide on a triple before it counts one twice, a ground head
 * writes *the same* triple for every solution its body has, so the count is the body's.
 *
 * It is also where deduplicating over "the head's variables" has none to deduplicate over. A `SELECT` over
 * no variables is not SPARQL, and generating one yields `SELECT *` - which deduplicates over the body's
 * own variables and so does not deduplicate at all, leaving `preserveCardinality` a silent no-op.
 */
describe('preserveCardinality over a ground mapping head', () => {
  const engine = new QueryEngine();
  const DF = DataFactory;

  // Bob is a father as soon as he has any child at all - one triple, however many children.
  const groundHeadConstruct = `PREFIX : <ex://>
    CONSTRUCT { :bob :is :father } WHERE {
      { :bob :hasSon ?child } UNION { :bob :hasDaughter ?child }
    }`;

  // Three body solutions, so three chances to count the one triple more than once.
  const store11 = new Store([
    DF.quad(DF.namedNode('ex://bob'), DF.namedNode('ex://hasSon'), DF.namedNode('ex://sam')),
    DF.quad(DF.namedNode('ex://bob'), DF.namedNode('ex://hasSon'), DF.namedNode('ex://tim')),
    DF.quad(DF.namedNode('ex://bob'), DF.namedNode('ex://hasDaughter'), DF.namedNode('ex://ann')),
  ]);

  const userQuery = 'PREFIX : <ex://> SELECT * WHERE { :bob :is ?x }';

  /** The solutions of a query, duplicates kept. */
  async function solutionsOf(query: string, source: Store): Promise<string[]> {
    const rows: RDF.Bindings[] = await arrayifyStream(await engine.queryBindings(query, { sources: [ source ]}));
    return rows.map(row => [ ...row ].map(([ key, value ]) => `${key.value}=${value.value}`).sort().join('|'));
  }

  /** The user query answered over the RDF 1.2 graph the mapping denotes, which holds the triple once. */
  async function solutionsOnMappedData(): Promise<string[]> {
    const quads: RDF.Quad[] = await arrayifyStream(
      await engine.queryQuads(groundHeadConstruct, { sources: [ store11 ]}),
    );
    return solutionsOf(userQuery, new Store(quads));
  }

  /** The user query answered through a rewriter over the RDF 1.1 data. */
  async function solutionsUsingRewriter(
    mappers: string[],
    preserveCardinality: boolean,
  ): Promise<string[]> {
    const rewriter = createQueryRewriter([
      unfoldingTransformation(mappingFromConstructQueries(mappers), { preserveCardinality }),
      filterFalseTransformation(),
    ]);
    return solutionsOf(await rewriter.rewriteQuery(userQuery), store11);
  }

  it('counts the one triple once per body solution when it is off', async({ expect }) => {
    expect(await solutionsUsingRewriter([ groundHeadConstruct ], false))
      .toEqual([ 'x=ex://father', 'x=ex://father', 'x=ex://father' ]);
  });

  it('counts it once when it is on, as the mapped graph does', async({ expect }) => {
    const onMappedData = await solutionsOnMappedData();
    // Sanity: the mapped graph really does hold the one triple, whatever the body's solution count.
    expect(onMappedData).toEqual([ 'x=ex://father' ]);
    expect(await solutionsUsingRewriter([ groundHeadConstruct ], true)).toEqual(onMappedData);
  });

  it('counts it once when the head is merged behind ?m_s ?m_p ?m_o too', async({ expect }) => {
    // With a second mapping the head is the generic one, which has three variables to deduplicate over -
    // the path that worked all along, and has to keep working.
    const mappers = [ groundHeadConstruct, 'CONSTRUCT { ?s ?p ?o } WHERE { ?s ?p ?o }' ];
    expect(await solutionsUsingRewriter(mappers, true)).toEqual(await solutionsOnMappedData());
  });
});
