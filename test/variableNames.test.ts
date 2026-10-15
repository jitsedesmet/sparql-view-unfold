import { describe, it } from 'vitest';
import { mappingFromConstructQueries } from '../lib/mapping.js';
import { createQueryRewriter } from '../lib/queryRewriter.js';
import { unfoldingTransformation } from '../lib/transformations/unfolding.js';
import { createTransformationContext, parseQuery } from '../lib/transformContext.js';

/**
 * Nothing is told apart by its name: the user query keeps the names it was written with, and a mapping
 * variable is renamed only where the user query takes its name.
 */
describe('variable names', () => {
  /** Rewrites a query with nothing but the unfolding of the given mappings. */
  async function unfold(query: string, constructs: string[]): Promise<string> {
    return (await createQueryRewriter([ unfoldingTransformation(mappingFromConstructQueries(constructs)) ])
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

  it('classifies a mapping variable by its side, not by a name looking like the user query\'s', async({ expect }) => {
    // The mapping's `?a` is unified with the user's `?b`: had it been read as a user query variable, the
    // pattern would bind `?b` from a variable the mapping body does not project.
    await expect(unfold('SELECT * { ?b <ex://p> ?c }', [ 'CONSTRUCT WHERE { ?a <ex://p> ?c }' ]))
      .resolves.toBe(`SELECT ?b ?c WHERE {
  SELECT ( ?a AS ?b ) ( ?mi_c AS ?c ) WHERE {
    ?a <ex://p> ?mi_c .
  }
}`);
  });

  it('coins the existence variable apart from the names of the user query', async({ expect }) => {
    await expect(unfold(
      'SELECT * { <ex://a> <ex://p> <ex://b> . ?mExists0 <ex://p> ?o }',
      [ 'CONSTRUCT WHERE { ?s <ex://p> ?o }' ],
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
