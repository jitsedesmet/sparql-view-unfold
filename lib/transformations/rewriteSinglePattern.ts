import type * as RDF from '@rdfjs/types';
import type { Algebra as Alg } from '@traqula/algebra-transformations-1-2';
import { Algebra } from '@traqula/algebra-transformations-1-2';
import type { ClusterSolver } from '../ClusterSolver.js';
import { objectRange, predicateRange, subjectRange } from '../RangeSet.js';
import type { TransformContext } from '../transformContext.js';
import type { Mapping, MappingHead } from '../types.js';
import { isRdfQuad, isRdfVar } from '../utils/typeGuards.js';

/**
 * @fileoverview Core pattern rewriting logic.
 *
 * This module implements the core algorithm for rewriting a single triple pattern
 * against a mapping definition. The rewriting process involves:
 *
 * 1. **Variable Clustering**: Determine which variables from the user query and
 *    mapping are equivalent (must have the same value).
 *
 * 2. **Bind Collection**: Determine what values each variable will be bound to
 *    after the subquery executes.
 *
 * 3. **Query Construction**: Build the subquery that finds matching data in the
 *    underlying RDF 1.1 store.
 *
 * 4. **Result Binding**: Add EXTEND operations to bind the user query variables
 *    to the values retrieved from the subquery.
 */

/**
 * Extracts subject, predicate, object from a mapping head or quad.
 * @param head - The mapping head or quad
 * @returns Array of [subject, predicate, object]
 */
function headSPO(head: MappingHead): (MappingHead['subject'] | MappingHead['predicate'] | MappingHead['object'])[] {
  return [ head.subject, head.predicate, head.object ];
}

/**
 * Register the unification between the current mapping and the triple pattern.
 * Function allows us to recurse over Triple Terms or nested Mapping Heads.
 * @param c transformation context
 * @param mHVars set of variables in the mapping head
 * @param tPVars set of variables in the triple pattern
 * @param head the mapping head to iterate
 * @param pattern the triple pattern to iterate
 */
function iterateMappingHead(
  c: TransformContext,
  mHVars: Record<string, RDF.Variable>,
  tPVars: Record<string, RDF.Variable>,
  head: MappingHead,
  pattern: Alg.Pattern | RDF.BaseQuad,
): void {
  // Static array that allows us to access the range using the position index.
  const varRangesInPos = <const> [ subjectRange, predicateRange, objectRange ];
  const spoPattern = [ pattern.subject, pattern.predicate, pattern.object ];
  for (const [ headIdx, headTerm ] of headSPO(head).entries()) {
    const patternTerm = spoPattern[headIdx];
    const variablePosRange = varRangesInPos[headIdx];
    if (isRdfQuad(headTerm) && isRdfQuad(patternTerm)) {
      // Recursion in triple term
      iterateMappingHead(c, mHVars, tPVars, headTerm, patternTerm);
    } else if (isRdfQuad(patternTerm) && isRdfVar(headTerm)) {
      // If pattern is a quad, head must be a var. Otherwise, it was a quad, or a static term (which fails unification)

      // We now know the varalues of the var should be FILTERed to aacount for the patternTerm restrictions;
      //   or get the values of the patternTerm contained variables. -> start recursing the patternTerm.

      function registerRestrictionsAndExpressionAssignments(quad: RDF.Quad, expression: Alg.Expression): void {
        const spoQuad = [ quad.subject, quad.predicate, quad.object ];
        const positionalOperators = [ 'subject', 'predicate', 'object' ];
        for (const [ patternIdx, patternTerm ] of spoQuad.entries()) {
          const variablePosRange = varRangesInPos[patternIdx];
          const curHeadExpression = c.AF.createOperatorExpression(positionalOperators[patternIdx], [ expression ]);
          if (isRdfQuad(patternTerm)) {
            registerRestrictionsAndExpressionAssignments(patternTerm, curHeadExpression);
          } else {
            if (isRdfVar(patternTerm)) {
              tPVars[patternTerm.value] = patternTerm;
              patternTerm.range = variablePosRange;
            }
            c.clusterSolver.register(curHeadExpression, patternTerm);
          }
        }
      }
      registerRestrictionsAndExpressionAssignments(patternTerm, c.AF.createTermExpression(headTerm));
    } else {
      // If the head term is a Quad and the TP is a var, no issue, we perform the EXTEND to create the Triple Term
      // Register var and range it according to position (metadata for cluster algo). Done for triple pattern and head
      if (isRdfVar(headTerm)) {
        mHVars[headTerm.value] = headTerm;
        headTerm.range = variablePosRange;
      }
      if (isRdfVar(patternTerm)) {
        tPVars[patternTerm.value] = patternTerm;
        patternTerm.range = variablePosRange;
      }
      // Register the static terms to the solver.
      c.clusterSolver.register(headTerm, patternTerm);
    }
  }
}

/**
 * Collects bindings for triple pattern variables based on cluster analysis.
 *
 * For each variable in the user's triple pattern, determines what it should
 * be bound to after the subquery executes:
 * - A concrete term (if the mapping determines a specific value)
 * - A mapping variable (if bound through the subquery)
 */
function collectTriplePatternBinds({
  clusterSolver,
  triplePatternVars,
  expressionFilters,
  AF,
  DF,
}: {
  clusterSolver: ClusterSolver;
  triplePatternVars: Record<string, RDF.Variable>;
  expressionFilters: Alg.Expression[];
} & Pick<TransformContext, 'AF' | 'DF'>): Record<string, Alg.Expression> {
  const triplePatternBinds: Record<string, Alg.Expression> = {};
  for (const tpVariable of Object.values(triplePatternVars)) {
    const cluster = clusterSolver.getCluster(tpVariable);
    const expressions = clusterSolver.getExpressions(tpVariable);

    const term = cluster.term;
    // If two head vars are equal,
    //  they are connected through a mapping var (would be first) and get their value from there.
    const unifiedHeadVar = cluster.vars.at(0);
    if (term) {
      triplePatternBinds[tpVariable.value] = AF.createTermExpression(term);
    } else if (unifiedHeadVar) {
      triplePatternBinds[tpVariable.value] = AF.createTermExpression(DF.variable(unifiedHeadVar.value));
    }
    let isBound = Boolean(term ?? unifiedHeadVar);

    for (const expression of expressions) {
      if (isBound) {
        // Triple pattern matching is term equality, so assert sameTerm and not `=`:
        // "1"^^xsd:integer and "1.0"^^xsd:decimal are `=` but never match the same pattern.
        expressionFilters.push(
          AF.createOperatorExpression('sameterm', [ triplePatternBinds[tpVariable.value], expression ]),
        );
      } else {
        triplePatternBinds[tpVariable.value] = expression;
        isBound = true;
      }
    }
  }
  return triplePatternBinds;
}

function collectMappingHeadBindsAndFilters({ clusterSolver, mappingHeadVars, AF }: {
  clusterSolver: ClusterSolver;
  mappingHeadVars: Record<string, RDF.Variable>;
} & Pick<TransformContext, 'AF'>): Alg.Expression[] {
  const termEqualityFilter: Alg.Expression[] = [];
  const headUnificationFilter: Alg.Expression[] = [];
  const remainderFilter: Alg.Expression[] = [];
  const handledGroups = new Set<number>();

  // Start by going over headVars and how they got restricted - restrict them within the body.
  for (const headVar of Object.values(mappingHeadVars)) {
    // The cluster for this mapping head.
    const group = clusterSolver.getGroup(headVar);
    if (handledGroups.has(group)) {
      continue;
    }
    handledGroups.add(group);

    const groupTerm = clusterSolver.groupToTerm[group];
    const groupMappingVars = clusterSolver.groupToValues[group].filter(val => !val.value.startsWith('uq'));

    // Handle term restrictions first!
    if (groupTerm) {
      if (groupTerm.termType === 'BlankNode') {
        throw new Error(`Unreachable: The mapping head is assigned to a BlankNode, but this is not possible since blank nodes in the query have been replaced with variables during algebra conversion.`);
      }
      // Each mapping head var in the cluter should be equal to the term.
      for (const clusterVar of groupMappingVars) {
        termEqualityFilter.push(AF.createOperatorExpression('sameterm', [
          AF.createTermExpression(clusterVar),
          AF.createTermExpression(groupTerm),
        ]));
      }
    } else {
      // Assert equality between the various mapping head Vars
      for (let headIdx = 0; headIdx < groupMappingVars.length - 1; headIdx++) {
        const headVar = groupMappingVars[headIdx];
        const tailVar = groupMappingVars[headIdx + 1];
        headUnificationFilter.push(AF.createOperatorExpression('sameterm', [
          AF.createTermExpression(headVar),
          AF.createTermExpression(tailVar),
        ]));
      }
    }

    const expressionsToRegister = clusterSolver.getExpressions(headVar);
    for (const expression of expressionsToRegister) {
      // If group has term, check if templates equal term, otherwise check if template equals var.
      // By checking templates to terms we can perform prefix validation checks.
      const term: RDF.Term = groupTerm ?? groupMappingVars[0];
      remainderFilter.push(AF.createOperatorExpression('sameterm', [ AF.createTermExpression(term), expression ]));
    }
  }

  return [ ...termEqualityFilter, ...headUnificationFilter, ...remainderFilter ];
}

/**
 * Wraps an operation in a PROJECT (subselect) with appropriate variable projection.
 */
function wrapOperationInProject({ triplePatternBinds, operation, DF, AF }: {
  triplePatternBinds: Record<string, Alg.Expression>;
  operation: Alg.Operation;
} & Pick<TransformContext, 'DF' | 'AF'>): Alg.Project {
  let buildOperation = operation;
  // All variables required from subselect -- recursive search needed for triple terms
  const variablesToSelect = Object.keys(triplePatternBinds).map(x => DF.variable(x));
  if (variablesToSelect.length === 0) {
    // You cannot select nothing, but actually we just want this subquery to validate if data exists.
    // You cannot have a subAsk, but you can do a select over a dummy var: SELECT (1 as ?dummy)
    // [proof this works](https://query.comunica.dev/#transientDatasources=%2F%2Ffragments.dbpedia.org%2F2016-04%2Fen&query=SELECT%20*%0AWHERE%20%7B%0A%20%20%3Fs%20%3Fp%20%3Fo%20.%0A%20%20%7B%20SELECT%20%281%20as%20%3Fdummy%29%20WHERE%20%7B%0A%20%20%20%20%20%20%3Chttp%3A%2F%2F0-access.newspaperarchive.com.lib.utep.edu%2Fus%2Fmississippi%2Fbiloxi%2Fbiloxi-daily-herald%2F1899%2F05-06%2Fpage-6%3Ftag%3Dtierce%2Bwine%26rtserp%3Dtags%2Ftierce-wine%3Fpage%3D2%3E%0A%20%20%20%20%20%20%3Chttp%3A%2F%2Fdbpedia.org%2Fproperty%2Fdate%3E%0A%20%20%20%20%20%20%221899-05-05%22%5E%5E%3Chttp%3A%2F%2Fwww.w3.org%2F2001%2FXMLSchema%23date%3E%0A%20%20%20%20%20%20%23%20%221899-05-06%22%5E%5E%3Chttp%3A%2F%2Fwww.w3.org%2F2001%2FXMLSchema%23date%3E%0A%20%20%20%7D%20%7D%0A%7D)
    // The name is deterministic: callers namespace each pattern's variables uniquely, so no
    // global counter is needed to keep existence vars of distinct patterns apart.
    const existenceVar = DF.variable('mExists');
    buildOperation = AF.createExtend(
      buildOperation,
      existenceVar,
      AF.createTermExpression(DF.literal('dummy')),
    );
    variablesToSelect.push(existenceVar);
  }
  // Sort allows for stable tests but does not practically change anything.
  variablesToSelect.sort((a, b) => a.value.localeCompare(b.value));
  return AF.createProject(buildOperation, variablesToSelect);
}

/**
 * Adds EXTEND operations after the subselect to bind triple pattern variables.
 *
 * After the subquery executes, we need to bind the user query's variables
 * to the appropriate values (mapping variables, concrete terms, or template results).
 *
 * @param params - Configuration object
 * @param params.operation - The inner operation
 * @param params.triplePatternBinds - Map of variable names to their bindings
 * @param params.DF - Data factory
 * @param params.AF - Algebra factory
 * @returns The subquery with EXTEND operations for variable binding
 */
function bindPatternTerms({ operation, AF, DF, triplePatternBinds }: {
  operation: Alg.Operation;
  triplePatternBinds: Record<string, Alg.Expression>;
} & Pick<TransformContext, 'DF' | 'AF'>): Alg.Operation {
  let buildOperation: Alg.Operation = operation;
  // Finally add the binds after the subselect - Sort to create stable tests
  for (const [ variable, expression ] of Object.entries(triplePatternBinds).sort((a, b) => a[0].localeCompare(b[0]))) {
    buildOperation = AF.createExtend(
      buildOperation,
      DF.variable(variable),
      expression,
    );
  }
  return buildOperation;
}

/**
 * Builds the conditions under which a pattern bind yields a term instead of raising an evaluation
 * error - README step 2.5: "assert the triple term vars are assigned".
 *
 * A BIND whose expression errors leaves its target variable *unbound* while keeping the solution,
 * but a triple pattern only matches when every one of its variables is assigned a term. A pattern
 * variable inside a triple term is bound through `SUBJECT`/`PREDICATE`/`OBJECT` of a mapping
 * variable, and those raise an error whenever that variable does not hold a triple term. Without
 * the guard, a mapping producing no triple term at all still yields a solution in which the
 * pattern's variables are unbound.
 *
 * `ISTRIPLE` also covers an unbound argument (it errors, so the FILTER rejects the solution), which
 * is why no separate `BOUND` check is emitted.
 *
 * The guards are added *below* the binds, over the mapping body, so the top of a rewritten pattern
 * stays an EXTEND. A FILTER at the top would be lifted into the condition of an enclosing LEFT JOIN
 * once {@link removeProjections} drops the subselect barrier (SPARQL 1.2 §18.2.2.2).
 *
 * @param c - The transformation context
 * @param expression - The expression a pattern variable gets bound to
 * @returns The conditions to assert, innermost argument first
 */
function bindEvaluationGuards(c: TransformContext, expression: Alg.Expression): Alg.Expression[] {
  if (
    expression.subType !== Algebra.ExpressionTypes.OPERATOR ||
    ![ 'subject', 'predicate', 'object' ].includes(expression.operator)
  ) {
    return [];
  }
  const [ argument ] = expression.args;
  return [
    ...bindEvaluationGuards(c, argument),
    // Copy the argument: the guard and the bind must not alias, later passes rewrite algebra in place.
    c.AF.createOperatorExpression('istriple', [ <Alg.Expression> c.astTransformer.transformObject(argument, o => o) ]),
  ];
}

/**
 * Rewrites a single triple pattern using a mapping definition.
 */
export function rewriteSinglePattern(
  c: TransformContext,
  pattern: Alg.Pattern,
  mapping: Mapping,
): Alg.Project | Alg.Extend {
  const { clusterSolver, AF, DF } = c;
  clusterSolver.clear();
  // Set of variables in the mapping head
  const mappingHeadVars: Record<string, RDF.Variable> = {};
  // Set of variables in the triple pattern
  const triplePatternVars: Record<string, RDF.Variable> = {};
  iterateMappingHead(c, mappingHeadVars, triplePatternVars, mapping.head, pattern);

  clusterSolver.sortClusters();

  const expressionFilters = collectMappingHeadBindsAndFilters({ mappingHeadVars, clusterSolver, AF });

  // A map between what each uqVar now equals. Adds bind after the subselect
  const triplePatternBinds: Record<string, Alg.Expression> = collectTriplePatternBinds({
    clusterSolver,
    triplePatternVars,
    expressionFilters,
    AF,
    DF,
  });

  // Construct the contents of our subselect
  let inProject: Alg.Operation = mapping.body.input;
  // Collapse unified head variables onto their fresh representative. Where a
  // representative would be bound twice, the redundant BIND becomes an equality
  // FILTER so the variables' equality is asserted, not dropped.
  // A pattern variable that is read out of a triple term is only assigned when that triple term
  // really is one - assert it, duplicates removed since one mapping variable feeds several binds.
  const guards = new Map<string, Alg.Expression>();
  for (const [ , expression ] of Object.entries(triplePatternBinds).sort((a, b) => a[0].localeCompare(b[0]))) {
    for (const guard of bindEvaluationGuards(c, expression)) {
      guards.set(JSON.stringify(guard), guard);
    }
  }
  for (const expression of [
    ...expressionFilters,
    ...clusterSolver.getStaticExpressionValidation()
      .map(x => AF.createOperatorExpression('sameterm', [ AF.createTermExpression(x.term), x.expression ])),
    ...guards.values(),
  ]) {
    inProject = AF.createFilter(inProject, expression);
  }
  inProject = bindPatternTerms({ operation: inProject, triplePatternBinds, DF, AF });
  return wrapOperationInProject({ operation: inProject, triplePatternBinds, AF, DF });
}
