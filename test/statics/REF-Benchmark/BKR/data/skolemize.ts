/**
 * Post-processing Skolemization script.
 *
 * Reads an RDF file, replaces every blank node (in subjects, predicates, objects,
 * and quoted-triple components) with a Skolem IRI of the form
 *   <{prefix}{blankNodeId}>
 * and writes the result to a new file (atomically via a temp file + rename).
 *
 * This is also the one place every quad in the source dump streams through exactly
 * once on its way into the RDF 1.2 representation the rest of the pipeline builds
 * on (`mapBkrStar.ts`, then `test/bench/makeSubset.mjs`), so it doubles as a data
 * cleanup pass: any quad with a syntactically invalid IRI (found in practice: literal
 * `%%-` — a `%` not followed by two hex digits, which is not valid RFC 3986/3987
 * percent-encoding) is dropped rather than written out, and logged to
 * `<output>.dropped.ttl` for auditing. Engines disagree on how to handle such IRIs —
 * some (N3, ARQ) parse them leniently, others (Oxigraph) reject the whole file — so
 * dropping them here is what makes every downstream file valid Turtle everywhere.
 *
 * Usage:
 *   npx tsx skolemize.ts <input.ttl> [<output.ttl>] [--format text/n3] [--prefix urn:bkr:blank:]
 *
 * If <output.ttl> is omitted, the input file is overwritten.
 * Use --format text/n3 for files that contain blank-node predicates (e.g. BKR-Singleton.ttl).
 *
 * Example:
 *   npx tsx skolemize.ts BKR-Singleton.ttl --format text/n3
 *   npx tsx skolemize.ts BKR-Reification.ttl
 *   npx tsx skolemize.ts BKR-WikiData.ttl
 */

import { createReadStream, createWriteStream, renameSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type * as RDF from '@rdfjs/types';
import { StreamParser, Writer } from 'n3';
import { DataFactory } from 'rdf-data-factory';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Parse CLI arguments
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const positionals: string[] = [];
let format = 'text/turtle';
let prefix = 'urn:bkr:blank:';

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--format') {
    format = args[++i];
  } else if (args[i] === '--prefix') {
    prefix = args[++i];
  } else {
    positionals.push(args[i]);
  }
}

if (positionals.length === 0) {
  // eslint-disable-next-line no-console
  console.error(
    'Usage: npx tsx skolemize.ts <input.ttl> [<output.ttl>] [--format text/n3] [--prefix urn:bkr:blank:]',
  );

  process.exit(1);
}

const inputPath = resolve(__dirname, positionals[0]);
const outputPath = positionals[1] ? resolve(__dirname, positionals[1]) : inputPath;
const tempPath = `${outputPath}.tmp_skolem`;

// ---------------------------------------------------------------------------

const df = new DataFactory({ blankNodePrefix: '' });

function skolemizeTerm(term: RDF.Term): RDF.Term {
  if (term.termType === 'BlankNode') {
    return df.namedNode(`${prefix}${term.value}`);
  }
  if (term.termType === 'Quad') {
    const q = <RDF.Quad><unknown>term;
    return df.quad(
      <RDF.Quad_Subject>skolemizeTerm(q.subject),
      <RDF.Quad_Predicate>skolemizeTerm(q.predicate),
      <RDF.Quad_Object>skolemizeTerm(q.object),
      <RDF.Quad_Graph>skolemizeTerm(q.graph),
    );
  }
  return term;
}

// ---------------------------------------------------------------------------
// Data cleanup: drop quads carrying a syntactically invalid IRI.
// ---------------------------------------------------------------------------

/** True iff every `%` in an IRI is followed by exactly two hex digits (RFC 3986/3987 pct-encoding). */
function isValidIri(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    if (value[i] === '%' && !/^[\da-fA-F]{2}/u.test(value.slice(i + 1, i + 3))) {
      return false;
    }
  }
  return true;
}

/** Recurses into quoted-triple (RDF 1.2 triple term) and literal-datatype components. */
function hasInvalidIri(term: RDF.Term): boolean {
  switch (term.termType) {
    case 'NamedNode':
      return !isValidIri(term.value);
    case 'Literal':
      return term.datatype !== undefined && hasInvalidIri(term.datatype);
    case 'Quad': {
      const q = <RDF.Quad><unknown>term;
      return hasInvalidIri(q.subject) || hasInvalidIri(q.predicate) ||
        hasInvalidIri(q.object) || hasInvalidIri(q.graph);
    }
    default:
      return false;
  }
}

// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  process.stdout.write(`Skolemizing ${inputPath} → ${outputPath}\n`);
  process.stdout.write(`  format: ${format}  prefix: ${prefix}\n`);

  const outStream = createWriteStream(tempPath);
  // Use text/n3 as output format when input is N3 (preserves blank-node-predicate files
  // correctly even before Skolemization converts them to named-node predicates).
  const writerFormat = format.includes('n3') ? 'text/n3' : 'text/turtle';
  const writer = new Writer(outStream, { format: writerFormat });

  // Same format as the main writer: it's already proven to round-trip this file's
  // RDF 1.2 triple-term syntax; a plain N-Quads writer isn't guaranteed to.
  const droppedPath = `${outputPath}.dropped.ttl`;
  const droppedStream = createWriteStream(droppedPath);
  const droppedWriter = new Writer(droppedStream, { format: writerFormat });

  const parser = new StreamParser({ factory: df, blankNodePrefix: '', format });
  createReadStream(inputPath)
    .on('error', err => parser.emit('error', err))
    .pipe(parser);

  let count = 0;
  let dropped = 0;
  await new Promise<void>((resolve2, reject) => {
    parser.on('error', reject);
    parser.on('data', (quad: RDF.Quad) => {
      if (hasInvalidIri(quad.subject) || hasInvalidIri(quad.predicate) ||
        hasInvalidIri(quad.object) || hasInvalidIri(quad.graph)) {
        droppedWriter.addQuad(quad);
        dropped++;
        return;
      }
      const s = skolemizeTerm(quad.subject);
      const p = skolemizeTerm(quad.predicate);
      const o = skolemizeTerm(quad.object);
      const g = skolemizeTerm(quad.graph);
      writer.addQuad(df.quad(
        <RDF.Quad_Subject>s,
        <RDF.Quad_Predicate>p,
        <RDF.Quad_Object>o,
        <RDF.Quad_Graph>g,
      ));
      if (++count % 1_000_000 === 0) {
        process.stdout.write(`\r  ${count.toLocaleString()} quads processed (${dropped} dropped)...`);
      }
    });
    parser.on('end', () => {
      if (count >= 1_000_000) {
        process.stdout.write('\r');
      }
      writer.end((err?: Error | null) => {
        if (err) {
          reject(err);
          return;
        }
        droppedWriter.end((dropErr?: Error | null) => {
          if (dropErr) {
            reject(dropErr);
            return;
          }
          // Atomically replace the output file.
          renameSync(tempPath, outputPath);
          process.stdout.write(
              `Done: ${count.toLocaleString()} quads → ${outputPath} ` +
              `(${dropped.toLocaleString()} dropped for an invalid IRI → ${droppedPath})\n`,
          );
          resolve2();
        });
      });
    });
  });
}

main().catch((err: unknown) => {
  process.stderr.write(`Error: ${(<Error>err).message}\n`);

  process.exit(1);
});
