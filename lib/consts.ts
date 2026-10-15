/**
 * Datatype IRI used for representing skolemized blank nodes as typed literals.
 * When blank nodes are represented as literals, they use this datatype to be identifiable.
 */
export const DT_INTERNAL_BNODE = 'https://sparql-extension.knows.idlab.ugent.be/bnode';

/**
 * Extension function IRI representing blank node construction, the one a mapping body is written against.
 * This function takes variable arguments and produces a consistent blank node identity.
 */
export const EXTENSION_FUNCTION_BNODE = 'internal://blank';

/**
 * IRI prefix used when skolemizing blank nodes as named nodes (IRIs).
 * Combined with a hash of the blank node's identifying values to create unique IRIs.
 */
export const IRI_PREFIX_BNODE = 'https://myInternalBnode.example.org/';

/** Prefix of a mapping variable renamed because its name is already in use in the rewrite. */
export const VAR_PREFIX_MAPPING = 'mi_';

/** Prefix of the variables `?m_s ?m_p ?m_o` of the generic head several mappings are merged into. */
export const VAR_PREFIX_MERGED_HEAD = 'm_';

/** Namespace of the predicates of the provenance view. */
export const PROVENANCE_NAMESPACE = 'https://sparql-extension.knows.idlab.ugent.be/provenance#';

/**
 * Predicate of the provenance view linking a derivation, one solution of a mapping body, to the view triple
 * it produces.
 */
export const PREDICATE_DERIVATION_OF = `${PROVENANCE_NAMESPACE}derivationOf`;

/** Predicate of the provenance view linking a derivation to a source triple it matched. */
export const PREDICATE_DERIVED_FROM = `${PROVENANCE_NAMESPACE}derivedFrom`;
