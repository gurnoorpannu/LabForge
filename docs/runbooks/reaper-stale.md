# Runbook: ReaperStale

**Alert:** `time() - labforge_reaper_last_success_timestamp_seconds > 600` (or the metric is absent).

## Symptoms
- Expired labs linger past their TTL. The pods still die at expiry + 60s from
  `activeDeadlineSeconds` (the second cleanup layer), and the pool controller
  then frees those slots, so users are unaffected for a while; capacity is what suffers.

## Confirm
```bash
kubectl -n labforge get cronjob labforge-reaper            # SUSPEND should be False
kubectl -n labforge get jobs --sort-by=.metadata.creationTimestamp | tail -5
kubectl -n labforge logs job/$(kubectl -n labforge get jobs -o name --sort-by=.metadata.creationTimestamp | tail -1 | cut -d/ -f2)
kubectl get ns -l app.kubernetes.io/managed-by=labforge -o custom-columns=NS:.metadata.name,EXPIRES:.metadata.annotations.labforge\.io/expires-at
```
The heartbeat only counts a run where **every** deletion succeeded and Postgres was reachable.

## Likely causes and fixes
| Cause | How you tell | Fix |
|---|---|---|
| CronJob suspended | `SUSPEND True` | `kubectl -n labforge patch cronjob labforge-reaper -p '{"spec":{"suspend":false}}'` |
| Postgres unreachable | job log: `DB bookkeeping failed` | Namespaces are still deleted; fix Postgres and the heartbeat resumes |
| RBAC broken | job log: `forbidden` | `kubectl auth can-i delete namespaces --as=system:serviceaccount:labforge:labforge-reaper` |
| Image pull failure | job pods `ImagePullBackOff` | Check the tag in `values-prod.yaml` exists in GHCR |

## Prevention
Keep the two-layer design (reaper + `activeDeadlineSeconds`); never remove the deadline from the pod spec.
