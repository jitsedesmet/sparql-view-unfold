import type { Algebra } from '@traqula/algebra-transformations-1-2';
import type { expect as Expect } from 'vitest';
import { describe, it } from 'vitest';
import { toAst } from '../lib/generator/toAst.js';
import { createQueryRewriter } from '../lib/queryRewriter.js';
import { projectionPushdown, projectionPushdownTransformation } from '../lib/transformations/projectionPushdown.js';
import { createTransformationContext, parseQuery } from '../lib/transformContext.js';
import { withCpVars, withoutCpVars } from '../lib/utils/certainlyBoundVars.js';
import { peelExtends } from '../lib/utils/extendChain.js';

const prefixes = `PREFIX : <ex://>
`;

describe('projectionPushdown', () => {
  // The pass only uses AF / DF / astTransformer from the context, never the mapping, so a mapping-less
  // context is sufficient here - as it is for the two passes before it.
  const c = createTransformationContext();

  /** What an operation puts in scope: the variables every solution binds, and what `SELECT *` expands to. */
  function scopeOf(op: Algebra.Operation): { cVars: string[]; pVars: string[] } {
    const { cVars, vRanges } = withCpVars(withoutCpVars(op)).metadata;
    return { cVars: [ ...cVars ].sort(), pVars: [ ...vRanges.keys() ].sort() };
  }

  /** Whether any operation of a tree still carries a cached `CPMeta`. */
  function holdsCachedMetadata(op: Algebra.Operation): boolean {
    let found = false;
    c.astTransformer.visitObject(op, (object) => {
      if ('type' in object && 'metadata' in object) {
        found = true;
      }
      return object;
    });
    return found;
  }

  /**
   * Asserts the rewritten query, and with it the three checks every case owes: the scope of the query is
   * what it was, the pass is idempotent, and it leaves no metadata behind.
   * @param expect - The assertion API of the running test
   * @param query - The query to rewrite, without its prefixes
   * @param expected - The query the rewrite has to generate
   */
  function expectTransform(expect: typeof Expect, query: string, expected: string): void {
    const output = projectionPushdown(c, parseQuery(c, prefixes + query));
    expect(c.generator.generate(toAst(output)).trim()).toEqual(expected.trim());
    // Below the root nothing keeps its scope - a renamed source leaves it, which is the point - but at the
    // root every variable is demanded, so the query answers with the same variables it did.
    expect(scopeOf(output)).toEqual(scopeOf(parseQuery(c, prefixes + query)));
    expect(holdsCachedMetadata(output)).toBe(false);
    expect(c.generator.generate(toAst(projectionPushdown(c, output))).trim()).toEqual(expected.trim());
  }

  /** The variables bound by the EXTEND chain at the top of an operation, in evaluation order. */
  function bindsAtTopOf(op: Algebra.Operation): string[] {
    return peelExtends(c, op).binds.map(bind => bind.variable.value);
  }

  /** The pattern of a query, without the projection the parser puts over it. */
  function patternOf(query: string): Algebra.Operation {
    return (<Algebra.Project> parseQuery(c, prefixes + query)).input;
  }

  describe('dead binds', () => {
    it('drops a bind of a constant nothing reads', ({ expect }) => {
      expectTransform(expect, 'SELECT ?s WHERE { ?s :p ?o BIND(:c AS ?x) }', `SELECT ?s WHERE {
  ?s <ex://p> ?o .
}`);
    });

    it('drops a bind nothing reads whatever it computes', ({ expect }) => {
      // `Extend` is one solution in, one out, so there is no stability gate on a drop.
      expectTransform(expect, 'SELECT ?s WHERE { ?s :p ?o BIND(RAND() AS ?r) }', `SELECT ?s WHERE {
  ?s <ex://p> ?o .
}`);
    });

    it('keeps a bind of a constant something reads', ({ expect }) => {
      expectTransform(expect, 'SELECT ?s ?x WHERE { ?s :p ?o BIND(:c AS ?x) }', `SELECT ?s ( <ex://c> AS ?x ) WHERE {
  ?s <ex://p> ?o .
}`);
    });

    it('drops what the right-hand side of a MINUS binds beyond its join keys', ({ expect }) => {
      expectTransform(expect, 'SELECT ?s WHERE { ?s :p ?o MINUS { ?s :q ?w BIND(?w AS ?v) } }', `SELECT ?s WHERE {
  ?s <ex://p> ?o .
  MINUS {
    ?s <ex://q> ?w .
  }
}`);
    });
  });

  describe('renames', () => {
    it('writes the target of a copy into the pattern binding its source', ({ expect }) => {
      expectTransform(expect, 'SELECT ?s WHERE { ?v :p ?o BIND(?v AS ?s) }', `SELECT ?s WHERE {
  ?s <ex://p> ?o .
}`);
    });

    it('turns UNION groups joined through copies into patterns sharing the join key', ({ expect }) => {
      // The shape the rewriting leaves behind: every branch copies into the group's variable, and every
      // group copies that into the user variable the groups join on.
      expectTransform(expect, `SELECT ?s ?o WHERE {
  { { ?v7 :w ?v8 BIND(?v7 AS ?v6) } UNION { ?v10 :h ?v9 BIND(?v9 AS ?v6) } BIND(?v6 AS ?s) }
  { ?v15 :w ?v16 BIND(?v16 AS ?o) BIND(?v15 AS ?s) }
}`, `SELECT ?s ?o WHERE {
  {
    ?s <ex://w> ?v8 .
  }
  UNION {
    ?v10 <ex://h> ?s .
  }
  ?s <ex://w> ?o .
}`);
    });

    it('collapses a chain of copies onto the outermost name', ({ expect }) => {
      expectTransform(expect, 'SELECT ?s WHERE { ?a :p ?o BIND(?a AS ?b) BIND(?b AS ?s) }', `SELECT ?s WHERE {
  ?s <ex://p> ?o .
}`);
    });

    it('renames a source into one of two targets, the other copying that', ({ expect }) => {
      // The outer copy renames first; the inner one then reads a demanded variable, and stays.
      expectTransform(
        expect,
        'SELECT ?y1 ?y2 WHERE { ?s :p ?a BIND(?a AS ?y1) BIND(?a AS ?y2) }',
        `SELECT ( ?y2 AS ?y1 ) ?y2 WHERE {
  ?s <ex://p> ?y2 .
}`,
      );
    });

    it('renames a source an OPTIONAL may leave unbound', ({ expect }) => {
      // `BIND(?o AS ?w)` leaves `?w` unbound exactly where `?o` is, so the rename keeps that too.
      expectTransform(
        expect,
        'SELECT ?s ?w WHERE { ?s :p ?x OPTIONAL { ?x :q ?o } BIND(?o AS ?w) }',
        `SELECT ?s ?w WHERE {
  ?s <ex://p> ?x .
  OPTIONAL {
    ?x <ex://q> ?w .
  }
}`,
      );
    });

    it('renames the keys of a VALUES, UNDEF included', ({ expect }) => {
      expectTransform(
        expect,
        'SELECT ?y ?z WHERE { VALUES (?x ?z) { (:a UNDEF) (UNDEF :b) } BIND(?x AS ?y) }',
        `SELECT ?y ?z WHERE {
  VALUES( ?y ?z ){
    ( <ex://a> UNDEF )
    ( UNDEF <ex://b> )
  }
}`,
      );
    });

    it('renames into a sub-SELECT, its projection included', ({ expect }) => {
      expectTransform(expect, 'SELECT ?y WHERE { { SELECT ?x WHERE { ?s :p ?x } } BIND(?x AS ?y) }', `SELECT ?y WHERE {
  SELECT ?y WHERE {
    ?s <ex://p> ?y .
  }
}`);
    });

    it('renames into an EXISTS pattern below the copy', ({ expect }) => {
      expectTransform(
        expect,
        'SELECT ?y WHERE { { ?s :p ?x FILTER(EXISTS { ?x :q ?o }) } BIND(?x AS ?y) }',
        `SELECT ?y WHERE {
  ?s <ex://p> ?y .
  FILTER ( EXISTS {
    ?y <ex://q> ?o .
  }
  )
}`,
      );
    });

    it('renames into a SERVICE, but rewrites nothing inside it', ({ expect }) => {
      // The dead bind in the service stays: what the endpoint evaluates is not the pass's to prune.
      expectTransform(
        expect,
        'SELECT ?y WHERE { SERVICE <ex://e> { ?s :p ?x BIND(:c AS ?unread) } BIND(?x AS ?y) }',
        `SELECT ?y WHERE {
  SERVICE <ex://e> {
    {
      ?s <ex://p> ?y .
      BIND( <ex://c> AS ?unread )
    }
  }
}`,
      );
    });

    it('renames per UNION branch, a branch that binds the target outright included', ({ expect }) => {
      expectTransform(
        expect,
        'SELECT ?s ?y WHERE { { ?s :p ?x BIND(?x AS ?y) } UNION { ?s :q ?y } }',
        `SELECT ?s ?y WHERE {
  {
    ?s <ex://p> ?y .
  }
  UNION {
    ?s <ex://q> ?y .
  }
}`,
      );
    });
  });

  describe('what keeps a copy', () => {
    it('keeps a copy whose source is read too', ({ expect }) => {
      expectTransform(expect, 'SELECT ?x ?y WHERE { ?s :p ?x BIND(?x AS ?y) }', `SELECT ?x ( ?x AS ?y ) WHERE {
  ?s <ex://p> ?x .
}`);
    });

    it('keeps a copy whose target a `!bound` below it reads', ({ expect }) => {
      // `?y` never binds below the copy, but it is *read* there: renaming `?x` to it would make the filter
      // see `?x`'s value, and reject every solution it now accepts.
      expectTransform(
        expect,
        'SELECT ?y WHERE { { ?s :p ?x FILTER(!BOUND(?y)) } BIND(?x AS ?y) }',
        `SELECT ( ?x AS ?y ) WHERE {
  ?s <ex://p> ?x .
  FILTER ( ! BOUND( ?y ) )
}`,
      );
    });

    it('keeps a copy whose target an EXISTS below it mentions', ({ expect }) => {
      expectTransform(
        expect,
        'SELECT ?y WHERE { { ?s :p ?x FILTER(EXISTS { ?y :q ?o }) } BIND(?x AS ?y) }',
        `SELECT ( ?x AS ?y ) WHERE {
  ?s <ex://p> ?x .
  FILTER ( EXISTS {
    ?y <ex://q> ?o .
  }
  )
}`,
      );
    });

    it('keeps a copy whose source a FILTER above reads', ({ expect }) => {
      expectTransform(expect, 'SELECT ?y WHERE { ?s :p ?x BIND(?x AS ?y) FILTER(?x != :a) }', `SELECT ?y WHERE {
  {
    ?s <ex://p> ?x .
    BIND( ?x AS ?y )
  }
  FILTER ( ( ?x != <ex://a> ) )
}`);
    });

    it('keeps a copy whose source only an EXISTS above reads', ({ expect }) => {
      expectTransform(
        expect,
        'SELECT ?y WHERE { ?s :p ?x BIND(?x AS ?y) FILTER(EXISTS { ?x :q ?o }) }',
        `SELECT ?y WHERE {
  {
    ?s <ex://p> ?x .
    BIND( ?x AS ?y )
  }
  FILTER ( EXISTS {
    ?x <ex://q> ?o .
  }
  )
}`,
      );
    });

    it('keeps a copy whose target is a join key, whatever the join key is named', ({ expect }) => {
      // A column named after a member of `Object.prototype` once made the VALUES look certainly bound to
      // nothing, so that no operand could bind `?k` and the join on it was deleted with the bind.
      expectTransform(
        expect,
        'SELECT ?s ?z WHERE { { VALUES ?valueOf { UNDEF } ?s :step ?valueOf BIND(?valueOf AS ?k) } ?k :onwards ?z }',
        `SELECT ?s ?z WHERE {
  VALUES ?k {
    UNDEF
  }
  ?s <ex://step> ?k .
  ?k <ex://onwards> ?z .
}`,
      );
    });

    it('keeps a copy whose source is a join key', ({ expect }) => {
      expectTransform(expect, 'SELECT ?y WHERE { { ?s :p ?x BIND(?x AS ?y) } ?x :q ?o }', `SELECT ?y WHERE {
  {
    ?s <ex://p> ?x .
    BIND( ?x AS ?y )
  }
  ?x <ex://q> ?o .
}`);
    });

    it('keeps a copy whose source the condition of an OPTIONAL reads', ({ expect }) => {
      expectTransform(
        expect,
        'SELECT ?s ?w WHERE { ?s :p ?x OPTIONAL { ?x :q ?o BIND(?o AS ?w) FILTER(?o != :a) } }',
        `SELECT ?s ?w WHERE {
  ?s <ex://p> ?x .
  OPTIONAL {
    {
      ?x <ex://q> ?o .
      BIND( ?o AS ?w )
    }
    FILTER ( ( ?o != <ex://a> ) )
  }
}`,
      );
    });

    it('keeps a copy below a DISTINCT that stands over no projection', ({ expect }) => {
      // A deduplication compares whole solutions, so it demands every variable in scope below it. Only a
      // pass builds this shape - SPARQL writes a DISTINCT over its projection - so it is checked on the
      // algebra, which `toAst` cannot print.
      const pattern = patternOf('SELECT * WHERE { ?s :p ?x BIND(?x AS ?y) }');
      expect(bindsAtTopOf(projectionPushdown(c, pattern, new Set([ 'y' ])))).toEqual([]);
      const output = projectionPushdown(c, c.AF.createDistinct(pattern), new Set([ 'y' ]));
      expect(bindsAtTopOf(output.input)).toEqual([ 'y' ]);
    });
  });

  describe('groupings and sub-SELECTs', () => {
    it('renames a source an aggregate reads', ({ expect }) => {
      expectTransform(
        expect,
        'SELECT ?s (COUNT(?w) AS ?n) WHERE { ?s :p ?x BIND(?x AS ?w) } GROUP BY ?s',
        `SELECT ?s ( COUNT( ?w ) AS ?n ) WHERE {
  ?s <ex://p> ?w .
}
GROUP BY ?s`,
      );
    });

    it('keeps everything below a COUNT(DISTINCT *)', ({ expect }) => {
      // An unstable column tells solutions apart, so deleting it would change the count.
      expectTransform(
        expect,
        'SELECT (COUNT(DISTINCT *) AS ?n) WHERE { ?s :p ?x BIND(RAND() AS ?r) }',
        `SELECT ( COUNT( DISTINCT * ) AS ?n ) WHERE {
  ?s <ex://p> ?x .
  BIND( RAND( ) AS ?r )
}`,
      );
    });

    it('keeps the select expressions of a grouped sub-SELECT nothing reads from', ({ expect }) => {
      // `toAst` prints an aggregate only through the bind reading it, and prints a keyless grouping only
      // through an aggregate: dropping the dead `?n` would lose the single row this sub-SELECT is.
      expectTransform(
        expect,
        'SELECT ?k WHERE { { SELECT (COUNT(*) AS ?n) WHERE { ?a :p ?b } } ?k :q ?z }',
        `SELECT ?k WHERE {
  {
    SELECT ( COUNT( * ) AS ?n ) WHERE {
      ?a <ex://p> ?b .
    }
  }
  ?k <ex://q> ?z .
}`,
      );
    });

    it('keeps listing the aggregates of a grouped sub-SELECT', ({ expect }) => {
      expectTransform(
        expect,
        'SELECT ?k WHERE { { SELECT ?k (COUNT(*) AS ?n) WHERE { ?k :p ?b } GROUP BY ?k } ?k :q ?z }',
        `SELECT ?k WHERE {
  {
    SELECT ?k ( COUNT( * ) AS ?n ) WHERE {
      ?k <ex://p> ?b .
    }
    GROUP BY ?k
  }
  ?k <ex://q> ?z .
}`,
      );
    });

    it('strikes what nothing reads from the projection of a sub-SELECT', ({ expect }) => {
      expectTransform(
        expect,
        'SELECT ?z WHERE { { SELECT ?a ?b WHERE { ?a :p ?v . BIND(?v AS ?b) } LIMIT 3 } ?a :q ?z }',
        `SELECT ?z WHERE {
  {
    SELECT ?a WHERE {
      ?a <ex://p> ?v .
    }
    LIMIT 3
  }
  ?a <ex://q> ?z .
}`,
      );
    });

    it('keeps an ORDER BY reading the source', ({ expect }) => {
      expectTransform(expect, 'SELECT ?y WHERE { ?s :p ?x BIND(?x AS ?y) } ORDER BY ?x', `SELECT ( ?x AS ?y ) WHERE {
  ?s <ex://p> ?x .
}
ORDER BY ASC ( ?x )`);
    });
  });

  describe('the demand it is handed', () => {
    const bare = 'SELECT * WHERE { ?v :p ?o BIND(?v AS ?s) BIND(:c AS ?x) }';

    it('renames at the top of a bare pattern when told what is read of it', ({ expect }) => {
      const output = projectionPushdown(c, patternOf(bare), new Set([ 's' ]));
      expect(c.generator.generate(toAst(c.AF.createProject(output, [ c.DF.variable('s') ]))).trim())
        .toEqual(`SELECT ?s WHERE {
  ?s <ex://p> ?o .
}`);
    });

    it('demands everything in scope of a bare pattern when told nothing', ({ expect }) => {
      const pattern = patternOf(bare);
      const variables = [ 'o', 's', 'v', 'x' ].map(name => c.DF.variable(name));
      expect(c.generator.generate(toAst(c.AF.createProject(projectionPushdown(c, pattern), variables))))
        .toEqual(c.generator.generate(toAst(c.AF.createProject(pattern, variables))));
    });
  });

  describe('through the pipeline runner', () => {
    const rewriter = createQueryRewriter([ projectionPushdownTransformation() ]);

    it('demands the projection of a SELECT', async({ expect }) => {
      expect((await rewriter.rewriteQuery(`${prefixes}SELECT ?s WHERE { ?v :p ?o BIND(?v AS ?s) BIND(:c AS ?x) }`))
        .trim()).toEqual(`SELECT ( ?uq_s AS ?s ) WHERE {
  ?uq_s <ex://p> ?uq_o .
}`);
    });

    it('demands nothing of an ASK', async({ expect }) => {
      expect((await rewriter.rewriteQuery(`${prefixes}ASK { ?s :p ?x BIND(?x AS ?y) }`)).trim())
        .toEqual(`ASK WHERE {
  ?uq_s <ex://p> ?uq_x .
}`);
    });

    it('demands the template of a CONSTRUCT', async({ expect }) => {
      expect((await rewriter.rewriteQuery(
        `${prefixes}CONSTRUCT { ?s :q ?y } WHERE { ?s :p ?x BIND(?x AS ?y) BIND(:c AS ?z) }`,
      )).trim()).toEqual(`CONSTRUCT {
  ?uq_s <ex://q> ?uq_y .
}
WHERE {
  ?uq_s <ex://p> ?uq_y .
}`);
    });

    it('demands the described variables of a DESCRIBE', async({ expect }) => {
      expect((await rewriter.rewriteQuery(`${prefixes}DESCRIBE ?y WHERE { ?s :p ?x BIND(?x AS ?y) }`)).trim())
        .toEqual(`DESCRIBE ?uq_y WHERE {
  ?uq_s <ex://p> ?uq_y .
}`);
    });

    it('demands the templates of an update', async({ expect }) => {
      expect((await rewriter.rewriteQuery(
        `${prefixes}DELETE { ?s :q ?y } INSERT { ?s :r ?w } WHERE { ?s :p ?x BIND(?x AS ?y) BIND(:c AS ?z) }`,
      )).trim()).toEqual(`DELETE {
  ?uq_s <ex://q> ?uq_y .
}
INSERT {
  ?uq_s <ex://r> ?uq_w .
}
WHERE {
  ?uq_s <ex://p> ?uq_y .
}`);
    });

    it('leaves the aggregate of a SELECT where the projection rebuilding needs it', async({ expect }) => {
      const query = `${prefixes}SELECT (COUNT(?x) AS ?c) WHERE { ?s :p ?x }`;
      expect(await rewriter.rewriteQuery(query)).toEqual(await createQueryRewriter([]).rewriteQuery(query));
    });
  });
});
