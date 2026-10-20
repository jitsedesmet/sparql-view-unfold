import type * as RDF from '@rdfjs/types';
import { termToString } from 'rdf-string';

/**
 * @fileoverview How-provenance polynomials in the spm-semiring N[X] (with the lineage operator δ), and their decoding
 * from the rows of a {@link provenance!provenanceCapturingQuery}: SPARQLprov, Def. 4.10 and Def. 4.15.
 */

/**
 * A how-provenance polynomial: a source (a derivation), a constant, or a sum (⊕), product (⊗), difference (⊖) or
 * aggregate lineage (δ) of polynomials.
 */
export type ProvenancePolynomial =
  | { type: 'constant'; value: number }
  | { type: 'source'; term: RDF.Term }
  | { type: 'sum'; operands: ProvenancePolynomial[] }
  | { type: 'product'; operands: ProvenancePolynomial[] }
  | { type: 'difference'; minuend: ProvenancePolynomial; subtrahend: ProvenancePolynomial }
  | { type: 'aggregate'; operand: ProvenancePolynomial };

/**
 * A solution of the rewritten query, with the polynomial explaining it. A difference keeps the solutions it removes,
 * so that their polynomial explains why they are not answers.
 */
export interface ProvenanceAnnotatedAnswer {
  /** The solution, by the names of its bound solution variables. */
  answer: ReadonlyMap<string, RDF.Term>;
  /** The polynomial explaining the solution. */
  polynomial: ProvenancePolynomial;
  /** Whether the solution is an answer of the original query: its polynomial is true in the Boolean spm-semiring. */
  isAnswer: boolean;
}

/** An spm-semiring with the lineage operation δ (SPARQLprov, Def. 4.15), to evaluate a polynomial in. */
export interface SpmSemiring<T> {
  /** The identity of `plus`. */
  zero: T;
  /** The identity of `times`. */
  one: T;
  /** The sum ⊕. */
  plus: (left: T, right: T) => T;
  /** The product ⊗. */
  times: (left: T, right: T) => T;
  /** The difference ⊖. */
  monus: (left: T, right: T) => T;
  /** The lineage δ of an aggregated group. */
  aggregate: (operand: T) => T;
}

/** The Boolean spm-semiring: whether a solution is an answer under set semantics. */
export const booleanSpmSemiring: SpmSemiring<boolean> = {
  zero: false,
  one: true,
  plus: (left, right) => left || right,
  times: (left, right) => left && right,
  monus: (left, right) => left && !right,
  // An aggregate answers once, even over no solutions.
  aggregate: () => true,
};

/** The spm-semiring of natural numbers: how many times a solution is an answer under bag semantics. */
export const countingSpmSemiring: SpmSemiring<number> = {
  zero: 0,
  one: 1,
  plus: (left, right) => left + right,
  times: (left, right) => left * right,
  monus: (left, right) => right === 0 ? left : 0,
  aggregate: () => 1,
};

/**
 * The node kinds of a polynomial tree as provenance variables name them: SPARQLprov's Σ, ⊕, ⊗, ⊖ and ⊙ (Def. 4.6),
 * and δ (Def. 4.15), spelled as SPARQLprov's implementation spells them.
 */
export const provenanceNodeKinds = <const> {
  sum: 'sum',
  osum: 'osum',
  product: 'product',
  difference: 'difference',
  statement: 'statement',
  aggregate: 'aggregate',
};

/** A node kind of {@link provenanceNodeKinds}. */
export type ProvenanceNodeKind = typeof provenanceNodeKinds[keyof typeof provenanceNodeKinds];

const zero: ProvenancePolynomial = { type: 'constant', value: 0 };
const one: ProvenancePolynomial = { type: 'constant', value: 1 };
const nodeKindPattern = Object.values(provenanceNodeKinds).join('|');

/** A row of a provenance table: the bound variables of one solution of a rewritten query, by name. */
type ProvenanceRow = ReadonlyMap<string, RDF.Term>;

/**
 * Finds the node kind a provenance table at a prefix is rooted in.
 * @param rows - The rows of the table.
 * @param prefix - The prefix of its variables.
 * @returns The kind, or `undefined` when no row binds a root.
 */
function rootKindOf(rows: readonly ProvenanceRow[], prefix: string): ProvenanceNodeKind | undefined {
  const rootPattern = new RegExp(`^${prefix}_(${nodeKindPattern})$`, 'u');
  for (const row of rows) {
    for (const name of row.keys()) {
      const match = rootPattern.exec(name);
      if (match) {
        return <ProvenanceNodeKind> match[1];
      }
    }
  }
  return undefined;
}

/**
 * Splits the rows of a table into the subtables of a child, one per value of the child's root (SPARQLprov, Def. 4.7).
 * @param rows - The rows of the table.
 * @param childPrefix - The prefix of the child's variables.
 * @returns The subtables, rows not binding the child's root left out.
 */
function subtablesOf(rows: readonly ProvenanceRow[], childPrefix: string): ProvenanceRow[][] {
  const kind = rootKindOf(rows, childPrefix);
  if (kind === undefined) {
    return [];
  }
  const root = `${childPrefix}_${kind}`;
  const subtables = new Map<string, ProvenanceRow[]>();
  for (const row of rows) {
    const value = row.get(root);
    if (value !== undefined) {
      const key = termToString(value);
      subtables.set(key, [ ...subtables.get(key) ?? [], row ]);
    }
  }
  return [ ...subtables.values() ];
}

/**
 * The sum of the polynomials of a child's subtables.
 * @param rows - The rows of the table.
 * @param childPrefix - The prefix of the child's variables.
 * @returns The sum.
 */
function childSum(rows: readonly ProvenanceRow[], childPrefix: string): ProvenancePolynomial {
  return { type: 'sum', operands: subtablesOf(rows, childPrefix).map(subtable => decodeTable(subtable, childPrefix)) };
}

/**
 * The indices of the children of an n-ary node, in order.
 * @param rows - The rows of the table.
 * @param nodePrefix - The prefix of the node's children, ending in the node's kind.
 * @returns The indices.
 */
function childIndicesOf(rows: readonly ProvenanceRow[], nodePrefix: string): number[] {
  const childPattern = new RegExp(`^${nodePrefix}_(\\d+)_`, 'u');
  const indices = new Set<number>();
  for (const row of rows) {
    for (const name of row.keys()) {
      const match = childPattern.exec(name);
      if (match) {
        indices.add(Number(match[1]));
      }
    }
  }
  return [ ...indices ].sort((left, right) => left - right);
}

/**
 * Decodes a provenance table into its polynomial (SPARQLprov, Def. 4.10).
 * @param rows - The rows of the table.
 * @param prefix - The prefix of its variables.
 * @returns The polynomial; `0` for a table without rows.
 */
function decodeTable(rows: readonly ProvenanceRow[], prefix: string): ProvenancePolynomial {
  const kind = rootKindOf(rows, prefix);
  const nodePrefix = `${prefix}_${kind}`;
  switch (kind) {
    case undefined:
      return zero;
    case 'statement': {
      const value = rows[0].get(nodePrefix);
      if (value === undefined) {
        return zero;
      }
      return value.termType === 'Literal' ?
          { type: 'constant', value: Number(value.value) } :
          { type: 'source', term: value };
    }
    case 'sum':
      return childSum(rows, nodePrefix);
    case 'aggregate':
      return { type: 'aggregate', operand: childSum(rows, nodePrefix) };
    case 'osum':
    case 'product':
      return {
        type: kind === 'osum' ? 'sum' : 'product',
        operands: childIndicesOf(rows, nodePrefix).map(index => childSum(rows, `${nodePrefix}_${index}`)),
      };
    case 'difference':
      return {
        type: 'difference',
        minuend: childSum(rows, `${nodePrefix}_1`),
        subtrahend: childSum(rows, `${nodePrefix}_2`),
      };
  }
}

/**
 * Decodes the rows a provenance capturing query answers into the answers of the original query, each annotated with
 * the polynomial explaining it (SPARQLprov, Def. 4.10).
 * @param bindings - The rows, as an engine like Comunica returns them.
 * @param provenanceVariablePrefix - The prefix of the provenance variables, as the capture returned it.
 * @returns One annotated answer per distinct answer, its polynomial simplified.
 */
export function decodeProvenance(
  bindings: Iterable<RDF.Bindings>,
  provenanceVariablePrefix: string,
): ProvenanceAnnotatedAnswer[] {
  const provenanceVariable = new RegExp(`^${provenanceVariablePrefix}_`, 'u');
  const rowsByAnswer = new Map<string, { answer: Map<string, RDF.Term>; rows: ProvenanceRow[] }>();
  for (const binding of bindings) {
    const answer = new Map<string, RDF.Term>();
    const row = new Map<string, RDF.Term>();
    for (const [ variable, term ] of binding) {
      (provenanceVariable.test(variable.value) ? row : answer).set(variable.value, term);
    }
    const key = [ ...answer ].map(([ name, term ]) => `${name}=${termToString(term)}`).sort().join(' ');
    const group = rowsByAnswer.get(key) ?? { answer, rows: []};
    group.rows.push(row);
    rowsByAnswer.set(key, group);
  }
  return [ ...rowsByAnswer.values() ].map(({ answer, rows }) => {
    const polynomial = simplifyPolynomial(decodeTable(rows, provenanceVariablePrefix));
    return { answer, polynomial, isAnswer: evaluatePolynomial(polynomial, booleanSpmSemiring, () => true) };
  });
}

/**
 * Evaluates a polynomial in an spm-semiring, the homomorphism its sources' values induce.
 * @param polynomial - The polynomial to evaluate.
 * @param semiring - The spm-semiring to evaluate it in.
 * @param valueOf - Gives the value of a source.
 * @returns The polynomial's value.
 */
export function evaluatePolynomial<T>(
  polynomial: ProvenancePolynomial,
  semiring: SpmSemiring<T>,
  valueOf: (source: RDF.Term) => T,
): T {
  const evaluate = (operand: ProvenancePolynomial): T => evaluatePolynomial(operand, semiring, valueOf);
  switch (polynomial.type) {
    case 'constant':
      return Array.from({ length: polynomial.value }, () => semiring.one).reduce(semiring.plus, semiring.zero);
    case 'source':
      return valueOf(polynomial.term);
    case 'sum':
      return polynomial.operands.map(evaluate).reduce(semiring.plus, semiring.zero);
    case 'product':
      return polynomial.operands.map(evaluate).reduce(semiring.times, semiring.one);
    case 'difference':
      return semiring.monus(evaluate(polynomial.minuend), evaluate(polynomial.subtrahend));
    case 'aggregate':
      return semiring.aggregate(evaluate(polynomial.operand));
  }
}

/**
 * Simplifies a polynomial by the semiring laws: nested sums and products flattened, `0` and `1` dropped as their
 * identities, and a product holding `0` made `0`. A difference is kept, `x ⊖ 0` included, as it explains an answer.
 * @param polynomial - The polynomial to simplify.
 * @returns The simplified polynomial.
 */
export function simplifyPolynomial(polynomial: ProvenancePolynomial): ProvenancePolynomial {
  switch (polynomial.type) {
    case 'constant':
    case 'source':
      return polynomial;
    case 'difference':
      return {
        type: 'difference',
        minuend: simplifyPolynomial(polynomial.minuend),
        subtrahend: simplifyPolynomial(polynomial.subtrahend),
      };
    case 'aggregate':
      return { type: 'aggregate', operand: simplifyPolynomial(polynomial.operand) };
    case 'sum':
    case 'product': {
      const identity = polynomial.type === 'sum' ? 0 : 1;
      const operands = polynomial.operands.map(simplifyPolynomial)
        .flatMap(operand => operand.type === polynomial.type ? operand.operands : [ operand ])
        .filter(operand => !(operand.type === 'constant' && operand.value === identity));
      const holdsZero = operands.some(operand => operand.type === 'constant' && operand.value === 0);
      if (polynomial.type === 'product' && holdsZero) {
        return zero;
      }
      if (operands.length <= 1) {
        return operands[0] ?? (polynomial.type === 'sum' ? zero : one);
      }
      return { type: polynomial.type, operands };
    }
  }
}

/**
 * Writes a polynomial in infix notation, a source by a label, and the operands of a sum or product in sorted order.
 * @param polynomial - The polynomial to write.
 * @param labelOf - Gives the label of a source; by default its N-Triples form.
 * @returns The written polynomial.
 */
export function polynomialToString(
  polynomial: ProvenancePolynomial,
  labelOf: (source: RDF.Term) => string = termToString,
): string {
  const write = (operand: ProvenancePolynomial): string => polynomialToString(operand, labelOf);
  switch (polynomial.type) {
    case 'constant':
      return String(polynomial.value);
    case 'source':
      return labelOf(polynomial.term);
    case 'sum':
      return `(${polynomial.operands.map(write).sort().join(' ⊕ ')})`;
    case 'product':
      return `(${polynomial.operands.map(write).sort().join(' ⊗ ')})`;
    case 'difference':
      return `(${write(polynomial.minuend)} ⊖ ${write(polynomial.subtrahend)})`;
    case 'aggregate':
      return `δ${write(polynomial.operand)}`;
  }
}

/**
 * The lineage of a polynomial: every source it mentions (SPARQLprov's lineage decoding).
 * @param polynomial - The polynomial to read.
 * @returns The sources, each once.
 */
export function lineageOf(polynomial: ProvenancePolynomial): RDF.Term[] {
  const sources = new Map<string, RDF.Term>();
  const visit = (operand: ProvenancePolynomial): void => {
    switch (operand.type) {
      case 'constant':
        return;
      case 'source':
        sources.set(termToString(operand.term), operand.term);
        return;
      case 'sum':
      case 'product':
        for (const term of operand.operands) {
          visit(term);
        }
        return;
      case 'difference':
        visit(operand.minuend);
        visit(operand.subtrahend);
        return;
      case 'aggregate':
        visit(operand.operand);
    }
  };
  visit(polynomial);
  return [ ...sources.values() ];
}
