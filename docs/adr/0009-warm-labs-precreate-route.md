# ADR-0009: Warm labs get their route when warmed, not when claimed

**Status:** accepted (Phase 9) · **Deviates from:** SPEC §6.4 ("after claiming ... create the Ingress + Middleware")

## Context
Load testing measured warm starts returning 201 in ~0.40 s but the terminal answering only at
**1.94 s**. The Ingress and ForwardAuth Middleware were created at claim time, and Traefik
applies Kubernetes config changes in batches (provider throttling), so a brand-new route takes
a second or two to start serving.

## Decision
The pool controller creates a warm lab's Middleware + Ingress together with its pod. Claiming
only patches ownership/expiry onto the namespace and pod (plus an idempotent create of the
route, for warm labs made before this change).

## Why it's safe
`/auth/verify` admits a session only if it **owns** the lab, the lab is `claimed`, not deleted and
not expired. An unclaimed warm lab has no owner, so its live route answers 401 (no session) or
403 (any session) to everyone. Tested at both levels: unit test, and through real Traefik in
`make test-e2e` (page and websocket).

## Consequences
- Measured: warm click-to-usable p50 **1.94 s → 499 ms** (docs/results.md).
- A claim no longer changes Traefik config, so warm-start latency doesn't depend on Traefik's
  reload timing at all.
- The pool controller's ClusterRole gains `create` on ingresses and middlewares.
- More routes exist in Traefik (one per warm lab); at pool sizes of a few labs, negligible.
