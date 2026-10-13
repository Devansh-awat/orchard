#!/usr/bin/env bash
set -euo pipefail

ORCHARD_VERSION=${ORCHARD_VERSION:-}
CHART_REF=${ORCHARD_CHART:-oci://ghcr.io/hackclub/orchard/charts/orchard}
IMAGE_REGISTRY=${ORCHARD_IMAGE_REGISTRY:-ghcr.io}
IMAGE_REPOSITORY=${ORCHARD_IMAGE_REPOSITORY:-hackclub/orchard}
STATE_DIR=${ORCHARD_STATE_DIR:-/etc/orchard}
VALUES_FILE="$STATE_DIR/values.yaml"

K3S_VERSION=${K3S_VERSION:-v1.31.5+k3s1}
HELM_VERSION=${HELM_VERSION:-v4.3.0}
GATEWAY_API_VERSION=${GATEWAY_API_VERSION:-v1.2.1}
NODE_PORT_RANGE=${ORCHARD_NODE_PORT_RANGE:-30000-30100}
HTTP_PORT=${ORCHARD_HTTP_PORT:-80}
HTTPS_PORT=${ORCHARD_HTTPS_PORT:-443}
HTTP_SUFFIX=''
HTTPS_SUFFIX=''
INGRESS_EXTRA_HOSTS='[]'
REGISTRY_PORT=${ORCHARD_REGISTRY_PORT:-5000}
REGISTRY_USER=orchard
REGISTRY_PASSWORD=''
REGISTRY_HOST=${ORCHARD_REGISTRY_HOST:-registry.orchard.local}

ORCHARD_DOMAIN=${ORCHARD_DOMAIN:-}
ORCHARD_APP_DOMAIN=${ORCHARD_APP_DOMAIN:-}
ORCHARD_ACME_EMAIL=${ORCHARD_ACME_EMAIL:-}
ORCHARD_INGRESS_MODE=${ORCHARD_INGRESS_MODE:-}
ORCHARD_TUNNEL_TOKEN=${ORCHARD_TUNNEL_TOKEN:-}
ORCHARD_UPDATE_POLICY=${ORCHARD_UPDATE_POLICY:-}
ORCHARD_METRICS=${ORCHARD_METRICS:-}
ORCHARD_MCP=${ORCHARD_MCP:-true}
ORCHARD_MCP_DOMAIN=${ORCHARD_MCP_DOMAIN:-}
ASSUME_YES=${ORCHARD_ASSUME_YES:-false}
INSTALL_URL=${ORCHARD_INSTALL_URL:-https://assets.orchard.my/install.sh}
PROMPT_TIMEOUT=${ORCHARD_PROMPT_TIMEOUT:-900}
PROMPT_FD_OPEN=false
PORTS_BUSY=''
PORTS_BUSY_DETAIL=''
PROMPT_BLOCKED=''
PROMPT_HINT_SHOWN=false

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
# $$ stays the top-level pid inside a subshell, BASHPID does not: a die() from
# inside a command substitution (ask, mostly) has to take the whole install with
# it rather than just returning an empty answer to the caller.
die() {
  printf '\n   %sx  %s%s\n\n' "$C_FAIL" "$*" "$C_RESET" >&2
  if [ "${BASHPID:-$$}" != "$$" ]; then kill -s TERM "$$" 2>/dev/null || true; fi
  exit 1
}
trap 'exit 1' TERM

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
    --mcp-domain <host>          ORCHARD_MCP_DOMAIN     where agents connect over MCP
                                                        (default: mcp.<your domain>)
    --email <address>            ORCHARD_ACME_EMAIL     Let's Encrypt contact, public mode
    --tunnel-token <token>       ORCHARD_TUNNEL_TOKEN   Cloudflare Tunnel token, tunnel mode
    --http-port <port>           ORCHARD_HTTP_PORT      where Traefik listens, lan mode only
                                                        (default: 80)
    --https-port <port>          ORCHARD_HTTPS_PORT     the same for TLS (default: 443)

  Behaviour
    --updates <manual|automatic> ORCHARD_UPDATE_POLICY  run orchard-update yourself, or nightly
    --metrics <true|false>       ORCHARD_METRICS        built-in metrics stack, needs ~1G extra
                                                        (default: on with 8G+ RAM)
    --mcp <true|false>           ORCHARD_MCP            the MCP endpoint agents connect to
                                                        (default: on)
    --yes, -y                    ORCHARD_ASSUME_YES     never prompt, take every default
                                 ORCHARD_PROMPT_TIMEOUT seconds to wait on a question before
                                                        giving up (default: 900, 0 waits forever)
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
                                 HELM_VERSION           helm release to install (default: v4.3.0)
    --gateway-api-version <ver>  GATEWAY_API_VERSION
    --node-port-range <lo-hi>    ORCHARD_NODE_PORT_RANGE  ports apps can claim
    --registry-port <port>       ORCHARD_REGISTRY_PORT    loopback port the kubelet pulls through
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
      --mcp-domain) need_value "$1" "${2:-}"; ORCHARD_MCP_DOMAIN=$2; shift 2 ;;
      --mcp) need_value "$1" "${2:-}"; ORCHARD_MCP=$2; shift 2 ;;
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
    --http-port) need_value "$1" "${2:-}"; HTTP_PORT=$2; shift 2 ;;
    --https-port) need_value "$1" "${2:-}"; HTTPS_PORT=$2; shift 2 ;;
      --registry-port) need_value "$1" "${2:-}"; REGISTRY_PORT=$2; shift 2 ;;
      --registry-host) need_value "$1" "${2:-}"; REGISTRY_HOST=$2; shift 2 ;;
      --state-dir) need_value "$1" "${2:-}"; STATE_DIR=$2; VALUES_FILE="$STATE_DIR/values.yaml"; shift 2 ;;
      -y|--yes) ASSUME_YES=true; shift ;;
      -h|--help) usage; exit 0 ;;
      *) usage; die "unknown flag: $1" ;;
    esac
  done
}

# Fields of /proc/<pid>/stat, counted after the pid and the (comm) that may
# contain anything: 2 is the parent, 5 is the controlling terminal.
proc_stat_field() {
  local pid=$1 n=$2
  [ -r "/proc/$pid/stat" ] || return 1
  awk -v n="$n" '{ sub(/^[0-9]+ \(.*\) /, ""); print $n }' "/proc/$pid/stat" 2>/dev/null
}

# `curl | sudo bash` looks like it is working and is not: the question appears,
# the keystrokes echo, and nothing ever arrives. sudo 1.9.14 and newer run the
# command in a pty of their own (use_pty, on by default on Ubuntu 24.04), that
# pty is our /dev/tty, and because sudo's own stdin is the pipe carrying this
# script it never relays the real terminal into it. The tell is an ancestor
# sitting on a different terminal than ours; nobody is typing into ours.
tty_is_the_one_being_typed_into() {
  local ours pid t hops=0
  ours=$(proc_stat_field $$ 5) || return 0
  [ -n "$ours" ] && [ "$ours" != 0 ] || return 0
  pid=$(proc_stat_field $$ 2) || return 0
  while [ "$hops" -lt 12 ]; do
    case "$pid" in ''|*[!0-9]*) return 0 ;; esac
    [ "$pid" -gt 1 ] || return 0
    t=$(proc_stat_field "$pid" 5) || return 0
    [ -n "$t" ] || return 0
    if [ "$t" != 0 ] && [ "$t" != "$ours" ]; then return 1; fi
    pid=$(proc_stat_field "$pid" 2) || return 0
    hops=$((hops + 1))
  done
  return 0
}

# Questions go over fd 3: stdin is usually this script itself, and /dev/tty is
# only worth reading when it is the terminal someone is actually typing into.
open_prompt_fd() {
  if [ -t 0 ]; then
    { if exec 3<&0; then PROMPT_FD_OPEN=true; fi; } 2>/dev/null
    if [ "$PROMPT_FD_OPEN" = true ]; then return 0; fi
  fi

  if ! tty_is_the_one_being_typed_into; then
    PROMPT_BLOCKED="this is running on a terminal of its own, so your keystrokes cannot reach it"
    return 1
  fi

  { if exec 3</dev/tty; then PROMPT_FD_OPEN=true; fi; } 2>/dev/null
  if [ "$PROMPT_FD_OPEN" != true ]; then
    PROMPT_BLOCKED="no terminal to read an answer from"
    return 1
  fi
}

prompt_hint() {
  {
    printf '\n      %sOrchard has a few questions before it installs anything.%s\n' "$C_GREY" "$C_RESET"
    printf '      %sRun it with your terminal attached:%s\n' "$C_GREY" "$C_RESET"
    # shellcheck disable=SC2016  # the $( ) is part of the command we are printing
    printf '        sudo bash -c "$(curl -fsSL %s)"\n' "$INSTALL_URL"
    printf '      %sor answer nothing and take every default:%s\n' "$C_GREY" "$C_RESET"
    printf '        curl -fsSL %s | sudo bash -s -- --yes\n' "$INSTALL_URL"
    printf '\n'
  } >&2
}

ask() {
  local prompt=$1 default=${2:-} answer='' rc=0
  if [ "$ASSUME_YES" = true ]; then printf '%s' "$default"; return; fi

  if [ "$PROMPT_FD_OPEN" != true ]; then
    warn "cannot ask '$prompt': ${PROMPT_BLOCKED:-no terminal to read an answer from}"
    if [ "$PROMPT_HINT_SHOWN" != true ]; then prompt_hint; fi
    die "nothing has been installed yet; nothing to undo"
  fi

  # Ignored rather than default: a read from a background process group then
  # fails with EIO instead of stopping us where nobody can see it.
  trap '' TTIN TTOU

  if [ -n "$default" ]; then
    printf '%s [%s]: ' "$prompt" "$default" >&2
  else
    printf '%s: ' "$prompt" >&2
  fi

  if [ "$PROMPT_TIMEOUT" -gt 0 ]; then
    IFS= read -r -t "$PROMPT_TIMEOUT" answer <&3 2>/dev/null || rc=$?
  else
    IFS= read -r answer <&3 2>/dev/null || rc=$?
  fi
  trap - TTIN TTOU

  if [ "$rc" -ne 0 ]; then
    printf '\n' >&2
    if [ "$rc" -gt 128 ]; then
      warn "no answer after $(fmt_secs "$PROMPT_TIMEOUT"); giving up on the question"
    else
      warn "could not read an answer from this terminal"
    fi
    prompt_hint
    die "nothing has been installed yet; nothing to undo"
  fi

  answer=${answer%$'\r'}
  answer=${answer#"${answer%%[![:space:]]*}"}
  answer=${answer%"${answer##*[![:space:]]}"}
  printf '%s' "${answer:-$default}"
}

preflight() {
  step

  [ "$(id -u)" -eq 0 ] || die "run as root (k3s needs it)"
  [ "$(uname -s)" = Linux ] || die "Linux only; this is $(uname -s)"

  case "$(uname -m)" in
    x86_64|amd64) ARCH=amd64 ;;
    aarch64|arm64) ARCH=arm64 ;;
    *) die "amd64 or arm64 only; this is $(uname -m)" ;;
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

  local port
  for port in "$HTTP_PORT" "$HTTPS_PORT"; do
    case "$port" in ''|*[!0-9]*) die "ports are numbers, not: $port" ;; esac
    { [ "$port" -ge 1 ] && [ "$port" -le 65535 ]; } || die "port out of range: $port"
  done
  [ "$HTTP_PORT" != "$HTTPS_PORT" ] || die "--http-port and --https-port cannot both be $HTTP_PORT"
  [ "$HTTP_PORT" = 80 ] || HTTP_SUFFIX=":$HTTP_PORT"
  [ "$HTTPS_PORT" = 443 ] || HTTPS_SUFFIX=":$HTTPS_PORT"

  # Not fatal here: tunnel mode never binds either port, and the mode is not
  # chosen until the next step. choose_ingress_mode stops the run if the mode
  # that gets picked does need them.
  if command -v ss >/dev/null 2>&1; then
    local holder
    for port in "$HTTP_PORT" "$HTTPS_PORT"; do
      if ss -lnt "sport = :$port" 2>/dev/null | grep -q LISTEN; then
        holder=$(ss -lntp "sport = :$port" 2>/dev/null | tail -1 | sed 's/^ *//')
        PORTS_BUSY="${PORTS_BUSY:+$PORTS_BUSY and }$port"
        PORTS_BUSY_DETAIL="${PORTS_BUSY_DETAIL}      $holder"$'\n'
      fi
    done
    if [ -n "$PORTS_BUSY" ]; then
      warn "port $PORTS_BUSY already in use:"
      printf '%s' "$PORTS_BUSY_DETAIL" >&2
    else
      info "ports $HTTP_PORT/$HTTPS_PORT are free"
    fi
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
  for port in "$HTTP_PORT" "$HTTPS_PORT" "$REGISTRY_PORT"; do
    if [ "$port" -ge "$lo" ] && [ "$port" -le "$hi" ]; then
      die "port $port falls inside ORCHARD_NODE_PORT_RANGE ($NODE_PORT_RANGE), where Kubernetes hands out its own"
    fi
  done
  if command -v ss >/dev/null 2>&1 && ss -lnt "sport = :$REGISTRY_PORT" 2>/dev/null | grep -q LISTEN; then
    if ! kubectl -n orchard get deploy zot >/dev/null 2>&1; then
      die "port $REGISTRY_PORT is already in use on this box; pick another with --registry-port"
    fi
  fi
  info "node ports: $NODE_PORT_RANGE, registry on 127.0.0.1:$REGISTRY_PORT"
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
    if [ -n "$PORTS_BUSY" ]; then
      echo
      note "port $PORTS_BUSY is taken on this box, and public and lan both need it."
      note "public sends the Let's Encrypt HTTP-01 challenge to 80, for every"
      note "hostname and every renewal, and the ACME spec fixes that port. lan"
      note "serves the dashboard there in plain HTTP. Tunnel mode needs neither"
      note "80 nor 443, because cloudflared dials out from inside the cluster."
      echo
    fi
    local default attempt=0
    default=$([ "$BEHIND_NAT" = true ] && echo 2 || echo 1)
    INGRESS_MODE=''
    while [ -z "$INGRESS_MODE" ] && [ "$attempt" -lt 5 ]; do
      attempt=$((attempt + 1))
      case "$(ask 'Choose' "$default")" in
        1|public) INGRESS_MODE=public ;;
        2|tunnel) INGRESS_MODE=tunnel ;;
        3|lan) INGRESS_MODE=lan ;;
        *) warn "pick 1, 2 or 3" ;;
      esac
    done
    [ -n "$INGRESS_MODE" ] || die "invalid choice"
  fi
  info "ingress mode: $INGRESS_MODE"

  case "$INGRESS_MODE" in
    public|tunnel|lan) ;;
    *) die "unknown ingress mode: $INGRESS_MODE" ;;
  esac

  if [ "$INGRESS_MODE" != lan ] && { [ "$HTTP_PORT" != 80 ] || [ "$HTTPS_PORT" != 443 ]; }; then
    case "$INGRESS_MODE" in
      public)
        warn "public mode cannot move off 80 and 443."
        note "80 is fixed by the ACME spec for the HTTP-01 challenge, and a browser"
        note "reaching an app on anything but 443 has to be told the port by hand."
        die "custom ports are lan only" ;;
      tunnel)
        warn "tunnel mode binds no host port at all, so there is nothing to move."
        die "custom ports are lan only" ;;
    esac
  fi

  if [ -n "$PORTS_BUSY" ] && [ "$INGRESS_MODE" != tunnel ]; then
    warn "$INGRESS_MODE mode needs 80 and 443 on this box, and port $PORTS_BUSY is taken:"
    printf '%s' "$PORTS_BUSY_DETAIL" >&2
    note "Free it, move whatever holds it, or install in tunnel mode"
    note "(--mode tunnel), which binds nothing on this box."
    die "stopped before installing anything"
  fi
}

# Every other name this box answers to, so Traefik routes on all of them rather
# than 404ing on the one the person actually typed. Its own IPs (including the
# Tailscale one), its hostname, its mDNS name, and the sslip.io name earlier
# versions used.
lan_alt_hosts() {
  local out='' seen=' ' candidate short
  short=$(hostname 2>/dev/null | cut -d. -f1 || true)
  for candidate in $LOCAL_IPS $short ${short:+$short.local} \
    "orchard.${PRIMARY_IP//./-}.sslip.io"; do
    [ -n "$candidate" ] || continue
    [ "$candidate" != "$ORCHARD_DOMAIN" ] || continue
    case "$seen" in *" $candidate "*) continue ;; esac
    seen="$seen$candidate "
    out="${out:+$out, }\"$candidate\""
  done
  printf '[%s]' "$out"
}

collect_domains() {
  step

  case "$ORCHARD_MCP" in
    true|false) ;;
    *) die "--mcp takes true or false, not: $ORCHARD_MCP" ;;
  esac

  if [ "$INGRESS_MODE" = lan ]; then
    # The dashboard answers on this box's own address, so nothing has to resolve
    # for it: sslip.io is public DNS, and a resolver that will not answer for a
    # private address (Tailscale's, most often) leaves an install nobody can
    # reach. Apps still need a wildcard, which an IP cannot have, so their
    # generated hostnames stay on sslip.io.
    ORCHARD_DOMAIN=${ORCHARD_DOMAIN:-${PRIMARY_IP:-localhost}}
    ORCHARD_APP_DOMAIN=${ORCHARD_APP_DOMAIN:-apps.${PRIMARY_IP//./-}.sslip.io}
    ORCHARD_MCP_DOMAIN=${ORCHARD_MCP_DOMAIN:-mcp.${PRIMARY_IP//./-}.sslip.io}
    USE_TLS=false
    CERT_ISSUER=selfsigned
    INGRESS_EXTRA_HOSTS=$(lan_alt_hosts)
    info "platform: http://$ORCHARD_DOMAIN$HTTP_SUFFIX"
    local alts
    alts=$(printf '%s' "$INGRESS_EXTRA_HOSTS" | tr -d '[]"')
    [ -z "$alts" ] || info "also at:  $alts"
    info "apps:     *.$ORCHARD_APP_DOMAIN$HTTPS_SUFFIX"
    if [ "$ORCHARD_MCP" = true ]; then info "agents:   http://$ORCHARD_MCP_DOMAIN$HTTP_SUFFIX"; fi
    return
  fi

  [ -n "$ORCHARD_DOMAIN" ] || ORCHARD_DOMAIN=$(ask "Domain for the Orchard UI (e.g. orchard.example.com)")
  [ -n "$ORCHARD_DOMAIN" ] || die "a domain is required for $INGRESS_MODE mode"

  local base=${ORCHARD_DOMAIN#*.}
  [ -n "$ORCHARD_APP_DOMAIN" ] || ORCHARD_APP_DOMAIN=$(ask "Wildcard domain for deployed apps" "apps.$base")
  # Not asked for: the MCP is on by default and one more prompt to skip past
  # buys nothing. --mcp-domain moves it, --mcp false removes it.
  [ -n "$ORCHARD_MCP_DOMAIN" ] || ORCHARD_MCP_DOMAIN="mcp.$base"

  USE_TLS=true
  CERT_ISSUER=letsencrypt

  if [ "$INGRESS_MODE" = public ]; then
    [ -n "$ORCHARD_ACME_EMAIL" ] || ORCHARD_ACME_EMAIL=$(ask "Email for Let's Encrypt notices")
    [ -n "$ORCHARD_ACME_EMAIL" ] || die "Let's Encrypt needs a contact email"

    echo
    bold "Point these records at ${PUBLIC_IP:-this box} before continuing:"
    local records=("$ORCHARD_DOMAIN" "*.$ORCHARD_APP_DOMAIN")
    if [ "$ORCHARD_MCP" = true ]; then records+=("$ORCHARD_MCP_DOMAIN"); fi
    local width=0 record
    for record in "${records[@]}"; do
      if [ ${#record} -gt "$width" ]; then width=${#record}; fi
    done
    for record in "${records[@]}"; do
      printf '  A  %-*s -> %s\n' "$width" "$record" "${PUBLIC_IP:-<this box>}"
    done
    if [ "$ORCHARD_MCP" = true ]; then
      note "the last one is where AI agents connect. Skip it with --mcp false,"
      note "or move it with --mcp-domain. You will be asked about it either way."
    fi
    wait_for_dns "$ORCHARD_DOMAIN"
    confirm_mcp_dns
  else
    USE_TLS=false
    CERT_ISSUER=""
    [ -n "$ORCHARD_TUNNEL_TOKEN" ] || ORCHARD_TUNNEL_TOKEN=$(ask "Cloudflare Tunnel token")
    [ -n "$ORCHARD_TUNNEL_TOKEN" ] || die "a tunnel token is required for tunnel mode"
    echo
    bold "In the Cloudflare dashboard, route these hostnames to this tunnel:"
    local hosts=("$ORCHARD_DOMAIN" "*.$ORCHARD_APP_DOMAIN")
    if [ "$ORCHARD_MCP" = true ]; then hosts+=("$ORCHARD_MCP_DOMAIN"); fi
    local width=0 host
    for host in "${hosts[@]}"; do
      if [ ${#host} -gt "$width" ]; then width=${#host}; fi
    done
    for host in "${hosts[@]}"; do
      printf '  %-*s -> http://traefik.traefik.svc.cluster.local:80\n' "$width" "$host"
    done
  fi
}

# Not every base image ships getent, and "we could not check" must not be
# treated as "it is broken" — this answer decides whether the MCP is deployed
# at all, so a missing tool would silently drop it.
host_resolves() {
  local host=$1
  if command -v getent >/dev/null 2>&1; then
    if getent ahostsv4 "$host" >/dev/null 2>&1; then return 0; fi
    return 1
  fi
  if command -v dig >/dev/null 2>&1; then
    if [ -n "$(dig +short A "$host" 2>/dev/null)" ]; then return 0; fi
    return 1
  fi
  if command -v host >/dev/null 2>&1; then
    if host -t A "$host" >/dev/null 2>&1; then return 0; fi
    return 1
  fi
  return 0
}

# The MCP is the one hostname that is derived rather than asked for, so it is
# also the one an operator is most likely to have missed. A hostname that does
# not resolve is not a visible outage: its certificate is issued over HTTP-01,
# so cert-manager retries against a name that is not there and the endpoint
# stays quietly broken. Better to sort it out here, while someone is watching.
confirm_mcp_dns() {
  [ "$ORCHARD_MCP" = true ] || return 0
  [ "$INGRESS_MODE" = public ] || return 0
  if host_resolves "$ORCHARD_MCP_DOMAIN"; then
    info "$ORCHARD_MCP_DOMAIN resolves"
    return 0
  fi

  echo
  warn "$ORCHARD_MCP_DOMAIN does not resolve yet."
  note "That is where AI agents connect over MCP. Its certificate is issued"
  note "over HTTP-01, so it cannot be obtained until the name points here."
  echo

  if [ "$ASSUME_YES" = true ]; then
    warn "leaving the MCP off. Add the record, then run:"
    note "  sudo orchardctl mcp enable --apply"
    ORCHARD_MCP=false
    return 0
  fi

  # Bounded rather than `while true`: anyone who wants more attempts has
  # `orchardctl mcp enable` afterwards.
  local attempt=0
  while [ $attempt -lt 6 ]; do
    attempt=$((attempt + 1))
    bold "What would you like to do?"
    echo "  1) I have added the record now, check again"
    echo "  2) use a different hostname"
    echo "  3) skip the MCP for now, I will turn it on later"
    case "$(ask 'Choose' 1)" in
      1)
        if host_resolves "$ORCHARD_MCP_DOMAIN"; then
          info "$ORCHARD_MCP_DOMAIN resolves"
          return 0
        fi
        warn "still nothing. DNS can take a few minutes to propagate."
        ;;
      2)
        local candidate
        candidate=$(ask "Hostname for the MCP endpoint" "$ORCHARD_MCP_DOMAIN")
        case "$candidate" in
          ''|*' '*|*.*) ;;
          *) warn "that does not look like a hostname"; echo; continue ;;
        esac
        if [ -z "$candidate" ]; then
          warn "that is not a hostname"
          echo
          continue
        fi
        ORCHARD_MCP_DOMAIN=$candidate
        if host_resolves "$ORCHARD_MCP_DOMAIN"; then
          info "$ORCHARD_MCP_DOMAIN resolves"
          return 0
        fi
        warn "$ORCHARD_MCP_DOMAIN does not resolve either."
        note "Point it at ${PUBLIC_IP:-this box} with an A record."
        ;;
      3)
        warn "leaving the MCP off. Add the record, then run:"
        note "  sudo orchardctl mcp enable --apply"
        ORCHARD_MCP=false
        return 0
        ;;
      *) warn "pick 1, 2 or 3" ;;
    esac
    echo
  done

  warn "leaving the MCP off. Add the record, then run:"
  note "  sudo orchardctl mcp enable --apply"
  ORCHARD_MCP=false
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
      local attempt=0
      while [ -z "$ORCHARD_UPDATE_POLICY" ] && [ "$attempt" -lt 5 ]; do
        attempt=$((attempt + 1))
        case "$(ask 'Choose' 1)" in
          1|manual) ORCHARD_UPDATE_POLICY=manual ;;
          2|automatic) ORCHARD_UPDATE_POLICY=automatic ;;
          *) warn "pick 1 or 2" ;;
        esac
      done
      [ -n "$ORCHARD_UPDATE_POLICY" ] || die "invalid choice"
    fi
  fi
  info "update policy: $ORCHARD_UPDATE_POLICY"
}

k3s_download() {
  curl -sfL https://get.k3s.io | INSTALL_K3S_VERSION="$K3S_VERSION" sh -s - server \
    --disable=traefik \
    --write-kubeconfig-mode=600 \
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

lan_cidrs() {
  ip -4 route show scope link 2>/dev/null \
    | awk '$1 ~ /\// && $2 == "dev" && $3 !~ /^(cni|flannel|veth|docker|br-|lo|tailscale)/ {print $1}' \
    | sort -u
}

ufw_rules() {
  local lo=$1 hi=$2 cidr
  ufw allow from 10.42.0.0/16 to any comment 'k3s pods'
  ufw allow from 10.43.0.0/16 to any comment 'k3s services'
  for cidr in $(lan_cidrs) 100.64.0.0/10; do
    ufw allow from "$cidr" to any port 6443 proto tcp comment 'kubernetes api'
  done
  if [ "$INGRESS_MODE" != tunnel ]; then
    ufw allow "$HTTP_PORT/tcp" comment 'orchard http'
    ufw allow "$HTTPS_PORT/tcp" comment 'orchard https'
    ufw allow "$lo:$hi/tcp" comment 'orchard app ports'
    ufw allow "$lo:$hi/udp" comment 'orchard app ports'
  fi
}

firewalld_rules() {
  local lo=$1 hi=$2 cidr
  firewall-cmd --permanent --zone=trusted --add-source=10.42.0.0/16
  firewall-cmd --permanent --zone=trusted --add-source=10.43.0.0/16
  for cidr in $(lan_cidrs) 100.64.0.0/10; do
    firewall-cmd --permanent \
      --add-rich-rule="rule family=ipv4 source address=$cidr port port=6443 protocol=tcp accept"
  done
  if [ "$INGRESS_MODE" != tunnel ]; then
    firewall-cmd --permanent --add-port="$HTTP_PORT/tcp"
    firewall-cmd --permanent --add-port="$HTTPS_PORT/tcp"
    firewall-cmd --permanent --add-port="$lo-$hi/tcp"
    firewall-cmd --permanent --add-port="$lo-$hi/udp"
  fi
  firewall-cmd --reload
}

configure_firewall() {
  local lo=${NODE_PORT_RANGE%-*} hi=${NODE_PORT_RANGE#*-}
  if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q '^Status: active'; then
    run_step "opening ufw for k3s and Orchard" 10s ufw_rules "$lo" "$hi"
  elif command -v firewall-cmd >/dev/null 2>&1 && firewall-cmd --state >/dev/null 2>&1; then
    run_step "opening firewalld for k3s and Orchard" 20s firewalld_rules "$lo" "$hi"
  else
    info "no host firewall active; install/README.md lists what this box will listen on"
  fi
}

install_k3s() {
  step
  configure_firewall

  if command -v k3s >/dev/null 2>&1; then
    info "k3s already installed, leaving it alone"
  else
    run_step "downloading and starting k3s" 1m k3s_download
  fi

  export KUBECONFIG=/etc/rancher/k3s/k3s.yaml
  run_step "waiting for the node to be ready" 30s wait_for_node
}

helm_download() {
  curl -fsSL https://raw.githubusercontent.com/helm/helm/refs/tags/v4.3.0/scripts/get-helm-3 | bash -s -- --version "$HELM_VERSION"
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

  # A LoadBalancer service means k3s servicelb, which binds 80 and 443 on the
  # node. In tunnel mode cloudflared reaches Traefik over its ClusterIP from
  # inside the cluster, so claiming the host ports would only pick a fight with
  # whatever else is on them.
  local traefik_service=LoadBalancer
  if [ "$INGRESS_MODE" = tunnel ]; then traefik_service=ClusterIP; fi

  run_step "Traefik" 1m30s helm upgrade --install traefik traefik/traefik \
    --namespace traefik --create-namespace \
    --set providers.kubernetesGateway.enabled=true \
    --set gateway.enabled=false \
    --set service.spec.type="$traefik_service" \
    --set ports.web.exposedPort="$HTTP_PORT" \
    --set ports.websecure.exposedPort="$HTTPS_PORT" \
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

registry_htpasswd() {
  if command -v htpasswd >/dev/null 2>&1; then
    htpasswd -nbB "$REGISTRY_USER" "$REGISTRY_PASSWORD"
  else
    kubectl run zot-htpasswd --rm -i --quiet --restart=Never --image=httpd:2.4-alpine \
      --command -- htpasswd -nbB "$REGISTRY_USER" "$REGISTRY_PASSWORD"
  fi
}

write_registry_auth() {
  local line
  line=$(registry_htpasswd | grep "^$REGISTRY_USER:" | head -1 | tr -d '[:space:]')
  [ -n "$line" ] || return 1
  kubectl apply -f - <<EOF
apiVersion: v1
kind: Secret
metadata:
  name: zot-auth
  namespace: orchard
stringData:
  htpasswd: "$line"
EOF
}

install_registry() {
  step

  kubectl create namespace orchard >/dev/null 2>&1 || true

  REGISTRY_PASSWORD=$(reuse_value '.builders.harbor.password')
  [ -n "$REGISTRY_PASSWORD" ] || REGISTRY_PASSWORD=$(head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n')
  run_step "generating registry credentials" 30s write_registry_auth

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
      "http": {
        "address": "0.0.0.0",
        "port": "5000",
        "auth": { "htpasswd": { "path": "/etc/zot-auth/htpasswd" } }
      },
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
  strategy: { type: Recreate }
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
              hostPort: $REGISTRY_PORT
              hostIP: 127.0.0.1
          volumeMounts:
            - { name: data, mountPath: /var/lib/registry }
            - { name: config, mountPath: /etc/zot }
            - { name: auth, mountPath: /etc/zot-auth, readOnly: true }
          resources:
            requests: { cpu: 50m, memory: 64Mi }
            limits: { cpu: "1", memory: 512Mi }
      volumes:
        - name: data
          persistentVolumeClaim: { claimName: zot-data }
        - name: config
          configMap: { name: zot-config }
        - name: auth
          secret: { secretName: zot-auth }
---
apiVersion: v1
kind: Service
metadata:
  name: zot
  namespace: orchard
spec:
  type: ClusterIP
  selector: { app: zot }
  ports:
    - port: 5000
      targetPort: 5000
EOF

  mkdir -p /etc/rancher/k3s
  cat > /etc/rancher/k3s/registries.yaml <<EOF
mirrors:
  $REGISTRY_HOST:
    endpoint:
      - "http://127.0.0.1:$REGISTRY_PORT"
configs:
  "127.0.0.1:$REGISTRY_PORT":
    auth:
      username: $REGISTRY_USER
      password: "$REGISTRY_PASSWORD"
EOF
  run_step "reloading k3s with the registry mirror" 45s restart_k3s
  run_step "starting the registry" 2m \
    kubectl -n orchard rollout status deploy/zot --timeout=5m
  info "registry ready at $REGISTRY_HOST, mirrored to 127.0.0.1:$REGISTRY_PORT, loopback only"
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
  reuse_value ".server.env[]? | select(.name == \"$1\") | .value"
}

reuse_value() {
  local value
  [ -f "$VALUES_FILE" ] || return 0
  command -v yq >/dev/null 2>&1 || return 0
  value=$(yq -r "$1" "$VALUES_FILE" 2>/dev/null | head -1)
  [ "$value" = null ] && value=
  printf '%s' "$value"
}

write_values() {
  step

  mkdir -p "$STATE_DIR"
  chmod 700 "$STATE_DIR"

  local url_suffix=$HTTP_SUFFIX
  local scheme=http entrypoint=web tls_enabled=false tls_issuer= mcp_tls_issuer=
  if [ "$USE_TLS" = true ]; then
    scheme=https; entrypoint=websecure; tls_enabled=true; url_suffix=$HTTPS_SUFFIX
    # Without this the IngressRoute gets a bare `tls:` block and Traefik
    # terminates with its self-signed TRAEFIK DEFAULT CERT, which every browser
    # rejects. The chart issues the real one against the ClusterIssuer above.
    tls_issuer="
    issuerRef:
      name: $CERT_ISSUER
      kind: ClusterIssuer"
    # The same trap on the MCP's own route, one level deeper in the values. An
    # MCP client refuses a self-signed certificate outright.
    mcp_tls_issuer="
      issuerRef:
        name: $CERT_ISSUER
        kind: ClusterIssuer"
  fi
  if [ "$INGRESS_MODE" = tunnel ]; then scheme=https; url_suffix=''; fi

  local cookie_secure=true
  if [ "$scheme" = http ]; then cookie_secure=false; fi

  # Re-running the installer is the supported way to pick up new host commands,
  # and it rewrites this file wholesale. Minting fresh secrets would log every
  # user out, and worse, a new SECRETS_ENCRYPTION_KEY makes every secret already
  # stored in the database permanently undecryptable. Carry them over.
  JWT_SECRET=$(reuse_secret JWT_SECRET)
  ENCRYPTION_KEY=$(reuse_secret SECRETS_ENCRYPTION_KEY)
  SSO_KEY=$(reuse_secret SSO_STATE_SECRET)
  # Shared with the MCP below rather than minted per process: it is what the
  # API recognises when the MCP acts for a consenting user, so a mismatch shows
  # up as every tool call failing rather than as anything failing to start.
  MCP_TOKEN=$(reuse_secret MCP_SERVICE_TOKEN)
  [ -n "$JWT_SECRET" ] || JWT_SECRET=$(head -c 32 /dev/urandom | base64 | tr -d '\n=' | head -c 43)
  [ -n "$ENCRYPTION_KEY" ] || ENCRYPTION_KEY=$(head -c 24 /dev/urandom | base64 | tr -d '\n=' | head -c 32)
  [ -n "$SSO_KEY" ] || SSO_KEY=$(head -c 24 /dev/urandom | base64 | tr -d '\n=' | head -c 32)
  [ -n "$MCP_TOKEN" ] || MCP_TOKEN=$(head -c 32 /dev/urandom | base64 | tr -d '\n=' | head -c 43)

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
    - { name: PUBLIC_HTTP_PORT, value: "$HTTP_PORT" }
    - { name: PUBLIC_HTTPS_PORT, value: "$HTTPS_PORT" }
    - { name: PUBLIC_OAUTH_PROVIDER, value: none }

server:
  replicas: 1
  image:
    tag: $IMAGE_TAG
  env:
    - { name: JWT_SECRET, value: "$JWT_SECRET" }
    - { name: SECRETS_ENCRYPTION_KEY, value: "$ENCRYPTION_KEY" }
    - { name: SSO_ENCRYPTION_KEY, value: "$SSO_KEY" }
    - { name: MCP_SERVICE_TOKEN, value: "$MCP_TOKEN" }
    - { name: APP_DOMAIN, value: $ORCHARD_APP_DOMAIN }
    - { name: PUBLIC_HTTP_PORT, value: "$HTTP_PORT" }
    - { name: PUBLIC_HTTPS_PORT, value: "$HTTPS_PORT" }
    - { name: FRONTEND_URL, value: $scheme://$ORCHARD_DOMAIN$url_suffix }
    - { name: SESSION_COOKIE_SECURE, value: "$cookie_secure" }
    - { name: MAX_CONCURRENT_BUILDS, value: "$MAX_BUILDS" }
    - { name: DOCKER_REGISTRY_PUSH, value: zot.orchard.svc.cluster.local:5000 }
    - { name: DOCKER_REGISTRY_PULL, value: $REGISTRY_HOST }
    - { name: REGISTRY_HTTP_HOSTS, value: zot.orchard.svc.cluster.local:5000 }
    - { name: REGISTRY_PROJECT, value: orchard }
    - { name: HARBOR_USERNAME, value: $REGISTRY_USER }
    - { name: HARBOR_PASSWORD, value: "$REGISTRY_PASSWORD" }
    - { name: BUILDER_SCRATCH_STORAGE_CLASS, value: local-path }

tenant:
  # Traefik, not the HAProxy this project runs in `network`. Tenant namespaces
  # are default-deny, so the ingress controller has to be named or the ACME
  # HTTP-01 solver is unreachable and certificates never issue.
  ingressNamespaces: "traefik,orchard"
  storageClass: local-path
  ingressClass: traefik
  certClusterIssuer: "$CERT_ISSUER"

ingress:
  enabled: true
  host: $ORCHARD_DOMAIN
  extraHosts: $INGRESS_EXTRA_HOSTS
  entryPoints: [$entrypoint]
  tls:
    enabled: $tls_enabled$tls_issuer

gateway:
  enabled: true
  namespace: network
  gatewayClassName: traefik
  http:
    # The server routes everything through Ingress and never creates an
    # HTTPRoute, so this listener carries no traffic. Enabled, it also declares
    # a certificateRef for a wildcard Secret that nothing here creates. Off,
    # matching production.
    enabled: false
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
  platform: linux/$ARCH
  harbor:
    username: $REGISTRY_USER
    password: "$REGISTRY_PASSWORD"
    hosts:
      - zot.orchard.svc.cluster.local:5000
  httpRegistries:
    - zot.orchard.svc.cluster.local:5000
  # Builds are firewalled off from the rest of the cluster, so the registry they
  # push to has to be named or the push is refused. This installer runs zot in
  # the orchard namespace; the chart's defaults describe a different cluster.
  registryEgress:
    - namespace: orchard
      podLabels:
        app: zot
      ports:
        - port: 5000
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

# Agents connect here. The chart derives MCP_BASE_URL, the frontend's
# PUBLIC_MCP_URL and the API it calls from the hostname below, so this is the
# whole of pointing an MCP client at this instance. Turn it off at install with
# --mcp false, or later with 'orchardctl mcp disable --apply'.
mcp:
  enabled: $ORCHARD_MCP
  # Stated rather than derived from the route: in tunnel mode Traefik answers
  # plaintext in-cluster while the world connects over https, and an OAuth
  # issuer that disagrees with the URL the client typed is rejected.
  url: $scheme://$ORCHARD_MCP_DOMAIN$url_suffix
  ingress:
    enabled: true
    host: $ORCHARD_MCP_DOMAIN
    entryPoints: [$entrypoint]
    tls:
      enabled: $tls_enabled$mcp_tls_issuer
  env:
    - { name: JWT_SECRET, value: "$JWT_SECRET" }
    - { name: MCP_SERVICE_TOKEN, value: "$MCP_TOKEN" }

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
  if [ "$ORCHARD_MCP" = true ]; then
    run_step "the agent endpoint" 1m kubectl -n orchard rollout status deploy/mcp --timeout=5m
  fi
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

  # The commands run unrendered, so this is a plain copy: pull the sync script
  # out of the image and let it install the rest.
  local boot
  boot=$(mktemp)
  if kubectl -n orchard exec deploy/server -- cat /app/hostbin/orchard-sync-commands > "$boot" 2>/dev/null \
     && [ -s "$boot" ] && bash -n "$boot" 2>/dev/null; then
    install -m 0755 "$boot" /usr/local/bin/orchard-sync-commands
    rm -f "$boot"
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
  local scheme=https suffix=$HTTPS_SUFFIX
  if [ "$USE_TLS" = false ]; then
    [ "$INGRESS_MODE" != tunnel ] && { scheme=http; suffix=$HTTP_SUFFIX; }
  fi
  if [ "$INGRESS_MODE" = tunnel ]; then suffix=''; fi

  step

  printf '\n'
  box_top
  pad_line ""
  pad_line "$C_BRIGHT$C_BOLD  Orchard is ready$C_RESET$C_GREY   installed in $(elapsed)$C_RESET"
  pad_line ""
  pad_line "  ${C_GREY}Dashboard${C_RESET}  $scheme://$ORCHARD_DOMAIN$suffix"
  pad_line "  ${C_GREY}Your apps${C_RESET}  *.$ORCHARD_APP_DOMAIN$HTTPS_SUFFIX"
  if [ "$ORCHARD_MCP" = true ]; then
    pad_line "  ${C_GREY}Agents${C_RESET}     $scheme://$ORCHARD_MCP_DOMAIN$suffix"
  fi
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

  if [ "$ASSUME_YES" != true ] && ! open_prompt_fd; then
    warn "$PROMPT_BLOCKED"
    prompt_hint
    PROMPT_HINT_SHOWN=true
    # The mode question is the first one and it is unconditional, so there is no
    # point walking through the machine checks to arrive at a question that
    # cannot be answered.
    if [ -z "$ORCHARD_INGRESS_MODE" ]; then
      die "stopping before the first question; nothing has been installed"
    fi
  fi
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
