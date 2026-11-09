#!/usr/bin/env bash
set -euo pipefail

CLUSTER=${ORCHARD_CLUSTER:-orchard-dev}
HTTP_PORT=8080
HTTPS_PORT=8443
GATEWAY_API_VERSION=v1.6.1
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

step() { printf '\n\033[1;32m==> %s\033[0m\n' "$*"; }
need() { command -v "$1" >/dev/null 2>&1 || { echo "missing dependency: $1" >&2; exit 1; }; }

need docker
need k3d
need kubectl
need helm

if k3d cluster list "$CLUSTER" >/dev/null 2>&1; then
  echo "cluster $CLUSTER already exists; delete it with: k3d cluster delete $CLUSTER" >&2
  exit 1
fi

step "Creating k3d cluster $CLUSTER"
k3d cluster create "$CLUSTER" \
  -p "$HTTP_PORT:80@loadbalancer" \
  -p "$HTTPS_PORT:443@loadbalancer" \
  --k3s-arg "--disable=traefik@server:0" \
  --wait

step "Installing Gateway API CRDs"
kubectl apply -f "https://github.com/kubernetes-sigs/gateway-api/releases/download/$GATEWAY_API_VERSION/standard-install.yaml"

step "Adding helm repos"
helm repo add traefik https://traefik.github.io/charts >/dev/null
helm repo add cnpg https://cloudnative-pg.github.io/charts >/dev/null
helm repo add jetstack https://charts.jetstack.io >/dev/null
helm repo update >/dev/null

step "Installing Traefik (with Gateway API provider)"
helm upgrade --install traefik traefik/traefik \
  --namespace traefik --create-namespace \
  --set providers.kubernetesGateway.enabled=true \
  --set gateway.enabled=false \
  --set accessLog.enabled=true \
  --set accessLog.format=json \
  --set accessLog.fields.headers.names.User-Agent=keep \
  --wait

step "Installing CloudNativePG operator"
helm upgrade --install cnpg cnpg/cloudnative-pg \
  --namespace cnpg-system --create-namespace \
  --wait

step "Installing cert-manager"
helm upgrade --install cert-manager jetstack/cert-manager \
  --namespace cert-manager --create-namespace \
  --set crds.enabled=true \
  --wait

step "Creating self-signed ClusterIssuer"
kubectl apply -f - <<'EOF'
apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata:
  name: selfsigned
spec:
  selfSigned: {}
EOF

step "Waiting for the CloudNativePG webhook"
until [ -n "$(kubectl -n cnpg-system get endpoints/cnpg-webhook-service -o jsonpath='{.subsets[*].addresses[*].ip}')" ]; do
  sleep 2
done

step "Installing Orchard"
kubectl create namespace network >/dev/null 2>&1 || true
helm upgrade --install orchard "$REPO_ROOT/infra/charts/orchard" \
  --namespace orchard --create-namespace \
  -f "$REPO_ROOT/scripts/quickstart-values.yaml" \
  --wait --timeout 15m

step "Done"
cat <<EOF

Orchard is up:

  http://orchard.127.0.0.1.nip.io:$HTTP_PORT

There is no account yet and no email here, so claim the instance with the
single-use link in the server log. It asks for an email address, then for a
password, because a passkey needs TLS:

  kubectl -n orchard logs deploy/server | grep -A3 'no superadmin'

Image builds are disabled in the quickstart (no registry), so deploy from a
container image. To tear down:

  k3d cluster delete $CLUSTER
EOF
