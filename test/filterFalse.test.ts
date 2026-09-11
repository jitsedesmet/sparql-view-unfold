import { QueryEngine } from '@comunica/query-sparql-file';
import { toAst } from '@traqula/algebra-sparql-1-2';
import type { Algebra } from '@traqula/algebra-transformations-1-2';
import * as arrayifyStreamNS from 'arrayify-stream';
import type { expect as Expect } from 'vitest';
import { describe, it } from 'vitest';
import { transformFilterFalse } from '../lib/transformations/filterFalse.js';
import { nullifyJoinOverIncompatibleBounds } from '../lib/transformations/nullifyJoinOverIncompatibleBounds.js';
import { pullUpExtends } from '../lib/transformations/pullUpExtends.js';
import { pushDownAssertions } from '../lib/transformations/pushDownAssertions.js';
import { removeProjections } from '../lib/transformations/removeProjections.js';
import { operationTransform, queryTransform } from '../lib/transformBgp.js';
import type { TransformContext } from '../lib/transformContext.js';
import { createPartialContext, parseQuery, transformContextFromConstructs } from '../lib/transformContext.js';
import { nonReificationTripleConstruct, nonTripleTermConstruct, rdfReificationConstruct } from './queryConsts.js';

// Crazy workaround to support both CJS and ESM
const arrayifyStream =
  (<any> arrayifyStreamNS).default ?? arrayifyStreamNS;

const prefixes = `PREFIX : <ex://>
`;

const engine = new QueryEngine();

/** The solutions of a query as sorted `name=value` strings. */
async function sortedBindingsOf(query: string, source: string): Promise<string[]> {
  const rows: any[] = await arrayifyStream(await engine.queryBindings(query, { sources: [ source ]}));
  return rows
    .map(row => [ ...row ].map(([ key, value ]: [any, any]) => `${key.value}=${value.value}`).sort().join('|'))
    .sort();
}

/** The variables a query's result exposes. */
async function exposedVariablesOf(query: string, source: string): Promise<string[]> {
  const result = <any> await engine.query(query, { sources: [ source ]});
  const metadata = await result.metadata();
  const variableNames: string[] = metadata.variables.map((variable: { value: string }) => variable.value);
  return variableNames.sort();
}

describe('transformFilterFalse', () => {
  // The pass only ever reads AF / DF / generator off the context, never the mapping.
  const c = <TransformContext> createPartialContext();

  /** Asserts the rewritten query, and that running the pass again changes nothing. */
  function expectTransform(expect: typeof Expect, query: string, expected: string): void {
    const transformedOnce = transformFilterFalse(c, parseQuery(c, prefixes + query));
    expect(c.generator.generate(toAst(transformedOnce)).trim()).toEqual(expected.trim());
    expect(transformFilterFalse(c, transformFilterFalse(c, parseQuery(c, prefixes + query)))).toEqual(transformedOnce);
  }

  describe('emptiness through a sub-SELECT', () => {
    it('drops a UNION branch whose BIND stands over an empty sub-SELECT', ({ expect }) => {
      expectTransform(
        expect,
        'SELECT * WHERE { { ?s ?p ?o } UNION { { SELECT ?a WHERE { ?a :p ?b FILTER(false) } } BIND(:b AS ?b) } }',
        `SELECT ?a ?b ?o ?p ?s WHERE {
  ?s ?p ?o .
}`,
      );
    });

    it('empties a JOIN over an empty sub-SELECT', ({ expect }) => {
      expectTransform(
        expect,
        'SELECT * WHERE { ?s ?p ?o { SELECT ?a WHERE { ?a :p ?b FILTER(false) } } }',
        `SELECT ?a ?o ?p ?s WHERE {
  FILTER ( FALSE )
}`,
      );
    });

    it('reduces a MINUS against an empty sub-SELECT to its left', ({ expect }) => {
      expectTransform(
        expect,
        'SELECT * WHERE { ?s ?p ?o MINUS { SELECT ?s WHERE { ?s :p ?b FILTER(false) } } }',
        `SELECT ?o ?p ?s WHERE {
  ?s ?p ?o .
}`,
      );
    });

    it('reduces an OPTIONAL empty sub-SELECT to what it is optional to', ({ expect }) => {
      expectTransform(
        expect,
        'SELECT * WHERE { ?s ?p ?o OPTIONAL { SELECT ?a WHERE { ?a :p ?b FILTER(false) } } }',
        `SELECT ?a ?o ?p ?s WHERE {
  ?s ?p ?o .
}`,
      );
    });

    // DISTINCT, REDUCED and LIMIT/OFFSET over nothing are still nothing.
    const emptyModifiedSubSelects = [
      'SELECT DISTINCT ?a WHERE { ?a :p ?b FILTER(false) }',
      'SELECT REDUCED ?a WHERE { ?a :p ?b FILTER(false) }',
      'SELECT ?a WHERE { ?a :p ?b FILTER(false) } LIMIT 10',
      'SELECT ?a WHERE { ?a :p ?b FILTER(false) } OFFSET 5',
      'SELECT DISTINCT ?a WHERE { ?a :p ?b FILTER(false) } LIMIT 10',
      'SELECT REDUCED ?a WHERE { ?a :p ?b FILTER(false) } OFFSET 5',
    ];
    for (const subSelect of emptyModifiedSubSelects) {
      it(`empties a JOIN over { ${subSelect} }`, ({ expect }) => {
        expectTransform(
          expect,
          `SELECT * WHERE { ?s ?p ?o { ${subSelect} } }`,
          `SELECT ?a ?o ?p ?s WHERE {
  FILTER ( FALSE )
}`,
        );
      });
    }
  });

  describe('a FILTER(FALSE)', () => {
    it('drops what it stands over, even where nothing above absorbs it', ({ expect }) => {
      expectTransform(
        expect,
        'SELECT (COUNT(*) AS ?n) WHERE { ?s :p ?o FILTER(false) }',
        `SELECT ( COUNT( * ) AS ?n ) WHERE {
  FILTER ( FALSE )
}`,
      );
    });
  });

  describe('the projection of an empty sub-SELECT', () => {
    it('collapses into a fresh FILTER(FALSE), without bringing its hidden variables back', ({ expect }) => {
      // The sub-SELECT hides ?b, which is what makes the BIND beside it legal.
      expectTransform(
        expect,
        'SELECT * WHERE { { SELECT ?a WHERE { ?a :p ?b FILTER(false) } } BIND(:b AS ?b) }',
        `SELECT ?a ?b WHERE {
  FILTER ( FALSE )
}`,
      );
    });

    it('leaves a GROUP over it alone, an aggregate over nothing still answering', ({ expect }) => {
      expectTransform(
        expect,
        `SELECT * WHERE { ?s ?p ?o {
  SELECT (COUNT(*) AS ?n) WHERE { { SELECT ?a WHERE { ?a :p ?b FILTER(false) } } }
} }`,
        `SELECT ?n ?o ?p ?s WHERE {
  ?s ?p ?o .
  {
    SELECT ( COUNT( * ) AS ?n ) WHERE {
      FILTER ( FALSE )
    }
  }
}`,
      );
    });
  });

  describe('the query\'s own solution modifiers', () => {
    it('keeps the projection', ({ expect }) => {
      expectTransform(
        expect,
        'SELECT ?a WHERE { ?a :p ?b FILTER(false) }',
        `SELECT ?a WHERE {
  FILTER ( FALSE )
}`,
      );
    });

    it('keeps DISTINCT and LIMIT', ({ expect }) => {
      expectTransform(
        expect,
        'SELECT DISTINCT ?a WHERE { ?a :p ?b FILTER(false) } LIMIT 10',
        `SELECT DISTINCT ?a WHERE {
  FILTER ( FALSE )
}
LIMIT 10`,
      );
    });

    it('keeps REDUCED and OFFSET', ({ expect }) => {
      expectTransform(
        expect,
        'SELECT REDUCED ?a WHERE { ?a :p ?b FILTER(false) } OFFSET 5',
        `SELECT REDUCED ?a WHERE {
  FILTER ( FALSE )
}
OFFSET 5`,
      );
    });

    it('keeps FROM', ({ expect }) => {
      expectTransform(
        expect,
        'SELECT ?a FROM <ex://g> WHERE { ?a :p ?b FILTER(false) }',
        `SELECT ?a FROM <ex://g> WHERE {
  FILTER ( FALSE )
}`,
      );
    });
  });

  describe('the answer of a rewritten query', () => {
    const source = './test/statics/multipleRdfReifiedTriples.ttl';

    // The pass-through mapping leaves every pattern as it was.
    function rewriteWithFilterFalse(query: string): string {
      const passThroughContext = transformContextFromConstructs([ nonTripleTermConstruct ]);
      return queryTransform(passThroughContext, query, [ transformFilterFalse ]);
    }

    it('exposes the same variables and rows when a SELECT * loses an empty sub-SELECT', async({ expect }) => {
      // `?a` is only in scope through the dropped branch.
      const query = `${prefixes}SELECT * WHERE { { ?s :knows ?o } UNION { SELECT ?a WHERE { ?a :p ?b FILTER(false) } } }`;
      const rewritten = rewriteWithFilterFalse(query);
      expect(rewritten).not.toContain('FILTER ( FALSE )');
      expect(await exposedVariablesOf(rewritten, source)).toEqual(await exposedVariablesOf(query, source));
      expect(await exposedVariablesOf(rewritten, source)).toContain('a');
      const originalBindings = await sortedBindingsOf(query, source);
      // Sanity: the query actually returns something, so the comparison is not two empty lists.
      expect(originalBindings.length).toBeGreaterThan(0);
      expect(await sortedBindingsOf(rewritten, source)).toEqual(originalBindings);
    });

    it('still returns the single row of an aggregate over an empty input', async({ expect }) => {
      // COUNT(*) of nothing is one row, 0.
      const query = `${prefixes}SELECT (COUNT(*) AS ?n) WHERE { ?s :knows ?o FILTER(false) }`;
      expect(await sortedBindingsOf(query, source)).toEqual([ 'n=0' ]);
      expect(await sortedBindingsOf(rewriteWithFilterFalse(query), source)).toEqual([ 'n=0' ]);
    });
  });
});

describe('transformFilterFalse over a reification mapping', () => {
  const mappers = [ rdfReificationConstruct, nonReificationTripleConstruct ];
  const source = './test/statics/bkrReifiedStatements.ttl';

  // The constant subject is what lets the pushdown prove the pass-through branch empty.
  const query = `
PREFIX bkr: <http://mor.nlm.nih.gov/bkr/>
PREFIX bkr_sn: <http://mor.nlm.nih.gov/bkr/SEMNET_>
PREFIX provenir: <http://knoesis.wright.edu/provenir/>
SELECT ?o ?source WHERE { << bkr:META_C0040300-INST bkr_sn:PART_OF ?o >> provenir:derives_from ?source . }`;

  const pushdownPipeline = <const>[
    operationTransform,
    transformFilterFalse,
    nullifyJoinOverIncompatibleBounds,
    transformFilterFalse,
    pushDownAssertions,
    transformFilterFalse,
    removeProjections,
  ];

  const pullUpPipeline = <const>[
    operationTransform,
    transformFilterFalse,
    nullifyJoinOverIncompatibleBounds,
    transformFilterFalse,
    pushDownAssertions,
    transformFilterFalse,
    pullUpExtends,
    removeProjections,
    pullUpExtends,
  ];

  function rewriteWithPipeline(
    pipeline: readonly ((c: TransformContext, op: Algebra.Operation) => Algebra.Operation)[],
  ): string {
    return queryTransform(transformContextFromConstructs(mappers), query, [ ...pipeline ]);
  }

  it('leaves no dead branch in the pushdown pipeline', ({ expect }) => {
    expect(rewriteWithPipeline(pushdownPipeline)).not.toContain('FILTER ( FALSE )');
  });

  it('leaves no dead branch in the pullUpExtends pipeline', ({ expect }) => {
    expect(rewriteWithPipeline(pullUpPipeline)).not.toContain('FILTER ( FALSE )');
  });

  describe('the rewritten query still answers', () => {
    // The query's meaning over the RDF 1.1 data, written by hand.
    const expectedOverRdf11 = `
PREFIX bkr: <http://mor.nlm.nih.gov/bkr/>
PREFIX bkr_sn: <http://mor.nlm.nih.gov/bkr/SEMNET_>
PREFIX provenir: <http://knoesis.wright.edu/provenir/>
PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
SELECT ?o ?source WHERE {
  ?t rdf:type rdf:Statement ;
     rdf:subject bkr:META_C0040300-INST ;
     rdf:predicate bkr_sn:PART_OF ;
     rdf:object ?o ;
     provenir:derives_from ?source .
}`;

    it('agrees with the mapping, run through the pushdown pipeline', async({ expect }) => {
      const expectedBindings = await sortedBindingsOf(expectedOverRdf11, source);
      // Sanity: the data actually answers, so the comparison is not two empty lists.
      expect(expectedBindings).toHaveLength(2);
      expect(await sortedBindingsOf(rewriteWithPipeline(pushdownPipeline), source)).toEqual(expectedBindings);
    });

    it('agrees with the mapping, run through the pullUpExtends pipeline', async({ expect }) => {
      expect(await sortedBindingsOf(rewriteWithPipeline(pullUpPipeline), source))
        .toEqual(await sortedBindingsOf(expectedOverRdf11, source));
    });
  });
});
