import type { Algebra } from '@traqula/algebra-transformations-1-2';
import { describe, it } from 'vitest';
import { createTransformationContext, parseQuery } from '../lib/transformContext.js';
import { withCpVars } from '../lib/utils/certainlyBoundVars.js';
import { variablesRequiredBoundBy } from '../lib/utils/unboundRejection.js';

const c = createTransformationContext();

/** The filter of `SELECT * { ?s ?p ?o FILTER(condition) }`. */
function filterOf(condition: string): Algebra.Filter {
  return <Algebra.Filter> (<Algebra.Project> parseQuery(c, `SELECT * { ?s ?p ?o FILTER(${condition}) }`)).input;
}

/** The variables a condition requires bound, sorted. */
function requiredBy(condition: string): string[] {
  return [ ...variablesRequiredBoundBy(filterOf(condition).expression) ].sort();
}

describe('variablesRequiredBoundBy', () => {
  describe('a strict operator', () => {
    it('requires every variable it reads, however deep', ({ expect }) => {
      expect(requiredBy('STRLEN(CONCAT(STR(?x), ?y)) > 2')).toEqual([ 'x', 'y' ]);
    });

    it('requires what is read through a negation, which raises on an error', ({ expect }) => {
      expect(requiredBy('!(?x = 1)')).toEqual([ 'x' ]);
    });

    it('requires nothing of an extension function, which is opaque', ({ expect }) => {
      expect(requiredBy('<ex://f>(?x)')).toEqual([]);
    });
  });

  describe('the logical connectives', () => {
    it('requires what any conjunct requires', ({ expect }) => {
      expect(requiredBy('?x > 1 && bound(?y)')).toEqual([ 'x', 'y' ]);
    });

    it('requires only what every disjunct requires, since one true side hides an error', ({ expect }) => {
      expect(requiredBy('?x > 1 || (?x < 0 && ?y = 2)')).toEqual([ 'x' ]);
    });

    it('requires nothing of a negated bound', ({ expect }) => {
      expect(requiredBy('!bound(?x)')).toEqual([]);
    });
  });

  describe('the operators that catch errors', () => {
    it('requires only the condition of an IF and what both branches require', ({ expect }) => {
      expect(requiredBy('IF(?c, ?x > 1 && ?y, ?x < 0)')).toEqual([ 'c', 'x' ]);
    });

    it('requires only what every COALESCE argument raises on', ({ expect }) => {
      expect(requiredBy('COALESCE(?x, ?y + ?x)')).toEqual([ 'x' ]);
      expect(requiredBy('COALESCE(?x, 1) = 1')).toEqual([]);
    });

    it('requires the left operand of IN, whose every comparison raises on it', ({ expect }) => {
      expect(requiredBy('?x IN (1, ?y)')).toEqual([ 'x' ]);
    });

    it('requires the left operand of NOT IN only over a non-empty list', ({ expect }) => {
      expect(requiredBy('?x NOT IN (1, ?y)')).toEqual([ 'x' ]);
      expect(requiredBy('?x NOT IN ()')).toEqual([]);
    });
  });

  it('makes a filter certify what its condition requires', ({ expect }) => {
    // The OPTIONAL alone may leave `?x` unbound, and either comparison raises where it does.
    const filter = <Algebra.Filter> (<Algebra.Project> parseQuery(
      c,
      'SELECT * { ?s ?p ?o OPTIONAL { ?s ?q ?x } FILTER(?x > 1 || ?x < 0) }',
    )).input;
    expect([ ...withCpVars(filter.input).metadata.cVars ].sort()).toEqual([ 'o', 'p', 's' ]);
    expect([ ...withCpVars(filter).metadata.cVars ].sort()).toEqual([ 'o', 'p', 's', 'x' ]);
  });
});
