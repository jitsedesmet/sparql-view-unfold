import type * as RDF from '@rdfjs/types';
import { Algebra, algebraUtils } from '@traqula/algebra-transformations-1-2';
import { termToString } from 'rdf-string';
import { DT_INTERNAL_BNODE, PREDICATE_DERIVATION_OF, PREDICATE_DERIVED_FROM } from './consts.js';
import type { TriplePosition } from './datastructures/TermClusterSet.js';
import { triplePositions } from './datastructures/TermClusterSet.js';
import type { MappingConstructionTools, MappingOptions } from './mapping.js';
import { mappingFromConstructs, parseConstructQuery } from './mapping.js';
import { rangeOfPosition } from './RangeSet.js';
import { decodeDerivationIri, derivationExpression } from './transformations/internalBnodeMaterialisation.js';
import type { TransformationContext } from './transformContext.js';
import { createTransformationContext } from './transformContext.js';
import type { Mapping } from './types.js';
import { DF, tripleTerm } from './utils/rdfDatatypes.js';
import { claimVariableName, collectVariableNames } from './utils.js';

/**
 * @fileoverview The provenance view of a set of CONSTRUCT queries: their derivations, each linked to the view triples
 * it produces and the source triples it matched, and the decoding of a derivation back into those triples.
 * See ARCHITECTURE.md.
 */

/** Links a derivation to a view triple it produces. */
export const derivationOfPredicate = DF.namedNode(PREDICATE_DERIVATION_OF);

/** Links a derivation to a source triple it matched. */
const derivedFromPredicate = DF.namedNode(PREDICATE_DERIVED_FROM);

/**
 * Creates the pattern linking a derivation to the triple term a triple (pattern) writes.
 * @param AF - The algebra factory to create it with
 * @param derivation - The variable the derivation is bound to
 * @param predicate - `derivationOf` or `derivedFrom`
 * @param triple - The triple (pattern)
 * @returns the pattern
 */
export function derivationLink(
  AF: TransformationContext['AF'],
  derivation: RDF.Variable,
  predicate: RDF.NamedNode,
  triple: RDF.BaseQuad,
): Algebra.Pattern {
  return AF.createPattern(derivation, predicate, tripleTerm(triple.subject, triple.predicate, triple.object));
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
 * The variables a derivation of a CONSTRUCT body is identified by, in the order its identity holds their values.
 * @param body - The WHERE clause of the CONSTRUCT
 * @returns the variables
 */
function derivationVariablesOf(body: Algebra.Operation): RDF.Variable[] {
  return algebraUtils.inScopeVariables(body);
}

/**
 * Rewrites a CONSTRUCT into the one building its provenance view. Each body solution becomes a derivation,
 * identified by the CONSTRUCT and the values of the body's variables.
 * @param tools - The factories to build with
 * @param construct - The CONSTRUCT a mapping is defined by
 * @param constructIndex - The index of the CONSTRUCT among the view's, which tells its derivations apart
 * @returns the CONSTRUCT linking each derivation to the triples it produces and matched
 */
export function provenanceConstructOf(
  tools: MappingConstructionTools,
  construct: Algebra.Construct,
  constructIndex: number,
): Algebra.Construct {
  const { AF } = tools;
  const body = construct.input;
  const usedNames = collectVariableNames(tools.astTransformer, construct);
  const derivation = DF.variable(claimVariableName('derivation', usedNames));
  // A variable the body leaves unbound is an argument of its own, so it still tells the derivations apart.
  const derivationIdentity = derivationExpression(
    AF,
    constructIndex,
    derivationVariablesOf(body).map(variable => AF.createTermExpression(variable)),
  );
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
 * @returns the mapping to unfold a {@link provenance!provenanceCapturingQuery} against
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
      provenanceConstructOf(tools, parseConstructQuery(tools, constructQuery), index)),
    options,
  );
}

/** A derivation decoded: one solution of a view CONSTRUCT's WHERE clause, and the triples it matched and produces. */
export interface DecodedDerivation {
  /** The index of the CONSTRUCT, among the view's, whose WHERE clause the derivation is a solution of. */
  constructIndex: number;
  /** The solution, by the names of its bound variables. */
  bindings: ReadonlyMap<string, RDF.Term>;
  /** The source triples it matched, which the provenance view links it to by `derivedFrom`. */
  sourceTriples: RDF.Quad[];
  /** The view triples it produces, which the provenance view links it to by `derivationOf`. */
  viewTriples: RDF.Quad[];
}

/**
 * Fills the bindings of a solution into a term.
 * @param term - The term, a variable or a triple term holding some
 * @param bindings - The solution
 * @returns the term, or `undefined` if it reads an unbound variable
 */
function filledIn(term: RDF.Term, bindings: ReadonlyMap<string, RDF.Term>): RDF.Term | undefined {
  if (term.termType === 'Variable') {
    return bindings.get(term.value);
  }
  if (term.termType === 'Quad') {
    const [ subject, predicate, object ] = triplePositions.map(position => filledIn(term[position], bindings));
    return subject && predicate && object ? tripleTerm(subject, predicate, object) : undefined;
  }
  return term;
}

/**
 * Whether a CONSTRUCT can write a term in a position, an internal blank node materialised as a literal counting as
 * the blank node it stands for.
 * @param term - The term
 * @param position - The position of a triple it is written in
 * @param generalizedRdfView - Whether the view is a generalized RDF view
 * @returns whether the position admits it
 */
function isAdmissible(term: RDF.Term, position: TriplePosition, generalizedRdfView: boolean): boolean {
  const isMaterialisedBnode = term.termType === 'Literal' && term.datatype.value === DT_INTERNAL_BNODE;
  return rangeOfPosition(position, generalizedRdfView).has(isMaterialisedBnode ? 'BlankNode' : term.termType) &&
    (term.termType !== 'Quad' || triplePositions.every(inner => isAdmissible(term[inner], inner, generalizedRdfView)));
}

/**
 * Fills a solution into triple patterns, keeping the triples a CONSTRUCT would write, each once.
 * @param patterns - The triple patterns
 * @param bindings - The solution
 * @param generalizedRdfView - Whether the view is a generalized RDF view
 * @returns the triples
 */
function triplesOf(
  patterns: readonly Algebra.Pattern[],
  bindings: ReadonlyMap<string, RDF.Term>,
  generalizedRdfView: boolean,
): RDF.Quad[] {
  const triples = new Map<string, RDF.Quad>();
  for (const pattern of patterns) {
    const triple = <RDF.Quad | undefined>
      filledIn(tripleTerm(pattern.subject, pattern.predicate, pattern.object), bindings);
    if (triple && triplePositions.every(position => isAdmissible(triple[position], position, generalizedRdfView))) {
      triples.set(termToString(triple), triple);
    }
  }
  return [ ...triples.values() ];
}

/**
 * Creates a decoder of the derivations of a view, as its provenance view identifies them, back into the solution of
 * the WHERE clause each derivation is, and the triples it matched and produces.
 * @param constructQueries - The SPARQL CONSTRUCT query strings defining the view, as the provenance view was built from
 * @param options - What the provenance view was built with
 * @returns the decoder, which throws for a term that is no derivation of this view
 * @throws Error if a CONSTRUCT query does not parse
 */
export function createDerivationDecoder(
  constructQueries: readonly string[],
  options: MappingOptions = {},
): (derivation: RDF.Term) => DecodedDerivation {
  const tools = createTransformationContext({ expressionRange: options.expressionRange });
  const constructs = constructQueries.map(constructQuery => parseConstructQuery(tools, constructQuery));
  const generalizedRdfView = options.generalizedRdfView === true;
  return (derivation) => {
    const parts = derivation.termType === 'NamedNode' ? decodeDerivationIri(derivation.value) : undefined;
    const construct = parts === undefined ? undefined : constructs.at(parts.constructIndex);
    const variables = construct === undefined ? [] : derivationVariablesOf(construct.input);
    if (parts === undefined || construct === undefined || variables.length !== parts.values.length) {
      throw new Error(`${termToString(derivation)} is no derivation of this view.`);
    }
    const bindings = new Map<string, RDF.Term>();
    for (const [ index, variable ] of variables.entries()) {
      const value = parts.values[index];
      if (value !== undefined) {
        bindings.set(variable.value, value);
      }
    }
    return {
      constructIndex: parts.constructIndex,
      bindings,
      // The data holds these triples, so no term of theirs is out of place.
      sourceTriples: triplesOf(triplePatternsEverySolutionMatches(construct.input), bindings, true),
      viewTriples: triplesOf(construct.template, bindings, generalizedRdfView),
    };
  };
}
