// Turns the benchmark's results into the data the overview page embeds (see build.mjs).
// Usage: node test/bench/overview/analyse.mjs [results.json] [--out overview-data.json]
// Reads results/results.json (every engine, preserveCardinality off and on), results/materialization.json and
// results/results-keep-projections.json (the full pipeline against the same without removeProjections).
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';

const RESULTS = join(import.meta.dirname, '..', 'results');
const outIdx = process.argv.indexOf('--out');
const OUT = outIdx > 0 ? process.argv[outIdx + 1] : join(import.meta.dirname, 'overview-data.json');
const IN = process.argv.slice(2).find((arg, i, args) => !arg.startsWith('--') && args[i - 1] !== '--out') ??
  join(RESULTS, 'results.json');

const ENGINES = [ 'qlever', 'virtuoso', 'graphdb', 'oxigraph', 'jena', 'blazegraph', 'comunica' ];
const WORKLOADS = [ 'lubm', 'oaei', 'reification', 'singleton' ];
const SCALES = [ 'u1', 'u10', 'u50', 'u100', 'u250', 'u500', 'eswc', 'd100', 'xs', 's' ];
const RUNGS = [ 'rewriting', 'rewriting+removeProjections', 'rewriting+pushDownAssertions', 'rewriting+pullUpExtends' ];
// A variant is one column of the benchmark: the reference, or a rung with pc off or on.
const VARIANTS = [ 'materialized', ...RUNGS.map(r => `${r}|off`), ...RUNGS.map(r => `${r}|on`) ];
function variantOf(row) {
  return row.approach === 'materialized' ?
    'materialized' :
  `${row.approach}|${row.preserveCardinality ? 'on' : 'off'}`;
}
// A difference smaller than this is a tie: it is within the run-to-run drift seen between runs.
const TIE = 1.1;

const rows = JSON.parse(readFileSync(IN, 'utf8'));
const materialization = JSON.parse(readFileSync(join(RESULTS, 'materialization.json'), 'utf8'));

// Cell = engine × workload × scale × case, holding a row per variant.
const cells = new Map();
for (const row of rows) {
  const key = `${row.engine}\t${row.scheme}\t${row.scale}\t${row.caseId}`;
  if (!cells.has(key)) {
    cells.set(key, { engine: row.engine, workload: row.scheme, scale: row.scale, caseId: row.caseId, quads: row.quads, timeoutMs: row.timeoutMs, v: {}});
  }
  cells.get(key).v[variantOf(row)] = row;
}
const allCells = [ ...cells.values() ];

// The answer size every engine's reference agrees on, per workload × scale × case; null where they disagree.
const referenceCounts = new Map();
for (const c of allCells) {
  const m = c.v.materialized;
  if (m?.status === 'ok') {
    const key = `${c.workload}\t${c.scale}\t${c.caseId}`;
    const seen = referenceCounts.get(key);
    referenceCounts.set(key, seen === undefined || seen === m.count ? m.count : null);
  }
}
const otherReferenceCount = c => referenceCounts.get(`${c.workload}\t${c.scale}\t${c.caseId}`) ?? null;

// Readable names for the kinds of error engines give; anything unmatched keeps the engine's own message.
const ERROR_KINDS = [
  [ /sameterm.{0,10}not yet implemented/iu, 'QLever: no sameTerm' ],
  [ /Tried to allocate/u, 'QLever: out of query memory (12 GB cap)' ],
  [ /generated SQL text has exceeded/u, 'Virtuoso: generated SQL over 10,000 lines (SP031, compiled-in)' ],
  [ /variables in state over the limit/u, 'Virtuoso: too many state slots (SQ156, compiled-in)' ],
  [ /Alias \S+ is defined twice/u, 'Virtuoso: compiler says an alias is defined twice' ],
  [ /subq ot was supposed to be found/u, 'Virtuoso: internal optimiser error (subq ot)' ],
  [ /populateStatsMap|StackOverflowError/u, 'Blazegraph: stack overflow on the deeply nested plan' ],
  [ /out of memory|OutOfMemoryError|SIGKILL/u, 'out of memory' ],
];

// StarBench cases whose shipped reference query is broken (test/bench/README.md, "Known issues in the
// corpus"). `different`: the singleton reference asks another question (other IRIs or concepts, a missing
// pattern), so it is neither an oracle nor a fair time to compare with. `selectStar`: it asks the same
// question but binds one variable more, so its rows never match while its time still compares.
const REFERENCE_DEFECTS = {
  singleton: { different: [ 'A-Q1', 'A-Q2', 'A-Q3', 'A-Q4', 'B-Q2', 'F-Q1', 'F-Q3', 'F-Q4', 'F-Q5' ], selectStar: [ 'F-Q1', 'F-Q2' ]},
  reification: { different: [], selectStar: [ 'F-Q1', 'F-Q2' ]},
};
const shortId = c => c.caseId.split('/').pop();
function referenceDefect(c) {
  return REFERENCE_DEFECTS[c.workload] &&
  [ ...REFERENCE_DEFECTS[c.workload].different, ...REFERENCE_DEFECTS[c.workload].selectStar ].includes(shortId(c));
}
const referenceDiffers = c => REFERENCE_DEFECTS[c.workload]?.different.includes(shortId(c)) ?? false;

// The answer size the rewrites agree on across engines and rungs, where the reference cannot say.
const rewriteCounts = new Map();
for (const c of allCells) {
  for (const [ v, r ] of Object.entries(c.v)) {
    if (v !== 'materialized' && r.status === 'ok') {
      const key = `${c.workload}\t${c.scale}\t${c.caseId}`;
      const seen = rewriteCounts.get(key);
      rewriteCounts.set(key, seen === undefined || seen === r.count ? r.count : null);
    }
  }
}
const rewriteCount = c => rewriteCounts.get(`${c.workload}\t${c.scale}\t${c.caseId}`) ?? null;

const time = row => Math.max(row.medianMs, 1);
const geomean = xs => xs.length > 0 ? Math.exp(xs.reduce((a, x) => a + Math.log(x), 0) / xs.length) : null;
function quantile(xs, q) {
  if (xs.length === 0) {
    return null;
  }
  const s = [ ...xs ].sort((a, b) => a - b);
  const i = (s.length - 1) * q;
  return s[Math.floor(i)] + (s[Math.ceil(i)] - s[Math.floor(i)]) * (i - Math.floor(i));
}
const round = (x, d = 3) => x === null ? null : Number(x.toPrecision(d));

/**
 * Compares variant a against b on the cells given. `ratio` is a/b over the cases both answered;
 * a win is a case where a is faster by more than TIE, or a answered and b timed out.
 * A case where either errored is left out and counted.
 */
function compare(cs, a, b) {
  const ratios = [];
  let aWins = 0;
  let bWins = 0;
  let ties = 0;
  let bothTimeout = 0;
  let errored = 0;
  for (const c of cs) {
    const ra = c.v[a];
    const rb = c.v[b];
    if (!ra || !rb || (b === 'materialized' && referenceDiffers(c))) {
      continue;
    }
    if (ra.status === 'error' || rb.status === 'error') {
      errored++;
    } else if (ra.status === 'ok' && rb.status === 'ok') {
      const r = time(ra) / time(rb);
      ratios.push(r);
      if (r < 1 / TIE) {
        aWins++;
      } else if (r > TIE) {
        bWins++;
      } else {
        ties++;
      }
    } else if (ra.status === 'ok') {
      aWins++;
    } else if (rb.status === 'ok') {
      bWins++;
    } else {
      bothTimeout++;
    }
  }
  return {
    n: ratios.length,
    geomean: round(geomean(ratios)),
    p10: round(quantile(ratios, 0.1)),
    median: round(quantile(ratios, 0.5)),
    p90: round(quantile(ratios, 0.9)),
    aWins,
    bWins,
    ties,
    bothTimeout,
    errored,
  };
}

/** Counts per variant: answered (ok), timeout, error; and of the answered, how they grade. */
function tally(cs, variant) {
  const t = { total: 0, ok: 0, timeout: 0, error: 0, correct: 0, setOnly: 0, wrong: 0, ungraded: 0, ungradedSizeMatches: 0, refDefect: 0, refDefectAgree: 0 };
  for (const c of cs) {
    const r = c.v[variant];
    if (!r) {
      continue;
    }
    t.total++;
    t[r.status]++;
    if (r.status === 'ok' && variant !== 'materialized') {
      if (r.correct === null) {
        // The engine's own reference timed out: there is nothing to grade against. The size can still be
        // checked against the reference other engines computed.
        t.ungraded++;
        if (r.count === otherReferenceCount(c)) {
          t.ungradedSizeMatches++;
        }
      } else if (r.correct) {
        t.correct++;
      } else if (referenceDefect(c)) {
        // Not a verdict on the rewrite: the reference is broken. What can be checked is that every engine and
        // every rung returns the same number of rows.
        t.refDefect++;
        if (r.count === rewriteCount(c)) {
          t.refDefectAgree++;
        }
      } else if (r.correctAsSet) {
        t.setOnly++;
      } else {
        t.wrong++;
      }
    }
  }
  return t;
}

function groupBy(xs, f) {
  const m = new Map();
  for (const x of xs) {
    const k = f(x);
    m.set(k, [ ...m.get(k) ?? [], x ]);
  }
  return m;
}
const order = (list, x) => list.includes(x) ? list.indexOf(x) : list.length;

// One summary block per engine × workload × scale.
const groups = [ ...groupBy(allCells, c => `${c.engine}\t${c.workload}\t${c.scale}`).values() ]
  .sort((x, y) => order(ENGINES, x[0].engine) - order(ENGINES, y[0].engine) ||
    order(WORKLOADS, x[0].workload) - order(WORKLOADS, y[0].workload) ||
    order(SCALES, x[0].scale) - order(SCALES, y[0].scale));

function breakEven(cs, engine, workload, scale, pc) {
  const ways = materialization.filter(m => m.engine === engine && m.workload === workload && m.scale === scale);
  if (ways.length === 0) {
    return null;
  }
  const fastest = ways.reduce((a, b) => a.totalMs <= b.totalMs ? a : b);
  const final = `rewriting+pullUpExtends|${pc}`;
  let saving = 0;
  let queries = 0;
  let rewritingCensored = false;
  let materializedCensored = false;
  for (const c of cs) {
    const m = c.v.materialized;
    const r = c.v[final];
    if (!m || !r || m.status === 'error' || r.status === 'error') {
      continue;
    }
    rewritingCensored ||= r.status === 'timeout';
    materializedCensored ||= m.status === 'timeout';
    const t = row => row.status === 'ok' ? row.medianMs : row.timeoutMs;
    saving += t(r) - t(m);
    queries++;
  }
  return {
    buildMs: Math.round(fastest.totalMs),
    method: fastest.method,
    storeBytes: fastest.storeBytes,
    queriesUsed: queries,
    meanSavingMs: queries ? round(saving / queries) : null,
    queries: saving > 0 ? Math.ceil(fastest.totalMs / (saving / queries)) : null,
    rewritingCensored,
    materializedCensored,
  };
}

/** The comparisons the page shows, over any set of cells. */
function measures(cs) {
  const steps = {};
  for (const pc of [ 'off', 'on' ]) {
    steps[pc] = RUNGS.slice(1).map((rung, i) => compare(cs, `${rung}|${pc}`, `${RUNGS[i]}|${pc}`));
  }
  const final = 'rewriting+pullUpExtends';
  const common = cs.filter(c => !referenceDiffers(c) && [ 'materialized', `${final}|off`, `${final}|on` ]
    .every(v => c.v[v]?.status === 'ok'));
  return {
    cases: cs.length,
    tally: Object.fromEntries(VARIANTS.map(v => [ v, tally(cs, v) ])),
    // Each rung against the one before it.
    steps,
    // Each rung against the reference.
    vsReference: Object.fromEntries(VARIANTS.slice(1).map(v => [ v, compare(cs, v, 'materialized') ])),
    // The final rung against the reference, pc off and on, over only the cases all three answered, so the
    // two pc settings are compared on the same queries.
    finalCommon: { off: compare(common, `${final}|off`, 'materialized'), on: compare(common, `${final}|on`, 'materialized') },
    // Pc on against pc off, per rung.
    pcEffect: Object.fromEntries(RUNGS.map(r => [ r, compare(cs, `${r}|on`, `${r}|off`) ])),
  };
}

const summary = groups.map((cs) => {
  const { engine, workload, scale, quads, timeoutMs } = cs[0];
  return {
    engine,
    workload,
    scale,
    quads,
    timeoutMs,
    ...measures(cs),
    breakEven: workload === 'lubm' || workload === 'oaei' ?
        { off: breakEven(cs, engine, workload, scale, 'off'), on: breakEven(cs, engine, workload, scale, 'on') } :
      null,
  };
});

// The same, per engine × workload over all its scales.
const pooled = [ ...groupBy(allCells, c => `${c.engine}\t${c.workload}`).values() ]
  .sort((x, y) => order(ENGINES, x[0].engine) - order(ENGINES, y[0].engine) ||
    order(WORKLOADS, x[0].workload) - order(WORKLOADS, y[0].workload))
  .map(cs => ({ engine: cs[0].engine, workload: cs[0].workload, scales: [ ...new Set(cs.map(c => c.scale)) ].sort((a, b) => order(SCALES, a) - order(SCALES, b)), ...measures(cs) }));

// Per-query detail, compact: dictionaries plus one array per cell.
// Each variant is [status, ms, count, grade, error]: status 0 ok, 1 timeout, 2 error, 3 not run because it
// timed out at a smaller scale, null missing;
// grade 0 reference, 1 correct, 2 correct as a set only, 3 wrong, 4 ungraded (own reference timed out),
// 5 differs from a reference known to be broken (REFERENCE_DEFECTS).
// `refCount` is the size other engines' references agree on, for the drill-down.
function gradeOf(row, cell) {
  if (row.correct === null) {
    return 4;
  }
  if (row.correct) {
    return 1;
  }
  if (referenceDefect(cell)) {
    return 5;
  }
  return row.correctAsSet ? 2 : 3;
}
const caseIds = [ ...new Set(allCells.map(c => c.caseId)) ].sort();
const errors = [];
const detail = allCells.map((c) => {
  const vs = VARIANTS.map((v) => {
    const r = c.v[v];
    if (!r) {
      return null;
    }
    const status = String(r.error ?? '').startsWith('skipped') ? 3 : { ok: 0, timeout: 1, error: 2 }[r.status];
    const grade = r.status === 'ok' && v !== 'materialized' ? gradeOf(r, c) : 0;
    let err = null;
    if (r.status === 'error') {
      const msg = String(r.error ?? '').replaceAll(/\s+/gu, ' ');
      // One entry per kind of error: the engine's own message, with its sizes and positions blanked.
      const short = ERROR_KINDS.find(([ re ]) => re.test(msg))?.[1] ??
        (/"exception": "((?:[^"\\]|\\.)*)"/u.exec(msg)?.[1] ?? msg).replaceAll(/\d+(\.\d+)?/gu, '#').slice(0, 200);
      if (!errors.includes(short)) {
        errors.push(short);
      }
      err = errors.indexOf(short);
    }
    return [ status, r.status === 'ok' ? Math.round(r.medianMs) : null, r.count ?? null, grade, err ];
  });
  return [ ENGINES.indexOf(c.engine), WORKLOADS.indexOf(c.workload), SCALES.indexOf(c.scale), caseIds.indexOf(c.caseId), vs, otherReferenceCount(c), referenceDefect(c) ? (referenceDiffers(c) ? 2 : 1) : 0 ];
});

// The full pipeline without removeProjections, against the full pipeline measured alongside it in the same run
// (not the campaign's rows, measured days apart), per engine × workload over all its scales.
const KEEP = join(RESULTS, 'results-keep-projections.json');
let keepProjections = null;
if (existsSync(KEEP)) {
  const keepCells = new Map();
  for (const row of JSON.parse(readFileSync(KEEP, 'utf8'))) {
    const key = `${row.engine}\t${row.scheme}\t${row.scale}\t${row.caseId}`;
    if (!keepCells.has(key)) {
      keepCells.set(key, { engine: row.engine, workload: row.scheme, scale: row.scale, caseId: row.caseId, v: {}});
    }
    keepCells.get(key).v[variantOf(row)] = row;
  }
  const [ full, keep ] = [ 'rewriting+pullUpExtends', 'rewriting+keepProjections' ];
  keepProjections = [ ...groupBy([ ...keepCells.values() ], c => `${c.engine}\t${c.workload}`).values() ]
    .sort((x, y) => order(ENGINES, x[0].engine) - order(ENGINES, y[0].engine) ||
      order(WORKLOADS, x[0].workload) - order(WORKLOADS, y[0].workload))
    .map(cs => ({
      engine: cs[0].engine,
      workload: cs[0].workload,
      ...Object.fromEntries([ 'off', 'on' ].map(pc => [ pc, {
        compare: compare(cs, `${keep}|${pc}`, `${full}|${pc}`),
        full: tally(cs, `${full}|${pc}`),
        keep: tally(cs, `${keep}|${pc}`),
      }])),
    }));
}

const data = {
  generated: new Date().toISOString(),
  source: basename(IN),
  rows: rows.length,
  tie: TIE,
  dict: { engines: ENGINES, workloads: WORKLOADS, scales: SCALES, variants: VARIANTS, caseIds, errors },
  summary,
  pooled,
  keepProjections,
  detail,
};
writeFileSync(OUT, JSON.stringify(data));
process.stdout.write(`${rows.length} rows, ${allCells.length} cells, ${summary.length} groups -> ${OUT} ` +
  `(${Math.round(JSON.stringify(data).length / 1024)} KB)\n`);
