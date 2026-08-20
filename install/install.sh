#!/usr/bin/env bash
set -euo pipefail

ORCHARD_VERSION=${ORCHARD_VERSION:-}
CHART_REF=${ORCHARD_CHART:-oci://ghcr.io/leafdtk/leaf/charts/orchard}
IMAGE_REGISTRY=${ORCHARD_IMAGE_REGISTRY:-ghcr.io}
IMAGE_REPOSITORY=${ORCHARD_IMAGE_REPOSITORY:-leafdtk/leaf}
STATE_DIR=${ORCHARD_STATE_DIR:-/etc/orchard}
VALUES_FILE="$STATE_DIR/values.yaml"

K3S_VERSION=${K3S_VERSION:-v1.31.5+k3s1}
GATEWAY_API_VERSION=${GATEWAY_API_VERSION:-v1.2.1}
NODE_PORT_RANGE=${ORCHARD_NODE_PORT_RANGE:-30000-30100}
ZOT_NODE_PORT=${ORCHARD_ZOT_NODE_PORT:-30500}
REGISTRY_HOST=${ORCHARD_REGISTRY_HOST:-registry.orchard.local}

ORCHARD_DOMAIN=${ORCHARD_DOMAIN:-}
ORCHARD_APP_DOMAIN=${ORCHARD_APP_DOMAIN:-}
ORCHARD_ACME_EMAIL=${ORCHARD_ACME_EMAIL:-}
ORCHARD_INGRESS_MODE=${ORCHARD_INGRESS_MODE:-}
ORCHARD_TUNNEL_TOKEN=${ORCHARD_TUNNEL_TOKEN:-}
ORCHARD_UPDATE_POLICY=${ORCHARD_UPDATE_POLICY:-}
ASSUME_YES=${ORCHARD_ASSUME_YES:-false}

bold() { printf '\033[1m%s\033[0m\n' "$*"; }
step() { printf '\n\033[1;32m==> %s\033[0m\n' "$*"; }
info() { printf '    %s\n' "$*"; }
warn() { printf '\033[1;33m  ! %s\033[0m\n' "$*" >&2; }
die() { printf '\033[1;31m  x %s\033[0m\n' "$*" >&2; exit 1; }

ask() {
  local prompt=$1 default=${2:-} answer
  if [ "$ASSUME_YES" = true ]; then printf '%s' "$default"; return; fi
  if [ -n "$default" ]; then
    read -r -p "$prompt [$default]: " answer </dev/tty || true
    printf '%s' "${answer:-$default}"
  else
    read -r -p "$prompt: " answer </dev/tty || true
    printf '%s' "$answer"
  fi
}

preflight() {
  step "Checking this machine"

  [ "$(id -u)" -eq 0 ] || die "run as root (k3s needs it)"
  [ "$(uname -s)" = Linux ] || die "Linux only; this is $(uname -s)"

  case "$(uname -m)" in
    x86_64|amd64) ARCH=amd64 ;;
    aarch64|arm64) ARCH=arm64 ;;
    *) die "unsupported architecture $(uname -m); Orchard needs amd64 or arm64" ;;
  esac
  info "architecture: $ARCH"

  if [ "$ARCH" = arm64 ]; then
    warn "image builds currently target linux/amd64 unconditionally."
    warn "Apps built on this box will not run here until that is fixed."
  fi

  MEM_MB=$(awk '/MemTotal/ {print int($2/1024)}' /proc/meminfo)
  [ "$MEM_MB" -ge 3500 ] || die "need at least 4Gi of RAM, found ${MEM_MB}Mi"
  [ "$MEM_MB" -ge 7500 ] || warn "8Gi is the comfortable floor; builds may be tight at ${MEM_MB}Mi"
  info "memory: ${MEM_MB}Mi"

  DISK_GB=$(df -BG --output=avail /var/lib 2>/dev/null | tail -1 | tr -dc '0-9')
  DISK_GB=${DISK_GB:-0}
  [ "$DISK_GB" -ge 20 ] || die "need at least 20G free on /var/lib, found ${DISK_GB}G"
  [ "$DISK_GB" -ge 60 ] || warn "only ${DISK_GB}G free; build cache and images will fill this quickly"
  info "free disk: ${DISK_GB}G"

  if command -v ss >/dev/null 2>&1; then
    for port in 80 443; do
      if ss -lnt "sport = :$port" 2>/dev/null | grep -q LISTEN; then
        local holder
        holder=$(ss -lntp "sport = :$port" 2>/dev/null | tail -1)
        die "port $port is already in use: $holder"
      fi
    done
    info "ports 80/443 are free"
  else
    warn "ss not found; skipping port check"
  fi

  if command -v kubectl >/dev/null 2>&1 && kubectl cluster-info >/dev/null 2>&1; then
    warn "an existing Kubernetes cluster is reachable from this shell."
    warn "This installer creates its own k3s cluster and will not touch it."
    warn "To install into that cluster instead, use the Helm chart: docs/self-hosting.md"
    [ "$(ask 'Continue and create a new k3s cluster? (yes/no)' no)" = yes ] || exit 1
  fi

  if [ ! -f /sys/fs/cgroup/cgroup.controllers ]; then
    warn "cgroup v2 not detected; resource limits may not be enforced"
  fi

  if [ -w /dev/kvm ]; then
    info "KVM present (VM-isolated builds available as an opt-in later)"
  fi
}

detect_network() {
  step "Working out how traffic reaches this box"

  PUBLIC_IP=$(curl -fsS --max-time 8 https://api.ipify.org 2>/dev/null || true)
  LOCAL_IPS=$(ip -4 -o addr show scope global 2>/dev/null | awk '{print $4}' | cut -d/ -f1 || true)
  PRIMARY_IP=$(printf '%s\n' "$LOCAL_IPS" | head -1)

  BEHIND_NAT=true
  if [ -n "$PUBLIC_IP" ] && printf '%s\n' "$LOCAL_IPS" | grep -qx "$PUBLIC_IP"; then
    BEHIND_NAT=false
  fi

  info "public IP: ${PUBLIC_IP:-unknown}"
  info "local IP:  ${PRIMARY_IP:-unknown}"
  if [ "$BEHIND_NAT" = true ]; then
    info "this box is behind NAT"
  else
    info "this box has a routable address"
  fi
}

choose_ingress_mode() {
  if [ -n "$ORCHARD_INGRESS_MODE" ]; then
    INGRESS_MODE=$ORCHARD_INGRESS_MODE
  elif [ "$ASSUME_YES" = true ]; then
    INGRESS_MODE=$([ "$BEHIND_NAT" = true ] && echo tunnel || echo public)
  else
    echo
    bold "How should the internet reach this instance?"
    echo "  1) public    - I have a routable IP and can point DNS at it"
    echo "  2) tunnel    - Cloudflare Tunnel (works behind NAT/CGNAT)"
    echo "  3) lan       - LAN only, self-signed certificates"
    local default
    default=$([ "$BEHIND_NAT" = true ] && echo 2 || echo 1)
    case "$(ask 'Choose' "$default")" in
      1) INGRESS_MODE=public ;;
      2) INGRESS_MODE=tunnel ;;
      3) INGRESS_MODE=lan ;;
      *) die "invalid choice" ;;
    esac
  fi
  info "ingress mode: $INGRESS_MODE"

  case "$INGRESS_MODE" in
    public|tunnel|lan) ;;
    *) die "unknown ingress mode: $INGRESS_MODE" ;;
  esac
}

collect_domains() {
  step "Domains"

  if [ "$INGRESS_MODE" = lan ]; then
    ORCHARD_DOMAIN=${ORCHARD_DOMAIN:-orchard.${PRIMARY_IP//./-}.sslip.io}
    ORCHARD_APP_DOMAIN=${ORCHARD_APP_DOMAIN:-apps.${PRIMARY_IP//./-}.sslip.io}
    USE_TLS=false
    CERT_ISSUER=selfsigned
    info "platform: http://$ORCHARD_DOMAIN"
    info "apps:     *.$ORCHARD_APP_DOMAIN"
    return
  fi

  [ -n "$ORCHARD_DOMAIN" ] || ORCHARD_DOMAIN=$(ask "Domain for the Orchard UI (e.g. orchard.example.com)")
  [ -n "$ORCHARD_DOMAIN" ] || die "a domain is required for $INGRESS_MODE mode"

  local base=${ORCHARD_DOMAIN#*.}
  [ -n "$ORCHARD_APP_DOMAIN" ] || ORCHARD_APP_DOMAIN=$(ask "Wildcard domain for deployed apps" "apps.$base")

  USE_TLS=true
  CERT_ISSUER=letsencrypt

  if [ "$INGRESS_MODE" = public ]; then
    [ -n "$ORCHARD_ACME_EMAIL" ] || ORCHARD_ACME_EMAIL=$(ask "Email for Let's Encrypt notices")
    [ -n "$ORCHARD_ACME_EMAIL" ] || die "Let's Encrypt needs a contact email"

    echo
    bold "Point these records at ${PUBLIC_IP:-this box} before continuing:"
    echo "  A  $ORCHARD_DOMAIN       -> ${PUBLIC_IP:-<this box>}"
    echo "  A  *.$ORCHARD_APP_DOMAIN -> ${PUBLIC_IP:-<this box>}"
    wait_for_dns "$ORCHARD_DOMAIN"
  else
    USE_TLS=false
    CERT_ISSUER=""
    [ -n "$ORCHARD_TUNNEL_TOKEN" ] || ORCHARD_TUNNEL_TOKEN=$(ask "Cloudflare Tunnel token")
    [ -n "$ORCHARD_TUNNEL_TOKEN" ] || die "a tunnel token is required for tunnel mode"
    echo
    bold "In the Cloudflare dashboard, route these hostnames to this tunnel:"
    echo "  $ORCHARD_DOMAIN        -> http://traefik.traefik.svc.cluster.local:80"
    echo "  *.$ORCHARD_APP_DOMAIN  -> http://traefik.traefik.svc.cluster.local:80"
  fi
}

wait_for_dns() {
  local host=$1 tries=0 resolved
  [ "$ASSUME_YES" = true ] && return 0
  printf '    waiting for %s to resolve' "$host"
  while [ $tries -lt 60 ]; do
    resolved=$(getent ahostsv4 "$host" 2>/dev/null | awk 'NR==1{print $1}' || true)
    if [ -n "$resolved" ]; then
      printf '\n'
      info "$host -> $resolved"
      if [ -n "$PUBLIC_IP" ] && [ "$resolved" != "$PUBLIC_IP" ]; then
        warn "that does not match this box's public IP ($PUBLIC_IP)"
      fi
      return 0
    fi
    printf '.'
    sleep 5
    tries=$((tries + 1))
  done
  printf '\n'
  warn "$host still does not resolve; certificates will fail until it does"
}

choose_update_policy() {
  if [ -z "$ORCHARD_UPDATE_POLICY" ]; then
    if [ "$ASSUME_YES" = true ]; then
      ORCHARD_UPDATE_POLICY=manual
    else
      echo
      bold "Updates"
      echo "  1) manual     - you run 'orchard-update' when you want a new version"
      echo "  2) automatic  - check nightly and upgrade in place"
      case "$(ask 'Choose' 1)" in
        1) ORCHARD_UPDATE_POLICY=manual ;;
        2) ORCHARD_UPDATE_POLICY=automatic ;;
        *) die "invalid choice" ;;
      esac
    fi
  fi
  info "update policy: $ORCHARD_UPDATE_POLICY"
}

install_k3s() {
  step "Installing k3s"

  if command -v k3s >/dev/null 2>&1; then
    info "k3s already installed, leaving it alone"
  else
    curl -sfL https://get.k3s.io | INSTALL_K3S_VERSION="$K3S_VERSION" sh -s - server \
      --disable=traefik \
      --write-kubeconfig-mode=644 \
      --service-node-port-range="$NODE_PORT_RANGE"
  fi

  export KUBECONFIG=/etc/rancher/k3s/k3s.yaml
  local tries=0
  until kubectl get nodes >/dev/null 2>&1; do
    tries=$((tries + 1))
    [ $tries -lt 60 ] || die "k3s did not become ready"
    sleep 2
  done
  kubectl wait --for=condition=Ready node --all --timeout=180s >/dev/null
  info "cluster is up"
}

ensure_helm() {
  command -v helm >/dev/null 2>&1 && return
  step "Installing Helm"
  curl -fsSL https://raw.githubusercontent.com/helm/helm/main/scripts/get-helm-3 | bash
}

install_operators() {
  step "Installing platform operators"

  kubectl apply -f "https://github.com/kubernetes-sigs/gateway-api/releases/download/$GATEWAY_API_VERSION/standard-install.yaml" >/dev/null

  helm repo add traefik https://traefik.github.io/charts >/dev/null 2>&1 || true
  helm repo add cnpg https://cloudnative-pg.github.io/charts >/dev/null 2>&1 || true
  helm repo add jetstack https://charts.jetstack.io >/dev/null 2>&1 || true
  helm repo update >/dev/null

  info "Traefik"
  helm upgrade --install traefik traefik/traefik \
    --namespace traefik --create-namespace \
    --set providers.kubernetesGateway.enabled=true \
    --set gateway.enabled=false \
    --wait --timeout 10m >/dev/null

  info "CloudNativePG"
  helm upgrade --install cnpg cnpg/cloudnative-pg \
    --namespace cnpg-system --create-namespace \
    --wait --timeout 10m >/dev/null

  if [ -n "$CERT_ISSUER" ]; then
    info "cert-manager"
    helm upgrade --install cert-manager jetstack/cert-manager \
      --namespace cert-manager --create-namespace \
      --set crds.enabled=true \
      --wait --timeout 10m >/dev/null
    install_cluster_issuer
  else
    info "cert-manager skipped (TLS terminates at the tunnel)"
  fi
}

install_cluster_issuer() {
  if [ "$CERT_ISSUER" = selfsigned ]; then
    kubectl apply -f - >/dev/null <<'EOF'
apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata:
  name: selfsigned
spec:
  selfSigned: {}
EOF
    return
  fi

  kubectl apply -f - >/dev/null <<EOF
apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata:
  name: letsencrypt
spec:
  acme:
    server: https://acme-v02.api.letsencrypt.org/directory
    email: $ORCHARD_ACME_EMAIL
    privateKeySecretRef:
      name: letsencrypt-account-key
    solvers:
      - http01:
          ingress:
            class: traefik
EOF
}

install_registry() {
  step "Installing the bundled registry (zot)"

  kubectl create namespace orchard >/dev/null 2>&1 || true

  kubectl apply -f - >/dev/null <<EOF
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: zot-data
  namespace: orchard
spec:
  accessModes: [ReadWriteOnce]
  storageClassName: local-path
  resources:
    requests:
      storage: ${REGISTRY_SIZE_GB}Gi
---
apiVersion: v1
kind: ConfigMap
metadata:
  name: zot-config
  namespace: orchard
data:
  config.json: |
    {
      "storage": {
        "rootDirectory": "/var/lib/registry",
        "gc": true,
        "gcDelay": "1h",
        "gcInterval": "24h"
      },
      "http": { "address": "0.0.0.0", "port": "5000" },
      "log": { "level": "info" },
      "extensions": {
        "scrub": { "interval": "24h" }
      }
    }
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: zot
  namespace: orchard
spec:
  replicas: 1
  selector:
    matchLabels: { app: zot }
  template:
    metadata:
      labels: { app: zot }
    spec:
      containers:
        - name: zot
          image: ghcr.io/project-zot/zot-linux-${ARCH}:latest
          args: ["serve", "/etc/zot/config.json"]
          ports:
            - containerPort: 5000
          volumeMounts:
            - { name: data, mountPath: /var/lib/registry }
            - { name: config, mountPath: /etc/zot }
          resources:
            requests: { cpu: 50m, memory: 64Mi }
            limits: { cpu: "1", memory: 512Mi }
      volumes:
        - name: data
          persistentVolumeClaim: { claimName: zot-data }
        - name: config
          configMap: { name: zot-config }
---
apiVersion: v1
kind: Service
metadata:
  name: zot
  namespace: orchard
spec:
  type: NodePort
  selector: { app: zot }
  ports:
    - port: 5000
      targetPort: 5000
      nodePort: $ZOT_NODE_PORT
EOF

  mkdir -p /etc/rancher/k3s
  cat > /etc/rancher/k3s/registries.yaml <<EOF
mirrors:
  $REGISTRY_HOST:
    endpoint:
      - "http://127.0.0.1:$ZOT_NODE_PORT"
configs:
  "127.0.0.1:$ZOT_NODE_PORT":
    tls:
      insecure_skip_verify: true
EOF
  systemctl restart k3s
  local tries=0
  until kubectl get --raw /readyz >/dev/null 2>&1; do
    tries=$((tries + 1))
    [ $tries -lt 60 ] || die "k3s did not come back after loading the registry mirror"
    sleep 2
  done
  kubectl -n orchard rollout status deploy/zot --timeout=5m >/dev/null
  info "registry ready at $REGISTRY_HOST (mirrored to 127.0.0.1:$ZOT_NODE_PORT)"
}

install_tunnel() {
  [ "$INGRESS_MODE" = tunnel ] || return 0
  step "Installing cloudflared"

  kubectl create namespace cloudflared >/dev/null 2>&1 || true
  kubectl -n cloudflared create secret generic tunnel-token \
    --from-literal=token="$ORCHARD_TUNNEL_TOKEN" \
    --dry-run=client -o yaml | kubectl apply -f - >/dev/null

  kubectl apply -f - >/dev/null <<'EOF'
apiVersion: apps/v1
kind: Deployment
metadata:
  name: cloudflared
  namespace: cloudflared
spec:
  replicas: 1
  selector:
    matchLabels: { app: cloudflared }
  template:
    metadata:
      labels: { app: cloudflared }
    spec:
      containers:
        - name: cloudflared
          image: cloudflare/cloudflared:latest
          args: ["tunnel", "--no-autoupdate", "run"]
          env:
            - name: TUNNEL_TOKEN
              valueFrom:
                secretKeyRef: { name: tunnel-token, key: token }
          resources:
            requests: { cpu: 20m, memory: 32Mi }
            limits: { cpu: 500m, memory: 256Mi }
EOF
  kubectl -n cloudflared rollout status deploy/cloudflared --timeout=5m >/dev/null
}

size_workloads() {
  if [ "$MEM_MB" -ge 15000 ]; then MAX_BUILDS=3
  elif [ "$MEM_MB" -ge 7500 ]; then MAX_BUILDS=2
  else MAX_BUILDS=1
  fi

  BUILD_CACHE_GB=$((DISK_GB / 5))
  [ "$BUILD_CACHE_GB" -gt 60 ] && BUILD_CACHE_GB=60
  [ "$BUILD_CACHE_GB" -lt 5 ] && BUILD_CACHE_GB=5

  REGISTRY_SIZE_GB=$((DISK_GB / 5))
  [ "$REGISTRY_SIZE_GB" -gt 50 ] && REGISTRY_SIZE_GB=50
  [ "$REGISTRY_SIZE_GB" -lt 5 ] && REGISTRY_SIZE_GB=5

  info "concurrent builds: $MAX_BUILDS, build cache: ${BUILD_CACHE_GB}G, registry: ${REGISTRY_SIZE_GB}G"
}

write_values() {
  step "Writing $VALUES_FILE"

  mkdir -p "$STATE_DIR"
  chmod 700 "$STATE_DIR"

  local scheme=http entrypoint=web tls_enabled=false
  if [ "$USE_TLS" = true ]; then
    scheme=https; entrypoint=websecure; tls_enabled=true
  fi
  [ "$INGRESS_MODE" = tunnel ] && scheme=https

  JWT_SECRET=$(head -c 32 /dev/urandom | base64 | tr -d '\n=' | head -c 43)
  ENCRYPTION_KEY=$(head -c 24 /dev/urandom | base64 | tr -d '\n=' | head -c 32)
  SSO_KEY=$(head -c 24 /dev/urandom | base64 | tr -d '\n=' | head -c 32)

  cat > "$VALUES_FILE" <<EOF
# Generated by install/install.sh. Edit and re-run 'orchard-update' to apply.
createNamespace: false

image:
  registry: $IMAGE_REGISTRY
  repository: $IMAGE_REPOSITORY

signupMode: open
datadog:
  enabled: false

frontend:
  replicas: 1
  env:
    - { name: PUBLIC_APP_DOMAIN, value: $ORCHARD_APP_DOMAIN }
    - { name: PUBLIC_OAUTH_PROVIDER, value: none }

server:
  replicas: 1
  env:
    - { name: JWT_SECRET, value: "$JWT_SECRET" }
    - { name: SECRETS_ENCRYPTION_KEY, value: "$ENCRYPTION_KEY" }
    - { name: SSO_ENCRYPTION_KEY, value: "$SSO_KEY" }
    - { name: APP_DOMAIN, value: $ORCHARD_APP_DOMAIN }
    - { name: FRONTEND_URL, value: $scheme://$ORCHARD_DOMAIN }
    - { name: MAX_CONCURRENT_BUILDS, value: "$MAX_BUILDS" }
    - { name: K8S_STORAGE_CLASS, value: local-path }
    - { name: K8S_INGRESS_CLASS, value: traefik }
    - { name: DOCKER_REGISTRY_PUSH, value: zot.orchard.svc.cluster.local:5000 }
    - { name: DOCKER_REGISTRY_PULL, value: $REGISTRY_HOST }
    - { name: REGISTRY_HTTP_HOSTS, value: zot.orchard.svc.cluster.local:5000 }
    - { name: REGISTRY_PROJECT, value: orchard }
    - { name: BUILDER_SCRATCH_STORAGE_CLASS, value: local-path }

tenant:
  storageClass: local-path
  ingressClass: traefik
  certClusterIssuer: "$CERT_ISSUER"

ingress:
  enabled: true
  host: $ORCHARD_DOMAIN
  entryPoints: [$entrypoint]
  tls:
    enabled: $tls_enabled

gateway:
  enabled: true
  namespace: network
  gatewayClassName: traefik
  http:
    enabled: true
    appDomain: $ORCHARD_APP_DOMAIN

postgres:
  enabled: true
  instances: 1
  storage:
    size: 10Gi
    storageClass: local-path

redis:
  enabled: true
  storage: 1Gi
  storageClass: local-path

builders:
  enabled: true
  harbor:
    username: ""
    password: ""
    hosts:
      - zot.orchard.svc.cluster.local
  localCache:
    enabled: true
    size: ${BUILD_CACHE_GB}Gi
    storageClass: local-path

metrics:
  enabled: true
  victoriametrics:
    retention: 7d
    storage:
      size: 5Gi
      storageClass: local-path

mcp:
  enabled: false

certificates:
  enabled: false

r2Proxy:
  enabled: false

# Sandboxed builds and tenant isolation need gVisor or Kata on the node.
# Follow install/README.md, then turn these on and re-run 'orchard-update'.
tenantSandbox:
  enabled: false
builderSandbox:
  enabled: false
sandbox:
  enabled: false
EOF
  chmod 600 "$VALUES_FILE"
}

install_orchard() {
  step "Installing Orchard"

  local args=(upgrade --install orchard "$CHART_REF"
    --namespace orchard --create-namespace
    -f "$VALUES_FILE" --wait --timeout 20m)
  [ -n "$ORCHARD_VERSION" ] && args+=(--version "$ORCHARD_VERSION")

  helm "${args[@]}"
}

install_updater() {
  step "Installing the updater"

  cat > /usr/local/bin/orchard-update <<EOF
#!/usr/bin/env bash
set -euo pipefail
export KUBECONFIG=/etc/rancher/k3s/k3s.yaml
exec helm upgrade --install orchard "$CHART_REF" \\
  --namespace orchard -f "$VALUES_FILE" --wait --timeout 20m "\$@"
EOF
  chmod +x /usr/local/bin/orchard-update

  if [ "$ORCHARD_UPDATE_POLICY" = automatic ]; then
    cat > /etc/systemd/system/orchard-update.service <<'EOF'
[Unit]
Description=Update Orchard
[Service]
Type=oneshot
ExecStart=/usr/local/bin/orchard-update
EOF
    cat > /etc/systemd/system/orchard-update.timer <<'EOF'
[Unit]
Description=Nightly Orchard update
[Timer]
OnCalendar=daily
RandomizedDelaySec=2h
Persistent=true
[Install]
WantedBy=timers.target
EOF
    systemctl daemon-reload
    systemctl enable --now orchard-update.timer >/dev/null
    info "nightly updates enabled (systemctl disable orchard-update.timer to stop)"
  else
    info "run 'orchard-update' to upgrade"
  fi
}

summary() {
  local scheme=https
  [ "$USE_TLS" = false ] && [ "$INGRESS_MODE" != tunnel ] && scheme=http

  step "Done"
  cat <<EOF

  Orchard is running at $scheme://$ORCHARD_DOMAIN
  Apps get subdomains of $ORCHARD_APP_DOMAIN

  Sign up with the first account, then claim the instance. The setup token is
  printed in the server log on first boot:

    kubectl -n orchard logs deploy/server | grep -A2 'no superadmin'

  Restart the server to mint a fresh token if it expires.

  Config:   $VALUES_FILE
  Upgrade:  orchard-update
  Logs:     kubectl -n orchard logs -f deploy/server

EOF
  if [ "$INGRESS_MODE" = tunnel ]; then
    warn "Tunnel mode: public TCP/UDP ports and public databases are unavailable."
  fi
  warn "Builds run with host-level privileges. Only give build access to people you trust."
}

main() {
  bold "Orchard installer"
  preflight
  detect_network
  choose_ingress_mode
  collect_domains
  choose_update_policy
  size_workloads
  install_k3s
  ensure_helm
  install_operators
  install_registry
  install_tunnel
  write_values
  install_orchard
  install_updater
  summary
}

main "$@"
