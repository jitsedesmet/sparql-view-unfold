/**
 * @fileoverview Collects the CONSTRUCT views that build the ekaw vocabulary from the four other conference
 * ontologies (cmt, confOf, conference, edas) into one `views.rq`, one view per `# ----`-separated block.
 *
 * The views are the ones the OAEI Populated Conference repository ships in `alignments/construct/`
 * (framagit.org/IRIT_UT2J/conference-dataset-population, LGPL-2.1), generated there from the EDOAL reference
 * alignments. `<source>-ekaw.sparql` builds ekaw triples from `<source>` data; all four put ekaw last in
 * alphabetical order, so no EDOAL conversion is needed here.
 *
 * A view whose template holds a blank node is dropped: a mapping head admits no blank node, and the
 * datasets are skolemised, so there is nothing for one to stand for. Each drop is printed and recorded in
 * the file header.
 *
 * Usage: node test/bench/workloads/oaei/collectViews.mjs <out/views.rq> <source-ekaw.sparql>...
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';

const VIEW_SEPARATOR = '# ----';
const [ outFile, ...inputs ] = process.argv.slice(2);
if (!outFile || inputs.length === 0) {
  process.stderr.write('usage: node collectViews.mjs <views.rq> <source-ekaw.sparql>...\n');
  process.exit(2);
}

const views = [];
const dropped = [];
for (const input of inputs) {
  // Each file concatenates complete queries, each opening with its own PREFIX block.
  const queries = readFileSync(input, 'utf8').split(/\n\s*\n(?=PREFIX)/u).map(q => q.trim()).filter(Boolean);
  for (const [ index, query ] of queries.entries()) {
    const template = /CONSTRUCT\s*\{([^}]*)\}/u.exec(query)?.[1] ?? '';
    const id = `${basename(input, '.sparql')}#${index}`;
    if (template.includes('_:')) {
      dropped.push(`${id}: ${template.trim().replaceAll(/\s+/gu, ' ')}`);
      continue;
    }
    views.push(`# ${id}\n${query}`);
  }
}

const header = [
  '# Collected by collectViews.mjs from alignments/construct/*-ekaw.sparql of the OAEI Populated Conference',
  '# dataset (framagit.org/IRIT_UT2J/conference-dataset-population, LGPL-2.1). Do not edit by hand.',
  `# ${views.length} views. Dropped for a blank node in the template: ${dropped.length}.`,
  ...dropped.map(d => `#   - ${d}`),
];
writeFileSync(outFile, `${header.join('\n')}\n\n${views.join(`\n${VIEW_SEPARATOR}\n`)}\n`);
process.stderr.write(`${views.length} views written to ${outFile}; dropped ${dropped.length}:\n  ${dropped.join('\n  ')}\n`);
