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

  it('constructs the same node in every pattern it is unfolded into', async({ expect }) => {
    const rewriter = skolemisingRewriter(`CONSTRUCT { ?node <ex://first> ?first . ?node <ex://second> ?second } WHERE {
      ?subject <ex://p1> ?first . ?subject <ex://p2> ?second .
      BIND(<internal://blank>(?subject, ?first, ?second) AS ?node)
    }`);
    await expect(constructedNodes(
      rewriter,
      'SELECT * WHERE { ?node <ex://first> ?first . ?node <ex://second> ?second }',
      './test/statics/data01.ttl',
    )).resolves.toHaveLength(1);
  });

  describe('with an argument an OPTIONAL leaves unbound', () => {
    // `?x` is bound for the `<ex://o1>` solution only, and both solutions share `?s`.
    const rewriter = skolemisingRewriter(`CONSTRUCT { ?node <ex://object> ?o } WHERE {
      ?s ?p ?o .
      OPTIONAL { ?x <ex://p1> ?o }
      BIND(<internal://blank>(?s, ?x) AS ?node)
    }`);

    const nodes = (): Promise<(string | undefined)[]> =>
      constructedNodes(rewriter, 'SELECT ?node WHERE { ?node <ex://object> ?o }', './test/statics/data01.ttl');

    it('still constructs a node for the solution leaving it unbound', async({ expect }) => {
      const constructed = await nodes();
      expect(constructed).toHaveLength(2);
      expect(constructed).not.toContain(undefined);
    });

    it('constructs a different node than for the solution binding it', async({ expect }) => {
      expect(new Set(await nodes()).size).toBe(2);
    });
  });

  describe('with an argument bound to a triple term', () => {
    function nodesFrom(tripleTerm: string, query: string): Promise<(string | undefined)[]> {
      const rewriter = skolemisingRewriter(`CONSTRUCT { ?node <ex://subject> ?s . ?node <ex://object> ?o } WHERE {
        ?s ?p ?o .
        BIND(${tripleTerm} AS ?t)
        BIND(<internal://blank>(?t) AS ?node)
      }`);
      return constructedNodes(rewriter, query, tripleTermData);
    }

    // The second nests a triple term in the object of one.
    it.for([ '<<( ?s ?p ?o )>>', '<<( ?s ?p <<( ?s ?p ?o )>> )>>' ])(
      'constructs a different node for each triple term %s',
      async(tripleTerm, { expect }) => {
        const nodes = await nodesFrom(tripleTerm, 'SELECT ?node WHERE { ?node <ex://subject> ?s }');
        expect(nodes).toHaveLength(3);
        expect(nodes).not.toContain(undefined);
        expect(new Set(nodes).size).toBe(3);
      },
    );

    // The join on `?node` keeps a solution only when both patterns constructed the same node.
    it('constructs the same node for the same triple term in every pattern', async({ expect }) => {
      await expect(nodesFrom(
        '<<( ?s ?p ?o )>>',
        'SELECT ?node WHERE { ?node <ex://subject> ?s . ?node <ex://object> ?o }',
      )).resolves.toHaveLength(3);
    });

    // The second is nested three deep, one more than the default depth, so neither form constructs a node.
    it.for(<const> [
      [ '<<( <ex://a> <ex://p1> <ex://o1> )>>', true ],
      [ '<<( <ex://a> <ex://p1> <<( <ex://a> <ex://p1> <<( <ex://a> <ex://p1> <ex://o1> )>> )>> )>>', false ],
    ])('constructs the same node for %s written out as for a variable bound to it', async([
      tripleTerm,
      constructsNode,
    ], { expect }) => {
      const [ binding ] = await solutions(iriRewriter, `SELECT * {
        BIND(${tripleTerm} AS ?t)
        BIND(<internal://blank>(?t) AS ?fromVariable)
        BIND(<internal://blank>(${tripleTerm}) AS ?fromConstant)
      }`, tripleTermData);
      expect(binding.has('fromVariable')).toBe(constructsNode);
      expect(binding.get('fromConstant')?.value).toBe(binding.get('fromVariable')?.value);
    });
  });

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

    // The encodings below are the ones the rewritten query writes for `term`.
    function escaped(value: string): string {
      return String.raw`REPLACE( REPLACE( ${value} , "\\\\" , "\\\\\\\\" ) , "," , "\\\\," )`;
    }

    function iriEncoding(term: string): string {
      return `CONCAT( ",iri," , ${escaped(`STR( ${term} )`)} )`;
    }

    function iriOrLiteralEncoding(term: string): string {
      return `IF( ISIRI( ${term} ) , ${iriEncoding(term)} , IF( HASLANGDIR( ${term} ) , CONCAT( ",literal@D," , ${escaped(`STR( ${term} )`)} , "," , ${escaped(`LANG( ${term} )`)} , "," , ${escaped(`LANGDIR( ${term} )`)} ) , IF( HASLANG( ${term} ) , CONCAT( ",literal@," , ${escaped(`STR( ${term} )`)} , "," , ${escaped(`LANG( ${term} )`)} ) , CONCAT( ",literal," , ${escaped(`STR( ${term} )`)} , "," , ${escaped(`STR( DATATYPE( ${term} ) )`)} ) ) ) )`;
    }

    // A term that is a triple term, unrolled `depth` triple terms deep.
    function tripleTermEncoding(term: string, depth = 2): string {
      return `CONCAT( ",triple" , ${iriEncoding(`SUBJECT( ${term} )`)} , ${iriEncoding(`PREDICATE( ${term} )`)} , ${termEncoding(`OBJECT( ${term} )`, depth - 1)} )`;
    }

    // Whether `term` evaluates rather than errors.
    function evaluates(term: string): string {
      return `COALESCE( SAMETERM( ${term} , ${term} ) , FALSE )`;
    }

    // A term that can be any term, unrolled `depth` triple terms deep.
    function termEncoding(term: string, depth = 2): string {
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
      }`)).trim()).toEqual(String.raw`SELECT ( STRDT( CONCAT( IF( BOUND( ?nick ) , IF( ISTRIPLE( ?nick ) , CONCAT( ",triple" , CONCAT( ",iri," , REPLACE( REPLACE( STR( SUBJECT( ?nick ) ) , "\\\\" , "\\\\\\\\" ) , "," , "\\\\," ) ) , CONCAT( ",iri," , REPLACE( REPLACE( STR( PREDICATE( ?nick ) ) , "\\\\" , "\\\\\\\\" ) , "," , "\\\\," ) ) , IF( ISTRIPLE( OBJECT( ?nick ) ) , CONCAT( ",triple" , CONCAT( ",iri," , REPLACE( REPLACE( STR( SUBJECT( OBJECT( ?nick ) ) ) , "\\\\" , "\\\\\\\\" ) , "," , "\\\\," ) ) , CONCAT( ",iri," , REPLACE( REPLACE( STR( PREDICATE( OBJECT( ?nick ) ) ) , "\\\\" , "\\\\\\\\" ) , "," , "\\\\," ) ) , IF( ISIRI( OBJECT( OBJECT( ?nick ) ) ) , CONCAT( ",iri," , REPLACE( REPLACE( STR( OBJECT( OBJECT( ?nick ) ) ) , "\\\\" , "\\\\\\\\" ) , "," , "\\\\," ) ) , IF( HASLANGDIR( OBJECT( OBJECT( ?nick ) ) ) , CONCAT( ",literal@D," , REPLACE( REPLACE( STR( OBJECT( OBJECT( ?nick ) ) ) , "\\\\" , "\\\\\\\\" ) , "," , "\\\\," ) , "," , REPLACE( REPLACE( LANG( OBJECT( OBJECT( ?nick ) ) ) , "\\\\" , "\\\\\\\\" ) , "," , "\\\\," ) , "," , REPLACE( REPLACE( LANGDIR( OBJECT( OBJECT( ?nick ) ) ) , "\\\\" , "\\\\\\\\" ) , "," , "\\\\," ) ) , IF( HASLANG( OBJECT( OBJECT( ?nick ) ) ) , CONCAT( ",literal@," , REPLACE( REPLACE( STR( OBJECT( OBJECT( ?nick ) ) ) , "\\\\" , "\\\\\\\\" ) , "," , "\\\\," ) , "," , REPLACE( REPLACE( LANG( OBJECT( OBJECT( ?nick ) ) ) , "\\\\" , "\\\\\\\\" ) , "," , "\\\\," ) ) , CONCAT( ",literal," , REPLACE( REPLACE( STR( OBJECT( OBJECT( ?nick ) ) ) , "\\\\" , "\\\\\\\\" ) , "," , "\\\\," ) , "," , REPLACE( REPLACE( STR( DATATYPE( OBJECT( OBJECT( ?nick ) ) ) ) , "\\\\" , "\\\\\\\\" ) , "," , "\\\\," ) ) ) ) ) ) , IF( ISIRI( OBJECT( ?nick ) ) , CONCAT( ",iri," , REPLACE( REPLACE( STR( OBJECT( ?nick ) ) , "\\\\" , "\\\\\\\\" ) , "," , "\\\\," ) ) , IF( HASLANGDIR( OBJECT( ?nick ) ) , CONCAT( ",literal@D," , REPLACE( REPLACE( STR( OBJECT( ?nick ) ) , "\\\\" , "\\\\\\\\" ) , "," , "\\\\," ) , "," , REPLACE( REPLACE( LANG( OBJECT( ?nick ) ) , "\\\\" , "\\\\\\\\" ) , "," , "\\\\," ) , "," , REPLACE( REPLACE( LANGDIR( OBJECT( ?nick ) ) , "\\\\" , "\\\\\\\\" ) , "," , "\\\\," ) ) , IF( HASLANG( OBJECT( ?nick ) ) , CONCAT( ",literal@," , REPLACE( REPLACE( STR( OBJECT( ?nick ) ) , "\\\\" , "\\\\\\\\" ) , "," , "\\\\," ) , "," , REPLACE( REPLACE( LANG( OBJECT( ?nick ) ) , "\\\\" , "\\\\\\\\" ) , "," , "\\\\," ) ) , CONCAT( ",literal," , REPLACE( REPLACE( STR( OBJECT( ?nick ) ) , "\\\\" , "\\\\\\\\" ) , "," , "\\\\," ) , "," , REPLACE( REPLACE( STR( DATATYPE( OBJECT( ?nick ) ) ) , "\\\\" , "\\\\\\\\" ) , "," , "\\\\," ) ) ) ) ) ) ) , IF( ISIRI( ?nick ) , CONCAT( ",iri," , REPLACE( REPLACE( STR( ?nick ) , "\\\\" , "\\\\\\\\" ) , "," , "\\\\," ) ) , IF( HASLANGDIR( ?nick ) , CONCAT( ",literal@D," , REPLACE( REPLACE( STR( ?nick ) , "\\\\" , "\\\\\\\\" ) , "," , "\\\\," ) , "," , REPLACE( REPLACE( LANG( ?nick ) , "\\\\" , "\\\\\\\\" ) , "," , "\\\\," ) , "," , REPLACE( REPLACE( LANGDIR( ?nick ) , "\\\\" , "\\\\\\\\" ) , "," , "\\\\," ) ) , IF( HASLANG( ?nick ) , CONCAT( ",literal@," , REPLACE( REPLACE( STR( ?nick ) , "\\\\" , "\\\\\\\\" ) , "," , "\\\\," ) , "," , REPLACE( REPLACE( LANG( ?nick ) , "\\\\" , "\\\\\\\\" ) , "," , "\\\\," ) ) , CONCAT( ",literal," , REPLACE( REPLACE( STR( ?nick ) , "\\\\" , "\\\\\\\\" ) , "," , "\\\\," ) , "," , REPLACE( REPLACE( STR( DATATYPE( ?nick ) ) , "\\\\" , "\\\\\\\\" ) , "," , "\\\\," ) ) ) ) ) ) , ",unbound" ) ) , <https://sparql-extension.knows.idlab.ugent.be/bnode> ) AS ?node ) WHERE {
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
      }`)).trim()).toEqual(`SELECT ( STRDT( CONCAT( ${iriEncoding('?s')} ) , <https://sparql-extension.knows.idlab.ugent.be/bnode> ) AS ?node ) WHERE {
  ?s ?p ?o .
}`);
    });

    it('encodes a variable that can be any term with every branch', async({ expect }) => {
      expect((await rewriter.rewriteQuery(`SELECT ?node WHERE {
        ?s ?p ?o .
        BIND(<internal://blank>(?o) AS ?node)
      }`)).trim()).toEqual(`SELECT ( STRDT( CONCAT( ${termEncoding('?o')} ) , <https://sparql-extension.knows.idlab.ugent.be/bnode> ) AS ?node ) WHERE {
  ?s ?p ?o .
}`);
    });

    it('encodes a variable that can only be a triple term without asking whether it is one', async({ expect }) => {
      expect((await rewriter.rewriteQuery(`SELECT ?node WHERE {
        ?s ?p ?o .
        BIND(<<( ?s ?p ?o )>> AS ?t)
        BIND(<internal://blank>(?t) AS ?node)
      }`)).trim()).toEqual(`SELECT ( STRDT( CONCAT( ${tripleTermEncoding('?t')} ) , <https://sparql-extension.knows.idlab.ugent.be/bnode> ) AS ?node ) WHERE {
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
      }`)).trim()).toEqual(`SELECT ( STRDT( CONCAT( ${tripleTermEncoding('?t', 1)} ) , <https://sparql-extension.knows.idlab.ugent.be/bnode> ) AS ?node ) WHERE {
  ?s ?p ?o .
  BIND( <<( ?s ?p ?o )>> AS ?t )
}`);
    });

    it('encodes a triple term written in the argument through its components', async({ expect }) => {
      expect((await rewriter.rewriteQuery(`SELECT ?node WHERE {
        ?s ?p ?o .
        BIND(<internal://blank>(<<( ?s ?p ?o )>>) AS ?node)
      }`)).trim()).toEqual(`SELECT ( STRDT( CONCAT( CONCAT( ",triple" , ${iriEncoding('?s')} , ${iriEncoding('?p')} , ${termEncoding('?o', 1)} ) ) , <https://sparql-extension.knows.idlab.ugent.be/bnode> ) AS ?node ) WHERE {
  ?s ?p ?o .
}`);
    });

    // `?o` may be a literal, which a subject does not admit, so constructing the triple term may fail.
    it('encodes a written triple term that may fail to construct as unbound when it does', async({ expect }) => {
      expect((await rewriter.rewriteQuery(`SELECT ?node WHERE {
        ?s ?p ?o .
        BIND(<internal://blank>(<<( ?o ?p ?s )>>) AS ?node)
      }`)).trim()).toEqual(`SELECT ( STRDT( CONCAT( IF( ${evaluates('<<( ?o ?p ?s )>>')} , CONCAT( ",triple" , ${iriEncoding('?o')} , ${iriEncoding('?p')} , ${iriEncoding('?s')} ) , ",unbound" ) ) , <https://sparql-extension.knows.idlab.ugent.be/bnode> ) AS ?node ) WHERE {
  ?s ?p ?o .
}`);
    });

    // Its encoding reads the argument many times, while the BIND evaluates it once.
    it('binds an expression argument to a variable first', async({ expect }) => {
      expect((await rewriter.rewriteQuery(`SELECT ?node WHERE {
        ?s ?p ?o .
        BIND(<internal://blank>(STR(?o)) AS ?node)
      }`)).trim()).toEqual(`SELECT ( STRDT( CONCAT( IF( BOUND( ?mBnodeArgument0 ) , ${termEncoding('?mBnodeArgument0')} , ",unbound" ) ) , <https://sparql-extension.knows.idlab.ugent.be/bnode> ) AS ?node ) WHERE {
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
      const query = await rewriter.rewriteQuery(`SELECT * WHERE {
        ?s ?p ?o OPTIONAL { ?s ?q ?x FILTER(<internal://blank>(STR(?x)) = ?o) }
      }`);
      expect(query).toContain(`IF( ${evaluates('STR( ?x )')} , ${termEncoding('STR( ?x )')} , ",unbound" )`);
      expect(query).not.toContain('internal://blank');
    });

    // Evaluating an EXISTS again on the same solution gives the same answer.
    it('accepts an EXISTS argument it cannot bind to a variable', async({ expect }) => {
      await expect(rewriter.rewriteQuery(`SELECT * WHERE {
        ?s ?p ?o OPTIONAL { ?s ?q ?x FILTER(<internal://blank>(EXISTS { ?x ?y ?z }) = ?o) }
      }`)).resolves.not.toContain('internal://blank');
    });

    it('refuses an unstable argument it cannot bind to a variable', async({ expect }) => {
      await expect(rewriter.rewriteQuery(`SELECT * WHERE {
        ?s ?p ?o OPTIONAL { ?s ?q ?x FILTER(<internal://blank>(STR(RAND())) = ?o) }
      }`)).rejects.toThrow('like RAND()');
    });

    it('rewrites an ISBLANK in an argument', async({ expect }) => {
      await expect(rewriter.rewriteQuery('SELECT * WHERE { ?s ?p ?o . BIND(<internal://blank>(STR(ISBLANK(?s))) AS ?node) }'))
        .resolves.not.toContain('ISBLANK');
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
      BIND( STRDT( CONCAT( IF( BOUND( ?s ) , ${termEncoding('?s')} , ",unbound" ) ) , <https://sparql-extension.knows.idlab.ugent.be/bnode> ) AS ?node )
    }
  }
  )
}`);
    });

    // BOUND only accepts a variable, and a constant is bound anyway. Its range is its own term type.
    it('encodes a constant argument without asking whether it is bound', async({ expect }) => {
      expect((await rewriter.rewriteQuery('SELECT * WHERE { BIND(<internal://blank>(<ex://c>) AS ?node) }')).trim())
        .toEqual(String.raw`SELECT ( STRDT( CONCAT( CONCAT( ",iri," , REPLACE( REPLACE( STR( <ex://c> ) , "\\\\" , "\\\\\\\\" ) , "," , "\\\\," ) ) ) , <https://sparql-extension.knows.idlab.ugent.be/bnode> ) AS ?node ) WHERE {
}`);
    });
  });
});
