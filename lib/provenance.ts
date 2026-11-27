import type * as RDF from '@rdfjs/types';
import { toAst } from '@traqula/algebra-sparql-1-2';
import { Algebra, algebraUtils } from '@traqula/algebra-transformations-1-2';
import {
  PREDICATE_DERIVATION_OF,
  PREDICATE_DERIVED_FROM,
  PROVENANCE_NAMESPACE,
} from './consts.js';
import type { MappingConstructionTools, MappingOptions } from './mapping.js';
import { mappingFromConstructs, parseConstructQuery } from './mapping.js';
import type { ProvenanceNodeKind } from './provenancePolynomial.js';
import {
  isProvenanceVariableName,
  provenanceChildPrefix,
  provenanceNodeVariableName,
} from './provenancePolynomial.js';
import { boundOrUnboundArgumentExpression } from './transformations/bnodeExtensionFunction.js';
import { internalBnodeExpression } from './transformations/internalBnodeMaterialisation.js';
import { rewriteNonRecursivePaths } from './transformations/pathTransformation.js';
import type { TransformationContext, TransformationContextOptions } from './transformContext.js';
import { createTransformationContext, parseQuery } from './transformContext.js';
import type { Mapping } from './types.js';
import { assertUserQueryIsSupported } from './userQueryRestrictions.js';
import { cpMetaOf, withoutCpVars } from './utils/certainlyBoundVars.js';
import { expressionsEvaluatedBy, leaveExistencePatterns } from './utils/existenceScopes.js';
import {
  boundExpression,
  conjunctionOf,
  disjunctionOf,
  splitConjunction,
  unstableFunctionCalledBy,
} from './utils/expressionHelpers.js';
import { groupProjectedBy, projectOntoVariablesOrExistence } from './utils/operationhelpers.js';
import { datatypeInteger, DF, tripleTerm } from './utils/rdfDatatypes.js';
import { unionSets } from './utils/setUtils.js';
import { queryFormTypes, solutionModifierChainOf } from './utils/solutionModifierChain.js';
import { claimVariableName, collectVariableNames, freshVarGenerator, markVariableNamesUsed } from './utils.js';

/**
 * @fileoverview Provenance capture: the provenance view of a mapping, and SPARQLprov's rewrite of a SELECT to also
 * select the how-provenance of its answers over it. See ARCHITECTURE.md.
 */

const derivationOfPredicate = DF.namedNode(PREDICATE_DERIVATION_OF);
const derivedFromPredicate = DF.namedNode(PREDICATE_DERIVED_FROM);

/**
 * Creates the pattern linking a derivation to the triple term a triple (pattern) writes.
 * @param AF - The algebra factory to create it with
 * @param derivation - The variable the derivation is bound to
 * @param predicate - `derivationOf` or `derivedFrom`
 * @param triple - The triple (pattern)
 * @returns the pattern
 */
function derivationLink(
  AF: TransformationContext['AF'],
  derivation: RDF.Variable,
  predicate: RDF.NamedNode,
  triple: RDF.BaseQuad,
): Algebra.Pattern {
  return AF.createPattern(derivation, predicate, tripleTerm(triple.subject, triple.predicate, triple.object));
}

/**
 * The names of the in-scope variables of an operation.
 * @param operation - The operation to read
 * @returns the names
 */
function inScopeVariableNames(operation: Algebra.Operation): Set<string> {
  return new Set(algebraUtils.inScopeVariables(operation).map(variable => variable.value));
}

/**
 * The in-scope variables of one operation that another has in scope too.
 * @param left - The operation whose variables are kept
 * @param right - The other operation
 * @returns those variables
 */
function sharedVariables(left: Algebra.Operation, right: Algebra.Operation): RDF.Variable[] {
  const rightNames = inScopeVariableNames(right);
  return algebraUtils.inScopeVariables(left).filter(variable => rightNames.has(variable.value));
}

/**
 * Collects the triple patterns every solution of an operation matches, skipping those under a UNION, the
 * right side of an OPTIONAL or MINUS, a sub-SELECT, GROUP, GRAPH or SERVICE, and a property path.
 * @param operation - The operation to read
 * @returns the triple patterns
 */
function triplePatternsEverySolutionMatches(operation: Algebra.Operation): Algebra.Pattern[] {
  switch (operation.type) {
    case Algebra.Types.BGP:
      return operation.patterns;
    case Algebra.Types.JOIN:
      return operation.input.flatMap(triplePatternsEverySolutionMatches);
    case Algebra.Types.LEFT_JOIN:
    case Algebra.Types.MINUS:
      return triplePatternsEverySolutionMatches(operation.input[0]);
    case Algebra.Types.FILTER:
    case Algebra.Types.EXTEND:
    case Algebra.Types.DISTINCT:
    case Algebra.Types.REDUCED:
    case Algebra.Types.ORDER_BY:
    case Algebra.Types.SLICE:
      return triplePatternsEverySolutionMatches(operation.input);
    default:
      return [];
  }
}

/**
 * Rewrites a CONSTRUCT into the one building its provenance view. Each body solution becomes a derivation,
 * identified by the CONSTRUCT and the values of the body's variables.
 * @param tools - The factories to build with
 * @param construct - The CONSTRUCT a mapping is defined by
 * @param constructIdentifier - The IRI telling this CONSTRUCT's derivations apart from those of another
 * @returns the CONSTRUCT linking each derivation to the triples it produces and matched
 */
export function provenanceConstructOf(
  tools: MappingConstructionTools,
  construct: Algebra.Construct,
  constructIdentifier: RDF.NamedNode,
): Algebra.Construct {
  const { AF } = tools;
  const body = construct.input;
  const usedNames = collectVariableNames(tools.astTransformer, construct);
  const derivation = DF.variable(claimVariableName('derivation', usedNames));
  // A variable the body leaves unbound is an argument of its own, so it still tells the derivations apart.
  const derivationIdentity = internalBnodeExpression(AF, [
    AF.createTermExpression(constructIdentifier),
    ...algebraUtils.inScopeVariables(body).map(variable => AF.createTermExpression(variable)),
  ]);
  return AF.createConstruct(AF.createExtend(body, derivation, derivationIdentity), [
    ...construct.template.map(triple => derivationLink(AF, derivation, derivationOfPredicate, triple)),
    ...triplePatternsEverySolutionMatches(body)
      .map(pattern => derivationLink(AF, derivation, derivedFromPredicate, pattern)),
  ]);
}

/**
 * Builds the mapping of the provenance view of a set of CONSTRUCT queries: the derivations of their bodies,
 * each `derivationOf` the view triples it produces and `derivedFrom` the source triples it matched.
 * @param constructQueries - The SPARQL CONSTRUCT query strings defining the view
 * @param options - What the mapping is configured with
 * @returns the mapping to unfold a {@link provenanceCapturingQuery} against
 * @throws Error under the same conditions as {@link mapping!mappingFromConstructQueries}
 */
export function provenanceMappingFromConstructQueries(
  constructQueries: readonly string[],
  options: MappingOptions = {},
): Mapping {
  const tools = createTransformationContext({ expressionRange: options.expressionRange });
  return mappingFromConstructs(
    tools,
    constructQueries.map((constructQuery, index) =>
      provenanceConstructOf(
        tools,
        parseConstructQuery(tools, constructQuery),
        DF.namedNode(`${PROVENANCE_NAMESPACE}construct${index}`),
      )),
    options,
  );
}

/** The transformation context, with what provenance capture needs. */
interface ProvenanceCaptureContext extends TransformationContext {
  /** The prefix every provenance variable starts with, followed by `_`. */
  provenanceVariablePrefix: string;
  /** Coins a variable that never leaves the operation it is coined for. */
  coinInternalVariable: () => RDF.Variable;
}

/** An operation lifted for provenance capture: the original, and its rewrite under a provenance variable prefix. */
interface ProvenancePattern {
  /** The original operation, whose in-scope and certainly bound variables the rewrite reads. */
  original: Algebra.Operation;
  /**
   * Rewrites the pattern, SPARQLprov's α(Q, z).
   * @param prefix - The provenance variable prefix z of its root
   * @returns the rewritten operation
   */
  rewrite: (prefix: string) => Algebra.Operation;
}

/** The value of a `one` leaf: a solution produced from no view triple. */
const constantOne = DF.literal('1', datatypeInteger);

/**
 * The provenance variables an operation selects.
 * @param c - The provenance capture context
 * @param operation - The rewritten operation to read
 * @returns those variables
 */
function provenanceVariablesOf(c: ProvenanceCaptureContext, operation: Algebra.Operation): RDF.Variable[] {
  return algebraUtils.inScopeVariables(operation)
    .filter(variable => isProvenanceVariableName(c.provenanceVariablePrefix, variable.value));
}

/**
 * Binds a provenance variable to the identity of a solution's values of some variables, SPARQLprov's B(X, ?w): an
 * internal blank node, so that it tells the solutions apart by term, not by their string form.
 * @param c - The provenance capture context
 * @param operation - The operation to extend
 * @param variables - The variables X the identity is made of
 * @param provenanceVariableName - The name of the provenance variable ?w to bind
 * @returns the extended operation
 */
function withIdentity(
  c: ProvenanceCaptureContext,
  operation: Algebra.Operation,
  variables: RDF.Variable[],
  provenanceVariableName: string,
): Algebra.Extend {
  const { AF } = c;
  // The name keeps the identity bound, and fixed, where there are no variables.
  return AF.createExtend(operation, DF.variable(provenanceVariableName), internalBnodeExpression(AF, [
    AF.createTermExpression(DF.literal(provenanceVariableName)),
    ...[ ...variables ].sort((left, right) => left.value.localeCompare(right.value))
      .map(variable => AF.createTermExpression(variable)),
  ]));
}

/**
 * Lifts an operation as a node of the polynomial, bound to the identity of each of its solutions.
 * @param c - The provenance capture context
 * @param original - The operation
 * @param kind - The node's kind
 * @param rewriteBelow - Rewrites what is below the node, given the node's variable name
 * @returns the pattern
 */
function nodePattern(
  c: ProvenanceCaptureContext,
  original: Algebra.Operation,
  kind: ProvenanceNodeKind,
  rewriteBelow: (nodeVariableName: string) => Algebra.Operation,
): ProvenancePattern {
  const domain = algebraUtils.inScopeVariables(original);
  return {
    original,
    rewrite: (prefix) => {
      const nodeVariableName = provenanceNodeVariableName(prefix, kind);
      return withIdentity(c, rewriteBelow(nodeVariableName), domain, nodeVariableName);
    },
  };
}

/**
 * Lifts an operation whose solutions read no view triple, as a `one` leaf under each solution's Σ node.
 * @param c - The provenance capture context
 * @param operation - The operation
 * @returns the pattern
 */
function constantOnePattern(c: ProvenanceCaptureContext, operation: Algebra.Operation): ProvenancePattern {
  return nodePattern(c, operation, 'sum', sum => c.AF.createExtend(
    operation,
    DF.variable(provenanceNodeVariableName(sum, 'one')),
    c.AF.createTermExpression(constantOne),
  ));
}

/**
 * Numbers the rows of a VALUES, so that the identities of identical rows differ, as a bag holds them.
 * @param c - The provenance capture context
 * @param values - The VALUES
 * @returns the VALUES with a column holding each row's index
 */
function withRowIndices(c: ProvenanceCaptureContext, values: Algebra.Values): Algebra.Values {
  const rowIndex = c.coinInternalVariable();
  return c.AF.createValues([ ...values.variables, rowIndex ], values.bindings.map((binding, index) =>
    ({ ...binding, [rowIndex.value]: DF.literal(String(index), datatypeInteger) })));
}

/**
 * Lifts a triple pattern as the sum (Σ) of the derivations of the view triple it matches: SPARQLprov, Def. 4.12 (2).
 * @param c - The provenance capture context
 * @param pattern - The triple pattern
 * @returns the pattern
 */
function triplePatternOf(c: ProvenanceCaptureContext, pattern: Algebra.Pattern): ProvenancePattern {
  return nodePattern(c, c.AF.createBgp([ pattern ]), 'sum', sum => c.AF.createBgp([
    derivationLink(c.AF, DF.variable(provenanceNodeVariableName(sum, 'statement')), derivationOfPredicate, pattern),
  ]));
}

/**
 * Lifts an operation over one input, rebuilding it over the rewrite of that input.
 * @param original - The operation
 * @param input - The pattern of its input
 * @param rebuild - Rebuilds the operation over the rewritten input
 * @returns the pattern
 */
function patternOverInput(
  original: Algebra.Operation,
  input: ProvenancePattern,
  rebuild: (rewrittenInput: Algebra.Operation) => Algebra.Operation,
): ProvenancePattern {
  return { original, rewrite: prefix => rebuild(input.rewrite(prefix)) };
}

/**
 * The n-ary product (⊗) or sum (⊕) of patterns, their join or union: SPARQLprov, Def. 4.12 (3) and (4).
 * @param c - The provenance capture context
 * @param kind - Whether the patterns are joined or united
 * @param patterns - The patterns
 * @returns the joined or united pattern
 */
function combinationOf(
  c: ProvenanceCaptureContext,
  kind: 'product' | 'osum',
  patterns: ProvenancePattern[],
): ProvenancePattern {
  const combine = (operations: Algebra.Operation[]): Algebra.Operation =>
    kind === 'product' ? c.AF.createJoin(operations, false) : c.AF.createUnion(operations, false);
  return nodePattern(c, combine(patterns.map(pattern => pattern.original)), kind, node =>
    combine(patterns.map((pattern, index) => pattern.rewrite(provenanceChildPrefix(node, index + 1)))));
}

/**
 * A pattern filtered by an expression: SPARQLprov, Def. 4.12 (7).
 * @param c - The provenance capture context
 * @param pattern - The pattern
 * @param expression - The filter expression
 * @returns the filtered pattern
 */
function filteredBy(c: ProvenanceCaptureContext, pattern: ProvenancePattern, expression: Algebra.Expression):
ProvenancePattern {
  const expressionWithoutProvenance = withoutProvenance(c, expression);
  return patternOverInput(
    c.AF.createFilter(pattern.original, expression),
    pattern,
    rewrittenInput => c.AF.createFilter(rewrittenInput, expressionWithoutProvenance),
  );
}

/**
 * Binds each target variable to the value of its source, leaving it unbound where the source is.
 * @param c - The provenance capture context
 * @param operation - The operation to extend
 * @param sourcesAndTargets - The source and target variable of each binding
 * @returns the extended operation
 */
function withCopies(
  c: ProvenanceCaptureContext,
  operation: Algebra.Operation,
  sourcesAndTargets: (readonly [RDF.Variable, RDF.Variable])[],
): Algebra.Operation {
  return sourcesAndTargets.reduce<Algebra.Operation>((extended, [ source, target ]) =>
    c.AF.createExtend(extended, target, c.AF.createTermExpression(source)), operation);
}

/**
 * Coins a copy of each variable.
 * @param c - The provenance capture context
 * @param variables - The variables to copy
 * @returns each variable and its copy
 */
function copiesOf(c: ProvenanceCaptureContext, variables: RDF.Variable[]): (readonly [RDF.Variable, RDF.Variable])[] {
  return variables.map(variable => <const> [ variable, c.coinInternalVariable() ]);
}

/**
 * Names the Σ node over a difference's right side.
 * @param differenceNodeVariableName - The difference node's variable name
 * @returns the Σ node's variable name
 */
function rightSumOf(differenceNodeVariableName: string): string {
  return provenanceNodeVariableName(provenanceChildPrefix(differenceNodeVariableName, 2), 'sum');
}

/**
 * Binds a difference node to the identity of its left side's solution, as is the Σ node over its right side.
 * @param c - The provenance capture context
 * @param operation - The rewritten difference
 * @param leftDomain - The variables of the left side
 * @param differenceNodeVariableName - The difference node's variable name
 * @returns the bound operation
 */
function boundAsDifferenceNode(
  c: ProvenanceCaptureContext,
  operation: Algebra.Operation,
  leftDomain: RDF.Variable[],
  differenceNodeVariableName: string,
): Algebra.Operation {
  return c.AF.createExtend(
    withIdentity(c, operation, leftDomain, differenceNodeVariableName),
    DF.variable(rightSumOf(differenceNodeVariableName)),
    c.AF.createTermExpression(DF.variable(differenceNodeVariableName)),
  );
}

/** Which solutions of a difference's right side annotate a solution of its left side. */
interface DifferenceOptions {
  /** What the merged solution must satisfy, as an OPTIONAL's condition. */
  condition?: Algebra.Expression;
  /** Only a solution sharing a bound variable counts, as for MINUS. */
  sharingABoundVariable?: boolean;
}

/**
 * The difference (⊖) of two patterns, SPARQLprov's `diff` (Def. 4.12 (5)): the left side's solutions, each with the
 * provenance of the right side's compatible ones.
 * @param c - The provenance capture context
 * @param left - The pattern whose solutions are kept
 * @param right - The pattern whose compatible solutions annotate them
 * @param options - Which solutions of the right side count
 * @returns the difference
 */
function differenceOf(
  c: ProvenanceCaptureContext,
  left: ProvenancePattern,
  right: ProvenancePattern,
  options: DifferenceOptions = {},
): ProvenancePattern {
  const { AF } = c;
  const leftDomain = algebraUtils.inScopeVariables(left.original);
  const leftCertainlyBound = cpMetaOf(c, left.original).cVars;
  const shared = sharedVariables(left.original, right.original);
  // The OPTIONAL merges a left solution with the right side's value of a shared variable it leaves unbound, so the
  // left side's own value is copied before the OPTIONAL and restored after it.
  const restored = shared.filter(variable => !leftCertainlyBound.has(variable.value));
  const conditionWithoutProvenance = options.condition && withoutProvenance(c, options.condition);
  return {
    original: left.original,
    rewrite: (prefix) => {
      const node = provenanceNodeVariableName(prefix, 'difference');
      const leftRewritten = left.rewrite(provenanceChildPrefix(node, 1));
      const rightRewritten = right.rewrite(rightSumOf(node));
      const leftCopies = copiesOf(c, restored);
      const conditions = conditionWithoutProvenance ? [ conditionWithoutProvenance ] : [];
      let rightJoined = rightRewritten;
      if (options.sharingABoundVariable) {
        // Which side bound a shared variable is read off the copies taken before the merge.
        const rightCopies = copiesOf(c, shared);
        rightJoined = withCopies(c, rightRewritten, rightCopies);
        const leftCopyOf = new Map(leftCopies.map(([ variable, copy ]) => [ variable.value, copy ]));
        conditions.push(disjunctionOf(c, rightCopies.map(([ variable, copy ]) => conjunctionOf(c, [
          boundExpression(c, (leftCopyOf.get(variable.value) ?? variable).value),
          boundExpression(c, copy.value),
        ]))));
      }
      const leftVariables = algebraUtils.inScopeVariables(leftRewritten);
      const rightProvenance = provenanceVariablesOf(c, rightRewritten);
      const restoredNames = new Set(restored.map(variable => variable.value));
      const merged = AF.createProject(
        AF.createLeftJoin(
          withCopies(c, leftRewritten, leftCopies),
          rightJoined,
          conditions.length === 0 ? undefined : conjunctionOf(c, conditions),
        ),
        [
          ...leftVariables.filter(variable => !restoredNames.has(variable.value)),
          ...leftCopies.map(([ , copy ]) => copy),
          ...rightProvenance,
        ],
      );
      const leftSolutions = leftCopies.length === 0 ?
        merged :
        AF.createProject(
          withCopies(c, merged, leftCopies.map(([ variable, copy ]) => <const> [ copy, variable ])),
          [ ...leftVariables, ...rightProvenance ],
        );
      return boundAsDifferenceNode(c, leftSolutions, leftDomain, node);
    },
  };
}

/**
 * The pattern of an EXISTS, `P ⊖ (P ⊖ P2)`. Each solution of P meets only its own rows of `P ⊖ P2`, so P is rewritten
 * once, and its provenance copied from the inner left side to the outer one.
 * @param c - The provenance capture context
 * @param pattern - The pattern P the EXISTS filters
 * @param existence - The pattern P2 of the EXISTS
 * @returns the pattern
 */
function existencePatternOf(
  c: ProvenanceCaptureContext,
  pattern: ProvenancePattern,
  existence: ProvenancePattern,
): ProvenancePattern {
  const solutionsWithout = differenceOf(c, pattern, existence);
  const domain = algebraUtils.inScopeVariables(pattern.original);
  return {
    original: pattern.original,
    rewrite: (prefix) => {
      const node = provenanceNodeVariableName(prefix, 'difference');
      const rightSum = rightSumOf(node);
      const solutionsWithoutRewritten = solutionsWithout.rewrite(rightSum);
      const innerLeftPrefix = provenanceChildPrefix(provenanceNodeVariableName(rightSum, 'difference'), 1);
      const outerLeftPrefix = provenanceChildPrefix(node, 1);
      const copied = withCopies(c, solutionsWithoutRewritten, provenanceVariablesOf(c, solutionsWithoutRewritten)
        .filter(variable => isProvenanceVariableName(innerLeftPrefix, variable.value))
        .map(variable => <const> [
          variable,
          DF.variable(outerLeftPrefix + variable.value.slice(innerLeftPrefix.length)),
        ]));
      return boundAsDifferenceNode(c, copied, domain, node);
    },
  };
}

/**
 * The rewrite of a MINUS: the difference with the solutions of its right side that share a bound variable with the
 * left side's, those of a MINUS without a shared variable being none.
 * @param c - The provenance capture context
 * @param minus - The MINUS
 * @returns the pattern
 */
function minusPatternOf(c: ProvenanceCaptureContext, minus: Algebra.Minus): ProvenancePattern {
  const [ left, right ] = minus.input;
  const shared = sharedVariables(left, right);
  if (shared.length === 0) {
    return patternOf(c, left);
  }
  const leftBound = cpMetaOf(c, left).cVars;
  if (!shared.every(variable => leftBound.has(variable.value))) {
    return differenceOf(c, patternOf(c, left), patternOf(c, right), { sharingABoundVariable: true });
  }
  // The left side binds every shared variable, so a right solution shares one exactly when it binds one too: a filter
  // on the right side, which keeps the OPTIONAL plain, with nothing to rename apart.
  const rightBound = cpMetaOf(c, right).cVars;
  const rightSharingABoundVariable = shared.some(variable => rightBound.has(variable.value)) ?
    right :
    c.AF.createFilter(right, disjunctionOf(c, shared.map(variable => boundExpression(c, variable.value))));
  return differenceOf(c, patternOf(c, left), patternOf(c, rightSharingABoundVariable));
}

/**
 * Whether an EXISTS pattern reads each outer variable only where it certainly binds it itself, so that a difference,
 * evaluating the pattern apart, agrees with SPARQL, evaluating it per outer solution.
 * @param c - The provenance capture context
 * @param pattern - The pattern of the EXISTS
 * @param outerNames - The names of the variables in scope around the EXISTS
 * @returns whether it is uncorrelated
 */
function isUncorrelatedPattern(
  c: ProvenanceCaptureContext,
  pattern: Algebra.Operation,
  outerNames: ReadonlySet<string>,
): boolean {
  const readsOuterVariableUnbound = (node: object, boundNames: ReadonlySet<string>): boolean =>
    [ ...collectVariableNames(c.astTransformer, node) ].some(name => outerNames.has(name) && !boundNames.has(name));
  if (readsOuterVariableUnbound(pattern, cpMetaOf(c, pattern).cVars)) {
    return false;
  }
  let uncorrelated = true;
  const check = (correlated: boolean): { shortcut: boolean } => {
    uncorrelated &&= !correlated;
    return { shortcut: !uncorrelated };
  };
  // An expression reads the outer value only where its input certainly binds the variable.
  const expressionReadsOuterVariableUnbound = (operation: Algebra.Operation, inputs: Algebra.Operation[]): boolean => {
    const inputBound = unionSets(inputs.map(input => cpMetaOf(c, input).cVars));
    return expressionsEvaluatedBy(operation).some(expression => readsOuterVariableUnbound(expression, inputBound));
  };
  const nothingBound = new Set<string>();
  algebraUtils.visitOperation(pattern, {
    // A sub-SELECT hides the outer variables it does not project; a GROUP, SERVICE or MINUS's right side all it reads.
    [Algebra.Types.PROJECT]: { preVisitor: project =>
      check(readsOuterVariableUnbound(project, new Set(project.variables.map(variable => variable.value)))) },
    [Algebra.Types.GROUP]: { preVisitor: group => check(readsOuterVariableUnbound(group, nothingBound)) },
    [Algebra.Types.SERVICE]: { preVisitor: service => check(readsOuterVariableUnbound(service, nothingBound)) },
    [Algebra.Types.MINUS]: { preVisitor: minus => check(readsOuterVariableUnbound(minus.input[1], nothingBound)) },
    // An OPTIONAL's right side, as an expression does, reads the outer value only where its left side binds it.
    [Algebra.Types.LEFT_JOIN]: { preVisitor: leftJoin => check(
      readsOuterVariableUnbound(leftJoin.input[1], cpMetaOf(c, leftJoin.input[0]).cVars) ||
      expressionReadsOuterVariableUnbound(leftJoin, leftJoin.input),
    ) },
    [Algebra.Types.FILTER]: { preVisitor: filter =>
      check(expressionReadsOuterVariableUnbound(filter, [ filter.input ])) },
    // A BIND to an outer variable is dropped where SPARQL substitutes that variable.
    [Algebra.Types.EXTEND]: { preVisitor: extend => check(outerNames.has(extend.variable.value) ||
      expressionReadsOuterVariableUnbound(extend, [ extend.input ])) },
    [Algebra.Types.ORDER_BY]: { preVisitor: orderBy =>
      check(expressionReadsOuterVariableUnbound(orderBy, [ orderBy.input ])) },
    // A nested EXISTS reads the outer value through the expression holding it.
    [Algebra.Types.EXPRESSION]: leaveExistencePatterns,
  });
  return uncorrelated;
}

/**
 * The rewrite of a filter: a top-level uncorrelated `NOT EXISTS` becomes a difference, and such an `EXISTS` the
 * difference with that difference, `P ⊖ (P ⊖ P2)`.
 * @param c - The provenance capture context
 * @param filter - The filter
 * @returns the pattern
 */
function filterPatternOf(c: ProvenanceCaptureContext, filter: Algebra.Filter): ProvenancePattern {
  const outerNames = inScopeVariableNames(filter.input);
  const existences: Algebra.ExistenceExpression[] = [];
  const remaining: Algebra.Expression[] = [];
  for (const conjunct of splitConjunction(filter.expression)) {
    if (conjunct.subType === Algebra.ExpressionTypes.EXISTENCE &&
      isUncorrelatedPattern(c, conjunct.input, outerNames)) {
      existences.push(conjunct);
    } else {
      remaining.push(conjunct);
    }
  }
  const filtered = existences.reduce((pattern, existence) => {
    const existencePattern = patternOf(c, existence.input);
    return existence.not ?
      differenceOf(c, pattern, existencePattern) :
      existencePatternOf(c, pattern, existencePattern);
  }, patternOf(c, filter.input));
  return remaining.length === 0 ? filtered : filteredBy(c, filtered, conjunctionOf(c, remaining));
}

/**
 * The rewrite of an OPTIONAL: the join of both sides, plus the left side less the right, as SPARQLprov's
 * K-annotated algebra defines it (Def. 3.1), its condition filtering the join and conditioning the difference.
 * @param c - The provenance capture context
 * @param leftJoin - The OPTIONAL
 * @returns the pattern
 */
function optionalPatternOf(c: ProvenanceCaptureContext, leftJoin: Algebra.LeftJoin): ProvenancePattern {
  const [ left, right ] = leftJoin.input.map(input => patternOf(c, input));
  const joined = combinationOf(c, 'product', [ left, right ]);
  const normalised = combinationOf(c, 'osum', [
    leftJoin.expression ? filteredBy(c, joined, leftJoin.expression) : joined,
    differenceOf(c, left, right, { condition: leftJoin.expression }),
  ]);
  // The OPTIONAL has the variables of its normalisation, and is cheaper to analyse.
  return { ...normalised, original: leftJoin };
}

/**
 * Replaces every BGP outside a SERVICE, in expressions too, by the distinct solutions of its derivation lookups: its
 * solutions over the view as a set, without provenance.
 * @param c - The provenance capture context
 * @param object - The operation or expression to rewrite
 * @returns the rewritten operation or expression
 */
function withoutProvenance<T extends object>(c: ProvenanceCaptureContext, object: T): T {
  return algebraUtils.mapOperation<'unsafe', T>(object, {
    [Algebra.Types.BGP]: { transform: bgp => c.AF.createDistinct(projectOntoVariablesOrExistence(
      c,
      c.AF.createBgp(bgp.patterns.map(pattern =>
        derivationLink(c.AF, c.coinInternalVariable(), derivationOfPredicate, pattern))),
      algebraUtils.inScopeVariables(bgp),
    )) },
    [Algebra.Types.SERVICE]: { preVisitor: () => ({ continue: false }) },
  });
}

/**
 * Attaches to every answer the provenance of the solutions agreeing with it on the join variables, an unbound variable
 * agreeing only with an unbound one: SPARQLprov's cautious join (Def. 4.17).
 * @param c - The provenance capture context
 * @param answers - The answers, selecting the join and answer variables
 * @param solutions - The solutions the answers are computed from, as a pattern
 * @param solutionsPrefix - The provenance variable prefix to rewrite the solutions under
 * @param joinVariables - The variables answers and solutions are matched on
 * @param answerVariables - The variables to select of an answer
 * @returns the answers, once per row of a matching solution
 */
function attachProvenanceToAnswers(
  c: ProvenanceCaptureContext,
  answers: Algebra.Operation,
  solutions: ProvenancePattern,
  solutionsPrefix: string,
  joinVariables: RDF.Variable[],
  answerVariables: RDF.Variable[],
): Algebra.Project {
  const { AF } = c;
  const solutionsRewritten = solutions.rewrite(solutionsPrefix);
  const solutionsProvenance = provenanceVariablesOf(c, solutionsRewritten);
  // The answers are computed from the solutions, so a variable every solution binds every answer binds too.
  const certainlyBound = cpMetaOf(c, solutions.original).cVars;
  // A join lets an unbound variable match any value, so a variable that may be unbound is joined on the extension
  // function's wrapped key, this repo's choice.
  const keyedVariables = joinVariables
    .filter(variable => !certainlyBound.has(variable.value))
    .map(variable => <const> [ variable, c.coinInternalVariable() ]);
  const withKeys = (operation: Algebra.Operation): Algebra.Operation => keyedVariables.reduce<Algebra.Operation>(
    (keyed, [ variable, key ]) =>
      AF.createExtend(keyed, key, boundOrUnboundArgumentExpression(AF, AF.createTermExpression(variable))),
    operation,
  );
  const solutionsOnJoin = AF.createProject(withKeys(solutionsRewritten), [
    ...joinVariables.filter(variable => certainlyBound.has(variable.value)),
    ...keyedVariables.map(([ , key ]) => key),
    ...solutionsProvenance,
  ]);
  const answersWithProvenance = AF.createLeftJoin(withKeys(answers), solutionsOnJoin);
  return AF.createProject(answersWithProvenance, [
    ...answerVariables,
    ...provenanceVariablesOf(c, answers),
    ...solutionsProvenance,
  ]);
}

/**
 * The pattern of a projection, SPARQLprov's `select` (Def. 4.12 (6)), or of an aggregate query over a GROUP
 * (Def. 4.17).
 * @param c - The provenance capture context
 * @param project - The projection
 * @returns the pattern
 */
function projectionPatternOf(c: ProvenanceCaptureContext, project: Algebra.Project): ProvenancePattern {
  const { AF } = c;
  const group = groupProjectedBy(project);
  if (group === undefined) {
    const input = patternOf(c, project.input);
    return {
      original: project,
      rewrite: (prefix) => {
        const sum = provenanceNodeVariableName(prefix, 'sum');
        const inputRewritten = input.rewrite(sum);
        return AF.createProject(withIdentity(c, inputRewritten, project.variables, sum), [
          ...project.variables,
          ...provenanceVariablesOf(c, inputRewritten),
          DF.variable(sum),
        ]);
      },
    };
  }
  // An aggregate counts solutions rather than their provenance, so the subtree is duplicated: the groups are computed
  // without provenance and that of their solutions attached afterwards (SPARQLprov, Def. 4.17).
  const groupsWithTheirKeys = withoutProvenance(c, AF.createProject(project.input, [
    ...project.variables,
    ...group.variables.filter(variable => !project.variables.some(selected => selected.equals(variable))),
  ]));
  const solutions = patternOf(c, AF.createProject(group.input, group.variables));
  return {
    original: project,
    rewrite: (prefix) => {
      const aggregate = provenanceNodeVariableName(prefix, 'aggregate');
      return attachProvenanceToAnswers(
        c,
        withIdentity(c, groupsWithTheirKeys, group.variables, aggregate),
        solutions,
        aggregate,
        group.variables,
        project.variables,
      );
    },
  };
}

/**
 * The pattern of a SLICE, rewritten as an aggregate is: its answers computed without provenance, with the provenance
 * of every agreeing solution attached.
 * @param c - The provenance capture context
 * @param slice - The SLICE
 * @returns the pattern
 */
function slicePatternOf(c: ProvenanceCaptureContext, slice: Algebra.Slice): ProvenancePattern {
  const answerVariables = algebraUtils.inScopeVariables(slice);
  const answers = c.AF.createDistinct(projectOntoVariablesOrExistence(c, withoutProvenance(c, slice), answerVariables));
  const solutions = patternOf(c, algebraUtils.mapOperation<'unsafe', Algebra.Operation>(slice.input, {
    [Algebra.Types.ORDER_BY]: { transform: orderBy => orderBy.input },
    [Algebra.Types.SLICE]: { preVisitor: () => ({ continue: false }) },
  }));
  return {
    original: slice,
    rewrite: prefix => attachProvenanceToAnswers(c, answers, solutions, prefix, answerVariables, answerVariables),
  };
}

/**
 * Lifts an operation into its pattern, SPARQLprov's α (Def. 4.12), with `derivationOf` as its reification scheme.
 * @param c - The provenance capture context
 * @param operation - The operation
 * @returns the pattern
 * @throws Error if the operation is one provenance cannot be captured through
 */
function patternOf(c: ProvenanceCaptureContext, operation: Algebra.Operation): ProvenancePattern {
  const { AF } = c;
  switch (operation.type) {
    case Algebra.Types.BGP: {
      if (operation.patterns.length === 0) {
        return constantOnePattern(c, operation);
      }
      const triplePatterns = operation.patterns.map(pattern => triplePatternOf(c, pattern));
      return triplePatterns.length === 1 ? triplePatterns[0] : combinationOf(c, 'product', triplePatterns);
    }
    case Algebra.Types.JOIN:
      return combinationOf(c, 'product', operation.input.map(input => patternOf(c, input)));
    case Algebra.Types.UNION:
      return combinationOf(c, 'osum', operation.input.map(input => patternOf(c, input)));
    case Algebra.Types.LEFT_JOIN:
      return optionalPatternOf(c, operation);
    case Algebra.Types.MINUS:
      return minusPatternOf(c, operation);
    case Algebra.Types.FILTER:
      return filterPatternOf(c, operation);
    case Algebra.Types.EXTEND: {
      const expressionWithoutProvenance = withoutProvenance(c, operation.expression);
      return patternOverInput(operation, patternOf(c, operation.input), rewrittenInput =>
        AF.createExtend(rewrittenInput, operation.variable, expressionWithoutProvenance));
    }
    case Algebra.Types.PROJECT:
      return projectionPatternOf(c, operation);
    case Algebra.Types.SLICE:
      return slicePatternOf(c, operation);
    case Algebra.Types.ORDER_BY: {
      const expressionsWithoutProvenance = operation.expressions.map(expression => withoutProvenance(c, expression));
      return patternOverInput(operation, patternOf(c, operation.input), rewrittenInput =>
        AF.createOrderBy(rewrittenInput, expressionsWithoutProvenance));
    }
    case Algebra.Types.DISTINCT:
    case Algebra.Types.REDUCED:
      // The decoding sums the rows of an answer, so it counts each answer once anyway, as SPARQLprov's own
      // implementation, which drops DISTINCT.
      return patternOf(c, operation.input);
    case Algebra.Types.FROM:
      return patternOverInput(operation, patternOf(c, operation.input), rewrittenInput =>
        AF.createFrom(rewrittenInput, operation.default, operation.named));
    case Algebra.Types.VALUES:
      return constantOnePattern(c, withRowIndices(c, operation));
    case Algebra.Types.SERVICE:
      // Its identical solutions cannot be told apart, so they count once.
      return constantOnePattern(c, operation);
    default:
      throw new Error(`Provenance cannot be captured through a ${operation.type}.`);
  }
}

/** A query rewritten to capture provenance. */
export interface ProvenanceCapturingQuery<T> {
  /** The rewritten query. */
  query: T;
  /** The prefix of its provenance variables, which {@link provenancePolynomial!decodeProvenance} takes. */
  provenanceVariablePrefix: string;
}

/**
 * Rewrites a SELECT query over the view to also select the provenance of its answers.
 * @param c - The transformation context to rewrite with
 * @param operation - The SELECT query over the view
 * @returns the query over the provenance view, and its provenance variable prefix
 * @throws Error if the query is not a SELECT, or breaks a restriction of the rewriting
 */
function captureProvenance(c: TransformationContext, operation: Algebra.Operation):
ProvenanceCapturingQuery<Algebra.Operation> {
  const queryForm = [ ...solutionModifierChainOf(operation) ].find(modifier => queryFormTypes.has(modifier.type));
  if (queryForm?.type !== Algebra.Types.PROJECT) {
    throw new Error('Provenance can only be captured for a SELECT query.');
  }
  assertUserQueryIsSupported(operation);
  const unstableFunction = unstableFunctionCalledBy(operation);
  if (unstableFunction !== undefined) {
    throw new Error(`The ${unstableFunction.toUpperCase()} function cannot be used in a query whose provenance is captured: the rewrite evaluates parts of the query more than once.`);
  }
  // The rewrite caches the range analysis on this private copy, and the result holds none of it.
  const pathless = withoutCpVars(rewriteNonRecursivePaths(c, operation));
  const variableNames = markVariableNamesUsed(c, pathless);
  const provenanceVariablePrefix =
    claimVariableName('prov', new Set([ ...variableNames ].map(name => name.split('_')[0])));
  const context = {
    ...c,
    provenanceVariablePrefix,
    coinInternalVariable: freshVarGenerator(variableNames, 'internal'),
  };
  return {
    query: withoutCpVars(patternOf(context, pathless).rewrite(provenanceVariablePrefix)),
    provenanceVariablePrefix,
  };
}

/**
 * Rewrites a SELECT query over the view, in algebra form, as {@link provenanceCapturingQuery} does.
 * @param operation - The SELECT query over the view
 * @param options - What the rewriter is configured with
 * @returns the query over the provenance view, and its provenance variable prefix
 * @throws Error if the query is not a SELECT, or breaks a restriction of the rewriting
 */
export function provenanceCapturingOperation(
  operation: Algebra.Operation,
  options: TransformationContextOptions = {},
): ProvenanceCapturingQuery<Algebra.Operation> {
  return captureProvenance(createTransformationContext(options), operation);
}

/**
 * Rewrites a SELECT query over the view into one that also selects the how-provenance of its answers. Unfolded against
 * {@link provenanceMappingFromConstructQueries}, its answers decode with {@link provenancePolynomial!decodeProvenance}.
 * @param query - The SELECT query over the view
 * @param options - What the rewriter is configured with
 * @returns the SPARQL 1.2 query over the provenance view, and its provenance variable prefix
 * @throws Error if the query is not a SELECT, or breaks a restriction of the rewriting
 */
export function provenanceCapturingQuery(
  query: string,
  options: TransformationContextOptions = {},
): ProvenanceCapturingQuery<string> {
  const c = createTransformationContext(options);
  const { query: rewritten, provenanceVariablePrefix } = captureProvenance(c, parseQuery(c, query));
  return { query: c.generator.generate(toAst(rewritten)), provenanceVariablePrefix };
}
