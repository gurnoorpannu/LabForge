# Operations: deploying LabForge to OCI

Everything up to this point runs and is tested on a laptop (k3d). This guide takes it to
`https://labs.gurnoor.online` on Oracle Cloud's Always Free tier. Steps marked **(you)** create
real cloud resources or need your accounts; nothing in this repo does them automatically.

Estimated time: 1.5–2 hours the first time, most of it waiting on OCI and DNS.

## 0. What you need

| Item | Where it goes |
|---|---|
| OCI account (Always Free), home region with Ampere A1 capacity | `~/.oci/config`, `terraform.tfvars` |
| The domain `gurnoor.online` at your DNS provider | an A record |
| Your public IP | `admin_ip` in `terraform.tfvars` |
| An SSH key pair (`~/.ssh/id_ed25519.pub`) | `ssh_public_key_path` |
| Google OAuth client (Web application) | Secret `labforge-api` |
| Discord webhook URL (channel settings → Integrations → Webhooks) | Secret `alertmanager-discord` |
| An email for Let's Encrypt expiry notices | `deploy/cluster/cluster-issuers.yaml` |

Tools on your Mac (Terraform, kubectl, helm, Docker are already installed):

```bash
brew install oci-cli ansible
```

## 1. OCI credentials (you)

```bash
oci setup config                     # creates ~/.oci/config + an API key; upload the public key in
                                     # Console -> Profile -> API keys
oci iam region-subscription list     # confirms it works; note your home region key
```

You'll need your **tenancy OCID** (Console → Profile → Tenancy). For a personal account, use it as the
compartment OCID too.

## 2. Terraform state bucket (you, once)

```bash
oci os ns get                                                    # -> <namespace>
oci os bucket create --name labforge-tfstate --compartment-id <tenancy-ocid> --versioning Enabled
```

## 3. Terraform: network + 2 VMs

```bash
cd infra/terraform
cp terraform.tfvars.example terraform.tfvars    # fill in region, OCIDs, admin_ip
cp backend.hcl.example backend.hcl              # fill in namespace, region
cd ../..
make infra-init
make infra-plan        # read the plan: 1 VCN, IGW, route table, security list, subnet, 2 instances
make infra-apply       # (you) creates them
```

- If apply fails with **"Out of host capacity"**: A1 capacity is scarce. Try
  `availability_domain_index = 1` (or 2) in `terraform.tfvars`, or retry later. Don't loop retries.
- Outputs: `server_public_ip`, `agent_public_ip`, `node_cidr`. Terraform also writes
  `infra/ansible/inventory.ini`.
- `node_cidr` must equal `network.nodeCidr` in `deploy/helm/labforge/values-prod.yaml`
  (both default to `10.0.1.0/24`).

## 4. DNS (you)

At your DNS provider: `A labs.gurnoor.online -> <server_public_ip>` (Traefik listens on both nodes;
one record is enough). Check: `dig +short labs.gurnoor.online`.

## 5. Ansible: harden nodes, install k3s

```bash
make provision
export KUBECONFIG=$PWD/infra/ansible/kubeconfig   # written by Ansible, git-ignored
kubectl get nodes                                 # 2 nodes Ready, v1.35.5+k3s1
```

The playbook upgrades packages, enables unattended upgrades, sets SSH to keys-only with no root
login, starts fail2ban, opens OCI's host firewall for k3s (and removes OCI's FORWARD REJECT, which
otherwise breaks pod networking), installs the kubelet drop-in (PID limit, single-process OOM kill),
then installs and pins k3s.

## 6. Container images: make them pullable (you, once)

CI already pushed `ghcr.io/gurnoorpannu/labforge-{api,pool-controller,reaper,lab}`. GHCR creates
packages **private**. For each of the 4: GitHub → your profile → Packages → package →
Package settings → Change visibility → **Public**. (Alternative: an `imagePullSecret`; public is
simpler and fine for a portfolio.)

Check: `docker manifest inspect ghcr.io/gurnoorpannu/labforge-api:latest` works without logging in.

## 7. Secrets (you; never committed)

```bash
kubectl create namespace labforge
kubectl label namespace labforge pod-security.kubernetes.io/enforce=restricted
kubectl create namespace monitoring

# App: session signing + Google OIDC
read -s OIDC_CLIENT_SECRET   # paste, Enter
kubectl -n labforge create secret generic labforge-api \
  --from-literal=SESSION_SECRET="$(openssl rand -hex 32)" \
  --from-literal=OIDC_CLIENT_ID="<id>.apps.googleusercontent.com" \
  --from-literal=OIDC_CLIENT_SECRET="$OIDC_CLIENT_SECRET"
unset OIDC_CLIENT_SECRET

# Database password (URL-safe)
kubectl -n labforge create secret generic labforge-postgres \
  --from-literal=POSTGRES_PASSWORD="$(openssl rand -hex 24)"

# Alerts -> Discord, and Grafana's admin login
read -s DISCORD_WEBHOOK
kubectl -n monitoring create secret generic alertmanager-discord --from-literal=webhook-url="$DISCORD_WEBHOOK"
unset DISCORD_WEBHOOK
kubectl -n monitoring create secret generic grafana-admin \
  --from-literal=admin-user=admin --from-literal=admin-password="$(openssl rand -hex 16)"
```

Google OAuth client: Cloud Console → APIs & Services → Credentials → OAuth client ID → Web application,
redirect URI `https://labs.gurnoor.online/auth/callback`. While the consent screen is in *Testing*,
add the Google accounts allowed to log in as test users (or publish it).

## 8. Let's Encrypt email (you)

Edit `deploy/cluster/cluster-issuers.yaml`: replace both `CHANGE_ME@example.com` with your email,
commit and push (Argo CD reads the repo, not your disk).

## 9. Argo CD + everything else

```bash
make bootstrap                                    # installs Argo CD 3.6 (chart 10.14.0), applies the apps
kubectl -n argocd get applications -w             # cert-manager, cluster-config, kps, labforge-monitoring,
                                                  # labforge -> Synced / Healthy (5-10 min)
```

Argo CD UI (optional): `kubectl -n argocd port-forward svc/argocd-server 8443:443`, user `admin`,
password from `kubectl -n argocd get secret argocd-initial-admin-secret -o jsonpath='{.data.password}' | base64 -d`.

Want to try certificates without burning Let's Encrypt rate limits? Temporarily point
`deploy/cluster/certificate.yaml` at `letsencrypt-staging`, then switch back.

## 10. Verify

```bash
curl -sI https://labs.gurnoor.online | head -1                     # HTTP/2 200
echo | openssl s_client -connect labs.gurnoor.online:443 -servername labs.gurnoor.online 2>/dev/null \
  | openssl x509 -noout -issuer -enddate                          # issuer: Let's Encrypt
curl -sI http://labs.gurnoor.online | head -2                      # 301/308, Location: https://...
```

Then in a browser: log in with Google → Start lab → Open terminal.

Alerts reach Discord: send a test alert through Alertmanager.

```bash
kubectl -n monitoring exec alertmanager-kps-kube-prometheus-stack-alertmanager-0 -c alertmanager -- \
  amtool alert add LabForgeTest severity=warning --annotation=summary="test from operations.md" \
  --alertmanager.url=http://localhost:9093
```

Grafana: `kubectl -n monitoring port-forward svc/kps-grafana 3001:80` → <http://localhost:3001>,
dashboard **LabForge**.

## 11. Prove it in production

Run the same suites as locally, against prod, and add the numbers to `docs/results.md`:

```bash
TAG=$(grep '^  tag:' deploy/helm/labforge/values-prod.yaml | cut -d'"' -f2)
LAB_IMAGE=ghcr.io/gurnoorpannu/labforge-lab:$TAG \
  make test-security NODE_CIDR=10.0.1.0/24 SECURITY_REPORT=docs/security-report-prod.md
E2E=1 LABFORGE_URL=https://labs.gurnoor.online npx vitest run tests/e2e   # prod TTL is 45m: add E2E_EXPIRY=0
for i in 1 2 3; do LABFORGE_URL=https://labs.gurnoor.online make load-test USERS=10 OUT=prod-A$i.json; done
python3 tests/load/summarize.py prod-A1.json prod-A2.json prod-A3.json
```

## Day 2

| Task | How |
|---|---|
| Deploy new code | merge to `main` → CI builds, scans, pushes, bumps `values-prod.yaml` → Argo CD rolls out |
| Change config (pool size, TTL, cap) | edit `values-prod.yaml`, push |
| Upgrade k3s | change `k3s_version` in `infra/ansible/group_vars/all.yml`, `make provision` (agent after server) |
| Rotate the session secret | recreate `labforge-api` with a new `SESSION_SECRET`, `kubectl -n labforge rollout restart deploy/labforge-api` (everyone logs in again) |
| See what's running | `kubectl get ns -l app.kubernetes.io/managed-by=labforge -L labforge.io/state` |
| End someone's lab | `kubectl delete ns lab-<id>` (the pool controller fixes the DB row) |
| Tear it all down | `cd infra/terraform && terraform destroy` **(you)**; delete the state bucket in the console |

Alerts and what to do: [runbooks/](runbooks/). What breaks and how: [failure-modes.md](failure-modes.md).
