# Runbook: NodeMemoryPressure

**Alert:** node memory used above 85% for 5 minutes.

## Symptoms
The kubelet will soon evict pods to protect the node. Labs (Burstable, no
priority) go first; users lose their lab.

## Confirm
```bash
kubectl top nodes
kubectl top pods -A --sort-by=memory | head -15
kubectl get events -A --field-selector reason=Evicted --sort-by=.lastTimestamp | tail
```

## Fix
1. If one lab is the hog: end it. `kubectl delete ns lab-<id>` (the pool controller fixes the DB row).
2. If it's the platform (Prometheus is the usual suspect): lower its retention or memory in
   `deploy/monitoring/kube-prometheus-stack-values.yaml`.
3. If labs in aggregate: lower `lab.maxConcurrent` or `lab.resources.limits.memory`.

## Prevention
Per-lab memory limits (512Mi) and `singleProcessOOMKill` keep one lab's runaway
process from taking more; the cap is what keeps the *sum* in check.
