# Runbook: HighLabStartLatency

**Alert:** p95 of warm lab starts above 5 seconds for 10 minutes.

A warm start is a few DB queries plus four Kubernetes API calls (patch namespace,
read + patch pod, create Middleware + Ingress), so it should be well under a second.

## Confirm
```bash
kubectl -n labforge exec deploy/labforge-api -- wget -qO- 127.0.0.1:9090/metrics | grep labforge_lab_start_duration_seconds
kubectl -n labforge logs deploy/labforge-api --tail=200 | grep -E '"responseTime":[0-9]{4,}'
kubectl get --raw /readyz?verbose | tail -3      # API server health
```

## Likely causes and fixes
| Cause | Fix |
|---|---|
| Pool empty, so starts are actually cold | See [pool-empty](pool-empty.md) |
| Kubernetes API slow (server node overloaded) | Check `kubectl top nodes`; the k3s server also runs the datastore |
| Postgres slow | `kubectl -n labforge top pod labforge-postgres-0`; check for long transactions |

## Prevention
Keep the warm pool sized for peak arrivals; `make load-test` shows the warm/cold split.
