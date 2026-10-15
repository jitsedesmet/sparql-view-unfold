import { QueryEngine } from '@comunica/query-sparql-file';
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

// The value of `?node` in every solution of the rewritten query.
async function constructedNodes(
  rewriter: QueryRewriter,
  query: string,
  source: string,
): Promise<(string | undefined)[]> {
  const bindings = await new QueryEngine().queryBindings(await rewriter.rewriteQuery(query), { sources: [ source ]});
  return (await bindings.toArray()).map(binding => binding.get('node')?.value);
}

describe('bnode skolem', () => {
  const c = createTransformationContext();
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

  it.skip('skolem to literal one var param', async({ expect }) => {
    const bnodeNoParams = AF.createNamedExpression(DF.namedNode('internal://blank'), [
      AF.createTermExpression(DF.variable('myVar')),
    ]);
    expect(internalBnodeAsSpecialLiteral(c, bnodeNoParams))
      .toEqual(AF.createOperatorExpression('strdt', [
        AF.createOperatorExpression('struuid', []),
        AF.createTermExpression(DF.namedNode(DT_INTERNAL_BNODE)),
      ]));
  });

  it('constructs the same node in every pattern it is unfolded into', async({ expect }) => {
    const rewriter = createQueryRewriter([ ...createDefaultTransformationPipeline(mappingFromConstructQueries([
      `CONSTRUCT { ?node <ex://first> ?first . ?node <ex://second> ?second } WHERE {
        ?subject <ex://p1> ?first . ?subject <ex://p2> ?second .
        BIND(<internal://blank>(?subject, ?first, ?second) AS ?node)
      }`,
    ])), internalBnodeAsSpecialIriTransformation() ]);
    await expect(constructedNodes(
      rewriter,
      'SELECT * WHERE { ?node <ex://first> ?first . ?node <ex://second> ?second }',
      './test/statics/data01.ttl',
    )).resolves.toHaveLength(1);
  });

  describe('with an argument an OPTIONAL leaves unbound', () => {
    // `?x` is bound for the `<ex://o1>` solution only, and both solutions share `?s`.
    const rewriter = createQueryRewriter([ ...createDefaultTransformationPipeline(mappingFromConstructQueries([
      `CONSTRUCT { ?node <ex://object> ?o } WHERE {
        ?s ?p ?o .
        OPTIONAL { ?x <ex://p1> ?o }
        BIND(<internal://blank>(?s, ?x) AS ?node)
      }`,
    ])), internalBnodeAsSpecialIriTransformation() ]);

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
    // The data holds `<a> <p1> <o1>` and two triples differing from it in one position.
    function nodesFrom(tripleTerm: string, query: string): Promise<(string | undefined)[]> {
      const rewriter = createQueryRewriter([ ...createDefaultTransformationPipeline(mappingFromConstructQueries([
        `CONSTRUCT { ?node <ex://subject> ?s . ?node <ex://object> ?o } WHERE {
          ?s ?p ?o .
          BIND(${tripleTerm} AS ?t)
          BIND(<internal://blank>(?t) AS ?node)
        }`,
      ])), internalBnodeAsSpecialIriTransformation() ]);
      return constructedNodes(rewriter, query, './test/statics/tripleTermArguments.ttl');
    }

    it('constructs a different node for each triple term', async({ expect }) => {
      const nodes = await nodesFrom('<<( ?s ?p ?o )>>', 'SELECT ?node WHERE { ?node <ex://subject> ?s }');
      expect(nodes).toHaveLength(3);
      expect(nodes).not.toContain(undefined);
      expect(new Set(nodes).size).toBe(3);
    });

    // The join on `?node` keeps a solution only when both patterns constructed the same node.
    it('constructs the same node for the same triple term in every pattern', async({ expect }) => {
      await expect(nodesFrom(
        '<<( ?s ?p ?o )>>',
        'SELECT ?node WHERE { ?node <ex://subject> ?s . ?node <ex://object> ?o }',
      )).resolves.toHaveLength(3);
    });

    it('constructs a node for a triple term nested in the object of one', async({ expect }) => {
      const nodes = await nodesFrom(
        '<<( ?s ?p <<( ?s ?p ?o )>> )>>',
        'SELECT ?node WHERE { ?node <ex://subject> ?s }',
      );
      expect(nodes).toHaveLength(3);
      expect(nodes).not.toContain(undefined);
      expect(new Set(nodes).size).toBe(3);
    });

    // The second is nested three deep, one more than the default depth, so neither form constructs a node.
    it.for(<const> [
      [ '<<( <ex://a> <ex://p1> <ex://o1> )>>', true ],
      [ '<<( <ex://a> <ex://p1> <<( <ex://a> <ex://p1> <<( <ex://a> <ex://p1> <ex://o1> )>> )>> )>>', false ],
    ])('constructs the same node for %s written out as for a variable bound to it', async([
      tripleTerm,
      constructsNode,
    ], { expect }) => {
      const query = await createQueryRewriter([ internalBnodeAsSpecialIriTransformation() ]).rewriteQuery(`SELECT * {
        BIND(${tripleTerm} AS ?t)
        BIND(<internal://blank>(?t) AS ?fromVariable)
        BIND(<internal://blank>(${tripleTerm}) AS ?fromConstant)
      }`);
      const bindings = await new QueryEngine().queryBindings(query, {
        sources: [ './test/statics/tripleTermArguments.ttl' ],
      });
      const [ binding ] = await bindings.toArray();
      expect(binding.has('fromVariable')).toBe(constructsNode);
      expect(binding.get('fromConstant')?.value).toBe(binding.get('fromVariable')?.value);
    });
  });

  it.for(<const> [
    [ 'a typed literal', internalBnodeAsSpecialLiteralTransformation() ],
    [ 'a prefixed IRI', internalBnodeAsSpecialIriTransformation() ],
  ])('recognises a node materialised as %s as a blank node', async([ , transformation ], { expect }) => {
    const rewriter = createQueryRewriter([ transformation ]);
    await expect(constructedNodes(
      rewriter,
      'SELECT ?node WHERE { ?s ?p ?o . BIND(<internal://blank>(?s) AS ?node) FILTER(ISBLANK(?node)) }',
      './test/statics/tripleTermArguments.ttl',
    )).resolves.toHaveLength(3);
    await expect(constructedNodes(
      rewriter,
      'SELECT ?node WHERE { ?node ?p ?o . FILTER(ISBLANK(?node)) }',
      './test/statics/tripleTermArguments.ttl',
    )).resolves.toHaveLength(0);
  });

  it('refuses a triple term argument depth that is not a non-negative integer', async({ expect }) => {
    expect(() => createTransformationContext({ tripleTermArgumentDepth: -1 })).toThrow('non-negative integer');
    await expect(createQueryRewriter([], { tripleTermArgumentDepth: 1.5 }).rewriteQuery('SELECT * {}'))
      .rejects.toThrow('non-negative integer');
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

    // `?o` may be a literal, which a subject does not admit: the construction may fail, so it is read through.
    it('encodes a written triple term that may fail to construct through its accessors', async({ expect }) => {
      expect((await rewriter.rewriteQuery(`SELECT ?node WHERE {
        ?s ?p ?o .
        BIND(<internal://blank>(<<( ?o ?p ?s )>>) AS ?node)
      }`)).trim()).toEqual(`SELECT ( STRDT( CONCAT( ${tripleTermEncoding('<<( ?o ?p ?s )>>')} ) , <https://sparql-extension.knows.idlab.ugent.be/bnode> ) AS ?node ) WHERE {
  ?s ?p ?o .
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
