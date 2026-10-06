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
 * Whether no operand but one can bind a variable, so that a merged solution holds what that one gave it.
 * @param name - The variable to check
 * @param operandIndex - The index of the operand that may bind it
 * @param operands - What each operand of the merge binds
 * @returns whether every other operand never binds it
 */
export function noOtherOperandBinds(name: string, operandIndex: number, operands: readonly CPMeta[]): boolean {
  return operands.every((operand, index) => index === operandIndex || operand.vRanges.neverBinds(name));
}

/**
 * (FJPush)'s side condition for one variable: every merged solution holds the value - or the absence of one -
 * the operand gave it, because the operand binds it certainly or nothing else binds it at all.
 * @param name - The variable to check
 * @param operandIndex - The index of the operand to read it on
 * @param operands - What each operand of the merge binds
 * @returns whether that operand decides the variable
 */
export function operandDecidesVariable(name: string, operandIndex: number, operands: readonly CPMeta[]): boolean {
  return operands[operandIndex].cVars.has(name) || noOtherOperandBinds(name, operandIndex, operands);
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
