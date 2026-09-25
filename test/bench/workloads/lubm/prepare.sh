#!/usr/bin/env bash
# Builds the LUBM workload's data under data/ (about 700 MB):
#   lubm-u1.nt, lubm-u10.nt            the generated data of 1 and 10 universities, skolemised
#   lubm-u1.views.nt, lubm-u10.views.nt  the views materialised over it: the reference answers' graph
#   *.hdt                              HDT copies of all four, for Comunica
# and regenerates views.rq from the ontology. See ../common.sh for what it needs.
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
source "$HERE/../common.sh"
D=$HERE/data
mkdir -p "$D"
require_disk 2 "$D"
cd "$D"

# The OWL 2 QL ontology the views are compiled from (ontop/iswc2014-benchmark, Apache-2.0), and the original
# one, whose class definitions the QL version drops.
curl -sSfL -o univ-benchQL.owl https://raw.githubusercontent.com/ontop/iswc2014-benchmark/master/LUBM/univ-benchQL.owl
curl -sSfL -o univ-bench.owl https://swat.cse.lehigh.edu/onto/univ-bench.owl
node "$HERE/compileOntology.mjs" univ-benchQL.owl univ-bench.owl "$HERE/views.rq"

# UBA 1.7 with seed 0. Each university's data depends only on the seed and its index, so University0 is
# the same in both scales and LUBM-10 contains LUBM-1.
curl -sSfL -o uba1.7.zip https://swat.cse.lehigh.edu/projects/lubm/uba1.7.zip
rm -rf uba gen && unzip -q uba1.7.zip -d uba && mkdir gen
(cd gen && java -cp ../uba/classes edu.lehigh.swat.bench.uba.Generator -univ 10 -index 0 -seed 0 \
  -onto http://swat.cse.lehigh.edu/onto/univ-bench.owl > ../gen.log)
# UBA joins paths with a backslash, so on Linux its files land beside gen/ as `gen\University0_0.owl`.
for f in gen\\*.owl; do mv -- "$f" "gen/${f#gen\\}"; done

# One process per university: Oxigraph's RDF/XML parser slows down over many files in one process.
for u in $(seq 0 9); do
  node "$WORKLOADS_DIR/toNTriples.mjs" "raw-$u.nt" gen/University"${u}"_*.owl &
done
wait
cat raw-[0-9].nt > raw-u10.nt
mv raw-0.nt raw-u1.nt
rm raw-[1-9].nt
dedupe raw-u1.nt lubm-u1.nt
dedupe raw-u10.nt lubm-u10.nt

for scale in u1 u10; do
  materialize "$HERE/views.rq" "$D/lubm-$scale.nt" "$D/lubm-$scale.views.nt"
done
to_hdt lubm-u1.nt lubm-u1.views.nt lubm-u10.nt lubm-u10.views.nt
