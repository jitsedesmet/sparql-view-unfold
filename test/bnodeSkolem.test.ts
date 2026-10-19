import { QueryEngine } from '@comunica/query-sparql-file';
import type * as RDF from '@rdfjs/types';
import { describe, it } from 'vitest';
import { DT_INTERNAL_BNODE } from '../lib/consts.js';
import { mappingFromConstructQueries } from '../lib/mapping.js';
import type { QueryRewriter } from '../lib/queryRewriter.js';
import { createDefaultTransformationPipeline, createQueryRewriter } from '../lib/queryRewriter.js';
import {
  internalBnodeAsSpecialIriTransformation,
  internalBnodeAsSpecialLiteral,
  internalBnodeAsSpecialLiteralTransformation,
} from '../lib/transformations/bnodeMapAsLiteral.js';
import { simplifyStaticExpressionsTransformation } from '../lib/transformations/staticExpressionEvaluation.js';
import { createTransformationContext } from '../lib/transformContext.js';

const engine = new QueryEngine();

// The data holds `<a> <p1> <o1>` and two triples differing from it in one position.
const tripleTermData = './test/statics/tripleTermArguments.ttl';

// Every solution of the rewritten query over the source.
async function solutions(rewriter: QueryRewriter, query: string, source: string): Promise<RDF.Bindings[]> {
  const bindings = await engine.queryBindings(await rewriter.rewriteQuery(query), { sources: [ source ]});
  return bindings.toArray();
}

// The value of `?node` in every solution of the rewritten query.
async function constructedNodes(
  rewriter: QueryRewriter,
  query: string,
  source: string,
): Promise<(string | undefined)[]> {
  return (await solutions(rewriter, query, source)).map(binding => binding.get('node')?.value);
}

// A rewriter unfolding the CONSTRUCT and materialising its blank nodes as prefixed IRIs.
function skolemisingRewriter(construct: string): QueryRewriter {
  return createQueryRewriter([
    ...createDefaultTransformationPipeline(mappingFromConstructQueries([ construct ])),
    internalBnodeAsSpecialIriTransformation(),
  ]);
}

describe('bnode skolem', () => {
  const c = createTransformationContext();
  const iriRewriter = createQueryRewriter([ internalBnodeAsSpecialIriTransformation() ]);
  const AF = c.AF;
  const DF = c.DF;

  it('skolem to literal no params', async({ expect }) => {
    const bnodeNoParams = AF.createNamedExpression(DF.namedNode('internal://blank'), []);
    expect(internalBnodeAsSpecialLiteral(c, bnodeNoParams))
      .toEqual(AF.createOperatorExpression('strdt', [
        AF.createOperatorExpression('struuid', []),
        AF.createTermExpression(DF.namedNode(DT_INTERNAL_BNODE)),
      ]));
  });

  // The join on `?node` keeps a solution only when both patterns constructed the same node.
  it.for([ '?s, ?p, ?o', '<<( ?s ?p ?o )>>', 'STR(?o), ?p, ?s' ])(
    'constructs the same node from %s in every pattern it is unfolded into',
    async(args, { expect }) => {
      const rewriter = skolemisingRewriter(`CONSTRUCT { ?node <ex://subject> ?s . ?node <ex://object> ?o } WHERE {
        ?s ?p ?o .
        BIND(<internal://blank>(${args}) AS ?node)
      }`);
      await expect(constructedNodes(
        rewriter,
        'SELECT ?node WHERE { ?node <ex://subject> ?s . ?node <ex://object> ?o }',
        tripleTermData,
      )).resolves.toEqual([ expect.any(String), expect.any(String), expect.any(String) ]);
    },
  );

  // `?o + 1` errors on every solution, and constructing `<<( ?o ?p ?s )>>` fails where `?o` is a literal.
  it.for([
    'STR(?o)',
    '?o + 1',
    'TRIPLE(?s, ?p, ?o)',
    '<<( ?o ?p ?s )>>',
    '<internal://blank>(?o)',
    'EXISTS { FILTER(ISBLANK(?node)) }',
  ])(
    'constructs the same node for the argument %s as for a variable bound to it',
    async(argument, { expect }) => {
      const nodes = await solutions(iriRewriter, `SELECT * {
        ?s ?p ?o .
        BIND(<internal://blank>(?s) AS ?node)
        BIND(${argument} AS ?bound)
        BIND(<internal://blank>(?bound) AS ?fromVariable)
        BIND(<internal://blank>(${argument}) AS ?fromExpression)
      }`, tripleTermData);
      expect(nodes).toHaveLength(3);
      for (const binding of nodes) {
        expect(binding.get('fromExpression')).toBeDefined();
        expect(binding.get('fromExpression')?.value).toBe(binding.get('fromVariable')?.value);
      }
    },
  );

  it.for(<const> [
    [ 'a typed literal', internalBnodeAsSpecialLiteralTransformation() ],
    [ 'a prefixed IRI', internalBnodeAsSpecialIriTransformation() ],
  ])('recognises a node materialised as %s as a blank node', async([ , transformation ], { expect }) => {
    const rewriter = createQueryRewriter([ transformation ]);
    await expect(constructedNodes(
      rewriter,
      'SELECT ?node WHERE { ?s ?p ?o . BIND(<internal://blank>(?s) AS ?node) FILTER(ISBLANK(?node)) }',
      tripleTermData,
    )).resolves.toHaveLength(3);
    await expect(constructedNodes(
      rewriter,
      'SELECT ?node WHERE { ?node ?p ?o . FILTER(ISBLANK(?node)) }',
      tripleTermData,
    )).resolves.toHaveLength(0);
  });

  // `<o1>` and `"o1"` have no triples of their own, so the EXISTS is false and every OPTIONAL row matches.
  it('evaluates an EXISTS argument in an OPTIONAL condition', async({ expect }) => {
    const rows = await solutions(iriRewriter, `SELECT ?x WHERE {
      ?s ?p ?o OPTIONAL { ?s ?q ?x FILTER(<internal://blank>(EXISTS { ?x ?y ?z }) = <internal://blank>(false)) }
    }`, tripleTermData);
    expect(rows.map(row => row.get('x')?.value)).toEqual(Array.from({ length: 9 }, () => expect.any(String)));
  });

  it('constructs a node per solution for an unstable argument', async({ expect }) => {
    const nodes = await constructedNodes(
      iriRewriter,
      'SELECT ?node WHERE { ?s ?p ?o . BIND(<internal://blank>(STR(RAND())) AS ?node) }',
      tripleTermData,
    );
    expect(new Set(nodes).size).toBe(3);
  });

  it('refuses a triple term argument depth that is not a non-negative integer', ({ expect }) => {
    expect(() => createTransformationContext({ tripleTermArgumentDepth: -1 })).toThrow('non-negative integer');
    expect(() => createQueryRewriter([], { tripleTermArgumentDepth: 1.5 })).toThrow('non-negative integer');
  });

  describe('as a special literal', () => {
    const rewriter = createQueryRewriter([ internalBnodeAsSpecialLiteralTransformation() ]);

    // A node materialised as a typed literal has its encoding as value.
    // The last is nested three deep, one more than the default depth, so it constructs no node.
    const encodings = <const> [
      [ '<ex://a>', ',iri,ex://a' ],
      [ '"a"', ',literal,a,http://www.w3.org/2001/XMLSchema#string' ],
      [ '"a"@en', ',literal@,a,en' ],
      [ '"a"@en--ltr', ',literal@D,a,en,ltr' ],
      [ '"1"^^<ex://dt>', ',literal,1,ex://dt' ],
      [ '<<( <ex://a> <ex://p> "o"@en )>>', ',triple,iri,ex://a,iri,ex://p,literal@,o,en' ],
      [
        '<<( <ex://a> <ex://p> <<( <ex://b> <ex://q> <ex://c> )>> )>>',
        ',triple,iri,ex://a,iri,ex://p,triple,iri,ex://b,iri,ex://q,iri,ex://c',
      ],
      [ '<<( <ex://a> <ex://p> <<( <ex://b> <ex://q> <<( <ex://c> <ex://r> <ex://d> )>> )>> )>>', undefined ],
    ];

    it('encodes each kind of term bound to a variable with its own tag, and an unbound one too', async({ expect }) => {
      await expect(constructedNodes(rewriter, `SELECT ?node WHERE {
        VALUES ?x { ${encodings.map(([ term ]) => term).join(' ')} UNDEF }
        BIND(<internal://blank>(?x) AS ?node)
      }`, tripleTermData)).resolves.toEqual([ ...encodings.map(([ , encoding ]) => encoding), ',unbound' ]);
    });

    it.for(encodings)('encodes %s written out as when bound to a variable', async([ term, encoding ], { expect }) => {
      await expect(constructedNodes(
        rewriter,
        `SELECT ?node WHERE { BIND(<internal://blank>(${term}) AS ?node) }`,
        tripleTermData,
      )).resolves.toEqual([ encoding ]);
    });

    const expressionEncodings = <const> [
      [ 'STR(<ex://a>)', ',literal,ex://a,http://www.w3.org/2001/XMLSchema#string' ],
      [ '1 + "x"', ',unbound' ],
      [ 'TRIPLE(<ex://a>, <ex://p>, "o"@en)', ',triple,iri,ex://a,iri,ex://p,literal@,o,en' ],
      [ 'EXISTS {}', ',literal,true,http://www.w3.org/2001/XMLSchema#boolean' ],
    ];

    it.for(expressionEncodings)('encodes the expression %s as the value it evaluates to', async([
      expression,
      encoding,
    ], { expect }) => {
      await expect(constructedNodes(
        rewriter,
        `SELECT ?node WHERE { BIND(<internal://blank>(${expression}) AS ?node) }`,
        tripleTermData,
      )).resolves.toEqual([ encoding ]);
    });

    // The encodings below are the ones the rewritten query writes for `term`.
    function escaped(value: string): string {
      return String.raw`REPLACE( REPLACE( ${value} , "\\\\" , "\\\\\\\\" ) , "," , "\\\\," )`;
    }

    // A CONCAT as the rewrite writes it: one that is a part splices in, and one of a single part is left out.
    function concatOf(parts: string[]): string {
      const spliced = parts.map(part =>
        part.startsWith('CONCAT( ') ? part.slice('CONCAT( '.length, -' )'.length) : part);
      return parts.length === 1 && !parts[0].startsWith('CONCAT( ') ? parts[0] : `CONCAT( ${spliced.join(' , ')} )`;
    }

    // The node materialised from the encodings of its arguments.
    function materialised(...encodings: string[]): string {
      return `STRDT( ${concatOf(encodings)} , <${DT_INTERNAL_BNODE}> )`;
    }

    // The encoding, or `,unbound` where the test fails.
    function orUnbound(test: string, encoding: string): string {
      return `IF( ${test} , ${encoding} , ",unbound" )`;
    }

    // Whether `term` evaluates rather than errors.
    function evaluates(term: string): string {
      return `COALESCE( SAMETERM( ${term} , ${term} ) , FALSE )`;
    }

    function iriEncoding(term: string): string {
      return concatOf([ '",iri,"', escaped(`STR( ${term} )`) ]);
    }

    function literalEncoding(term: string): string {
      const direction = `IF( HASLANGDIR( ${term} ) , ${concatOf([ '","', `LANGDIR( ${term} )` ])} , "" )`;
      return concatOf([
        `IF( HASLANG( ${term} ) , IF( HASLANGDIR( ${term} ) , ",literal@D," , ",literal@," ) , ",literal," )`,
        escaped(`STR( ${term} )`),
        '","',
        `IF( HASLANG( ${term} ) , ${concatOf([ escaped(`LANG( ${term} )`), direction ])} , ${
          escaped(`STR( DATATYPE( ${term} ) )`)} )`,
      ]);
    }

    function iriOrLiteralEncoding(term: string): string {
      return `IF( ISIRI( ${term} ) , ${iriEncoding(term)} , ${literalEncoding(term)} )`;
    }

    // A term that is a triple term, unrolled `depth` triple terms deep.
    function tripleTermEncoding(term: string, depth = c.tripleTermArgumentDepth): string {
      return concatOf([
        '",triple"',
        iriEncoding(`SUBJECT( ${term} )`),
        iriEncoding(`PREDICATE( ${term} )`),
        termEncoding(`OBJECT( ${term} )`, depth - 1),
      ]);
    }

    // A term that can be any term, unrolled `depth` triple terms deep.
    function termEncoding(term: string, depth = c.tripleTermArgumentDepth): string {
      if (depth === 0) {
        return iriOrLiteralEncoding(term);
      }
      return `IF( ISTRIPLE( ${term} ) , ${tripleTermEncoding(term, depth)} , ${iriOrLiteralEncoding(term)} )`;
    }

    it('encodes an argument an OPTIONAL leaves unbound as a value of its own', async({ expect }) => {
      expect((await rewriter.rewriteQuery(`SELECT ?node WHERE {
        ?person <ex://name> ?name .
        OPTIONAL { ?person <ex://nick> ?nick }
        BIND(<internal://blank>(?nick) AS ?node)
      }`)).trim()).toEqual(String.raw`SELECT ( STRDT( IF( BOUND( ?nick ) , IF( ISTRIPLE( ?nick ) , CONCAT( ",triple" , ",iri," , REPLACE( REPLACE( STR( SUBJECT( ?nick ) ) , "\\\\" , "\\\\\\\\" ) , "," , "\\\\," ) , ",iri," , REPLACE( REPLACE( STR( PREDICATE( ?nick ) ) , "\\\\" , "\\\\\\\\" ) , "," , "\\\\," ) , IF( ISTRIPLE( OBJECT( ?nick ) ) , CONCAT( ",triple" , ",iri," , REPLACE( REPLACE( STR( SUBJECT( OBJECT( ?nick ) ) ) , "\\\\" , "\\\\\\\\" ) , "," , "\\\\," ) , ",iri," , REPLACE( REPLACE( STR( PREDICATE( OBJECT( ?nick ) ) ) , "\\\\" , "\\\\\\\\" ) , "," , "\\\\," ) , IF( ISIRI( OBJECT( OBJECT( ?nick ) ) ) , CONCAT( ",iri," , REPLACE( REPLACE( STR( OBJECT( OBJECT( ?nick ) ) ) , "\\\\" , "\\\\\\\\" ) , "," , "\\\\," ) ) , CONCAT( IF( HASLANG( OBJECT( OBJECT( ?nick ) ) ) , IF( HASLANGDIR( OBJECT( OBJECT( ?nick ) ) ) , ",literal@D," , ",literal@," ) , ",literal," ) , REPLACE( REPLACE( STR( OBJECT( OBJECT( ?nick ) ) ) , "\\\\" , "\\\\\\\\" ) , "," , "\\\\," ) , "," , IF( HASLANG( OBJECT( OBJECT( ?nick ) ) ) , CONCAT( REPLACE( REPLACE( LANG( OBJECT( OBJECT( ?nick ) ) ) , "\\\\" , "\\\\\\\\" ) , "," , "\\\\," ) , IF( HASLANGDIR( OBJECT( OBJECT( ?nick ) ) ) , CONCAT( "," , LANGDIR( OBJECT( OBJECT( ?nick ) ) ) ) , "" ) ) , REPLACE( REPLACE( STR( DATATYPE( OBJECT( OBJECT( ?nick ) ) ) ) , "\\\\" , "\\\\\\\\" ) , "," , "\\\\," ) ) ) ) ) , IF( ISIRI( OBJECT( ?nick ) ) , CONCAT( ",iri," , REPLACE( REPLACE( STR( OBJECT( ?nick ) ) , "\\\\" , "\\\\\\\\" ) , "," , "\\\\," ) ) , CONCAT( IF( HASLANG( OBJECT( ?nick ) ) , IF( HASLANGDIR( OBJECT( ?nick ) ) , ",literal@D," , ",literal@," ) , ",literal," ) , REPLACE( REPLACE( STR( OBJECT( ?nick ) ) , "\\\\" , "\\\\\\\\" ) , "," , "\\\\," ) , "," , IF( HASLANG( OBJECT( ?nick ) ) , CONCAT( REPLACE( REPLACE( LANG( OBJECT( ?nick ) ) , "\\\\" , "\\\\\\\\" ) , "," , "\\\\," ) , IF( HASLANGDIR( OBJECT( ?nick ) ) , CONCAT( "," , LANGDIR( OBJECT( ?nick ) ) ) , "" ) ) , REPLACE( REPLACE( STR( DATATYPE( OBJECT( ?nick ) ) ) , "\\\\" , "\\\\\\\\" ) , "," , "\\\\," ) ) ) ) ) ) , IF( ISIRI( ?nick ) , CONCAT( ",iri," , REPLACE( REPLACE( STR( ?nick ) , "\\\\" , "\\\\\\\\" ) , "," , "\\\\," ) ) , CONCAT( IF( HASLANG( ?nick ) , IF( HASLANGDIR( ?nick ) , ",literal@D," , ",literal@," ) , ",literal," ) , REPLACE( REPLACE( STR( ?nick ) , "\\\\" , "\\\\\\\\" ) , "," , "\\\\," ) , "," , IF( HASLANG( ?nick ) , CONCAT( REPLACE( REPLACE( LANG( ?nick ) , "\\\\" , "\\\\\\\\" ) , "," , "\\\\," ) , IF( HASLANGDIR( ?nick ) , CONCAT( "," , LANGDIR( ?nick ) ) , "" ) ) , REPLACE( REPLACE( STR( DATATYPE( ?nick ) ) , "\\\\" , "\\\\\\\\" ) , "," , "\\\\," ) ) ) ) ) , ",unbound" ) , <https://sparql-extension.knows.idlab.ugent.be/bnode> ) AS ?node ) WHERE {
  ?person <ex://name> ?name .
  OPTIONAL {
    ?person <ex://nick> ?nick .
  }
}`);
    });

    // A subject is never a literal or a triple term, and the pattern binds `?s` in every solution.
    it('encodes a subject variable as an IRI only', async({ expect }) => {
      expect((await rewriter.rewriteQuery(`SELECT ?node WHERE {
        ?s ?p ?o .
        BIND(<internal://blank>(?s) AS ?node)
      }`)).trim()).toEqual(`SELECT ( ${materialised(iriEncoding('?s'))} AS ?node ) WHERE {
  ?s ?p ?o .
}`);
    });

    it('encodes a variable that can only be a triple term without asking whether it is one', async({ expect }) => {
      expect((await rewriter.rewriteQuery(`SELECT ?node WHERE {
        ?s ?p ?o .
        BIND(<<( ?s ?p ?o )>> AS ?t)
        BIND(<internal://blank>(?t) AS ?node)
      }`)).trim()).toEqual(`SELECT ( ${materialised(tripleTermEncoding('?t'))} AS ?node ) WHERE {
  ?s ?p ?o .
  BIND( <<( ?s ?p ?o )>> AS ?t )
}`);
    });

    it('encodes a triple term only as deep as the context says', async({ expect }) => {
      const shallowRewriter = createQueryRewriter(
        [ internalBnodeAsSpecialLiteralTransformation() ],
        { tripleTermArgumentDepth: 1 },
      );
      expect((await shallowRewriter.rewriteQuery(`SELECT ?node WHERE {
        ?s ?p ?o .
        BIND(<<( ?s ?p ?o )>> AS ?t)
        BIND(<internal://blank>(?t) AS ?node)
      }`)).trim()).toEqual(`SELECT ( ${materialised(tripleTermEncoding('?t', 1))} AS ?node ) WHERE {
  ?s ?p ?o .
  BIND( <<( ?s ?p ?o )>> AS ?t )
}`);
    });

    it('encodes a triple term written in the argument through its components', async({ expect }) => {
      expect((await rewriter.rewriteQuery(`SELECT ?node WHERE {
        ?s ?p ?o .
        BIND(<internal://blank>(<<( ?s ?p ?o )>>) AS ?node)
      }`)).trim()).toEqual(String.raw`SELECT ( STRDT( CONCAT( ",triple" , ",iri," , REPLACE( REPLACE( STR( ?s ) , "\\\\" , "\\\\\\\\" ) , "," , "\\\\," ) , ",iri," , REPLACE( REPLACE( STR( ?p ) , "\\\\" , "\\\\\\\\" ) , "," , "\\\\," ) , IF( ISTRIPLE( ?o ) , CONCAT( ",triple" , ",iri," , REPLACE( REPLACE( STR( SUBJECT( ?o ) ) , "\\\\" , "\\\\\\\\" ) , "," , "\\\\," ) , ",iri," , REPLACE( REPLACE( STR( PREDICATE( ?o ) ) , "\\\\" , "\\\\\\\\" ) , "," , "\\\\," ) , IF( ISIRI( OBJECT( ?o ) ) , CONCAT( ",iri," , REPLACE( REPLACE( STR( OBJECT( ?o ) ) , "\\\\" , "\\\\\\\\" ) , "," , "\\\\," ) ) , CONCAT( IF( HASLANG( OBJECT( ?o ) ) , IF( HASLANGDIR( OBJECT( ?o ) ) , ",literal@D," , ",literal@," ) , ",literal," ) , REPLACE( REPLACE( STR( OBJECT( ?o ) ) , "\\\\" , "\\\\\\\\" ) , "," , "\\\\," ) , "," , IF( HASLANG( OBJECT( ?o ) ) , CONCAT( REPLACE( REPLACE( LANG( OBJECT( ?o ) ) , "\\\\" , "\\\\\\\\" ) , "," , "\\\\," ) , IF( HASLANGDIR( OBJECT( ?o ) ) , CONCAT( "," , LANGDIR( OBJECT( ?o ) ) ) , "" ) ) , REPLACE( REPLACE( STR( DATATYPE( OBJECT( ?o ) ) ) , "\\\\" , "\\\\\\\\" ) , "," , "\\\\," ) ) ) ) ) , IF( ISIRI( ?o ) , CONCAT( ",iri," , REPLACE( REPLACE( STR( ?o ) , "\\\\" , "\\\\\\\\" ) , "," , "\\\\," ) ) , CONCAT( IF( HASLANG( ?o ) , IF( HASLANGDIR( ?o ) , ",literal@D," , ",literal@," ) , ",literal," ) , REPLACE( REPLACE( STR( ?o ) , "\\\\" , "\\\\\\\\" ) , "," , "\\\\," ) , "," , IF( HASLANG( ?o ) , CONCAT( REPLACE( REPLACE( LANG( ?o ) , "\\\\" , "\\\\\\\\" ) , "," , "\\\\," ) , IF( HASLANGDIR( ?o ) , CONCAT( "," , LANGDIR( ?o ) ) , "" ) ) , REPLACE( REPLACE( STR( DATATYPE( ?o ) ) , "\\\\" , "\\\\\\\\" ) , "," , "\\\\," ) ) ) ) ) ) , <https://sparql-extension.knows.idlab.ugent.be/bnode> ) AS ?node ) WHERE {
  ?s ?p ?o .
}`);
    });

    // `?o` may be a literal, which a subject does not admit, so constructing the triple term may fail.
    it('encodes a written triple term that may fail to construct as unbound when it does', async({ expect }) => {
      expect((await rewriter.rewriteQuery(`SELECT ?node WHERE {
        ?s ?p ?o .
        BIND(<internal://blank>(<<( ?o ?p ?s )>>) AS ?node)
      }`)).trim()).toEqual(`SELECT ( ${materialised(orUnbound(
        evaluates('<<( ?o ?p ?s )>>'),
        concatOf([ '",triple"', iriEncoding('?o'), iriEncoding('?p'), iriEncoding('?s') ]),
      ))} AS ?node ) WHERE {
  ?s ?p ?o .
}`);
    });

    // Its encoding reads the argument many times, while the BIND evaluates it once.
    it('binds an expression argument to a variable first', async({ expect }) => {
      expect((await rewriter.rewriteQuery(`SELECT ?node WHERE {
        ?s ?p ?o .
        BIND(<internal://blank>(STR(?o)) AS ?node)
      }`)).trim()).toEqual(`SELECT ( ${materialised(orUnbound('BOUND( ?mBnodeArgument0 )', termEncoding('?mBnodeArgument0')))} AS ?node ) WHERE {
  ?s ?p ?o .
  BIND( STR( ?o ) AS ?mBnodeArgument0 )
}`);
    });

    it('grows the rewrite linearly with nested blank nodes', async({ expect }) => {
      const lengths = await Promise.all([ 1, 2, 3 ].map(async(depth) => {
        const nested = `${'<internal://blank>('.repeat(depth)}?o${')'.repeat(depth)}`;
        return (await rewriter.rewriteQuery(`SELECT ?node WHERE { ?s ?p ?o . BIND(${nested} AS ?node) }`)).length;
      }));
      expect(lengths[2] - lengths[1]).toBe(lengths[1] - lengths[0]);
    });

    // An OPTIONAL condition has no input to bind the argument in, so it tests the argument itself.
    it('encodes an expression argument in an OPTIONAL condition as unbound when it errors', async({ expect }) => {
      expect((await rewriter.rewriteQuery(`SELECT * WHERE {
        ?s ?p ?o OPTIONAL { ?s ?q ?x FILTER(<internal://blank>(STR(?x)) = ?o) }
      }`)).trim()).toEqual(`SELECT ?o ?p ?q ?s ?x WHERE {
  ?s ?p ?o .
  OPTIONAL {
    ?s ?q ?x .
    FILTER ( ( ${materialised(orUnbound(evaluates('STR( ?x )'), termEncoding('STR( ?x )')))} = ?o ) )
  }
}`);
    });

    it('refuses an unstable argument it cannot bind to a variable', async({ expect }) => {
      await expect(rewriter.rewriteQuery(`SELECT * WHERE {
        ?s ?p ?o OPTIONAL { ?s ?q ?x FILTER(<internal://blank>(STR(RAND())) = ?o) }
      }`)).rejects.toThrow('like RAND()');
    });

    it('rewrites an ISBLANK in an argument', async({ expect }) => {
      expect((await rewriter.rewriteQuery(`SELECT * WHERE {
        ?s ?p ?o . BIND(<internal://blank>(STR(ISBLANK(?s))) AS ?node)
      }`)).trim()).toEqual(`SELECT ( ${materialised(orUnbound('BOUND( ?mBnodeArgument0 )', termEncoding('?mBnodeArgument0')))} AS ?node ) ?o ?p ?s WHERE {
  ?s ?p ?o .
  BIND( STR( ( DATATYPE( ?s ) = <${DT_INTERNAL_BNODE}> ) ) AS ?mBnodeArgument0 )
}`);
    });

    // An EXISTS substitutes the solution it is asked for, so the ranges of its own pattern do not hold.
    it('encodes an argument in an EXISTS with every branch', async({ expect }) => {
      expect((await rewriter.rewriteQuery(`SELECT * WHERE {
        ?s ?p ?o .
        FILTER EXISTS { BIND(<internal://blank>(?s) AS ?node) }
      }`)).trim()).toEqual(`SELECT ?o ?p ?s WHERE {
  ?s ?p ?o .
  FILTER ( EXISTS {
    {
      BIND( ${materialised(orUnbound('BOUND( ?s )', termEncoding('?s')))} AS ?node )
    }
  }
  )
}`);
    });

    // BOUND only accepts a variable, and a constant is bound anyway. Its range is its own term type.
    it('encodes a constant argument without asking whether it is bound', async({ expect }) => {
      expect((await rewriter.rewriteQuery('SELECT * WHERE { BIND(<internal://blank>(<ex://c>) AS ?node) }')).trim())
        .toEqual(String.raw`SELECT ( STRDT( CONCAT( ",iri," , REPLACE( REPLACE( STR( <ex://c> ) , "\\\\" , "\\\\\\\\" ) , "," , "\\\\," ) ) , <https://sparql-extension.knows.idlab.ugent.be/bnode> ) AS ?node ) WHERE {
}`);
      // Static evaluation folds the encoding of a constant into the node itself.
      const evaluated = createQueryRewriter([
        internalBnodeAsSpecialLiteralTransformation(),
        simplifyStaticExpressionsTransformation(),
      ]);
      expect((await evaluated.rewriteQuery('SELECT * WHERE { BIND(<internal://blank>(<ex://c>) AS ?node) }')).trim())
        .toEqual(`SELECT ( ",iri,ex://c"^^<https://sparql-extension.knows.idlab.ugent.be/bnode> AS ?node ) WHERE {
}`);
    }, 60_000);
  });
});
