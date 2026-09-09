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
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import type { Readable } from 'node:stream';
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
  /** Local Turtle file path (used by in-process engines). */
  file?: string;
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
      if (line.trim() === '') {
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

  public async ask(query: string, timeoutMs: number): Promise<SelectResult> {
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
      this.child.stdin.write(`${JSON.stringify({ query, timeoutMs })}\n`);
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
    if (source.file) {
      return this.runInWorker(query, source.file, timeoutMs);
    }
    return this.runInProcess(query, source, timeoutMs);
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
  private async runInWorker(query: string, file: string, timeoutMs?: number): Promise<SelectResult> {
    if (this.worker && !this.worker.usable(file)) {
      this.worker.kill();
      this.worker = undefined;
    }
    this.worker ??= new ComunicaWorker(this.workerScript, file, this.name);
    try {
      return await this.worker.ask(query, timeoutMs ?? 0);
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
    return summarize(SparqlHttpEngine.canonicalizeJsonResults(json), durationMs);
  }

  /** Turns SPARQL Results JSON into the same canonical form as {@link bindingToString}. */
  private static canonicalizeJsonResults(json: SparqlJsonResults): string[] {
    return json.results.bindings.map((row) => {
      const entries = Object.entries(row)
        .map(([ variable, value ]) => `${variable}=${SparqlHttpEngine.canonicalizeJsonTerm(value)}`)
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
  private static canonicalizeJsonTerm(value: SparqlJsonTerm): string {
    if (value.type === 'triple' && value.value && typeof value.value === 'object') {
      const t = value.value;
      return `Quad:<<${SparqlHttpEngine.canonicalizeJsonTerm(t.subject)}|` +
        `${SparqlHttpEngine.canonicalizeJsonTerm(t.predicate)}|` +
        `${SparqlHttpEngine.canonicalizeJsonTerm(t.object)}>>`;
    }
    const termType = value.type === 'uri' ? 'NamedNode' : (value.type === 'bnode' ? 'BlankNode' : 'Literal');
    return `${termType}:${<string> value.value}`;
  }
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
 * In-process engine backed by Oxigraph (Rust, compiled to WASM). Oxigraph >= 0.4
 * supports SPARQL 1.2 / RDF 1.2 triple terms natively.
 *
 * Oxigraph's `Store.query` is *synchronous* and blocks the event loop, so it
 * cannot be cancelled with an in-process timer. To keep the benchmark bounded,
 * each query is executed in a short-lived child process (`oxiOneShot.mjs`) that
 * loads the dataset file and answers a single query; the parent enforces a hard
 * wall-clock timeout by killing that child. The dataset is taken from
 * {@link EngineSource.file}.
 */
export class OxigraphEngine implements BenchEngine {
  public readonly supportsSparql12 = true;
  private readonly oneShot = join(dirname(fileURLToPath(import.meta.url)), 'oxiOneShot.mjs');

  public constructor(public readonly name = 'oxigraph') {}

  public async runSelect(query: string, source: EngineSource, timeoutMs?: number): Promise<SelectResult> {
    if (!source.file) {
      throw new Error(`OxigraphEngine needs a 'file' for dataset '${source.name}'.`);
    }
    const result = spawnSync(process.execPath, [ this.oneShot, source.file ], {
      input: query,
      timeout: timeoutMs,
      maxBuffer: 512 * 1024 * 1024,
      encoding: 'utf8',
    });
    // `spawnSync`'s own timeout reports both ways depending on platform and timing: an
    // ETIMEDOUT error, or a plain SIGTERM signal with no error. Any *other* signal is the
    // worker dying on its own (the OOM killer on a large subset, most often) and must
    // stay an error — reporting it as a timeout would quietly turn a crash into a
    // "too slow" data point.
    const killedByUs = (<NodeJS.ErrnoException | undefined> result.error)?.code === 'ETIMEDOUT' ||
      result.signal === 'SIGTERM';
    if (killedByUs) {
      throw new BenchTimeoutError(timeoutMs ?? 0);
    }
    if (result.signal !== null) {
      throw new Error(`oxigraph one-shot killed by ${result.signal}: ${result.stderr.slice(0, 500)}`);
    }
    if (result.status !== 0) {
      throw new Error(`oxigraph one-shot failed: ${result.stderr.slice(0, 500)}`);
    }
    const parsed = <{ durationMs: number; count: number; rows: string[] }> JSON.parse(result.stdout);
    return { rows: parsed.rows, count: parsed.count, durationMs: parsed.durationMs };
  }
}

/**
 * In-process-managed engine backed by **Apache Jena / Fuseki** (Java, HTTP SPARQL
 * endpoint). Jena 5.x/6.x has full SPARQL 1.2 / RDF 1.2 support (new `<<( )>>`
 * triple-term syntax, `rdf:reifies`) — see the survey in `README.md`. Verified in
 * this session against Fuseki 6.2.0, which requires a **Java 21+** runtime (Fuseki
 * 6.x class files are too new for Java 17; earlier Fuseki releases, e.g. 4.10.x,
 * work with Java 11/17 — see `README.md` for details).
 *
 * Unlike {@link OxigraphEngine} (one-shot child process per query, since Oxigraph's
 * `Store.query` is synchronous), Fuseki is a long-lived HTTP server, so this engine
 * keeps one `fuseki-server.jar` child process running and reuses it across every
 * query against the same dataset {@link EngineSource.file}. It only pays the
 * (JVM startup + dataset load) cost again when the requested `file` changes — which
 * matches `run.ts`'s loop order (one dataset file per (engine, scheme, scale)
 * block, queried by every benchmark case in that block). Call {@link dispose} once
 * done to shut the child process down; `run.ts` does this for every engine after
 * its scheme/scale loops finish.
 *
 * Needs the `fuseki-server.jar` from an Apache Jena Fuseki distribution
 * (<https://jena.apache.org/download/>) and a Java runtime on `PATH` — see
 * `README.md` for the exact download/setup steps. Configurable via env vars
 * (or constructor options): `JENA_FUSEKI_JAR` (path to the jar, required),
 * `JENA_JAVA` (java binary, default `java`), `JENA_FUSEKI_PORT` (default 3131),
 * `JENA_JVM_OPTS` (extra JVM args, space-separated, e.g. `-Xmx4g` for the
 * larger `m`/`l` scale subsets).
 */
export class JenaEngine implements BenchEngine {
  public readonly supportsSparql12 = true;
  private readonly jarPath: string;
  private readonly javaBin: string;
  private readonly port: number;
  private readonly extraJavaArgs: string[];
  private readonly startupTimeoutMs: number;

  private child: ChildProcessByStdio<null, Readable, Readable> | undefined;
  private currentFile: string | undefined;
  private readonly recentOutput: string[] = [];

  public constructor(public readonly name = 'jena', options: {
    jarPath?: string;
    javaBin?: string;
    port?: number;
    extraJavaArgs?: string[];
    startupTimeoutMs?: number;
  } = {}) {
    this.jarPath = options.jarPath ?? process.env.JENA_FUSEKI_JAR ?? '';
    this.javaBin = options.javaBin ?? process.env.JENA_JAVA ?? 'java';
    this.port = options.port ?? Number.parseInt(process.env.JENA_FUSEKI_PORT ?? '3131', 10);
    this.extraJavaArgs = options.extraJavaArgs ?? (process.env.JENA_JVM_OPTS ?? '').split(/\s+/u).filter(Boolean);
    // Loading the `m`/`l` scale subsets (hundreds of MB of Turtle) can take well
    // over a minute; this is independent of, and not charged against, the
    // per-query `timeoutMs` passed to `runSelect`.
    this.startupTimeoutMs = options.startupTimeoutMs ?? 180_000;
  }

  private get baseUrl(): string {
    return `http://localhost:${this.port}`;
  }

  public async runSelect(query: string, source: EngineSource, timeoutMs?: number): Promise<SelectResult> {
    if (!source.file) {
      throw new Error(`JenaEngine needs a 'file' for dataset '${source.name}'.`);
    }
    await this.ensureServer(source.file);

    const start = performance.now();
    let json: { results: { bindings: Record<string, { type: string; value: unknown }>[] }};
    try {
      const response = await fetch(`${this.baseUrl}/ds/sparql`, {
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
      json = <{ results: { bindings: Record<string, { type: string; value: unknown }>[] }}>
        await readJsonResponse(response, this.name);
    } catch (error: unknown) {
      if (error instanceof Error && error.name === 'TimeoutError') {
        throw new BenchTimeoutError(timeoutMs ?? 0);
      }
      throw error;
    }
    const durationMs = performance.now() - start;
    const rows = json.results.bindings.map((row) => {
      const entries = Object.entries(row)
        .map(([ variable, value ]) => `${variable}=${JenaEngine.canonicalizeTerm(value)}`)
        .sort()
        .join(',');
      return `{${entries}}`;
    });
    return summarize(rows, durationMs);
  }

  /** Same canonicalization as {@link SparqlHttpEngine}, including RDF 1.2 triple terms. */
  private static canonicalizeTerm(value: { type: string; value: unknown }): string {
    if (value.type === 'triple' && value.value && typeof value.value === 'object') {
      const t = <{ subject: unknown; predicate: unknown; object: unknown }> value.value;
      return `Quad:<<${JenaEngine.canonicalizeTerm(<{ type: string; value: unknown }> t.subject)}|` +
        `${JenaEngine.canonicalizeTerm(<{ type: string; value: unknown }> t.predicate)}|` +
        `${JenaEngine.canonicalizeTerm(<{ type: string; value: unknown }> t.object)}>>`;
    }
    const termType = value.type === 'uri' ? 'NamedNode' : (value.type === 'bnode' ? 'BlankNode' : 'Literal');
    return `${termType}:${<string> value.value}`;
  }

  /** Starts (or restarts, if `file` differs from what is currently loaded) the Fuseki child process. */
  private async ensureServer(file: string): Promise<void> {
    // `exitCode`/`signalCode` are the liveness check that matters: a server that died
    // after startup (OOM on a large subset, say) leaves `this.child` set, and reusing it
    // would turn every remaining query into a connection-refused `error` row instead of
    // restarting the server once.
    if (this.child && this.currentFile === file && this.child.exitCode === null && this.child.signalCode === null) {
      return;
    }
    await this.stop();
    if (!this.jarPath) {
      throw new Error(
        'JenaEngine: no fuseki-server.jar configured. Set JENA_FUSEKI_JAR to the path of a Jena Fuseki ' +
        'distribution\'s fuseki-server.jar (see test/bench/README.md for download/setup instructions).',
      );
    }
    // Guard against a stray process (from a previous crashed/killed run) already
    // squatting on the port: if it answers /$/ping before we've spawned anything,
    // it is *not* guaranteed to hold the dataset we're about to request.
    if (await JenaEngine.ping(this.baseUrl)) {
      throw new Error(
        `JenaEngine: port ${this.port} is already in use by another process (not started by this ` +
        'JenaEngine instance) — refusing to query it, since it may not have the expected dataset ' +
        'loaded. Free the port or pass a different `port` option.',
      );
    }

    this.recentOutput.length = 0;
    const args = [
      ...this.extraJavaArgs,
      '-jar',
      this.jarPath,
      `--file=${file}`,
      '--port',
      String(this.port),
      '/ds',
    ];
    const child = spawn(this.javaBin, args, { stdio: [ 'ignore', 'pipe', 'pipe' ]});
    this.child = child;
    this.currentFile = file;
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

    const deadline = Date.now() + this.startupTimeoutMs;
    while (Date.now() < deadline) {
      if (exited) {
        throw new Error(
          `JenaEngine: fuseki-server exited during startup (dataset '${file}'). Recent output:\n${
          this.recentOutput.join('')}`,
        );
      }
      if (await JenaEngine.ping(this.baseUrl)) {
        return;
      }
      await new Promise((resolve) => {
        setTimeout(resolve, 500);
      });
    }
    await this.stop();
    throw new Error(
      `JenaEngine: fuseki-server did not become ready within ${this.startupTimeoutMs}ms (dataset '${file}').`,
    );
  }

  private static async ping(baseUrl: string): Promise<boolean> {
    try {
      const response = await fetch(`${baseUrl}/$/ping`, { signal: AbortSignal.timeout(2_000) });
      return response.ok;
    } catch {
      return false;
    }
  }

  /** Stops the current Fuseki child process, if any, and waits for it to exit. */
  private async stop(): Promise<void> {
    const child = this.child;
    this.child = undefined;
    this.currentFile = undefined;
    if (!child || child.exitCode !== null || child.signalCode !== null) {
      return;
    }
    await new Promise<void>((resolve) => {
      // Cleared on exit: an uncleared 5s timer keeps the Node event loop alive, so a run
      // that has written its last row would sit idle before the process could exit.
      const escalate = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill('SIGKILL');
        }
      }, 5_000);
      child.once('exit', () => {
        clearTimeout(escalate);
        resolve();
      });
      child.kill('SIGTERM');
    });
  }

  public async dispose(): Promise<void> {
    await this.stop();
  }
}
