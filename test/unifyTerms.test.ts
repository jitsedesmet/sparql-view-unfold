import type * as RDF from '@rdfjs/types';
import { termToString } from 'rdf-string';
import { describe, it } from 'vitest';
import { unifyTerms } from '../lib/utils/assertions.js';
import { DF } from '../lib/utils/rdfDatatypes.js';

const a = DF.variable('a');
const b = DF.variable('b');
const c = DF.variable('c');
const d = DF.variable('d');
const q = DF.namedNode('ex://q');
const s = DF.namedNode('ex://s');

/**
 * Writes a unification out.
 * @param left - The one term
 * @param right - The other term
 * @returns the unified term and the substitution, or `none`
 */
function unified(left: RDF.Term, right: RDF.Term): string {
  const unification = unifyTerms(left, right);
  if (unification === undefined) {
    return 'none';
  }
  const unifier = [ ...unification.unifier ].map(([ name, term ]) => `${name}=${termToString(term)}`).sort();
  return `${termToString(unification.unified)} {${unifier.join(' ')}}`;
}

describe('unifyTerms', () => {
  it.for<[string, RDF.Term, RDF.Term, string]>([
    [ 'two variables', a, b, '?a {b=?a}' ],
    [ 'a variable and a term', a, s, 'ex://s {a=ex://s}' ],
    [ 'two equal terms', s, s, 'ex://s {}' ],
    [ 'two different terms', s, q, 'none' ],
    [ 'a variable and a triple pattern', a, DF.quad(b, q, c), '<<?b ex://q ?c>> {a=<<?b ex://q ?c>>}' ],
    [ 'a triple term and a triple pattern', DF.quad(s, q, s), DF.quad(a, q, b), '<<ex://s ex://q ex://s>> {a=ex://s b=ex://s}' ],
    [ 'two triple patterns', DF.quad(a, q, b), DF.quad(c, q, d), '<<?a ex://q ?b>> {c=?a d=?b}' ],
    [ 'a variable and a nested triple pattern holding it', DF.quad(a, q, DF.quad(b, q, c)), DF.quad(d, q, b), 'none' ],
    [ 'a nested triple pattern and an IRI', DF.quad(a, q, DF.quad(b, q, c)), DF.quad(d, q, s), 'none' ],
    [ 'a triple pattern and a nested one', DF.quad(a, q, d), DF.quad(b, q, DF.quad(b, q, c)), '<<?a ex://q <<?a ex://q ?c>>>> {b=?a d=<<?a ex://q ?c>>}' ],
    [ 'a triple term into a subject', DF.quad(a, q, DF.quad(b, q, c)), DF.quad(d, q, a), 'none' ],
    [ 'a variable and a triple pattern holding it', a, DF.quad(a, q, b), 'none' ],
    [ 'a literal into a subject', DF.quad(a, q, DF.literal('x')), DF.quad(b, q, a), 'none' ],
    [ 'a predicate into a subject and object', DF.quad(a, a, b), DF.quad(s, c, c), '<<ex://s ex://s ex://s>> {a=ex://s b=ex://s c=ex://s}' ],
  ])('unifies %s', ([ , left, right, expected ], { expect }) => {
    expect(unified(left, right)).toBe(expected);
  });
});
