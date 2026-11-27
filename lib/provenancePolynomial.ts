import type * as RDF from '@rdfjs/types';
import { termToString } from 'rdf-string';

/**
 * @fileoverview How-provenance polynomials (SPARQLprov, Def. 4.15), and their decoding from the rows of a
 * {@link provenance!provenanceCapturingQuery} (Def. 4.10).
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
  | { type: 'difference'; left: ProvenancePolynomial; right: ProvenancePolynomial }
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
 * The node kinds of a polynomial tree: Σ, ⊕, ⊗, ⊖, ⊙ and δ as SPARQLprov's implementation names them, and `one`, the
 * leaf of a solution produced from no view triple.
 */
const nodeKinds = <const> [ 'sum', 'osum', 'product', 'difference', 'statement', 'aggregate', 'one' ];

/** A node kind of a polynomial tree. */
export type ProvenanceNodeKind = typeof nodeKinds[number];

/**
 * Names the provenance variable of a node: its prefix, the path to it from the root, followed by its kind. That name
 * is the prefix of a Σ or δ node's one child, and starts that of an n-ary node's children.
 * @param prefix - The prefix of the node
 * @param kind - The node's kind
 * @returns the variable name
 */
export function provenanceNodeVariableName(prefix: string, kind: ProvenanceNodeKind): string {
  return `${prefix}_${kind}`;
}

/**
 * Whether a variable is a provenance variable of a capture.
 * @param prefix - The capture's provenance variable prefix
 * @param name - The variable's name
 * @returns whether it starts with the prefix
 */
export function isProvenanceVariableName(prefix: string, name: string): boolean {
  return name.startsWith(`${prefix}_`);
}

/**
 * The prefix of an n-ary (⊕, ⊗ or ⊖) node's child.
 * @param nodeVariableName - The node's variable name
 * @param index - The child's index, from 1
 * @returns the child's prefix
 */
export function provenanceChildPrefix(nodeVariableName: string, index: number): string {
  return `${nodeVariableName}_${index}`;
}

/** A row of a provenance table: the bound variables of one solution of a rewritten query, by name. */
type ProvenanceRow = ReadonlyMap<string, RDF.Term>;

/** The structure of a provenance table, read off its variables once. */
interface ProvenanceColumns {
  /** The kind of the node at each prefix. */
  kindOf: ReadonlyMap<string, ProvenanceNodeKind>;
  /** The indices of the children of each n-ary node, in order, by the node's variable name. */
  childIndicesOf: ReadonlyMap<string, number[]>;
}

/**
 * Reads the kind of every node and the children of every n-ary node off the variables of a provenance table.
 * @param rows - The rows of the table
 * @returns the structure
 */
function provenanceColumnsOf(rows: readonly ProvenanceRow[]): ProvenanceColumns {
  const names = new Set<string>();
  for (const row of rows) {
    for (const name of row.keys()) {
      names.add(name);
    }
  }
  const kindOf = new Map<string, ProvenanceNodeKind>();
  const childIndices = new Map<string, Set<number>>();
  for (const name of names) {
    // Every provenance variable is a node's: its prefix, then its kind.
    const separator = name.lastIndexOf('_');
    const kind = <ProvenanceNodeKind> name.slice(separator + 1);
    if (!nodeKinds.includes(kind)) {
      continue;
    }
    const prefix = name.slice(0, separator);
    kindOf.set(prefix, kind);
    const [ , parentNodeVariableName, index ] = /^(.*)_(\d+)$/u.exec(prefix) ?? [];
    if (parentNodeVariableName !== undefined) {
      const indices = childIndices.get(parentNodeVariableName) ?? new Set<number>();
      childIndices.set(parentNodeVariableName, indices.add(Number(index)));
    }
  }
  return {
    kindOf,
    childIndicesOf: new Map([ ...childIndices ]
      .map(([ name, indices ]) => [ name, [ ...indices ].sort((left, right) => left - right) ])),
  };
}

/**
 * Groups items by a key.
 * @param items - The items to group
 * @param keyOf - Gives the key of an item
 * @returns the groups, in the order their first item came
 */
function groupBy<T>(items: Iterable<T>, keyOf: (item: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const key = keyOf(item);
    const group = groups.get(key);
    if (group === undefined) {
      groups.set(key, [ item ]);
    } else {
      group.push(item);
    }
  }
  return groups;
}

/**
 * Sums the polynomials of the subtables at a prefix, one per value of its root (SPARQLprov, Def. 4.7).
 * @param columns - The structure of the table
 * @param rows - The rows of the table
 * @param prefix - The prefix of the subtables' variables
 * @returns the sum, leaving out rows not binding the root
 */
function sumOfSubtables(columns: ProvenanceColumns, rows: readonly ProvenanceRow[], prefix: string):
ProvenancePolynomial {
  const kind = columns.kindOf.get(prefix);
  if (kind === undefined) {
    return { type: 'sum', operands: []};
  }
  const root = provenanceNodeVariableName(prefix, kind);
  const subtables = groupBy(rows.filter(row => row.has(root)), row => termToString(row.get(root)!));
  return {
    type: 'sum',
    operands: [ ...subtables.values() ].map(subtable => decodeTable(columns, subtable, root, kind)),
  };
}

/**
 * Decodes a provenance table, every row of which binds its root to the same value, into its polynomial (SPARQLprov,
 * Def. 4.10).
 * @param columns - The structure of the table
 * @param rows - The rows of the table
 * @param root - The variable name of its root
 * @param kind - The kind of its root
 * @returns the polynomial
 */
function decodeTable(
  columns: ProvenanceColumns,
  rows: readonly ProvenanceRow[],
  root: string,
  kind: ProvenanceNodeKind,
): ProvenancePolynomial {
  switch (kind) {
    case 'statement':
      return { type: 'source', term: rows[0].get(root)! };
    case 'one':
      return { type: 'constant', value: 1 };
    case 'sum':
      return sumOfSubtables(columns, rows, root);
    case 'aggregate':
      return { type: 'aggregate', operand: sumOfSubtables(columns, rows, root) };
    case 'osum':
    case 'product':
      return {
        type: kind === 'osum' ? 'sum' : 'product',
        operands: (columns.childIndicesOf.get(root) ?? [])
          .map(index => sumOfSubtables(columns, rows, provenanceChildPrefix(root, index))),
      };
    case 'difference':
      return {
        type: 'difference',
        left: sumOfSubtables(columns, rows, provenanceChildPrefix(root, 1)),
        right: sumOfSubtables(columns, rows, provenanceChildPrefix(root, 2)),
      };
  }
}

/**
 * Decodes the rows a provenance capturing query answers into the answers of the original query, each annotated with
 * the polynomial explaining it (SPARQLprov, Def. 4.10).
 * @param bindings - The rows, as an engine like Comunica returns them
 * @param provenanceVariablePrefix - The prefix of the provenance variables, as the capture returned it
 * @returns one annotated answer per distinct answer, its polynomial simplified
 */
export function decodeProvenance(
  bindings: Iterable<RDF.Bindings>,
  provenanceVariablePrefix: string,
): ProvenanceAnnotatedAnswer[] {
  const answerNames = new Set<string>();
  const splitRows = [ ...bindings ].map((binding) => {
    const answer = new Map<string, RDF.Term>();
    const row = new Map<string, RDF.Term>();
    for (const [ variable, term ] of binding) {
      if (isProvenanceVariableName(provenanceVariablePrefix, variable.value)) {
        row.set(variable.value, term);
      } else {
        answer.set(variable.value, term);
        answerNames.add(variable.value);
      }
    }
    return { answer, row };
  });
  const sortedAnswerNames = [ ...answerNames ].sort();
  // JSON keeps a term's quotes and spaces from running into the next variable's.
  const rowsByAnswer = groupBy(splitRows, ({ answer }) => JSON.stringify(sortedAnswerNames.map((name) => {
    const term = answer.get(name);
    return term === undefined ? null : termToString(term);
  })));
  const columns = provenanceColumnsOf(splitRows.map(({ row }) => row));
  return [ ...rowsByAnswer.values() ].map((group) => {
    // An answer's rows may hold several values of the root, such as one per group of an aggregate.
    const polynomial = simplifyPolynomial(
      sumOfSubtables(columns, group.map(({ row }) => row), provenanceVariablePrefix),
    );
    return {
      answer: group[0].answer,
      polynomial,
      isAnswer: evaluatePolynomial(polynomial, booleanSpmSemiring, () => true),
    };
  });
}

/**
 * Evaluates a polynomial in an spm-semiring, the homomorphism its sources' values induce.
 * @param polynomial - The polynomial to evaluate
 * @param semiring - The spm-semiring to evaluate it in
 * @param valueOf - Gives the value of a source
 * @returns the polynomial's value
 */
export function evaluatePolynomial<T>(
  polynomial: ProvenancePolynomial,
  semiring: SpmSemiring<T>,
  valueOf: (source: RDF.Term) => T,
): T {
  switch (polynomial.type) {
    case 'constant': {
      let value = semiring.zero;
      for (let count = 0; count < polynomial.value; count++) {
        value = semiring.plus(value, semiring.one);
      }
      return value;
    }
    case 'source':
      return valueOf(polynomial.term);
    case 'sum':
      return polynomial.operands.reduce((value, operand) =>
        semiring.plus(value, evaluatePolynomial(operand, semiring, valueOf)), semiring.zero);
    case 'product':
      return polynomial.operands.reduce((value, operand) =>
        semiring.times(value, evaluatePolynomial(operand, semiring, valueOf)), semiring.one);
    case 'difference':
      return semiring.monus(
        evaluatePolynomial(polynomial.left, semiring, valueOf),
        evaluatePolynomial(polynomial.right, semiring, valueOf),
      );
    case 'aggregate':
      return semiring.aggregate(evaluatePolynomial(polynomial.operand, semiring, valueOf));
  }
}

/**
 * Simplifies a polynomial by the semiring laws: nested sums and products flattened, `0` and `1` dropped as their
 * identities, and a product holding `0` made `0`. A difference is kept, `x ⊖ 0` included, as it explains an answer.
 * @param polynomial - The polynomial to simplify
 * @returns the simplified polynomial
 */
export function simplifyPolynomial(polynomial: ProvenancePolynomial): ProvenancePolynomial {
  switch (polynomial.type) {
    case 'constant':
    case 'source':
      return polynomial;
    case 'difference':
      return {
        type: 'difference',
        left: simplifyPolynomial(polynomial.left),
        right: simplifyPolynomial(polynomial.right),
      };
    case 'aggregate':
      return { type: 'aggregate', operand: simplifyPolynomial(polynomial.operand) };
    case 'sum':
    case 'product': {
      const identity = polynomial.type === 'sum' ? 0 : 1;
      const operands = polynomial.operands.map(simplifyPolynomial)
        .flatMap(operand => operand.type === polynomial.type ? operand.operands : [ operand ])
        .filter(operand => !(operand.type === 'constant' && operand.value === identity));
      if (polynomial.type === 'product' &&
        operands.some(operand => operand.type === 'constant' && operand.value === 0)) {
        return { type: 'constant', value: 0 };
      }
      if (operands.length <= 1) {
        return operands[0] ?? { type: 'constant', value: identity };
      }
      return { type: polynomial.type, operands };
    }
  }
}

/**
 * Writes a polynomial in infix notation, a source by a label, and the operands of a sum or product in sorted order.
 * @param polynomial - The polynomial to write
 * @param labelOf - Gives the label of a source; by default its rdf-string form
 * @returns the written polynomial
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
    case 'product':
      return `(${polynomial.operands.map(write).sort().join(polynomial.type === 'sum' ? ' ⊕ ' : ' ⊗ ')})`;
    case 'difference':
      return `(${write(polynomial.left)} ⊖ ${write(polynomial.right)})`;
    case 'aggregate':
      return `δ${write(polynomial.operand)}`;
  }
}

/**
 * The lineage of a polynomial: every source it mentions (SPARQLprov's lineage decoding).
 * @param polynomial - The polynomial to read
 * @returns the sources, each once
 */
export function lineageOf(polynomial: ProvenancePolynomial): RDF.Term[] {
  const sources = new Map<string, RDF.Term>();
  // Evaluation visits every source, whatever the semiring.
  evaluatePolynomial(polynomial, countingSpmSemiring, (source) => {
    sources.set(termToString(source), source);
    return 0;
  });
  return [ ...sources.values() ];
}
