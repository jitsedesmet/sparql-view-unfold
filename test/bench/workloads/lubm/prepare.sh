#!/usr/bin/env bash
# Builds the LUBM workload's data under data/ (about 10 GB):
#   lubm-u{1,10,50,100}.nt             the generated data of 1, 10, 50 and 100 universities, skolemised
#   lubm-u*.views.nt                   the views materialised over it: the reference answers' graph
#   *.hdt                              HDT copies of all eight, for Comunica
# and regenerates views.rq from the ontology. See ../common.sh for what it needs.
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
source "$HERE/../common.sh"
D=$HERE/data
mkdir -p "$D"
require_disk 12 "$D"
cd "$D"

# The OWL 2 QL ontology the views are compiled from (ontop/iswc2014-benchmark, Apache-2.0), and the original
# one, whose class definitions the QL version drops.
curl -sSfL -o univ-benchQL.owl https://raw.githubusercontent.com/ontop/iswc2014-benchmark/master/LUBM/univ-benchQL.owl
curl -sSfL -o univ-bench.owl https://swat.cse.lehigh.edu/onto/univ-bench.owl
node "$HERE/compileOntology.mjs" univ-benchQL.owl univ-bench.owl "$HERE/views.rq"

# UBA 1.7 with seed 0. Each university's data depends only on the seed and its index, so every scale
# contains the smaller ones: LUBM-100 holds LUBM-50, which holds LUBM-10, which holds LUBM-1.
curl -sSfL -o uba1.7.zip https://swat.cse.lehigh.edu/projects/lubm/uba1.7.zip
rm -rf uba gen && unzip -q uba1.7.zip -d uba && mkdir gen
(cd gen && java -cp ../uba/classes edu.lehigh.swat.bench.uba.Generator -univ 100 -index 0 -seed 0 \
  -onto http://swat.cse.lehigh.edu/onto/univ-bench.owl > ../gen.log)
# UBA joins paths with a backslash, so on Linux its files land beside gen/ as `gen\University0_0.owl`.
for f in gen\\*.owl; do mv -- "$f" "gen/${f#gen\\}"; done

# One process per university, 16 at a time: Oxigraph's RDF/XML parser slows down over many files in one
# process.
rm -rf raw && mkdir raw
seq 0 99 | xargs -P 16 -I{} sh -c "node '$WORKLOADS_DIR/toNTriples.mjs' raw/raw-{}.nt gen/University{}_*.owl"
for n in 1 10 50 100; do
  seq 0 $((n - 1)) | sed 's#.*#raw/raw-&.nt#' | xargs cat > "raw-u$n.nt"
  dedupe "raw-u$n.nt" "lubm-u$n.nt"
done
rm -r raw

for scale in u1 u10 u50 u100; do
  materialize "$HERE/views.rq" "$D/lubm-$scale.nt" "$D/lubm-$scale.views.nt"
  to_hdt "lubm-$scale.nt" "lubm-$scale.views.nt"
done
