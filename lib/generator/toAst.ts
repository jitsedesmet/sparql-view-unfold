import { toAst12Builder } from '@traqula/algebra-sparql-1-2';
import type { Algebra } from '@traqula/algebra-transformations-1-2';
import { createAstContext } from '@traqula/algebra-transformations-1-2';
import { IndirBuilder } from '@traqula/core';

/**
 * @fileoverview `toAst` with the scope of an OPTIONAL and a MINUS kept when they are a JOIN operand.
 *
 * An OPTIONAL or a MINUS applies to everything before it in a group, so the one `toAst` lists in the middle of
 * a JOIN's patterns reads back as `LeftJoin(Join(A, B), C)` where it was `Join(A, LeftJoin(B, C))`.
 */

const translateJoin = toAst12Builder.getRule('translateJoin');
const translatePattern = toAst12Builder.getRule('translatePatternNew');

/** The JOIN rule of `toAst`, grouping an operand that would carry an OPTIONAL or a MINUS into the join. */
const translateJoinKeepingScope: typeof translateJoin = {
  name: 'translateJoin',
  fun: ({ SUBRULE }) => ({ astFactory: F }, op) => {
    const patterns = op.input.flatMap((operand, index) => {
      const translated = [ SUBRULE(translatePattern, operand) ].flat();
      const appliesToWhatPrecedes = translated.some(pattern =>
        F.isPatternOptional(pattern) || F.isPatternMinus(pattern));
      return index > 0 && appliesToWhatPrecedes ? [ F.patternGroup(translated, F.gen()) ] : translated;
    });
    // Adjacent BGPs merge, as `toAst` itself does.
    const merged: typeof patterns = [];
    for (const pattern of patterns) {
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

const toAstTransformer = IndirBuilder.create(toAst12Builder).patchRule(translateJoinKeepingScope).build();

/**
 * Translates an operation to a SPARQL 1.2 AST, keeping the scope of every OPTIONAL and MINUS.
 * @param op - The operation to translate
 * @returns the AST, ready for the generator
 */
export function toAst(op: Algebra.Operation): ReturnType<typeof toAstTransformer.algToSparql> {
  return toAstTransformer.algToSparql(createAstContext(), op);
}
