import { createHash } from 'node:crypto';
import { QueryEngine } from '@comunica/query-sparql-file';
import type * as RDF from '@rdfjs/types';
import { describe, it } from 'vitest';
import { DT_INTERNAL_BNODE, EXTENSION_FUNCTION_BNODE_ENCODING, IRI_PREFIX_BNODE } from '../lib/consts.js';
import { mappingFromConstructQueries } from '../lib/mapping.js';
import { createDefaultTransformationPipeline, createQueryRewriter } from '../lib/queryRewriter.js';
import type { ExtensionFunctions } from '../lib/transformations/bnodeExtensionFunction.js';
import {
  boundArgumentMarker,
  internalBnodeExtensionFunctions,
} from '../lib/transformations/bnodeExtensionFunction.js';
import {
  internalBnodeAsSpecialIriTransformation,
  internalBnodeAsSpecialLiteralTransformation,
} from '../lib/transformations/bnodeMapAsLiteral.js';
import { simplifyStaticExpressionsTransformation } from '../lib/transformations/staticExpressionEvaluation.js';
import { createTransformationContext } from '../lib/transformContext.js';
import type { QueryTransformation } from '../lib/types.js';

const engine = new QueryEngine();

// The data holds `<a> <p1> <o1>` and two triples differing from it in one position.
const tripleTermData = './test/statics/tripleTermArguments.ttl';

// How internal blank nodes are evaluated: the step materialising them, and the functions the engine is given for it.
interface BnodeEvaluation {
  name: string;
  transformation: QueryTransformation;
  extensionFunctions?: ExtensionFunctions;
}

// The evaluation materialising as the step does, its encoding in SPARQL or by the extension function.
function bnodeEvaluation(
  materialisedAs: string,
  transformationStep: typeof internalBnodeAsSpecialLiteralTransformation,
  encodedByExtensionFunction: boolean,
): BnodeEvaluation {
  return {
    name: `${encodedByExtensionFunction ? 'an extension function' : 'SPARQL'} as ${materialisedAs}`,
    transformation: transformationStep({ encodedByExtensionFunction }),
    ...encodedByExtensionFunction && { extensionFunctions: internalBnodeExtensionFunctions() },
  };
}

const sparqlLiteral = bnodeEvaluation('a typed literal', internalBnodeAsSpecialLiteralTransformation, false);
const sparqlIri = bnodeEvaluation('a prefixed IRI', internalBnodeAsSpecialIriTransformation, false);
const extensionFunctionLiteral = bnodeEvaluation('a typed literal', internalBnodeAsSpecialLiteralTransformation, true);
const extensionFunctionIri = bnodeEvaluation('a prefixed IRI', internalBnodeAsSpecialIriTransformation, true);
const evaluations = [ sparqlLiteral, sparqlIri, extensionFunctionLiteral, extensionFunctionIri ];

// Where a query is evaluated, and the pipeline rewriting it before the evaluation's step.
interface QuerySetting {
  source?: string;
  pipeline?: QueryTransformation[];
}

// Every solution of the query, rewritten by the pipeline and the evaluation's step, over the source.
async function solutions(
  evaluation: BnodeEvaluation,
  query: string,
  { source = tripleTermData, pipeline = []}: QuerySetting = {},
): Promise<RDF.Bindings[]> {
  const rewritten = await createQueryRewriter([ ...pipeline, evaluation.transformation ]).rewriteQuery(query);
  const bindings = await engine.queryBindings(rewritten, {
    sources: [ source ],
    ...evaluation.extensionFunctions && { extensionFunctions: evaluation.extensionFunctions },
  });
  return bindings.toArray();
}

// The value of `?node` in every solution of the query.
async function constructedNodes(
  evaluation: BnodeEvaluation,
  query: string,
  setting?: QuerySetting,
): Promise<(string | undefined)[]> {
  return (await solutions(evaluation, query, setting)).map(binding => binding.get('node')?.value);
}

// The default pipeline unfolding the CONSTRUCT.
function unfolding(construct: string): QueryTransformation[] {
  return createDefaultTransformationPipeline(mappingFromConstructQueries([ construct ]));
}

describe('bnode skolem', () => {
  const c = createTransformationContext();
  const AF = c.AF;
  const DF = c.DF;

  it('skolem to literal no params', async({ expect }) => {
    const bnodeNoParams = AF.createNamedExpression(DF.namedNode('internal://blank'), []);
    expect(internalBnodeAsSpecialLiteralTransformation()(c, bnodeNoParams))
      .toEqual(AF.createOperatorExpression('strdt', [
        AF.createOperatorExpression('struuid', []),
        AF.createTermExpression(DF.namedNode(DT_INTERNAL_BNODE)),
      ]));
  });

  describe.for(evaluations)('evaluated by $name', (evaluation) => {
    // The join on `?node` keeps a solution only when both patterns constructed the same node.
    it.for([ '?s, ?p, ?o', '<<( ?s ?p ?o )>>', 'STR(?o), ?p, ?s' ])(
      'constructs the same node from %s in every pattern it is unfolded into',
      async(args, { expect }) => {
        await expect(constructedNodes(
          evaluation,
          'SELECT ?node WHERE { ?node <ex://subject> ?s . ?node <ex://object> ?o }',
          { pipeline: unfolding(`CONSTRUCT { ?node <ex://subject> ?s . ?node <ex://object> ?o } WHERE {
            ?s ?p ?o .
            BIND(<internal://blank>(${args}) AS ?node)
          }`) },
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
        const nodes = await solutions(evaluation, `SELECT * {
          ?s ?p ?o .
          BIND(<internal://blank>(?s) AS ?node)
          BIND(${argument} AS ?bound)
          BIND(<internal://blank>(?bound) AS ?fromVariable)
          BIND(<internal://blank>(${argument}) AS ?fromExpression)
        }`);
        expect(nodes).toHaveLength(3);
        for (const binding of nodes) {
          expect(binding.get('fromExpression')).toBeDefined();
          expect(binding.get('fromExpression')?.value).toBe(binding.get('fromVariable')?.value);
        }
      },
    );

    // A BIND keeps an error apart from false, which a FILTER would drop alike.
    it('recognises a materialised node as the only blank node', async({ expect }) => {
      const rows = await solutions(evaluation, `SELECT ?isBlank WHERE {
        { VALUES ?x { <ex://a> "a" <<( <ex://a> <ex://p> <ex://o> )>> } } UNION { BIND(<internal://blank>(<ex://a>) AS ?x) }
        BIND(ISBLANK(?x) AS ?isBlank)
      }`);
      // In any order, as a UNION promises none.
      expect(rows.map(row => String(row.get('isBlank')?.value)).sort()).toEqual([ 'false', 'false', 'false', 'true' ]);
    });

    // `<o1>` and `"o1"` have no triples of their own, so the EXISTS is false and every OPTIONAL row matches.
    it('evaluates an EXISTS argument in an OPTIONAL condition', async({ expect }) => {
      const rows = await solutions(evaluation, `SELECT ?x WHERE {
        ?s ?p ?o OPTIONAL { ?s ?q ?x FILTER(<internal://blank>(EXISTS { ?x ?y ?z }) = <internal://blank>(false)) }
      }`);
      expect(rows.map(row => row.get('x')?.value)).toEqual(Array.from({ length: 9 }, () => expect.any(String)));
    });

    // `?x` is bound for the `<ex://o1>` solution only, and both solutions share `?s`.
    it('constructs a node of its own for an argument an OPTIONAL in the mapping leaves unbound', async({ expect }) => {
      const nodes = await constructedNodes(
        evaluation,
        'SELECT ?node WHERE { ?node <ex://object> ?o }',
        { source: './test/statics/data01.ttl', pipeline: unfolding(`CONSTRUCT { ?node <ex://object> ?o } WHERE {
          ?s ?p ?o .
          OPTIONAL { ?x <ex://p1> ?o }
          BIND(<internal://blank>(?s, ?x) AS ?node)
        }`) },
      );
      expect(nodes).toEqual([ expect.any(String), expect.any(String) ]);
      expect(new Set(nodes).size).toBe(2);
    });

    it.for([
      'SELECT ?node WHERE { ?s ?p ?o . BIND(<internal://blank>(STR(RAND())) AS ?node) }',
      'SELECT (SAMPLE(<internal://blank>(STR(RAND()))) AS ?node) WHERE { ?s ?p ?o } GROUP BY ?s ?p ?o',
      'SELECT ?node WHERE { ?s ?p ?o . BIND(<internal://blank>() AS ?node) }',
    ])('constructs a node per solution for an unstable argument in %s', async(query, { expect }) => {
      expect(new Set(await constructedNodes(evaluation, query)).size).toBe(3);
    });
  });

  describe('evaluated by an extension function', () => {
    const rewriter = createQueryRewriter([ extensionFunctionLiteral.transformation ]);
    const encode = internalBnodeExtensionFunctions()[EXTENSION_FUNCTION_BNODE_ENCODING];

    it('wraps every argument and rewrites ISBLANK', async({ expect }) => {
      expect((await rewriter.rewriteQuery(`SELECT * WHERE {
        ?s ?p ?o .
        BIND(<internal://blank>(?s, STR(?o)) AS ?node)
        FILTER(ISBLANK(?node))
      }`)).trim()).toEqual([
        'SELECT ?node ?o ?p ?s WHERE {\n  {\n    ?s ?p ?o .\n    BIND( STRDT( <internal://blank/encoding> ( ',
        'COALESCE( TRIPLE( <internal://blank/argument> , <internal://blank/argument> , ?s ) , <internal://blank/unbound> ) , ',
        'COALESCE( TRIPLE( <internal://blank/argument> , <internal://blank/argument> , STR( ?o ) ) , <internal://blank/unbound> ) ',
        `) , <${DT_INTERNAL_BNODE}> ) AS ?node )\n  }\n  FILTER ( ( ISLITERAL( ?node ) && ( DATATYPE( ?node ) = <${DT_INTERNAL_BNODE}> ) ) )\n}`,
      ].join(''));
    });

    // The SPARQL encoding there tests an argument by evaluating it again, so it takes `RAND()` for an error: both sides
    // become `,unbound` and the condition fails.
    it('evaluates an unstable argument in an OPTIONAL condition once', async({ expect }) => {
      await expect(solutions(extensionFunctionLiteral, `SELECT ?x WHERE {
        ?s ?p ?o OPTIONAL { ?s ?q ?x FILTER(!SAMETERM(<internal://blank>(STR(RAND())), <internal://blank>(STR(RAND())))) }
      }`)).resolves.toHaveLength(9);
    });

    // The SPARQL encoding errors on it.
    it('encodes a blank node an engine constructs by its label', async({ expect }) => {
      await expect(encode([
        DF.quad(boundArgumentMarker, boundArgumentMarker, DF.blankNode('b0')),
      ])).resolves.toEqual(DF.literal(',bnode,2:b0'));
    });

    it('refuses an argument the transformation did not wrap', async({ expect }) => {
      await expect(encode([ DF.namedNode('ex://a') ]))
        .rejects.toThrow('has to be wrapped');
    });
  });

  it('refuses a triple term argument depth that is not a non-negative integer', ({ expect }) => {
    expect(() => createTransformationContext({ tripleTermArgumentDepth: -1 })).toThrow('non-negative integer');
    expect(() => createQueryRewriter([], { tripleTermArgumentDepth: 1.5 })).toThrow('non-negative integer');
  });

  // A node materialised as a typed literal has its encoding as value, the same whichever way it is encoded.
  describe.for([ sparqlLiteral, extensionFunctionLiteral ])('encoded by $name', (evaluation) => {
    const encodings = <const> [
      [ '<ex://a>', ',iri,6:ex://a' ],
      [ '"a"', ',literal,1:a,39:http://www.w3.org/2001/XMLSchema#string,0:,0:' ],
      // The length tells where a string ends, so a comma or backslash in it needs no escaping.
      [ '"a,b\\\\c"', ',literal,5:a,b\\c,39:http://www.w3.org/2001/XMLSchema#string,0:,0:' ],
      // The length counts characters, as `STRLEN` does, not UTF-16 code units.
      [ '"😀"', ',literal,1:😀,39:http://www.w3.org/2001/XMLSchema#string,0:,0:' ],
      [ '"a"@en', ',literal,1:a,53:http://www.w3.org/1999/02/22-rdf-syntax-ns#langString,2:en,0:' ],
      [ '"a"@en--ltr', ',literal,1:a,56:http://www.w3.org/1999/02/22-rdf-syntax-ns#dirLangString,2:en,3:ltr' ],
      [ '"1"^^<ex://dt>', ',literal,1:1,7:ex://dt,0:,0:' ],
      [ '<<( <ex://a> <ex://p> "o"@en )>>', ',triple,iri,6:ex://a,iri,6:ex://p,literal,1:o,53:http://www.w3.org/1999/02/22-rdf-syntax-ns#langString,2:en,0:' ],
      [
        '<<( <ex://a> <ex://p> <<( <ex://b> <ex://q> <ex://c> )>> )>>',
        ',triple,iri,6:ex://a,iri,6:ex://p,triple,iri,6:ex://b,iri,6:ex://q,iri,6:ex://c',
      ],
    ];

    it('encodes each kind of term bound to a variable with its own tag, and an unbound one too', async({ expect }) => {
      await expect(constructedNodes(evaluation, `SELECT ?node WHERE {
        VALUES ?x { ${encodings.map(([ term ]) => term).join(' ')} UNDEF }
        BIND(<internal://blank>(?x) AS ?node)
      }`)).resolves.toEqual([ ...encodings.map(([ , encoding ]) => encoding), ',unbound' ]);
    });

    it.for(encodings)('encodes %s written out as when bound to a variable', async([ term, encoding ], { expect }) => {
      await expect(constructedNodes(evaluation, `SELECT ?node WHERE { BIND(<internal://blank>(${term}) AS ?node) }`))
        .resolves.toEqual([ encoding ]);
    });

    // An argument that errors is encoded as one left unbound: `1 + "x"` errors, and a literal subject fails to
    // construct its triple term.
    it.for(<const> [
      [ 'STR(<ex://a>)', ',literal,6:ex://a,39:http://www.w3.org/2001/XMLSchema#string,0:,0:' ],
      [ '1 + "x"', ',unbound' ],
      [ '<<( ?literal <ex://p> <ex://o> )>>', ',unbound' ],
      [ 'TRIPLE(<ex://a>, <ex://p>, "o"@en)', ',triple,iri,6:ex://a,iri,6:ex://p,literal,1:o,53:http://www.w3.org/1999/02/22-rdf-syntax-ns#langString,2:en,0:' ],
      [ 'EXISTS {}', ',literal,4:true,40:http://www.w3.org/2001/XMLSchema#boolean,0:,0:' ],
      // In the order they are written.
      [ '<ex://b>, ?unbound, "a"', ',iri,6:ex://b,unbound,literal,1:a,39:http://www.w3.org/2001/XMLSchema#string,0:,0:' ],
    ])('encodes the arguments %s as the values they evaluate to', async([ args, encoding ], { expect }) => {
      await expect(constructedNodes(evaluation, `SELECT ?node WHERE {
        BIND("a" AS ?literal)
        BIND(<internal://blank>(${args}) AS ?node)
      }`)).resolves.toEqual([ encoding ]);
    });
  });

  describe('with a triple term three deep', () => {
    const query = `SELECT ?node WHERE {
      BIND(<internal://blank>(<<( <ex://a> <ex://p> <<( <ex://b> <ex://q> <<( <ex://c> <ex://r> <ex://d> )>> )>> )>>) AS ?node)
    }`;

    // An expression cannot recurse, so the SPARQL encoding unrolls a triple term only `tripleTermArgumentDepth` deep.
    it('encoded in SPARQL, constructs no node', async({ expect }) => {
      await expect(constructedNodes(sparqlLiteral, query)).resolves.toEqual([ undefined ]);
    });

    it('encoded by an extension function, constructs its node', async({ expect }) => {
      await expect(constructedNodes(extensionFunctionLiteral, query)).resolves.toEqual([
        ',triple,iri,6:ex://a,iri,6:ex://p,triple,iri,6:ex://b,iri,6:ex://q,triple,iri,6:ex://c,iri,6:ex://r,iri,6:ex://d',
      ]);
    });
  });

  // A node materialised as an IRI is the prefixed SHA-1 of its encoding, the same whichever way it is encoded.
  it.for([ sparqlIri, extensionFunctionIri ])('encoded by $name, materialises the SHA-1 of the encoding', async(
    evaluation,
    { expect },
  ) => {
    await expect(constructedNodes(evaluation, 'SELECT ?node WHERE { BIND(<internal://blank>(<ex://a>) AS ?node) }'))
      .resolves.toEqual([ `${IRI_PREFIX_BNODE}${createHash('sha1').update(',iri,6:ex://a').digest('hex')}` ]);
  });

  describe('as a special literal', () => {
    const rewriter = createQueryRewriter([ sparqlLiteral.transformation ]);

    // Joins encodings, each the list of parts of its CONCAT, as the rewrite does: nested parts spliced in, adjacent
    // constants merged.
    function concatOf(...encodings: string[][]): string[] {
      const constant = /^"[^"\\]*"$/u;
      const joined: string[] = [];
      for (const part of encodings.flat()) {
        const previous = joined.at(-1);
        if (previous !== undefined && constant.test(previous) && constant.test(part)) {
          joined[joined.length - 1] = `${previous.slice(0, -1)}${part.slice(1)}`;
        } else {
          joined.push(part);
        }
      }
      return joined;
    }

    function written(encoding: string[]): string {
      return encoding.length === 1 ? encoding[0] : `CONCAT( ${encoding.join(' , ')} )`;
    }

    // The node materialised from the encodings of its arguments.
    function materialised(...encodings: string[][]): string {
      return `STRDT( ${written(concatOf(...encodings))} , <${DT_INTERNAL_BNODE}> )`;
    }

    // The encoding, or `,unbound` where the test fails.
    function orUnbound(test: string, encoding: string[]): string[] {
      return [ `IF( ${test} , ${written(encoding)} , ",unbound" )` ];
    }

    // Whether `term` evaluates rather than errors.
    function evaluates(term: string): string {
      return `COALESCE( SAMETERM( ${term} , ${term} ) , FALSE )`;
    }

    function field(value: string): string[] {
      return [ '","', `STR( STRLEN( ${value} ) )`, '":"', value ];
    }

    function iriEncoding(term: string): string[] {
      return concatOf([ '",iri"' ], field(`STR( ${term} )`));
    }

    function literalEncoding(term: string): string[] {
      return concatOf(
        [ '",literal"' ],
        field(`STR( ${term} )`),
        field(`STR( DATATYPE( ${term} ) )`),
        field(`LANG( ${term} )`),
        field(`LANGDIR( ${term} )`),
      );
    }

    function iriOrLiteralEncoding(term: string): string[] {
      return [ `IF( ISIRI( ${term} ) , ${written(iriEncoding(term))} , ${written(literalEncoding(term))} )` ];
    }

    // A term that is a triple term, unrolled `depth` triple terms deep.
    function tripleTermEncoding(term: string, depth = c.tripleTermArgumentDepth): string[] {
      return concatOf(
        [ '",triple"' ],
        iriEncoding(`SUBJECT( ${term} )`),
        iriEncoding(`PREDICATE( ${term} )`),
        termEncoding(`OBJECT( ${term} )`, depth - 1),
      );
    }

    // A term that can be any term, unrolled `depth` triple terms deep.
    function termEncoding(term: string, depth = c.tripleTermArgumentDepth): string[] {
      if (depth === 0) {
        return iriOrLiteralEncoding(term);
      }
      return [ `IF( ISTRIPLE( ${term} ) , ${written(tripleTermEncoding(term, depth))} , ${written(iriOrLiteralEncoding(term))} )` ];
    }

    it('encodes an argument an OPTIONAL leaves unbound as a value of its own', async({ expect }) => {
      expect((await rewriter.rewriteQuery(`SELECT ?node WHERE {
        ?person <ex://name> ?name .
        OPTIONAL { ?person <ex://nick> ?nick }
        BIND(<internal://blank>(?nick) AS ?node)
      }`)).trim()).toEqual([
        String.raw`SELECT ( STRDT( IF( BOUND( ?nick ) , IF( ISTRIPLE( ?nick ) , CONCAT( ",triple,iri," , STR( `,
        String.raw`STRLEN( STR( SUBJECT( ?nick ) ) ) ) , ":" , STR( SUBJECT( ?nick ) ) , ",iri," , STR( STRLEN( `,
        String.raw`STR( PREDICATE( ?nick ) ) ) ) , ":" , STR( PREDICATE( ?nick ) ) , IF( ISTRIPLE( OBJECT( ?nick ) `,
        String.raw`) , CONCAT( ",triple,iri," , STR( STRLEN( STR( SUBJECT( OBJECT( ?nick ) ) ) ) ) , ":" , STR( `,
        String.raw`SUBJECT( OBJECT( ?nick ) ) ) , ",iri," , STR( STRLEN( STR( PREDICATE( OBJECT( ?nick ) ) ) ) ) , `,
        String.raw`":" , STR( PREDICATE( OBJECT( ?nick ) ) ) , IF( ISIRI( OBJECT( OBJECT( ?nick ) ) ) , CONCAT( `,
        String.raw`",iri," , STR( STRLEN( STR( OBJECT( OBJECT( ?nick ) ) ) ) ) , ":" , STR( OBJECT( OBJECT( ?nick `,
        String.raw`) ) ) ) , CONCAT( ",literal," , STR( STRLEN( STR( OBJECT( OBJECT( ?nick ) ) ) ) ) , ":" , STR( `,
        String.raw`OBJECT( OBJECT( ?nick ) ) ) , "," , STR( STRLEN( STR( DATATYPE( OBJECT( OBJECT( ?nick ) ) ) ) ) `,
        String.raw`) , ":" , STR( DATATYPE( OBJECT( OBJECT( ?nick ) ) ) ) , "," , STR( STRLEN( LANG( OBJECT( `,
        String.raw`OBJECT( ?nick ) ) ) ) ) , ":" , LANG( OBJECT( OBJECT( ?nick ) ) ) , "," , STR( STRLEN( LANGDIR( `,
        String.raw`OBJECT( OBJECT( ?nick ) ) ) ) ) , ":" , LANGDIR( OBJECT( OBJECT( ?nick ) ) ) ) ) ) , IF( ISIRI( `,
        String.raw`OBJECT( ?nick ) ) , CONCAT( ",iri," , STR( STRLEN( STR( OBJECT( ?nick ) ) ) ) , ":" , STR( `,
        String.raw`OBJECT( ?nick ) ) ) , CONCAT( ",literal," , STR( STRLEN( STR( OBJECT( ?nick ) ) ) ) , ":" , `,
        String.raw`STR( OBJECT( ?nick ) ) , "," , STR( STRLEN( STR( DATATYPE( OBJECT( ?nick ) ) ) ) ) , ":" , STR( `,
        String.raw`DATATYPE( OBJECT( ?nick ) ) ) , "," , STR( STRLEN( LANG( OBJECT( ?nick ) ) ) ) , ":" , LANG( `,
        String.raw`OBJECT( ?nick ) ) , "," , STR( STRLEN( LANGDIR( OBJECT( ?nick ) ) ) ) , ":" , LANGDIR( OBJECT( `,
        String.raw`?nick ) ) ) ) ) ) , IF( ISIRI( ?nick ) , CONCAT( ",iri," , STR( STRLEN( STR( ?nick ) ) ) , ":" `,
        String.raw`, STR( ?nick ) ) , CONCAT( ",literal," , STR( STRLEN( STR( ?nick ) ) ) , ":" , STR( ?nick ) , `,
        String.raw`"," , STR( STRLEN( STR( DATATYPE( ?nick ) ) ) ) , ":" , STR( DATATYPE( ?nick ) ) , "," , STR( `,
        String.raw`STRLEN( LANG( ?nick ) ) ) , ":" , LANG( ?nick ) , "," , STR( STRLEN( LANGDIR( ?nick ) ) ) , ":" `,
        String.raw`, LANGDIR( ?nick ) ) ) ) , ",unbound" ) , <https://sparql-extension.knows.idlab.ugent.be/bnode> `,
        String.raw`) AS ?node ) WHERE {
  ?person <ex://name> ?name .
  OPTIONAL {
    ?person <ex://nick> ?nick .
  }
}`,
      ].join(''));
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
      }`)).trim()).toEqual([
        String.raw`SELECT ( STRDT( CONCAT( ",triple,iri," , STR( STRLEN( STR( ?s ) ) ) , ":" , STR( ?s ) , ",iri," `,
        String.raw`, STR( STRLEN( STR( ?p ) ) ) , ":" , STR( ?p ) , IF( ISTRIPLE( ?o ) , CONCAT( ",triple,iri," , `,
        String.raw`STR( STRLEN( STR( SUBJECT( ?o ) ) ) ) , ":" , STR( SUBJECT( ?o ) ) , ",iri," , STR( STRLEN( `,
        String.raw`STR( PREDICATE( ?o ) ) ) ) , ":" , STR( PREDICATE( ?o ) ) , IF( ISIRI( OBJECT( ?o ) ) , CONCAT( `,
        String.raw`",iri," , STR( STRLEN( STR( OBJECT( ?o ) ) ) ) , ":" , STR( OBJECT( ?o ) ) ) , CONCAT( `,
        String.raw`",literal," , STR( STRLEN( STR( OBJECT( ?o ) ) ) ) , ":" , STR( OBJECT( ?o ) ) , "," , STR( `,
        String.raw`STRLEN( STR( DATATYPE( OBJECT( ?o ) ) ) ) ) , ":" , STR( DATATYPE( OBJECT( ?o ) ) ) , "," , `,
        String.raw`STR( STRLEN( LANG( OBJECT( ?o ) ) ) ) , ":" , LANG( OBJECT( ?o ) ) , "," , STR( STRLEN( `,
        String.raw`LANGDIR( OBJECT( ?o ) ) ) ) , ":" , LANGDIR( OBJECT( ?o ) ) ) ) ) , IF( ISIRI( ?o ) , CONCAT( `,
        String.raw`",iri," , STR( STRLEN( STR( ?o ) ) ) , ":" , STR( ?o ) ) , CONCAT( ",literal," , STR( STRLEN( `,
        String.raw`STR( ?o ) ) ) , ":" , STR( ?o ) , "," , STR( STRLEN( STR( DATATYPE( ?o ) ) ) ) , ":" , STR( `,
        String.raw`DATATYPE( ?o ) ) , "," , STR( STRLEN( LANG( ?o ) ) ) , ":" , LANG( ?o ) , "," , STR( STRLEN( `,
        String.raw`LANGDIR( ?o ) ) ) , ":" , LANGDIR( ?o ) ) ) ) ) , `,
        String.raw`<https://sparql-extension.knows.idlab.ugent.be/bnode> ) AS ?node ) WHERE {
  ?s ?p ?o .
}`,
      ].join(''));
    });

    // `?o` may be a literal, which a subject does not admit, so constructing the triple term may fail.
    it('encodes a written triple term that may fail to construct as unbound when it does', async({ expect }) => {
      expect((await rewriter.rewriteQuery(`SELECT ?node WHERE {
        ?s ?p ?o .
        BIND(<internal://blank>(<<( ?o ?p ?s )>>) AS ?node)
      }`)).trim()).toEqual(`SELECT ( ${materialised(orUnbound(
        evaluates('<<( ?o ?p ?s )>>'),
        concatOf([ '",triple"' ], iriEncoding('?o'), iriEncoding('?p'), iriEncoding('?s')),
      ))} AS ?node ) WHERE {
  ?s ?p ?o .
}`);
    });

    // Its encoding reads the argument many times, while the BIND evaluates it once. STR gives a literal, so the
    // encoding is that of a literal only.
    it('binds an expression argument to a variable first', async({ expect }) => {
      expect((await rewriter.rewriteQuery(`SELECT ?node WHERE {
        ?s ?p ?o .
        BIND(<internal://blank>(STR(?o)) AS ?node)
      }`)).trim()).toEqual(`SELECT ( ${materialised(orUnbound('BOUND( ?mBnodeArgument0 )', literalEncoding('?mBnodeArgument0')))} AS ?node ) WHERE {
  ?s ?p ?o .
  BIND( STR( ?o ) AS ?mBnodeArgument0 )
}`);
    });

    it.for([
      'SELECT ?node WHERE { ?s ?p ?o . BIND(NESTED AS ?node) }',
      'SELECT * WHERE { ?s ?p ?o } ORDER BY (NESTED)',
      'SELECT (SAMPLE(NESTED) AS ?node) WHERE { ?s ?p ?o }',
    ])('grows the rewrite linearly with nested blank nodes in %s', async(query, { expect }) => {
      const lengths = await Promise.all([ 1, 2, 3 ].map(async(depth) => {
        const nested = `${'<internal://blank>('.repeat(depth)}?o${')'.repeat(depth)}`;
        return (await rewriter.rewriteQuery(query.replace('NESTED', nested))).length;
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
    FILTER ( ( ${materialised(orUnbound(evaluates('STR( ?x )'), literalEncoding('STR( ?x )')))} = ?o ) )
  }
}`);
    });

    it('rewrites an ISBLANK in an argument', async({ expect }) => {
      expect((await rewriter.rewriteQuery(`SELECT * WHERE {
        ?s ?p ?o . BIND(<internal://blank>(STR(ISBLANK(?s))) AS ?node)
      }`)).trim()).toEqual(`SELECT ( ${materialised(orUnbound('BOUND( ?mBnodeArgument0 )', literalEncoding('?mBnodeArgument0')))} AS ?node ) ?o ?p ?s WHERE {
  ?s ?p ?o .
  BIND( STR( ( ISLITERAL( ?s ) && ( DATATYPE( ?s ) = <${DT_INTERNAL_BNODE}> ) ) ) AS ?mBnodeArgument0 )
}`);
    });

    // SPARQL 1.2 joins the solution an EXISTS is evaluated for into its pattern, so ?s holds what it holds outside.
    it('encodes an argument in an EXISTS with the ranges of the solution it is evaluated for', async({ expect }) => {
      expect((await rewriter.rewriteQuery(`SELECT * WHERE {
        ?s ?p ?o .
        FILTER EXISTS { BIND(<internal://blank>(?s) AS ?node) }
      }`)).trim()).toEqual(`SELECT ?o ?p ?s WHERE {
  ?s ?p ?o .
  FILTER ( EXISTS {
    {
      BIND( ${materialised(iriEncoding('?s'))} AS ?node )
    }
  }
  )
}`);
    });

    // BOUND only accepts a variable, and a constant is bound anyway. Its range is its own term type.
    it('encodes a constant argument without asking whether it is bound', async({ expect }) => {
      expect((await rewriter.rewriteQuery('SELECT * WHERE { BIND(<internal://blank>(<ex://c>) AS ?node) }')).trim())
        .toEqual([
          String.raw`SELECT ( STRDT( CONCAT( ",iri," , STR( STRLEN( STR( <ex://c> ) ) ) , ":" , STR( <ex://c> ) ) , `,
          String.raw`<https://sparql-extension.knows.idlab.ugent.be/bnode> ) AS ?node ) WHERE {
}`,
        ].join(''));
      // Static evaluation folds the encoding of a constant into the node itself.
      const evaluated = createQueryRewriter([
        internalBnodeAsSpecialLiteralTransformation(),
        simplifyStaticExpressionsTransformation(),
      ]);
      expect((await evaluated.rewriteQuery('SELECT * WHERE { BIND(<internal://blank>(<ex://c>) AS ?node) }')).trim())
        .toEqual(`SELECT ( ",iri,6:ex://c"^^<https://sparql-extension.knows.idlab.ugent.be/bnode> AS ?node ) WHERE {
}`);
    }, 60_000);
  });
});
