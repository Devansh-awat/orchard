#!/usr/bin/env bash
set -euo pipefail

root=$(cd "$(dirname "$0")/.." && pwd)
manifest=$root/.release-please-manifest.json
chart=$root/infra/charts/orchard

released() {
  local version
  version=$(yq -p json -o yaml '."'"$1"'" // ""' "$manifest")
  [ -n "$version" ] || { echo "$1 is missing from $manifest" >&2; exit 1; }
  printf '%s' "$version"
}

pin() {
  local file=$1 path=$2 value=$3 line
  line=$(yq "$path | line" "$file")
  [ "$line" -gt 0 ] || { echo "$path is missing from $file" >&2; exit 1; }
  sed -i -E "${line}s/^([^:]+:[[:space:]]*)(\"?)[^\"#[:space:]]*(\"?)/\\1\\2${value}\\3/" "$file"
  [ "$(yq "$path" "$file")" = "$value" ] || { echo "could not set $path in $file" >&2; exit 1; }
}

frontend=$(released apps/frontend)
server=$(released apps/server)
r2proxy=$(released apps/r2-proxy)
fcbuilder=$(released apps/fc-builder)
umbrella=$(printf '%s\n' "$frontend" "$server" "$(released apps/gateway)" "$(released apps/cli)" "$r2proxy" | sort -V | tail -1)

pin "$chart/Chart.yaml" .version "$umbrella"
pin "$chart/Chart.yaml" .appVersion "$umbrella"
pin "$chart/values.yaml" .frontend.image.tag "$frontend"
pin "$chart/values.yaml" .server.image.tag "$server"
pin "$chart/values.yaml" .mcp.image.tag "$server"
pin "$chart/values.yaml" .r2Proxy.image.tag "$r2proxy"
if [ "$fcbuilder" != 0.0.0 ]; then pin "$chart/values.yaml" .fcBuilder.image.tag "$fcbuilder"; fi
