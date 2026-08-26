#!/usr/bin/env bash
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

ORCHARD_LIB_ONLY=1
export ORCHARD_LIB_ONLY
# shellcheck source=install.sh
source "$HERE/install.sh"

SPEED=${DEMO_SPEED:-1}
FAIL_AT=${DEMO_FAIL:-}

pause() { sleep "$(awk -v s="$1" -v f="$SPEED" 'BEGIN{printf "%.2f", s/f}')"; }

fake() { pause "$1"; }

fake_fail() {
  pause 1
  cat >&2 <<'EOF'
Error: UPGRADE FAILED: another operation (install/upgrade/rollback) is in progress
Release "orchard" does not exist. Installing it now.
  namespaces "network" not found
EOF
  return 1
}

maybe() {
  local label=$1 typical=$2 secs=$3
  if [ "$FAIL_AT" = "$label" ]; then
    run_step "$label" "$typical" fake_fail
  else
    run_step "$label" "$typical" fake "$secs"
  fi
}

# shellcheck disable=SC2034  # consumed by summary() from install.sh
ORCHARD_DOMAIN=orchard.example.com
# shellcheck disable=SC2034
ORCHARD_APP_DOMAIN=apps.example.com
# shellcheck disable=SC2034
INGRESS_MODE=public
# shellcheck disable=SC2034
USE_TLS=true
# shellcheck disable=SC2034
VALUES_FILE=/etc/orchard/values.yaml

demo() {
  local i=0
  REMAINING=0
  while [ "$i" -lt "$STEP_TOTAL" ]; do
    REMAINING=$((REMAINING + PLAN_COSTS[i]))
    i=$((i + 1))
  done

  banner
  show_plan

  step
  info "architecture: amd64"
  info "memory: 16031Mi"
  info "free disk: 218G"
  info "ports 80/443 are free"
  info "node ports: 30000-30100, registry on 30100"

  step
  info "public IP: 203.0.113.44"
  info "local IP:  203.0.113.44"
  info "this box has a routable address"
  info "ingress mode: public"

  step
  info "platform: https://orchard.example.com"
  info "apps:     *.apps.example.com"
  info "update policy: manual"
  info "concurrent builds: 3, build cache: 43G, registry: 43G"

  step
  maybe "downloading and starting k3s" 1m 6
  maybe "waiting for the node to be ready" 30s 3

  step
  maybe "downloading helm" 20s 2

  step
  maybe "Gateway API CRDs" 15s 2
  maybe "fetching chart repositories" 20s 2
  maybe "Traefik" 1m30s 4
  maybe "CloudNativePG" 1m 4
  maybe "cert-manager" 1m30s 5

  step
  maybe "reloading k3s with the registry mirror" 45s 3
  maybe "starting the registry" 2m 5
  info "registry ready at registry.orchard.local, mirrored to 127.0.0.1:30100"

  step
  info "not needed in public mode"

  step

  step
  maybe "applying the chart" 40s 3
  maybe "postgres" 3m 5
  maybe "redis" 30s 2
  maybe "the api" 3m 5
  maybe "the web app" 1m 3

  step
  info "run 'orchard-update' to upgrade"

  summary
}

case "${1:-}" in
  -h|--help)
    cat <<'EOF'

  Orchard installer demo

  Runs the real installer's interface against fake work, so you can see exactly
  what an install looks like without touching the machine.

  Usage:
    ./demo.sh                 the happy path
    DEMO_SPEED=4 ./demo.sh    four times faster
    DEMO_FAIL=Traefik ./demo.sh   watch a step fail

  DEMO_FAIL takes any sub-step label, for example "cert-manager", "postgres",
  or "the api".

EOF
    exit 0
    ;;
esac

demo
