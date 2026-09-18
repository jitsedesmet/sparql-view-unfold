import type * as RDF from '@rdfjs/types';
import { toAst } from '@traqula/algebra-sparql-1-2';
import { describe, it } from 'vitest';
import { VAR_PREFIX_MERGED_HEAD } from '../lib/consts.js';
import { mappingFromConstructQueries } from '../lib/mapping.js';
import { createTransformationContext } from '../lib/transformContext.js';
import type { Mapping } from '../lib/types.js';

const { generator } = createTransformationContext();

/** How a head term reads, recursing into a triple term. */
function headTermAsString(term: RDF.Term): string {
  if (term.termType === 'Quad') {
    return `<<( ${[ term.subject, term.predicate, term.object ].map(headTermAsString).join(' ')} )>>`;
  }
  return `${term.termType}:${term.value}`;
}

/**
 * A mapping as the two strings it is worth comparing: `toEqual` cannot see through the `cVars` metadata
 * the algebra carries, and the generated body is what the unfolding will actually inline anyway.
 */
function mappingAsStrings(mapping: Mapping): { head: string; body: string } {
  return {
    head: [ mapping.head.subject, mapping.head.predicate, mapping.head.object ].map(headTermAsString).join(' '),
    body: generator.generate(toAst(mapping.body)),
  };
}

describe('mappingFromConstructQueries', () => {
  describe('a template of several triples', () => {
    it('denotes what the same triples as separate CONSTRUCT queries denote', ({ expect }) => {
      const twoTriplesInOneTemplate = mappingFromConstructQueries([ `
        PREFIX : <ex://>
        CONSTRUCT { ?s ?p ?o . ?s :alias ?o } WHERE { ?s ?p ?o }` ]);
      const twoSeparateConstructQueries = mappingFromConstructQueries([
        'CONSTRUCT { ?s ?p ?o } WHERE { ?s ?p ?o }',
        'PREFIX : <ex://>\nCONSTRUCT { ?s :alias ?o } WHERE { ?s ?p ?o }',
      ]);
      expect(mappingAsStrings(twoTriplesInOneTemplate)).toEqual(mappingAsStrings(twoSeparateConstructQueries));
    });

    it('is merged behind the generic head, a single template triple keeping its own', ({ expect }) => {
      const oneTemplateTriple = mappingFromConstructQueries([ 'CONSTRUCT { ?s ?p ?o } WHERE { ?s ?p ?o }' ]);
      const twoTemplateTriples = mappingFromConstructQueries([ `
        PREFIX : <ex://>
        CONSTRUCT { ?s ?p ?o . ?s :alias ?o } WHERE { ?s ?p ?o }` ]);

      // TODO: this expect confuses me? It does not stay the same? Since we check the value is `mi_s` instead of `s`?
      expect(oneTemplateTriple.head.subject.value).toBe('mi_s');
      expect(twoTemplateTriples.head.subject.value).toBe(`${VAR_PREFIX_MERGED_HEAD}s`);
      expect(twoTemplateTriples.head.predicate.value).toBe(`${VAR_PREFIX_MERGED_HEAD}p`);
      expect(twoTemplateTriples.head.object.value).toBe(`${VAR_PREFIX_MERGED_HEAD}o`);
    });
  });

  describe('the head of the resulting mapping', () => {
    it('is the head of a lone mapping, constants and all', ({ expect }) => {
      const mapping = mappingFromConstructQueries([
        'PREFIX : <ex://>\nCONSTRUCT { ?t :reifies ?o } WHERE { ?t :src ?o }',
      ]);
      expect(mapping.head.subject).toEqual(expect.objectContaining({ termType: 'Variable', value: 'mi_t' }));
      expect(mapping.head.predicate).toEqual(expect.objectContaining({ termType: 'NamedNode', value: 'ex://reifies' }));
      expect(mapping.head.object).toEqual(expect.objectContaining({ termType: 'Variable', value: 'mi_o' }));
    });

    it('is the generic one as soon as there are two mappings', ({ expect }) => {
      const mapping = mappingFromConstructQueries([
        'PREFIX : <ex://>\nCONSTRUCT { ?t :reifies ?o } WHERE { ?t :src ?o }',
        'CONSTRUCT { ?s ?p ?o } WHERE { ?s ?p ?o }',
      ]);
      for (const [ position, term ] of <const>[
        [ 's', mapping.head.subject ],
        [ 'p', mapping.head.predicate ],
        [ 'o', mapping.head.object ],
      ]) {
        expect(term).toEqual(expect.objectContaining({
          termType: 'Variable',
          value: `${VAR_PREFIX_MERGED_HEAD}${position}`,
        }));
      }
    });

    it('rejects a term a position does not admit', ({ expect }) => {
      // TODO: nice test! this reminds me, should we add these termType rangeTests to our assertion pushdown?
      //  In case we do for example a mapping `CONSTRUCT { ?o ?p ?s } where { ?s ?p ?o },
      //  then only those bindings where ?o is a literal or blankNode should actually be accepted.
      //   We thus get: `CONSTRUCT { ?o ?p ?s } WHERE { ?s ?p ?o FILTER( isLiteral(?o) || isBlank(?o) ) }`
      //  Note that we only need to add assertions there where the range of ?o
      //  is is larger then the accepted range of the template position it is used in.
      //  There might be value in putting this correctness check behind a context option,
      //  just like we have for preserveCardinality.
      expect(() => mappingFromConstructQueries([
        'PREFIX : <ex://>\nCONSTRUCT { "literalSubject" :p ?o } WHERE { ?s :p ?o }',
      ])).toThrow('cannot use Literal in this position');
    });
  });

  describe('an unstable function in the mapping body', () => {
    function mappingWithBodyBinding(expression: string): () => unknown {
      return () => mappingFromConstructQueries([
        `PREFIX : <ex://>\nCONSTRUCT { ?s :p ?o } WHERE { ?s :src ?o . BIND(${expression} AS ?unstable) }`,
      ]);
    }

    it('is rejected when it is BNODE, naming the function', ({ expect }) => {
      expect(mappingWithBodyBinding('BNODE()')).toThrow('The BNODE function cannot be used in a mapping body');
    });

    it('is rejected when it is RAND, naming the function', ({ expect }) => {
      expect(mappingWithBodyBinding('RAND()')).toThrow('The RAND function cannot be used in a mapping body');
    });

    it('is rejected when it is UUID, naming the function', ({ expect }) => {
      expect(mappingWithBodyBinding('UUID()')).toThrow('The UUID function cannot be used in a mapping body');
    });

    it('is rejected when it is STRUUID, naming the function', ({ expect }) => {
      expect(mappingWithBodyBinding('STRUUID()')).toThrow('The STRUUID function cannot be used in a mapping body');
    });

    // NOW is fixed per query execution (SPARQL 1.1 §17.4.5.1), so it denotes one graph like any constant.
    it('is accepted when it is NOW', ({ expect }) => {
      expect(mappingWithBodyBinding('NOW()')).not.toThrow();
    });
  });
});
