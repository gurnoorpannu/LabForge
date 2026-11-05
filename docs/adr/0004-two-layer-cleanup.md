# ADR-0004: Two independent cleanup layers (reaper + activeDeadlineSeconds)

**Status:** accepted

## Context
"The lab is destroyed after its TTL" is a security and cost property, so it must not
depend on one component being healthy.

## Decision
1. **Reaper** (CronJob, every minute) deletes namespaces whose `labforge.io/expires-at`
   annotation has passed. It reads the annotation from the cluster, so it works while
   Postgres is down.
2. **`activeDeadlineSeconds`** on the lab pod: expiry + 60 s grace, counted from the pod's
   start (so warm pods claimed hours after starting get their age added). The kubelet kills
   the pod with no LabForge component involved. The pool controller then frees the slot.

## Consequences
- Verified on k3d: with the reaper suspended, the pod ended `Failed/DeadlineExceeded` at
  expiry + grace and the namespace was removed (`make test-e2e`).
- The 60 s grace means the reaper normally wins; the deadline is the backstop.
- `activeDeadlineSeconds` can be set or lowered on a running pod but not raised, so a
  "extend my lab" feature would need a new pod. Accepted: not a requirement.
