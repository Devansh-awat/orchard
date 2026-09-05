#!/usr/bin/env bash
set -euo pipefail

ORCHARD_VERSION=${ORCHARD_VERSION:-}
CHART_REF=${ORCHARD_CHART:-oci://ghcr.io/hackclub/orchard/charts/orchard}
IMAGE_REGISTRY=${ORCHARD_IMAGE_REGISTRY:-ghcr.io}
IMAGE_REPOSITORY=${ORCHARD_IMAGE_REPOSITORY:-hackclub/orchard}
STATE_DIR=${ORCHARD_STATE_DIR:-/etc/orchard}
VALUES_FILE="$STATE_DIR/values.yaml"

K3S_VERSION=${K3S_VERSION:-v1.31.5+k3s1}
GATEWAY_API_VERSION=${GATEWAY_API_VERSION:-v1.2.1}
NODE_PORT_RANGE=${ORCHARD_NODE_PORT_RANGE:-30000-30100}
ZOT_NODE_PORT=${ORCHARD_ZOT_NODE_PORT:-30100}
REGISTRY_HOST=${ORCHARD_REGISTRY_HOST:-registry.orchard.local}

ORCHARD_DOMAIN=${ORCHARD_DOMAIN:-}
ORCHARD_APP_DOMAIN=${ORCHARD_APP_DOMAIN:-}
ORCHARD_ACME_EMAIL=${ORCHARD_ACME_EMAIL:-}
ORCHARD_INGRESS_MODE=${ORCHARD_INGRESS_MODE:-}
ORCHARD_TUNNEL_TOKEN=${ORCHARD_TUNNEL_TOKEN:-}
ORCHARD_UPDATE_POLICY=${ORCHARD_UPDATE_POLICY:-}
ORCHARD_METRICS=${ORCHARD_METRICS:-}
ASSUME_YES=${ORCHARD_ASSUME_YES:-false}

IMAGE_TAG=${ORCHARD_IMAGE_TAG:-latest}
IMAGE_PULL_POLICY=${ORCHARD_IMAGE_PULL_POLICY:-Always}

START_TS=$(date +%s)
IS_TTY=false
if [ -t 1 ]; then IS_TTY=true; fi

if [ "$IS_TTY" = true ] && [ -z "${NO_COLOR:-}" ]; then
  C_RESET=$'\033[0m'; C_DIM=$'\033[2m'; C_BOLD=$'\033[1m'
  case "${COLORTERM:-}" in
    truecolor|24bit)
      C_BRAND=$'\033[38;2;174;42;58m'
      C_BRIGHT=$'\033[38;2;214;77;94m'
      ;;
    *)
      C_BRAND=$'\033[38;5;125m'
      C_BRIGHT=$'\033[38;5;167m'
      ;;
  esac
  C_OK=$'\033[38;5;108m'; C_AMBER=$'\033[38;5;179m'
  C_FAIL=$'\033[38;5;203m'; C_GREY=$'\033[38;5;245m'
else
  C_RESET=''; C_DIM=''; C_BOLD=''
  C_BRAND=''; C_BRIGHT=''; C_OK=''; C_AMBER=''; C_FAIL=''; C_GREY=''
fi

pace() {
  if [ "$IS_TTY" = true ] && [ "${ORCHARD_NO_PACING:-}" != "1" ]; then sleep "$1"; fi
}

WIDTH=68
SPINNER=('...' '.. ' '.  ' ' . ' '  .' ' ..')
if [ "$IS_TTY" = true ]; then
  SPINNER=('⠋' '⠙' '⠹' '⠸' '⠼' '⠴' '⠦' '⠧' '⠇' '⠏')
fi

PLAN_TITLES=(
  "Check this machine"
  "Find how traffic gets in"
  "Choose domains"
  "Install k3s"
  "Install Helm"
  "Install platform operators"
  "Install the container registry"
  "Install the Cloudflare tunnel"
  "Write the configuration"
  "Install Orchard"
  "Install the updater"
  "Finish"
)
PLAN_COSTS=(6 6 6 120 20 240 105 45 4 300 4 0)

STEP_N=0
STEP_TOTAL=${#PLAN_TITLES[@]}
REMAINING=0

fmt_secs() {
  if [ "$1" -ge 60 ]; then printf '%dm%02ds' $(($1 / 60)) $(($1 % 60)); else printf '%ds' "$1"; fi
}

elapsed() { fmt_secs $(($(date +%s) - START_TS)); }

rule() {
  local n=$1 out=''
  while [ "$n" -gt 0 ]; do out="${out}─"; n=$((n - 1)); done
  printf '%s' "$out"
}

pad_line() {
  local text=$1 plain
  plain=$(printf '%s' "$text" | sed 's/\x1b\[[0-9;]*m//g')
  printf '%s%s│%s %s%*s %s│%s\n' \
    '  ' "$C_BRAND" "$C_RESET" "$text" $((WIDTH - ${#plain} - 2)) '' "$C_BRAND" "$C_RESET"
}

box_top() { printf '%s%s╭%s╮%s\n' '  ' "$C_BRAND" "$(rule $WIDTH)" "$C_RESET"; }
box_bottom() { printf '%s%s╰%s╯%s\n' '  ' "$C_BRAND" "$(rule $WIDTH)" "$C_RESET"; }

banner() {
  printf '\n'
  pace 0.15
  box_top
  pad_line ""
  pace 0.2
  pad_line "$C_BRIGHT$C_BOLD  ORCHARD$C_RESET$C_DIM   self-hosted app platform$C_RESET"
  pad_line ""
  pace 0.35
  pad_line "$C_DIM  One box, one command. About 10 minutes on a clean machine.$C_RESET"
  pad_line ""
  box_bottom
  printf '\n'
  pace 0.5
}

show_plan() {
  printf '  %sWhat happens next%s\n' "$C_BOLD" "$C_RESET"
  pace 0.25
  local i=0
  while [ "$i" -lt "$STEP_TOTAL" ]; do
    printf '  %s%2d  %s%s\n' "$C_GREY" $((i + 1)) "${PLAN_TITLES[$i]}" "$C_RESET"
    pace 0.05
    i=$((i + 1))
  done
  printf '\n'
  pace 0.6
}

info() { printf '      %s%s%s\n' "$C_GREY" "$*" "$C_RESET"; }
note() { printf '      %s\n' "$*"; }
bold() { printf '  %s%s%s\n' "$C_BOLD" "$*" "$C_RESET"; }
warn() { printf '   %s!%s  %s%s%s\n' "$C_AMBER" "$C_RESET" "$C_AMBER" "$*" "$C_RESET" >&2; }
die() { printf '\n   %sx  %s%s\n\n' "$C_FAIL" "$*" "$C_RESET" >&2; exit 1; }

step() {
  local title left='' head
  title=${PLAN_TITLES[$STEP_N]}
  local cost=${PLAN_COSTS[$STEP_N]}
  STEP_N=$((STEP_N + 1))

  if [ "$REMAINING" -gt 45 ]; then left=" ${C_DIM}·${C_RESET} ${C_GREY}~$(fmt_secs "$REMAINING") left${C_RESET}"; fi
  head="  ${C_BRAND}${C_BOLD}${STEP_N}/${STEP_TOTAL}${C_RESET}  ${C_BOLD}${title}${C_RESET}"

  printf '\n%s\n' "$head"
  printf '  %s%s%s  %s%s elapsed%s%s\n' \
    "$C_BRAND" "$(rule 4)" "$C_RESET" "$C_GREY" "$(elapsed)" "$C_RESET" "$left"

  REMAINING=$((REMAINING - cost))
  if [ "$REMAINING" -lt 0 ]; then REMAINING=0; fi
}

run_step() {
  local label=$1 typical=$2
  shift 2
  local log t0 pid rc=0 i=0 beat=0 secs frame

  log=$(mktemp)
  t0=$(date +%s)

  "$@" >"$log" 2>&1 &
  pid=$!

  while kill -0 "$pid" 2>/dev/null; do
    secs=$(($(date +%s) - t0))
    if [ "$IS_TTY" = true ]; then
      frame=${SPINNER[$((i % ${#SPINNER[@]}))]}
      printf '\r      %s%s%s %s %s%s / ~%s%s\033[K' \
        "$C_BRIGHT" "$frame" "$C_RESET" "$label" "$C_GREY" "$(fmt_secs "$secs")" "$typical" "$C_RESET"
      i=$((i + 1))
    elif [ "$secs" -ge $((beat + 30)) ]; then
      beat=$secs
      printf '      .. %s  %s elapsed (typically %s)\n' "$label" "$(fmt_secs "$secs")" "$typical"
    fi
    sleep 0.1
  done

  wait "$pid" || rc=$?
  secs=$(($(date +%s) - t0))

  if [ "$rc" -ne 0 ]; then
    if [ "$IS_TTY" = true ]; then printf '\r\033[K'; fi
    printf '      %sx%s %s %sfailed after %s%s\n\n' \
      "$C_FAIL" "$C_RESET" "$label" "$C_FAIL" "$(fmt_secs "$secs")" "$C_RESET" >&2
    sed 's/^/        /' "$log" | tail -25 >&2
    printf '\n' >&2
    rm -f "$log"
    exit 1
  fi

  if [ "$IS_TTY" = true ]; then
    printf '\r      %s✓%s %s %s%s%s\033[K\n' \
      "$C_OK" "$C_RESET" "$label" "$C_GREY" "$(fmt_secs "$secs")" "$C_RESET"
  else
    printf '      ok %s (%s)\n' "$label" "$(fmt_secs "$secs")"
  fi
  rm -f "$log"
}

usage() {
  cat <<'EOF'

  Orchard installer

  Usage:
    install.sh [flags]

  Every flag has an environment variable equivalent. Flags win.

  How traffic gets in
    --mode <public|tunnel|lan>   ORCHARD_INGRESS_MODE   how the internet reaches this box
    --domain <host>              ORCHARD_DOMAIN         where the Orchard UI lives
    --app-domain <host>          ORCHARD_APP_DOMAIN     wildcard parent for deployed apps
    --email <address>            ORCHARD_ACME_EMAIL     Let's Encrypt contact, public mode
    --tunnel-token <token>       ORCHARD_TUNNEL_TOKEN   Cloudflare Tunnel token, tunnel mode

  Behaviour
    --updates <manual|automatic> ORCHARD_UPDATE_POLICY  run orchard-update yourself, or nightly
    --metrics <true|false>       ORCHARD_METRICS        built-in metrics stack, needs ~1G extra
                                                        (default: on with 8G+ RAM)
    --yes, -y                    ORCHARD_ASSUME_YES     never prompt, take every default
    --help, -h                                         show this and exit

  Versions and images
    --chart <ref>                ORCHARD_CHART          helm chart, OCI ref or local path
    --chart-version <semver>     ORCHARD_VERSION        pin the chart version
    --image-tag <tag>            ORCHARD_IMAGE_TAG      image tag for server and frontend
    --image-pull-policy <policy> ORCHARD_IMAGE_PULL_POLICY
    --image-registry <host>      ORCHARD_IMAGE_REGISTRY
    --image-repository <path>    ORCHARD_IMAGE_REPOSITORY

  Cluster
    --k3s-version <version>      K3S_VERSION
    --gateway-api-version <ver>  GATEWAY_API_VERSION
    --node-port-range <lo-hi>    ORCHARD_NODE_PORT_RANGE  ports apps can claim
    --registry-port <port>       ORCHARD_ZOT_NODE_PORT    must sit inside the range
    --registry-host <host>       ORCHARD_REGISTRY_HOST    name the kubelet pulls by
    --state-dir <path>           ORCHARD_STATE_DIR        where values.yaml is written

  Also honoured: NO_COLOR disables all colour, ORCHARD_NO_PACING=1 removes the
  brief pauses in the opening screen.

  Fully non-interactive example:

    ORCHARD_ASSUME_YES=true install.sh \
      --mode public \
      --domain orchard.example.com \
      --app-domain apps.example.com \
      --email me@example.com \
      --updates manual

EOF
}

need_value() {
  if [ -z "${2:-}" ]; then die "$1 needs a value"; fi
}

parse_args() {
  while [ $# -gt 0 ]; do
    case "$1" in
      --mode) need_value "$1" "${2:-}"; ORCHARD_INGRESS_MODE=$2; shift 2 ;;
      --domain) need_value "$1" "${2:-}"; ORCHARD_DOMAIN=$2; shift 2 ;;
      --app-domain) need_value "$1" "${2:-}"; ORCHARD_APP_DOMAIN=$2; shift 2 ;;
      --email) need_value "$1" "${2:-}"; ORCHARD_ACME_EMAIL=$2; shift 2 ;;
      --tunnel-token) need_value "$1" "${2:-}"; ORCHARD_TUNNEL_TOKEN=$2; shift 2 ;;
      --updates) need_value "$1" "${2:-}"; ORCHARD_UPDATE_POLICY=$2; shift 2 ;;
      --metrics) need_value "$1" "${2:-}"; ORCHARD_METRICS=$2; shift 2 ;;
      --chart) need_value "$1" "${2:-}"; CHART_REF=$2; shift 2 ;;
      --chart-version) need_value "$1" "${2:-}"; ORCHARD_VERSION=$2; shift 2 ;;
      --image-tag) need_value "$1" "${2:-}"; IMAGE_TAG=$2; shift 2 ;;
      --image-pull-policy) need_value "$1" "${2:-}"; IMAGE_PULL_POLICY=$2; shift 2 ;;
      --image-registry) need_value "$1" "${2:-}"; IMAGE_REGISTRY=$2; shift 2 ;;
      --image-repository) need_value "$1" "${2:-}"; IMAGE_REPOSITORY=$2; shift 2 ;;
      --k3s-version) need_value "$1" "${2:-}"; K3S_VERSION=$2; shift 2 ;;
      --gateway-api-version) need_value "$1" "${2:-}"; GATEWAY_API_VERSION=$2; shift 2 ;;
      --node-port-range) need_value "$1" "${2:-}"; NODE_PORT_RANGE=$2; shift 2 ;;
      --registry-port) need_value "$1" "${2:-}"; ZOT_NODE_PORT=$2; shift 2 ;;
      --registry-host) need_value "$1" "${2:-}"; REGISTRY_HOST=$2; shift 2 ;;
      --state-dir) need_value "$1" "${2:-}"; STATE_DIR=$2; VALUES_FILE="$STATE_DIR/values.yaml"; shift 2 ;;
      -y|--yes) ASSUME_YES=true; shift ;;
      -h|--help) usage; exit 0 ;;
      *) usage; die "unknown flag: $1" ;;
    esac
  done
}

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
  step

  [ "$(id -u)" -eq 0 ] || die "run as root (k3s needs it)"
  [ "$(uname -s)" = Linux ] || die "Linux only; this is $(uname -s)"

  case "$(uname -m)" in
    x86_64|amd64) ARCH=amd64 ;;
    *) die "amd64 only for now: image builds target linux/amd64, so apps built on a $(uname -m) box would not run on it" ;;
  esac
  info "architecture: $ARCH"

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
    if [ "$(ask 'Continue and create a new k3s cluster? (yes/no)' no)" != yes ]; then
      die "stopped so the existing cluster is left alone"
    fi
  fi

  if [ ! -f /sys/fs/cgroup/cgroup.controllers ]; then
    warn "cgroup v2 not detected; resource limits may not be enforced"
  fi

  if [ -w /dev/kvm ]; then
    info "KVM present (VM-isolated builds available as an opt-in later)"
  fi

  local lo=${NODE_PORT_RANGE%-*} hi=${NODE_PORT_RANGE#*-}
  if [ "$ZOT_NODE_PORT" -lt "$lo" ] || [ "$ZOT_NODE_PORT" -gt "$hi" ]; then
    die "ORCHARD_ZOT_NODE_PORT ($ZOT_NODE_PORT) must fall inside ORCHARD_NODE_PORT_RANGE ($NODE_PORT_RANGE)"
  fi
  info "node ports: $NODE_PORT_RANGE, registry on $ZOT_NODE_PORT"
}

detect_network() {
  step

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
  step

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
  if [ "$ASSUME_YES" = true ]; then return 0; fi
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

k3s_download() {
  curl -sfL https://get.k3s.io | INSTALL_K3S_VERSION="$K3S_VERSION" sh -s - server \
    --disable=traefik \
    --write-kubeconfig-mode=644 \
    --service-node-port-range="$NODE_PORT_RANGE"
}

wait_for_node() {
  local tries=0
  until [ "$(kubectl get nodes --no-headers 2>/dev/null | wc -l)" -gt 0 ]; do
    tries=$((tries + 1))
    if [ $tries -ge 90 ]; then
      journalctl -u k3s --no-pager -n 30 2>/dev/null \
        | grep -aiE 'level=(error|fatal)|server is not ready' | tail -3 >&2
      return 1
    fi
    sleep 2
  done
  kubectl wait --for=condition=Ready node --all --timeout=180s >/dev/null
}

install_k3s() {
  step

  if command -v k3s >/dev/null 2>&1; then
    info "k3s already installed, leaving it alone"
  else
    run_step "downloading and starting k3s" 1m k3s_download
  fi

  export KUBECONFIG=/etc/rancher/k3s/k3s.yaml
  run_step "waiting for the node to be ready" 30s wait_for_node
}

helm_download() {
  curl -fsSL https://raw.githubusercontent.com/helm/helm/main/scripts/get-helm-3 | bash
}

ensure_helm() {
  step
  if command -v helm >/dev/null 2>&1; then
    info "helm already installed"
    return
  fi
  run_step "downloading helm" 20s helm_download
}

YQ_VERSION=${YQ_VERSION:-v4.44.3}

yq_download() {
  curl -fsSL -o /usr/local/bin/yq \
    "https://github.com/mikefarah/yq/releases/download/${YQ_VERSION}/yq_linux_${ARCH}"
  chmod +x /usr/local/bin/yq
}

# Backs orchard-config. Editing the values file by hand is the alternative, and
# a stray indent there breaks the next upgrade rather than the edit.
ensure_yq() {
  if command -v yq >/dev/null 2>&1; then
    return
  fi
  run_step "downloading yq" 20s yq_download
}

add_helm_repos() {
  helm repo add traefik https://traefik.github.io/charts >/dev/null 2>&1 || true
  helm repo add cnpg https://cloudnative-pg.github.io/charts >/dev/null 2>&1 || true
  helm repo add jetstack https://charts.jetstack.io >/dev/null 2>&1 || true
  helm repo update >/dev/null
}

install_operators() {
  step

  run_step "Gateway API CRDs" 15s \
    kubectl apply -f "https://github.com/kubernetes-sigs/gateway-api/releases/download/$GATEWAY_API_VERSION/standard-install.yaml"

  run_step "fetching chart repositories" 20s add_helm_repos

  run_step "Traefik" 1m30s helm upgrade --install traefik traefik/traefik \
    --namespace traefik --create-namespace \
    --set providers.kubernetesGateway.enabled=true \
    --set gateway.enabled=false \
    --wait --timeout 10m

  run_step "CloudNativePG" 1m helm upgrade --install cnpg cnpg/cloudnative-pg \
    --namespace cnpg-system --create-namespace \
    --wait --timeout 10m

  if [ -n "$CERT_ISSUER" ]; then
    run_step "cert-manager" 1m30s helm upgrade --install cert-manager jetstack/cert-manager \
      --namespace cert-manager --create-namespace \
      --set crds.enabled=true \
      --wait --timeout 10m
    install_cluster_issuer
  else
    info "cert-manager skipped, TLS terminates at the tunnel"
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
  step

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
  run_step "reloading k3s with the registry mirror" 45s restart_k3s
  run_step "starting the registry" 2m \
    kubectl -n orchard rollout status deploy/zot --timeout=5m
  info "registry ready at $REGISTRY_HOST, mirrored to 127.0.0.1:$ZOT_NODE_PORT"
}

restart_k3s() {
  systemctl restart k3s
  local tries=0
  until kubectl get --raw /readyz >/dev/null 2>&1; do
    tries=$((tries + 1))
    [ $tries -lt 90 ] || return 1
    sleep 2
  done
}

install_tunnel() {
  step
  if [ "$INGRESS_MODE" != tunnel ]; then
    info "not needed in $INGRESS_MODE mode"
    return 0
  fi

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
  run_step "connecting the tunnel" 30s \
    kubectl -n cloudflared rollout status deploy/cloudflared --timeout=5m
}

size_workloads() {
  if [ "$MEM_MB" -ge 15000 ]; then MAX_BUILDS=3
  elif [ "$MEM_MB" -ge 7500 ]; then MAX_BUILDS=2
  else MAX_BUILDS=1
  fi

  BUILD_CACHE_GB=$((DISK_GB / 5))
  if [ "$BUILD_CACHE_GB" -gt 60 ]; then BUILD_CACHE_GB=60; fi
  if [ "$BUILD_CACHE_GB" -lt 5 ]; then BUILD_CACHE_GB=5; fi

  REGISTRY_SIZE_GB=$((DISK_GB / 5))
  if [ "$REGISTRY_SIZE_GB" -gt 50 ]; then REGISTRY_SIZE_GB=50; fi
  if [ "$REGISTRY_SIZE_GB" -lt 5 ]; then REGISTRY_SIZE_GB=5; fi

  # The metrics stack (VictoriaMetrics + vmagent + exporters) is the largest
  # idle cost in the chart. On a small box that budget is better spent on
  # actually running apps, so default it off and let --metrics force it on.
  if [ -z "$ORCHARD_METRICS" ]; then
    if [ "$MEM_MB" -ge 7500 ]; then ORCHARD_METRICS=true; else ORCHARD_METRICS=false; fi
  fi

  info "concurrent builds: $MAX_BUILDS, build cache: ${BUILD_CACHE_GB}G, registry: ${REGISTRY_SIZE_GB}G, metrics: $ORCHARD_METRICS"
}

# Pull a server env value out of the values file a previous run wrote, so a
# re-run preserves it instead of rotating it.
reuse_secret() {
  local name=$1 value
  [ -f "$VALUES_FILE" ] || return 0
  command -v yq >/dev/null 2>&1 || return 0
  value=$(yq -r ".server.env[]? | select(.name == \"$name\") | .value" "$VALUES_FILE" 2>/dev/null | head -1)
  [ "$value" = null ] && value=
  printf '%s' "$value"
}

write_values() {
  step

  mkdir -p "$STATE_DIR"
  chmod 700 "$STATE_DIR"

  local scheme=http entrypoint=web tls_enabled=false tls_issuer=
  if [ "$USE_TLS" = true ]; then
    scheme=https; entrypoint=websecure; tls_enabled=true
    # Without this the IngressRoute gets a bare `tls:` block and Traefik
    # terminates with its self-signed TRAEFIK DEFAULT CERT, which every browser
    # rejects. The chart issues the real one against the ClusterIssuer above.
    tls_issuer="
    issuerRef:
      name: $CERT_ISSUER
      kind: ClusterIssuer"
  fi
  if [ "$INGRESS_MODE" = tunnel ]; then scheme=https; fi

  local cookie_secure=true
  if [ "$scheme" = http ]; then cookie_secure=false; fi

  # Re-running the installer is the supported way to pick up new host commands,
  # and it rewrites this file wholesale. Minting fresh secrets would log every
  # user out, and worse, a new SECRETS_ENCRYPTION_KEY makes every secret already
  # stored in the database permanently undecryptable. Carry them over.
  JWT_SECRET=$(reuse_secret JWT_SECRET)
  ENCRYPTION_KEY=$(reuse_secret SECRETS_ENCRYPTION_KEY)
  SSO_KEY=$(reuse_secret SSO_STATE_SECRET)
  [ -n "$JWT_SECRET" ] || JWT_SECRET=$(head -c 32 /dev/urandom | base64 | tr -d '\n=' | head -c 43)
  [ -n "$ENCRYPTION_KEY" ] || ENCRYPTION_KEY=$(head -c 24 /dev/urandom | base64 | tr -d '\n=' | head -c 32)
  [ -n "$SSO_KEY" ] || SSO_KEY=$(head -c 24 /dev/urandom | base64 | tr -d '\n=' | head -c 32)

  cat > "$VALUES_FILE" <<EOF
# Generated by install/install.sh. Edit and re-run 'orchard-update' to apply.
createNamespace: false

image:
  registry: $IMAGE_REGISTRY
  repository: $IMAGE_REPOSITORY
  pullPolicy: $IMAGE_PULL_POLICY

signupMode: invite_only
datadog:
  enabled: false

frontend:
  replicas: 1
  image:
    tag: $IMAGE_TAG
  env:
    - { name: PUBLIC_APP_DOMAIN, value: $ORCHARD_APP_DOMAIN }
    - { name: PUBLIC_OAUTH_PROVIDER, value: none }

server:
  replicas: 1
  image:
    tag: $IMAGE_TAG
  env:
    - { name: JWT_SECRET, value: "$JWT_SECRET" }
    - { name: SECRETS_ENCRYPTION_KEY, value: "$ENCRYPTION_KEY" }
    - { name: SSO_ENCRYPTION_KEY, value: "$SSO_KEY" }
    - { name: APP_DOMAIN, value: $ORCHARD_APP_DOMAIN }
    - { name: FRONTEND_URL, value: $scheme://$ORCHARD_DOMAIN }
    - { name: SESSION_COOKIE_SECURE, value: "$cookie_secure" }
    - { name: MAX_CONCURRENT_BUILDS, value: "$MAX_BUILDS" }
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
    enabled: $tls_enabled$tls_issuer

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
  enabled: $ORCHARD_METRICS
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
  step

  kubectl create namespace network >/dev/null 2>&1 || true

  local args=(upgrade --install orchard "$CHART_REF"
    --namespace orchard --create-namespace
    -f "$VALUES_FILE" --timeout 20m)
  if [ -n "$ORCHARD_VERSION" ]; then args+=(--version "$ORCHARD_VERSION"); fi

  run_step "applying the chart" 40s helm "${args[@]}"
  run_step "postgres" 3m kubectl -n orchard wait --for=condition=Ready \
    cluster.postgresql.cnpg.io/orchard-db --timeout=10m
  run_step "redis" 30s kubectl -n orchard rollout status deploy/redis --timeout=5m
  run_step "the api" 3m kubectl -n orchard rollout status deploy/server --timeout=10m
  run_step "the web app" 1m kubectl -n orchard rollout status deploy/frontend --timeout=5m
}

install_updater() {
  step

  # Runtime paths for the host commands, which ship as static files inside the
  # server image rather than being generated here with these baked in.
  cat > "$STATE_DIR/env" <<EOF
ORCHARD_VALUES=$VALUES_FILE
ORCHARD_CHART=$CHART_REF
ORCHARD_NAMESPACE=orchard
EOF
  chmod 600 "$STATE_DIR/env"

  # Bootstrap: lift the sync script out of the image by hand, then let it
  # install the rest. Keeps one copy of each command in the repo instead of a
  # second set embedded here that drifts out of step with it.
  local boot
  boot=$(mktemp)

  if kubectl -n orchard exec deploy/server -- cat /app/hostbin/orchard-sync-commands > "$boot" 2>/dev/null \
     && [ -s "$boot" ]; then
    # awk -v cannot carry a multi-line value, so the preamble is printed line
    # by line here, the same way orchard-sync-commands does it.
    awk -v pre="$STATE_DIR" '
      /^#PREAMBLE#$/ {
        print ": \"${ORCHARD_STATE_DIR:=" pre "}\""
        print "[ -r \"$ORCHARD_STATE_DIR/env\" ] && . \"$ORCHARD_STATE_DIR/env\""
        print ": \"${ORCHARD_VALUES:=$ORCHARD_STATE_DIR/values.yaml}\""
        print ": \"${ORCHARD_CHART:=oci://ghcr.io/hackclub/orchard/charts/orchard}\""
        print ": \"${ORCHARD_NAMESPACE:=orchard}\""
        print "export KUBECONFIG=\"${KUBECONFIG:-/etc/rancher/k3s/k3s.yaml}\""
        next
      }
      { print }
    ' "$boot" > "$boot.r"
    install -m 0755 "$boot.r" /usr/local/bin/orchard-sync-commands
    rm -f "$boot" "$boot.r"
    if ORCHARD_STATE_DIR="$STATE_DIR" orchard-sync-commands >/dev/null; then
      info "host commands installed (orchardctl)"
    else
      warn "could not install the host commands; run orchard-sync-commands later"
    fi
  else
    rm -f "$boot"
    warn "could not read the host commands from the server pod; skipping"
  fi

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
    info "run 'sudo orchardctl update' to upgrade"
  fi
}

summary() {
  local scheme=https
  if [ "$USE_TLS" = false ]; then [ "$INGRESS_MODE" != tunnel ] && scheme=http; fi

  step

  printf '\n'
  box_top
  pad_line ""
  pad_line "$C_BRIGHT$C_BOLD  Orchard is ready$C_RESET$C_GREY   installed in $(elapsed)$C_RESET"
  pad_line ""
  pad_line "  ${C_GREY}Dashboard${C_RESET}  $scheme://$ORCHARD_DOMAIN"
  pad_line "  ${C_GREY}Your apps${C_RESET}  *.$ORCHARD_APP_DOMAIN"
  pad_line ""
  pad_line "  ${C_GREY}Upgrade${C_RESET}    sudo orchardctl update"
  pad_line "  ${C_GREY}Settings${C_RESET}   sudo orchardctl config set <path> <value> --apply"
  pad_line "  ${C_GREY}Logs${C_RESET}       orchardctl logs"
  pad_line "  ${C_GREY}Config${C_RESET}     $VALUES_FILE"
  pad_line ""
  box_bottom

  printf '\n  %sOne more step%s\n' "$C_BOLD" "$C_RESET"
  note "Open the claim link below to create the first account and sign in."
  note "There is no email to wait for: the link is the credential."
  printf '\n'
  if claim_link=$(orchard-claim 2>/dev/null | grep -E '^\s+http'); then
    printf '      %s%s%s\n' "$C_BRIGHT" "$(echo "$claim_link" | tr -d ' ')" "$C_RESET"
  else
    printf '      %ssudo orchardctl claim%s\n' "$C_BRIGHT" "$C_RESET"
  fi
  printf '\n'
  note "Add a passkey as soon as you are in — with no SMTP configured it is"
  note "the only way to sign back in. Run 'sudo orchardctl claim' for a link."
  printf '\n'

  if [ "$INGRESS_MODE" = tunnel ]; then
    warn "Tunnel mode carries HTTP only, so public databases and raw TCP ports are off."
  fi
  warn "Builds run with host-level privileges. Only give build access to people you trust."
  printf '\n'
}

main() {
  parse_args "$@"
  local i=0
  REMAINING=0
  while [ "$i" -lt "$STEP_TOTAL" ]; do
    REMAINING=$((REMAINING + PLAN_COSTS[i]))
    i=$((i + 1))
  done

  banner
  show_plan
  preflight
  detect_network
  choose_ingress_mode
  collect_domains
  choose_update_policy
  size_workloads
  install_k3s
  ensure_helm
  ensure_yq
  install_operators
  install_registry
  install_tunnel
  write_values
  install_orchard
  install_updater
  summary
}

if [ "${ORCHARD_LIB_ONLY:-}" != "1" ]; then
  main "$@"
fi
