import { QueryEngine } from '@comunica/query-sparql-file';
import type * as RDF from '@rdfjs/types';
import { toAst } from '@traqula/algebra-sparql-1-2';
import * as arrayifyStreamNS from 'arrayify-stream';
import { Parser, Store } from 'n3';
import { DataFactory } from 'rdf-data-factory';
import type { ExpectStatic } from 'vitest';
import { describe, it } from 'vitest';
import { mappingFromConstructQueries } from '../lib/mapping.js';
import type { QueryRewriter } from '../lib/queryRewriter.js';
import { createDefaultTransformationPipeline, createQueryRewriter } from '../lib/queryRewriter.js';
import { filterFalseTransformation } from '../lib/transformations/filterFalse.js';
import {
  nullifyJoinOverIncompatibleBoundsTransformation,
} from '../lib/transformations/nullifyJoinOverIncompatibleBounds.js';
import { nullifyUnbindableVarsTransformation } from '../lib/transformations/nullifyUnbindableVars.js';
import { pullUpExtends } from '../lib/transformations/pullUpExtends.js';
import { unfoldingTransformation } from '../lib/transformations/unfolding.js';
import { createTransformationContext, parseQuery } from '../lib/transformContext.js';
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

  /**
   * The rows of a query in the order it returns them.
   * @param query - The query to run, prefixes included
   * @param source - The data to run it over
   * @returns one string per row, in sequence
   */
  async function sequence(query: string, source: string | Store): Promise<string[]> {
    const rows: RDF.Bindings[] = await arrayifyStream(await engine.queryBindings(query, { sources: [ source ]}));
    return rows.map(row => [ ...row ].map(([ key, value ]) => `${key.value}=${value.value}`).sort().join('|'));
  }

  /**
   * The rows of a query, sorted but with duplicates kept: the multiplicity of every row is part of the answer.
   * @param query - The query to run, prefixes included
   * @param source - The data to run it over
   * @returns one string per row, sorted
   */
  async function bindings(query: string, source: string | Store): Promise<string[]> {
    return (await sequence(query, source)).sort();
  }

  const prefixes = 'PREFIX : <ex://>\n';

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
      const rewriter = createQueryRewriter([
        unfoldingTransformation(mappingFromConstructQueries([ tripleTermConstruct, nonTripleTermConstruct ])),
        filterFalseTransformation(),
        nullifyJoinOverIncompatibleBoundsTransformation(),
        nullifyUnbindableVarsTransformation(),
        filterFalseTransformation(),
      ]);
      const resUsingMapper = await sourceToStore([ store11 ], await rewriter.rewriteQuery(userQuery));

      expect(resOnMappedData.getQuads(null, null, null, null))
        .toBeRdfIsomorphic(resUsingMapper.getQuads(null, null, null, null));
    });
  });
  describe('assignment pull-up', () => {
    /**
     * The rewrites of {@link pullUpExtends} are about `cVars` and `pVars`, and a wrong one of those shows
     * up in what `SELECT *` returns rather than in the shape of the query - so these run both versions and
     * compare the answers, duplicates and all. The four operations below are the ones where a solution may
     * leave a variable unbound, which is exactly where a lost `cVars` is observable.
     */
    const pullUpData = './test/statics/assertionPushdown.ttl';
    const c = createTransformationContext();

    async function assertEquivalent(
      expect: ExpectStatic,
      query: string,
      expectedRows: number,
    ): Promise<void> {
      const evalQuery = prefixes + query;
      const rewritten = c.generator.generate(toAst(pullUpExtends(c, parseQuery(c, evalQuery)))).trim();
      const original = await bindings(evalQuery, pullUpData);
      // Result is equal
      expect(await bindings(rewritten, pullUpData)).toEqual(original);
      // And has the requested length
      expect(original).toHaveLength(expectedRows);
    }

    /**
     * Runs both versions of a query with an `ORDER BY` and compares the sequences, not the sets.
     * @param expect - The assertion API of the running test
     * @param query - The query to rewrite, without its prefixes
     * @param expected - The rows the query returns, in order
     */
    async function assertSameSequence(
      expect: ExpectStatic,
      query: string,
      expected: string[],
    ): Promise<void> {
      const evalQuery = prefixes + query;
      const rewritten = c.generator.generate(toAst(pullUpExtends(c, parseQuery(c, evalQuery)))).trim();
      const original = await sequence(evalQuery, pullUpData);
      expect(await sequence(prefixes + rewritten, pullUpData)).toEqual(original);
      expect(original).toEqual(expected);
    }

    it('orders the same when the bind rises past the ORDER BY', async({ expect }) => {
      // The rewrite here is `project(extend(orderby(…)))` - the bind *above* the ordering - which `toAst`
      // writes as a SELECT expression and a parser reads back as `project(orderby(extend(…)))`. Sound
      // because an EXTEND is element-wise and order-preserving, and the ordering does not read `?t`; this
      // is the case a string comparison cannot check, since both trees print the same.
      await assertSameSequence(expect, 'SELECT * WHERE { VALUES ?v { 3 1 2 } BIND(:tag AS ?t) } ORDER BY ASC(?v)', [
        't=ex://tag|v=1',
        't=ex://tag|v=2',
        't=ex://tag|v=3',
      ]);
    });

    it('orders the same when the comparator is the substitution', async({ expect }) => {
      // `ORDER BY ?x` becomes `ORDER BY ?v` as `?x` rises through it, so a wrong substitution would show
      // up here as a different order rather than as a different set.
      await assertSameSequence(expect, 'SELECT ?v WHERE { VALUES ?v { 3 1 2 } BIND(?v AS ?x) } ORDER BY DESC(?x)', [
        'v=3',
        'v=2',
        'v=1',
      ]);
    });

    it('keeps the value of a bind whose duplicate is deleted', async({ expect }) => {
      // Both operands compute the same `?x`, so one copy goes; the answer must not notice which.
      await assertEquivalent(expect, `SELECT * WHERE {
        { ?x :p ?y BIND(CONCAT(STR(?x), "z") AS ?c) }
        { ?x :r ?z BIND(CONCAT(STR(?x), "z") AS ?c) }
      }`, 1);
    });

    it('keeps what an OPTIONAL leaves unbound unbound', async({ expect }) => {
      await assertEquivalent(expect, `SELECT * WHERE {
        { ?x :p ?y BIND(:a AS ?b) }
        OPTIONAL { ?y :q ?z }
      }`, 1);
    });

    it('keeps a bind out of the compatibility test of a MINUS', async({ expect }) => {
      await assertEquivalent(expect, `SELECT * WHERE {
        { ?x :p ?y BIND(:a AS ?b) }
        MINUS { ?z :q ?y }
      }`, 0);
    });

    it('keeps the multiplicities of a UNION every branch of which carries the bind', async({ expect }) => {
      await assertEquivalent(expect, `SELECT * WHERE {
        { ?x :p ?y BIND(:a AS ?b) } UNION { ?x :p ?y BIND(:a AS ?b) }
      }`, 2);
    });

    it('keeps what a sub-SELECT projects when the bind rises out of it', async({ expect }) => {
      await assertEquivalent(expect, `SELECT * WHERE {
        { SELECT ?x ?b WHERE { ?x :p ?y BIND(:a AS ?b) } }
        ?x :says ?t
      }`, 1);
    });

    it('drops a bind nothing projects without changing the answer', async({ expect }) => {
      // Directly below the projection, which is as far as a drop reaches in this phase: the same bind one
      // OPTIONAL deeper needs the `needed` analysis, and stays.
      await assertEquivalent(expect, `SELECT ?x WHERE {
        ?x :p ?y
        BIND(:a AS ?b)
      }`, 1);
    });
  });

  describe('unfolding in an EXISTS', () => {
    const plainView = 'CONSTRUCT { ?s :q ?o } WHERE { ?s :p ?o }';
    const data = new Store(new Parser()
      .parse('@prefix : <ex://> . :a :p :b . :b :p :c . :c :p :d . :x :p "l" . :a :hidden true .'));

    const rewritersByView = new Map<string, { unfoldOnly: QueryRewriter; pipeline: QueryRewriter }>();

    /**
     * The rewriters over a view, unfolding alone and the default pipeline, built once per view.
     * @param view - The view, without its prefixes
     * @returns both rewriters
     */
    function rewritersOver(view: string): { unfoldOnly: QueryRewriter; pipeline: QueryRewriter } {
      let rewriters = rewritersByView.get(view);
      if (rewriters === undefined) {
        const mapping = mappingFromConstructQueries([ prefixes + view ]);
        rewriters = {
          unfoldOnly: createQueryRewriter([ unfoldingTransformation(mapping) ]),
          pipeline: createQueryRewriter(createDefaultTransformationPipeline(mapping)),
        };
        rewritersByView.set(view, rewriters);
      }
      return rewriters;
    }

    /**
     * Asserts that the unfolded query over the data, optimised or not, answers what the query answers over the view.
     * @param expect - The assertion API of the running test
     * @param query - The query, without its prefixes
     * @param expectedRows - The number of rows it returns
     * @param view - The view, without its prefixes
     */
    async function assertUnfoldsLikeView(
      expect: ExpectStatic,
      query: string,
      expectedRows: number,
      view = plainView,
    ): Promise<void> {
      const overView = await bindings(prefixes + query, await sourceToStore([ data ], prefixes + view));
      for (const rewriter of Object.values(rewritersOver(view))) {
        expect(await bindings(await rewriter.rewriteQuery(prefixes + query), data)).toEqual(overView);
      }
      expect(overView).toHaveLength(expectedRows);
    }

    it('compares a variable the solution binds to the view', async({ expect }) => {
      await assertUnfoldsLikeView(expect, 'SELECT * { ?s :q ?o FILTER EXISTS { ?o :q ?x } }', 2);
      await assertUnfoldsLikeView(expect, 'SELECT * { ?s :q ?o FILTER NOT EXISTS { ?o :q ?x } }', 2);
    });

    it('compares it in a nested EXISTS', async({ expect }) => {
      await assertUnfoldsLikeView(
        expect,
        'SELECT * { ?s :q ?o FILTER EXISTS { ?x :q ?o FILTER EXISTS { ?o :q ?y } } }',
        2,
      );
    });

    it('compares a variable the enclosing EXISTS binds in a nested EXISTS', async({ expect }) => {
      await assertUnfoldsLikeView(
        expect,
        'SELECT * { ?s :q ?o FILTER EXISTS { ?o :q ?x FILTER EXISTS { ?x :q ?y } } }',
        1,
      );
    });

    it('compares a variable only the outer solution binds in a nested EXISTS', async({ expect }) => {
      await assertUnfoldsLikeView(
        expect,
        'SELECT * { ?s :q ?o FILTER EXISTS { ?x :q ?y FILTER EXISTS { ?o :q ?x } } }',
        1,
      );
    });

    it('leaves an EXISTS in the view as it stands', async({ expect }) => {
      await assertUnfoldsLikeView(
        expect,
        'SELECT * { ?s :q ?o FILTER EXISTS { ?o :q ?x } }',
        1,
        'CONSTRUCT { ?s :q ?o } WHERE { ?s :p ?o FILTER NOT EXISTS { ?s :hidden true } }',
      );
      await assertUnfoldsLikeView(
        expect,
        'SELECT * { ?s :p ?o FILTER EXISTS { ?o :p ?x } }',
        2,
        'CONSTRUCT { ?s :p ?o } WHERE { ?s :p ?o FILTER NOT EXISTS { ?o :p ?s } }',
      );
    });

    it('leaves an EXISTS in a SERVICE as it stands', async({ expect }) => {
      const rewritten = await rewritersOver(plainView).unfoldOnly.rewriteQuery(
        `${prefixes}SELECT * { SERVICE <http://e/> { ?s :q ?o FILTER EXISTS { ?o :q ?x } } }`,
      );
      expect(rewritten).not.toContain('ex://p');
    });

    it('matches a variable the solution leaves unbound to anything', async({ expect }) => {
      await assertUnfoldsLikeView(expect, 'SELECT * { ?s :q ?o OPTIONAL { ?o :q ?z } FILTER EXISTS { ?z :q ?x } }', 3);
      await assertUnfoldsLikeView(expect, 'SELECT * { VALUES ?z { :b UNDEF } FILTER EXISTS { ?z :q ?x } }', 2);
      await assertUnfoldsLikeView(
        expect,
        'SELECT * { ?s :q ?o BIND(IF(isLiteral(?o), ?nothing, ?o) AS ?z) FILTER EXISTS { ?z :q ?x } }',
        3,
      );
    });

    it('compares a variable the solution binds in an EXISTS a BIND evaluates', async({ expect }) => {
      await assertUnfoldsLikeView(expect, 'SELECT * { ?s :q ?o BIND(EXISTS { ?o :q ?x } AS ?hasNext) }', 4);
    });

    it('binds a variable a GROUP drops from the solution of an EXISTS in its HAVING', async({ expect }) => {
      // Not compared to the view: Comunica substitutes ?o into that EXISTS too, where SPARQL 1.2 leaves it free.
      const query =
        'SELECT * { ?s :q ?o FILTER EXISTS { SELECT ?y { ?y :q ?x } GROUP BY ?y HAVING EXISTS { ?o :q ?y } } }';
      const rewritten = await rewritersOver(plainView).unfoldOnly.rewriteQuery(prefixes + query);
      const havingPattern = rewritten.slice(rewritten.lastIndexOf('EXISTS'));
      expect(havingPattern).toMatch(/BIND\( \?\w+ AS \?o \)/u);
    });

    it('asserts rather than binds a variable the solution certainly binds', async({ expect }) => {
      const rewritten = await rewritersOver(plainView).unfoldOnly
        .rewriteQuery(`${prefixes}SELECT * { ?s :q ?o FILTER EXISTS { ?o :q ?x } }`);
      const pattern = rewritten.slice(rewritten.indexOf('EXISTS'));
      expect(pattern).not.toMatch(/BIND\( \?\w+ AS \?o \)/u);
      expect(pattern).toMatch(/SAMETERM\( \?\w+ , \?o \)/u);
    });
  });
});
