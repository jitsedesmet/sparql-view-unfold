import { toAst } from '@traqula/algebra-sparql-1-2';
import { describe, it } from 'vitest';
import { createTransformationContext, parseQuery } from '../lib/transformContext.js';

describe('the generator', () => {
  it('escapes a string literal so the query parses back to the same value', ({ expect }) => {
    const c = createTransformationContext();
    const query = String.raw`SELECT * WHERE { ?s ?p "a \"quote\", a \\ backslash\nand a newline" }`;
    const generated = c.generator.generate(toAst(parseQuery(c, query)));

    expect(parseQuery(c, generated)).toEqual(parseQuery(c, query));
  });
});
