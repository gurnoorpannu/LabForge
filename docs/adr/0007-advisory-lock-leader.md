# ADR-0007: Leader election with a Postgres advisory lock

**Status:** accepted

## Context
The pool controller must run as one active instance (two would both top up the pool), but
should have a standby for fast failover.

## Decision
Two replicas. Each holds a dedicated Postgres connection and calls
`pg_try_advisory_lock(7003)` every pass; whoever gets it reconciles. The lock is tied to the
connection: if the leader dies or its connection drops, Postgres releases it and the standby
takes over on its next pass (~5 s). If the leader *loses* its connection it exits instead of
continuing without the lock.

## Alternatives
Kubernetes Lease objects (client-go style leader election) are the norm, but the controller
already depends on Postgres for every decision; a lock there adds no new dependency or RBAC,
and "leader can't reach Postgres" and "leader can't act" become the same failure.

## Consequences
Failover is bounded by the reconcile interval. `labforge_pool_controller_leader` shows which
replica leads (verified: exactly one reports 1).
