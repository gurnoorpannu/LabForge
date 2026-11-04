# Local dev (Phase 1)

Hand-written example lab so each Kubernetes object is understood before the API generates it in code.

## Prerequisites

- Docker running
- [`k3d`](https://k3d.io) (`brew install k3d`)
- [`helm`](https://helm.sh) (`brew install helm`) — not needed until later phases
- `kubectl` (installed)

## Run it

```bash
make dev-up              # create k3d cluster (k3s + bundled Traefik), maps localhost:8080 -> :80
make lab-image           # build the Ubuntu+ttyd image for arm64
make lab-image-import    # load it into the cluster
make lab-example-up      # apply deploy/local/lab-example.yaml
```

Then open <http://localhost:8080/lab/demo0lab0one> — a real bash shell in the browser.

```bash
make lab-example-down    # remove the lab namespace
make dev-down            # delete the cluster
```

## Run the API (Phase 2)

The API runs on your Mac against the k3d cluster (your kubeconfig) and a Docker Postgres.

```bash
make dev-db                                       # Postgres 16 on :5432
cp services/api/.env.example services/api/.env    # DEV_FAKE_AUTH=true locally
make api-run                                      # http://localhost:3000

curl -s -XPOST localhost:3000/api/labs -H 'x-dev-user: alice'   # start a cold lab
curl -s localhost:3000/api/labs/me     -H 'x-dev-user: alice'   # current lab
curl -s -XDELETE localhost:3000/api/labs/me -H 'x-dev-user: alice'
make test-integration                             # create -> Ready -> reachable -> delete
```

`x-dev-user` is trusted only when `DEV_FAKE_AUTH=true`, and config refuses to start with it
when `NODE_ENV=production`. Google login replaces it in Phase 3.

`rbac.yaml` holds the API's ServiceAccount and least-privilege ClusterRole (used once the API
runs in-cluster, Phase 7). Inspect it with
`kubectl auth can-i --list --as=system:serviceaccount:labforge:labforge-api`.

## The objects (in `lab-example.yaml`)

| Object | Why it exists |
|---|---|
| **Namespace** | One per lab = the isolation boundary. Carries id/state/owner/expiry labels+annotations and the `pod-security.kubernetes.io/enforce: restricted` label. |
| **ResourceQuota** | Hard ceiling for the whole namespace so one lab can't starve the node. |
| **LimitRange** | Per-container default + max requests/limits. |
| **NetworkPolicy** | Default-deny ingress+egress; allow only Traefik→7681, DNS to kube-dns, and internet (minus pod/service/metadata CIDRs). |
| **Pod** | Ubuntu + ttyd. Non-root (UID 1000), `readOnlyRootFilesystem`, drop ALL caps, no privilege escalation, no SA token, seccomp RuntimeDefault, emptyDir at `/home/lab` + `/tmp`. |
| **Service** | ClusterIP → 7681. |
| **Ingress** | Traefik routes `/lab/<id>` to the Service, no prefix strip (ttyd owns the path via `-b`). |

The Traefik **ForwardAuth Middleware** (per-lab owner check) is added in Phase 3 — Phase 1 is open so the
terminal path can be proven first.

## Verification checklist (Phase 1)

```bash
# 1. terminal reachable in the browser
open http://localhost:8080/lab/demo0lab0one

# 2. pod was admitted under the `restricted` PSA (no warnings/errors on apply)
kubectl -n lab-demo0lab0one get pod lab -o jsonpath='{.status.phase}{"\n"}'

# 3. read-only root filesystem is enforced
kubectl -n lab-demo0lab0one exec lab -- sh -c 'touch /nope 2>&1 || echo "root FS is read-only (expected)"'
kubectl -n lab-demo0lab0one exec lab -- sh -c 'touch /home/lab/ok && touch /tmp/ok && echo "writable dirs OK"'

# 4. running as non-root
kubectl -n lab-demo0lab0one exec lab -- id
```
