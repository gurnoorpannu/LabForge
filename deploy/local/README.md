# Local development

Two ways to run LabForge on a laptop:

| Mode | Command | Use it for |
|---|---|---|
| **Whole stack in k3d** (like prod) | `make up` | Normal use, `make test-e2e`, `make test-security`, `make load-test`, monitoring |
| **API on your Mac** against k3d + a Docker Postgres | `make api-run` | Fast edit-run loops on the API, `make test-integration` |

Don't run both against the same cluster at once: the chart's pool controller deletes lab namespaces
that have no row in *its* database (after a 2-minute grace), which includes labs made by a host-run
API and the hand-written demo lab below. For the second mode, first
`kubectl -n labforge scale deploy/labforge-pool-controller --replicas=0` (or `make chart-down`).

## Prerequisites

- Docker running
- [`k3d`](https://k3d.io), [`helm`](https://helm.sh), `kubectl` (`brew install k3d helm kubectl`)
- Node 22.19+ (24 LTS recommended)

## Whole stack (`make up`)

```bash
make up                    # k3d + 4 images (arm64) + chart with values-local.yaml
open http://localhost:8080
kubectl -n labforge exec deploy/labforge-api -- node dist/mint-session.js alice   # a session cookie
make chart-up              # re-deploy after changing values; images: make images images-import
```

Monitoring (optional, ~1.5 GB of images):

```bash
kubectl create namespace monitoring
kubectl -n monitoring create secret generic grafana-admin --from-literal=admin-user=admin --from-literal=admin-password=$(openssl rand -hex 16)
kubectl -n monitoring create secret generic alertmanager-discord \
  --from-literal=webhook-url=http://webhook-sink.monitoring.svc.cluster.local:8080/discord-webhook
kubectl apply -f tests/monitoring/webhook-sink.yaml        # logs alerts instead of posting to Discord
helm upgrade --install kps prometheus-community/kube-prometheus-stack --version 92.20.0 \
  -n monitoring -f deploy/monitoring/kube-prometheus-stack-values.yaml --wait --timeout 10m
kubectl apply -k deploy/monitoring/manifests
helm upgrade labforge deploy/helm/labforge -n labforge -f deploy/helm/labforge/values-local.yaml \
  --set monitoring.serviceMonitors=true
kubectl -n monitoring logs deploy/webhook-sink -f            # alerts arrive here
```

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

## Run the API (Phases 2–3)

The API runs on your Mac (`:3000`) against the k3d cluster (your kubeconfig) and a Docker Postgres.
Traefik inside k3d reaches it for ForwardAuth through `host.k3d.internal:3000`.

```bash
make dev-db                                       # Postgres 16 on :5432 (or DB_PORT=5433, see below)
cp services/api/.env.example services/api/.env    # then set SESSION_SECRET=$(openssl rand -hex 32)
make api-run                                      # UI at http://localhost:3000
```

Without a Google client, mint a session instead of logging in (also what tests and k6 use):

```bash
COOKIE=$(make -s mint-session LAB_USER=alice)
curl -s -XPOST localhost:3000/api/labs -H "cookie: $COOKIE"        # start a lab -> url
curl -s localhost:8080/lab/<labId>/ -H "cookie: $COOKIE" -o /dev/null -w '%{http_code}\n'   # 200
curl -s localhost:8080/lab/<labId>/ -o /dev/null -w '%{http_code}\n'                        # 401
curl -s -XDELETE localhost:3000/api/labs/me -H "cookie: $COOKIE"
make test-integration                             # real k3d + Traefik + Postgres tests
```

The Phase 2 `x-dev-user` header is gone: ForwardAuth forwards browser headers, so any
header-trusting shortcut would be a way to fake identity.

## Google login (Phase 3)

1. <https://console.cloud.google.com> → create/select a project → **APIs & Services → OAuth consent
   screen**: External, app name "LabForge", your email; while in *Testing*, add yourself under
   **Test users**.
2. **Credentials → Create credentials → OAuth client ID → Web application**. Authorized redirect URIs:
   - `http://localhost:3000/auth/callback` (local)
   - `https://labs.gurnoor.online/auth/callback` (prod)
3. Put the client id and secret in `services/api/.env` (`OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`),
   restart `make api-run`, open <http://localhost:3000> → **Log in with Google**.

In production they live in a Kubernetes Secret, created by hand (never committed). `read -s` keeps
the values out of your shell history:

```bash
read -s OIDC_CLIENT_SECRET   # paste, Enter
kubectl -n labforge create secret generic labforge-api \
  --from-literal=SESSION_SECRET="$(openssl rand -hex 32)" \
  --from-literal=OIDC_CLIENT_ID="<client-id>.apps.googleusercontent.com" \
  --from-literal=OIDC_CLIENT_SECRET="$OIDC_CLIENT_SECRET"
unset OIDC_CLIENT_SECRET
```

How login works: authorization code flow with **PKCE (S256)**, `state` (login CSRF) and `nonce`
(ID-token replay), held for 10 minutes in a signed `lf_oidc` cookie scoped to `/auth`. On success
the API stores a session (only the SHA-256 of a 256-bit token) and sets `lf_session`: signed,
`HttpOnly`, `SameSite=Lax`, `Secure` on https, host-only (no `Domain` attribute, so it never leaks
to subdomains). A verified Google email is required.

How a terminal request is authorised: each lab's Ingress uses its own Traefik `Middleware`
(`forwardAuth` → `/auth/verify?lab=<id>`). The lab id is baked in when the lab is claimed, so the
API never parses the client-controlled path; see
[ADR-0001](../../docs/adr/0001-forwardauth-binds-lab-id.md). `/auth/verify` answers in one indexed
query: **200** owner of a live lab, **401** no/invalid session, **403** someone else's lab, or an
expired/ended one.

RBAC lives in the chart (`deploy/helm/labforge/templates/rbac.yaml`): one ServiceAccount and
least-privilege ClusterRole per component. Check a permission with
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

Labs created by the API (Phase 3+) also get a Traefik **ForwardAuth Middleware** that the Ingress
references, so only the lab's owner gets in. This hand-written demo lab deliberately has none: it's
open, for learning the objects. Don't leave it running anywhere reachable (`make lab-example-down`).

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
| `make test-integration` (Phase 2): create → Ready → reachable → delete; 20-way reservation races | 4/4 pass |

### Phase 3: access through Traefik ForwardAuth (`make test-integration`, 13/13, 3 runs)

| Request to a lab (through real Traefik on :8080) | Result |
|---|---|
| Owner's session: page / websocket | `200` / `101` |
| No session: page / websocket | `401` / `401` |
| Forged (bad-signature) cookie | `401` |
| Another user's session: page / websocket | `403` / `403` |
| Another user + spoofed `X-Forwarded-Uri`/`X-Forwarded-Prefix` naming their own lab | `403` |
| Another user + `/lab/<theirs>/../<victim>/`, `%2e%2e`, `%2f` path tricks | never `200`/`101` |
| Owner after the lab's `expires_at` (before the reaper runs) | `403` |
| Logged-out session (user's other sessions keep working) | `401` (other: `200`) |
| Owner right after ending the lab, then namespace | denied, then gone |

Manual run in the browser: logged-out page shows "Log in with Google" → with a minted session,
**Start lab** → **Open terminal** opens bash as `lab` with the expiry banner; clearing the cookie and
reloading the terminal URL returns `401 login required`.

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
