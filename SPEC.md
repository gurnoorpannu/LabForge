# LabForge — Build Spec

> Source-of-truth spec for the project. Work proceeds phase by phase (§9); each phase ends with
> verification and a review stop.

---

## 0. Working agreement

Portfolio project for **SRE / Cloud / DevOps** roles. UI stays minimal (plain HTML, no frameworks).

- **Work phase by phase** (§9). End of each phase: run verification checks, show results, **stop for review**.
- After each phase: short plain-language explanation + 3–5 interview Q&A.
- **Never run anything that costs money or changes real cloud infra without asking** (`terraform apply/destroy`, creating cloud resources, DNS). `terraform plan` is fine.
- **Never commit secrets**: OCI keys, kubeconfigs, `.env`, OAuth client secrets, Discord webhooks. `.gitignore` in Phase 0; `.env.example` instead.
- **Never invent benchmark numbers.** Every number in docs comes from a test actually run, with the command.
- Ask instead of guessing about cloud account, domain, or credentials.
- Small, focused commits, conventional messages (`feat:`, `fix:`, `infra:`, `docs:`, `test:`).
- Prefer boring, well-documented tools; check current docs/installed versions before writing config.

---

## 1. What we're building

Users log in with Google, click **Start Lab**, and within seconds get `https://<LAB_DOMAIN>/lab/<labId>`
opening a real Ubuntu shell in the browser. Labs **auto-destroy after 45 minutes** (configurable).
Limits: **1 active lab/user**, cluster-wide **max concurrent**. At capacity → `503` + `Retry-After`.

Each lab = one Kubernetes namespace with one Ubuntu + `ttyd` pod, plus isolation objects (quota,
network policy, pod security).

---

## 2. Placeholders

| Name | Value |
|---|---|
| `GITHUB_USER` | `gurnoorpannu` |
| `LAB_DOMAIN` | `labs.gurnoor.online` |
| `ACME_EMAIL` | _(my email)_ |
| `CLOUD` | `oci` (Always Free ARM Ampere A1) |
| `ADMIN_IP` | _(my public IP)/32_ |
| Lab TTL | `45m` |
| Warm pool size | `3` |
| Max concurrent labs | `10` |

---

## 3–8

See the full spec sections in the project history / PR description. Key requirements summarised:

- **Lab image**: `ubuntu:24.04` + `ttyd` + common tools, non-root user `lab` (UID 1000, no sudo),
  `readOnlyRootFilesystem` with emptyDir at `/home/lab` and `/tmp`, MOTD with expiry.
- **Lab namespace**: labels/annotations for id/state/owner/expiry, restricted PSA, hardened pod spec,
  ResourceQuota + LimitRange, default-deny NetworkPolicy (DNS + toggleable internet egress, block pod/
  service/node CIDRs and `169.254.169.254/32`), Service + Ingress (path `/lab/<id>`, no strip) with a
  per-namespace Traefik ForwardAuth Middleware to the API's `/auth/verify`.
- **API**: Fastify, Google OIDC + Postgres sessions, `/auth/verify`, lab CRUD with 1-lab/user + global
  cap + warm-lab claim, health + metrics, zod validation, rate limiting, least-privilege RBAC.
- **Claiming**: Postgres is source of truth; atomic `FOR UPDATE SKIP LOCKED` claim; partial unique index
  for 1 active lab/user; `activeDeadlineSeconds` as a per-pod safety net.
- **Pool controller**: ~5s reconcile to `poolSize` ready labs, drift fixes, global cap, advisory-lock leader.
- **Reaper**: CronJob every minute, annotation-driven (works if DB down), two-layer cleanup with `activeDeadlineSeconds`.
- **Observability**: prom-client metrics, kube-prometheus-stack, PrometheusRules → Discord, Grafana dashboard.
- **Infra**: Terraform (OCI VCN/subnet/security-list/2× A1 VMs) + Ansible (harden, OCI iptables, k3s).
- **Helm + ArgoCD**: chart with values-local / values-prod, lint + kubeconform, GitOps sync.
- **CI/CD**: `ci.yml` (checks) + `images.yml` (buildx multi-arch → Trivy → GHCR → bump tag).

## 9. Phases

0. Scaffolding · 1. Local cluster + lab image · 2. API core · 3. Auth + ForwardAuth ·
4. Isolation hardening · 5. Lifecycle (reaper, pool, claiming) · 6. Observability ·
7. Helm + CI/CD · 8. Cloud infra · 9. Prove it + write-up.

## 10. Definition of done

Log in → start lab → real terminal over HTTPS → gone after TTL. Labs can't reach each other, the K8s
API, platform internals, or cloud metadata (proven by tests). Warm vs cold start measured. Fully
reproducible (Terraform + Ansible + ArgoCD). CI green, images scanned, no secrets in git.
