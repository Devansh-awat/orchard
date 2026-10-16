#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."
REPO=$PWD
STATE=${ORCHARD_DEV_STATE:-$HOME/.local/share/orchard-dev}
PG_BIN=$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | sort -V | tail -1 || true)
PREVIEW_PORT=8080

log() { printf '\033[1;32m[dev]\033[0m %s\n' "$*"; }

install_packages() {
  local missing=()
  [ -n "$PG_BIN" ] || missing+=(postgresql)
  command -v redis-server >/dev/null || missing+=(redis-server)
  command -v go >/dev/null || missing+=(golang-go)
  [ ${#missing[@]} -eq 0 ] && return
  log "installing ${missing[*]}"
  sudo DEBIAN_FRONTEND=noninteractive apt-get update -qq
  sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends "${missing[@]}" >/dev/null
  PG_BIN=$(ls -d /usr/lib/postgresql/*/bin | sort -V | tail -1)
}

ensure_swap() {
  [ -n "$(swapon --show --noheadings 2>/dev/null)" ] && return
  log "adding 4G of swap at /swapfile"
  [ -f /swapfile ] || {
    sudo fallocate -l 4G /swapfile
    sudo chmod 600 /swapfile
    sudo mkswap /swapfile >/dev/null
  }
  sudo swapon /swapfile || log "swap unavailable, builds may get OOM-killed"
}

start_services() {
  mkdir -p "$STATE"
  if [ ! -d "$STATE/pg" ]; then
    log "initialising postgres in $STATE/pg"
    "$PG_BIN/initdb" -D "$STATE/pg" -U postgres --auth=trust >/dev/null
  fi
  if ! "$PG_BIN/pg_ctl" -D "$STATE/pg" status >/dev/null 2>&1; then
    rm -f "$STATE/pg/postmaster.pid"
    "$PG_BIN/pg_ctl" -D "$STATE/pg" -l "$STATE/pg.log" -w \
      -o "-k /tmp -c listen_addresses=127.0.0.1" start >/dev/null
    log "postgres up"
  fi
  psql -h 127.0.0.1 -U postgres -tAc "SELECT 1 FROM pg_roles WHERE rolname='orchard'" | grep -q 1 \
    || psql -h 127.0.0.1 -U postgres -qc "CREATE ROLE orchard LOGIN SUPERUSER PASSWORD 'orchard'"
  psql -h 127.0.0.1 -U postgres -tAc "SELECT 1 FROM pg_database WHERE datname='orchard'" | grep -q 1 \
    || psql -h 127.0.0.1 -U postgres -qc "CREATE DATABASE orchard OWNER orchard"
  if ! redis-cli -h 127.0.0.1 ping >/dev/null 2>&1; then
    redis-server --daemonize yes --bind 127.0.0.1 --dir "$STATE" --logfile "$STATE/redis.log"
    log "redis up"
  fi
}

write_env() {
  if [ ! -f "$STATE/server.env" ]; then
    log "generating $STATE/server.env"
    sed \
      -e "s|^JWT_SECRET=.*|JWT_SECRET=$(openssl rand -hex 32)|" \
      -e "s|^SECRETS_ENCRYPTION_KEY=.*|SECRETS_ENCRYPTION_KEY=$(openssl rand -hex 32)|" \
      -e "s|^MCP_SERVICE_TOKEN=.*|MCP_SERVICE_TOKEN=$(openssl rand -hex 32)|" \
      "$REPO/.env.example" >"$STATE/server.env"
  fi
  [ -f apps/server/.env ] || cp "$STATE/server.env" apps/server/.env
  [ -f apps/frontend/.env ] || cp apps/frontend/.env.example apps/frontend/.env
}

setup() {
  install_packages
  start_services
  write_env
  CI=true pnpm install --frozen-lockfile
  pnpm --filter server prisma:generate
  pnpm --filter @grafts/greenhouse prebuild
  pnpm --filter server exec prisma migrate deploy
  log "setup done"
}

run() {
  install_packages
  ensure_swap
  start_services
  write_env

  local origin=${ORCHARD_DEV_ORIGIN:-}
  [ -z "$origin" ] && [ -f "$STATE/origin" ] && origin=$(tr -d '[:space:]' <"$STATE/origin")
  origin=${origin:-http://localhost:$PREVIEW_PORT}
  origin=${origin%/}
  local host=${origin#*://}
  host=${host%%[:/]*}

  export FRONTEND_URL=$origin
  export WEBAUTHN_ORIGIN=$origin
  export WEBAUTHN_RP_ID=$host
  export HOST=0.0.0.0
  export GATEWAY_LISTEN=0.0.0.0:$PREVIEW_PORT
  local build_dir=$REPO/grafts/greenhouse/.graft-dev
  export ORCHARD_GRAFTS_DIR=$STATE/grafts
  export ORCHARD_GRAFTS_DEV=1
  export __VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS=".vercel.run,$host"
  export NODE_OPTIONS=${NODE_OPTIONS:---max-old-space-size=1536}
  if [ -z "${KUBECONFIG_PATH:-}${KUBECONFIG_BASE64:-}${KUBECONFIG:-}" ] && [ ! -f "$HOME/.kube/config" ]; then
    export KUBECONFIG_PATH=$STATE/no-cluster.kubeconfig
    export NODE_OPTIONS="$NODE_OPTIONS --require $REPO/.orchard/dev-standalone.cjs"
  fi

  if [ -f "$STATE/local.env" ]; then
    set -a
    . "$STATE/local.env"
    set +a
    log "loaded $STATE/local.env"
  fi

  log "origin $origin (set ORCHARD_DEV_ORIGIN or write it to $STATE/origin to change)"

  rm -rf "$ORCHARD_GRAFTS_DIR" "$build_dir"
  mkdir -p "$ORCHARD_GRAFTS_DIR"
  (while :; do
    pnpm --filter @grafts/greenhouse dev 2>&1 | while IFS= read -r line; do
      printf '%s\n' "$line"
      case "$line" in
        *"graft dev: rebuilt"*)
          rsync -a --delete-delay "$build_dir/greenhouse/" "$ORCHARD_GRAFTS_DIR/greenhouse/"
          log "published greenhouse build"
          ;;
      esac
    done || true
    log "greenhouse graft watcher exited, restarting"
    sleep 2
  done) &
  local graft=$!
  trap 'trap - EXIT; kill 0 2>/dev/null || true' EXIT
  until [ -f "$ORCHARD_GRAFTS_DIR/greenhouse/graft.json" ]; do
    kill -0 $graft 2>/dev/null || { log "greenhouse graft build failed"; exit 1; }
    sleep 1
  done
  log "greenhouse graft built, starting orchard on :$PREVIEW_PORT"
  pnpm dev
}

case "${1:-}" in
  setup) setup ;;
  run) run ;;
  *) echo "usage: $0 setup|run" >&2; exit 2 ;;
esac
