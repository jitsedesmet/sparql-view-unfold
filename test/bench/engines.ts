/**
 * @fileoverview Engine adapters for the cross-engine SPARQL 1.2 benchmark.
 *
 * The benchmark compares two ways of answering a SPARQL 1.2 query:
 *  1. **native**   — run the SPARQL 1.2 query directly on RDF 1.2 data
 *                    (only possible on engines that support SPARQL 1.2).
 *  2. **rewriting** — rewrite the SPARQL 1.2 query (using this library) so its
 *                    triple *patterns* match the materialized RDF 1.1 data instead
 *                    of RDF 1.2 triple terms, then run it on that data. The
 *                    rewritten query can still construct/compare triple-term
 *                    *values* (e.g. via `SUBJECT()`/`PREDICATE()`/`OBJECT()`), so
 *                    it still requires a SPARQL 1.2-capable engine — the gain is
 *                    that the *data* no longer needs native RDF 1.2 support.
 *
 * Every engine is accessed through the small {@link BenchEngine} interface so the
 * runner does not need to know whether it is talking to an in-process library
 * (Comunica) or a remote SPARQL HTTP endpoint (Apache Jena/Fuseki, Oxigraph, ...).
 *
 * See {@link ./README.md} for the survey of which engines support SPARQL 1.2.
 */
import { spawn, spawnSync } from 'node:child_process';
import type { ChildProcessByStdio, ChildProcessWithoutNullStreams } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { Readable } from 'node:stream';
import type { Writable } from 'node:stream';
import type { ReadableStream } from 'node:stream/web';
import { fileURLToPath } from 'node:url';
import { QueryEngine } from '@comunica/query-sparql-file';
import type * as RDF from '@rdfjs/types';
import type { Store } from 'n3';

/**
 * A logical dataset to run a query against. In-process engines use `file`/`store`,
 * while HTTP engines resolve the dataset by `name` to a pre-loaded endpoint.
 */
export interface EngineSource {
  /** Logical dataset name, e.g. `BKR-Reification`. Used by HTTP engines. */
  name: string;
  /** Local Turtle or N-Triples file path (used by in-process engines). */
  file?: string;
  /**
   * An HDT copy of {@link file}, which {@link ComunicaEngine} queries instead when it is set. Only for
   * RDF 1.1 data: HDT cannot hold triple terms.
   */
  hdtFile?: string;
  /** In-memory quad store (used by in-process engines, e.g. for small tests). */
  store?: Store;
}

/** Outcome of running a single SELECT query on a single engine. */
export interface SelectResult {
  /** Canonical, sorted string form of every solution mapping (for comparison). */
  rows: string[];
  /** Number of solution mappings returned. */
  count: number;
  /** Wall-clock execution time in milliseconds. */
  durationMs: number;
}

/** Common interface implemented by every engine the benchmark can drive. */
export interface BenchEngine {
  /** Human-readable engine name, e.g. `comunica` or `oxigraph`. */
  readonly name: string;
  /** Whether the engine can evaluate SPARQL 1.2 (RDF 1.2 triple terms) natively. */
  readonly supportsSparql12: boolean;
  /** Run a SELECT query against the given source and return canonicalized results. */
  runSelect: (query: string, source: EngineSource, timeoutMs?: number) => Promise<SelectResult>;
  /**
   * Releases any resources held across calls (e.g. a child server process). Optional —
   * only engines that own long-lived external state (like {@link JenaEngine}) need it.
   * Callers should invoke this once they are done with the engine, best-effort.
   */
  dispose?: () => Promise<void>;
}

/** Thrown when a query exceeds its allotted time budget. */
export class BenchTimeoutError extends Error {
  public constructor(public readonly timeoutMs: number) {
    super(`Query exceeded timeout of ${timeoutMs}ms`);
    this.name = 'BenchTimeoutError';
  }
}

/**
 * Hard cap on a SPARQL JSON response body, in bytes. A pathological rewrite (or a
 * legitimately huge join at a bigger scale) can make an engine return a response of
 * multiple gigabytes; `Response.json()`/`.text()` decode the whole body as one V8
 * string first, and past roughly 1-2GB that decode hits a native `CHECK failed:
 * i::kMaxInt >= len` and aborts the *Node process* — not a catchable exception, so no
 * amount of try/catch around the call helps. {@link readJsonResponse} turns that crash
 * into an ordinary `error` row for the one case that hit it, instead of losing an
 * entire multi-hour run.
 */
const MAX_RESPONSE_BYTES = 256 * 1024 * 1024;

/**
 * Hard cap on how many solutions an in-process engine may accumulate for one query.
 * The HTTP engines are bounded by {@link MAX_RESPONSE_BYTES}, but {@link ComunicaEngine}
 * runs in *this* process and collects the whole solution stream in memory, so a
 * pathological join has no backstop other than the V8 heap limit — which it reaches as a
 * `FATAL ERROR: Reached heap limit`, killing the run outright rather than raising a
 * catchable error. (`--timeout` does not save it either: the OOM can arrive before the
 * timer fires, and once the heap is exhausted the event loop no longer gets to run it.)
 * The largest legitimate result in this benchmark is ~20k solutions, so this cap sits two
 * orders of magnitude above real data and only ever trips on a runaway query, which then
 * lands as an ordinary `error` row.
 */
const MAX_BINDINGS = 2_000_000;

/**
 * Heap ceiling for a Comunica worker. Deliberately well below the machine's memory: the
 * cap exists so a runaway query *fails fast* rather than thrashing a huge heap for an hour
 * before dying anyway, and nothing this benchmark legitimately computes comes close (the
 * largest real result is ~20k solutions over a 700k-quad subset).
 */
const WORKER_HEAP_MB = 8000;

/** Reads a fetch `Response` as JSON, refusing (with a catchable error) past {@link MAX_RESPONSE_BYTES}. */
async function readJsonResponse(response: Response, engineName: string): Promise<unknown> {
  const tooLarge = (bytes: number): Error => new Error(
    `Engine '${engineName}' response is over the ${MAX_RESPONSE_BYTES}-byte cap ` +
    `(${bytes} bytes) — refusing to decode it, likely a pathologically large join result.`,
  );
  const declared = response.headers.get('content-length');
  if (declared !== null && Number(declared) > MAX_RESPONSE_BYTES) {
    await response.body?.cancel();
    throw tooLarge(Number(declared));
  }
  const reader = response.body?.getReader();
  if (!reader) {
    return response.json();
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    total += value.byteLength;
    if (total > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw tooLarge(total);
    }
    chunks.push(value);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

/**
 * Converts an RDFJS Bindings object to a canonical, deterministic string so that
 * two result sets can be compared regardless of ordering. Variables are sorted
 * alphabetically. (Same canonical form used by the integration tests.)
 */
export function bindingToString(binding: RDF.Bindings): string {
  const entries = [ ...binding ]
    .map(([ variable, term ]) => `${variable.value}=${term.termType}:${term.value}`)
    .sort()
    .join(',');
  return `{${entries}}`;
}

function summarize(rows: string[], durationMs: number): SelectResult {
  return { rows: [ ...rows ].sort(), count: rows.length, durationMs };
}

/** One reply from `comunicaWorker.mjs`; `ok` carries the result, the others explain themselves. */
type WorkerReply =
  | { status: 'ok'; durationMs: number; count: number; rows: string[] }
  | { status: 'timeout' }
  | { status: 'error'; message: string };

/**
 * Grace period on top of a query's budget before the parent gives up on a worker that
 * should have answered by now. The worker enforces the budget itself and replies
 * `timeout`; this only catches one wedged badly enough not to run its own timer.
 */
const WORKER_GRACE_MS = 30_000;

/**
 * A `comunicaWorker.mjs` child process holding one loaded dataset, driven over
 * newline-delimited JSON. Queries are asked one at a time, matching `run.ts`'s sequential
 * loop; the worker answers in the same order.
 */
class ComunicaWorker {
  public alive = true;
  private readonly child: ChildProcessWithoutNullStreams;
  private pending: ((reply: WorkerReply | Error) => void) | undefined;
  /** Kept only to quote back in an error message when the worker dies. */
  private stderr = '';

  public constructor(script: string, private readonly file: string, private readonly engineName: string) {
    this.child = spawn(process.execPath, [ `--max-old-space-size=${WORKER_HEAP_MB}`, script, file ], {
      stdio: [ 'pipe', 'pipe', 'pipe' ],
    });
    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', (chunk: string) => {
      this.stderr = `${this.stderr}${chunk}`.slice(-2000);
    });
    // A result line can be many megabytes; readline reassembles it across chunks.
    createInterface({ input: this.child.stdout }).on('line', (line) => {
      // The HDT library prints its progress to stdout when it first indexes a file; only the worker's
      // own replies are JSON objects.
      if (!line.startsWith('{')) {
        return;
      }
      const reply = <WorkerReply & { status: string }> JSON.parse(line);
      // The worker announces itself once the dataset is loaded; nothing is waiting yet.
      if (reply.status !== 'ready') {
        this.settle(reply);
      }
    });
    this.child.on('exit', (code, signal) => {
      this.alive = false;
      this.settle(new Error(
        `Engine '${this.engineName}' worker exited (code ${code}, signal ${signal}) — ` +
        `most likely its heap was exhausted by this query: ${this.stderr.slice(-500)}`,
      ));
    });
  }

  /** Whether this worker holds `file` and can still answer. */
  public usable(file: string): boolean {
    return this.alive && this.file === file;
  }

  public kill(): void {
    this.alive = false;
    this.child.kill('SIGKILL');
  }

  /** Kills the worker and waits for the OS to reap it, so the caller can move on cleanly. */
  public async stop(): Promise<void> {
    if (this.child.exitCode !== null || this.child.signalCode !== null) {
      return;
    }
    const exited = new Promise<void>((resolve) => {
      this.child.once('exit', () => resolve());
    });
    this.kill();
    await exited;
  }

  /** Answers `query`; with `constructTo`, a CONSTRUCT whose triples the worker appends to that file. */
  public async ask(query: string, timeoutMs: number, constructTo?: string): Promise<SelectResult> {
    if (this.pending) {
      throw new Error(`Engine '${this.engineName}' worker is already answering a query.`);
    }
    if (!this.alive) {
      throw new Error(`Engine '${this.engineName}' worker is not running.`);
    }
    const reply = await new Promise<WorkerReply | Error>((resolve) => {
      this.pending = resolve;
      const backstop = timeoutMs > 0 ?
        setTimeout(() => {
          this.kill();
          this.settle(new BenchTimeoutError(timeoutMs));
        }, timeoutMs + WORKER_GRACE_MS) :
        undefined;
      const done = this.pending;
      this.pending = (settled): void => {
        clearTimeout(backstop);
        done(settled);
      };
      this.child.stdin.write(`${JSON.stringify({ query, timeoutMs, constructTo })}\n`);
    });
    if (reply instanceof Error) {
      throw reply;
    }
    if (reply.status === 'timeout') {
      throw new BenchTimeoutError(timeoutMs);
    }
    if (reply.status === 'error') {
      throw new Error(`Engine '${this.engineName}' worker: ${reply.message}`);
    }
    return { rows: reply.rows, count: reply.count, durationMs: reply.durationMs };
  }

  /** Hands the outcome to whoever is waiting, if anyone still is. */
  private settle(outcome: WorkerReply | Error): void {
    const pending = this.pending;
    this.pending = undefined;
    pending?.(outcome);
  }
}

/**
 * Engine backed by Comunica. Comunica >= 5.0 fully supports SPARQL 1.2 / RDF 1.2 triple
 * terms, so it can act both as a rewriting target (SPARQL 1.1 queries over RDF 1.1 data)
 * and as a native SPARQL 1.2 reference.
 *
 * A {@link EngineSource.file} is queried through a long-lived worker process
 * (`comunicaWorker.mjs`), which loads and indexes the dataset once and then stays warm for
 * every query against it — the same store reuse the in-process engine had, since that is
 * both how Comunica is really used and what keeps the fast baseline rows honest.
 *
 * The worker exists because Comunica buffers its own join state, which no cap on the
 * *output* stream can bound: on this corpus `reification/F-Q3` grows past a 12GB heap and
 * dies as `FATAL ERROR: Reached heap limit` — not a catchable exception, so evaluated
 * inline it takes the whole sweep down with it, as it did twice (once 16.5 hours in).
 * Across a process boundary it costs one `error` row and a fresh worker. Timeouts are
 * handled *inside* the worker by cancelling the stream, so a slow query does not also
 * throw away the loaded store.
 *
 * A `store`-only source (the in-memory datasets in `bench.test.ts`) cannot cross a
 * process boundary and is still evaluated in-process.
 */
export class ComunicaEngine implements BenchEngine {
  public readonly name: string;
  public readonly supportsSparql12 = true;
  private readonly engine = new QueryEngine();
  private readonly workerScript = join(dirname(fileURLToPath(import.meta.url)), 'comunicaWorker.mjs');
  private worker: ComunicaWorker | undefined;

  public constructor(name = 'comunica') {
    this.name = name;
  }

  public async runSelect(query: string, source: EngineSource, timeoutMs?: number): Promise<SelectResult> {
    const file = source.hdtFile ?? source.file;
    if (file) {
      return this.runInWorker(query, file, timeoutMs);
    }
    return this.runInProcess(query, source, timeoutMs);
  }

  /**
   * Runs a CONSTRUCT over `source` and appends the triples it builds to `file` as N-Triples, returning how
   * many it wrote. How Comunica materialises views; no time budget, since that is not a measurement row.
   */
  public async constructToFile(query: string, source: EngineSource, file: string): Promise<number> {
    const data = source.hdtFile ?? source.file;
    if (!data) {
      throw new Error(`ComunicaEngine needs a 'file' for dataset '${source.name}'.`);
    }
    return (await this.runInWorker(query, data, undefined, file)).count;
  }

  /** Shuts the worker down; `run.ts` calls this once an engine's scheme/scale loops finish. */
  public async dispose(): Promise<void> {
    await this.worker?.stop();
    this.worker = undefined;
  }

  /**
   * Runs the query on the worker holding `file`, starting one if there is none or the
   * previous one died (an OOM abort, most often — which is reported as an `error` row by
   * the caller, never as a timeout, since calling a crash "too slow" fabricates a data
   * point). A worker outlives timeouts, so it is normally started once per dataset.
   */
  private async runInWorker(query: string, file: string, timeoutMs?: number, constructTo?: string):
  Promise<SelectResult> {
    if (this.worker && !this.worker.usable(file)) {
      this.worker.kill();
      this.worker = undefined;
    }
    this.worker ??= new ComunicaWorker(this.workerScript, file, this.name);
    try {
      return await this.worker.ask(query, timeoutMs ?? 0, constructTo);
    } catch (error: unknown) {
      // A dead worker cannot answer the next query either; drop it so the next call
      // starts a fresh one against the same dataset.
      if (!this.worker.alive) {
        this.worker = undefined;
      }
      throw error;
    }
  }

  private async runInProcess(query: string, source: EngineSource, timeoutMs?: number): Promise<SelectResult> {
    const sources = ComunicaEngine.resolveSources(source);
    const start = performance.now();
    const bindingsStream = await this.engine.queryBindings(query, { sources });
    const destroy = (): void =>
      (<{ destroy: (error?: Error) => void }><unknown> bindingsStream).destroy();
    let timer: NodeJS.Timeout | undefined;
    try {
      const rows = await new Promise<string[]>((resolve, reject) => {
        if (timeoutMs !== undefined) {
          timer = setTimeout(() => {
            // Cancel the underlying Comunica work so it stops consuming CPU.
            destroy();
            reject(new BenchTimeoutError(timeoutMs));
          }, timeoutMs);
        }
        // Canonicalized as it streams rather than via `arrayifyStream(...).map(...)`: only
        // the strings are retained, instead of the Bindings objects *and* their strings.
        const collected: string[] = [];
        bindingsStream.on('data', (binding: RDF.Bindings) => {
          if (collected.length >= MAX_BINDINGS) {
            destroy();
            reject(new Error(
              `Engine '${this.name}' produced over ${MAX_BINDINGS} solutions — abandoning ` +
              `the query, since collecting them would exhaust the heap and kill the run.`,
            ));
            return;
          }
          collected.push(bindingToString(binding));
        });
        bindingsStream.on('error', reject);
        bindingsStream.on('end', () => resolve(collected));
      });
      const durationMs = performance.now() - start;
      return summarize(rows, durationMs);
    } finally {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
    }
  }

  private static resolveSources(
    source: EngineSource,
  ): NonNullable<Parameters<QueryEngine['queryBindings']>[1]>['sources'] {
    if (source.store) {
      return [ source.store ];
    }
    if (source.file) {
      return [ source.file ];
    }
    throw new Error(
      `ComunicaEngine needs a 'file' or 'store' for dataset '${source.name}'.`,
    );
  }
}

/**
 * Adapter for any engine exposing the standard SPARQL 1.1/1.2 Protocol over HTTP
 * (Apache Jena/Fuseki, Oxigraph, GraphDB, ...). The dataset is expected to be
 * pre-loaded into the endpoint; the {@link EngineSource.name} is mapped to a
 * concrete endpoint URL through `datasetEndpoints`.
 */
export class SparqlHttpEngine implements BenchEngine {
  public constructor(
    public readonly name: string,
    /** Map from logical dataset name to the SPARQL endpoint holding that dataset. */
    private readonly datasetEndpoints: Record<string, string>,
    public readonly supportsSparql12 = true,
  ) {}

  public async runSelect(query: string, source: EngineSource, timeoutMs?: number): Promise<SelectResult> {
    const endpoint = this.datasetEndpoints[source.name];
    if (!endpoint) {
      throw new Error(
        `Engine '${this.name}' has no endpoint configured for dataset '${source.name}'.`,
      );
    }
    const start = performance.now();
    let json: SparqlJsonResults;
    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/sparql-query',
          Accept: 'application/sparql-results+json',
        },
        body: query,
        signal: timeoutMs === undefined ? undefined : AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) {
        throw new Error(`Engine '${this.name}' returned HTTP ${response.status}: ${await response.text()}`);
      }
      // The abort can fire while still streaming the body (query already running server-side,
      // headers sent, but the result set not yet fully written) — not just during connect/fetch()
      // itself — so this call needs to be inside the same try as `fetch`, not after it.
      json = <SparqlJsonResults> await readJsonResponse(response, this.name);
    } catch (error: unknown) {
      if (error instanceof Error && error.name === 'TimeoutError') {
        throw new BenchTimeoutError(timeoutMs ?? 0);
      }
      throw error;
    }
    const durationMs = performance.now() - start;
    return summarize(canonicalizeJsonResults(json), durationMs);
  }
}

/** Turns SPARQL Results JSON into the same canonical form as {@link bindingToString}. */
function canonicalizeJsonResults(json: SparqlJsonResults): string[] {
  return json.results.bindings.map((row) => {
    const entries = Object.entries(row)
      .map(([ variable, value ]) => `${variable}=${canonicalizeJsonTerm(value)}`)
      .sort()
      .join(',');
    return `{${entries}}`;
  });
}

/**
 * Canonicalizes a single SPARQL Results JSON term, including the `"type": "triple"`
 * extension engines use to represent RDF 1.2 triple terms (RDF-star) in results
 * (e.g. Apache Jena/Fuseki) — recursing into `value.subject`/`predicate`/`object`.
 */
function canonicalizeJsonTerm(value: SparqlJsonTerm): string {
  if (value.type === 'triple' && value.value && typeof value.value === 'object') {
    const t = value.value;
    return `Quad:<<${canonicalizeJsonTerm(t.subject)}|${canonicalizeJsonTerm(t.predicate)}|${
      canonicalizeJsonTerm(t.object)}>>`;
  }
  const termType = value.type === 'uri' ? 'NamedNode' : (value.type === 'bnode' ? 'BlankNode' : 'Literal');
  return `${termType}:${<string> value.value}`;
}

interface SparqlJsonTripleValue {
  subject: SparqlJsonTerm;
  predicate: SparqlJsonTerm;
  object: SparqlJsonTerm;
}

interface SparqlJsonTerm {
  type: string;
  value: string | SparqlJsonTripleValue;
}

interface SparqlJsonResults {
  results: { bindings: Record<string, SparqlJsonTerm>[] };
}

/**
 * Where an engine keeps the store it builds from a data file: beside the file, with the file's extension
 * replaced by the kind of store (`lubm-u10.nt` -> `lubm-u10.tdb2`).
 */
export function storeDir(file: string, kind: string): string {
  return `${file.replace(/\.(?:nt|ttl)$/u, '')}.${kind}`;
}

/**
 * Runs a command to completion, throwing with the tail of its output if it fails. For the bulk loaders,
 * whose output is progress chatter nobody reads unless they fail.
 */
export function runTool(command: string, args: string[], cwd?: string): void {
  const result = spawnSync(command, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, cwd });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed (${result.status ?? result.signal}):\n${
      `${result.stdout}${result.stderr}`.slice(-2000)}`);
  }
}

/** Grace a server gets past a query's budget before stopping the query itself; the client gives up first. */
const SERVER_TIMEOUT_GRACE_MS = 2_000;

/** How long a server may take to open its store and answer, which is not charged to any query. */
const STARTUP_TIMEOUT_MS = 600_000;

/**
 * A native SPARQL server the harness runs itself, over an on-disk store bulk-loaded once per data file:
 * the setup the server is built for, rather than an in-memory dataset reloaded per run.
 *
 * The store sits beside the data file ({@link storeDir}) and is built on first use, into a temporary
 * directory renamed into place once complete, so a load that is interrupted is redone rather than
 * reused half-finished. Building it is not timed: the source store is needed by every approach alike, and
 * what it costs to build the materialised views' store is `timeMaterialization.ts`'s business.
 *
 * One server runs at a time, restarted when the store or the time budget changes, and after every query
 * that runs out of its budget: the server may still be working on that query, and Node's `fetch` would reuse
 * the connection the server is tearing down, which on Oxigraph failed the next one or two queries with
 * `fetch failed`. The budget is also given to the server, a little above the client's, as a second guard
 * against a query the client gave up on using the CPU the next one is measured on.
 */
export abstract class ManagedServerEngine implements BenchEngine {
  public abstract readonly supportsSparql12: boolean;
  /** Suffix of this engine's store directory. */
  public abstract readonly storeKind: string;
  protected readonly port: number;

  private child: ChildProcessByStdio<null, Readable, Readable> | undefined;
  /** The store and budget the running server was started with. */
  private current: string | undefined;
  private readonly recentOutput: string[] = [];

  protected constructor(public readonly name: string, port: number) {
    this.port = port;
  }

  /** Bulk-loads `file` into a new store at `dir`. */
  public abstract loadStore(file: string, dir: string): void;

  /**
   * The command line serving the store at `dir`, stopping a query after `timeoutMs` if given, and taking
   * SPARQL updates if `writable`.
   */
  protected abstract serverCommand(dir: string, timeoutMs: number | undefined, writable: boolean): string[];

  /** The endpoint queries are posted to. */
  protected abstract get queryUrl(): string;

  /** The endpoint updates are posted to. */
  protected abstract get updateUrl(): string;

  /** Headers an update needs besides its content type (QLever: an access token). */
  protected updateHeaders(): Record<string, string> {
    return {};
  }

  protected get baseUrl(): string {
    return `http://localhost:${this.port}`;
  }

  /** Extra URL parameters for a query run under a budget. */
  protected queryParameters(_timeoutMs: number | undefined): string {
    return '';
  }

  /** Runs, untimed, before every measured query. */
  protected async beforeQuery(): Promise<void> {
    // Nothing by default.
  }

  /** The store for `file`, built now if there is none yet. */
  public storeFor(file: string): string {
    const dir = storeDir(file, this.storeKind);
    if (!existsSync(dir)) {
      const building = `${dir}.building`;
      rmSync(building, { recursive: true, force: true });
      process.stderr.write(`  ${this.name}: loading ${file} into ${dir}\n`);
      this.loadStore(file, building);
      renameSync(building, dir);
    }
    return dir;
  }

  public async runSelect(query: string, source: EngineSource, timeoutMs?: number): Promise<SelectResult> {
    await this.serve(source, timeoutMs);
    return this.select(query, timeoutMs);
  }

  /** Runs a SELECT on the store at `dir`, served writable, as {@link runUpdate} left it. */
  public async selectOnWritable(query: string, dir: string): Promise<SelectResult> {
    await this.ensureServer(dir, undefined, true);
    return this.select(query, undefined);
  }

  private async select(query: string, timeoutMs: number | undefined): Promise<SelectResult> {
    await this.beforeQuery();
    const start = performance.now();
    try {
      const response = await this.post(query, 'application/sparql-results+json', timeoutMs);
      // The abort can fire while the body is still streaming, so reading it belongs in the same try.
      const json = <SparqlJsonResults> await readJsonResponse(response, this.name);
      return summarize(canonicalizeJsonResults(json), performance.now() - start);
    } catch (error: unknown) {
      if (error instanceof Error && error.name === 'TimeoutError') {
        await this.stop();
        throw new BenchTimeoutError(timeoutMs ?? 0);
      }
      throw error;
    }
  }

  /**
   * Runs a CONSTRUCT over `source` and streams the graph it builds, as N-Triples, into `out`, which stays
   * open for the next view's. No time budget: it materialises views, it is not a measurement row.
   */
  public async constructInto(query: string, source: EngineSource, out: Writable): Promise<void> {
    await this.serve(source, undefined);
    const response = await this.post(query, 'application/n-triples', undefined);
    if (!response.body) {
      return;
    }
    // Written chunk by chunk rather than piped: a pipe would end `out`, or, told not to, leave its listeners on it.
    for await (const chunk of Readable.fromWeb(<ReadableStream> response.body)) {
      if (!out.write(chunk)) {
        await once(out, 'drain');
      }
    }
  }

  /**
   * Runs a SPARQL update against the store at `dir`, served writable. How `timeMaterialization.ts` times
   * materialising views inside the database, with `INSERT ... WHERE`.
   */
  public async runUpdate(update: string, dir: string): Promise<void> {
    await this.ensureServer(dir, undefined, true);
    const response = await fetch(this.updateUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/sparql-update', ...this.updateHeaders() },
      body: update,
    });
    if (!response.ok) {
      throw new Error(`Engine '${this.name}' update returned HTTP ${response.status}: ${
        (await response.text()).slice(0, 2000)}`);
    }
    await response.body?.cancel();
  }

  public async dispose(): Promise<void> {
    await this.stop();
  }

  /** Has a server running on `source`'s store under `timeoutMs`, building the store first if need be. */
  private async serve(source: EngineSource, timeoutMs: number | undefined): Promise<void> {
    if (!source.file) {
      throw new Error(`Engine '${this.name}' needs a 'file' for dataset '${source.name}'.`);
    }
    await this.ensureServer(this.storeFor(source.file), timeoutMs, false);
  }

  private async post(query: string, accept: string, timeoutMs: number | undefined): Promise<Response> {
    const response = await fetch(`${this.queryUrl}${this.queryParameters(timeoutMs)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/sparql-query', Accept: accept },
      body: query,
      signal: timeoutMs === undefined ? undefined : AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) {
      throw new Error(`Engine '${this.name}' returned HTTP ${response.status}: ${
        (await response.text()).slice(0, 2000)}`);
    }
    return response;
  }

  /** Starts the server on `dir`, unless it already serves it the same way. */
  private async ensureServer(dir: string, timeoutMs: number | undefined, writable: boolean): Promise<void> {
    const wanted = `${dir}\n${timeoutMs}\n${writable}`;
    // A server that died after startup leaves `this.child` set; reusing it would turn every remaining
    // query into a connection-refused error row instead of restarting the server once.
    if (this.child && this.current === wanted && this.child.exitCode === null && this.child.signalCode === null) {
      return;
    }
    await this.stop();
    // A stray server from an earlier, killed run may be squatting on the port, holding other data.
    if (await this.ready()) {
      throw new Error(`Engine '${this.name}': port ${this.port} is already in use by another process.`);
    }
    this.recentOutput.length = 0;
    const [ command, ...args ] = this.serverCommand(
      dir,
      timeoutMs === undefined ? undefined : timeoutMs + SERVER_TIMEOUT_GRACE_MS,
      writable,
    );
    const child = spawn(command, args, { stdio: [ 'ignore', 'pipe', 'pipe' ]});
    this.child = child;
    this.current = wanted;
    let exited = false;
    child.on('exit', () => {
      exited = true;
    });
    const capture = (chunk: Buffer): void => {
      this.recentOutput.push(chunk.toString('utf8'));
      if (this.recentOutput.length > 200) {
        this.recentOutput.shift();
      }
    };
    child.stdout.on('data', capture);
    child.stderr.on('data', capture);

    const deadline = Date.now() + STARTUP_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (exited) {
        throw new Error(`Engine '${this.name}' exited during startup on ${dir}:\n${this.recentOutput.join('')}`);
      }
      if (await this.ready()) {
        return;
      }
      await new Promise((resolve) => {
        setTimeout(resolve, 200);
      });
    }
    await this.stop();
    throw new Error(`Engine '${this.name}' did not become ready within ${STARTUP_TIMEOUT_MS}ms on ${dir}.`);
  }

  /** Whether something answers queries on the port. */
  private async ready(): Promise<boolean> {
    try {
      const response = await fetch(this.queryUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/sparql-query', Accept: 'application/sparql-results+json' },
        body: 'SELECT ?s WHERE { ?s ?p ?o } LIMIT 1',
        signal: AbortSignal.timeout(2_000),
      });
      await response.body?.cancel();
      return response.ok;
    } catch {
      return false;
    }
  }

  /** Stops the server, if any, and waits for it to exit. */
  private async stop(): Promise<void> {
    const child = this.child;
    this.child = undefined;
    this.current = undefined;
    if (!child || child.exitCode !== null || child.signalCode !== null) {
      return;
    }
    await new Promise<void>((resolve) => {
      // Cleared on exit: an uncleared timer keeps the event loop, and so a finished run, alive.
      const escalate = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill('SIGKILL');
        }
      }, 10_000);
      child.once('exit', () => {
        clearTimeout(escalate);
        resolve();
      });
      child.kill('SIGTERM');
    });
  }
}

/**
 * **Oxigraph**'s native server (`oxigraph serve-read-only`) over a RocksDB store filled by its bulk loader
 * (`oxigraph load`). Oxigraph >= 0.5 supports SPARQL 1.2 / RDF 1.2 triple terms.
 *
 * Needs the `oxigraph` binary of a release (<https://github.com/oxigraph/oxigraph/releases>), on `PATH` or
 * named by `OXIGRAPH_BIN`. `OXIGRAPH_PORT` sets the port (default 3132).
 */
export class OxigraphEngine extends ManagedServerEngine {
  public readonly supportsSparql12 = true;
  public readonly storeKind = 'oxigraph';
  private readonly bin = process.env.OXIGRAPH_BIN ?? 'oxigraph';

  public constructor(name = 'oxigraph') {
    super(name, Number.parseInt(process.env.OXIGRAPH_PORT ?? '3132', 10));
  }

  public loadStore(file: string, dir: string): void {
    runTool(this.bin, [ 'load', '--location', dir, '--file', file ]);
  }

  protected serverCommand(dir: string, timeoutMs: number | undefined, writable: boolean): string[] {
    return [
      this.bin,
      writable ? 'serve' : 'serve-read-only',
      '--location',
      dir,
      '--bind',
      `localhost:${this.port}`,
      ...timeoutMs === undefined ? [] : [ '--timeout-s', String(Math.ceil(timeoutMs / 1000)) ],
    ];
  }

  protected get queryUrl(): string {
    return `${this.baseUrl}/query`;
  }

  protected get updateUrl(): string {
    return `${this.baseUrl}/update`;
  }
}

/**
 * **Apache Jena**'s Fuseki over a TDB2 database filled by `tdb2.tdbloader --loader=parallel`. Jena 5.x/6.x
 * supports SPARQL 1.2 / RDF 1.2 triple terms. Driven against a Fuseki 6.3.0 build, which needs a Java 21+
 * runtime; see `README.md`, "Setting up the engines", for which build to use and why it matters. TDB2 decides
 * for itself what to keep in memory.
 *
 * Configured through `JENA_FUSEKI_JAR` (the path to `fuseki-server.jar`, required; the jar also holds the
 * TDB2 loader), `JENA_JAVA` (default `java`), `JENA_FUSEKI_PORT` (default 3131) and `JENA_JVM_OPTS` (extra
 * JVM arguments, space-separated).
 */
export class JenaEngine extends ManagedServerEngine {
  public readonly supportsSparql12 = true;
  public readonly storeKind = 'tdb2';
  private readonly jarPath = process.env.JENA_FUSEKI_JAR ?? '';
  private readonly javaBin = process.env.JENA_JAVA ?? 'java';
  private readonly jvmArgs = (process.env.JENA_JVM_OPTS ?? '').split(/\s+/u).filter(Boolean);

  public constructor(name = 'jena') {
    super(name, Number.parseInt(process.env.JENA_FUSEKI_PORT ?? '3131', 10));
  }

  public loadStore(file: string, dir: string): void {
    const args = [ '-cp', this.jar(), 'tdb2.tdbloader', '--loader=parallel', '--loc', dir, file ];
    runTool(this.javaBin, [ ...this.jvmArgs, ...args ]);
  }

  protected serverCommand(dir: string, timeoutMs: number | undefined, writable: boolean): string[] {
    return [
      this.javaBin,
      ...this.jvmArgs,
      '-jar',
      this.jar(),
      '--tdb2',
      `--loc=${dir}`,
      ...writable ? [ '--update' ] : [],
      ...timeoutMs === undefined ? [] : [ `--timeout=${timeoutMs}` ],
      '--port',
      String(this.port),
      '/ds',
    ];
  }

  protected get queryUrl(): string {
    return `${this.baseUrl}/ds/sparql`;
  }

  protected get updateUrl(): string {
    return `${this.baseUrl}/ds/update`;
  }

  private jar(): string {
    if (!this.jarPath) {
      throw new Error('JenaEngine: set JENA_FUSEKI_JAR to a Fuseki fuseki-server.jar (see test/bench/README.md).');
    }
    return this.jarPath;
  }
}

/**
 * **QLever**'s server over an index built by its index builder. QLever has no RDF 1.2 support, so it runs the
 * LUBM and OAEI workloads only.
 *
 * QLever keeps the results of queries and their subqueries in a cache, and the benchmark's pipelines share
 * subqueries, so the cache is cleared before every query: each one is measured cold, as on the other
 * engines. Updates are held in memory, which is all `timeMaterialization.ts` needs of them.
 *
 * Needs `qlever-index` and `qlever-server`, built from <https://github.com/ad-freiburg/qlever>, in
 * `QLEVER_BIN_DIR` or on `PATH`. `QLEVER_PORT` sets the port (default 3133) and `QLEVER_MEMORY` the memory
 * queries may use (default `12GB`, about what Jena's JVM gets by default on this machine).
 */
export class QLeverEngine extends ManagedServerEngine {
  public readonly supportsSparql12 = false;
  public readonly storeKind = 'qlever';
  private readonly binDir = process.env.QLEVER_BIN_DIR;
  private readonly memory = process.env.QLEVER_MEMORY ?? '12GB';
  /** Guards nothing - the server listens on localhost - but QLever takes no updates without one. */
  private readonly accessToken = 'bench';

  public constructor(name = 'qlever') {
    super(name, Number.parseInt(process.env.QLEVER_PORT ?? '3133', 10));
  }

  public loadStore(file: string, dir: string): void {
    mkdirSync(dir, { recursive: true });
    const format = file.endsWith('.ttl') ? 'ttl' : 'nt';
    // The builder writes its temporary files to the working directory, so the paths must not be relative.
    const args = [ '-i', resolve(dir, 'index'), '-f', resolve(file), '-F', format, '-p', 'true' ];
    runTool(this.bin('qlever-index'), args, dir);
  }

  protected serverCommand(dir: string, timeoutMs: number | undefined, _writable: boolean): string[] {
    return [
      this.bin('qlever-server'),
      '-i',
      join(dir, 'index'),
      '-p',
      String(this.port),
      '-m',
      this.memory,
      '-a',
      this.accessToken,
      // Without a budget (materialising views) the server's own 30 s default must not apply either.
      '-s',
      `${timeoutMs === undefined ? 1_000_000 : Math.ceil(timeoutMs / 1000)}s`,
    ];
  }

  protected get queryUrl(): string {
    return `${this.baseUrl}/`;
  }

  protected get updateUrl(): string {
    return `${this.baseUrl}/`;
  }

  protected override updateHeaders(): Record<string, string> {
    return { Authorization: `Bearer ${this.accessToken}` };
  }

  protected override async beforeQuery(): Promise<void> {
    const response = await fetch(`${this.baseUrl}/?cmd=clear-cache`);
    await response.body?.cancel();
  }

  private bin(name: string): string {
    return this.binDir ? join(this.binDir, name) : name;
  }
}
