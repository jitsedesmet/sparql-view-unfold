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
import { mappingFromConstructs } from './mapping.js';
import { rewriteNonRecursivePaths } from './transformations/pathTransformation.js';
import type { TransformationContext } from './transformContext.js';
import { createTransformationContext, parseQuery } from './transformContext.js';
import type { Mapping } from './types.js';
import { assertUserQueryIsSupported } from './userQueryRestrictions.js';
import { cpMetaOf, withoutCpVars } from './utils/certainlyBoundVars.js';
import { projectSolutionExistence } from './utils/operationhelpers.js';
import { DF, tripleTerm } from './utils/rdfDatatypes.js';
import { intersectSets } from './utils/setUtils.js';
import { queryFormTypes, solutionModifierChainOf } from './utils/solutionModifierChain.js';
import { collectVariableNames, freshVarGenerator } from './utils.js';

/**
 * @fileoverview Provenance capture: which view triples, and which source triples, every answer rests on.
 *
 * A *derivation* is one solution of a mapping body. {@link provenanceMappingFromConstructQueries} gives each
 * a stable identity, linked by `derivationOf` to the view triples it produces and by `derivedFrom` to the
 * source triples it matched. {@link provenanceCapturingQuery} makes a SELECT over the view also select, per
 * triple pattern, the derivation that pattern matched. Unfolded against the provenance mapping, it answers
 * one row per combination of derivations an answer has.
 *
 * The query side is the semiring query rewriting of Hernández et al., "Computing How-Provenance for SPARQL
 * Queries via Query Rewriting" (https://doi.org/10.14778/3484224.3484235), Def. 4.3: every triple pattern
 * becomes Reify(p(s, o), ?Σi) and the new variables are projected, so a row is one monomial and the rows of an
 * answer are its sum. Here the reification is `?derivationN derivationOf <<( s p o )>>`, its reifiers
 * derivations.
 *
 * OPTIONAL, MINUS and EXISTS get positive provenance only. That paper (Def. 4.12) and Asma et al., "NPCS:
 * Native Provenance Computation for SPARQL" (https://doi.org/10.1145/3589334.3645557) annotate them with ⊖ in
 * spm-semirings instead; the former (p. 3400) shows the positive annotation of an OPTIONAL query,
 * u3 ⊗ (u1 ⊕ u2), to be incorrect, as it does not commute with homomorphisms.
 */

/** Stands in for an unbound variable where a term is needed: in a derivation's identity and in a join key. */
const unboundMarker = DF.namedNode(`${PROVENANCE_NAMESPACE}unbound`);

/** The transformation context, with the variable coiners provenance capture needs. */
type ProvenanceCaptureContext = TransformationContext & {
  /** Coins the variable a triple pattern's derivation is selected as. */
  coinDerivationVariable: () => RDF.Variable;
  /** The names of every variable {@link coinDerivationVariable} coined. */
  derivationVariableNames: Set<string>;
  /** Coins a variable that never leaves the operation it is coined for. */
  coinInternalVariable: () => RDF.Variable;
};

/**
 * Creates the triple term a triple pattern writes.
 * @param triple - The triple pattern
 * @returns the triple term
 */
function tripleTermOf(triple: RDF.BaseQuad): RDF.Quad {
  return tripleTerm(triple.subject, triple.predicate, triple.object);
}

/**
 * Reads the variables every solution of an operation binds, without caching that on the operation.
 * @param operation - The operation to read
 * @returns the names of those variables
 */
function certainlyBoundVariablesOf(operation: Algebra.Operation): Set<string> {
  return cpMetaOf(withoutCpVars(operation)).cVars;
}

/**
 * Creates `COALESCE(?variable, unboundMarker)`: the variable's value, or the marker where it is unbound.
 * @param AF - The algebra factory to create it with
 * @param variable - The variable to read
 * @returns the expression
 */
function valueOrUnboundMarker(AF: TransformationContext['AF'], variable: RDF.Variable): Algebra.Expression {
  return AF.createOperatorExpression('coalesce', [
    AF.createTermExpression(variable),
    AF.createTermExpression(unboundMarker),
  ]);
}

/**
 * Finds the GROUP a projection writes its GROUP BY on: its input, below the binds of its aggregates, its HAVING
 * and its ORDER BY.
 * @param project - The projection to read
 * @returns the GROUP, or `undefined` when the projection groups nothing
 */
function groupProjectedBy(project: Algebra.Project): Algebra.Group | undefined {
  let input = project.input;
  while (input.type === Algebra.Types.EXTEND || input.type === Algebra.Types.FILTER ||
    input.type === Algebra.Types.ORDER_BY) {
    input = input.input;
  }
  return input.type === Algebra.Types.GROUP ? input : undefined;
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
function provenanceConstructOf(
  tools: MappingConstructionTools,
  construct: Algebra.Construct,
  constructIdentifier: RDF.NamedNode,
): Algebra.Construct {
  const { AF } = tools;
  const body = construct.input;
  const coinVariable = freshVarGenerator(collectVariableNames(tools.astTransformer, construct), 'derivation');
  const { cVars: certainlyBound, vRanges: scope } = cpMetaOf(withoutCpVars(body));
  // A variable the body may leave unbound enters the identity as its value or the marker, an unbound argument
  // making the identity itself unbound.
  let identifiedBody = body;
  const identifyingVariables = [ ...scope.keys() ].map((name) => {
    if (certainlyBound.has(name)) {
      return DF.variable(name);
    }
    const valueOrMarker = coinVariable();
    identifiedBody = AF.createExtend(identifiedBody, valueOrMarker, valueOrUnboundMarker(AF, DF.variable(name)));
    return valueOrMarker;
  });
  const derivation = coinVariable();
  const derivationIdentity = AF.createNamedExpression(DF.namedNode(EXTENSION_FUNCTION_BNODE), [
    AF.createTermExpression(constructIdentifier),
    ...identifyingVariables.map(variable => AF.createTermExpression(variable)),
  ]);
  const derivationLink = (predicate: string, triple: RDF.BaseQuad): Algebra.Pattern =>
    AF.createPattern(derivation, DF.namedNode(predicate), tripleTermOf(triple));
  return AF.createConstruct(AF.createExtend(identifiedBody, derivation, derivationIdentity), [
    ...construct.template.map(triple => derivationLink(PREDICATE_DERIVATION_OF, triple)),
    ...triplePatternsEverySolutionMatches(body).map(pattern => derivationLink(PREDICATE_DERIVED_FROM, pattern)),
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
        <Algebra.Construct> parseQuery(tools, constructQuery),
        DF.namedNode(`${PROVENANCE_NAMESPACE}construct${index}`),
      )),
    options,
  );
}

/**
 * Replaces the triple patterns of a BGP by lookups of the derivations of the view triples they match.
 * @param c - The provenance capture context
 * @param bgp - The BGP to rewrite
 * @param coinVariable - Coins the variable each lookup binds its derivation to
 * @returns the lookups
 */
function derivationLookupsOf(
  c: ProvenanceCaptureContext,
  bgp: Algebra.Bgp,
  coinVariable: () => RDF.Variable,
): Algebra.Bgp {
  const derivationOf = DF.namedNode(PREDICATE_DERIVATION_OF);
  return c.AF.createBgp(bgp.patterns.map(pattern =>
    c.AF.createPattern(coinVariable(), derivationOf, tripleTermOf(pattern))));
}

/**
 * The derivation variables an operation selects.
 * @param c - The provenance capture context
 * @param operation - The rewritten operation to read
 * @returns those variables
 */
function derivationsSelectedBy(c: ProvenanceCaptureContext, operation: Algebra.Operation): RDF.Variable[] {
  return algebraUtils.inScopeVariables(operation)
    .filter(variable => c.derivationVariableNames.has(variable.value));
}

/**
 * Replaces every BGP outside a SERVICE by its derivation lookups projected onto the BGP's own variables, so
 * the solutions stay the same and select no derivation.
 * @param c - The provenance capture context
 * @param object - The operation or expression to rewrite
 * @returns the rewritten operation or expression
 */
function withDerivationsHidden<T extends object>(c: ProvenanceCaptureContext, object: T): T {
  return algebraUtils.mapOperation<'unsafe', T>(object, {
    [Algebra.Types.BGP]: { transform: (bgp) => {
      const lookups = derivationLookupsOf(c, bgp, c.coinInternalVariable);
      const variables = algebraUtils.inScopeVariables(bgp);
      return variables.length === 0 ? projectSolutionExistence(c, lookups) : c.AF.createProject(lookups, variables);
    } },
    [Algebra.Types.SERVICE]: { preVisitor: () => ({ continue: false }) },
  });
}

/**
 * Attaches to every answer the derivations of the solutions agreeing with it on the join variables, where an
 * unbound variable only agrees with an unbound one.
 *
 * The shape of the aggregate rewrite of Hernández et al., "Computing How-Provenance for SPARQL Queries via
 * Query Rewriting" (https://doi.org/10.14778/3484224.3484235), Def. 4.17: answers computed apart, joined with
 * the provenance under cautious compatibility, which skips strongly bound variables as this joins certainly
 * bound ones directly. A COALESCE key replaces their renaming and filter. LIMIT and OFFSET are in neither that
 * paper nor NPCS.
 * @param c - The provenance capture context
 * @param answers - The answers, selecting the join and answer variables but no derivation
 * @param solutions - The solutions the answers are computed from, selecting their derivations
 * @param joinVariables - The variables answers and solutions are matched on
 * @param answerVariables - The variables to select of an answer
 * @returns the answers, once per derivation of a matching solution
 */
function attachDerivationsToAnswers(
  c: ProvenanceCaptureContext,
  answers: Algebra.Operation,
  solutions: Algebra.Operation,
  joinVariables: RDF.Variable[],
  answerVariables: RDF.Variable[],
): Algebra.Project {
  const { AF } = c;
  const derivations = derivationsSelectedBy(c, solutions);
  const certainlyBound = intersectSets([ certainlyBoundVariablesOf(answers), certainlyBoundVariablesOf(solutions) ]);
  const keyedVariables = joinVariables.filter(variable => !certainlyBound.has(variable.value));
  const keys = keyedVariables.map(() => c.coinInternalVariable());
  // A join lets an unbound variable match any value, so a variable that may be unbound is joined on a key.
  const withKeys = (operation: Algebra.Operation): Algebra.Operation =>
    keyedVariables.reduce<Algebra.Operation>((keyed, variable, index) => AF.createExtend(
      keyed,
      keys[index],
      valueOrUnboundMarker(AF, variable),
    ), operation);
  const solutionsOnJoin = AF.createProject(withKeys(solutions), [
    ...joinVariables.filter(variable => certainlyBound.has(variable.value)),
    ...keys,
    ...derivations,
  ]);
  const answersWithDerivations = AF.createLeftJoin(withKeys(answers), solutionsOnJoin);
  return AF.createProject(answersWithDerivations, [ ...answerVariables, ...derivations ]);
}

/**
 * Rewrites an operation to also select, per triple pattern outside a SERVICE, the derivation that pattern
 * matched.
 * @param c - The provenance capture context
 * @param operation - The operation to rewrite
 * @returns the rewritten operation
 */
function withDerivations(c: ProvenanceCaptureContext, operation: Algebra.Operation): Algebra.Operation {
  const { AF } = c;
  return algebraUtils.mapOperation<'unsafe', Algebra.Operation>(operation, {
    [Algebra.Types.BGP]: { transform: bgp => derivationLookupsOf(c, bgp, c.coinDerivationVariable) },
    [Algebra.Types.PROJECT]: { transform: (project, original) => {
      const group = groupProjectedBy(project);
      if (group === undefined) {
        return AF.createProject(project.input, [ ...project.variables, ...derivationsSelectedBy(c, project.input) ]);
      }
      // An aggregate counts the solutions of its group rather than their derivations, so the groups are
      // computed without derivations and the derivations of their solutions attached afterwards.
      const groupsWithTheirKeys = AF.createProject(original.input, [
        ...original.variables,
        ...group.variables.filter(variable => !original.variables.some(selected => selected.equals(variable))),
      ]);
      return attachDerivationsToAnswers(
        c,
        withDerivationsHidden(c, groupsWithTheirKeys),
        group.input,
        group.variables,
        original.variables,
      );
    } },
    [Algebra.Types.SLICE]: { transform: (slice, original) => {
      // LIMIT and OFFSET count solutions rather than their derivations, likewise. Every solution agreeing with
      // an answer is one of its derivations, so the solutions need no order and the answers no repeats.
      const answerVariables = algebraUtils.inScopeVariables(original);
      const unorderedSolutions = algebraUtils.mapOperation<'unsafe', Algebra.Operation>(slice.input, {
        [Algebra.Types.ORDER_BY]: { transform: orderBy => orderBy.input },
        [Algebra.Types.SLICE]: { preVisitor: () => ({ continue: false }) },
      });
      return attachDerivationsToAnswers(
        c,
        AF.createDistinct(AF.createProject(withDerivationsHidden(c, original), answerVariables)),
        unorderedSolutions,
        answerVariables,
        answerVariables,
      );
    } },
    [Algebra.Types.SERVICE]: { preVisitor: () => ({ continue: false }) },
  });
}

/**
 * Rewrites a SELECT query over the view to also select, per triple pattern, the derivation that pattern
 * matched.
 * @param c - The transformation context to rewrite with
 * @param operation - The SELECT query over the view
 * @returns the query over the provenance view
 * @throws Error if the query is not a SELECT, or breaks a restriction of the rewriting
 */
function captureProvenance(c: TransformationContext, operation: Algebra.Operation): Algebra.Operation {
  const queryForm = [ ...solutionModifierChainOf(operation) ].find(modifier => queryFormTypes.has(modifier.type));
  if (queryForm?.type !== Algebra.Types.PROJECT) {
    throw new Error('Provenance can only be captured for a SELECT query.');
  }
  assertUserQueryIsSupported(operation);
  const pathless = rewriteNonRecursivePaths(c, operation);
  const variableNames = collectVariableNames(c.astTransformer, pathless);
  const derivationVariableNames = new Set<string>();
  const coinFreshDerivationVariable = freshVarGenerator(variableNames, 'derivation');
  return withDerivations({
    ...c,
    coinDerivationVariable: () => {
      const derivation = coinFreshDerivationVariable();
      derivationVariableNames.add(derivation.value);
      return derivation;
    },
    derivationVariableNames,
    coinInternalVariable: freshVarGenerator(variableNames, 'internal'),
  }, pathless);
}

/**
 * Rewrites a SELECT query over the view, in algebra form, as {@link provenanceCapturingQuery} does.
 * @param operation - The SELECT query over the view
 * @returns the query over the provenance view
 * @throws Error if the query is not a SELECT, or breaks a restriction of the rewriting
 */
export function provenanceCapturingOperation(operation: Algebra.Operation): Algebra.Operation {
  return captureProvenance(createTransformationContext(), operation);
}

/**
 * Rewrites a SELECT query over the view into one that also selects, per triple pattern, the derivation that
 * pattern matched. Unfolded against {@link provenanceMappingFromConstructQueries}, it answers one row per
 * combination of derivations an answer has.
 * @param query - The SELECT query over the view
 * @returns the SPARQL 1.2 query over the provenance view
 * @throws Error if the query is not a SELECT, or breaks a restriction of the rewriting
 */
export function provenanceCapturingQuery(query: string): string {
  const c = createTransformationContext();
  return c.generator.generate(toAst(captureProvenance(c, parseQuery(c, query))));
}
