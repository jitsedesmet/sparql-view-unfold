/**
 * @fileoverview Converts BKR-star benchmark queries (which use the *old* RDF-star
 * quoted-triple syntax `<< s p o >>` in the subject position) into RDF 1.2 form
 * using `rdf:reifies` and triple terms `<<( s p o )>>`.
 *
 * The BKR-star benchmark queries look like:
 * ```sparql
 * SELECT ?s ?p ?o WHERE {
 *   << ?s ?p ?o >> provenir:derives_from bkr:PUBMED_99992-INST .
 * }
 * ```
 * which the current SPARQL 1.2 draft and this library express as:
 * ```sparql
 * SELECT ?s ?p ?o WHERE {
 *   _:bkr0 rdf:reifies <<( ?s ?p ?o )>> .
 *   _:bkr0 provenir:derives_from bkr:PUBMED_99992-INST .
 * }
 * ```
 *
 * BKR-star only ever embeds triples one level deep and always in the subject
 * position (see `data/mapToReification-Q1.rq`), so a lexical rewrite is safe here.
 */

const RDF_NS = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';

/**
 * Rewrites every `<< s p o >>` occurrence (used as a triple subject) into an
 * `rdf:reifies` triple term. A fresh blank node links the reifier to the outer
 * annotation triple.
 *
 * @param query - A BKR-star SPARQL query string using `<< ... >>` syntax.
 * @returns An RDF 1.2 SPARQL query string using `rdf:reifies <<( ... )>>`.
 */
export function bkrStarToRdf12(query: string): string {
  let counter = 0;
  // `[^<>]+?` guarantees we never match a nested `<<`, matching BKR's depth-1 promise.
  const rewritten = query.replaceAll(/<<\s*([^<>]+?)\s*>>/gu, (_match, inner: string) => {
    const reifier = `_:bkr${counter++}`;
    // The `<< >>` sat in subject position, so emit the reifies triple and then
    // continue the original triple with the reifier as its subject.
    // Use a full IRI for rdf:reifies so the result never depends on a prefix decl.
    return `${reifier} <${RDF_NS}reifies> <<( ${inner.trim()} )>> .\n  ${reifier}`;
  });
  return rewritten;
}
