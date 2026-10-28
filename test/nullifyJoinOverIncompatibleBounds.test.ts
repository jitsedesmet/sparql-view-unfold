import type { Algebra } from '@traqula/algebra-transformations-1-2';
import { describe, it } from 'vitest';
import { createQueryRewriter } from '../lib/queryRewriter.js';
import {
  nullifyJoinOverIncompatibleBounds,
  nullifyJoinOverIncompatibleBoundsTransformation,
} from '../lib/transformations/nullifyJoinOverIncompatibleBounds.js';
import { createTransformationContext } from '../lib/transformContext.js';

describe('nullifyJoinOverIncompatibleBounds', () => {
  const c = createTransformationContext();

  it('leaves a join of no operands as it stands', ({ expect }) => {
    // A join of no operands is the join identity, as an empty BGP is.
    expect(nullifyJoinOverIncompatibleBounds(c, c.AF.createJoin([]))).toEqual(c.AF.createJoin([]));
  });

  it('leaves a join over a union of no operands as it stands', ({ expect }) => {
    const join = (): Algebra.Join => c.AF.createJoin([ c.AF.createUnion([]), c.AF.createBgp([]) ], false);
    expect(nullifyJoinOverIncompatibleBounds(c, join())).toEqual(join());
  });

  describe('a triple term over variables', () => {
    const rewriter = createQueryRewriter([ nullifyJoinOverIncompatibleBoundsTransformation() ]);

    /**
     * Joins a bind of a ground triple term with a bind of a triple term over variables.
     * @param pattern - The triple term over variables
     * @returns the query
     */
    function joinWith(pattern: string): string {
      return `SELECT * WHERE {
  {
    BIND( <<( <ex://me> <ex://name> "jitse" )>> AS ?claim )
  }
  {
    ?s <ex://name> ?n .
    BIND( ${pattern} AS ?claim )
  }
}`;
    }

    it('keeps the bind of a triple term the ground one matches', async({ expect }) => {
      const query = joinWith('<<( ?s <ex://name> ?n )>>');
      expect((await rewriter.rewriteQuery(query)).trim()).toBe(query.replace('SELECT *', 'SELECT ?claim ?n ?s'));
    });

    it('nullifies the bind of a triple term the ground one cannot match', async({ expect }) => {
      expect(await rewriter.rewriteQuery(joinWith('<<( ?s <ex://age> ?n )>>'))).toContain('FILTER ( FALSE )');
    });

    it('keeps the bind of a triple term that can fail, leaving its variable unbound', async({ expect }) => {
      // `?a` is unbound where the OPTIONAL does not match, and `?n` may be a literal in a subject position.
      for (const pattern of [ '<<( ?s <ex://age> ?a )>>', '<<( ?n <ex://age> ?s )>>' ]) {
        expect(await rewriter.rewriteQuery(joinWith(pattern).replace('?s <ex://name> ?n .', `?s <ex://name> ?n .
    OPTIONAL { ?s <ex://age> ?a }`))).not.toContain('FALSE');
      }
    });
  });
});
