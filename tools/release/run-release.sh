#!/usr/bin/env bash
# Drives a knope release for the branch's channel, then emits a version manifest
# for the rest of CI (image tags + Helm chart). Safe to run when there is
# nothing to release: it no-ops and just reports the current versions.
set -euo pipefail

branch="${GITHUB_REF_NAME:-$(git rev-parse --abbrev-ref HEAD)}"

# Branch -> channel. Prerelease branches pass --prerelease-label so knope cuts
# X.Y.Z-<label>.N with an auto-incrementing counter; maintenance lines (N.x,
# N.M.x) release stable off their own history.
label_args=()
case "$branch" in
  main)        channel="stable" ;;
  beta)        channel="beta";  label_args=(--prerelease-label beta) ;;
  alpha)       channel="alpha"; label_args=(--prerelease-label alpha) ;;
  rc)          channel="rc";    label_args=(--prerelease-label rc) ;;
  *.x)         channel="stable" ;;
  *) echo "::notice::'$branch' is not a release branch; skipping" >&2; channel="none" ;;
esac

released=false
if [ "$channel" != "none" ]; then
  # ${arr[@]+...} guards the empty-array expansion under `set -u` on bash 3.2.
  # Gate the real run on a dry-run so the commit step never fails on an empty
  # release. Match "Would add the following to" (only emitted on a real bump) —
  # NOT a generic "Would", since the git commit/push Command steps always print
  # "Would run ..." even on a no-op (chore/docs-only) push.
  if knope release --dry-run ${label_args[@]+"${label_args[@]}"} 2>&1 | grep -q "Would add the following to"; then
    knope release ${label_args[@]+"${label_args[@]}"}
    released=true
  else
    echo "::notice::no releasable commits on '$branch'" >&2
  fi
fi

# Latest tag per package (changed this run or not) — images always need a tag to
# publish under. sort -V gives the highest semver on the channel.
latest() { git tag --list "$1/v*" | sed "s#$1/v##" | sort -V | tail -1; }

server=$(latest server);   frontend=$(latest frontend)
gateway=$(latest gateway); cli=$(latest cli)
r2proxy=$(latest r2-proxy); umbrella=$(latest orchard)

versions=$(cat <<JSON
{"server":"${server:-0.0.0}","frontend":"${frontend:-0.0.0}","gateway":"${gateway:-0.0.0}","cli":"${cli:-0.0.0}","r2-proxy":"${r2proxy:-0.0.0}","mcp":"${server:-0.0.0}","umbrella":"${umbrella:-0.0.0}","channel":"$channel"}
JSON
)
versions=$(echo "$versions" | tr -d '\n')

echo "channel=$channel released=$released"
echo "$versions"

if [ -n "${GITHUB_OUTPUT:-}" ]; then
  {
    echo "versions=$versions"
    echo "released=$released"
    echo "channel=$channel"
    echo "umbrella=${umbrella:-0.0.0}"
  } >> "$GITHUB_OUTPUT"
fi
