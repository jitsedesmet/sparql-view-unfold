import { BindingsFactory } from '@comunica/utils-bindings-factory';
import type * as RDF from '@rdfjs/types';
import { describe, it } from 'vitest';
import type { ProvenancePolynomial } from '../lib/provenancePolynomial.js';
import {
  booleanSpmSemiring,
  countingSpmSemiring,
  decodeProvenance,
  evaluatePolynomial,
  lineageOf,
  polynomialToString,
  simplifyPolynomial,
} from '../lib/provenancePolynomial.js';
import { DF } from '../lib/utils/rdfDatatypes.js';

const BF = new BindingsFactory(DF);
const source = (name: string): ProvenancePolynomial => ({ type: 'source', term: DF.namedNode(name) });

/**
 * Creates a row of a rewritten query's answers.
 * @param entries - The bound variables, an IRI value written as its string
 * @returns the row
 */
function row(entries: Record<string, string>): RDF.Bindings {
  return BF.bindings(Object.entries(entries).map(([ name, value ]) => [ DF.variable(name), DF.namedNode(value) ]));
}

describe('decodeProvenance', () => {
  it('decodes SPARQLprov\'s Example 4.11 into the polynomials of Example 4.5', ({ expect }) => {
    // Females without an occupation: GM, with occupation s12, and OT, with occupations s22 and s24, are not answers.
    const rows = [
      [ 'GM', 's11', 's12' ],
      [ 'OT', 's21', 's22' ],
      [ 'OT', 's21', 's24' ],
    ].map(([ person, gender, occupation ]) => row({
      person,
      prov_sum: person,
      prov_sum_difference: person,
      prov_sum_difference_1_sum: person,
      prov_sum_difference_1_sum_statement: gender,
      prov_sum_difference_2_sum: person,
      prov_sum_difference_2_sum_sum: occupation,
      prov_sum_difference_2_sum_sum_statement: occupation,
    }));

    expect(decodeProvenance(rows, 'prov').map(({ answer, polynomial, isAnswer }) =>
      `${answer.get('person')!.value}: ${polynomialToString(polynomial)} ${isAnswer}`)).toEqual([
      'GM: (s11 ⊖ s12) false',
      'OT: (s21 ⊖ (s22 ⊕ s24)) false',
    ]);
  });

  it('decodes a difference without compatible solutions as the difference with 0', ({ expect }) => {
    const rows = [ row({
      person: 'GM',
      prov_sum: 'GM',
      prov_sum_difference: 'GM',
      prov_sum_difference_1_sum: 'GM',
      prov_sum_difference_1_sum_statement: 's13',
      prov_sum_difference_2_sum: 'GM',
    }) ];

    const [ annotated ] = decodeProvenance(rows, 'prov');
    expect(polynomialToString(annotated.polynomial)).toBe('(s13 ⊖ 0)');
    expect(annotated.isAnswer).toBe(true);
  });

  it('sums the rows of a solution and multiplies the factors of a row', ({ expect }) => {
    // SPARQLprov's Example 4.1: OT is a writer or novelist (s22, s24), female (s21) and awarded (s23).
    const rows = [ 's22', 's24' ].map((occupation, index) => row({
      person: 'OT',
      prov_sum: 'OT',
      prov_sum_product: 'OT',
      prov_sum_product_1_osum: 'OT',
      [`prov_sum_product_1_osum_${index + 1}_sum`]: 'OT',
      [`prov_sum_product_1_osum_${index + 1}_sum_statement`]: occupation,
      prov_sum_product_2_sum: 'OT',
      prov_sum_product_2_sum_statement: 's21',
      prov_sum_product_3_sum: 'OT',
      prov_sum_product_3_sum_statement: 's23',
    }));

    const [ annotated ] = decodeProvenance(rows, 'prov');
    expect(polynomialToString(annotated.polynomial)).toBe('((s22 ⊕ s24) ⊗ s21 ⊗ s23)');
  });
});

describe('simplifyPolynomial', () => {
  it('flattens, drops identities and absorbs into 0, but keeps a difference with 0', ({ expect }) => {
    const polynomial: ProvenancePolynomial = { type: 'sum', operands: [
      { type: 'sum', operands: [ source('a'), { type: 'constant', value: 0 }]},
      { type: 'product', operands: [ source('b'), { type: 'constant', value: 1 }]},
      { type: 'product', operands: [ source('c'), { type: 'constant', value: 0 }]},
      { type: 'difference', minuend: source('d'), subtrahend: { type: 'sum', operands: []}},
    ]};

    expect(polynomialToString(simplifyPolynomial(polynomial))).toBe('((d ⊖ 0) ⊕ a ⊕ b)');
  });
});

describe('evaluatePolynomial', () => {
  const difference: ProvenancePolynomial = { type: 'difference', minuend: source('c'), subtrahend: source('d') };
  const polynomial: ProvenancePolynomial = { type: 'sum', operands: [
    { type: 'product', operands: [ source('a'), source('b') ]},
    difference,
    { type: 'aggregate', operand: { type: 'constant', value: 0 }},
  ]};

  it('counts the times a solution is an answer in the spm-semiring of natural numbers', ({ expect }) => {
    expect(evaluatePolynomial(polynomial, countingSpmSemiring, () => 1)).toBe(2);
    expect(evaluatePolynomial(polynomial, countingSpmSemiring, term => term.value === 'd' ? 0 : 2)).toBe(7);
  });

  it('tells whether a solution is an answer in the Boolean spm-semiring', ({ expect }) => {
    expect(evaluatePolynomial(difference, booleanSpmSemiring, () => true)).toBe(false);
    expect(evaluatePolynomial(difference, booleanSpmSemiring, term => term.value !== 'd')).toBe(true);
  });
});

describe('lineageOf', () => {
  it('lists every source once', ({ expect }) => {
    expect(lineageOf({ type: 'product', operands: [
      source('a'),
      { type: 'difference', minuend: source('a'), subtrahend: source('b') },
    ]}).map(term => term.value)).toEqual([ 'a', 'b' ]);
  });
});
