#!/usr/bin/env bash
# Rehearse the production bootstrap (docs/operations.md steps 7 and 9) on the
# local k3d cluster: hand-made Secrets, Argo CD, and every Application exactly as
# committed. Only differences from prod: the labforge app uses the locally
# imported images (GHCR packages may be private) and the k3d node CIDR, and TLS
# is a self-signed cert (no public DNS for Let's Encrypt).
#
#   make dev-up images images-import && tests/rehearsal/argocd.sh
set -euo pipefail
cd "$(dirname "$0")/../.."
CURL="curl -sk --connect-to labs.gurnoor.online:443:127.0.0.1:${HTTPS_PORT:-8443}"

echo "== clean slate for the labforge namespace"
helm uninstall labforge -n labforge --wait 2>/dev/null || true
kubectl -n labforge delete pvc --all --wait=true 2>/dev/null || true
kubectl create namespace labforge --dry-run=client -o yaml | kubectl apply -f - >/dev/null
kubectl label namespace labforge pod-security.kubernetes.io/enforce=restricted --overwrite >/dev/null
kubectl create namespace monitoring --dry-run=client -o yaml | kubectl apply -f - >/dev/null

echo "== secrets (operations.md step 7)"
mk() { kubectl -n "$1" create secret generic "$2" "${@:3}" --dry-run=client -o yaml | kubectl apply -f - >/dev/null; }
mk labforge labforge-api --from-literal=SESSION_SECRET="$(openssl rand -hex 32)"
mk labforge labforge-postgres --from-literal=POSTGRES_PASSWORD="$(openssl rand -hex 24)"
mk monitoring alertmanager-discord --from-literal=webhook-url=http://webhook-sink.monitoring.svc.cluster.local:8080/discord-webhook
mk monitoring grafana-admin --from-literal=admin-user=admin --from-literal=admin-password="$(openssl rand -hex 16)"
kubectl -n kube-system get secret labforge-tls >/dev/null 2>&1 || {
  t=$(mktemp -d)
  openssl req -x509 -newkey rsa:2048 -nodes -days 2 -subj "/CN=labs.gurnoor.online" \
    -addext "subjectAltName=DNS:labs.gurnoor.online" -keyout "$t/k" -out "$t/c" 2>/dev/null
  kubectl -n kube-system create secret tls labforge-tls --cert="$t/c" --key="$t/k" >/dev/null
}

echo "== Argo CD (make bootstrap, with the labforge app pointed at local images)"
helm repo add argo https://argoproj.github.io/argo-helm >/dev/null 2>&1 || true
helm repo update argo >/dev/null
helm upgrade --install argocd argo/argo-cd --version 10.14.0 -n argocd --create-namespace --wait --timeout 10m | grep STATUS
kubectl apply -f deploy/argocd/cluster.yaml -f deploy/argocd/monitoring.yaml
python3 - <<'PY' | kubectl apply -f -
s = open("deploy/argocd/application.yaml").read()
a = "      valueFiles: [values-prod.yaml]"
assert a in s
print(s.replace(a, a + """
      parameters:
        - {name: images.registry, value: ""}
        - {name: images.tag, value: dev}
        - {name: network.nodeCidr, value: 172.28.0.0/16}"""))
PY

echo "== waiting for the Applications (up to 20 min; monitoring images are large)"
status() { kubectl -n argocd get applications -o jsonpath='{range .items[*]}{.metadata.name}{"\t"}{.status.sync.status}{"\t"}{.status.health.status}{"\n"}{end}'; }
for _ in $(seq 1 120); do
  # cluster-config can't become Healthy locally: Let's Encrypt needs public DNS.
  status | grep -v "^cluster-config" | grep -qv "Synced.Healthy$" || break
  sleep 10
done
status | column -t
kubectl -n argocd get applications -o jsonpath='{range .items[*]}{.metadata.name}: {.status.operationState.phase} {.status.operationState.message}{"\n"}{end}' | cut -c1-220

echo "== the app, at the production hostname over HTTPS"
echo "readyz: $($CURL -o /dev/null -w '%{http_code}' https://labs.gurnoor.online/readyz)"
C=$(kubectl -n labforge exec deploy/labforge-api -- node dist/mint-session.js rehearsal-user | tail -1)
LAB=$($CURL -XPOST https://labs.gurnoor.online/api/labs -H "cookie: $C")
echo "start lab: $LAB"
URL=$(printf '%s' "$LAB" | python3 -c 'import json,sys; print(json.load(sys.stdin)["url"])')
for _ in $(seq 1 20); do
  code=$($CURL -o /dev/null -w '%{http_code}' "$URL" -H "cookie: $C"); [ "$code" = 200 ] && break; sleep 1
done
echo "owner GET $URL: $code   anonymous: $($CURL -o /dev/null -w '%{http_code}' "$URL")"
$CURL -o /dev/null -XDELETE https://labs.gurnoor.online/api/labs/me -H "cookie: $C"
echo "== monitoring"
kubectl -n monitoring get pods --no-headers | awk '{print $1, $2, $3}'
kubectl -n monitoring get prometheusrule labforge -o name; kubectl -n labforge get servicemonitor -o name
