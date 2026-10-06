import { describe, it } from 'vitest';
import { toAst } from '../lib/generator/toAst.js';
import { createTransformationContext, parseQuery } from '../lib/transformContext.js';

const c = createTransformationContext();

/** The query printed from its own algebra. */
function roundTrip(query: string): string {
  return c.generator.generate(toAst(parseQuery(c, query)));
}

describe('toAst', () => {
  it.for([
    [ 'an OPTIONAL that is not the first operand', 'SELECT * { ?s :p ?o { ?s :r ?m OPTIONAL { ?m :q ?o } } }' ],
    [ 'a MINUS that is not the first operand', 'SELECT * { ?s :p ?o { ?s :r ?m MINUS { ?m :q ?o } } }' ],
    [
      'an OPTIONAL leading a JOIN that is not the first operand',
      'SELECT * { ?s :p ?o { { ?s :r ?m OPTIONAL { ?m :q ?o } } ?m :t ?z } }',
    ],
    [ 'an OPTIONAL that is the first operand', 'SELECT * { { ?s :r ?m OPTIONAL { ?m :q ?o } } ?s :p ?o }' ],
  ])('keeps the scope of %s', ([ , query ], { expect }) => {
    const prefixed = `PREFIX : <ex://> ${query}`;
    expect(parseQuery(c, roundTrip(prefixed))).toEqual(parseQuery(c, prefixed));
  });
});
