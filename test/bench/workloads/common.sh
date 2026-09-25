#!/usr/bin/env bash
# Shared steps of the workloads' prepare.sh scripts. Sourced, not run.
#
# Needs: node, java 21+ (for Fuseki), JENA_FUSEKI_JAR (the 6.3.0 build the benchmark runs, see
# test/bench/README.md) and rdf2hdt from hdt-cpp on PATH, or RDF2HDT pointing at it.

WORKLOADS_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
REPO_ROOT=$(cd "$WORKLOADS_DIR/../../.." && pwd)
RDF2HDT=${RDF2HDT:-rdf2hdt}

# Stops unless at least $1 GB would still be free on the disk holding $2 afterwards.
require_disk() {
  local need_gb=$1 dir=$2 free_gb
  free_gb=$(df -BG --output=avail "$dir" | tail -1 | tr -dc '0-9')
  if (( free_gb < need_gb + 20 )); then
    echo "Only ${free_gb}G free on $(df --output=target "$dir" | tail -1); need ${need_gb}G plus 20G headroom." >&2
    echo "Free space first, for instance by deleting another workload's data/ directory." >&2
    exit 1
  fi
}

# Deduplicates N-Triples into their final file: a graph is a set.
dedupe() {
  LC_ALL=C sort -u "$1" > "$2"
  rm "$1"
}

# Runs every view of $1 over $2 with Jena, cross-checked against Oxigraph, into $3.
materialize() {
  : "${JENA_FUSEKI_JAR:?set JENA_FUSEKI_JAR to fuseki-server.jar}"
  (cd "$REPO_ROOT" && npx tsx test/bench/materializeViews.ts "$1" "$2" "$3")
}

# Writes an HDT copy (<file>.hdt) of each N-Triples file, and has it indexed once by opening it, so no
# benchmark row pays for the index. The old index goes first: the HDT library reuses an index file it
# finds beside the HDT without checking that it belongs to it.
to_hdt() {
  for nt in "$@"; do
    local hdt=${nt%.nt}.hdt
    rm -f "$hdt" "$hdt.index.v1-1"
    "$RDF2HDT" -f ntriples -B "urn:bench:$(basename "${nt%.nt}")" "$nt" "$hdt" > /dev/null
    echo '{"query":"SELECT * WHERE { ?s ?p ?o } LIMIT 1","timeoutMs":600000}' |
      node "$REPO_ROOT/test/bench/comunicaWorker.mjs" "$hdt" | grep -q '"status":"ok"'
  done
}
