import type * as RDF from '@rdfjs/types';
import { Algebra, algebraUtils } from '@traqula/algebra-transformations-1-2';
import type { TransformContext } from '../transformContext.js';
import { createFilterFalse } from '../utils/operationhelpers.js';
import { termIsStaticTerm } from '../utils/typeGuards.js';
import { directExtensions } from '../utils.js';
import { VariableSet } from './variableSet.js';

// TODO: implement this check to not only check static bind equality but also static term/iri equality in a filter.

/**
 * Optimization transformation that detects and eliminates incompatible join branches.
 *
 * After query rewriting, a JOIN may contain UNION branches where different alternatives
 * bind variables to incompatible values. This transformation:
 *
 * 1. Analyzes variable bindings across JOIN operands
 * 2. Computes the intersection of possible values for each variable
 * 3. Replaces EXTEND operations with incompatible values with FILTER(FALSE)
 * 4. Adds VALUES clauses to constrain subqueries to valid values only
 *
 * @example
 * // Given query: SELECT * { ?s ?p ?o . <ex://a> ?p ?o }
 * // With mappings: CONSTRUCT WHERE { <ex://a> <ex://a> ?o }
 * //                CONSTRUCT WHERE { <ex://b> <ex://b> ?o }
 * //
 * // The first pattern creates a UNION binding ?s to <ex://a> or <ex://b>
 * // The second pattern requires subject <ex://a>, constraining ?p
 * // Since ?p from the <ex://b> mapping (value <ex://b>) doesn't match
 * // the ?p from the second pattern (which works with <ex://a>),
 * // the <ex://b> branch is eliminated.
 *
 * @example
 * // With 3 mappings where the third has subject <ex://b>:
 * // CONSTRUCT WHERE { <ex://a> <ex://a> ?o }
 * // CONSTRUCT WHERE { <ex://a> <ex://b> ?o }
 * // CONSTRUCT WHERE { <ex://b> <ex://c> ?o }
 * //
 * // The third mapping would bind ?s = <ex://b>, but the second pattern
 * // in the query has subject <ex://a>. Since these are incompatible,
 * // only the first two mappings (both with ?s = <ex://a>) survive.
 *
 * @param c - The transformation context
 * @param op - The operation to transform
 * @returns The transformed operation with incompatible branches eliminated
 */
export function nullifyJoinOverIncompatibleBounds<T extends Algebra.Operation>(
  c: TransformContext,
  op: T,
): T {
  return algebraUtils.mapOperation<'unsafe', typeof op>(
    op,
    { join: {
      transform: (join) => {
        // Find for each member of the join whether variables are bound to known terms
        const varSets = variableExtensionsOverJoin(c, join);

        // We optimize: iterate extends and unions. An extend who's term does not match is replaced by filterFalse.
        // Finding an extend where the var is bound to another var, you can bind both vars to the new static value,
        // or you can write a filter to an includes in the subquery.
        restrictOperations(c, join, varSets);

        return join;
      },
    }},
  );
}

/**
 * Applies variable restrictions to JOIN operands.
 * Replaces incompatible EXTEND operations with FILTER(FALSE) and
 * adds VALUES constraints to subqueries where possible.
 * @param c - The transformation context
 * @param join - The JOIN to modify
 * @param varSets - Map of variable names to their possible values
 */
function restrictOperations(c: TransformContext, join: Algebra.Join, varSets: Record<string, VariableSet>): void {
  const { AF } = c;
  const mappingVarsToScope: Record<string, VariableSet> = {};
  const recurse = (op: Algebra.Operation): Algebra.Operation => {
    if (op.type === Algebra.Types.EXTEND) {
      if (op.expression.subType === Algebra.ExpressionTypes.TERM && varSets[op.variable.value]) {
        const varSet = varSets[op.variable.value];
        const exprTerm = op.expression.term;
        // Only in case the var is bound to a mapping var (we know how they are constructed)
        if (!varSet.isNoFixed && exprTerm.termType === 'Variable' && /^[mr]/u.test(exprTerm.value)) {
          // The mapping var can be made specific
          mappingVarsToScope[exprTerm.value] = varSet;
          // If the mapping var gets bound, you may aso bind the userQuery var
          if (varSet.values.length === 1) {
            op.expression = AF.createTermExpression(varSet.values[0]);
          }
          op.input = recurse(op.input);
          delete mappingVarsToScope[exprTerm.value];
          return op;
        }
        // Can nullify
        if (!varSet.termIsCompatible(exprTerm)) {
          return createFilterFalse(c, op);
        }
      }
      op.input = recurse(op.input);
    } else if (op.type === Algebra.Types.UNION) {
      op.input = op.input.map(x => recurse(x));
    } else if (op.type === Algebra.Types.PROJECT) {
      return restrictProjectUsingValues(c, op, mappingVarsToScope);
    }
    return op;
  };
  join.input = join.input.map(x => recurse(x));
}

function restrictProjectUsingValues(
  c: TransformContext,
  project: Algebra.Project,
  mappingVarsToScope: Record<string, VariableSet>,
): Algebra.Operation {
  if (Object.keys(mappingVarsToScope).length === 0) {
    return project;
  }
  const { AF, DF } = c;
  let join: Algebra.Join;
  // The first thing in the project should become a join that joins the various variables together
  if (project.input.type === Algebra.Types.JOIN) {
    join = project.input;
  } else {
    join = AF.createJoin([ project.input ], false);
    project.input = join;
  }
  for (const [ var_, varSet ] of Object.entries(mappingVarsToScope)) {
    join.input.unshift(AF.createValues(
      [ DF.variable(var_) ],
      varSet.values.map(value => ({ [var_]: <RDF.NamedNode | RDF.Literal> value })),
    ));
  }
  return project;
}

function _restrictProjectUsingBindOrFilter(
  c: TransformContext,
  op: Algebra.Project,
  mappingVarsToScope: Record<string, VariableSet>,
): Algebra.Operation {
  const { AF, DF } = c;
  // For the vars that are filtered to a single term, you can also introduce an extension + join.
  const staticallyBound = Object.entries(mappingVarsToScope)
    .filter(([ _, set ]) => !set.isNoFixed && set.values.length === 1);
  const nonStaticallyBound = Object.fromEntries(Object.entries(mappingVarsToScope)
    .filter(([ var_ ]) => !staticallyBound.some(([ x ]) => x === var_)));
  if (staticallyBound.length > 0) {
    const isExtendBlock = (op: Algebra.Operation): boolean => {
      if (op.type === Algebra.Types.EXTEND) {
        return isExtendBlock(op.input);
      }
      if (op.type === Algebra.Types.BGP && op.patterns.length === 0) {
        return true;
      }
      return false;
    };
    let toExtendAround: Algebra.Operation;
    if (op.input.type === Algebra.Types.JOIN) {
      if (isExtendBlock(op.input.input[0])) {
        toExtendAround = op.input.input[0];
      } else {
        toExtendAround = AF.createBgp([]);
        op.input.input.unshift(toExtendAround);
      }
    } else {
      // Introduce join
      toExtendAround = AF.createBgp([]);
      op.input = AF.createJoin([ toExtendAround, op.input ]);
    }
    for (const [ var_, varSet ] of staticallyBound) {
      toExtendAround = AF.createExtend(
        toExtendAround,
        DF.variable(var_),
        AF.createTermExpression(varSet.values[0]),
      );
    }
    op.input.input[0] = toExtendAround;
  }
  op.input = createFilterBound(c, op.input, nonStaticallyBound);
  // The variables that are statically bounded do no longer need to be projected since
  // they have also been bound to the static term in the extend rewriting that added the var to `mappingVarsToScope`
  op.variables = op.variables.filter(var_ => !staticallyBound.some(([ x ]) => x === var_.value));
  return op;
}

function createFilterBound(
  c: TransformContext,
  input: Algebra.Operation,
  mappingVarsToScope: Record<string, VariableSet>,
): Algebra.Filter | Algebra.Operation {
  const { AF, DF } = c;

  function equality(var_: RDF.Variable, term: RDF.Term): Algebra.OperatorExpression {
    return AF.createOperatorExpression('=', [ AF.createTermExpression(var_), AF.createTermExpression(term) ]);
  }
  function orOfEquals(var_: RDF.Variable, varSet: VariableSet): Algebra.OperatorExpression {
    let res = equality(var_, varSet.values[0]);
    for (const term of varSet.values.slice(1)) {
      res = AF.createOperatorExpression('||', [ res, equality(var_, term) ]);
    }
    return res;
  }
  function andOfVars(list: readonly [RDF.Variable, VariableSet][]): Algebra.OperatorExpression {
    let res = orOfEquals(list[0][0], list[0][1]);
    for (const [ var_, varSet ] of list.slice(1)) {
      res = AF.createOperatorExpression('&&', [ res, orOfEquals(var_, varSet) ]);
    }
    return res;
  }

  const entries = Object.entries(mappingVarsToScope);
  if (entries.length === 0) {
    return input;
  }

  const mappedEntries = Object.entries(mappingVarsToScope)
    .map(([ var_, varSet ]): [RDF.Variable, VariableSet] => ([ DF.variable(var_), varSet ]));
  return AF.createFilter(input, andOfVars(mappedEntries));
}

function variableExtensionsOverJoin(c: TransformContext, join: Algebra.Join): Record<string, VariableSet> {
  const head = join.input[0];
  // Not knowing the variable makes it be noFixed, and that is identity of disjuntion
  const varSets: Record<string, VariableSet> = directExtensionOverUnionsAndMore(c, head);

  for (const op of join.input.slice(1)) {
    for (const [ var_, varSet ] of Object.entries(directExtensionOverUnionsAndMore(c, op))) {
      if (varSets[var_]) {
        varSets[var_] = varSets[var_].disjunct(varSet);
      } else {
        varSets[var_] = varSet;
      }
    }
  }

  return varSets;
}

function directExtensionOverUnionsAndMore(c: TransformContext, op: Algebra.Operation): Record<string, VariableSet> {
  const varSets: Record<string, VariableSet> = {};
  const traverse = (op: Algebra.Operation): void => {
    if (op.type === Algebra.Types.EXTEND) {
      if (op.expression.subType === Algebra.ExpressionTypes.TERM && termIsStaticTerm(op.expression.term)) {
        varSets[op.variable.value] = new VariableSet(op.expression.term);
      }
      traverse(op.input);
    } else if (op.type === Algebra.Types.UNION) {
      Object.assign(varSets, directExtensionOverUnions(c, op));
    }
  };

  traverse(op);
  return varSets;
}

function directExtensionOverUnions(c: TransformContext, union: Algebra.Union): Record<string, VariableSet> {
  const head = union.input[0];
  // Not knowing the variable makes it be noFixed, which is absorbing element under union
  const varSets: Record<string, VariableSet> = Object.fromEntries(Object.entries(directExtensions(c, head))
    .map(([ var_, term ]) => [ var_, new VariableSet((term)) ]));
  for (const op of union.input.slice(1)) {
    let trackedVars = Object.keys(varSets);
    for (const [ var_, term ] of Object.entries(directExtensions(c, op))) {
      // Register you saw this var
      trackedVars = trackedVars.filter(x => x !== var_);
      if (varSets[var_]) {
        varSets[var_] = varSets[var_].union(new VariableSet(term));
      } else {
        varSets[var_] = VariableSet.createNoFixed();
      }
    }
    // All vars not visited are noFixed:
    for (const var_ of trackedVars) {
      varSets[var_] = VariableSet.createNoFixed();
    }
  }
  return varSets;
}
