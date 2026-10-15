import { QueryEngine } from '@comunica/query-sparql-file';
import { describe, it } from 'vitest';
import { DT_INTERNAL_BNODE } from '../lib/consts.js';
import { mappingFromConstructQueries } from '../lib/mapping.js';
import { createDefaultTransformationPipeline, createQueryRewriter } from '../lib/queryRewriter.js';
import {
  internalBnodeAsSpecialIriTransformation,
  internalBnodeAsSpecialLiteral,
  internalBnodeAsSpecialLiteralTransformation,
} from '../lib/transformations/bnodeMapAsLiteral.js';
import { createTransformationContext } from '../lib/transformContext.js';

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
    const query = await rewriter.rewriteQuery('SELECT * WHERE { ?node <ex://first> ?first . ?node <ex://second> ?second }');
    const bindings = await new QueryEngine().queryBindings(query, { sources: [ './test/statics/data01.ttl' ]});

    await expect(bindings.toArray()).resolves.toHaveLength(1);
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

    async function constructedNodes(): Promise<(string | undefined)[]> {
      const query = await rewriter.rewriteQuery('SELECT ?node WHERE { ?node <ex://object> ?o }');
      const bindings = await new QueryEngine().queryBindings(query, { sources: [ './test/statics/data01.ttl' ]});
      return (await bindings.toArray()).map(binding => binding.get('node')?.value);
    }

    it('still constructs a node for the solution leaving it unbound', async({ expect }) => {
      const nodes = await constructedNodes();
      expect(nodes).toHaveLength(2);
      expect(nodes).not.toContain(undefined);
    });

    it('constructs a different node than for the solution binding it', async({ expect }) => {
      expect(new Set(await constructedNodes()).size).toBe(2);
    });
  });

  describe('with an argument bound to a triple term', () => {
    // The data holds `<a> <p1> <o1>` and two triples differing from it in one position.
    async function constructedNodes(tripleTerm: string, query: string): Promise<(string | undefined)[]> {
      const rewriter = createQueryRewriter([ ...createDefaultTransformationPipeline(mappingFromConstructQueries([
        `CONSTRUCT { ?node <ex://subject> ?s . ?node <ex://object> ?o } WHERE {
          ?s ?p ?o .
          BIND(${tripleTerm} AS ?t)
          BIND(<internal://blank>(?t) AS ?node)
        }`,
      ])), internalBnodeAsSpecialIriTransformation() ]);
      const bindings = await new QueryEngine().queryBindings(await rewriter.rewriteQuery(query), {
        sources: [ './test/statics/tripleTermArguments.ttl' ],
      });
      return (await bindings.toArray()).map(binding => binding.get('node')?.value);
    }

    it('constructs a node', async({ expect }) => {
      const nodes = await constructedNodes('<<( ?s ?p ?o )>>', 'SELECT ?node WHERE { ?node <ex://subject> ?s }');
      expect(nodes).toHaveLength(3);
      expect(nodes).not.toContain(undefined);
    });

    it('constructs a different node for each triple term', async({ expect }) => {
      const nodes = await constructedNodes('<<( ?s ?p ?o )>>', 'SELECT ?node WHERE { ?node <ex://subject> ?s }');
      expect(new Set(nodes).size).toBe(3);
    });

    // The join on `?node` keeps a solution only when both patterns constructed the same node.
    it('constructs the same node for the same triple term in every pattern', async({ expect }) => {
      await expect(constructedNodes(
        '<<( ?s ?p ?o )>>',
        'SELECT ?node WHERE { ?node <ex://subject> ?s . ?node <ex://object> ?o }',
      )).resolves.toHaveLength(3);
    });

    it('constructs a node for a triple term nested in the object of one', async({ expect }) => {
      const nodes = await constructedNodes(
        '<<( ?s ?p <<( ?s ?p ?o )>> )>>',
        'SELECT ?node WHERE { ?node <ex://subject> ?s }',
      );
      expect(nodes).toHaveLength(3);
      expect(nodes).not.toContain(undefined);
      expect(new Set(nodes).size).toBe(3);
    });

    it('constructs the same node for a triple term constant as for a variable bound to it', async({ expect }) => {
      const query = await createQueryRewriter([ internalBnodeAsSpecialIriTransformation() ]).rewriteQuery(`SELECT * {
        BIND(<<( <ex://a> <ex://p1> <ex://o1> )>> AS ?t)
        BIND(<internal://blank>(?t) AS ?fromVariable)
        BIND(<internal://blank>(<<( <ex://a> <ex://p1> <ex://o1> )>>) AS ?fromConstant)
      }`);
      const bindings = await new QueryEngine().queryBindings(query, {
        sources: [ './test/statics/tripleTermArguments.ttl' ],
      });
      const [ binding ] = await bindings.toArray();
      expect(binding.get('fromConstant')).toBeDefined();
      expect(binding.get('fromConstant')?.equals(binding.get('fromVariable'))).toBe(true);
    });
  });

  describe('as a special literal', () => {
    const rewriter = createQueryRewriter([ internalBnodeAsSpecialLiteralTransformation() ]);

    // The encoding of a term that is an IRI or a literal, as the rewritten query writes it.
    function iriOrLiteralEncoding(term: string): string {
      const escaped = (value: string): string =>
        String.raw`REPLACE( REPLACE( ${value} , "\\\\" , "\\\\\\\\" ) , "," , "\\\\," )`;
      return `IF( ISIRI( ${term} ) , CONCAT( ",iri," , ${escaped(`STR( ${term} )`)} ) , IF( HASLANGDIR( ${term} ) , CONCAT( ",literal@D," , ${escaped(`STR( ${term} )`)} , "," , ${escaped(`LANG( ${term} )`)} , "," , ${escaped(`LANGDIR( ${term} )`)} ) , IF( HASLANG( ${term} ) , CONCAT( ",literal@," , ${escaped(`STR( ${term} )`)} , "," , ${escaped(`LANG( ${term} )`)} ) , CONCAT( ",literal," , ${escaped(`STR( ${term} )`)} , "," , ${escaped(`STR( DATATYPE( ${term} ) )`)} ) ) ) )`;
    }

    // The encoding of a term that is a triple term, nested two deep, as the rewritten query writes it.
    function tripleTermEncoding(term: string): string {
      const object = `OBJECT( ${term} )`;
      const objectEncoding = `IF( ISTRIPLE( ${object} ) , CONCAT( ",triple" , ${iriOrLiteralEncoding(`SUBJECT( ${object} )`)} , ${iriOrLiteralEncoding(`PREDICATE( ${object} )`)} , ${iriOrLiteralEncoding(`OBJECT( ${object} )`)} ) , ${iriOrLiteralEncoding(object)} )`;
      return `CONCAT( ",triple" , ${iriOrLiteralEncoding(`SUBJECT( ${term} )`)} , ${iriOrLiteralEncoding(`PREDICATE( ${term} )`)} , ${objectEncoding} )`;
    }

    // The encoding of a term that can also be a triple term, as the rewritten query writes it.
    function termEncoding(term: string): string {
      return `IF( ISTRIPLE( ${term} ) , ${tripleTermEncoding(term)} , ${iriOrLiteralEncoding(term)} )`;
    }

    it('encodes an argument an OPTIONAL leaves unbound as a value of its own', async({ expect }) => {
      expect((await rewriter.rewriteQuery(`SELECT ?node WHERE {
        ?person <ex://name> ?name .
        OPTIONAL { ?person <ex://nick> ?nick }
        BIND(<internal://blank>(?nick) AS ?node)
      }`)).trim()).toEqual(`SELECT ( STRDT( CONCAT( IF( BOUND( ?nick ) , ${termEncoding('?nick')} , ",unbound" ) ) , <https://sparql-extension.knows.idlab.ugent.be/bnode> ) AS ?node ) WHERE {
  ?person <ex://name> ?name .
  OPTIONAL {
    ?person <ex://nick> ?nick .
  }
}`);
    });

    // A subject is never a triple term, and the pattern binds `?s` in every solution.
    it('encodes a variable that cannot be a triple term as an IRI or a literal only', async({ expect }) => {
      expect((await rewriter.rewriteQuery(`SELECT ?node WHERE {
        ?s ?p ?o .
        BIND(<internal://blank>(?s) AS ?node)
      }`)).trim()).toEqual(`SELECT ( STRDT( CONCAT( ${iriOrLiteralEncoding('?s')} ) , <https://sparql-extension.knows.idlab.ugent.be/bnode> ) AS ?node ) WHERE {
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

    // BOUND only accepts a variable, and a constant is bound anyway. A constant IRI is no triple term either.
    it('encodes a constant argument without asking whether it is bound or a triple term', async({ expect }) => {
      expect((await rewriter.rewriteQuery('SELECT * WHERE { BIND(<internal://blank>(<ex://c>) AS ?node) }')).trim())
        .toEqual(`SELECT ( STRDT( CONCAT( ${iriOrLiteralEncoding('<ex://c>')} ) , <https://sparql-extension.knows.idlab.ugent.be/bnode> ) AS ?node ) WHERE {
}`);
    });
  });
});
