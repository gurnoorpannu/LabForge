# ADR-0006: Postgres is the source of truth for lab assignment

**Status:** accepted

## Context
"Which user owns which lab" could live in Kubernetes (namespace annotations) or in a database.

## Decision
Postgres. The `labs` table decides assignment; namespace annotations mirror it for the
reaper and the MOTD.

## Why
- **Atomic claims:** `UPDATE ... WHERE id = (SELECT ... FOR UPDATE SKIP LOCKED LIMIT 1)` hands a
  warm lab to exactly one user. Kubernetes has no multi-object transactions; doing this with
  annotations means optimistic-concurrency retries on resourceVersion.
- **Invariants in the schema:** a partial unique index enforces one active lab per user even
  if application code has a bug; the global cap is checked under a transaction lock.
  Tested: 20 parallel starts for 3 warm labs -> exactly 3 warm, none assigned twice.
- **Sessions and audit log** need a database anyway.

## Consequences
Two sources must agree; the pool controller reconciles drift both ways (rows without a
namespace, namespaces without a row). Postgres is a single instance (see failure-modes.md).
