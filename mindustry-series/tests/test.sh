#!/bin/bash

set -euo pipefail

PATH=/usr/local/bin:/usr/bin:/bin node /app/sim/verify.mjs /logs/sim /logs/verifier/reward.json
