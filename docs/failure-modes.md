# Failure modes

What happens when each part fails, why that's acceptable (or what limits it), and how you find
out. Alerts link to runbooks in [runbooks/](runbooks/).

| Failure | What happens | Why acceptable / mitigation | Detected by |
|---|---|---|---|
| **API pod crashes** | New starts and logins fail. **Open terminals keep working until the next ForwardAuth call** (each HTTP request and websocket upgrade); established websockets stay up. | 2 replicas + PDB in prod; Kubernetes restarts it in seconds. | Readiness/liveness probes; Traefik 502s; `up{job="labforge-api"}` |
| **All API replicas down** | No starts; every *new* request to a lab gets an error from ForwardAuth (fails closed). Existing websockets continue. | Fail-closed is the right default for auth. | as above |
| **Reaper fails / suspended** | Expired labs aren't deleted on time. Pods still die at expiry + 60 s (`activeDeadlineSeconds`), then the pool controller frees the slot. | Two independent layers (ADR-0004); verified with the reaper suspended. | **ReaperStale** (heartbeat > 10 min) |
| **Pool controller down** | No new warm labs; starts fall back to cold (~2.4 s instead of ~0.5 s). Drift isn't repaired. | Standby replica takes the advisory lock within ~5 s (ADR-0007). | **PoolEmpty**; `labforge_pool_controller_leader` |
| **Node loss / reboot** | Lab pods on it end (bare pods, `restartPolicy: Never`): those users lose their session and its files. The pool controller frees their slots and replaces dead warm labs. | Labs are disposable by design (wiped at expiry anyway). The server node also hosts the control plane: see below. | Node `NotReady`; pods `Failed`; pool refills |
| **k3s server node loss** | Control plane gone: nothing new starts, no cleanup. Running labs on the agent keep running (and their deadlines still fire). | Single server is the free-tier trade-off (ADR-0008). HA = 3 servers with embedded etcd. | kubectl/ArgoCD unreachable; Prometheus down with it (it runs in-cluster) |
| **Lab image pull fails** | Cold starts and new warm labs stick in `Pending`/`ImagePullBackOff`; the API times out (`ready: false`) and the pool controller retires warming labs after 5 min. | Warm labs already running keep serving starts. | **LabsStuckPending**; PoolEmpty |
| **Cluster at capacity** | `POST /api/labs` → `503` + `Retry-After: 60`; the UI says when to retry. Nothing is scheduled beyond the cap. | Cap is enforced in Postgres under a lock, so it can't be overshot by races (tested). | Dashboard "Rejected"; `labforge_lab_requests_total{result="rejected_capacity"}` |
| **Postgres down** | Logins, starts, `/auth/verify` fail: **all lab traffic is refused (fail closed)**. API readiness fails. The reaper still deletes expired namespaces (annotation-driven) but can't record it; the pool controller exits (loses its lock connection) and restarts until Postgres is back. | Single instance, local-path PVC. Restart is quick; data loss would mean losing assignments, sessions, audit log (labs themselves are disposable). HA = managed Postgres or an operator with replicas + backups. | API `/readyz` 503; ReaperStale; PoolEmpty |
| **Postgres node lost permanently** | local-path PVC lost with the node: sessions and lab rows gone; everyone logs in again. The pool controller deletes the now-orphaned lab namespaces. | Accepted for a free-tier portfolio deployment; nightly `pg_dump` to Object Storage is the cheap upgrade. | as above |
| **Cert renewal fails** | cert-manager renews ~30 days before expiry; if it keeps failing, browsers reject the site when the cert expires. | 30-day buffer; staging issuer for safe retries. | cert-manager `Certificate` `Ready=False`; Let's Encrypt expiry emails (ACME email) |
| **Google OIDC outage** | New logins fail (`login_failed`); existing sessions keep working (sessions are ours, not Google's). | Sessions last 12 h. | API logs; login errors |
| **Traefik down** | Nothing reachable (UI, API, labs). | k3s restarts it; it's a Deployment. | External uptime check (not in-cluster) |
| **A lab misbehaves** (fork bomb, memory or disk hog) | PID limit stops a fork bomb at 1024 processes; memory overrun kills only that process (`singleProcessOOMKill`); disk over 512 Mi evicts that lab. Other labs unaffected. | Per-pod limits, all verified by `make test-security`. | NodeMemoryPressure; eviction events |
| **A lab tries to escape the network** | Can't reach the K8s API, kubelets, nodes, other labs, platform services or cloud metadata. | Default-deny NetworkPolicy + node-CIDR exclusion + platform ingress policy; verified with positive controls. | `make test-security` (CI-able) |
| **GitOps bad deploy** | ArgoCD syncs whatever main says; a broken image rolls out (maxUnavailable 0 keeps the old API pod until the new one is ready). | Revert the commit; ArgoCD self-heals back. CI gates: tests, Trivy. | ArgoCD health; readiness |

## Things that are deliberately *not* handled

- **Lab abuse of the internet** (scanning, spam). Egress is open except internal ranges. Mitigations
  if needed: disable egress (`lab.internetEgress=false`), or allow-list ports.
- **Persistent labs.** By design, nothing survives expiry or a pod restart.
