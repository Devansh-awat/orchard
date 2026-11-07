#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Disable the CNPG postgres superuser login on existing Orchard database clusters.

New clusters are created with enableSuperuserAccess=false. Existing ones keep
true until an operator runs this script. Orchard itself never uses the
superuser secret (it runs psql over the local socket inside the pod).

  cnpg-disable-superuser.sh [--apply] [--limit N] [--pause SECONDS] [--namespace NS] [--context CTX]

Default is a dry run that only lists the clusters that would change.
--apply patches clusters one at a time, then checks that no instance pod was
recreated or restarted. If one was, the script stops so you can decide whether
to continue. Start with --limit 1 on a non-critical database.
USAGE
}

apply=false
limit=0
pause=20
namespace=""
context=()

while [ $# -gt 0 ]; do
  case "$1" in
    --apply) apply=true ;;
    --limit) limit="$2"; shift ;;
    --pause) pause="$2"; shift ;;
    --namespace) namespace="$2"; shift ;;
    --context) context=(--context "$2"); shift ;;
    -h|--help) usage; exit 0 ;;
    *) usage; exit 2 ;;
  esac
  shift
done

scope=(--all-namespaces)
if [ -n "$namespace" ]; then scope=(-n "$namespace"); fi

list=$(kubectl "${context[@]}" get clusters.postgresql.cnpg.io "${scope[@]}" \
  -l app.kubernetes.io/managed-by=orchard \
  -o jsonpath='{range .items[?(@.spec.enableSuperuserAccess==true)]}{.metadata.namespace}{" "}{.metadata.name}{"\n"}{end}')

if [ -z "$list" ]; then
  echo "no managed clusters have enableSuperuserAccess=true"
  exit 0
fi

pod_fingerprint() {
  kubectl "${context[@]}" get pods -n "$1" -l "cnpg.io/cluster=$2" \
    -o jsonpath='{range .items[*]}{.metadata.name}{":"}{.metadata.uid}{":"}{range .status.containerStatuses[*]}{.restartCount}{","}{end}{"\n"}{end}' | sort
}

done_count=0
while read -r ns name; do
  [ -n "$ns" ] || continue
  if [ "$apply" != true ]; then
    echo "would patch $ns/$name"
    continue
  fi
  before=$(pod_fingerprint "$ns" "$name")
  kubectl "${context[@]}" patch clusters.postgresql.cnpg.io "$name" -n "$ns" \
    --type merge -p '{"spec":{"enableSuperuserAccess":false}}'
  sleep "$pause"
  after=$(pod_fingerprint "$ns" "$name")
  if [ "$before" != "$after" ]; then
    echo "instance pods of $ns/$name changed after the patch (restart or roll); stopping" >&2
    echo "before:" >&2
    echo "$before" >&2
    echo "after:" >&2
    echo "$after" >&2
    exit 1
  fi
  echo "patched $ns/$name, pods unchanged"
  done_count=$((done_count + 1))
  if [ "$limit" -gt 0 ] && [ "$done_count" -ge "$limit" ]; then
    echo "limit reached ($limit)"
    break
  fi
done <<<"$list"
