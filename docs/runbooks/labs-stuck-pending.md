# Runbook: LabsStuckPending

**Alert:** a pod in a `lab-*` namespace has been `Pending` for over 2 minutes.

## Confirm
```bash
kubectl get pods -A -l app.kubernetes.io/managed-by=labforge --field-selector=status.phase=Pending
kubectl -n <lab-namespace> describe pod lab | tail -20     # the Events section says why
kubectl describe nodes | grep -A8 "Allocated resources"
```

## Likely causes and fixes
| Event message | Cause | Fix |
|---|---|---|
| `Insufficient cpu` / `Insufficient memory` | Nodes full by requests | Lower `lab.maxConcurrent` so the cap matches capacity, or add a node |
| `ErrImagePull` / `ImagePullBackOff` | Lab image tag missing or GHCR down | Check `LAB_IMAGE` in `kubectl -n labforge get cm labforge-config -o yaml`; make the package public in GHCR |
| `exceeded quota` | Quota smaller than the pod's requests | `lab.resources` and the quota come from the same values: re-render the chart |
| `violates PodSecurity` | A pod spec change broke `restricted` | Revert; `make test-security` catches this |

## Prevention
`maxConcurrent` should satisfy `maxConcurrent × lab CPU request ≤ allocatable CPU` across nodes.
