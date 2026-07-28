/**
 * @fileoverview Transformation module exports for SPARQL query rewriting.
 *
 * This module provides various optimization and transformation passes that can be
 * applied to rewritten SPARQL queries. These transformations are typically applied
 * in sequence after the core BGP rewriting.
 *
 * ## Available Transformations:
 *
 * - **substituteVarsThatArePreBoundToTerms**: Substitutes variables that are known
 *   to be bound to specific terms, eliminating unnecessary bindings.
 *
 * - **transformFilterFalse**: Simplifies algebra by removing FILTER(FALSE) patterns
 *   and their containing structures (UNION identity, JOIN absorbing element).
 *
 * - **nullifyJoinOverIncompatibleBounds**: Detects joins where variable bindings
 *   from one branch are incompatible with another and replaces with FILTER(FALSE).
 *
 * - **pushUpBoundedFromUnion**: Hoists common variable bindings out of UNION branches
 *   to the parent level for optimization.
 *
 * - **rewriteSinglePattern**: Core function that rewrites a single triple pattern
 *   against a mapping definition.
 *
 * - **removeProjections**: Removes all PROJECT operations from an algebra tree,
 *   anonymizing every non-projected variable to a fresh variable to preserve scoping.
 *
 * - **transformJoinValuesToFilter**: Rewrites a JOIN with a VALUES clause into an equality FILTER
 *   over the remaining join operands (extracting any column that is constant across all rows, and
 *   collapsing contradicting VALUES to an empty result), enabling further push-down optimizations.
 *
 * @module transformations
 */
export { substituteVarsThatArePreBoundToTerms } from './boundedVarSubstitution.js';
export { transformFilterFalse } from './filterFalse.js';
export { nullifyJoinOverIncompatibleBounds } from './nullifyJoinOverIncompatibleBounds.js';
export { pushUpBoundedFromUnion } from './pushUpBoundedFromUnion.js';
export { rewriteSinglePattern } from './rewriteSinglePattern.js';
export { removeProjections } from './removeProjections.js';
export {
  pushDownRestrictors,
} from './pushDownRestrictors.js';
export { transformJoinValuesToFilter } from './joinValuesToFilter.js';
