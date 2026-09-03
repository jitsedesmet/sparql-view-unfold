/**
 * @fileoverview Transformation module exports for SPARQL query rewriting.
 *
 * Optimization and transformation passes applied in sequence after the core BGP rewriting:
 *
 * - **transformFilterFalse**: removes FILTER(FALSE) patterns and the structures containing them (UNION
 *   identity, JOIN absorbing element).
 * - **nullifyJoinOverIncompatibleBounds**: detects joins whose branches bind a variable to incompatible
 *   terms and replaces them with FILTER(FALSE).
 * - **nullifyUnbindableVars**: the same one level up, for incompatible term *types* rather than terms.
 * - **rewriteSinglePattern**: rewrites a single triple pattern against a mapping definition.
 * - **removeProjections**: removes all PROJECT operations, anonymizing every non-projected variable to a
 *   fresh one to preserve scoping.
 * - **pushDownAssertions**: pushes assertion filters (`FILTER(sameTerm(?x, c))`) as deep into the plan as
 *   possible, substituting into BGPs, pruning VALUES rows and UNION branches, and turning an OPTIONAL over
 *   an asserted variable into a plain join.
 * - **pullUpExtends**: the mirror of the pushdown, floating the `BIND`s it left behind at the leaves back up
 *   the plan and deleting the ones nothing above reads - a UNION every branch of which carries the same
 *   bind included.
 * - **transformJoinValuesToFilter**: rewrites a JOIN with a VALUES clause into an equality FILTER over the
 *   remaining operands, enabling further push-down.
 * - **transformExtendsToValues**: rewrites a BIND of a ground term over the empty BGP or over a VALUES into
 *   a VALUES itself.
 * - **rewriteNonRecursivePaths**: expands non-recursive property paths into equivalent BGPs and UNIONs, so
 *   the mapping-based rewriting sees individual triple patterns.
 * - **transformServiceCallPushUp**: merges and hoists SERVICE calls so as much of the plan as possible is
 *   evaluated by the endpoint.
 * - **internalBnodeAsSpecialLiteral** / **internalBnodeAsSpecialIri**: materialise internal blank nodes as
 *   typed literals or as prefixed IRIs, since RDF 1.1 sources cannot reference blank nodes consistently.
 * @module transformations
 */
export { internalBnodeAsSpecialIri, internalBnodeAsSpecialLiteral } from './bnodeMapAsLiteral.js';
export { transformExtendsToValues } from './extendsToValues.js';
export { transformFilterFalse } from './filterFalse.js';
export { nullifyJoinOverIncompatibleBounds } from './nullifyJoinOverIncompatibleBounds.js';
export { nullifyUnbindableVars } from './nullifyUnbindableVars.js';
export { rewriteNonRecursivePaths } from './pathTransformation.js';
export { rewriteSinglePattern } from './rewriteSinglePattern.js';
export { removeProjections } from './removeProjections.js';
export { pushDownAssertions } from './pushDownAssertions.js';
export { pullUpExtends } from './pullUpExtends.js';
export { transformJoinValuesToFilter } from './joinValuesToFilter.js';
export { transformServiceCallPushUp } from './serviceCallMerge.js';
