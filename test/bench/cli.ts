/**
 * @fileoverview CLI entry point for the cross-engine SPARQL 1.2 benchmark.
 *
 * Usage:
 *   npx tsx test/bench/cli.ts [--pattern reification|singleton] [--limit N]
 *                             [--fuseki URL] [--oxigraph URL] [--json OUT.json]
 *
 * By default it only runs the in-process Comunica engine (which requires no
 * external services). Pass `--fuseki` / `--oxigraph` with the base SPARQL
 * endpoint URL of a server that already has the materialized dataset loaded to
 * benchmark those engines too. See README.md for how to stand those up.
 */
import { writeFileSync } from 'node:fs';
import { buildCases, PATTERNS } from './config.js';
import { ComunicaEngine, SparqlHttpEngine } from './engines.js';
import type { BenchEngine } from './engines.js';
import { formatRecords, runBenchmark } from './runner.js';

interface CliOptions {
  pattern: keyof typeof PATTERNS;
  limit: number;
  fuseki?: string;
  oxigraph?: string;
  json?: string;
}

function parseArgs(argv: string[]): CliOptions {
  const opts: CliOptions = { pattern: 'reification', limit: Number.POSITIVE_INFINITY };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = (): string => {
      const value = argv[++i];
      if (value === undefined) {
        throw new Error(`Missing value for ${arg}`);
      }
      return value;
    };
    switch (arg) {
      case '--pattern':
        opts.pattern = next();
        break;
      case '--limit':
        opts.limit = Number.parseInt(next(), 10);
        break;
      case '--fuseki':
        opts.fuseki = next();
        break;
      case '--oxigraph':
        opts.oxigraph = next();
        break;
      case '--json':
        opts.json = next();
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (!(opts.pattern in PATTERNS)) {
    throw new Error(`Unknown pattern '${opts.pattern}'. Known: ${Object.keys(PATTERNS).join(', ')}`);
  }
  return opts;
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  const pattern = PATTERNS[opts.pattern];

  let cases = buildCases(opts.pattern);
  if (Number.isFinite(opts.limit)) {
    cases = cases.slice(0, opts.limit);
  }

  const comunica = new ComunicaEngine('comunica');
  const engines: BenchEngine[] = [ comunica ];
  if (opts.fuseki) {
    engines.push(new SparqlHttpEngine('fuseki', { [pattern.dataFile]: opts.fuseki }));
  }
  if (opts.oxigraph) {
    engines.push(new SparqlHttpEngine('oxigraph', { [pattern.dataFile]: opts.oxigraph }));
  }

  process.stderr.write(
    `Running ${cases.length} case(s) for pattern '${pattern.name}' on engines: ` +
    `${engines.map(e => e.name).join(', ')}\n`,
  );

  // Comunica (SPARQL 1.2 capable) is the reference for correctness checking.
  const records = await runBenchmark(cases, engines, comunica);

  process.stdout.write(`${formatRecords(records)}\n`);
  if (opts.json) {
    writeFileSync(opts.json, JSON.stringify(records, null, 2));
    process.stderr.write(`Wrote ${records.length} records to ${opts.json}\n`);
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
