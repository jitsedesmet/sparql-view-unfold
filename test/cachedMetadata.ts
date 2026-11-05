import type { Algebra } from '@traqula/algebra-transformations-1-2';
import type { TransformationContext } from '../lib/transformContext.js';

/**
 * Whether any operation of a tree still carries cached metadata.
 * @param c - The context holding the AST transformer
 * @param op - The tree to check
 * @returns whether one does
 */
export function holdsCachedMetadata(c: Pick<TransformationContext, 'astTransformer'>, op: Algebra.Operation): boolean {
  let found = false;
  c.astTransformer.visitObject(op, (object) => {
    if ('type' in object && 'metadata' in object) {
      found = true;
    }
    return object;
  });
  return found;
}
