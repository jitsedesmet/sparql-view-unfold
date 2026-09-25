/**
 * @fileoverview Merges RDF files into one skolemised N-Triples file, the form every workload's source
 * data is benchmarked in.
 *
 * **Skolemised**, because the rewriter does not allow blank nodes in the RDF 1.1 source (see the
 * "Restrictions" table of the root README): a blank node cannot be referenced across the sub-queries the
 * unfolding produces, so triples reached through one would be lost. Every blank node becomes
 * `<urn:skolem:<input file name>:<n>>`, numbered in order of first appearance. The file name keeps two
 * inputs' labels apart, and the numbering makes the output deterministic even where the parser coins
 * random labels (Oxigraph does for RDF/XML).
 *
 * The `owl:Ontology` header an RDF file may open with (`<> a owl:Ontology ; owl:imports ...`) is dropped:
 * it describes the file, not the data, and its subject is the file's own IRI.
 *
 * Usage: node test/bench/workloads/toNTriples.mjs <out.nt> <input.(owl|rdf|ttl|nt)>...
 */
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, extname } from 'node:path';
import { pathToFileURL } from 'node:url';
import oxigraph from 'oxigraph';

const OWL = 'http://www.w3.org/2002/07/owl#';
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';

const FORMATS = {
  '.owl': 'application/rdf+xml',
  '.rdf': 'application/rdf+xml',
  '.ttl': 'text/turtle',
  '.nt': 'application/n-triples',
};

const [ out, ...inputs ] = process.argv.slice(2);
if (!out || inputs.length === 0) {
  process.stderr.write('usage: node toNTriples.mjs <out.nt> <input>...\n');
  process.exit(2);
}

/** Subjects declared `owl:Ontology` in the current file: their triples are the header. */
function ontologyHeaderSubjects(quads) {
  return new Set(quads
    .filter(q => q.predicate.value === RDF_TYPE && q.object.value === `${OWL}Ontology`)
    .map(q => q.subject.value));
}

writeFileSync(out, '');
let written = 0;
let skolemised = 0;
for (const input of inputs) {
  const format = FORMATS[extname(input)];
  if (!format) {
    throw new Error(`Unknown RDF format for ${input}`);
  }
  const quads = oxigraph.parse(readFileSync(input, 'utf8'), {
    format,
    base_iri: pathToFileURL(input).href,
  });
  const header = ontologyHeaderSubjects(quads);
  const labels = new Map();
  const file = basename(input);
  const skolem = (term) => {
    if (term.termType !== 'BlankNode') {
      return term;
    }
    if (!labels.has(term.value)) {
      labels.set(term.value, oxigraph.namedNode(`urn:skolem:${encodeURIComponent(file)}:${labels.size}`));
    }
    return labels.get(term.value);
  };
  // Oxigraph prints a term in its N-Triples form, escaping included.
  const lines = [];
  for (const quad of quads) {
    if (header.has(quad.subject.value)) {
      continue;
    }
    lines.push(`${skolem(quad.subject)} ${quad.predicate} ${skolem(quad.object)} .\n`);
  }
  appendFileSync(out, lines.join(''));
  written += lines.length;
  skolemised += labels.size;
}
process.stderr.write(`${out}: ${written} triples from ${inputs.length} files, ${skolemised} blank nodes skolemised\n`);
