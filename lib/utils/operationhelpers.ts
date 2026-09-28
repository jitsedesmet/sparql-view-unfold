import type * as RDF from '@rdfjs/types';
import { Algebra } from '@traqula/algebra-transformations-1-2';
import type { TransformationContext } from '../transformContext.js';
import { datatypeBoolean, DF } from './rdfDatatypes.js';

/** The literal `false` with xsd:boolean datatype, used for FILTER(FALSE) patterns */
export const termFalse = DF.literal('false', datatypeBoolean);

/** The literal `true` with xsd:boolean datatype, the condition of a filter that constrains nothing */
export const termTrue = DF.literal('true', datatypeBoolean);

/**
 * Whether an operation is the `FILTER(FALSE)` sentinel for a pattern that never matches.
 * @param c - The transformation context
 * @param op - The operation to check
 * @returns whether it is that sentinel
 */
export function isFilterFalse(c: TransformationContext, op: Algebra.Operation): boolean {
  return op.type === Algebra.Types.FILTER && isExpressionFalse(c, op.expression);
}

/**
 * Whether an expression is the `FALSE` term, the condition of `FILTER(FALSE)` or of a LEFT JOIN that never matches.
 * @param c - The transformation context
 * @param op - The expression to check
 * @returns whether it is the `FALSE` term
 */
export function isExpressionFalse(c: TransformationContext, op: Algebra.Expression): boolean {
  return op.subType === Algebra.ExpressionTypes.TERM && op.term.equals(termFalse);
}

/**
 * Creates the `FILTER(FALSE)` that represents an empty result set: in SPARQL algebra the empty multiset,
 * absorbing for JOIN and identity for UNION.
 * @param c - The transformation context
 * @param op - The operation it replaces, kept as its input so that the node carries that operation's
 * `pVars`; an empty BGP by default, which carries none
 * @returns the filter
 */
export function createFilterFalse(c: TransformationContext, op?: Algebra.Operation): Algebra.Filter {
  return c.AF.createFilter(op ?? c.AF.createBgp([]), c.AF.createTermExpression(termFalse));
}

/**
 * The term one row of a VALUES holds for a column, read as an own property so that a column named after a
 * member of `Object.prototype` (`?valueOf`) is not mistaken for one the row binds.
 * @param row - The row to read
 * @param variableName - The column to read it at
 * @returns the term, or `undefined` for `UNDEF`
 */
export function termOfValuesRow(
  row: Algebra.Values['bindings'][number],
  variableName: string,
): RDF.Literal | RDF.NamedNode | undefined {
  return Object.hasOwn(row, variableName) ? row[variableName] : undefined;
}

/**
 * The GROUP at the bottom of the EXTEND / FILTER / ORDER_BY chain at the top of an operation: the grouping
 * that chain's select expressions, `HAVING` and `ORDER BY` are computed over, and which `toAst` prints
 * together with the chain as one SELECT.
 * @param op - The operation whose chain to read
 * @returns the GROUP, or `undefined` when the chain stands on anything else
 */
export function groupBelowTopLevelChain(op: Algebra.Operation): Algebra.Group | undefined {
  let current = op;
  while (
    current.type === Algebra.Types.EXTEND ||
    current.type === Algebra.Types.FILTER ||
    current.type === Algebra.Types.ORDER_BY
  ) {
    current = current.input;
  }
  return current.type === Algebra.Types.GROUP ? current : undefined;
}

/**
 * Wraps an operation in the projection that asks whether it has any solution at all.
 *
 * SPARQL has neither a sub-ASK nor an empty projection, so the question is written as a projection onto a
 * single variable bound to a constant: one solution comes out exactly when the operation has one, whatever
 * that operation binds
 * ([proof this works](https://query.comunica.dev/#transientDatasources=%2F%2Ffragments.dbpedia.org%2F2016-04%2Fen&query=SELECT%20*%0AWHERE%20%7B%0A%20%20%3Fs%20%3Fp%20%3Fo%20.%0A%20%20%7B%20SELECT%20%281%20as%20%3Fdummy%29%20WHERE%20%7B%0A%20%20%20%20%20%20%3Chttp%3A%2F%2F0-access.newspaperarchive.com.lib.utep.edu%2Fus%2Fmississippi%2Fbiloxi%2Fbiloxi-daily-herald%2F1899%2F05-06%2Fpage-6%3Ftag%3Dtierce%2Bwine%26rtserp%3Dtags%2Ftierce-wine%3Fpage%3D2%3E%0A%20%20%20%20%20%20%3Chttp%3A%2F%2Fdbpedia.org%2Fproperty%2Fdate%3E%0A%20%20%20%20%20%20%221899-05-05%22%5E%5E%3Chttp%3A%2F%2Fwww.w3.org%2F2001%2FXMLSchema%23date%3E%0A%20%20%20%20%20%20%23%20%221899-05-06%22%5E%5E%3Chttp%3A%2F%2Fwww.w3.org%2F2001%2FXMLSchema%23date%3E%0A%20%20%20%7D%20%7D%0A%7D)).
 *
 * The variable it binds leaves the projection, so the context coins it: two of them sharing a name would
 * share a join key, and a MINUS decides compatibility on exactly the variables its two sides share.
 * @param c - Object containing the factories and the existence variable generator
 * @param operation - The operation to ask about
 * @returns the projection, over the one variable it binds
 */
export function projectSolutionExistence(
  c: Pick<TransformationContext, 'AF' | 'DF' | 'coinExistenceVariable'>,
  operation: Algebra.Operation,
): Algebra.Project {
  const existenceVariable = c.coinExistenceVariable();
  return c.AF.createProject(
    c.AF.createExtend(operation, existenceVariable, c.AF.createTermExpression(c.DF.literal('dummy'))),
    [ existenceVariable ],
  );
}
