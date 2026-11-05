# ADR-0002: One namespace per lab, not one pod per lab in a shared namespace

**Status:** accepted

## Context
A lab is one pod, so the obvious design is "all lab pods in one `labs` namespace".
But a lab also needs a quota, a network policy, a Pod Security level, an Ingress,
and an auth Middleware, all scoped to that one user.

## Decision
Each lab gets its own namespace `lab-<id>` holding all of its objects.

## Consequences
- **Isolation by default:** ResourceQuota, LimitRange, the default-deny NetworkPolicy
  and the `restricted` PSA label are per-namespace primitives; they apply to exactly one lab.
- **One-shot cleanup:** deleting the namespace garbage-collects the pod, Service, Ingress,
  Middleware and policies. Nothing can be leaked by a half-finished cleanup.
- **ForwardAuth stays simple:** the Middleware lives next to its Ingress (no cross-namespace
  references, which Traefik disables by default), with the lab id baked in (ADR-0001).
- Cost: namespace creation/deletion is slower than a pod (deletion waits on finalizers,
  ~20 s locally), and there are more objects in etcd. At tens of labs this is irrelevant;
  the warm pool hides creation time from users.
