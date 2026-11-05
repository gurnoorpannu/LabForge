#!/usr/bin/env bash
# Run the k6 load test against the chart on the current cluster.
#   tests/load/run.sh <users> [out.json]
# 1. waits for the warm pool to be full, 2. mints <users> sessions in the API pod,
# 3. runs k6 (official image, pinned), 4. ends every lab it started.
set -euo pipefail
USERS="${1:?usage: run.sh <users> [summary.json]}"
OUT="${2:-}"
NS="${LABFORGE_NAMESPACE:-labforge}"
K6_IMAGE="grafana/k6:2.3.0"
# Prod: LABFORGE_URL=https://labs.gurnoor.online. Local: k6 runs in a container,
# so it reaches the k3d ingress via host.docker.internal; cleanup runs on the host.
K6_URL="${LABFORGE_URL:-http://host.docker.internal:8080}"
HOST_URL="${LABFORGE_URL:-http://localhost:8080}"
POOL="${EXPECT_POOL:-3}"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

api_metric() {
  kubectl -n "$NS" exec deploy/labforge-api -- wget -qO- http://127.0.0.1:9090/metrics | grep "^$1" | awk '{print $2}'
}

echo "waiting for $POOL warm labs..."
for _ in $(seq 1 90); do
  [ "$(api_metric 'labforge_pool_ready{state="ready"}')" = "$POOL" ] && break
  sleep 2
done
echo "pool ready: $(api_metric 'labforge_pool_ready{state="ready"}')"

RUN="load-$(date +%s)"
echo "minting $USERS sessions..."
{
  echo "["
  for i in $(seq 1 "$USERS"); do
    c=$(kubectl -n "$NS" exec deploy/labforge-api -- node dist/mint-session.js "$RUN-u$i" | tail -1)
    printf '  "%s"%s\n' "$c" "$([ "$i" -lt "$USERS" ] && echo ,)"
  done
  echo "]"
} > "$WORK/cookies.json"

docker run --rm -v "$WORK":/work -v "$PWD/tests/load":/scripts:ro \
  -e COOKIES_FILE=/work/cookies.json -e LABFORGE_URL="$K6_URL" \
  "$K6_IMAGE" run --quiet --summary-export /work/summary.json --out json=/work/raw.json /scripts/start-labs.js

# OUT=path keeps the raw samples (one JSON object per line) for tests/load/summarize.py.
[ -n "$OUT" ] && cp "$WORK/raw.json" "$OUT"

echo "ending the labs this run started..."
python3 - "$WORK/cookies.json" "$HOST_URL" <<'PY'
import json, sys, urllib.request
for c in json.load(open(sys.argv[1])):
    req = urllib.request.Request(sys.argv[2] + "/api/labs/me", method="DELETE", headers={"cookie": c})
    try: urllib.request.urlopen(req, timeout=30)
    except Exception: pass
PY
