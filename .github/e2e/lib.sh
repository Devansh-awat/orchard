set -euo pipefail

KUBECTL=${KUBECTL:-sudo k3s kubectl}

port_suffix() {
  case "$SCHEME:$PORT" in
    http:80|https:443) ;;
    *) printf ':%s' "$PORT" ;;
  esac
}

edge_url() {
  printf '%s://%s%s%s' "$SCHEME" "$1" "$(port_suffix)" "${2:-/}"
}

edge() {
  local host=$1
  shift
  local opts=(-sS)
  if [ -n "${ADDR:-}" ] && [ "$host" != "$ADDR" ]; then opts+=(--resolve "$host:$PORT:$ADDR"); fi
  if [ "${INSECURE:-}" = true ]; then opts+=(-k); fi
  curl "${opts[@]}" "$@"
}

api_as() {
  local token=$1
  shift
  edge "$DASH_HOST" --fail-with-body -H "authorization: Bearer $token" -H 'content-type: application/json' "$@"
}

api() {
  api_as "$TOKEN" "$@"
}

save_cookies() {
  tr -d '\r' < "$1" | grep -i '^set-cookie:' | sed -E 's/^[^:]*: *//; s/;.*//' > "$2"
  test -s "$2"
}

cookie_header() {
  paste -sd ';' "$1" | sed 's/;/; /g'
}

session() {
  local jar=$1
  shift
  edge "$DASH_HOST" --fail-with-body -H "cookie: $(cookie_header "$jar")" -H 'content-type: application/json' "$@"
}

status_as() {
  local token=$1 method=$2 path=$3 body=${4:-}
  local args=(-o "$RUNNER_TEMP/last-body" -w '%{http_code}' -X "$method"
    -H "authorization: Bearer $token" -H 'content-type: application/json')
  if [ -n "$body" ]; then args+=(-d "$body"); fi
  edge "$DASH_HOST" "${args[@]}" "$BASE$path"
}

retry() {
  local tries=$1 i
  shift
  for ((i = 1; i < tries; i++)); do
    if "$@"; then return 0; fi
    sleep 5
  done
  "$@"
}

claim() {
  local claim_token token
  claim_token=$($KUBECTL -n orchard exec deploy/server -- node dist/scripts/mint-claim-link.js \
    | grep -o 'token=[A-Za-z0-9_-]*' | cut -d= -f2)
  test -n "$claim_token"
  edge "$DASH_HOST" --fail-with-body -D "$RUNNER_TEMP/jar.headers" -H 'content-type: application/json' \
    -d "{\"token\":\"$claim_token\",\"email\":\"ci@example.com\"}" "$BASE/setup/bootstrap" >/dev/null
  save_cookies "$RUNNER_TEMP/jar.headers" "$RUNNER_TEMP/jar"
  token=$(session "$RUNNER_TEMP/jar" -d '{"name":"e2e","scopes":["exec"]}' "$BASE/auth/tokens" | jq -r .token)
  [[ "$token" == orch_* ]] || { echo "no API token in the response"; return 1; }
  echo "::add-mask::$token"
  echo "TOKEN=$token" >> "$GITHUB_ENV"
}

builder_pull_failures() {
  $KUBECTL -n orchard-builders get pods -l "orchard.my/deployment-id=$1" -o json 2>/dev/null \
    | jq -r '.items[].status | (.initContainerStatuses // []) + (.containerStatuses // []) | .[]
      | select(.state.waiting.reason == "ImagePullBackOff" or .state.waiting.reason == "ErrImagePull")
      | "\(.name): \(.state.waiting.message)"' || true
}

wait_build() {
  local id=$1 old=${2:-} dep status image stuck=0 pulls
  while :; do
    pulls=$(builder_pull_failures "$id")
    if [ -n "$pulls" ]; then
      stuck=$((stuck + 1))
      if [ "$stuck" -ge 36 ]; then
        echo "the builder can't pull its images:"
        echo "$pulls"
        return 1
      fi
    else
      stuck=0
    fi
    dep=$(api "$BASE/deployments/$id")
    status=$(jq -r .buildStatus <<<"$dep")
    image=$(jq -r '.image // ""' <<<"$dep")
    echo "$id: $status $image"
    case "$status" in
      succeeded) if [ -z "$old" ] || [ "$image" != "$old" ]; then return 0; fi ;;
      failed) api "$BASE/deployments/$id/logs" | jq -r '.buildError, .logs' | tail -c 20000; return 1 ;;
    esac
    sleep 5
  done
}

wait_database() {
  local id=$1 status
  while :; do
    status=$(api "$BASE/databases/$id" | jq -r .status)
    echo "$id: $status"
    case "$status" in
      ready|running) return 0 ;;
      failed|error) api "$BASE/databases/$id" | jq .; return 1 ;;
    esac
    sleep 5
  done
}

dep_json() {
  api "$BASE/deployments/$1"
}

rollout() {
  local ns name
  ns=$(dep_json "$1" | jq -r .namespace)
  name=$(dep_json "$1" | jq -r .name)
  retry 24 $KUBECTL -n "$ns" get "deploy/$name" -o name
  $KUBECTL -n "$ns" rollout status "deploy/$name" --timeout=5m
}

kexec() {
  local id=$1 ns name
  shift
  ns=$(dep_json "$id" | jq -r .namespace)
  name=$(dep_json "$id" | jq -r .name)
  $KUBECTL -n "$ns" exec "deploy/$name" -- sh -c "$*"
}

app_host() {
  dep_json "$1" | jq -r '.ingresses[0].host // empty'
}

app_body() {
  edge "$1" -m 10 -o "$RUNNER_TEMP/app-body" -w '%{http_code}' "$(edge_url "$1" /)" || true
}

app_serves() {
  local host=$1 want=$2 code
  code=$(app_body "$host")
  echo "$host answered $code"
  [ "$code" = 200 ] && grep -q "$want" "$RUNNER_TEMP/app-body"
}

app_gone() {
  local code
  code=$(app_body "$1")
  echo "$1 answered $code"
  [ "$code" = 404 ]
}

make_public() {
  local id=$1 dep project ingress mode
  dep=$(dep_json "$id")
  project=$(jq -r .projectId <<<"$dep")
  ingress=$(jq -r '.ingresses[0].id' <<<"$dep")
  mode=$(jq -r '.ingresses[0].protectionMode // "none"' <<<"$dep")
  echo "ingress $ingress starts with protection $mode"
  if [ "$mode" != none ]; then
    api -X PUT -d '{"mode":"none"}' "$BASE/projects/$project/ingresses/$ingress/protection" >/dev/null
  fi
}

diagnostics() {
  $KUBECTL get nodes -o wide || true
  $KUBECTL get pods -A -o wide || true
  $KUBECTL get ingress,svc -A || true
  $KUBECTL get networkpolicy -A || true
  $KUBECTL get certificates,orders,challenges -A 2>/dev/null || true
  $KUBECTL get events -A --sort-by=.lastTimestamp | tail -80 || true
  $KUBECTL -n orchard logs deploy/server --tail=400 || true
  $KUBECTL -n orchard-builders get jobs,pods -o wide || true
  for pod in $($KUBECTL -n orchard-builders get pods -o name 2>/dev/null); do
    $KUBECTL -n orchard-builders logs "$pod" --all-containers --tail=150 || true
  done
  $KUBECTL -n cloudflared logs deploy/cloudflared --tail=50 2>/dev/null || true
}
