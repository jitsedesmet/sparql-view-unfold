import { describe, it } from 'vitest';
import { createQueryRewriter } from '../lib/queryRewriter.js';
import { extendsToValuesTransformation } from '../lib/transformations/extendsToValues.js';

describe('extendsToValues', () => {
  const rewriter = createQueryRewriter([ extendsToValuesTransformation() ]);

  it('turns a bind of a ground triple term over a VALUES into a column', async({ expect }) => {
    expect((await rewriter.rewriteQuery(
      'SELECT * { VALUES ?s { <ex://me> } BIND(<<( <ex://me> <ex://name> "jitse" )>> AS ?claim) }',
    )).trim()).toBe(`SELECT ?claim ?s WHERE {
  VALUES( ?s ?claim ){
    ( <ex://me> <<( <ex://me> <ex://name> "jitse" )>> )
  }
}`);
  });

  it('keeps the bind of a triple term over variables, which no VALUES row can hold', async({ expect }) => {
    expect((await rewriter.rewriteQuery(
      'SELECT * { VALUES ?s { <ex://me> } BIND(<<( ?s <ex://name> "jitse" )>> AS ?claim) }',
    )).trim()).toBe(`SELECT ( <<( ?s <ex://name> "jitse" )>> AS ?claim ) ?s WHERE {
  VALUES ?s {
    <ex://me>
  }
}`);
  });
});
