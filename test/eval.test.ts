import { QueryEngine } from '@comunica/query-sparql-file';
import type * as RDF from '@rdfjs/types';
import type { Algebra } from '@traqula/algebra-transformations-1-2';
import { algebraUtils, Algebra as AlgebraValues } from '@traqula/algebra-transformations-1-2';
import * as arrayifyStreamNS from 'arrayify-stream';
import { Store } from 'n3';
import { DataFactory } from 'rdf-data-factory';
import type { ExpectStatic } from 'vitest';
import { describe, it } from 'vitest';
import { toAst } from '../lib/generator/toAst.js';
import { mappingFromConstructQueries } from '../lib/mapping.js';
import { createDefaultTransformationPipeline, createQueryRewriter } from '../lib/queryRewriter.js';
import { filterFalseTransformation } from '../lib/transformations/filterFalse.js';
import {
  nullifyJoinOverIncompatibleBoundsTransformation,
} from '../lib/transformations/nullifyJoinOverIncompatibleBounds.js';
import { nullifyUnbindableVarsTransformation } from '../lib/transformations/nullifyUnbindableVars.js';
import { projectionPushdown, projectionPushdownTransformation } from '../lib/transformations/projectionPushdown.js';
import { pullUpExtends } from '../lib/transformations/pullUpExtends.js';
import { unfoldingTransformation } from '../lib/transformations/unfolding.js';
import { createTransformationContext, parseQuery } from '../lib/transformContext.js';
import type { EnclosingQuery, QueryTransformation } from '../lib/types.js';
import { withCpVars, withoutCpVars } from '../lib/utils/certainlyBoundVars.js';
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
  /** The prefix of the queries run over `assertionPushdown.ttl`. */
  const exampleNamespacePrefix = 'PREFIX : <ex://>\n';
  const c = createTransformationContext();

  /**
   * The solutions of a query, one string each.
   * @param query - The query to run, prefixes included
   * @param sources - What to run it over
   * @returns the rows sorted, but with duplicates kept: the multiplicity of every row is part of the answer
   */
  async function bindings(
    query: string,
    sources: NonNullable<Parameters<typeof engine.queryBindings>[1]>['sources'] =
    [ './test/statics/assertionPushdown.ttl' ],
  ): Promise<string[]> {
    const rows: RDF.Bindings[] = await arrayifyStream(await engine.queryBindings(query, { sources }));
    return rows
      .map(row => [ ...row ].map(([ key, value ]) => `${key.value}=${value.value}`).sort().join('|'))
      .sort();
  }

  /**
   * Asserts that a pass leaves the answer of a query over `assertionPushdown.ttl` as it was, duplicates and
   * all.
   * @param expect - The assertion API of the running test
   * @param rewrite - The pass, applied to the whole parsed query
   * @param query - The query to rewrite, without its prefixes
   * @param expectedRows - How many rows the query answers, so that no case passes by answering nothing
   */
  async function assertRewriteKeepsAnswer(
    expect: ExpectStatic,
    rewrite: (operation: Algebra.Operation) => Algebra.Operation,
    query: string,
    expectedRows: number,
  ): Promise<void> {
    const evalQuery = exampleNamespacePrefix + query;
    const rewritten = c.generator.generate(toAst(rewrite(parseQuery(c, evalQuery)))).trim();
    const original = await bindings(evalQuery);
    expect(await bindings(rewritten)).toEqual(original);
    expect(original).toHaveLength(expectedRows);
  }

  describe('assignment pull-up', () => {
    /**
     * The rewrites of {@link pullUpExtends} are about `cVars` and `pVars`, and a wrong one of those shows
     * up in what `SELECT *` returns rather than in the shape of the query - so these run both versions and
     * compare the answers, duplicates and all. The four operations below are the ones where a solution may
     * leave a variable unbound, which is exactly where a lost `cVars` is observable.
     */
    async function assertEquivalent(expect: ExpectStatic, query: string, expectedRows: number): Promise<void> {
      await assertRewriteKeepsAnswer(expect, operation => pullUpExtends(c, operation), query, expectedRows);
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
      const evalQuery = exampleNamespacePrefix + query;
      const rewritten = c.generator.generate(toAst(pullUpExtends(c, parseQuery(c, evalQuery)))).trim();
      const original = await sequence(evalQuery);
      expect(await sequence(exampleNamespacePrefix + rewritten)).toEqual(original);
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

  describe('projection pushdown', () => {
    /**
     * A rename changes which variable a value travels in below the bind, and a drop what is in scope there,
     * so as for the pull-up these run both versions and compare the answers, duplicates and all. The cases
     * that *keep* a bind are the ones where the wrong rewrite would answer differently, which is what makes
     * them worth running rather than only printing.
     */
    async function assertEquivalent(expect: ExpectStatic, query: string, expectedRows: number): Promise<void> {
      await assertRewriteKeepsAnswer(expect, operation => projectionPushdown(c, operation), query, expectedRows);
    }

    it('joins UNION groups on the variable the copies write', async({ expect }) => {
      await assertEquivalent(expect, `SELECT ?s ?o WHERE {
        { { ?v1 :p ?v2 BIND(?v1 AS ?v0) } UNION { ?v3 :q ?v4 BIND(?v4 AS ?v0) } BIND(?v0 AS ?s) }
        { ?v5 :step ?v6 BIND(?v5 AS ?s) BIND(?v6 AS ?o) }
      }`, 2);
    });

    it('leaves what an OPTIONAL leaves unbound unbound', async({ expect }) => {
      await assertEquivalent(expect, `SELECT ?x ?w WHERE {
        { ?x :p ?y } UNION { ?x :step ?y }
        OPTIONAL { ?y :onwards ?z }
        BIND(?z AS ?w)
      }`, 5);
    });

    it('renames into an OPTIONAL whose condition reads a join key', async({ expect }) => {
      // The bind stands outside the OPTIONAL because Comunica cannot evaluate one inside it next to a
      // condition reading `?x` - none of its join actors takes that OPTIONAL. Renamed away, it can.
      await assertEquivalent(expect, `SELECT ?x ?w WHERE {
        ?x :step ?y
        OPTIONAL { ?y :onwards ?z FILTER(?x != :a) }
        BIND(?z AS ?w)
      }`, 4);
    });

    it('keeps the compatibility test of a MINUS', async({ expect }) => {
      await assertEquivalent(expect, `SELECT ?x ?y WHERE {
        { ?x :p ?y } UNION { ?x :step ?y }
        MINUS { ?z :q ?v BIND(?v AS ?y) }
      }`, 4);
    });

    it('keeps the value an aggregate reads', async({ expect }) => {
      await assertEquivalent(expect, `SELECT ?x (COUNT(?w) AS ?n) WHERE {
        ?x :step ?y BIND(?y AS ?w)
      } GROUP BY ?x`, 2);
    });

    it('keeps the multiplicities a COUNT(*) counts when it drops the binds below it', async({ expect }) => {
      await assertEquivalent(expect, `SELECT ?x (COUNT(*) AS ?n) WHERE {
        ?x :step ?y BIND(:c AS ?k) BIND(RAND() AS ?r)
      } GROUP BY ?x`, 2);
    });

    it('keeps the window of a sub-SELECT it strikes a variable from', async({ expect }) => {
      await assertEquivalent(expect, `SELECT ?z WHERE {
        { SELECT ?x ?w WHERE { ?x :step ?y BIND(?y AS ?w) } ORDER BY DESC(?y) LIMIT 1 }
        ?x :p ?z
      }`, 1);
    });

    it('renames the keys of a VALUES with UNDEF', async({ expect }) => {
      await assertEquivalent(expect, `SELECT ?w ?x WHERE {
        VALUES (?v ?x) { (:a UNDEF) (UNDEF :b) (:c :d) }
        BIND(?v AS ?w)
      }`, 3);
    });

    it('keeps a source only an EXISTS above reads', async({ expect }) => {
      // Renamed away, `?y` would be unbound in the EXISTS and match every node: four rows instead of two.
      await assertEquivalent(expect, `SELECT ?x ?w WHERE {
        { ?x :step ?y BIND(?y AS ?w) }
        FILTER(EXISTS { ?y :onwards :end })
      }`, 2);
    });

    it('keeps the scope of a MINUS a deleted bind was the braces of', async({ expect }) => {
      // Without the bind the operand is a bare `Minus(∅, R)`, which a printer that flattens JOIN operands
      // would move into the outer group, where it removes the one solution too.
      await assertEquivalent(expect, 'SELECT ?x WHERE { ?x :p ?y { MINUS { ?x :p ?y } BIND(:c AS ?k) } }', 1);
    });

    it('keeps the scope of an OPTIONAL a deleted bind was the braces of', async({ expect }) => {
      await assertEquivalent(expect, `SELECT ?x ?z WHERE {
        { ?x :step ?y } UNION { ?x :p ?y }
        { OPTIONAL { ?y :onwards ?z } BIND(1 AS ?k) }
      }`, 4);
    });

    it('does not capture a target a `!bound` below reads', async({ expect }) => {
      // Renamed, the filter would see `?w` bound and answer nothing.
      await assertEquivalent(expect, `SELECT ?x ?w WHERE {
        { ?x :step ?y FILTER(!BOUND(?w)) }
        BIND(?y AS ?w)
      }`, 4);
    });

    it('does not capture a target an EXISTS below mentions', async({ expect }) => {
      // Renamed, the EXISTS would read `?w` bound and keep two of the four rows.
      await assertEquivalent(expect, `SELECT ?x ?w WHERE {
        { ?x :step ?y FILTER(EXISTS { ?w :onwards :end }) }
        BIND(?y AS ?w)
      }`, 4);
    });
  });

  describe('projection pushdown at the end of the default pipeline', () => {
    /**
     * The same checks over queries the rewriting produced rather than ones written by hand: the answer, the
     * scope of the query, that the pass never adds a bind, that it is idempotent, and that it creates no
     * work for the pull-up - the binds that pass left were blocked by its own licences, not by these.
     */
    const rdfPrefixes = `PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
PREFIX : <ex://>
`;
    const mapping = mappingFromConstructQueries([ tripleTermConstruct, nonTripleTermConstruct ]);
    // `projectionPushdown` is the last step of the default pipeline; see the first case for the check.
    const pipelineBeforePass = createDefaultTransformationPipeline(mapping).slice(0, -1);
    const queries = [
      'SELECT * WHERE { ?t rdf:reifies <<( ?s ?p ?o )>> }',
      'SELECT ?s ?o WHERE { ?t rdf:reifies <<( ?s :knows ?o )>> ; :statedBy ?who }',
      'SELECT ?who WHERE { ?t rdf:reifies <<( :alice :knows ?o )>> ; :statedBy ?who }',
      'SELECT DISTINCT ?s WHERE { ?t rdf:reifies <<( ?s ?p ?o )>> }',
      'SELECT ?s (COUNT(?o) AS ?n) WHERE { ?t rdf:reifies <<( ?s :knows ?o )>> } GROUP BY ?s',
      'SELECT ?s ?c WHERE { ?t rdf:reifies <<( ?s ?p ?o )>> OPTIONAL { ?t :confidence ?c } }',
      'SELECT ?s WHERE { ?s :knows ?o MINUS { ?t rdf:reifies <<( ?s :knows ?o )>> ; :statedBy :wikipedia } }',
      'SELECT ?s ?o WHERE { ?t rdf:reifies <<( ?s :knows ?o )>> } ORDER BY ?o LIMIT 2',
      'SELECT ?x WHERE { { ?t rdf:reifies <<( ?x :knows ?o )>> } UNION { ?x :age ?a } }',
    ];

    /** What the runner hands the last step of a pipeline. */
    interface InputOfPass {
      queryPart: Algebra.Operation;
      enclosingQuery: EnclosingQuery;
    }

    /**
     * Runs the pipeline up to the pass, capturing what the runner would hand it.
     * @param query - The user query, without its prefixes
     * @returns the query part and its enclosing query, as the last step receives them
     */
    async function inputOfPass(query: string): Promise<InputOfPass> {
      let captured: InputOfPass | undefined;
      const capture: QueryTransformation = (_context, operation, enclosingQuery) => {
        captured = { queryPart: operation, enclosingQuery: enclosingQuery ?? {}};
        return operation;
      };
      await createQueryRewriter([ ...pipelineBeforePass, capture ]).rewriteQuery(rdfPrefixes + query);
      if (captured === undefined) {
        throw new Error('The pipeline never reached its last step');
      }
      return captured;
    }

    /** How many EXTENDs a tree holds, those inside an EXISTS included. */
    function bindCountOf(op: Algebra.Operation): number {
      let count = 0;
      algebraUtils.visitOperation(op, { [AlgebraValues.Types.EXTEND]: { visitor: () => {
        count += 1;
      } }});
      return count;
    }

    /** What an operation puts in scope: the variables every solution binds, and what `SELECT *` expands to. */
    function scopeOf(op: Algebra.Operation): { cVars: string[]; pVars: string[] } {
      const { cVars, vRanges } = withCpVars(withoutCpVars(op)).metadata;
      return { cVars: [ ...cVars ].sort(), pVars: [ ...vRanges.keys() ].sort() };
    }

    it.for(queries)('ends the default pipeline, rewriting %s', async(query, { expect }) => {
      const rewriterWithPass = createQueryRewriter([ ...pipelineBeforePass, projectionPushdownTransformation() ]);
      const defaultRewriter = createQueryRewriter(createDefaultTransformationPipeline(mapping));
      expect(await rewriterWithPass.rewriteQuery(rdfPrefixes + query))
        .toEqual(await defaultRewriter.rewriteQuery(rdfPrefixes + query));
    });

    it.for(queries)('keeps the answer and the scope of %s', async(query, { expect }) => {
      const store11 = new Store(<RDF.Quad[]> await arrayifyStream(await engine.queryQuads(
        'CONSTRUCT WHERE { ?s ?p ?o }',
        { sources: [ './test/statics/multipleRdfReifiedTriples.ttl' ]},
      )));
      const withoutPass = createQueryRewriter(pipelineBeforePass);
      const withPass = createQueryRewriter([ ...pipelineBeforePass, projectionPushdownTransformation() ]);
      const answer = await bindings(await withoutPass.rewriteQuery(rdfPrefixes + query), [ store11 ]);
      expect(answer.length).toBeGreaterThan(0);
      expect(await bindings(await withPass.rewriteQuery(rdfPrefixes + query), [ store11 ])).toEqual(answer);
      const parsed = parseQuery(c, rdfPrefixes + query);
      expect(scopeOf(await withPass.rewriteOperation(parsed)))
        .toEqual(scopeOf(await withoutPass.rewriteOperation(parsed)));
    });

    it.for(queries)('adds no bind to %s, is idempotent, and makes no work for the pull-up', async(
      query,
      { expect },
    ) => {
      const { queryPart, enclosingQuery } = await inputOfPass(query);
      const output = projectionPushdown(c, queryPart, enclosingQuery.demandedVariables);
      expect(bindCountOf(output)).toBeLessThanOrEqual(bindCountOf(queryPart));
      const printed = (op: Algebra.Operation): string => JSON.stringify(withoutCpVars(op));
      expect(printed(projectionPushdown(c, output, enclosingQuery.demandedVariables))).toEqual(printed(output));
      // An implication rather than an equality: the pull-up may have work left *before* this pass, since
      // `removeProjections` runs after it and uncovers binds the projections it removes were hiding.
      const pullUpIsDone = (op: Algebra.Operation): boolean => printed(pullUpExtends(c, op)) === printed(op);
      expect(pullUpIsDone(output) || !pullUpIsDone(queryPart)).toBe(true);
    });
  });
});
