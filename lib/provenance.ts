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
import { cpMetaOf, termVars, withoutCpVars } from './utils/certainlyBoundVars.js';
import {
  boundExpression,
  conjunctionOf,
  disjunctionOf,
  sameTermExpression,
  splitConjunction,
  unboundExpression,
  unstableFunctionCalledBy,
} from './utils/expressionHelpers.js';
import { groupProjectedBy, projectOntoVariablesOrExistence } from './utils/operationhelpers.js';
import { datatypeInteger, DF, tripleTerm } from './utils/rdfDatatypes.js';
import { queryFormTypes, solutionModifierChainOf } from './utils/solutionModifierChain.js';
import {
  claimVariableName,
  collectVariableNames,
  freshVarGenerator,
  markVariableNamesUsed,
  renameVariables,
} from './utils.js';

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
  const coinVariable = freshVarGenerator(collectVariableNames(tools.astTransformer, construct), 'derivation');
  const derivation = coinVariable();
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

/** The literal `1`, the polynomial of a solution produced from no data. */
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
 * Lifts an operation as the sum (Σ) of the statements each of its solutions binds: SPARQLprov, Def. 4.12 (2).
 * @param c - The provenance capture context
 * @param original - The operation
 * @param bindingStatement - Builds the operation binding each solution's statements to a variable
 * @returns the pattern
 */
function statementSumPattern(
  c: ProvenanceCaptureContext,
  original: Algebra.Operation,
  bindingStatement: (statement: RDF.Variable) => Algebra.Operation,
): ProvenancePattern {
  const domain = algebraUtils.inScopeVariables(original);
  return {
    original,
    rewrite: prefix => withIdentity(
      c,
      bindingStatement(DF.variable(provenanceNodeVariableName(provenanceChildPrefix(prefix, 'sum'), 'statement'))),
      domain,
      provenanceNodeVariableName(prefix, 'sum'),
    ),
  };
}

/**
 * Lifts an operation whose solutions read no view triple, annotating each with the polynomial `1`.
 * @param c - The provenance capture context
 * @param operation - The operation
 * @returns the pattern
 */
function constantOnePattern(c: ProvenanceCaptureContext, operation: Algebra.Operation): ProvenancePattern {
  return statementSumPattern(c, operation, statement =>
    c.AF.createExtend(operation, statement, c.AF.createTermExpression(constantOne)));
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
 * A triple pattern as the sum (Σ) of the derivations of the view triple it matches.
 * @param c - The provenance capture context
 * @param pattern - The triple pattern
 * @returns the pattern
 */
function triplePatternOf(c: ProvenanceCaptureContext, pattern: Algebra.Pattern): ProvenancePattern {
  return statementSumPattern(c, c.AF.createBgp([ pattern ]), derivation =>
    c.AF.createBgp([ derivationLink(c.AF, derivation, derivationOfPredicate, pattern) ]));
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
  const original = combine(patterns.map(pattern => pattern.original));
  const domain = algebraUtils.inScopeVariables(original);
  return {
    original,
    rewrite: prefix => withIdentity(
      c,
      combine(patterns.map((pattern, index) => pattern.rewrite(provenanceChildPrefix(prefix, kind, index + 1)))),
      domain,
      provenanceNodeVariableName(prefix, kind),
    ),
  };
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

/** Which solutions of a difference's subtrahend remove a solution of its minuend. */
interface DifferenceOptions {
  /** What a compatible pair must also satisfy, merged, as an OPTIONAL's condition. */
  condition?: Algebra.Expression;
  /** Only a solution sharing a bound variable removes one, as for MINUS. */
  sharingABoundVariable?: boolean;
  /** Only a solution agreeing on which variables are unbound removes one, as for the outer difference of EXISTS. */
  identicalSolutions?: boolean;
}

/**
 * The difference (⊖) of two patterns, SPARQLprov's `diff` (Def. 4.12 (5)): the minuend's solutions, each with the
 * provenance of the subtrahend's compatible ones.
 * @param c - The provenance capture context
 * @param minuend - The pattern whose solutions are kept
 * @param subtrahend - The pattern whose compatible solutions annotate them
 * @param options - Which solutions of the subtrahend count
 * @returns the difference
 */
function differenceOf(
  c: ProvenanceCaptureContext,
  minuend: ProvenancePattern,
  subtrahend: ProvenancePattern,
  options: DifferenceOptions = {},
): ProvenancePattern {
  const { AF } = c;
  const minuendDomain = algebraUtils.inScopeVariables(minuend.original);
  const certainlyBound = cpMetaOf(c, minuend.original).cVars;
  // Shared variables the minuend may leave unbound are renamed apart in the subtrahend and compared in the OPTIONAL's
  // condition. A MINUS needs to tell which side bound a shared variable, so it renames them all.
  const renamedApart = sharedVariables(minuend.original, subtrahend.original)
    .filter(variable => options.sharingABoundVariable === true || !certainlyBound.has(variable.value));
  const conditionWithoutProvenance = options.condition && withoutProvenance(c, options.condition);
  return {
    original: minuend.original,
    rewrite: (prefix) => {
      const renameOf = new Map(renamedApart.map(variable => [ variable.value, c.coinInternalVariable().value ]));
      const subtrahendSum = provenanceChildPrefix(provenanceChildPrefix(prefix, 'difference', 2), 'sum');
      const subtrahendRewritten = subtrahend.rewrite(subtrahendSum);
      const subtrahendRenamed = renameOf.size === 0 ?
        subtrahendRewritten :
        renameVariables(c, subtrahendRewritten, renameOf);
      const minuendRewritten = minuend.rewrite(provenanceChildPrefix(prefix, 'difference', 1));
      const optional = AF.createProject(
        AF.createLeftJoin(
          minuendRewritten,
          subtrahendRenamed,
          differenceCondition(c, renameOf, options, conditionWithoutProvenance),
        ),
        [ ...algebraUtils.inScopeVariables(minuendRewritten), ...provenanceVariablesOf(c, subtrahendRenamed) ],
      );
      const identity = provenanceNodeVariableName(prefix, 'difference');
      // The Σ over the subtrahend has the minuend's solution as its identity too.
      return AF.createExtend(
        withIdentity(c, optional, minuendDomain, identity),
        DF.variable(subtrahendSum),
        AF.createTermExpression(DF.variable(identity)),
      );
    },
  };
}

/**
 * The condition of a difference's OPTIONAL: every renamed variable compatible with its rename, as the options ask, and
 * the difference's own condition over the merged solution.
 * @param c - The provenance capture context
 * @param renameOf - The rename of each variable renamed apart, by name
 * @param options - Which solutions of the subtrahend count
 * @param condition - The difference's own condition, without provenance
 * @returns the condition, or `undefined` when there is nothing to check
 */
function differenceCondition(
  c: ProvenanceCaptureContext,
  renameOf: ReadonlyMap<string, string>,
  options: Omit<DifferenceOptions, 'condition'>,
  condition: Algebra.Expression | undefined,
): Algebra.Expression | undefined {
  const renamedPairs = [ ...renameOf ];
  const conditions = renamedPairs.map(([ name, rename ]) => {
    const sameTerm = sameTermExpression(c, c.AF.createTermExpression(DF.variable(name)), DF.variable(rename));
    return options.identicalSolutions ?
      disjunctionOf(c, [ conjunctionOf(c, [ unboundExpression(c, name), unboundExpression(c, rename) ]), sameTerm ]) :
      disjunctionOf(c, [ unboundExpression(c, name), unboundExpression(c, rename), sameTerm ]);
  });
  if (options.sharingABoundVariable) {
    conditions.push(disjunctionOf(c, renamedPairs.map(([ name, rename ]) =>
      conjunctionOf(c, [ boundExpression(c, name), boundExpression(c, rename) ]))));
  }
  if (condition) {
    // The merged solution takes a renamed variable's value from whichever side binds it.
    conditions.push(substitutedByCoalesce(c, condition, renameOf));
  }
  return conditions.length === 0 ? undefined : conjunctionOf(c, conditions);
}

/**
 * Substitutes, in an OPTIONAL's condition, every renamed variable `?x` by `COALESCE(?x, ?renamed)`, its value in the
 * merged solution; `BOUND(?x)` becomes `BOUND(?x) || BOUND(?renamed)`, and an EXISTS binds the merged value itself.
 * @param c - The provenance capture context
 * @param expression - The condition
 * @param renameOf - The rename of each renamed variable, by name
 * @returns the substituted condition
 */
function substitutedByCoalesce(
  c: ProvenanceCaptureContext,
  expression: Algebra.Expression,
  renameOf: ReadonlyMap<string, string>,
): Algebra.Expression {
  const { AF } = c;
  const substitutedTerm = (term: RDF.Term): Algebra.Expression => {
    if (![ ...termVars(term) ].some(name => renameOf.has(name))) {
      return AF.createTermExpression(term);
    }
    if (term.termType === 'Variable') {
      return AF.createOperatorExpression('coalesce', [
        AF.createTermExpression(term),
        AF.createTermExpression(DF.variable(renameOf.get(term.value)!)),
      ]);
    }
    const quad = <RDF.Quad> term;
    return AF.createOperatorExpression('triple', [ quad.subject, quad.predicate, quad.object ].map(substitutedTerm));
  };
  const substitute = (operand: Algebra.Expression): Algebra.Expression => {
    switch (operand.subType) {
      case Algebra.ExpressionTypes.TERM:
        return substitutedTerm(operand.term);
      case Algebra.ExpressionTypes.OPERATOR: {
        const [ argument ] = operand.args;
        const renamedBound = operand.operator === 'bound' && argument?.subType === Algebra.ExpressionTypes.TERM ?
          renameOf.get(argument.term.value) :
          undefined;
        return renamedBound === undefined ?
          AF.createOperatorExpression(operand.operator, operand.args.map(substitute)) :
          disjunctionOf(c, [ operand, boundExpression(c, renamedBound) ]);
      }
      case Algebra.ExpressionTypes.NAMED:
        return AF.createNamedExpression(operand.name, operand.args.map(substitute));
      case Algebra.ExpressionTypes.EXISTENCE: {
        // A triple pattern takes no expression, so the pattern reads the merged value of a fresh variable.
        const readNames = [ ...collectVariableNames(c.astTransformer, operand.input) ]
          .filter(name => renameOf.has(name));
        if (readNames.length === 0) {
          return operand;
        }
        const mergedOf = new Map(readNames.map(name => [ name, c.coinInternalVariable().value ]));
        const bindingMerged = readNames.reduce<Algebra.Operation>((operation, name) => AF.createExtend(
          operation,
          DF.variable(mergedOf.get(name)!),
          substitutedTerm(DF.variable(name)),
        ), AF.createBgp([]));
        return AF.createExistenceExpression(
          operand.not,
          AF.createJoin([ bindingMerged, renameVariables(c, operand.input, mergedOf) ]),
        );
      }
      default:
        return operand;
    }
  };
  return substitute(expression);
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
 * The rewrite of a filter: a top-level `NOT EXISTS` becomes a difference, and a top-level `EXISTS` the difference with
 * that difference, `P ⊖ (P ⊖ P2)`.
 * @param c - The provenance capture context
 * @param filter - The filter
 * @returns the pattern
 */
function filterPatternOf(c: ProvenanceCaptureContext, filter: Algebra.Filter): ProvenancePattern {
  const outerNames = inScopeVariableNames(filter.input);
  // A correlated (NOT) EXISTS, whose pattern reads an outer variable it may leave unbound, stays a filter: a
  // difference compares solutions where SPARQL substitutes the outer values into the pattern.
  const isUncorrelatedExistence = (conjunct: Algebra.Expression): conjunct is Algebra.ExistenceExpression => {
    if (conjunct.subType !== Algebra.ExpressionTypes.EXISTENCE) {
      return false;
    }
    const boundNames = cpMetaOf(c, conjunct.input).cVars;
    return ![ ...collectVariableNames(c.astTransformer, conjunct.input) ]
      .some(name => outerNames.has(name) && !boundNames.has(name));
  };
  const existences: Algebra.ExistenceExpression[] = [];
  const remaining: Algebra.Expression[] = [];
  for (const conjunct of splitConjunction(filter.expression)) {
    if (isUncorrelatedExistence(conjunct)) {
      existences.push(conjunct);
    } else {
      remaining.push(conjunct);
    }
  }
  const filtered = existences
    .reduce((pattern, existence) => {
      const solutionsWithout = differenceOf(c, pattern, patternOf(c, existence.input));
      return existence.not ?
        solutionsWithout :
        differenceOf(c, pattern, solutionsWithout, { identicalSolutions: true });
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
  const keyOfVariable = joinVariables
    .filter(variable => !certainlyBound.has(variable.value))
    .map(variable => <const> [ variable, c.coinInternalVariable() ]);
  const withKeys = (operation: Algebra.Operation): Algebra.Operation => keyOfVariable.reduce<Algebra.Operation>(
    (keyed, [ variable, key ]) =>
      AF.createExtend(keyed, key, boundOrUnboundArgumentExpression(AF, AF.createTermExpression(variable))),
    operation,
  );
  const solutionsOnJoin = AF.createProject(withKeys(solutionsRewritten), [
    ...joinVariables.filter(variable => certainlyBound.has(variable.value)),
    ...keyOfVariable.map(([ , key ]) => key),
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
        const inputRewritten = input.rewrite(provenanceChildPrefix(prefix, 'sum'));
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
    rewrite: prefix => attachProvenanceToAnswers(
      c,
      withIdentity(c, groupsWithTheirKeys, group.variables, provenanceNodeVariableName(prefix, 'aggregate')),
      solutions,
      provenanceChildPrefix(prefix, 'aggregate'),
      group.variables,
      project.variables,
    ),
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
  const answers = c.AF.createDistinct(c.AF.createProject(withoutProvenance(c, slice), answerVariables));
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
    case Algebra.Types.SERVICE:
      // Neither reads the view, so neither has derivations.
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
