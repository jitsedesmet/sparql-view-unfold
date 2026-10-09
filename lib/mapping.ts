/* eslint-disable jsdoc/check-param-names */
import type * as RDF from '@rdfjs/types';
import type { Algebra } from '@traqula/algebra-transformations-1-2';
import { algebraUtils } from '@traqula/algebra-transformations-1-2';
import { VAR_PREFIX_MAPPING, VAR_PREFIX_MERGED_HEAD } from './consts.js';
import { triplePositions } from './datastructures/TermClusterSet.js';
import type { RangeSet } from './RangeSet.js';
import { rangeOfAssertedPosition, rangeOfPosition } from './RangeSet.js';
import type { TransformationContext } from './transformContext.js';
import { createTransformationContext, parseQuery, prefixVarsInOperation } from './transformContext.js';
import type { Mapping, MappingHead } from './types.js';
import type { AssertionConjunct } from './utils/assertions.js';
import { access, assertBound, assertTermType, conjunctAsExpression } from './utils/assertions.js';
import type { VRanges } from './utils/certainlyBoundVars.js';
import { withCpVars } from './utils/certainlyBoundVars.js';
import { conjunctionOf, unstableOperators } from './utils/expressionHelpers.js';
import { projectSolutionExistence } from './utils/operationhelpers.js';
import { isSubsetOf } from './utils/setUtils.js';
import { collectVariableNames } from './utils.js';

/**
 * @fileoverview Building the {@link Mapping} the unfolding runs on, out of SPARQL CONSTRUCT queries.
 *
 * A mapping is a GAV expression: its *head* is one RDF 1.2 triple pattern and its *body* the RDF 1.1 query
 * producing the values that head is instantiated with. The unfolding wants exactly one triple in that head,
 * which is a restriction on the internal shape rather than on what a caller may write: a CONSTRUCT
 * instantiates every triple of its template once per solution of its body, so a template of N triples
 * denotes precisely the union of the N single-triple CONSTRUCTs over that same body, and
 * {@link mappingFromConstructQueries} performs that split itself.
 *
 * Several mappings are merged into a single one over the generic `?m_s ?m_p ?m_o` head, each body binding
 * those three variables to the head it came from and the bodies joined by a UNION. **A lone mapping keeps
 * its own head**, which pins the positions the head writes constants in and so lets the unfolding decide
 * far more about a pattern than the generic head ever could.
 *
 * Two restrictions live here rather than in the passes, because they are properties of the mapping and can
 * be checked once, when it is built:
 *
 * - **No unstable function in the body** ({@link unstableOperators}). The unfolding evaluates a body once
 *   per user pattern it is unfolded into, so a function that answers differently on two evaluations makes
 *   the unfolded query disagree with the mapped graph it stands for. `NOW` is deliberately allowed, SPARQL
 *   1.1 §17.4.5.1 fixing it per query execution.
 * - **Only the terms a head position admits** ({@link rangeOfAssertedPosition}), checked per triple of the
 *   template. A constant a position cannot hold is rejected outright; a variable the body could bind to such
 *   a term is filtered out instead, since a CONSTRUCT instantiates no triple for a solution that would make
 *   an illegal one (SPARQL 1.1 §16.2) - the same sentence the `FILTER(bound(?x))` below comes from. A
 *   generalized RDF view ({@link MappingOptions.generalizedRdfView}) admits any term in the positions of its
 *   triple, but not in those of a triple term, which SPARQL's `TRIPLE` only builds out of an RDF triple.
 *
 * Both checks belong to the *template triple*, which is why they happen here rather than at the unfolding:
 * once several mappings are merged the head is three plain variables and a triple term one of them is a
 * `BIND` of, whose interior nothing would re-read.
 */

/** What building a mapping may be configured with. */
export interface MappingOptions {
  /**
   * Whether the mapping denotes a generalized RDF graph, keeping the triples with any term in any position that a
   * CONSTRUCT drops. A triple term is never a generalized one: SPARQL's `TRIPLE` builds RDF triple terms only, so
   * a solution that would need another instantiates no triple.
   */
  generalizedRdfView?: boolean;
}

/** The factories building a mapping needs; the solver and the generator of a full context play no part. */
type MappingConstructionTools = Pick<TransformationContext, 'parser' | 'AF' | 'DF' | 'astTransformer'>;

/**
 * The type tests making a term of the template one its position admits, recursing into a triple term.
 * @param templateTerm - The term the position holds
 * @param admissibleRange - The term types that position admits
 * @param bodyRanges - What the body can bind each of its variables to
 * @returns T⟨?x : R⟩ per variable the body could bind outside its position
 * @throws Error for a constant the position does not admit, or a blank node, which the template mints afresh
 * per solution
 */
function admissibilityTypeTests(
  templateTerm: RDF.Term,
  admissibleRange: RangeSet,
  bodyRanges: VRanges,
): AssertionConjunct[] {
  if (templateTerm.termType === 'Variable') {
    if (isSubsetOf(bodyRanges.rangeOf(templateTerm.value), admissibleRange)) {
      return [];
    }
    return [{ access: access(templateTerm.value), assertion: assertTermType(admissibleRange) }];
  }
  if (templateTerm.termType === 'BlankNode' || !admissibleRange.has(templateTerm.termType)) {
    throw new Error(`Invalid Template, cannot use ${templateTerm.termType} in this position.`);
  }
  if (templateTerm.termType === 'Quad') {
    return triplePositions.flatMap(position =>
      admissibilityTypeTests(templateTerm[position], rangeOfPosition(position), bodyRanges));
  }
  return [];
}

/**
 * Asserts that a mapping body calls no function whose value is not a function of its arguments.
 * @param body - The mapping body to check
 * @throws Error naming the offending function
 */
function assertBodyCallsNoUnstableFunction(body: Algebra.Operation): void {
  algebraUtils.visitOperationSub(body, {}, {
    expression: { operator: { visitor: (operatorExpression) => {
      if (unstableOperators.has(operatorExpression.operator)) {
        throw new Error(`The ${operatorExpression.operator.toUpperCase()} function cannot be used in a mapping body: it answers differently each time the body is evaluated, while the mapping has to denote one fixed graph.`);
      }
    } }},
    // A mapping body may contain any path.
  });
}

/**
 * Builds the mapping one triple of a CONSTRUCT template denotes over that CONSTRUCT's body.
 * @param tools - The factories to build with
 * @param options - What the mapping is configured with
 * @param templateTriple - The one template triple becoming the head
 * @param constructBody - The WHERE clause of the CONSTRUCT, shared with the template's other triples
 * @returns the mapping
 * @throws Error if the template triple holds a term one of its positions does not admit
 */
function mappingOfSingleTemplateTriple(
  tools: MappingConstructionTools,
  options: MappingOptions,
  templateTriple: Algebra.Pattern,
  constructBody: Algebra.Operation,
): Mapping {
  const { AF, DF, astTransformer } = tools;
  const generalizedRdfView = options.generalizedRdfView === true;
  const head: MappingHead = <MappingHead> AF
    .createPattern(templateTriple.subject, templateTriple.predicate, templateTriple.object);

  const headVariableNames = [ ...collectVariableNames(astTransformer, head) ];
  // A CONSTRUCT only instantiates its template when every variable in it is bound and every term it writes
  // is one its position can hold, so the solutions failing either do not belong to the mapping. Variables
  // that are certainly bound, or certainly of a term type the position admits, already need no condition.
  const { cVars: certainlyBoundVariableNames, vRanges: bodyRanges } = withCpVars(constructBody).metadata;
  const typeTests = triplePositions.flatMap(position =>
    admissibilityTypeTests(head[position], rangeOfAssertedPosition(position, generalizedRdfView), bodyRanges));
  const conditions: AssertionConjunct[] = [
    ...headVariableNames
      .filter(name => !certainlyBoundVariableNames.has(name))
      .map(name => ({ access: access(name), assertion: assertBound() })),
    ...typeTests,
  ];
  let body: Algebra.Operation = constructBody;
  if (conditions.length > 0) {
    body = AF.createFilter(body, conjunctionOf(tools, conditions
      .map(condition => conjunctAsExpression(tools, condition))));
  }
  return {
    head,
    body: AF.createProject(body, headVariableNames.map(name => DF.variable(name))),
    generalizedRdfView,
  };
}

/**
 * Builds every single-triple mapping a CONSTRUCT query denotes.
 * @param tools - The factories to build with
 * @param options - What the mapping is configured with
 * @param constructQuery - The SPARQL CONSTRUCT query string
 * @returns one mapping per triple of the CONSTRUCT template
 * @throws Error if the body calls an unstable function, or the template holds an inadmissible term
 */
function mappingsOfConstructQuery(
  tools: MappingConstructionTools,
  options: MappingOptions,
  constructQuery: string,
): Mapping[] {
  const construct = <Algebra.Construct> parseQuery(tools, constructQuery);
  const body = construct.input;
  assertBodyCallsNoUnstableFunction(body);
  // The mappings share this body object, which is safe because `prefixVarsInOperation` copies what it
  // renames, so every mapping leaving `mappingFromConstructQueries` owns its own tree.
  return construct.template
    .map(templateTriple => mappingOfSingleTemplateTriple(tools, options, templateTriple, body));
}

/**
 * Merges several mappings into one over the generic `?m_s ?m_p ?m_o` head, each body binding those three
 * variables to the head it came from.
 * @param tools - The factories to build with
 * @param mappings - The mappings to merge, at least two
 * @returns the merged mapping
 */
function mergeMappingsOverGenericHead(
  { AF, DF }: MappingConstructionTools,
  mappings: readonly Mapping[],
): Mapping {
  const genericHeadVariables = [ 's', 'p', 'o' ]
    .map(position => DF.variable(`${VAR_PREFIX_MERGED_HEAD}${position}`));
  const [ genericSubject, genericPredicate, genericObject ] = genericHeadVariables;

  const bodiesBindingTheGenericHead = mappings.map(({ head, body }) => {
    const headPositionTerms = [ head.subject, head.predicate, head.object ];
    let bodyWithGenericHead: Algebra.Operation = body;
    for (const [ positionIndex, genericHeadVariable ] of genericHeadVariables.entries()) {
      bodyWithGenericHead = AF.createExtend(
        bodyWithGenericHead,
        genericHeadVariable,
        AF.createTermExpression(headPositionTerms[positionIndex]),
      );
    }
    return bodyWithGenericHead;
  });

  return {
    head: <MappingHead> AF.createPattern(genericSubject, genericPredicate, genericObject),
    body: AF.createProject(AF.createUnion(bodiesBindingTheGenericHead), genericHeadVariables),
    generalizedRdfView: mappings.some(mapping => mapping.generalizedRdfView),
  };
}

/**
 * Builds the {@link Mapping} a set of SPARQL CONSTRUCT queries denotes, splitting a template of several
 * triples into a mapping per triple and merging what is left into one generic head.
 * @param constructQueries - The SPARQL CONSTRUCT query strings defining the mappings
 * @param options - What the mapping is configured with
 * @returns the mapping, keeping its own head where there is exactly one and merged behind
 * `?m_s ?m_p ?m_o` otherwise
 * @throws Error if no CONSTRUCT is given, if a body calls an unstable function, or if a template holds a
 * term one of its positions does not admit
 * @example
 * const mapping = mappingFromConstructQueries([
 *   'CONSTRUCT { ?t rdf:reifies <<( ?s ?p ?o )>> } WHERE { ... }',
 *   'CONSTRUCT { ?s ?p ?o } WHERE { ?s ?p ?o . FILTER(!isTriple(?o)) }',
 * ]);
 */
export function mappingFromConstructQueries(
  constructQueries: readonly string[],
  options: MappingOptions = {},
): Mapping {
  const tools = createTransformationContext();
  const mappings = constructQueries
    .flatMap(constructQuery => mappingsOfConstructQuery(tools, options, constructQuery))
    .map(mapping => prefixVarsInOperation(tools, mapping, VAR_PREFIX_MAPPING));

  if (mappings.length === 0) {
    throw new Error('A mapping needs at least one CONSTRUCT query with at least one template triple.');
  }
  if (mappings.length === 1) {
    return mappings[0];
  }
  return mergeMappingsOverGenericHead(tools, mappings);
}

/**
 * Makes a mapping denote a *set* of triples rather than a bag, by deduplicating its body over the head's
 * own variables.
 *
 * Those variables are the triple the head constructs, the head being injective in them, so deduplicating
 * them is deduplicating the triples the mapping produces - including a triple two merged mappings both
 * produce, the merged head being the three variables every branch binds. It is **potentially expensive**:
 * the whole body of every unfolded pattern is materialised and sorted, where the unfolding otherwise
 * streams. Where the body produces many duplicate triples, it can instead speed the query up, since the
 * joins then combine fewer solutions.
 * @param context - Object containing the factories and the existence variable generator
 * @param mapping - The mapping to deduplicate
 * @returns the mapping, its body producing each triple once
 */
export function withDeduplicatedBody(
  c: Pick<TransformationContext, 'AF' | 'DF' | 'coinExistenceVariable'>,
  mapping: Mapping,
): Mapping {
  const { AF } = c;
  if (mapping.body.variables.length === 0) {
    // A head of nothing but constants writes one triple, and writes it as soon as the body has any
    // solution at all - so deduplicating it is asking whether the body has one, and the answer is a
    // single row. Deduplicating over the head's (zero) variables cannot express that: a SELECT over no
    // variables is not SPARQL, and generating one yields `SELECT *`, which deduplicates over the body's
    // own variables and so does not deduplicate at all.
    const existenceOfBody = projectSolutionExistence(c, mapping.body.input);
    return {
      ...mapping,
      body: AF.createProject(AF.createDistinct(existenceOfBody), existenceOfBody.variables),
    };
  }
  return {
    ...mapping,
    // By construction,
    //  the selected variables of mapping.body.variables coincides with the vars used in the mapping head.
    body: AF.createProject(AF.createDistinct(mapping.body), mapping.body.variables),
  };
}
