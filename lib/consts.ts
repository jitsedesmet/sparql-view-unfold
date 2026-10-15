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

/**
 * Prefix a mapping variable is renamed with when the user query it is unfolded into already uses its name,
 * by {@link transformations/unfolding!unfoldingTransformation}. A mapping variable whose name is free keeps
 * it.
 *
 * Not load-bearing: nothing classifies a variable on its name. The unfolding tells the two sides apart by
 * which side of the unification a variable was registered on, so all the prefix does is keep the renamed
 * variables readable.
 */
export const VAR_PREFIX_MAPPING = 'mi_';

/**
 * Prefix of the three variables `?m_s ?m_p ?m_o` of the generic head several mappings are merged into,
 * where no variable of the mappings already takes the name.
 */
export const VAR_PREFIX_MERGED_HEAD = 'm_';
