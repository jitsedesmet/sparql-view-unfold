import type * as RDF from '@rdfjs/types';
import { Algebra } from '@traqula/algebra-transformations-1-2';
import type { TriplePosition } from './datastructures/TermClusterSet.js';
import type { TransformationContext } from './transformContext.js';
import { DF } from './utils/rdfDatatypes.js';
import { isRdfTerm, isRdfVar } from './utils/typeGuards.js';

/**
 * Renames variables in an object, VALUES binding keys included, handing back a copy.
 * @param c - The transformation context
 * @param obj - The object to rename in
 * @param renames - The new name of each variable to rename
 * @returns the renamed copy
 */
export function renameVariables<T extends object>(
  c: TransformationContext,
  obj: T,
  renames: ReadonlyMap<string, string>,
): T {
  return <T> c.astTransformer.transformObject(obj, (object) => {
    const newName = isRdfVar(object) ? renames.get(object.value) : undefined;
    if (newName !== undefined) {
      // One variable object per occurrence, as the parser hands out: the unfolding writes ranges onto them.
      return DF.variable(newName);
    }
    if ('type' in object && object.type === 'values' && 'bindings' in object) {
      const valuesOp = <Algebra.Values> object;
      valuesOp.bindings = valuesOp.bindings.map(binding => Object.fromEntries(
        Object.entries(binding).map(([ key, value ]) => [ renames.get(key) ?? key, value ]),
      ));
    }
    return object;
  });
}

/**
 * Deep copies an object, so that it can be rewritten in place without touching the original.
 * @param c - The transformation context
 * @param obj - The object to copy
 * @returns the copy
 */
export function deepCopy<T extends object>(c: Pick<TransformationContext, 'astTransformer'>, obj: T): T {
  return <T> c.astTransformer.transformObject(obj, object => object);
}

/**
 * Adds the names of every variable in an object to the names the context has in use.
 * @param c - The transformation context
 * @param obj - The object whose variables to add
 * @returns the names in use, which the caller can coin fresh names against
 */
export function markVariableNamesUsed(
  c: Pick<TransformationContext, 'astTransformer' | 'usedVariableNames'>,
  obj: object,
): Set<string> {
  for (const name of collectVariableNames(c.astTransformer, obj)) {
    c.usedVariableNames.add(name);
  }
  return c.usedVariableNames;
}

/**
 * Creates a generator of variables named by a prefix and an increasing index, skipping names in use.
 * @param usedNames - The names in use, read live and added to with every name coined
 * @param prefix - The prefix of the coined names
 * @returns a function coining a new variable on each call
 * @example
 * const fresh = freshVarGenerator(new Set([ 'x', 'v_0' ]));
 * fresh(); // ?v_1  (v_0 was taken)
 * fresh(); // ?v_2
 */
export function freshVarGenerator(usedNames: Set<string>, prefix = 'v_'): () => RDF.Variable {
  let index = 0;
  return (): RDF.Variable => {
    while (usedNames.has(`${prefix}${index}`)) {
      index += 1;
    }
    const name = `${prefix}${index}`;
    usedNames.add(name);
    index += 1;
    return DF.variable(name);
  };
}

/**
 * Claims a variable name: the wanted one if free, else the first free numeric suffix of it (`wanted0`, ...).
 * @param wanted - The name the variable would like to have
 * @param usedNames - The names in use, to which the claimed name is added
 * @returns the claimed name
 */
export function claimVariableName(wanted: string, usedNames: Set<string>): string {
  let name = wanted;
  for (let index = 0; usedNames.has(name); index += 1) {
    name = `${wanted}${index}`;
  }
  usedNames.add(name);
  return name;
}

/** Names a variable a rewrite coins for one position of a triple term it writes into a pattern. */
export type DerivedVarNamer = (representative: string, position: TriplePosition) => RDF.Variable;

/** How a position is spelled in the name of the variable holding it. */
const positionSuffixes: Readonly<Record<TriplePosition, string>> = {
  subject: 's',
  predicate: 'p',
  object: 'o',
};

/**
 * Creates the namer a pass writing triple terms into patterns coins its variables with: the position `p` of
 * the value `?x` names becomes `?x_p`, and a name already taken in the query takes the first free numeric
 * suffix (`?x_p0`, `?x_p1`, ...).
 *
 * **The name has to be a function of what it names**, which is the whole reason this exists beside
 * {@link freshVarGenerator}. Two places writing out the same position must write the same variable, or the
 * two operands of a join stop joining on it once both have been rewritten - where a sequentially numbered
 * generator names by call order instead. Sound because the position is functionally determined by the value
 * the two already agree on: equal triple terms have equal subjects.
 * @param usedNames - The names in use, read live and added to with every name coined; it has to hold every
 * name of the query before the pass runs, or a name coined half way through collides with one not yet met
 * @returns the namer, which is stateful: it remembers what it has already coined, so that a second reading
 * of one position hands back the variable the first one coined
 */
export function derivedVarNamer(usedNames: Set<string>): DerivedVarNamer {
  const coined = new Map<string, RDF.Variable>();
  return (representative: string, position: TriplePosition): RDF.Variable => {
    const key = `${representative}_${positionSuffixes[position]}`;
    const known = coined.get(key);
    if (known !== undefined) {
      return known;
    }
    const name = claimVariableName(key, usedNames);
    const variable = DF.variable(name);
    coined.set(key, variable);
    return variable;
  };
}

/**
 * Collects the names of every variable that occurs anywhere in an operation subtree, the string keys used
 * in VALUES bindings included.
 * @param astTransformer - The transformer to traverse with
 * @param obj - The subtree to read
 * @returns the variable names
 */
export function collectVariableNames(
  astTransformer: TransformationContext['astTransformer'],
  obj: object,
): Set<string> {
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
 * Extracts direct variable assignments from the EXTEND chain at the top of an operation, keeping only the
 * ones whose expression is a Literal or a NamedNode.
 * @param op - The operation to search
 * @returns the term assigned to each variable
 */
export function directExtensions(op: Algebra.Operation): Map<string, RDF.Term> {
  const assignments = new Map<string, RDF.Term>();

  const findAssignments = (op: Algebra.Operation): void => {
    if (op.type === 'extend') {
      if (op.expression.subType === Algebra.ExpressionTypes.TERM && (
        op.expression.term.termType === 'Literal' || op.expression.term.termType === 'NamedNode')) {
        assignments.set(op.variable.value, op.expression.term);
      }
      findAssignments(op.input);
    }
  };

  findAssignments(op);
  return assignments;
}
