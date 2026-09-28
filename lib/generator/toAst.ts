import { toAst12Builder } from '@traqula/algebra-sparql-1-2';
import type { Algebra } from '@traqula/algebra-transformations-1-2';
import { createAstContext } from '@traqula/algebra-transformations-1-2';
import { IndirBuilder } from '@traqula/core';
import type { SparqlQuery } from '@traqula/rules-sparql-1-2';

/**
 * @fileoverview The algebra-to-AST translation the rewriter prints its output with: traqula's, with one rule
 * patched so that a JOIN keeps the scope of each of its operands.
 *
 * traqula's `translateJoin` flattens the patterns of every operand into the one group the JOIN is printed
 * as. That is sound for most operands, but not for a `LEFT_JOIN` or a `MINUS` after the first: SPARQL
 * evaluates an `OPTIONAL` or a `MINUS` against everything that precedes it in its group, so
 * `Join(A, Minus(B, C))` printed as `{ A B MINUS { C } }` reads back as `Minus(Join(A, B), C)`, and `C`
 * starts removing solutions of `A`. Upstream it only goes unnoticed while something else - a `BIND`, a
 * `FILTER` - happens to give the operand braces of its own; a pass that deletes that `BIND` exposes it.
 *
 * TODO: drop this patch once traqula's `translateJoin` groups such an operand itself.
 */

const translatePatternRule = toAst12Builder.getRule('translatePatternNew');
const translateJoinRule = toAst12Builder.getRule('translateJoin');

/**
 * `translateJoin`, wrapping every operand after the first whose patterns hold an `OPTIONAL` or a `MINUS` in
 * a group of its own, so that it reads only its own patterns.
 */
const translateJoinKeepingOperandScopes: typeof translateJoinRule = {
  name: 'translateJoin',
  fun: ({ SUBRULE }) => ({ astFactory: F }, op) => {
    const operandPatterns = op.input.flatMap((operand, operandIndex) => {
      const translated = [ SUBRULE(translatePatternRule, operand) ].flat();
      if (operandIndex > 0 && translated.some(pattern => F.isPatternOptional(pattern) || F.isPatternMinus(pattern))) {
        return [ F.patternGroup(translated, F.gen()) ];
      }
      return translated;
    });
    // Adjacent BGPs merge into one, as upstream: one operand may be a path and the next a BGP.
    const merged: typeof operandPatterns = [];
    for (const pattern of operandPatterns) {
      const previous = merged.at(-1);
      if (previous !== undefined && F.isPatternBgp(previous) && F.isPatternBgp(pattern)) {
        previous.triples.push(...pattern.triples);
      } else {
        merged.push(pattern);
      }
    }
    return merged;
  },
};

const rewriterToAst = IndirBuilder.create(toAst12Builder).patchRule(translateJoinKeepingOperandScopes).build();

/**
 * Translates an operation to a SPARQL 1.2 AST, a JOIN keeping the scope of each of its operands.
 * @param op - The operation to translate
 * @returns its AST, ready for the generator
 */
export function toAst(op: Algebra.Operation): SparqlQuery {
  return rewriterToAst.algToSparql(createAstContext(), op);
}
