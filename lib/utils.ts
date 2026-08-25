import type * as RDF from '@rdfjs/types';
import { Algebra } from '@traqula/algebra-transformations-1-2';
import type { TriplePosition } from './datastructures/TermClusterSet.js';
import type { TransformContext } from './transformContext.js';
import { DF } from './utils/rdfDatatypes.js';
import { isRdfTerm, isRdfVar } from './utils/typeGuards.js';

/**
 * Renames variables in an operation subtree according to the given map.
 * Handles both variable terms and the string keys used in VALUES bindings.
 *
 * @param c - The transformation context
 * @param obj - The operation to rewrite
 * @param renames - Map from original variable name to its replacement variable
 * @returns The rewritten operation
 */
export function renameVariables<T extends object>(
  c: TransformContext,
  obj: T,
  renames: Record<string, RDF.Variable>,
): T {
  return <T> c.astTransformer.transformObject(obj, (object) => {
    if (isRdfVar(object) && object.value in renames) {
      return renames[object.value];
    }
    if ('type' in object && object.type === 'values' && 'bindings' in object) {
      const valuesOp = <Algebra.Values> object;
      valuesOp.bindings = valuesOp.bindings.map(binding => Object.fromEntries(
        Object.entries(binding).map(([ key, value ]) => [ key in renames ? renames[key].value : key, value ]),
      ));
    }
    return object;
  });
}

/**
 * Creates a generator of fresh (non-colliding) RDF variables.
 *
 * The generator coins variable names using an internal, monotonically increasing
 * index (e.g. `?v_0`, `?v_1`, ...). If a candidate name already exists in the set
 * of known variables, the index is advanced until an unused name is found.
 * Every coined name is remembered internally, so repeated calls never collide with
 * each other nor with any variable that was present in the original operation tree.
 *
 * @param existing - Variable names that already exist within the operation tree
 * @param prefix - Prefix used for the coined variable names (defaults to `v`)
 * @returns A function that returns a new, unused variable on each call
 * @example
 * const fresh = freshVarGenerator([ 'x', 'v_0' ]);
 * fresh(); // ?v_1  (v_0 was taken)
 * fresh(); // ?v_2
 */
export function freshVarGenerator(existing: Iterable<string>, prefix = 'v_'): () => RDF.Variable {
  const taken = new Set(existing);
  let index = 0;
  return (): RDF.Variable => {
    let name = `${prefix}${index}`;
    while (taken.has(name)) {
      index += 1;
      name = `${prefix}${index}`;
    }
    taken.add(name);
    index += 1;
    return DF.variable(name);
  };
}

/** Names a variable a rewrite coins for one position of a triple term it writes into a pattern. */
export type DerivedVarNamer = (anchor: string, position: TriplePosition) => RDF.Variable;

/** How a position is spelled in the name of the variable holding it. */
const positionSuffixes: Readonly<Record<TriplePosition, string>> = {
  subject: 's',
  predicate: 'p',
  object: 'o',
};

/**
 * Creates the namer a pass writing triple terms into patterns coins its variables with: the position
 * `p` of the value `?x` names becomes `?x_p`, and a name already taken in the query takes the first
 * free numeric suffix (`?x_p0`, `?x_p1`, ...).
 *
 * **The name has to be a function of what it names**, which is the whole reason this exists beside
 * {@link freshVarGenerator}. Two places writing out the same position must write the same variable, or
 * the two operands of a join stop joining on it once both have been rewritten - and a sequentially
 * numbered generator names by call order instead, so the *same* position picks up a different name
 * depending on which branch is rewritten first. Sound because the position is functionally determined
 * by the value the two already agree on: equal triple terms have equal subjects.
 *
 * So `anchor` must be the canonical name of the value the position is read from, and the memo below is
 * what makes a second reading of the same position hand back the variable the first one coined -
 * including where the first candidate was taken and the suffix moved the name.
 *
 * @param existing - Every variable name occurring in the query, collected once *before* the pass runs
 *   ({@link collectVariableNames}), since a name coined half way through would otherwise collide with
 *   one further down the tree that has not been visited yet.
 * @returns The namer, which is stateful: it remembers what it has already coined.
 */
export function derivedVarNamer(existing: Iterable<string>): DerivedVarNamer {
  const taken = new Set(existing);
  const coined = new Map<string, RDF.Variable>();
  return (anchor: string, position: TriplePosition): RDF.Variable => {
    const key = `${anchor}_${positionSuffixes[position]}`;
    const known = coined.get(key);
    if (known !== undefined) {
      return known;
    }
    let name = key;
    for (let index = 0; taken.has(name); index += 1) {
      name = `${key}${index}`;
    }
    taken.add(name);
    const variable = DF.variable(name);
    coined.set(key, variable);
    return variable;
  };
}

/**
 * Collects the names of every variable that occurs anywhere in an operation subtree.
 * This includes variable terms (subjects, predicates, objects, expression operands,
 * projected/extended variables, ...) as well as the string keys used in VALUES bindings.
 */
export function collectVariableNames(astTransformer: TransformContext['astTransformer'], obj: object): Set<string> {
  const names = new Set<string>();
  astTransformer.visitObject(obj, (object) => {
    if (isRdfTerm(object) && object.termType === 'Variable') {
      names.add(object.value);
    }
    // VALUES bindings reference their variables through string keys.
    if ('type' in object && object.type === 'values' && 'bindings' in object) {
      for (const binding of (<Algebra.Values> object).bindings) {
        for (const key of Object.keys(binding)) {
          names.add(key);
        }
      }
    }
  });
  return names;
}

/**
 * Extracts direct variable assignments from EXTEND operations.
 * Only collects assignments where the expression is a simple term (Literal or NamedNode).
 * @param c - Transform context
 * @param op - The operation to search
 * @returns A record mapping variable names to their assigned terms
 */
export function directExtensions(c: TransformContext, op: Algebra.Operation): Record<string, RDF.Term> {
  const assignments: Record<string, RDF.Term> = {};

  const findAssignments = (op: Algebra.Operation): void => {
    if (op.type === 'extend') {
      if (op.expression.subType === Algebra.ExpressionTypes.TERM && (
        op.expression.term.termType === 'Literal' || op.expression.term.termType === 'NamedNode')) {
        assignments[op.variable.value] = (op.expression).term;
      }
      findAssignments(op.input);
    }
  };

  findAssignments(op);
  return assignments;
}

/**
 * Removes EXTEND operations for specified variables from an operation tree.
 * Modifies the tree in place.
 * @param c - Transform context
 * @param op - The operation to modify
 * @param vars - Variable names whose extensions should be removed
 * @returns The modified operation
 */
export function deleteVarExtensionsInPlace(
  c: TransformContext,
  op: Algebra.Operation,
  vars: string[],
): Algebra.Operation {
  if (vars.length === 0) {
    return op;
  }
  const pruneExtensions = (op: Algebra.Operation): Algebra.Operation => {
    if (op.type === 'extend') {
      if (vars.includes(op.variable.value)) {
        return pruneExtensions(op.input);
      }
      op.input = pruneExtensions(op.input);
      return op;
    }
    return op;
  };
  return pruneExtensions(op);
}

/**
 * Optimizes a template array by concatenating adjacent string values.
 * This reduces the number of CONCAT operations needed when generating SPARQL.
 * @param arr - Array of template components (strings and variables)
 * @returns Optimized array with adjacent strings merged
 * @example
 * optimizeTemplateArray(['http://', 'example.org/', varX])
 * // Returns: ['http://example.org/', varX]
 */
export function optimizeTemplateArray<T>(arr: T[]): (T | string)[] {
  const optimizedTemplate: (T | string)[] = [];
  for (const val of arr) {
    if (typeof val === 'string' && typeof optimizedTemplate.at(-1) === 'string') {
      const prev = <string> optimizedTemplate.pop();
      optimizedTemplate.push(prev + val);
    } else {
      optimizedTemplate.push(val);
    }
  }
  return optimizedTemplate;
}
