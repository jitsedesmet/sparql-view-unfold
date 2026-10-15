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

  describe('as a special literal', () => {
    const rewriter = createQueryRewriter([ internalBnodeAsSpecialLiteralTransformation() ]);

    it('encodes an argument an OPTIONAL leaves unbound as a value of its own', async({ expect }) => {
      expect((await rewriter.rewriteQuery(`SELECT ?node WHERE {
        ?person <ex://name> ?name .
        OPTIONAL { ?person <ex://nick> ?nick }
        BIND(<internal://blank>(?nick) AS ?node)
      }`)).trim()).toEqual(String.raw`SELECT ( STRDT( CONCAT( IF( BOUND( ?nick ) , IF( ISIRI( ?nick ) , CONCAT( ",iri," , REPLACE( REPLACE( STR( ?nick ) , "\\\\" , "\\\\\\\\" ) , "," , "\\\\," ) ) , IF( HASLANGDIR( ?nick ) , CONCAT( ",literal@D," , REPLACE( REPLACE( STR( ?nick ) , "\\\\" , "\\\\\\\\" ) , "," , "\\\\," ) , "," , REPLACE( REPLACE( LANG( ?nick ) , "\\\\" , "\\\\\\\\" ) , "," , "\\\\," ) , "," , REPLACE( REPLACE( LANGDIR( ?nick ) , "\\\\" , "\\\\\\\\" ) , "," , "\\\\," ) ) , IF( HASLANG( ?nick ) , CONCAT( ",literal@," , REPLACE( REPLACE( STR( ?nick ) , "\\\\" , "\\\\\\\\" ) , "," , "\\\\," ) , "," , REPLACE( REPLACE( LANG( ?nick ) , "\\\\" , "\\\\\\\\" ) , "," , "\\\\," ) ) , CONCAT( ",literal," , REPLACE( REPLACE( STR( ?nick ) , "\\\\" , "\\\\\\\\" ) , "," , "\\\\," ) , "," , REPLACE( REPLACE( STR( DATATYPE( ?nick ) ) , "\\\\" , "\\\\\\\\" ) , "," , "\\\\," ) ) ) ) ) , ",unbound" ) ) , <https://sparql-extension.knows.idlab.ugent.be/bnode> ) AS ?node ) WHERE {
  ?person <ex://name> ?name .
  OPTIONAL {
    ?person <ex://nick> ?nick .
  }
}`);
    });

    // BOUND only accepts a variable, and a constant is bound anyway.
    it('encodes a constant argument without asking whether it is bound', async({ expect }) => {
      expect((await rewriter.rewriteQuery('SELECT * WHERE { BIND(<internal://blank>(<ex://c>) AS ?node) }')).trim())
        .toEqual(String.raw`SELECT ( STRDT( CONCAT( IF( ISIRI( <ex://c> ) , CONCAT( ",iri," , REPLACE( REPLACE( STR( <ex://c> ) , "\\\\" , "\\\\\\\\" ) , "," , "\\\\," ) ) , IF( HASLANGDIR( <ex://c> ) , CONCAT( ",literal@D," , REPLACE( REPLACE( STR( <ex://c> ) , "\\\\" , "\\\\\\\\" ) , "," , "\\\\," ) , "," , REPLACE( REPLACE( LANG( <ex://c> ) , "\\\\" , "\\\\\\\\" ) , "," , "\\\\," ) , "," , REPLACE( REPLACE( LANGDIR( <ex://c> ) , "\\\\" , "\\\\\\\\" ) , "," , "\\\\," ) ) , IF( HASLANG( <ex://c> ) , CONCAT( ",literal@," , REPLACE( REPLACE( STR( <ex://c> ) , "\\\\" , "\\\\\\\\" ) , "," , "\\\\," ) , "," , REPLACE( REPLACE( LANG( <ex://c> ) , "\\\\" , "\\\\\\\\" ) , "," , "\\\\," ) ) , CONCAT( ",literal," , REPLACE( REPLACE( STR( <ex://c> ) , "\\\\" , "\\\\\\\\" ) , "," , "\\\\," ) , "," , REPLACE( REPLACE( STR( DATATYPE( <ex://c> ) ) , "\\\\" , "\\\\\\\\" ) , "," , "\\\\," ) ) ) ) ) ) , <https://sparql-extension.knows.idlab.ugent.be/bnode> ) AS ?node ) WHERE {
}`);
    });
  });
});
