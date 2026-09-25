/**
 * @fileoverview Compiles the LUBM ontology into non-recursive CONSTRUCT views over the asserted data:
 * reasoning by rewriting. The virtual graph the views denote is the asserted data plus everything the
 * ontology entails from it, so a query over the views answers as a query over the saturated graph would.
 *
 * Every view body reads only asserted predicates, so no view feeds another and no recursion arises. The
 * TBox is saturated here instead, once:
 *
 * - **One identity view**, `CONSTRUCT WHERE { ?s ?p ?o }`, carries the asserted data itself.
 * - **Class and property hierarchies, inverses, domains and ranges** (from `univ-benchQL.owl`, the OWL 2 QL
 *   version of the ontology in ontop/iswc2014-benchmark): the subsumption graph over basic concepts (`A`,
 *   `∃P`, `∃P⁻`) and roles (`P`, `P⁻`) is closed reflexively and transitively, and one view is emitted per
 *   entailed class or property and basic concept that entails it.
 * - **The defined classes** (`Chair`, `Dean`, `Director`, `Employee`, `Student`, `TeachingAssistant`):
 *   the QL version keeps only their `D ⊑ ∃P.C` half, which derives nothing, so their `A ⊓ ∃P.C ⊑ D` half
 *   is read from the original `univ-bench.owl`. Each becomes views with a conjunctive body - one per
 *   sub-role of `P` and per basic concept entailing `C` (and `A`) - that derive `D` and every superclass
 *   of it. A conjunct the role already implies through its domain or range is left out.
 *
 * Left out, and printed so the README can say so:
 * - `A ⊑ ∃P.C` axioms: they assert that an unnamed individual exists, which a view cannot produce without
 *   inventing a node for it.
 * - `owl:TransitiveProperty` (`subOrganizationOf`): its closure is recursive. LUBM Q11 needs it and is
 *   therefore not part of the workload.
 *
 * Usage: node test/bench/workloads/lubm/compileOntology.mjs <univ-benchQL.owl> <univ-bench.owl> <views.rq>
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import oxigraph from 'oxigraph';

const UB = 'http://swat.cse.lehigh.edu/onto/univ-bench.owl#';
const RDF = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';
const RDFS = 'http://www.w3.org/2000/01/rdf-schema#';
const OWL = 'http://www.w3.org/2002/07/owl#';
const VIEW_SEPARATOR = '# ----';

const [ qlFile, fullFile, outFile ] = process.argv.slice(2);
if (!outFile) {
  process.stderr.write('usage: node compileOntology.mjs <univ-benchQL.owl> <univ-bench.owl> <views.rq>\n');
  process.exit(2);
}

function load(file) {
  const store = new oxigraph.Store();
  store.load(readFileSync(file, 'utf8'), {
    format: 'application/rdf+xml',
    base_iri: file.endsWith('univ-bench.owl') ? 'http://swat.cse.lehigh.edu/onto/univ-bench.owl' : pathToFileURL(file).href,
  });
  return store;
}

function objects(store, subject, predicate) {
  return store.match(subject, oxigraph.namedNode(predicate), null, null).map(q => q.object);
}

function subjectsOfType(store, type) {
  return store.match(null, oxigraph.namedNode(`${RDF}type`), oxigraph.namedNode(type), null).map(q => q.subject);
}

/** Reads an RDF list into an array of terms. */
function list(store, head) {
  const items = [];
  let node = head;
  while (node.value !== `${RDF}nil`) {
    items.push(objects(store, node, `${RDF}first`)[0]);
    node = objects(store, node, `${RDF}rest`)[0];
  }
  return items;
}

const ql = load(qlFile);
const full = load(fullFile);
const skipped = [];

// ---- Basic concepts and roles, keyed as strings so they can live in sets and maps.
const cls = iri => `C ${iri}`;
const role = (iri, inverse = false) => `${inverse ? 'R-' : 'R+'} ${iri}`;
const exists = r => `E ${r}`;
const invert = r => (r.startsWith('R+') ? `R-${r.slice(2)}` : `R+${r.slice(2)}`);
const roleIri = r => r.slice(3);
const isInverse = r => r.startsWith('R-');

// Edges `sub -> super` of the subsumption graphs.
const roleEdges = new Map();
const conceptEdges = new Map();
function addEdge(edges, sub, sup) {
  if (!edges.has(sub)) {
    edges.set(sub, new Set());
  }
  edges.get(sub).add(sup);
}
function addRoleInclusion(sub, sup) {
  addEdge(roleEdges, sub, sup);
  addEdge(roleEdges, invert(sub), invert(sup));
}

const objectProperties = new Set(subjectsOfType(ql, `${OWL}ObjectProperty`).map(t => t.value));
const properties = new Set([ ...objectProperties, ...subjectsOfType(ql, `${OWL}DatatypeProperty`).map(t => t.value) ]);
const classes = new Set(subjectsOfType(ql, `${OWL}Class`).filter(t => t.termType === 'NamedNode').map(t => t.value));

for (const p of properties) {
  const node = oxigraph.namedNode(p);
  for (const sup of objects(ql, node, `${RDFS}subPropertyOf`)) {
    addRoleInclusion(role(p), role(sup.value));
  }
  for (const inv of objects(ql, node, `${OWL}inverseOf`)) {
    addRoleInclusion(role(p), role(inv.value, true));
    addRoleInclusion(role(inv.value, true), role(p));
  }
  for (const domain of objects(ql, node, `${RDFS}domain`)) {
    if (domain.termType === 'NamedNode') {
      addEdge(conceptEdges, exists(role(p)), cls(domain.value));
    }
  }
  if (objectProperties.has(p)) {
    for (const range of objects(ql, node, `${RDFS}range`)) {
      if (range.termType === 'NamedNode') {
        addEdge(conceptEdges, exists(role(p, true)), cls(range.value));
      }
    }
  }
  if (objects(ql, node, `${RDF}type`).some(t => t.value === `${OWL}TransitiveProperty`)) {
    skipped.push(`transitivity of ${p.replace(UB, 'ub:')}`);
  }
}
for (const c of classes) {
  for (const sup of objects(ql, oxigraph.namedNode(c), `${RDFS}subClassOf`)) {
    if (sup.termType === 'NamedNode') {
      addEdge(conceptEdges, cls(c), cls(sup.value));
    } else {
      const onProperty = objects(ql, sup, `${OWL}onProperty`)[0]?.value;
      const filler = objects(ql, sup, `${OWL}someValuesFrom`)[0]?.value;
      skipped.push(`${c.replace(UB, 'ub:')} ⊑ ∃${onProperty?.replace(UB, 'ub:')}.${filler?.replace(UB, 'ub:')}`);
    }
  }
}

// ∃R ⊑ ∃S whenever R ⊑ S.
function closure(edges, start) {
  const seen = new Set([ start ]);
  const todo = [ start ];
  while (todo.length > 0) {
    for (const next of edges.get(todo.pop()) ?? []) {
      if (!seen.has(next)) {
        seen.add(next);
        todo.push(next);
      }
    }
  }
  return seen;
}
const allRoles = [ ...properties ].flatMap(p => [ role(p), role(p, true) ]);
for (const r of allRoles) {
  for (const sup of closure(roleEdges, r)) {
    if (sup !== r) {
      addEdge(conceptEdges, exists(r), exists(sup));
    }
  }
}

// ---- Which basic concepts entail each named class, which roles entail each property.
const basicConcepts = [ ...[ ...classes ].map(cls), ...allRoles.map(exists) ];
function entailing(target) {
  return basicConcepts.filter(b => closure(conceptEdges, b).has(target));
}
function subRoles(r) {
  return allRoles.filter(sub => closure(roleEdges, sub).has(r));
}

/** A body pattern stating that `?x` belongs to basic concept `b`, with `fresh` naming any new variable. */
function member(b, x, fresh) {
  if (b.startsWith('C ')) {
    return [ `${x} a <${b.slice(2)}> .` ];
  }
  const r = b.slice(2);
  return [ triple(x, r, fresh()) ];
}
function triple(x, r, y) {
  return isInverse(r) ? `${y} <${roleIri(r)}> ${x} .` : `${x} <${roleIri(r)}> ${y} .`;
}
function freshVariables() {
  let n = 0;
  return () => `?v${n++}`;
}

const views = new Map();
function addView(head, body) {
  const key = `${head}\n${[ ...body ].sort().join('\n')}`;
  views.set(key, `CONSTRUCT { ${head} }\nWHERE {\n  ${body.join('\n  ')}\n}`);
}

addView('?s ?p ?o .', [ '?s ?p ?o .' ]);
for (const c of classes) {
  for (const b of entailing(cls(c))) {
    if (b !== cls(c)) {
      addView(`?x a <${c}> .`, member(b, '?x', freshVariables()));
    }
  }
}
for (const p of properties) {
  for (const r of subRoles(role(p))) {
    if (r !== role(p)) {
      addView(`?x <${p}> ?y .`, [ triple('?x', r, '?y') ]);
    }
  }
}

// ---- Defined classes: `A ⊓ ∃P.C ⊑ D` from the full ontology.
const defined = [];
for (const c of full.match(null, oxigraph.namedNode(`${OWL}intersectionOf`), null, null)) {
  const members = list(full, c.object);
  const named = members.filter(m => m.termType === 'NamedNode').map(m => m.value);
  const restriction = members.find(m => m.termType === 'BlankNode');
  const onProperty = objects(full, restriction, `${OWL}onProperty`)[0].value;
  const filler = objects(full, restriction, `${OWL}someValuesFrom`)[0].value;
  defined.push({ defines: c.subject.value, named, onProperty, filler });
}
// The body is sound only if its conjunct classes are themselves fully derived from asserted data, which
// fails if a defined class could be the only way to reach one of them. Check rather than assume.
const definedClasses = new Set(defined.map(d => cls(d.defines)));
for (const d of defined) {
  for (const conjunct of [ ...d.named, d.filler ]) {
    const reachedThroughDefinitions = [ ...definedClasses ]
      .filter(dc => dc !== cls(conjunct) && closure(conceptEdges, dc).has(cls(conjunct)));
    const selfSufficient = reachedThroughDefinitions.every(dc => defined
      .find(x => cls(x.defines) === dc).named.includes(conjunct));
    if (!selfSufficient) {
      process.stderr.write(`warning: ${conjunct} in the definition of ${d.defines} is also reached through ${reachedThroughDefinitions.join(', ')}\n`);
    }
  }
}
for (const d of defined) {
  const supers = [ ...closure(conceptEdges, cls(d.defines)) ].filter(s => s.startsWith('C ')).map(s => s.slice(2));
  for (const r of subRoles(role(d.onProperty))) {
    const implied = closure(conceptEdges, exists(r));
    const impliedOfFiller = closure(conceptEdges, exists(invert(r)));
    const fillerOptions = impliedOfFiller.has(cls(d.filler)) ? [ null ] : entailing(cls(d.filler));
    const namedOptions = d.named.map(a => (implied.has(cls(a)) ? [ null ] : entailing(cls(a))));
    for (const fillerOption of fillerOptions) {
      for (const namedCombination of cartesian(namedOptions)) {
        const fresh = freshVariables();
        const body = [ triple('?x', r, '?y') ];
        if (fillerOption) {
          body.push(...member(fillerOption, '?y', fresh));
        }
        for (const option of namedCombination) {
          if (option) {
            body.push(...member(option, '?x', fresh));
          }
        }
        for (const s of supers) {
          addView(`?x a <${s}> .`, body);
        }
      }
    }
  }
}
function cartesian(lists) {
  return lists.reduce((acc, options) => acc.flatMap(prefix => options.map(o => [ ...prefix, o ])), [[]]);
}

const header = [
  '# Generated by compileOntology.mjs from univ-benchQL.owl and the class definitions of univ-bench.owl',
  '# (ontop/iswc2014-benchmark, Apache-2.0; swat.cse.lehigh.edu/onto/univ-bench.owl). Do not edit by hand.',
  `# ${views.size} views. Left out: ${skipped.length} axioms (see the README).`,
  ...skipped.map(s => `#   - ${s}`),
];
writeFileSync(outFile, `${header.join('\n')}\n\n${[ ...views.values() ].join(`\n${VIEW_SEPARATOR}\n`)}\n`);
process.stderr.write(`${views.size} views written to ${outFile}; ${skipped.length} axioms left out:\n  ${skipped.join('\n  ')}\n`);
