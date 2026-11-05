import { toAst } from '@traqula/algebra-sparql-1-2';
import { describe, it } from 'vitest';
import { mappingFromConstructQueries } from '../lib/mapping.js';
import { createDefaultTransformationPipeline, createQueryRewriter } from '../lib/queryRewriter.js';
import { unfoldingTransformation } from '../lib/transformations/unfolding.js';
import { createTransformationContext, parseQuery } from '../lib/transformContext.js';
import { claimVariableName } from '../lib/utils.js';

/**
 * Nothing is told apart by its name: the user query keeps the names it was written with, and a mapping
 * variable is renamed only where its name is in use.
 */
describe('variable names', () => {
  /** Rewrites a query with nothing but the unfolding of the given mappings. */
  async function unfold(query: string, constructs: string[]): Promise<string> {
    return (await createQueryRewriter([ unfoldingTransformation(mappingFromConstructQueries(constructs)) ])
      .rewriteQuery(query)).trim();
  }

  /** Rewrites a query with the default pipeline over the given mappings. */
  async function rewriteWithDefaultPipeline(query: string, constructs: string[]): Promise<string> {
    return (await createQueryRewriter(createDefaultTransformationPipeline(mappingFromConstructQueries(constructs)))
      .rewriteQuery(query)).trim();
  }

  it('renames a mapping variable the user query uses, and only that one', async({ expect }) => {
    await expect(unfold('SELECT * { ?s <ex://p> ?x }', [ 'CONSTRUCT WHERE { ?s <ex://p> ?o }' ]))
      .resolves.toBe(`SELECT ?s ?x WHERE {
  SELECT ( ?mi_s AS ?s ) ( ?o AS ?x ) WHERE {
    ?mi_s <ex://p> ?o .
  }
}`);
  });

  it('renames a mapping variable apart from a user query variable already carrying the prefix', async({ expect }) => {
    await expect(unfold('SELECT * { ?s <ex://p> ?mi_s }', [ 'CONSTRUCT WHERE { ?s <ex://p> ?o }' ]))
      .resolves.toBe(`SELECT ?mi_s ?s WHERE {
  SELECT ( ?o AS ?mi_s ) ( ?mi_s0 AS ?s ) WHERE {
    ?mi_s0 <ex://p> ?o .
  }
}`);
  });

  it('renames a mapping variable apart from a mapping variable already carrying the prefix', async({ expect }) => {
    await expect(unfold('SELECT * { ?s <ex://p> ?x }', [
      'CONSTRUCT { ?s <ex://p> ?o } WHERE { ?s <ex://p> ?o . ?s <ex://q> ?mi_s }',
    ])).resolves.toBe(`SELECT ?s ?x WHERE {
  SELECT ( ?mi_s0 AS ?s ) ( ?o AS ?x ) WHERE {
    ?mi_s0 <ex://p> ?o .
    ?mi_s0 <ex://q> ?mi_s .
  }
}`);
  });

  it('takes the first free numeric suffix', ({ expect }) => {
    expect(claimVariableName('x', new Set([ 'x', 'x0' ]))).toBe('x1');
  });

  it('renames the VALUES keys of a renamed mapping variable', async({ expect }) => {
    await expect(unfold('SELECT * { ?s <ex://p> ?x }', [
      'CONSTRUCT { ?s <ex://p> ?o } WHERE { VALUES ?s { <ex://a> } ?s <ex://q> ?o }',
    ])).resolves.toBe(`SELECT ?s ?x WHERE {
  SELECT ( ?mi_s AS ?s ) ( ?o AS ?x ) WHERE {
    VALUES ?mi_s {
      <ex://a>
    }
    ?mi_s <ex://q> ?o .
  }
}`);
  });

  it('classifies a mapping variable by its side, not by its name', async({ expect }) => {
    // `?b`, `?c` and the mapping's `?z` are one group. Sorted by name alone, `?b` would be bound from `?c`,
    // a variable the mapping body does not bind.
    await expect(unfold('SELECT * { ?b <ex://p> ?c }', [ 'CONSTRUCT WHERE { ?z <ex://p> ?z }' ]))
      .resolves.toBe(`SELECT ?b ?c WHERE {
  SELECT ( ?z AS ?b ) ( ?z AS ?c ) WHERE {
    ?z <ex://p> ?z .
  }
}`);
  });

  /** Rewrites a join of two patterns, user query and mapping both naming a variable `variableName`. */
  function rewriteNaming(variableName: string): Promise<string> {
    return rewriteWithDefaultPipeline(`SELECT * { ?${variableName} <ex://p> ?x . ?x <ex://p> ?${variableName} }`, [
      `CONSTRUCT { ?s <ex://p> ?o } WHERE { ?s <ex://p> ?o . ?o <ex://q> ?${variableName} }`,
    ]);
  }

  for (const name of [ 'toString', '__proto__' ]) {
    it(`rewrites a variable named ${name} as it rewrites any other`, async({ expect }) => {
      const rewritten = await rewriteNaming(name);
      expect(rewritten).toContain(`?${name} `);
      expect(rewritten.replaceAll(name, `${name}Q`)).toBe(await rewriteNaming(`${name}Q`));
    });
  }

  it('coins the existence variable apart from the names of the user query', async({ expect }) => {
    await expect(unfold(
      'SELECT * { <ex://a> <ex://p> <ex://b> . ?mExists0 <ex://p> ?o }',
      [ 'CONSTRUCT WHERE { ?s <ex://p> ?o }' ],
    )).resolves.toContain('SELECT ?mExists1 WHERE');
  });

  it('coins the existence variable apart from the names of the mapping', async({ expect }) => {
    await expect(unfold(
      'SELECT * { <ex://a> <ex://p> <ex://b> }',
      [ 'CONSTRUCT { ?s <ex://p> ?o } WHERE { ?s <ex://p> ?o . ?o <ex://q> ?mExists0 }' ],
    )).resolves.toContain('SELECT ?mExists1 WHERE');
  });

  it('names the generic head apart from the variables of the mappings it merges', ({ expect }) => {
    const mapping = mappingFromConstructQueries([
      'CONSTRUCT WHERE { ?m_s <ex://p> ?o }',
      'CONSTRUCT WHERE { ?s <ex://q> ?o }',
    ]);
    expect([ mapping.head.subject.value, mapping.head.predicate.value, mapping.head.object.value ])
      .toEqual([ 'm_s0', 'm_p', 'm_o' ]);
  });

  describe('a name only the query form uses', () => {
    // `removeProjections` coins `?v_N` for the variables the mapping body hides; `?v_0` stays the user's.
    const hidingMapping = [ 'CONSTRUCT { ?s <ex://p> ?o } WHERE { ?s <ex://p> ?o . ?o <ex://q> ?z }' ];
    const unfoldedPattern = `  ?v_2 <ex://p> ?v_1 .
  ?v_1 <ex://q> ?v_3 .
  BIND( ?v_2 AS ?s )
  BIND( ?v_1 AS ?x )`;

    for (const [ form, query, expected ] of [
      [ 'SELECT', 'SELECT ?s ?v_0 WHERE { ?s <ex://p> ?x }', `SELECT ?s ?v_0 WHERE {\n${unfoldedPattern}\n}` ],
      [
        'CONSTRUCT',
        'CONSTRUCT { ?s <ex://r> ?v_0 } WHERE { ?s <ex://p> ?x }',
        `CONSTRUCT {\n  ?s <ex://r> ?v_0 .\n}\nWHERE {\n${unfoldedPattern}\n}`,
      ],
      [ 'DESCRIBE', 'DESCRIBE ?s ?v_0 WHERE { ?s <ex://p> ?x }', `DESCRIBE ?s ?v_0 WHERE {\n${unfoldedPattern}\n}` ],
      [
        'INSERT',
        'INSERT { ?s <ex://r> ?v_0 } WHERE { ?s <ex://p> ?x }',
        `INSERT {
  ?s <ex://r> ?v_0 .
}
WHERE {
  {
    ?v_2 <ex://p> ?v_1 .
    ?v_1 <ex://q> ?v_3 .
    BIND( ?v_2 AS ?s )
    BIND( ?v_1 AS ?x )
  }
}`,
      ],
    ]) {
      it(`is not coined for ${form}`, async({ expect }) => {
        await expect(rewriteWithDefaultPipeline(query, hidingMapping)).resolves.toBe(expected);
      });
    }

    it('is not coined through rewriteOperation either', async({ expect }) => {
      const c = createTransformationContext();
      const rewritten = await createQueryRewriter(createDefaultTransformationPipeline(
        mappingFromConstructQueries(hidingMapping),
      )).rewriteOperation(parseQuery(c, 'SELECT ?s ?v_0 WHERE { ?s <ex://p> ?x }'));
      expect(c.generator.generate(toAst(rewritten)).trim()).toBe(`SELECT ?s ?v_0 WHERE {\n${unfoldedPattern}\n}`);
    });
  });

  it('leaves the operation handed to rewriteOperation as it was', async({ expect }) => {
    const c = createTransformationContext();
    const query = 'SELECT * { ?s <ex://p> ?o }';
    const operation = parseQuery(c, query);
    await createQueryRewriter([ unfoldingTransformation(mappingFromConstructQueries([
      'CONSTRUCT WHERE { ?s <ex://p> ?o }',
    ])) ]).rewriteOperation(operation);
    expect(operation).toEqual(parseQuery(c, query));
  });
});
