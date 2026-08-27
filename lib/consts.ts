/**
 * Datatype IRI used for representing skolemized blank nodes as typed literals.
 * When blank nodes are represented as literals, they use this datatype to be identifiable.
 */
export const DT_INTERNAL_BNODE = 'https://sparql-extension.knows.idlab.ugent.be/bnode';

/**
 * Extension function IRI used internally to represent blank node construction.
 * This function takes variable arguments and produces a consistent blank node identity.
 */
export const EXTENSION_FUNCTION_BNODE = 'internal://blank';

/**
 * IRI prefix used when skolemizing blank nodes as named nodes (IRIs).
 * Combined with a hash of the blank node's identifying values to create unique IRIs.
 */
export const IRI_PREFIX_BNODE = 'https://myInternalBnode.example.org/';

/**
 * Prefix every variable of the user query is renamed with before rewriting, by `queryTransform`.
 *
 * This is the *only* prefix the rewriting classifies on: a variable in a cluster carries it exactly when it
 * came from the user query, and every other variable in that cluster belongs to the mapping. Both
 * `ClusterSolver.mappingVarsOf` and `ClusterSolver.sortClusters` are defined by it, so it has to stay
 * disjoint from {@link VAR_PREFIX_MAPPING} and {@link VAR_PREFIX_MERGED_HEAD} - and the underscore is part
 * of it, a test against a bare `uq` also matching a user variable named `?uqx`.
 */
export const VAR_PREFIX_USER_QUERY = 'uq_';

/**
 * Prefix every variable of a mapping (its head and its body alike) is renamed with, so that a mapping
 * cannot collide with the user query it is unfolded into.
 *
 * Not load-bearing for classification - anything without {@link VAR_PREFIX_USER_QUERY} counts as a mapping
 * variable - but it is what keeps that distinction true.
 */
export const VAR_PREFIX_MAPPING = 'mi_';

/**
 * Prefix of the three variables `?m_s ?m_p ?m_o` of the generic head several mappings are merged into.
 * Load-bearing in the same way {@link VAR_PREFIX_MAPPING} is: it must not be a
 * {@link VAR_PREFIX_USER_QUERY}.
 */
export const VAR_PREFIX_MERGED_HEAD = 'm_';
