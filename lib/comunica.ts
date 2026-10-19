/**
 * @fileoverview The Node-only entry point: the pipeline steps that need a Comunica runtime.
 *
 * Everything here reaches {@link https://github.com/LinkedSoftwareDependencies/Components.js Components.js},
 * which bootstraps Comunica's actors from Node's own module resolution and so imports `node:module` and
 * `node:path`. A bundler resolves every import in a module graph before it tree-shakes anything, so a single
 * re-export of this module from the package barrel makes the whole package unresolvable for the browser -
 * even for a build that never calls the step, and even with `sideEffects: false` set. Keeping it behind its
 * own subpath is what lets {@link sparql-view-unfold | the main entry point} stay platform-neutral.
 *
 * None of the steps here are in {@link queryRewriter!createDefaultTransformationPipeline}, so a consumer
 * reaches for this subpath only on purpose.
 * @module comunica
 * @example
 * import { createQueryRewriter } from 'sparql-view-unfold';
 * import { simplifyStaticExpressionsTransformation } from 'sparql-view-unfold/comunica';
 *
 * const rewriter = createQueryRewriter([
 *   unfoldingTransformation(mapping),
 *   simplifyStaticExpressionsTransformation(),
 * ]);
 */
export {
  simplifyStaticExpressions,
  simplifyStaticExpressionsTransformation,
} from './transformations/staticExpressionEvaluation.js';
