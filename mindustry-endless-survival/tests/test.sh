#!/bin/bash

set -euo pipefail
export PATH=/usr/local/bin:/usr/bin:/bin
until [ -f /logs/sim/result.json ] || [ -f /logs/sim/failure.json ]; do sleep 5; done
SIM=/logs/sim
OUT=/logs/verifier
MINDUSTRY_SURVIVAL_SEATS=$(find /logs/seats -mindepth 1 -maxdepth 1 -type d -name 'seat-*' | wc -l | tr -d ' ')
export MINDUSTRY_SURVIVAL_SEATS
mkdir -p "$OUT"
if ! node /app/sim/metrics.mjs "$SIM" "$OUT/metrics.json" 2>"$OUT/metrics-error.log"; then
  node -e 'require("node:fs").writeFileSync(process.argv[1], JSON.stringify({schema:"mindustry-deterministic/1",status:"invalid",reason:"Diagnostic reduction failed; see metrics-error.log"}) + "\n")' "$OUT/metrics.json"
fi
cp "$OUT/metrics.json" /logs/sim/metrics.json
status=0
node /app/sim/verify.mjs "$SIM" "$OUT/reward.json" || status=$?
if [ -f "$SIM/survival-outcome.json" ]; then cp "$SIM/survival-outcome.json" "$OUT/survival-outcome.json"; fi
[ "$status" -eq 0 ] || exit "$status"
