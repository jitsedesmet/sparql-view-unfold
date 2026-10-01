import { QueryEngine } from '@comunica/query-sparql-file';
import { toAst } from '@traqula/algebra-sparql-1-2';
import * as arrayifyStreamNS from 'arrayify-stream';
import type { expect as Expect } from 'vitest';
import { describe, it } from 'vitest';
import { rewriteNonRecursivePaths } from '../lib/transformations/pathTransformation.js';
import { createTransformationContext, parseQuery } from '../lib/transformContext.js';

// Crazy workaround to support both CJS and ESM
const arrayifyStream =
  (<any> arrayifyStreamNS).default ?? arrayifyStreamNS;

const prefixes = `PREFIX : <ex://>
`;

describe('rewriteNonRecursivePaths', () => {
  const c = createTransformationContext();
  const engine = new QueryEngine();

  function transform(query: string): string {
    const transformed = rewriteNonRecursivePaths(c, parseQuery(c, prefixes + query));
    return c.generator.generate(toAst(transformed)).trim();
  }

  async function bindings(query: string): Promise<string[]> {
    const stream = await engine.queryBindings(query, {
      sources: [ './test/statics/negatedPropertySet.ttl' ],
    });
    const rows: any[] = await arrayifyStream(stream);
    // Sorted, but duplicates kept: the multiplicity of every row is part of the answer.
    return rows
      .map(row => [ ...row ].map(([ k, v ]: [any, any]) => `${k.value}=${v.value}`).sort().join('|'))
      .sort();
  }

  /**
   * Evaluates the rewritten query against the expected rows, written down from the specification: the
   * evaluation of a negated property set is a *set* of solutions over its end points. Comunica's own
   * evaluation of the path is not the oracle here, since it yields a solution once per matching predicate.
   */
  async function assertRows(expect: typeof Expect, query: string, expected: string[]): Promise<void> {
    expect(await bindings(transform(query))).toEqual(expected.sort());
  }

  describe('a negated property set', () => {
    it('is a DISTINCT projection onto the end points', ({ expect }) => {
      // The predicate variable is coined from a module wide counter, so its number depends on test order.
      expect(transform('SELECT * { ?s !:r ?o }').replaceAll(/rewrite_\d+/gu, 'rewrite')).toEqual(`SELECT ?o ?s WHERE {
  SELECT DISTINCT ?s ?o WHERE {
    ?s ?rewrite ?o .
    FILTER ( ( ?rewrite NOT IN ( <ex://r> ) ) )
  }
}`);
    });

    it('does not expose the predicate it matched, nor repeat a pair per predicate', async({ expect }) => {
      await assertRows(expect, 'SELECT * { ?s !:r ?o }', [
        'o=ex://a2|s=ex://z',
        'o=ex://a|s=ex://z',
        'o=ex://b|s=ex://a',
        'o=ex://b|s=ex://a2',
      ]);
    });

    it('yields an end point pair once, however many predicates link it', async({ expect }) => {
      await assertRows(expect, 'SELECT ?s ?o { ?s !(:r|:s) ?o }', [
        'o=ex://b|s=ex://a',
        'o=ex://b|s=ex://a2',
      ]);
    });

    it('yields a single solution when both end points are bound', async({ expect }) => {
      await assertRows(expect, 'SELECT ?s { :a !:r :b }', [ '' ]);
    });

    it('yields nothing when two bound end points are linked by a negated predicate only', async({ expect }) => {
      await assertRows(expect, 'SELECT ?s { :a !:r :c }', []);
    });

    it('keeps the multiplicity of the sequence it is part of', async({ expect }) => {
      await assertRows(expect, 'SELECT ?o { :z :s/!:r ?o }', [ 'o=ex://b', 'o=ex://b' ]);
    });

    it('applies the same set semantics to an inverse member', async({ expect }) => {
      await assertRows(expect, 'SELECT ?s ?o { ?o !^:r ?s }', [
        'o=ex://a2|s=ex://z',
        'o=ex://a|s=ex://z',
        'o=ex://b|s=ex://a',
        'o=ex://b|s=ex://a2',
      ]);
    });
  });
});
