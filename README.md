# LabForge

Self-service platform that gives a user a **temporary, isolated Linux terminal in the browser**.

Log in with Google → **Start Lab** → within seconds you get a link to a real Ubuntu shell in the
browser. The lab **auto-destroys after 45 minutes** and everything inside is wiped. One active lab
per user; a cluster-wide cap on concurrent labs returns a clear `503 + Retry-After` when full.

Each lab = one Kubernetes namespace (one Ubuntu + `ttyd` pod) plus isolation objects (quota,
network policy, restricted pod security).

> Portfolio project for SRE / Cloud / DevOps. Built phase by phase — see [SPEC](SPEC.md).

## Status

| Phase | Scope | State |
|-------|-------|-------|
| 0 | Scaffolding (repo, CI, workspaces) | ✅ done |
| 1 | Local k3d cluster + lab image | ⬜ |
| 2 | API core (cold start) | ⬜ |
| 3 | Auth + ForwardAuth | ⬜ |
| 4 | Isolation hardening | ⬜ |
| 5 | Lifecycle: reaper, warm pool, claiming | ⬜ |
| 6 | Observability | ⬜ |
| 7 | Helm chart + CI/CD | ⬜ |
| 8 | Cloud infra (OCI) | ⬜ |
| 9 | Load tests + write-up | ⬜ |

## Tech stack

k3s (prod) / k3d (local) · Node 20 + TypeScript + Fastify · Postgres 16 · Traefik + cert-manager ·
Helm + ArgoCD · kube-prometheus-stack · Terraform (OCI) + Ansible · GitHub Actions + GHCR.

## Quickstart (local)

Requires Node 20+, Docker, and (from Phase 1) `k3d` + `kubectl` + `helm`.

```bash
make install      # install JS deps
make lint         # lint
make typecheck    # type-check all workspaces
make test         # unit tests
make help         # list all targets
```

## Repo layout

```
infra/        Terraform (OCI) + Ansible (k3s install, hardening)
images/lab/   Lab terminal image (Ubuntu + ttyd)
services/     api, pool-controller, reaper, shared (TypeScript)
deploy/       Helm chart, ArgoCD Application, monitoring
tests/        integration (k3d), security (isolation), load (k6)
docs/         architecture, failure modes, runbooks, ADRs, measured results
```

## Results

Real measured numbers (warm vs cold start, isolation proofs, load behaviour) land in
[docs/results.md](docs/results.md) in Phase 9 — every number paired with the command that produced
it. No invented benchmarks.

## Security notes

No secrets in git (see `.gitignore`). Each service ships a `.env.example`; real OIDC secrets,
Discord webhooks, kubeconfigs, and OCI keys are provided out-of-band (K8s Secrets / local files).
