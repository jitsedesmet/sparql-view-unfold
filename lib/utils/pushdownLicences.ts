import type * as RDF from '@rdfjs/types';
import type { Algebra } from '@traqula/algebra-transformations-1-2';
import type { TransformationContext } from '../transformContext.js';
import type { CPMeta } from './certainlyBoundVars.js';

/**
 * @fileoverview The licences the passes moving something past a merge read off the operands' metadata.
 *
 * A JOIN merges compatible solutions, so a condition asked of one operand only answers for the merged
 * solution where that operand decides every value the condition reads. The pushdowns read it to send a
 * filter into an operand, the pull-up to lift a bind out of one.
 */

/**
 * Whether no operand but the given ones can bind a variable, so that a merged solution holds what those gave it.
 * @param name - The variable to check
 * @param ownOperandIndices - The indices of the operands that may bind it
 * @param operands - What each operand of the merge binds
 * @returns whether every other operand never binds it
 */
export function noOtherOperandBinds(
  name: string,
  ownOperandIndices: readonly number[],
  operands: readonly CPMeta[],
): boolean {
  return operands.every((operand, index) => ownOperandIndices.includes(index) || operand.vRanges.neverBinds(name));
}

/**
 * (FJPush)'s side condition: every merged solution holds the value - or the absence of one - the operand gave
 * each variable, because the operand binds it certainly or nothing else binds it at all.
 * @param names - The variables to check
 * @param operandIndex - The index of the operand to read them on
 * @param operands - What each operand of the merge binds
 * @param certainInOperand - What the operand binds certainly, where that is read below the operand's top
 * @returns whether that operand decides every one of them
 */
export function operandDecidesVariables(
  names: Iterable<string>,
  operandIndex: number,
  operands: readonly CPMeta[],
  certainInOperand: ReadonlySet<string> = operands[operandIndex].cVars,
): boolean {
  return [ ...names ].every(name =>
    certainInOperand.has(name) || noOtherOperandBinds(name, [ operandIndex ], operands));
}

/**
 * Whether every operand binds each variable certainly, so that one operand's condition on them holds of every
 * compatible solution of another: what licenses copying a condition into the right side of an OPTIONAL.
 * @param names - The variables to check
 * @param operands - What each operand binds
 * @returns whether all of them are certain everywhere
 */
export function everyOperandBindsCertainly(names: Iterable<string>, operands: readonly CPMeta[]): boolean {
  return [ ...names ].every(name => operands.every(operand => operand.cVars.has(name)));
}

/**
 * Whether what is read below a GRAPH sees the value the GRAPH gives its graph variable, which it binds outside
 * its pattern: the reader does not read it, or the pattern binds it certainly.
 * @param reads - The variables read
 * @param graphName - The name of the GRAPH
 * @param certainInPattern - What the pattern binds certainly
 * @returns whether the reads cross the GRAPH unchanged
 */
export function graphPatternDecides(
  reads: ReadonlySet<string>,
  graphName: RDF.Term,
  certainInPattern: ReadonlySet<string>,
): boolean {
  return graphName.termType !== 'Variable' || !reads.has(graphName.value) || certainInPattern.has(graphName.value);
}

/**
 * The JOIN half of an OPTIONAL, `σ_e(A1 ⋈ A2)`, for a filter above it that rejects every solution of the
 * anti-join half: those are solutions of `A1`, so a variable `A1` never binds is unbound in all of them.
 * @param c - The transformation context
 * @param leftJoin - The OPTIONAL the filter stands on
 * @param requiredBound - The variables the filter rejects every solution leaving unbound
 * @param left - What the left operand binds
 * @returns the JOIN half, or `undefined` when the filter may keep a solution of the anti-join half
 */
export function innerJoinUnderRejectingFilter(
  c: TransformationContext,
  leftJoin: Algebra.LeftJoin,
  requiredBound: Iterable<string>,
  left: CPMeta,
): Algebra.Operation | undefined {
  if (![ ...requiredBound ].some(name => left.vRanges.neverBinds(name))) {
    return undefined;
  }
  const joined = c.AF.createJoin(leftJoin.input, true);
  return leftJoin.expression === undefined ? joined : c.AF.createFilter(joined, leftJoin.expression);
}
