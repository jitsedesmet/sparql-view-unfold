#!/bin/bash
# Full BKR-star conversion pipeline:
#   1. Skolemize BKR-star.ttl -> BKR-star-skolem.ttl (RDF 1.2, no blank nodes)
#   2. Map the skolemized dataset to reification / singleton / wikidata patterns
set -euo pipefail
cd "$(dirname "$0")"
echo "[$(date)] STEP 1: skolemize"
npx tsx skolemize.ts BKR-star.ttl BKR-star-skolem.ttl
echo "[$(date)] STEP 2: map reification patterns"
npx tsx mapBkrStar.ts
echo "[$(date)] DONE"
