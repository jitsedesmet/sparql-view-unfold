import { QueryEngine } from '@comunica/query-sparql-file';
import type * as RDF from '@rdfjs/types';
import { toAst } from '@traqula/algebra-sparql-1-2';
import * as arrayifyStreamNS from 'arrayify-stream';
import { Parser, Store } from 'n3';
import { DataFactory } from 'rdf-data-factory';
import { termToString } from 'rdf-string';
import type { ExpectStatic } from 'vitest';
import { describe, it } from 'vitest';
import { mappingFromConstructQueries } from '../lib/mapping.js';
import { createQueryRewriter } from '../lib/queryRewriter.js';
import { filterFalseTransformation } from '../lib/transformations/filterFalse.js';
import {
  nullifyJoinOverIncompatibleBoundsTransformation,
} from '../lib/transformations/nullifyJoinOverIncompatibleBounds.js';
import { nullifyUnbindableVarsTransformation } from '../lib/transformations/nullifyUnbindableVars.js';
import { rewriteNonRecursivePathsTransformation } from '../lib/transformations/pathTransformation.js';
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
   * Evaluates a query.
   * @param query - The query to evaluate
   * @param sources - The sources to evaluate it over
   * @returns one string per row, sorted, but duplicates kept: the multiplicity of every row is part of the answer
   */
  async function bindings(
    query: string,
    sources: NonNullable<Parameters<typeof engine.queryBindings>[1]>['sources'] = [
      './test/statics/assertionPushdown.ttl',
    ],
  ): Promise<string[]> {
    const rows: RDF.Bindings[] = await arrayifyStream(await engine.queryBindings(query, { sources }));
    return rows
      .map(row => [ ...row ].map(([ key, value ]) => `${key.value}=${termToString(value)}`).sort().join('|'))
      .sort();
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
    const pullUpPrefixes = 'PREFIX : <ex://>\n';
    const c = createTransformationContext();

    async function assertEquivalent(
      expect: ExpectStatic,
      query: string,
      expectedRows: number,
    ): Promise<void> {
      const evalQuery = pullUpPrefixes + query;
      const rewritten = c.generator.generate(toAst(pullUpExtends(c, parseQuery(c, evalQuery)))).trim();
      const original = await bindings(evalQuery);
      // Result is equal
      expect(await bindings(rewritten)).toEqual(original);
      // And has the requested length
      expect(original).toHaveLength(expectedRows);
    }

    /**
     * The rows of a query in the order it returns them, which {@link bindings} deliberately throws away.
     * @param query - The query to run, prefixes included
     * @returns one string per row, in sequence
     */
    async function sequence(query: string): Promise<string[]> {
      const rows: RDF.Bindings[] = await arrayifyStream(
        await engine.queryBindings(query, { sources: [ './test/statics/assertionPushdown.ttl' ]}),
      );
      return rows.map(row => [ ...row ].map(([ key, value ]) => `${key.value}=${value.value}`).sort().join('|'));
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
      const evalQuery = pullUpPrefixes + query;
      const rewritten = c.generator.generate(toAst(pullUpExtends(c, parseQuery(c, evalQuery)))).trim();
      const original = await sequence(evalQuery);
      expect(await sequence(pullUpPrefixes + rewritten)).toEqual(original);
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

  // The spec defines the zero length match for term and variable endpoints only; a triple pattern is unified.
  describe('a zero or one path with a triple pattern endpoint', () => {
    const tripleTermStore = new Store(new Parser().parse(`
      <ex://s> <ex://p> <<( <ex://a> <ex://q> <ex://b> )>> .
      <ex://n> <ex://r> <<( <ex://c> <ex://q> <ex://d> )>> .
    `));
    const rewriter = createQueryRewriter([ rewriteNonRecursivePathsTransformation() ]);

    /**
     * Evaluates a query with its paths expanded.
     * @param query - The query to expand and evaluate
     * @returns one string per row, sorted
     */
    async function expandedBindings(query: string): Promise<string[]> {
      return bindings(await rewriter.rewriteQuery(query), [ tripleTermStore ]);
    }

    it('binds the variable to every triple term node the pattern matches', async({ expect }) => {
      await expect(expandedBindings('SELECT ?x ?a ?b { ?x <ex://p>? <<( ?a <ex://q> ?b )>> }')).resolves.toEqual([
        'a=ex://a|b=ex://b|x=<<ex://a ex://q ex://b>>',
        'a=ex://a|b=ex://b|x=ex://s',
        'a=ex://c|b=ex://d|x=<<ex://c ex://q ex://d>>',
      ]);
    });

    it('binds the pattern to a ground triple term without asking for it in the data', async({ expect }) => {
      await expect(expandedBindings('SELECT * { <<( <ex://e> <ex://q> <ex://f> )>> <ex://p>? <<( ?a <ex://q> ?b )>> }'))
        .resolves.toEqual([ 'a=ex://e|b=ex://f' ]);
    });

    it('equates the variables of two triple pattern endpoints', async({ expect }) => {
      await expect(expandedBindings('SELECT * { <<( ?a <ex://q> ?b )>> <ex://p>? <<( ?c <ex://q> ?d )>> }'))
        .resolves.toEqual([
          'a=ex://a|b=ex://b|c=ex://a|d=ex://b',
          'a=ex://c|b=ex://d|c=ex://c|d=ex://d',
        ]);
    });

    it('has no zero length match when unification puts a literal in subject position', async({ expect }) => {
      await expect(expandedBindings('SELECT * { <<( ?a <ex://q> "x" )>> <ex://p>? <<( ?b <ex://q> ?a )>> }'))
        .resolves.toEqual([]);
    });

    it('has no zero length match when the pattern holds the variable', async({ expect }) => {
      await expect(expandedBindings('SELECT * { ?a <ex://p>? <<( ?a <ex://q> ?b )>> }')).resolves.toEqual([]);
    });
  });
});
