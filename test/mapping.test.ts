import type * as RDF from '@rdfjs/types';
import { toAst } from '@traqula/algebra-sparql-1-2';
import { describe, it } from 'vitest';
import { VAR_PREFIX_MAPPING, VAR_PREFIX_MERGED_HEAD } from '../lib/consts.js';
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

      // Every mapping variable is prefixed, merged or not, so "its own head" is `?s` under that prefix
      // rather than the `?m_s` the merge coins.
      expect(oneTemplateTriple.head.subject.value).toBe(`${VAR_PREFIX_MAPPING}s`);
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
      expect(() => mappingFromConstructQueries([
        'PREFIX : <ex://>\nCONSTRUCT { "literalSubject" :p ?o } WHERE { ?s :p ?o }',
      ])).toThrow('cannot use Literal in this position');
    });
  });

  /**
   * A CONSTRUCT instantiates its template only for the solutions making a legal triple of it, so a head
   * variable the body could bind to a term its position cannot hold has to be filtered out of the body.
   */
  describe('a head variable the body could bind outside its position', () => {
    it('is filtered where the head permutes the positions the body read', ({ expect }) => {
      // `?o` is read in object position, where a literal is fine, and written in subject position.
      expect(mappingAsStrings(mappingFromConstructQueries([
        'CONSTRUCT { ?o ?p ?s } WHERE { ?s ?p ?o }',
      ])).body).toContain('( ISBLANK( ?mi_o ) || ISIRI( ?mi_o ) )');
    });

    it('is filtered inside a triple term the head constructs', ({ expect }) => {
      expect(mappingAsStrings(mappingFromConstructQueries([
        'PREFIX : <ex://>\nCONSTRUCT { ?t :reifies <<( ?o :p ?s )>> } WHERE { ?t :src ?s . ?s :p ?o }',
      ])).body).toContain('( ISBLANK( ?mi_o ) || ISIRI( ?mi_o ) )');
    });

    it('is left alone where the body already proves the position, filtering nothing at all', ({ expect }) => {
      expect(mappingAsStrings(mappingFromConstructQueries([
        'CONSTRUCT { ?s ?p ?o } WHERE { ?s ?p ?o }',
      ])).body).not.toContain('FILTER');
    });

    it('is left alone for a view that means to present generalized RDF', ({ expect }) => {
      expect(mappingAsStrings(mappingFromConstructQueries(
        [ 'CONSTRUCT { ?o ?p ?s } WHERE { ?s ?p ?o }' ],
        { generalizedRdfView: true },
      )).body).not.toContain('FILTER');
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
