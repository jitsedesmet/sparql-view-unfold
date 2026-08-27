import type { Algebra } from '@traqula/algebra-transformations-1-2';
import { algebraUtils } from '@traqula/algebra-transformations-1-2';
import type { TransformContext } from '../transformContext.js';
import { deleteVarExtensionsInPlace, directExtensions } from '../utils.js';

/**
 * Optimization transformation that hoists common variable bindings out of UNION branches.
 *
 * When all branches of a UNION bind the same variable to the same term, that binding
 * can be moved outside the UNION. This reduces redundant computation and can enable
 * further optimizations.
 *
 * @example
 * // Before:
 * // { { ... } BIND(<A> AS ?x) } UNION { { ... } BIND(<A> AS ?x) }
 * // After:
 * // { { ... } UNION { ... } } BIND(<A> AS ?x)
 *
 * This optimization is particularly useful after query rewriting, where many UNION
 * branches may bind common variables (like predicates) to the same static value.
 *
 * @param c - The transformation context
 * @param op - The operation to transform
 * @returns The transformed operation with common bindings hoisted
 */
export function pushUpBoundedFromUnion<T extends Algebra.Operation>(c: TransformContext, op: T): T {
  return algebraUtils.mapOperation<'unsafe', typeof op>(
    op,
    {
      union: {
        transform: (union) => {
          if (union.input.length === 0) {
            return union;
          }
          const first = union.input[0];
          // Start with assignments from first branch; any not in subsequent branches
          // will be removed
          const assignments = directExtensions(first);
          const needsVisit = new Set<string>();
          const nonStaticBoundVars = new Set<string>();

          // Check each subsequent branch
          for (const op of union.input.slice(1)) {
            for (const key of Object.keys(assignments)) {
              needsVisit.add(key);
            }

            for (const [ var_, term ] of Object.entries(directExtensions(op))) {
              needsVisit.delete(var_);
              const assignment = assignments[var_];
              // If bound to different term, cannot hoist
              if (assignment && !assignment.equals(term)) {
                delete assignments[var_];
                nonStaticBoundVars.add(var_);
              }
            }

            // Vars not seen in this branch cannot be hoisted
            for (const key of needsVisit) {
              delete assignments[key];
              nonStaticBoundVars.add(key);
            }
          }

          // Remove the common extensions from each UNION branch
          const staticVars = Object.keys(assignments);
          union.input = union.input.map(op => deleteVarExtensionsInPlace(op, staticVars));

          // Add hoisted bindings after the UNION
          let ret: Algebra.Operation = union;
          for (const [ var_, term ] of Object.entries(assignments)) {
            ret = c.AF.createExtend(ret, c.DF.variable(var_), c.AF.createTermExpression(term));
          }
          return ret;
        },
      },
    },
  );
}
