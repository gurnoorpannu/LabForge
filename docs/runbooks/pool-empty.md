# Runbook: PoolEmpty

**Alert:** `max(labforge_pool_ready{state="ready"}) == 0` for 5 minutes.

## Symptoms
- Every lab start is a cold start (seconds instead of sub-second).
- Dashboard: "Warm labs ready" is 0; "Pool level" shows no `ready` line.

## Confirm
```bash
kubectl -n labforge get pods -l app.kubernetes.io/component=pool-controller
kubectl -n labforge logs -l app.kubernetes.io/component=pool-controller --tail=50 | grep -E "leadership|error|reconciled"
kubectl get ns -l app.kubernetes.io/managed-by=labforge -L labforge.io/state
kubectl -n labforge exec deploy/labforge-api -- wget -qO- 127.0.0.1:9090/metrics | grep -E "labforge_(pool_ready|labs_active)"
```

## Likely causes and fixes
| Cause | How you tell | Fix |
|---|---|---|
| Cluster at the cap | `labs_active` ≈ `MAX_CONCURRENT_LABS` | Expected under load. Raise `lab.maxConcurrent` only if nodes have room. |
| Pool controller down or no leader | No pod Running, or no "acquired leadership" in logs | `kubectl -n labforge rollout restart deploy/labforge-pool-controller` |
| Warm pods never get Ready | Namespaces stuck in `warming`; see [labs-stuck-pending](labs-stuck-pending.md) | Fix the scheduling / image problem |
| Postgres down | Controller logs `ECONNREFUSED` | See Postgres in [failure-modes](../failure-modes.md) |
| `poolSize` is 0 | `helm get values labforge -n labforge` | Intended? Otherwise set `lab.poolSize`. |

## Prevention
Keep `maxConcurrent` comfortably above `poolSize` plus typical concurrent users; watch the "Rejected" panel.
