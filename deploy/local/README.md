# Local dev (Phases 1–2)

Hand-written example lab so each Kubernetes object is understood before the API generates it in code,
plus the API running on your Mac against a local k3d cluster.

## Prerequisites

- Docker running
- [`k3d`](https://k3d.io) (`brew install k3d`)
- [`helm`](https://helm.sh) (`brew install helm`): not needed until later phases
- `kubectl`

## Run the example lab (Phase 1)

```bash
make dev-up              # k3d cluster (k3s + bundled Traefik), node subnet 172.28.0.0/16, localhost:8080 -> :80
make lab-image           # build the Ubuntu+ttyd image for arm64
make lab-image-import    # load it into the cluster
make lab-example-up      # apply deploy/local/lab-example.yaml
```

Then open <http://localhost:8080/lab/demo0lab0one>: a real bash shell in the browser.

```bash
make lab-example-down    # remove the lab namespace
make dev-down            # delete the cluster
```

## Run the API (Phase 2)

The API runs on your Mac against the k3d cluster (your kubeconfig) and a Docker Postgres.

```bash
make dev-db                                       # Postgres 16 on :5432 (or DB_PORT=5433, see below)
cp services/api/.env.example services/api/.env    # DEV_FAKE_AUTH=true locally
make api-run                                      # http://localhost:3000

curl -s -XPOST localhost:3000/api/labs -H 'x-dev-user: alice'   # start a cold lab
curl -s localhost:3000/api/labs/me     -H 'x-dev-user: alice'   # current lab
curl -s -XDELETE localhost:3000/api/labs/me -H 'x-dev-user: alice'
make test-integration                             # real k3d + Postgres tests
```

`x-dev-user` is trusted only when `DEV_FAKE_AUTH=true`, and config refuses to start with it
when `NODE_ENV=production`. Google login replaces it in Phase 3.

`rbac.yaml` holds the API's ServiceAccount and least-privilege ClusterRole (used once the API
runs in-cluster, Phase 7). `make rbac` applies it; check it with
`kubectl auth can-i create pods --subresource=exec -n lab-x --as=system:serviceaccount:labforge:labforge-api`
(use `--subresource=`, since `pods/exec` is parsed as a pod *named* `exec`).

## The objects (in `lab-example.yaml`)

| Object | Why it exists |
|---|---|
| **Namespace** | One per lab = the isolation boundary. Carries id/state/owner/expiry labels+annotations and the `pod-security.kubernetes.io/enforce: restricted` label. |
| **ResourceQuota** | Hard ceiling for the whole namespace so one lab can't starve the node. |
| **LimitRange** | Per-container default + max requests/limits. |
| **NetworkPolicy** | Default-deny ingress+egress; allow only Traefik→7681, DNS to kube-dns, and internet minus pod/service/**node**/metadata CIDRs. |
| **Pod** | Ubuntu + ttyd. Non-root (UID 1000), `readOnlyRootFilesystem`, drop ALL caps, no privilege escalation, no SA token, seccomp RuntimeDefault, emptyDir at `/home/lab` + `/tmp`, expiry via downward API, `ping_group_range` sysctl. |
| **Service** | ClusterIP → 7681. |
| **Ingress** | Traefik routes `/lab/<id>` to the Service, no prefix strip (ttyd owns the path via `-b`). |

The Traefik **ForwardAuth Middleware** (per-lab owner check) is added in Phase 3. Until then labs are open,
so the terminal path can be proven first.

### Why the node CIDR must be blocked

A lab connecting to the API server's ClusterIP `10.43.0.1:443` is rewritten by kube-proxy to the server
node's real address (`172.28.0.3:6443`) **before** NetworkPolicy is evaluated. Excluding only the
service CIDR therefore leaves the API server reachable; this was observed on the first k3d run
(`curl https://10.43.0.1` → 401). That is why `NODE_CIDR` is required config with no default, and why
`make dev-up` pins the k3d subnet so the value is known.

## Verified on k3d (2026-11-04, k3s v1.35.5+k3s1, Traefik 3.6.13, ttyd 1.7.4)

| Check | Result |
|---|---|
| Terminal over Traefik: page / websocket upgrade | `200` / `101 Switching Protocols` |
| Pod admitted under `restricted`; privileged pod in lab ns | admitted / **rejected** |
| `id` inside lab | `uid=1000(lab)`, no sudo, `su` fails |
| Write `/`, `/etc` / write `/home/lab`, `/tmp` | read-only / OK |
| `CapEff`, `NoNewPrivs`, SA token | `0000000000000000`, `1`, not mounted |
| DNS, HTTPS to internet, `ping 1.1.1.1` | OK |
| K8s API `10.43.0.1`, node `:6443`, kubelet `:10250`, `169.254.169.254` | blocked |
| `make test-integration`: create → Ready → reachable → delete; 20-way reservation races | 4/4 pass |

Commands for the in-pod rows:

```bash
NS=lab-demo0lab0one
kubectl -n $NS exec lab -- id
kubectl -n $NS exec lab -- sh -c 'touch /nope; touch /home/lab/ok /tmp/ok && echo writable-ok'
kubectl -n $NS exec lab -- sh -c 'grep -E "CapEff|NoNewPrivs" /proc/self/status'
kubectl -n $NS exec lab -- sh -c 'curl -sk -m4 https://10.43.0.1 || echo blocked'
kubectl -n $NS exec lab -- ping -c1 1.1.1.1
```

Phase 4 turns these into an automated pass/fail suite.

## Troubleshooting

- **Port 5432 already in use** (another Postgres): `make dev-db DB_PORT=5433`, set the same port in
  `DATABASE_URL` in `services/api/.env`, and run `make test-integration DB_PORT=5433`.
- **k3d server container restart-loops** (`kubectl` returns `ServiceUnavailable`;
  `docker logs k3d-labforge-server-0` shows `cloud-controller-manager exited ... forbidden`): a k3s
  startup race where the cloud controller starts before its RBAC exists. Seen once out of three
  creates. `make dev-down && make dev-up` fixes it.
