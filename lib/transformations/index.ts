/**
 * @fileoverview The steps a rewriting pipeline is built out of, one factory each.
 *
 * Every step is a `<descriptiveStem>Transformation()` returning a
 * {@link types!QueryTransformation}, so that a pipeline reads as a uniform list; only the unfolding has
 * anything to configure, and it is the only one taking arguments.
 *
 * - **unfoldingTransformation**: the rewriting proper - every triple pattern replaced by the mapping body
 *   producing the triples it could match. Takes the mapping it unfolds, and whether to preserve
 *   cardinality.
 * - **rewriteNonRecursivePathsTransformation**: expands non-recursive property paths into equivalent BGPs
 *   and UNIONs, so the unfolding sees individual triple patterns. Belongs *before* the unfolding.
 * - **filterFalseTransformation**: removes FILTER(FALSE) patterns, what they stand over, and the structures
 *   containing them (UNION identity, JOIN absorbing element), sub-SELECTs included; a GROUP and the query's
 *   own solution modifiers are left in place.
 * - **pushDownAssertionsTransformation**: pushes assertion filters (`FILTER(sameTerm(?x, c))`) as deep into
 *   the plan as possible, substituting into BGPs, pruning VALUES rows and UNION branches, and turning an
 *   OPTIONAL over an asserted variable into a plain join.
 * - **pullUpExtendsTransformation**: the mirror of the pushdown, floating the `BIND`s it left behind at the
 *   leaves back up the plan and deleting the ones nothing above reads - a UNION every branch of which
 *   carries the same bind included.
 * - **nullifyJoinOverIncompatibleBoundsTransformation**: detects joins whose branches bind a variable to
 *   incompatible terms and replaces them with FILTER(FALSE).
 * - **nullifyUnbindableVarsTransformation**: the same one level up, for incompatible term *types* rather
 *   than terms.
 * - **removeProjectionsTransformation**: removes all inner PROJECT operations, anonymizing every
 *   non-projected variable to a fresh one to preserve scoping.
 * - **joinValuesToFilterTransformation**: rewrites a JOIN with a VALUES clause into an equality FILTER over
 *   the remaining operands, enabling further push-down.
 * - **extendsToValuesTransformation**: rewrites a BIND of a ground term over the empty BGP or over a VALUES
 *   into a VALUES itself.
 * - **serviceCallPushUpTransformation**: merges and hoists SERVICE calls so as much of the plan as possible
 *   is evaluated by the endpoint.
 * - **internalBnodeAsSpecialLiteralTransformation** / **internalBnodeAsSpecialIriTransformation**:
 *   materialise internal blank nodes as typed literals or as prefixed IRIs, since RDF 1.1 sources cannot
 *   reference blank nodes consistently.
 *
 * One step is deliberately **not** re-exported here:
 * {@link comunica!simplifyStaticExpressionsTransformation}, which folds static expressions through
 * Comunica's expression evaluator. It bootstraps Components.js from Node's module resolution, so importing
 * it reaches `node:module` and `node:path`; a bundler resolves every import in a module graph before it
 * tree-shakes, so re-exporting it here would make this barrel - and with it the package entry point -
 * unresolvable for the browser even in a build that never calls the step. It lives behind the
 * `sparql-view-unfold/comunica` subpath instead, which only a Node consumer needs to reach for.
 * @module transformations
 */
export {
  internalBnodeAsSpecialIriTransformation,
  internalBnodeAsSpecialLiteralTransformation,
} from './bnodeMapAsLiteral.js';
export { extendsToValuesTransformation } from './extendsToValues.js';
export { filterFalseTransformation } from './filterFalse.js';
export { joinValuesToFilterTransformation } from './joinValuesToFilter.js';
export { nullifyJoinOverIncompatibleBoundsTransformation } from './nullifyJoinOverIncompatibleBounds.js';
export { nullifyUnbindableVarsTransformation } from './nullifyUnbindableVars.js';
export { rewriteNonRecursivePathsTransformation } from './pathTransformation.js';
export { pullUpExtendsTransformation } from './pullUpExtends.js';
export { pushDownAssertionsTransformation } from './pushDownAssertions.js';
export { removeProjectionsTransformation } from './removeProjections.js';
export { serviceCallPushUpTransformation } from './serviceCallMerge.js';
export type { UnfoldingOptions } from './unfolding.js';
export { unfoldingTransformation } from './unfolding.js';
