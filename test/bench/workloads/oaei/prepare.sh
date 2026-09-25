#!/usr/bin/env bash
# Builds the OAEI Populated Conference workload's data under data/ (about 350 MB):
#   oaei-100.nt, oaei-eswc.nt          cmt + confOf + conference + edas data, merged and skolemised,
#                                      from data_100 (every instance shared) and eswc (real ESWC 2018 data)
#   oaei-*.views.nt                    the ekaw views materialised over it: the reference answers' graph
#   *.hdt                              HDT copies of all four, for Comunica
# and regenerates views.rq and queries/. Downloads single files rather than cloning the 1.1 GB repository.
# See ../common.sh for what it needs.
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
source "$HERE/../common.sh"
D=$HERE/data
mkdir -p "$D"
require_disk 1 "$D"
cd "$D"

PROJECT=IRIT_UT2J%2Fconference-dataset-population
RAW=https://framagit.org/IRIT_UT2J/conference-dataset-population/-/raw/master
SOURCES=(cmt confOf conference edas)

mkdir -p construct src-100 src-eswc
for source in "${SOURCES[@]}"; do
  curl -sSf -o "construct/$source-ekaw.sparql" "$RAW/alignments/construct/$source-ekaw.sparql"
  curl -sSf -o "src-100/${source}_100.ttl" "$RAW/populated_datasets/data_100/${source}_100.ttl"
  curl -sSf -o "src-eswc/${source}_eswc.ttl" "$RAW/populated_datasets/eswc/${source}_eswc.ttl"
done
node "$HERE/collectViews.mjs" "$HERE/views.rq" construct/{cmt,confOf,conference,edas}-ekaw.sparql

# The ekaw version of every competency question, one file per question.
rm -rf "$HERE/queries" && mkdir "$HERE/queries"
for page in 1 2 3 4; do
  curl -sSf "https://framagit.org/api/v4/projects/$PROJECT/repository/tree?path=CQAs&recursive=true&per_page=100&page=$page"
done | grep -oE '"path":"[^"]+/ekaw.sparql"' | sed 's/"path":"//;s/"$//' | while read -r path; do
  curl -sSf -o "$HERE/queries/$(basename "$(dirname "$path")").rq" "$RAW/$path"
done

for scale in 100 eswc; do
  node "$WORKLOADS_DIR/toNTriples.mjs" "raw-$scale.nt" "src-$scale"/*.ttl
  dedupe "raw-$scale.nt" "oaei-$scale.nt"
  materialize "$HERE/views.rq" "$D/oaei-$scale.nt" "$D/oaei-$scale.views.nt"
done
to_hdt oaei-100.nt oaei-100.views.nt oaei-eswc.nt oaei-eswc.views.nt
