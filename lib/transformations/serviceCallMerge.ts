import { Algebra, algebraUtils } from '@traqula/algebra-transformations-1-2';
import { termToString } from 'rdf-string';
import type { TransformContext } from '../transformContext.js';

/**
 * Merges and hoists SERVICE calls, so that as much of the plan as possible is evaluated by the endpoint
 * rather than around it.
 *
 * Three rewrites: sibling SERVICE calls to one endpoint become a single call over the operation that
 * joined or united them; a SERVICE that is the sole input of a congruent operation swaps places with it;
 * and the VALUES clauses of a join over nothing but VALUES and SERVICE are pushed into each service,
 * where the endpoint can apply them as an early filter.
 * @param c - The transformation context
 * @param op - The operation to transform
 * @returns the transformed operation
 */
export function transformServiceCallPushUp(c: TransformContext, op: Algebra.Operation): Algebra.Operation {
  const { AF } = c;

  /**
   * Merges the SERVICE operands of a JOIN or UNION that name the same endpoint into a single call.
   * @param op - The multi-input operation to merge
   * @returns the merged operation, or `op` when no endpoint is named twice
   */
  function pushUpServiceFromMulti(op: Algebra.Operation & Algebra.Multi): Algebra.Operation {
    let canOptimize = false;
    const distinctServices: Record<string, Algebra.Service[]> = {};
    for (const service of op.input) {
      if (service.type === Algebra.Types.SERVICE) {
        const strName = termToString(service.name);
        distinctServices[strName] = distinctServices[strName] ?? [];
        distinctServices[strName].push(service);
        if (distinctServices[strName].length > 1) {
          canOptimize = true;
        }
      }
    }

    if (!canOptimize) {
      return op;
    }
    // Group the service calls under the same operation type
    const handledServices = new Set<string>();
    const newInput: Algebra.Operation[] = [];
    for (const subOp of op.input) {
      if (subOp.type === Algebra.Types.SERVICE) {
        const strName = termToString(subOp.name);
        if (!handledServices.has(strName)) {
          handledServices.add(strName);
          const services = distinctServices[strName];
          // Create a single service for both
          // TODO: WHAT ABOUT SILENT SERVICES?
          newInput.push(<Algebra.Service>{
            ...services[0],
            input: <typeof op>{
              ...op,
              input: services.map(x => x.input),
            },
          });
        }
      } else {
        newInput.push(subOp);
      }
    }
    if (newInput.length === 1) {
      return newInput[0];
    }
    return <typeof op> {
      ...op,
      input: newInput,
    };
  }

  /**
   * Swaps a congruent single-input operation with the SERVICE below it, so that the endpoint evaluates it.
   * @param op - The single-input operation to swap
   * @returns the swapped operation, or `op` when its input is no SERVICE
   */
  function pushOpServiceFromSingle(op: Algebra.Operation & Algebra.Single): Algebra.Operation {
    const subOp = op.input;
    if (subOp.type === Algebra.Types.SERVICE) {
      op.input = subOp.input;
      subOp.input = op;
      return subOp;
    }
    return op;
  }

  /**
   * Pushes the VALUES clauses of a join into every SERVICE call beside them, which makes the outer join
   * simpler and lets each endpoint apply the bindings as an early filter.
   * @param op - The join to distribute over
   * @returns the rewritten join, or `op` when it holds anything but VALUES and SERVICE - removing the
   * VALUES from the outer join would change what the other operands join with
   */
  function valuesDistributionOfJoin(op: Algebra.Join): Algebra.Operation {
    const valueClauses: Algebra.Values[] = [];
    const serviceClauses: Algebra.Service[] = [];

    for (const input of op.input) {
      if (input.type === Algebra.Types.VALUES) {
        valueClauses.push(input);
      } else if (input.type === Algebra.Types.SERVICE) {
        serviceClauses.push(input);
      } else {
        // A non-VALUES, non-SERVICE branch is present: removing VALUES from
        // the outer join would change semantics, so abort.
        return op;
      }
    }

    if (valueClauses.length === 0 || serviceClauses.length === 0) {
      return op;
    }

    // Push every VALUES clause into each SERVICE branch as an inner join.
    const newServices = serviceClauses.map((service): Algebra.Service => ({
      ...service,
      input: AF.createJoin([ ...valueClauses, service.input ], true),
    }));

    if (newServices.length === 1) {
      return newServices[0];
    }
    return {
      ...op,
      input: newServices,
    };
  }

  return algebraUtils.mapOperation<'unsafe', typeof op>(
    op,
    {
      [Algebra.Types.JOIN]: { transform: (join) => {
        // Flatten any nested JOINs that are direct children so that VALUES and
        // SERVICE siblings become visible at the same level.  This normalises
        // structures produced by bgpTransform, which wraps even a single-pattern
        // BGP inside a JOIN, before applying the push-down optimisations.
        const flatJoin = AF.createJoin(join.input, true);
        const pushed = valuesDistributionOfJoin(flatJoin);
        if (pushed !== flatJoin) {
          return pushed;
        }
        return pushUpServiceFromMulti(flatJoin);
      } },
      [Algebra.Types.UNION]: { transform: pushUpServiceFromMulti },
      [Algebra.Types.FILTER]: { transform: pushOpServiceFromSingle },
      [Algebra.Types.EXTEND]: { transform: pushOpServiceFromSingle },
      [Algebra.Types.PROJECT]: { transform: pushOpServiceFromSingle },
      [Algebra.Types.GRAPH]: { transform: pushOpServiceFromSingle },
      [Algebra.Types.ORDER_BY]: { transform: pushOpServiceFromSingle },
      [Algebra.Types.REDUCED]: { transform: pushOpServiceFromSingle },
      [Algebra.Types.SLICE]: { transform: pushOpServiceFromSingle },
      // TODO: investigate if others work the same way.
    },
  );
}
