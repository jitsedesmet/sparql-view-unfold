import { toAst } from '@traqula/algebra-sparql-1-2';
import { beforeAll, describe, it } from 'vitest';
import { transformContextFromConstructs, parseQuery } from '../lib/transformContext.js';
import { simplifyStaticExpressions } from '../lib/utils/staticExpressionEvaluation.js';
import { nonTripleTermConstruct } from './queryConsts.js';

describe('simplifyStaticExpressions', () => {
  const c = transformContextFromConstructs([ nonTripleTermConstruct ]);

  async function simplify(query: string): Promise<string> {
    const operation = parseQuery(c, query);
    const folded = await simplifyStaticExpressions(c, operation);
    return c.generator.generate(toAst(folded));
  }

  // The Comunica evaluator factory is built once, lazily, on the first evaluation; warming it up here keeps
  // that one-time cost out of the individual tests' timeouts.
  beforeAll(async() => {
    await simplify('SELECT * WHERE { ?s ?p ?o . BIND(1 + 2 AS ?x) }');
  }, 60_000);

  it('folds a static arithmetic expression in a BIND', async({ expect }) => {
    const out = await simplify('SELECT * WHERE { ?s ?p ?o . BIND(1 + 2 AS ?x) }');
    expect(out).toContain('3');
    expect(out).not.toContain('+');
  });

  it('folds a static function call to its value', async({ expect }) => {
    const out = await simplify('SELECT * WHERE { ?s ?p ?o . BIND(CONCAT("a", "b") AS ?x) }');
    expect(out.toLowerCase()).not.toContain('concat');
    expect(out).toContain('ab');
  });

  it('folds a fully static FILTER to a boolean', async({ expect }) => {
    const out = await simplify('SELECT * WHERE { ?s ?p ?o . FILTER(STRLEN("abc") > 1) }');
    expect(out.toLowerCase()).not.toContain('strlen');
  });

  it('leaves a non-static expression untouched', async({ expect }) => {
    const out = await simplify('SELECT * WHERE { ?s ?p ?o . FILTER(STRLEN(?s) > 1) }');
    expect(out.toLowerCase()).toContain('strlen');
  });

  it('leaves a raising expression standing rather than folding it', async({ expect }) => {
    // `1 / 0` raises, and an error is not `false` in every context, so it must survive.
    const out = await simplify('SELECT * WHERE { ?s ?p ?o . BIND(1 / 0 AS ?x) }');
    expect(out).toContain('/');
  });

  it('does not fold a non-deterministic operator', async({ expect }) => {
    const out = await simplify('SELECT * WHERE { ?s ?p ?o . BIND(UUID() AS ?x) }');
    expect(out.toLowerCase()).toContain('uuid');
  });

  it('does not fold NOW(), whose value is only known at execution time', async({ expect }) => {
    const out = await simplify('SELECT * WHERE { ?s ?p ?o . BIND(NOW() AS ?x) }');
    expect(out.toLowerCase()).toContain('now');
  });
});
