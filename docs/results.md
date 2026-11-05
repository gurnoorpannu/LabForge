# Results (measured)

Every number here comes from a test that was actually run, with the command that produced it.
Nothing is estimated. **All runs so far are on a laptop k3d cluster**; the production (OCI)
runs are pending the cloud deploy (see [operations.md](operations.md) → "Prove it in production").

## Environment

| | |
|---|---|
| Machine | Apple M4, 10 cores, 16 GB RAM, macOS 26.5.2 |
| Docker Desktop | 29.9.2; VM: 10 vCPU, 7.7 GiB; 9 unrelated containers also running |
| Cluster | k3d 5.9.0 → k3s **v1.35.5+k3s1**, 1 server + 1 agent (both containers on the same VM) |
| Ingress | Traefik 3.6.13 (bundled with k3s) |
| LabForge | Helm chart, `values-local.yaml` + `lab.poolSize=3`, `lab.maxConcurrent=10` (prod defaults), 1 API replica, 2 pool-controller replicas |
| Lab pod | requests 250m / 256Mi, limits 500m / 512Mi; image `labforge-lab` (Ubuntu 24.04 + ttyd 1.7.4) |
| Date | 2026-11-05 |

## Lab start latency: warm vs cold (k6)

**Scenario A:** 10 users press *Start* at the same instant, against a full warm pool of 3.
Run 3 times (30 starts: 9 warm, 21 cold). **Scenario B:** 15 users at once against the cap of 10.

```bash
make load-test USERS=10 OUT=raw-A1.json    # x3: raw-A2.json, raw-A3.json
make load-test USERS=15 OUT=raw-B.json
python3 tests/load/summarize.py raw-A1.json raw-A2.json raw-A3.json
python3 tests/load/summarize.py raw-B.json
```

`tests/load/run.sh` waits for a full pool, mints one session per user inside the API pod,
runs k6 2.3.0 (official image), then ends every lab. Percentiles are pooled over all samples
(nearest rank), not averaged per run.

**Scenario A (3 runs × 10 users):**

| Measurement | n | p50 | p95 | max |
|---|---|---|---|---|
| Start lab, warm (POST /api/labs → 201) | 9 | 478.3 ms | 945.8 ms | 945.8 ms |
| Start lab, cold (POST → 201, pod Ready) | 21 | 2.39 s | 3.50 s | 4.01 s |
| **Click → terminal answers 200, warm** | 9 | **499.0 ms** | 1.01 s | 1.01 s |
| **Click → terminal answers 200, cold** | 21 | **2.85 s** | 4.84 s | 4.88 s |
| Authenticated request to own lab (Traefik + ForwardAuth + ttyd) | 600 | 1.3 ms | 48.5 ms | 166.4 ms |

`lab_created: 30`, `lab_rejected_capacity: 0`, other statuses: 0.

"Click → terminal answers 200" is the number a user feels: from sending *Start* until
`GET /lab/<id>/token` through Traefik returns 200 for their session (polled every 100 ms).

**Scenario B (15 users, cap 10):** 10 created (3 warm, 7 cold), **5 rejected with
`503` + `Retry-After: 60`** (5/5 k6 checks), 0 other errors.

| Measurement | n | p50 | p95 |
|---|---|---|---|
| Click → usable, warm | 3 | 596.0 ms | 608.0 ms |
| Click → usable, cold | 7 | 2.92 s | 2.92 s |

Caveats: small samples (n=9 warm); laptop with other workloads; both "nodes" share one VM,
so these are lower bounds on contention effects, not cloud numbers.

### Pre-creating warm routes (before/after)

The first measurement found warm labs returned in ~0.40 s but weren't usable until **1.94 s**:
the Ingress + auth Middleware were created at claim time, and Traefik applies new routing config
in batches. Warm labs now get their route when they are warmed (it admits nobody until claimed,
ADR-0009).

| Warm lab, click → usable | p50 |
|---|---|
| Route created at claim (1 run, n=3) | 1.94 s |
| Route pre-created (Scenario A above, n=9) | 499.0 ms |

## /auth/verify latency (server side, Prometheus)

`labforge_auth_verify_duration_seconds` over the Scenario A+B window (971 verify calls, all
`allowed`, since load-test users only open their own labs):

```bash
kubectl -n monitoring port-forward svc/kps-kube-prometheus-stack-prometheus 19090:9090 &
curl -s --get --data-urlencode \
  'query=histogram_quantile(0.95, sum by (le) (increase(labforge_auth_verify_duration_seconds_bucket[159s])))' \
  http://localhost:19090/api/v1/query
```

| p50 | p95 | p99 |
|---|---|---|
| 0.64 ms | 5.7 ms | 44.2 ms |

Caveat: Prometheus interpolates within histogram buckets (0.001, 0.0025, 0.005, 0.01, 0.025,
0.05 s ...), so these are approximations; the k6 table above is the primary source.

## Isolation (security suite)

`make test-security SECURITY_REPORT=docs/security-report.md`: **39 passed, 0 failed**,
full table in [security-report.md](security-report.md). Highlights: API server unreachable
(ClusterIP and node IP), kubelets, other labs, Traefik, CoreDNS metrics, cloud metadata and all
platform services blocked, each with a positive control; no capabilities, `no_new_privs`,
seccomp, no SA token, read-only root; fork bomb stopped at **1020** processes (pod limit 1024)
and the lab recovered; 700 Mi allocation OOM-killed only the offending process; 700 Mi disk
write evicted the pod.

Honesty note: the disk-eviction check timed out once (kubelet's volume-usage measurement is
periodic; a manual repeat evicted in 20 s). Its wait was raised from 3 to 5 minutes and every
run since has passed.

## Lifecycle and correctness

| Test | Result | Command |
|---|---|---|
| 20 parallel starts by one user | exactly 1 lab | `make test-integration` |
| 20 users racing for 3 remaining slots | exactly 3 succeed, 17 `capacity` | `make test-integration` |
| 20 parallel starts for 3 warm labs | exactly 3 warm, 17 cold, no lab assigned twice | `make test-integration` |
| Second active lab for a user, inserted directly in SQL | rejected by the partial unique index (23505) | `make test-integration` |
| `activeDeadlineSeconds` patched onto a *running* pod | accepted; kubelet killed it `Failed/DeadlineExceeded` ~20 s later | `make test-integration` (warm-claim) |
| Expiry with TTL 2 m | namespace gone within TTL + 1 min | `make test-e2e` |
| Expiry with the reaper suspended | pod `DeadlineExceeded`, then slot freed | `make test-e2e` |
| Access through Traefik | owner 200/101, anonymous 401, other user 403, forged cookie 401, `../` / `%2e%2e` / `%2f` / spoofed `X-Forwarded-Uri` never 200 | `make test-integration`, `make test-e2e` |

## Alerting (PoolEmpty, end to end)

Pool set to 0 with `helm upgrade ... --set lab.poolSize=0`; Alertmanager's Discord receiver
pointed at `tests/monitoring/webhook-sink.yaml` (a logging stand-in for Discord):

| Event | Time (UTC) |
|---|---|
| Pool drained | 17:43:22 |
| PoolEmpty pending | 17:44:04 |
| PoolEmpty firing (after `for: 5m`) | 17:48:38 |
| Discord-format webhook POST received | 17:49:09 (`group_wait` 30 s) |

The payload was a Discord embed: `[FIRING:1] PoolEmpty ...` with the description and runbook
link. Delivery to a real Discord channel needs your webhook (operations.md).

## Supply chain

Trivy 0.76.2, `--severity CRITICAL --ignore-unfixed`: 0 findings on all four images in CI
(`images.yml`). Locally `labforge-api` had 0 CRITICAL/HIGH; `labforge-lab` had 2 HIGH in `apt`
(fixed upstream), removed by `apt-get upgrade` in the Dockerfile.

## Still to measure (production)

After the OCI deploy: the same k6 scenarios against `https://labs.gurnoor.online`
(`LABFORGE_URL=https://labs.gurnoor.online make load-test ...`), `make test-security` and
`E2E=1 LABFORGE_URL=https://labs.gurnoor.online npx vitest run tests/e2e` with the OCI kubeconfig.
Record them here next to the local numbers.
