import type * as RDF from '@rdfjs/types';
import { toAst } from '@traqula/algebra-sparql-1-2';
import { Algebra, algebraUtils } from '@traqula/algebra-transformations-1-2';
import {
  EXTENSION_FUNCTION_BNODE,
  PREDICATE_DERIVATION_OF,
  PREDICATE_DERIVED_FROM,
  PROVENANCE_NAMESPACE,
} from './consts.js';
import type { MappingConstructionTools, MappingOptions } from './mapping.js';
import { mappingFromConstructs, parseConstructQuery } from './mapping.js';
import { boundOrUnboundArgumentExpression } from './transformations/bnodeExtensionFunction.js';
import { rewriteNonRecursivePaths } from './transformations/pathTransformation.js';
import type { TransformationContext } from './transformContext.js';
import { createTransformationContext, parseQuery } from './transformContext.js';
import type { Mapping } from './types.js';
import { assertUserQueryIsSupported } from './userQueryRestrictions.js';
import { cpMetaOf, withoutCpVars } from './utils/certainlyBoundVars.js';
import { conjunctionOf, splitConjunction } from './utils/expressionHelpers.js';
import { groupProjectedBy, projectOntoVariablesOrExistence } from './utils/operationhelpers.js';
import { datatypeInteger, DF, tripleTerm } from './utils/rdfDatatypes.js';
import { queryFormTypes, solutionModifierChainOf } from './utils/solutionModifierChain.js';
import { collectVariableNames, freshVarGenerator, markVariableNamesUsed, renameVariables } from './utils.js';

/**
 * @fileoverview Provenance capture: a mapping linking each derivation, one solution of a mapping body, to the triples
 * it produces and matched, and SPARQLprov's rewrite of a SELECT to also select the how-provenance of its answers over
 * those derivations. See ARCHITECTURE.md.
 */

const derivationOfPredicate = DF.namedNode(PREDICATE_DERIVATION_OF);
const derivedFromPredicate = DF.namedNode(PREDICATE_DERIVED_FROM);

/**
 * Creates the triple term a triple pattern writes.
 * @param triple - The triple pattern
 * @returns the triple term
 */
function tripleTermOf(triple: RDF.BaseQuad): RDF.Quad {
  return tripleTerm(triple.subject, triple.predicate, triple.object);
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
  const derivationIdentity = AF.createNamedExpression(DF.namedNode(EXTENSION_FUNCTION_BNODE), [
    AF.createTermExpression(constructIdentifier),
    ...algebraUtils.inScopeVariables(body).map(variable => AF.createTermExpression(variable)),
  ]);
  const derivationLink = (predicate: RDF.NamedNode, triple: RDF.BaseQuad): Algebra.Pattern =>
    AF.createPattern(derivation, predicate, tripleTermOf(triple));
  return AF.createConstruct(AF.createExtend(body, derivation, derivationIdentity), [
    ...construct.template.map(triple => derivationLink(derivationOfPredicate, triple)),
    ...triplePatternsEverySolutionMatches(body).map(pattern => derivationLink(derivedFromPredicate, pattern)),
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
  const tools = createTransformationContext();
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

/**
 * A query being rewritten: the original operation, and its rewrite under a provenance variable prefix.
 * Combinators over these build the rewrites of operators SPARQL has no operation for, like SPARQLprov's `diff`.
 */
interface ProvenancePattern {
  /** The original operation, whose in-scope and certainly bound variables the rewrite reads. */
  original: Algebra.Operation;
  /**
   * Rewrites the pattern, SPARQLprov's α(Q, z).
   * @param prefix - The provenance variable prefix z of its root.
   * @returns The rewritten operation.
   */
  rewrite: (prefix: string) => Algebra.Operation;
}

/** The literal `1`, the polynomial of a solution produced from no data. */
const constantOne = DF.literal('1', datatypeInteger);

/**
 * Reads the variables every solution of an operation binds, without caching that on the operation.
 * @param operation - The operation to read
 * @returns the names of those variables
 */
function certainlyBoundVariablesOf(operation: Algebra.Operation): Set<string> {
  return cpMetaOf(withoutCpVars(operation)).cVars;
}

/**
 * The provenance variables an operation selects.
 * @param c - The provenance capture context
 * @param operation - The rewritten operation to read
 * @returns those variables
 */
function provenanceVariablesOf(c: ProvenanceCaptureContext, operation: Algebra.Operation): RDF.Variable[] {
  return algebraUtils.inScopeVariables(operation)
    .filter(variable => variable.value.startsWith(`${c.provenanceVariablePrefix}_`));
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
  return AF.createExtend(operation, DF.variable(provenanceVariableName), AF.createNamedExpression(
    DF.namedNode(EXTENSION_FUNCTION_BNODE),
    [
      AF.createTermExpression(DF.literal(provenanceVariableName)),
      ...[ ...variables ].sort((left, right) => left.value.localeCompare(right.value))
        .map(variable => AF.createTermExpression(variable)),
    ],
  ));
}

/**
 * Annotates every solution of an operation with the polynomial `1`, as the solutions of the empty BGP are.
 * @param c - The provenance capture context
 * @param operation - The operation, whose solutions are produced from no reified data
 * @param prefix - The provenance variable prefix
 * @returns the annotated operation
 */
function withConstantOne(c: ProvenanceCaptureContext, operation: Algebra.Operation, prefix: string): Algebra.Extend {
  return c.AF.createExtend(operation, DF.variable(`${prefix}_statement`), c.AF.createTermExpression(constantOne));
}

/**
 * Lifts an operation into a pattern rewritten by {@link rewriteWithProvenance}.
 * @param c - The provenance capture context
 * @param operation - The operation
 * @returns the pattern
 */
function patternOf(c: ProvenanceCaptureContext, operation: Algebra.Operation): ProvenancePattern {
  return { original: operation, rewrite: prefix => rewriteWithProvenance(c, operation, prefix) };
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
  return {
    original,
    rewrite: prefix => withIdentity(
      c,
      combine(patterns.map((pattern, index) => pattern.rewrite(`${prefix}_${kind}_${index + 1}`))),
      algebraUtils.inScopeVariables(original),
      `${prefix}_${kind}`,
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
  return {
    original: c.AF.createFilter(pattern.original, expression),
    rewrite: prefix => c.AF.createFilter(pattern.rewrite(prefix), expression),
  };
}

/** How a {@link differenceOf} removes the solutions of its minuend. */
interface DifferenceOptions {
  /** Only a solution of the subtrahend that, merged, satisfies this removes one, as for an OPTIONAL's condition. */
  condition?: Algebra.Expression;
  /** Only a solution sharing a bound variable removes one, as for MINUS. */
  sharingABoundVariable?: boolean;
}

/**
 * The difference (⊖) of two patterns, SPARQLprov's `diff`: the minuend's solutions, each with the provenance of the
 * subtrahend's solutions compatible with it (Def. 4.12 (5)). Rather than SPARQLprov's conditioned OPTIONAL, which
 * Comunica only evaluates as a bind join that cannot bind through a BIND, the compatible pairs are joined apart,
 * keyed by the minuend's identity, and left-joined back on it: the same table.
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
  const subtrahendDomain = new Set(algebraUtils.inScopeVariables(subtrahend.original).map(variable => variable.value));
  const shared = minuendDomain.filter(variable => subtrahendDomain.has(variable.value));
  if (options.sharingABoundVariable && shared.length === 0) {
    // A MINUS without a shared variable removes nothing.
    return minuend;
  }
  return {
    original: minuend.original,
    rewrite: (prefix) => {
      const identity = `${prefix}_difference`;
      let subtrahendRewritten = subtrahend.rewrite(`${prefix}_difference_2_sum`);
      const conditions: Algebra.Expression[] = options.condition ? [ options.condition ] : [];
      if (options.sharingABoundVariable) {
        // A join cannot tell which side bound a shared variable, so MINUS renames them in the subtrahend.
        const renamed = shared.map(variable => <const> [ variable, c.coinInternalVariable() ]);
        subtrahendRewritten = renameVariables(
          c,
          subtrahendRewritten,
          new Map(renamed.map(([ variable, rename ]) => [ variable.value, rename.value ])),
        );
        const bound = (variable: RDF.Variable): Algebra.Expression =>
          AF.createOperatorExpression('bound', [ AF.createTermExpression(variable) ]);
        conditions.push(
          ...renamed.map(([ variable, rename ]) => AF.createOperatorExpression('||', [
            AF.createOperatorExpression('||', [
              AF.createOperatorExpression('!', [ bound(variable) ]),
              AF.createOperatorExpression('!', [ bound(rename) ]),
            ]),
            AF.createOperatorExpression('sameterm', [
              AF.createTermExpression(variable),
              AF.createTermExpression(rename),
            ]),
          ])),
          renamed.map(([ variable, rename ]) => AF.createOperatorExpression('&&', [ bound(variable), bound(rename) ]))
            .reduce((left, right) => AF.createOperatorExpression('||', [ left, right ])),
        );
      }
      const compatiblePairs = AF.createJoin([
        withIdentity(c, withoutProvenance(c, minuend.original), minuendDomain, identity),
        subtrahendRewritten,
      ], false);
      const subtrahendProvenance = AF.createProject(
        conditions.length === 0 ? compatiblePairs : AF.createFilter(compatiblePairs, conjunctionOf(c, conditions)),
        [ DF.variable(identity), ...provenanceVariablesOf(c, subtrahendRewritten) ],
      );
      return AF.createExtend(
        AF.createLeftJoin(
          withIdentity(c, minuend.rewrite(`${prefix}_difference_1`), minuendDomain, identity),
          subtrahendProvenance,
        ),
        DF.variable(`${prefix}_difference_2_sum`),
        AF.createTermExpression(DF.variable(identity)),
      );
    },
  };
}

/**
 * The rewrite of a filter, its top-level `NOT EXISTS` a difference and its top-level `EXISTS` the difference with
 * that difference, `P ⊖ (P ⊖ P2)`, which keeps a solution exactly when a compatible one exists.
 * @param c - The provenance capture context
 * @param filter - The filter
 * @returns the pattern
 */
function filterPatternOf(c: ProvenanceCaptureContext, filter: Algebra.Filter): ProvenancePattern {
  const conjuncts = splitConjunction(filter.expression);
  const remaining = conjuncts.filter(conjunct => conjunct.subType !== Algebra.ExpressionTypes.EXISTENCE);
  const filtered = conjuncts.filter(conjunct => conjunct.subType === Algebra.ExpressionTypes.EXISTENCE)
    .reduce((pattern, existence) => {
      const solutionsWithout = differenceOf(c, pattern, patternOf(c, existence.input));
      return existence.not ? solutionsWithout : differenceOf(c, pattern, solutionsWithout);
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
  return {
    ...combinationOf(c, 'osum', [
      leftJoin.expression ? filteredBy(c, joined, leftJoin.expression) : joined,
      differenceOf(c, left, right, { condition: leftJoin.expression }),
    ]),
    original: leftJoin,
  };
}

/**
 * Replaces every BGP outside a SERVICE by the distinct solutions of its derivation lookups on the BGP's own
 * variables: the BGP's solutions over the view as a set, selecting no provenance (this repo's choice).
 * @param c - The provenance capture context
 * @param operation - The operation to rewrite
 * @returns the rewritten operation
 */
function withoutProvenance(c: ProvenanceCaptureContext, operation: Algebra.Operation): Algebra.Operation {
  return algebraUtils.mapOperation<'unsafe', Algebra.Operation>(operation, {
    [Algebra.Types.BGP]: { transform: bgp => c.AF.createDistinct(projectOntoVariablesOrExistence(
      c,
      c.AF.createBgp(bgp.patterns.map(pattern =>
        c.AF.createPattern(c.coinInternalVariable(), derivationOfPredicate, tripleTermOf(pattern)))),
      algebraUtils.inScopeVariables(bgp),
    )) },
    [Algebra.Types.SERVICE]: { preVisitor: () => ({ continue: false }) },
  });
}

/**
 * Attaches to every answer the provenance of the solutions agreeing with it on the join variables, where an unbound
 * variable only agrees with an unbound one: the cautious join `and=` of SPARQLprov, Def. 4.17, here also used for a
 * SLICE.
 * @param c - The provenance capture context
 * @param answers - The answers, selecting the join and answer variables
 * @param solutions - The rewritten solutions the answers are computed from
 * @param joinVariables - The variables answers and solutions are matched on
 * @param answerVariables - The variables to select of an answer
 * @returns the answers, once per row of a matching solution
 */
function attachProvenanceToAnswers(
  c: ProvenanceCaptureContext,
  answers: Algebra.Operation,
  solutions: Algebra.Operation,
  joinVariables: RDF.Variable[],
  answerVariables: RDF.Variable[],
): Algebra.Project {
  const { AF } = c;
  const solutionsProvenance = provenanceVariablesOf(c, solutions);
  // The answers are computed from the solutions, so a variable every solution binds every answer binds too.
  const certainlyBound = certainlyBoundVariablesOf(solutions);
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
  const solutionsOnJoin = AF.createProject(withKeys(solutions), [
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
 * Rewrites a projection, SPARQLprov's `select` (Def. 4.12 (6)), or, over a GROUP, its aggregate query (Def. 4.17):
 * the groups computed without provenance, and the provenance of their solutions attached under the lineage δ.
 * @param c - The provenance capture context
 * @param project - The projection
 * @param prefix - The provenance variable prefix
 * @returns the rewritten projection
 */
function rewriteProjection(c: ProvenanceCaptureContext, project: Algebra.Project, prefix: string): Algebra.Operation {
  const { AF } = c;
  const group = groupProjectedBy(project);
  if (group === undefined) {
    const input = rewriteWithProvenance(c, project.input, `${prefix}_sum`);
    return AF.createProject(withIdentity(c, input, project.variables, `${prefix}_sum`), [
      ...project.variables,
      ...provenanceVariablesOf(c, input),
      DF.variable(`${prefix}_sum`),
    ]);
  }
  // An aggregate counts solutions rather than their provenance, so the subtree is duplicated: the groups are computed
  // without provenance and that of their solutions attached afterwards (SPARQLprov, Def. 4.17).
  const groupsWithTheirKeys = AF.createProject(project.input, [
    ...project.variables,
    ...group.variables.filter(variable => !project.variables.some(selected => selected.equals(variable))),
  ]);
  return attachProvenanceToAnswers(
    c,
    withIdentity(c, withoutProvenance(c, groupsWithTheirKeys), group.variables, `${prefix}_aggregate`),
    rewriteProjection(c, AF.createProject(group.input, group.variables), `${prefix}_aggregate`),
    group.variables,
    project.variables,
  );
}

/**
 * Rewrites a SLICE: LIMIT and OFFSET count solutions likewise, so the GROUP duplication applies to them too, this
 * repo's choice. Every solution agreeing with an answer is one it rests on, so the solutions need no order and the
 * answers no repeats.
 * @param c - The provenance capture context
 * @param slice - The SLICE
 * @param prefix - The provenance variable prefix
 * @returns the rewritten SLICE
 */
function rewriteSlice(c: ProvenanceCaptureContext, slice: Algebra.Slice, prefix: string): Algebra.Operation {
  const answerVariables = algebraUtils.inScopeVariables(slice);
  const unorderedSolutions = algebraUtils.mapOperation<'unsafe', Algebra.Operation>(slice.input, {
    [Algebra.Types.ORDER_BY]: { transform: orderBy => orderBy.input },
    [Algebra.Types.SLICE]: { preVisitor: () => ({ continue: false }) },
  });
  return attachProvenanceToAnswers(
    c,
    c.AF.createDistinct(c.AF.createProject(withoutProvenance(c, slice), answerVariables)),
    rewriteWithProvenance(c, unorderedSolutions, prefix),
    answerVariables,
    answerVariables,
  );
}

/**
 * Rewrites an operation to also select the provenance of its solutions, encoded as SPARQLprov encodes polynomials
 * (Def. 4.12): SPARQLprov's α(Q, z), with `derivationOf` as its reification scheme.
 * @param c - The provenance capture context
 * @param operation - The operation to rewrite
 * @param prefix - The provenance variable prefix z of its root
 * @returns the rewritten operation
 * @throws Error if the operation is one provenance cannot be captured through
 */
function rewriteWithProvenance(c: ProvenanceCaptureContext, operation: Algebra.Operation, prefix: string):
Algebra.Operation {
  const { AF } = c;
  switch (operation.type) {
    case Algebra.Types.BGP: {
      if (operation.patterns.length === 0) {
        return withConstantOne(c, operation, prefix);
      }
      // A triple pattern is the sum of the derivations of the view triple it matches.
      const triplePatterns = operation.patterns.map(pattern => ({
        original: AF.createBgp([ pattern ]),
        rewrite: (triplePrefix: string) => withIdentity(
          c,
          AF.createBgp([ AF.createPattern(DF.variable(`${triplePrefix}_sum_statement`), derivationOfPredicate, tripleTermOf(pattern)) ]),
          algebraUtils.inScopeVariables(AF.createBgp([ pattern ])),
          `${triplePrefix}_sum`,
        ),
      }));
      return triplePatterns.length === 1 ?
        triplePatterns[0].rewrite(prefix) :
        combinationOf(c, 'product', triplePatterns).rewrite(prefix);
    }
    case Algebra.Types.JOIN:
      return combinationOf(c, 'product', operation.input.map(input => patternOf(c, input))).rewrite(prefix);
    case Algebra.Types.UNION:
      return combinationOf(c, 'osum', operation.input.map(input => patternOf(c, input))).rewrite(prefix);
    case Algebra.Types.LEFT_JOIN:
      return optionalPatternOf(c, operation).rewrite(prefix);
    case Algebra.Types.MINUS:
      return differenceOf(c, patternOf(c, operation.input[0]), patternOf(c, operation.input[1]), {
        sharingABoundVariable: true,
      }).rewrite(prefix);
    case Algebra.Types.FILTER:
      return filterPatternOf(c, operation).rewrite(prefix);
    case Algebra.Types.EXTEND:
      return AF.createExtend(
        rewriteWithProvenance(c, operation.input, prefix),
        operation.variable,
        operation.expression,
      );
    case Algebra.Types.PROJECT:
      return rewriteProjection(c, operation, prefix);
    case Algebra.Types.SLICE:
      return rewriteSlice(c, operation, prefix);
    case Algebra.Types.ORDER_BY:
      return AF.createOrderBy(rewriteWithProvenance(c, operation.input, prefix), operation.expressions);
    case Algebra.Types.DISTINCT:
    case Algebra.Types.REDUCED:
      // The decoding sums the rows of an answer, so it counts each answer once anyway, as SPARQLprov's own
      // implementation, which drops DISTINCT.
      return rewriteWithProvenance(c, operation.input, prefix);
    case Algebra.Types.VALUES:
    case Algebra.Types.SERVICE:
      // Neither reads the view, so neither has derivations: its solutions are produced from no reified data.
      return withConstantOne(c, operation, prefix);
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
  const pathless = rewriteNonRecursivePaths(c, operation);
  const variableNames = markVariableNamesUsed(c, pathless);
  let provenanceVariablePrefix = 'prov';
  for (let index = 1; [ ...variableNames ].some(name => name.startsWith(`${provenanceVariablePrefix}_`)); index++) {
    provenanceVariablePrefix = `prov${index}`;
  }
  const context = {
    ...c,
    provenanceVariablePrefix,
    coinInternalVariable: freshVarGenerator(variableNames, 'internal'),
  };
  return { query: rewriteWithProvenance(context, pathless, provenanceVariablePrefix), provenanceVariablePrefix };
}

/**
 * Rewrites a SELECT query over the view, in algebra form, as {@link provenanceCapturingQuery} does.
 * @param operation - The SELECT query over the view
 * @returns the query over the provenance view, and its provenance variable prefix
 * @throws Error if the query is not a SELECT, or breaks a restriction of the rewriting
 */
export function provenanceCapturingOperation(operation: Algebra.Operation):
ProvenanceCapturingQuery<Algebra.Operation> {
  return captureProvenance(createTransformationContext(), operation);
}

/**
 * Rewrites a SELECT query over the view into one that also selects the how-provenance of its answers, encoded as
 * SPARQLprov encodes polynomials. Unfolded against {@link provenanceMappingFromConstructQueries}, its answers decode
 * with {@link provenancePolynomial!decodeProvenance} into the polynomials over derivations explaining them.
 * @param query - The SELECT query over the view
 * @returns the SPARQL 1.2 query over the provenance view, and its provenance variable prefix
 * @throws Error if the query is not a SELECT, or breaks a restriction of the rewriting
 */
export function provenanceCapturingQuery(query: string): ProvenanceCapturingQuery<string> {
  const c = createTransformationContext();
  const { query: rewritten, provenanceVariablePrefix } = captureProvenance(c, parseQuery(c, query));
  return { query: c.generator.generate(toAst(rewritten)), provenanceVariablePrefix };
}
