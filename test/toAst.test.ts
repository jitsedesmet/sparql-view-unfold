import { describe, it } from 'vitest';
import { toAst } from '../lib/generator/toAst.js';
import { createTransformationContext, parseQuery } from '../lib/transformContext.js';

/**
 * The patched `translateJoin`: an OPTIONAL or a MINUS reads everything before it in its group, so a JOIN
 * operand after the first holding one has to be printed as a group of its own. Every case round-trips a
 * query the parser reads as exactly that JOIN.
 */
describe('toAst', () => {
  const c = createTransformationContext();

  function roundTrip(query: string): string {
    return c.generator.generate(toAst(parseQuery(c, `PREFIX : <ex://>\n${query}`))).trim();
  }

  it('keeps a MINUS after the first operand of a JOIN in a group of its own', ({ expect }) => {
    // Flattened, the MINUS would remove the solutions of `?x :p ?y` too, and answer nothing.
    expect(roundTrip('SELECT ?x WHERE { ?x :p ?y { MINUS { ?x :p ?y } } }')).toEqual(`SELECT ?x WHERE {
  ?x <ex://p> ?y .
  {
    MINUS {
      ?x <ex://p> ?y .
    }
  }
}`);
  });

  it('keeps an OPTIONAL after the first operand of a JOIN in a group of its own', ({ expect }) => {
    expect(roundTrip('SELECT ?x ?z WHERE { ?x :p ?y { ?a :q ?b OPTIONAL { ?y :r ?z } } }'))
      .toEqual(`SELECT ?x ?z WHERE {
  ?x <ex://p> ?y .
  {
    ?a <ex://q> ?b .
    OPTIONAL {
      ?y <ex://r> ?z .
    }
  }
}`);
  });

  it('flattens an OPTIONAL that is the first operand, which reads only what it did', ({ expect }) => {
    expect(roundTrip('SELECT ?a ?z ?x WHERE { ?a :q ?b OPTIONAL { ?y :r ?z } ?x :p ?y }'))
      .toEqual(`SELECT ?a ?z ?x WHERE {
  ?a <ex://q> ?b .
  OPTIONAL {
    ?y <ex://r> ?z .
  }
  ?x <ex://p> ?y .
}`);
  });

  it('groups an OPTIONAL that a nested JOIN would flatten into a later operand', ({ expect }) => {
    expect(roundTrip('SELECT ?x ?e ?g WHERE { ?x :p ?y { { ?c :q ?d OPTIONAL { ?d :r ?e } } ?f :s ?g } }'))
      .toEqual(`SELECT ?x ?e ?g WHERE {
  ?x <ex://p> ?y .
  {
    ?c <ex://q> ?d .
    OPTIONAL {
      ?d <ex://r> ?e .
    }
  }
  ?f <ex://s> ?g .
}`);
  });
});
